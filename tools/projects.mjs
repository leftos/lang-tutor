/**
 * Project workspace manager for project-kind languages (currently `web`,
 * with `csharp` arriving in Phase 2).
 *
 * Owns:
 *  - Scaffolding per-user workspaces under LANG_TUTOR_PROJECT_ROOT.
 *  - File CRUD (tree / read / write / rename / delete / mkdir) with strict
 *    path-traversal rejection — every path is resolved against the project root
 *    and rejected if it escapes.
 *  - Process supervision per the per-language `PROJECT_CONFIG` table: a one-time
 *    install command (gated by a marker file), then a long-running dev command.
 *    Stdout/stderr are streamed into a per-language ring buffer and broadcast
 *    to SSE subscribers.
 *  - Readiness probe per the language's `readiness` declaration: `http-probe`
 *    polls a port until it responds; `process-alive` waits for the spawned
 *    child to stay alive past a warm-up window (used by desktop processes).
 *
 * SECURITY: all user file paths are resolved against the user's project root
 * before filesystem access. Child commands and arguments are fixed by
 * PROJECT_CONFIG; only the private preview port and public base path are filled
 * into placeholders.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_WORKSPACE_ROOT = process.env.NODE_ENV === 'production' ? '/var/lib/lang-tutor/workspaces' : join(REPO_ROOT, '.local', 'workspaces');
const WORKSPACE_ROOT = resolve(process.env.LANG_TUTOR_PROJECT_ROOT ?? process.env.LANG_TUTOR_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT);
const PROJECT_CACHE_ROOT = resolve(process.env.LANG_TUTOR_PROJECT_CACHE_ROOT ?? join(WORKSPACE_ROOT, '..', 'cache'));

const LOG_RING_SIZE = 500;
const READY_PROBE_INTERVAL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;
const PROCESS_ALIVE_DEFAULT_MS = 500;
const WEB_PORT_START = Number.parseInt(process.env.LANG_TUTOR_WEB_PORT_START ?? '5180', 10);
const WEB_PORT_END = Number.parseInt(process.env.LANG_TUTOR_WEB_PORT_END ?? '5280', 10);

const IS_WIN = process.platform === 'win32';
const NODE = IS_WIN ? 'node.exe' : 'node';
const PNPM = IS_WIN ? 'pnpm.cmd' : 'pnpm';
const CSHARP_SOLUTION_FILE = 'LangTutor.sln';
const CSHARP_WPF_PROJECT_FILE = 'LangTutor.Wpf/LangTutor.Wpf.csproj';

function normalizeBasePath(value) {
  const raw = value?.trim();
  if (!raw || raw === './') return '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const APP_BASE_PATH = normalizeBasePath(process.env.LANG_TUTOR_BASE_PATH);

/**
 * Per-language project configuration. Single source of truth for
 * scaffold directory, install/dev commands, readiness model, watcher
 * ignore set, and which (if any) iframe bootstrap to inject.
 *
 * @typedef {{
 *   scaffoldDir: string,
 *   install: { cmd: string, args: string[], marker: string } | null,
 *   dev: { cmd: string, args: string[] },
 *   readiness:
 *     | { kind: 'http-probe', preferredPort: number }
 *     | { kind: 'process-alive', minAliveMs: number },
 *   treeIgnore: Set<string>,
 *   bootstrap: 'web-iframe' | null,
 * }} ProjectConfig
 *
 * @type {Readonly<Record<string, ProjectConfig>>}
 */
const PROJECT_CONFIG = Object.freeze({
  web: {
    scaffoldDir: 'web',
    install: { cmd: PNPM, args: ['install', '--ignore-scripts'], marker: 'node_modules' },
    dev: {
      cmd: NODE,
      args: [
        './node_modules/vite/bin/vite.js',
        '--configLoader',
        'runner',
        '--host',
        '127.0.0.1',
        '--strictPort',
        '--port',
        '{port}',
        '--base',
        '{base}',
      ],
    },
    readiness: { kind: 'http-probe', preferredPort: 5180 },
    treeIgnore: new Set(['node_modules', '.git', 'dist', '.vite', '.vite-temp']),
    bootstrap: 'web-iframe',
  },
  csharp: {
    scaffoldDir: 'csharp',
    install: { cmd: 'dotnet', args: ['restore', CSHARP_SOLUTION_FILE], marker: 'LangTutor.Wpf/obj' },
    // --verbosity minimal: default would be 'quiet' under non-TTY, which prints
    // nothing until the build fails. 'minimal' streams the restore + build
    // milestones we need for the frontend's build-phase pill, plus
    // `Foo.cs(L,C): error CSnnnn:` lines for the Build errors tab.
    dev: { cmd: 'dotnet', args: ['run', '--project', CSHARP_WPF_PROJECT_FILE, '--verbosity', 'minimal'] },
    readiness: { kind: 'process-alive', minAliveMs: PROCESS_ALIVE_DEFAULT_MS },
    treeIgnore: new Set(['bin', 'obj', '.vs']),
    bootstrap: null,
  },
});

/**
 * Friendly install-hint per command. Looked up by the command's base name
 * (after stripping any .cmd / .exe / .bat suffix) so Windows variants work too.
 */
const MISSING_CMD_HINTS = Object.freeze({
  dotnet: '.NET SDK not found on PATH. Install .NET 8 (or newer) from https://aka.ms/dotnet/download and restart the dev server.',
  node: 'Node.js not found on PATH. Install Node 20.6+ and restart the dev server.',
  pnpm: 'pnpm not found on PATH. Install with `npm install -g pnpm` and restart the dev server.',
});

const WGC_NO_SDK_HINT =
  'Windows screen capture (WGC) needs the Windows 10 SDK (any version ≥ 10.0.19041) installed. ' +
  'The easiest path is to install the Windows 10/11 SDK via the Visual Studio Installer (“Desktop development with C++” workload includes it), ' +
  'or grab the standalone installer from https://developer.microsoft.com/windows/downloads/windows-sdk/. ' +
  'Without it the tutor falls back to text-only payloads — share screenshots manually.';

function missingCmdHint(cmd) {
  const baseName = cmd.replace(/\.(cmd|exe|bat)$/i, '');
  return MISSING_CMD_HINTS[baseName] ?? `${cmd} not found on PATH. Install it and restart the dev server.`;
}

/**
 * Best-effort check for whether a command can be spawned. Uses spawnSync with
 * `--version` since both `pnpm` and `dotnet` (the only commands we care about
 * today) respond to it cheaply. ENOENT means the executable isn't on PATH.
 *
 * On Windows some package-manager shims need `shell: true`; a missing command
 * exits non-zero through cmd.exe rather than emitting ENOENT, so we treat any
 * non-zero exit and any error event as "missing" here.
 */
function commandExists(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { shell: IS_WIN, stdio: 'ignore', timeout: 5_000 });
    if (r.error !== undefined && r.error !== null) return false;
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Csharp preflight: catch the failures that produce inscrutable `dotnet run`
 * output otherwise: missing WPF project and SDK / TFM mismatches. Returns
 * `null` on pass; a friendly hint string on fail.
 */
function preflightCsharp(cwd) {
  const wpfProjectPath = safeResolve(cwd, CSHARP_WPF_PROJECT_FILE);
  if (!existsSync(wpfProjectPath)) {
    return `No WPF .csproj file found at projects/csharp/${CSHARP_WPF_PROJECT_FILE}. Click Reset to re-scaffold.`;
  }

  let csprojContent;
  try {
    csprojContent = readFileSync(wpfProjectPath, 'utf8');
  } catch (e) {
    return `Could not read ${wpfProjectPath}: ${e.message}`;
  }

  const tfMatch = csprojContent.match(/<TargetFramework>\s*net(\d+)\.\d+[^<]*<\/TargetFramework>/i);
  if (tfMatch === null) return null; // unrecognised TFM — let dotnet itself complain
  const requiredMajor = Number.parseInt(tfMatch[1], 10);
  if (!Number.isFinite(requiredMajor)) return null;

  let sdkOutput;
  try {
    const r = spawnSync('dotnet', ['--list-sdks'], { shell: IS_WIN, encoding: 'utf8', timeout: 5_000 });
    if (r.status !== 0) return null;
    sdkOutput = r.stdout ?? '';
  } catch {
    return null;
  }
  const installedMajors = new Set();
  for (const line of sdkOutput.split('\n')) {
    const m = line.match(/^(\d+)\.\d+\.\d+/);
    if (m !== null) installedMajors.add(Number.parseInt(m[1], 10));
  }
  const hasMatch = [...installedMajors].some((v) => v >= requiredMajor);
  if (!hasMatch) {
    const installed = [...installedMajors].sort((a, b) => a - b).join(', ') || 'none';
    return `Project targets .NET ${requiredMajor}+ but only these SDK majors are installed: ${installed}. Install .NET ${requiredMajor} SDK from https://aka.ms/dotnet/download (or edit LangTutor.Wpf.csproj's <TargetFramework> to match).`;
  }
  return null;
}

/** PATH lookup using the platform's `where` / `which` — for tools that don't have a sane --version. */
function executableInPath(exeName) {
  const lookup = IS_WIN ? 'where.exe' : 'which';
  try {
    const r = spawnSync(lookup, [exeName], { stdio: 'ignore', timeout: 5_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

const ALLOWED_LANGS = Object.freeze(new Set(Object.keys(PROJECT_CONFIG)));

function getTreeIgnore(lang) {
  return PROJECT_CONFIG[lang].treeIgnore;
}

/** Port reported back to the frontend. Null for desktop projects (no HTTP server). */
function getReadinessPort(lang) {
  const r = PROJECT_CONFIG[lang].readiness;
  return r.kind === 'http-probe' ? r.preferredPort : null;
}

// ── Iframe bootstrap (DOM snapshot + console capture for evaluate) ──
//
// This is injected into proxied preview HTML only. It must never be written
// into the student's workspace files; those should stay readable course
// material.

const BOOTSTRAP_START = '<!-- lang-tutor:bootstrap-start -->';
const BOOTSTRAP_END = '<!-- lang-tutor:bootstrap-end -->';

// IIFE bundle of the npm `html-to-image` package, produced by
// scripts/copy-html-to-image.mjs. Bundled and inlined (rather than dynamically
// imported) because the iframe is cross-origin from the parent (`:5180` vs
// `:5173`) and dynamic imports are CORS-restricted. Embedding inline costs
// ~14 KB once per iframe load. If the file is missing (postinstall didn't run)
// we fall back to an empty string and the screenshot handler reports a clear
// error instead of crashing the bootstrap.
const HTML_TO_IMAGE_BUNDLE = (() => {
  try {
    return readFileSync(join(REPO_ROOT, 'public', 'lang-tutor-assets', 'html-to-image.js'), 'utf8');
  } catch {
    return '';
  }
})();

const BOOTSTRAP_INNER = `(() => {
  if (window.__langTutorBootstrap) return;
  window.__langTutorBootstrap = true;
  const buffer = [];
  const MAX = 200;
  for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const line = args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        buffer.push({ level, line, ts: Date.now() });
        if (buffer.length > MAX) buffer.shift();
      } catch {}
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    buffer.push({ level: 'error', line: \`[uncaught] \${e.message || String(e.error)}\`, ts: Date.now() });
    if (buffer.length > MAX) buffer.shift();
  });

  // Vite injects <vite-error-overlay> as a sibling of the user tree when a
  // build / HMR error occurs. Watch for it so the tutor sees the same red box
  // the student sees, even though the underlying error also reaches us via
  // [SERVER] logs.
  let latestOverlay = null;
  const readOverlayText = (el) => {
    try {
      const root = el.shadowRoot;
      if (root && typeof root.textContent === 'string') {
        const t = root.textContent.replace(/\\s+/g, ' ').trim();
        if (t.length > 0) return t.slice(0, 4000);
      }
    } catch {}
    try {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      return t.length > 0 ? t.slice(0, 4000) : null;
    } catch { return null; }
  };
  const overlayObserver = new MutationObserver(() => {
    const el = document.querySelector('vite-error-overlay');
    latestOverlay = el === null ? null : readOverlayText(el);
  });
  const startObserver = () => {
    if (document.body) overlayObserver.observe(document.body, { childList: true, subtree: false });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();

  // Resize a PNG dataURL via an offscreen canvas. Keeps aspect ratio; clamps
  // the long edge to maxLong. Returns a new PNG dataURL.
  const resizeDataUrl = (dataUrl, maxLong) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) { reject(new Error('zero-dimension image')); return; }
      const scale = Math.min(1, maxLong / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('canvas 2d context unavailable')); return; }
      ctx.drawImage(img, 0, 0, tw, th);
      try { resolve(c.toDataURL('image/png')); }
      catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });

  // A sandboxed iframe without allow-same-origin protects the parent app's
  // storage from student-authored preview code, but it also gives the document
  // an opaque origin. html-to-image cannot read cssRules from linked sheets in
  // that state, so for capture only we fetch linked stylesheets through the
  // same preview proxy, insert equivalent <style> tags, and temporarily disable
  // the links. Everything is restored after rasterisation.
  const prepareStylesForCapture = async () => {
    const cleanups = [];
    const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'));
    await Promise.all(links.map(async (link) => {
      try {
        const href = link.href;
        if (!href) return;
        const response = await fetch(href, { credentials: 'omit' });
        if (!response.ok) return;
        const css = await response.text();
        const style = document.createElement('style');
        style.setAttribute('data-lang-tutor-capture-style', '');
        style.textContent = css;
        link.after(style);
        const wasDisabled = link.disabled;
        link.disabled = true;
        cleanups.push(() => {
          style.remove();
          link.disabled = wasDisabled;
        });
      } catch {}
    }));
    return () => {
      for (let i = cleanups.length - 1; i >= 0; i -= 1) cleanups[i]();
    };
  };

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const reply = (payload) => {
      if (event.source && typeof event.source.postMessage === 'function') {
        event.source.postMessage(payload, event.origin || '*');
      }
    };

    if (data.type === 'lang-tutor:snapshot-request') {
      // Re-read on demand so a snapshot taken right as the overlay appears
      // doesn't lose the race with the MutationObserver.
      let hmrOverlay = latestOverlay;
      try {
        const live = document.querySelector('vite-error-overlay');
        if (live !== null) hmrOverlay = readOverlayText(live);
      } catch {}
      reply({
        type: 'lang-tutor:snapshot-reply',
        requestId: data.requestId,
        dom: document.documentElement.outerHTML,
        consoleBuffer: buffer.slice(),
        url: location.href,
        title: document.title,
        hmrOverlay,
      });
      return;
    }

    if (data.type === 'lang-tutor:screenshot-request') {
      const requestId = data.requestId;
      try {
        if (!window.htmlToImage || typeof window.htmlToImage.toPng !== 'function') {
          throw new Error('html-to-image bundle missing — run \\'pnpm install\\' to refresh public/lang-tutor-assets/');
        }
        // Render the document body (rather than documentElement) — html-to-image
        // walks the full layout tree, but the <html> element's serialised
        // bounding box is sometimes 0×0 on documents with quirky styling.
        const target = document.body || document.documentElement;
        const cleanupStyles = await prepareStylesForCapture();
        let rawDataUrl;
        try {
          rawDataUrl = await window.htmlToImage.toPng(target, { pixelRatio: 1, cacheBust: false });
        } finally {
          cleanupStyles();
        }
        const fullDataUrl = await resizeDataUrl(rawDataUrl, 1568);
        const thumbDataUrl = await resizeDataUrl(rawDataUrl, 256);
        reply({ type: 'lang-tutor:screenshot-reply', requestId, fullDataUrl, thumbDataUrl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply({ type: 'lang-tutor:screenshot-reply', requestId, error: msg });
      }
      return;
    }
  });
})();`;

const BOOTSTRAP_SCRIPT = `${BOOTSTRAP_START}\n<script>${HTML_TO_IMAGE_BUNDLE}</script>\n<script>${BOOTSTRAP_INNER}</script>\n${BOOTSTRAP_END}`;

export function stripPreviewBootstrapFromHtml(html) {
  const startIdx = html.indexOf(BOOTSTRAP_START);
  const endIdx = html.indexOf(BOOTSTRAP_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return html;

  const before = html.slice(0, startIdx).replace(/\s+$/, '');
  const after = html.slice(endIdx + BOOTSTRAP_END.length).replace(/^\s+/, '');
  return `${before}\n${after}`;
}

export function injectPreviewBootstrapIntoHtml(html) {
  const stripped = stripPreviewBootstrapFromHtml(html);

  // Inject right after the opening <head> tag: early enough to intercept
  // console calls before user scripts run, without polluting source files.
  const headOpen = stripped.search(/<head\b[^>]*>/i);
  if (headOpen === -1) return stripped;
  const headEnd = stripped.indexOf('>', headOpen) + 1;
  return `${stripped.slice(0, headEnd)}\n${BOOTSTRAP_SCRIPT}\n${stripped.slice(headEnd).replace(/^\s+/, '')}`;
}

const SELF_WRITE_SUPPRESS_MS = 500;

/** Timestamps of recent self-mutations (abs path → ms). Watch events that
 *  match a recent self-write are dropped to avoid round-trip echoes. */
const selfWrites = new Map();

function markSelfWrite(absPath) {
  selfWrites.set(absPath, Date.now());
  // Lazy GC — any path older than the suppress window has served its purpose.
  for (const [p, ts] of selfWrites) {
    if (Date.now() - ts > SELF_WRITE_SUPPRESS_MS * 4) selfWrites.delete(p);
  }
}

function isRecentSelfWrite(absPath) {
  const ts = selfWrites.get(absPath);
  if (ts === undefined) return false;
  if (Date.now() - ts > SELF_WRITE_SUPPRESS_MS) {
    selfWrites.delete(absPath);
    return false;
  }
  return true;
}

// ── Project root + path safety ──────────────────────────────────────────────

function assertLang(lang) {
  if (!ALLOWED_LANGS.has(lang)) throw new Error(`unknown project language: ${lang}`);
}

function scopeSegment(scope) {
  const raw = typeof scope === 'string' && scope.length > 0 ? scope : 'local';
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(raw)) return raw;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function stateKey(scope, lang) {
  return `${scopeSegment(scope)}:${lang}`;
}

export function getProjectRoot(scope, lang) {
  assertLang(lang);
  return join(WORKSPACE_ROOT, scopeSegment(scope), PROJECT_CONFIG[lang].scaffoldDir);
}

export function getPreviewRoutePath(lang) {
  assertLang(lang);
  return `/proj/preview/${encodeURIComponent(lang)}/`;
}

export function getPreviewPublicBase(lang) {
  assertLang(lang);
  return `${APP_BASE_PATH}proj/preview/${encodeURIComponent(lang)}/`;
}

function safeResolve(projectRoot, relPath) {
  const cleaned = (relPath ?? '').replace(/^[/\\]+/, '');
  const resolved = resolve(projectRoot, cleaned);
  const rootWithSep = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
  if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`path traversal rejected: ${relPath}`);
  }
  return resolved;
}

// ── Scaffold ────────────────────────────────────────────────────────────────

const SCAFFOLD_WEB = {
  'package.json': `${JSON.stringify(
    {
      name: 'lang-tutor-web',
      private: true,
      type: 'module',
      scripts: { dev: 'vite --configLoader runner --port 5180 --strictPort --host 127.0.0.1' },
      devDependencies: {
        vite: '^7.0.0',
        // vite-plugin-checker runs tsc / biome in a worker and surfaces
        // diagnostics in the HMR overlay AND on stderr — captured by the
        // supervisor and forwarded to the tutor's [SERVER] block.
        'vite-plugin-checker': '^0.7.0',
        '@biomejs/biome': '^2.0.0',
        // typescript ships with tsserver; the language-server binary is
        // installed globally (see scripts/setup.ps1) but typescript itself
        // must be in the workspace so checker.tsc can resolve it.
        typescript: '^5.5.0',
      },
    },
    null,
    2
  )}\n`,

  'vite.config.js': `import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';

// vite-plugin-checker — runs in a worker so it doesn't block HMR. tsc reads
// jsconfig.json (checkJs is enabled) so plain .js files get type-checked.
// Biome handles linting/formatting. Errors surface in the HMR overlay AND in
// stderr, the latter is what makes them flow into the lang-tutor [SERVER]
// block when the student clicks Send to tutor.
export default defineConfig({
  // Hosted workspaces live in writable scratch storage while app releases stay
  // read-only. Keep Vite's own cache beside the user's project files.
  cacheDir: './.vite',
  plugins: [
    checker({
      typescript: { tsconfigPath: 'jsconfig.json' },
      biome: { dev: { logLevel: ['error', 'warning'] } },
      overlay: { initialIsOpen: false },
      enableBuild: false,
    }),
  ],
});
`,

  'jsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        checkJs: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowImportingTsExtensions: false,
        // tsserver / typescript-language-server picks this up to provide hover,
        // completion, and diagnostics for .js files. Without checkJs they'd be
        // syntax-only — with it enabled, JSDoc + inferred types catch real bugs.
      },
      include: ['./*.js', './*.html'],
    },
    null,
    2
  )}\n`,

  'biome.json': `${JSON.stringify(
    {
      formatter: { enabled: true, indentStyle: 'space', indentWidth: 2 },
      linter: { enabled: true, rules: { recommended: true } },
      files: { includes: ['**/*.js', '**/*.html', '**/*.css', '!index.html', '!**/node_modules', '!**/.vite'] },
    },
    null,
    2
  )}\n`,

  'pnpm-workspace.yaml': `packages:
  - .
`,

  'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web · Workshop</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from your web workshop.</h1>
      <p>
        Edit <code>index.html</code>, <code>style.css</code>, or <code>app.js</code>
        and this page will reload automatically.
      </p>
      <p>Open the developer console — <code>app.js</code> logs there on load.</p>
    </main>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`,

  'style.css': `:root { color-scheme: light dark; }

body {
  font-family: system-ui, -apple-system, sans-serif;
  max-width: 42rem;
  margin: 3rem auto;
  padding: 0 1.25rem;
  line-height: 1.55;
}

h1 { font-weight: 600; letter-spacing: -0.01em; }

code {
  background: color-mix(in srgb, currentColor 8%, transparent);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.95em;
}
`,

  'app.js': `console.log('Hello from app.js — edit this file to begin.');
`,

  'README.md': `# Your web workshop

This folder is your sandbox for the web-development course in lang-tutor.

- \`index.html\` — page structure
- \`style.css\` — page styles
- \`app.js\` — page logic

Lang Tutor starts a private Vite dev server when you click Run and shows it in
the Preview tab with hot reload. Edit the files here or through any other
editor — lang-tutor reads and writes them on disk.
`,
};

const SCAFFOLD_CSHARP = {
  'LangTutor.sln': `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "LangTutor.Wpf", "LangTutor.Wpf\\LangTutor.Wpf.csproj", "{9F5B6B88-6D6E-45F4-A375-E3BD8E4B5CE9}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "LangTutor.Console", "LangTutor.Console\\LangTutor.Console.csproj", "{4EC0AFD9-6E8B-4F9C-A263-C660E8E76773}"
EndProject
Global
  GlobalSection(SolutionConfigurationPlatforms) = preSolution
    Debug|Any CPU = Debug|Any CPU
    Release|Any CPU = Release|Any CPU
  EndGlobalSection
  GlobalSection(ProjectConfigurationPlatforms) = postSolution
    {9F5B6B88-6D6E-45F4-A375-E3BD8E4B5CE9}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
    {9F5B6B88-6D6E-45F4-A375-E3BD8E4B5CE9}.Debug|Any CPU.Build.0 = Debug|Any CPU
    {9F5B6B88-6D6E-45F4-A375-E3BD8E4B5CE9}.Release|Any CPU.ActiveCfg = Release|Any CPU
    {9F5B6B88-6D6E-45F4-A375-E3BD8E4B5CE9}.Release|Any CPU.Build.0 = Release|Any CPU
    {4EC0AFD9-6E8B-4F9C-A263-C660E8E76773}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
    {4EC0AFD9-6E8B-4F9C-A263-C660E8E76773}.Debug|Any CPU.Build.0 = Debug|Any CPU
    {4EC0AFD9-6E8B-4F9C-A263-C660E8E76773}.Release|Any CPU.ActiveCfg = Release|Any CPU
    {4EC0AFD9-6E8B-4F9C-A263-C660E8E76773}.Release|Any CPU.Build.0 = Release|Any CPU
  EndGlobalSection
EndGlobal
`,

  'LangTutor.Wpf/LangTutor.Wpf.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>LangTutor.Wpf</RootNamespace>
  </PropertyGroup>
</Project>
`,

  'LangTutor.Wpf/App.xaml': `<Application x:Class="LangTutor.Wpf.App"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             StartupUri="MainWindow.xaml">
  <Application.Resources>
  </Application.Resources>
</Application>
`,

  'LangTutor.Wpf/App.xaml.cs': `using System.Windows;

namespace LangTutor.Wpf;

public partial class App : Application
{
}
`,

  'LangTutor.Wpf/MainWindow.xaml': `<Window x:Class="LangTutor.Wpf.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Lang Tutor - C# Workshop"
        Height="320" Width="480">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <TextBlock x:Name="GreetingText"
               Text="Hello from your C# workshop."
               FontSize="18"
               VerticalAlignment="Center"
               HorizontalAlignment="Center"/>
    <Button Grid.Row="1"
            Content="Click me"
            Padding="16,8"
            HorizontalAlignment="Center"
            Click="OnClickMe"/>
  </Grid>
</Window>
`,

  'LangTutor.Wpf/MainWindow.xaml.cs': `using System.Windows;

namespace LangTutor.Wpf;

public partial class MainWindow : Window
{
    private int _clicks;

    public MainWindow()
    {
        InitializeComponent();
    }

    private void OnClickMe(object sender, RoutedEventArgs e)
    {
        _clicks++;
        GreetingText.Text = $"Clicked {_clicks} time(s).";
    }
}
`,

  'LangTutor.Console/LangTutor.Console.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>LangTutor.Console</RootNamespace>
  </PropertyGroup>
</Project>
`,

  'LangTutor.Console/Program.cs': `Console.WriteLine("Hello from the C# console workspace.");
Console.WriteLine("Edit Program.cs, then use the console run button to run just this file.");
`,

  'README.md': `# Your C# workshop

This folder is your sandbox for the C# course in lang-tutor.

- \`LangTutor.sln\` - solution containing the WPF app and console workspace
- \`LangTutor.Wpf/\` - WPF app: XAML, app lifecycle, layout, binding, MVVM
- \`LangTutor.Console/Program.cs\` - small console exercises for language fundamentals

When you click Run in lang-tutor, it runs the WPF project:

1. Restore NuGet packages (one-time, cached after)
2. Compile the C# + XAML
3. Launch the WPF window on your desktop

The window is a real Windows app, not an in-browser preview — it pops up on top
of your other windows. Click the button to watch the click counter increment.

For console lessons, open \`LangTutor.Console/Program.cs\` and use the console
run button above the editor. That sends the active C# file to the local sandbox,
which is useful for records, pattern matching, LINQ, async basics, and small
algorithm exercises that do not need WPF.

You can also build and run from Visual Studio or JetBrains Rider by opening
\`LangTutor.sln\`.
`,
};

const SCAFFOLDS = Object.freeze({ web: SCAFFOLD_WEB, csharp: SCAFFOLD_CSHARP });

function migrateWebScaffold(root) {
  const updatedPaths = [];
  const indexPath = safeResolve(root, 'index.html');
  if (existsSync(indexPath)) {
    const original = readFileSync(indexPath, 'utf8');
    const updated = stripPreviewBootstrapFromHtml(original);
    if (updated !== original) {
      writeFileSync(indexPath, updated, 'utf8');
      markSelfWrite(indexPath);
      updatedPaths.push('index.html');
    }
  }

  const viteConfig = safeResolve(root, 'vite.config.js');
  if (existsSync(viteConfig)) {
    const original = readFileSync(viteConfig, 'utf8');
    const updated = original
      .replace(/\bbiomejs:\s*true\b/g, "biome: { dev: { logLevel: ['error', 'warning'] } }")
      .replace(/\bbiome:\s*true\b/g, "biome: { dev: { logLevel: ['error', 'warning'] } }");
    if (updated !== original) {
      writeFileSync(viteConfig, updated, 'utf8');
      markSelfWrite(viteConfig);
      updatedPaths.push('vite.config.js');
    }
  }

  const biomeConfig = safeResolve(root, 'biome.json');
  if (!existsSync(biomeConfig)) return updatedPaths;

  try {
    const original = readFileSync(biomeConfig, 'utf8');
    const config = JSON.parse(original);
    let changed = false;

    if (typeof config.$schema === 'string' && config.$schema.includes('biomejs.dev/schemas/')) {
      delete config.$schema;
      changed = true;
    }

    if (typeof config.files !== 'object' || config.files === null || Array.isArray(config.files)) {
      config.files = {};
      changed = true;
    }

    const includes = Array.isArray(config.files.includes)
      ? config.files.includes.filter((entry) => typeof entry === 'string')
      : ['**/*.js', '**/*.html', '**/*.css'];

    for (const pattern of ['!index.html', '!**/node_modules', '!**/.vite']) {
      if (!includes.includes(pattern)) {
        includes.push(pattern);
        changed = true;
      }
    }

    if (
      !Array.isArray(config.files.includes) ||
      includes.length !== config.files.includes.length ||
      includes.some((entry, index) => entry !== config.files.includes[index])
    ) {
      config.files.includes = includes;
      changed = true;
    }

    if (changed) {
      writeFileSync(biomeConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      markSelfWrite(biomeConfig);
      updatedPaths.push('biome.json');
    }
  } catch {
    // Leave hand-edited or invalid Biome configs alone; Vite/Biome will report
    // the parse error in the normal project output.
  }

  return updatedPaths;
}

export function ensureScaffold(scope, lang) {
  const root = getProjectRoot(scope, lang);
  const template = SCAFFOLDS[lang];
  if (!template) throw new Error(`no scaffold defined for ${lang}`);

  const created = [];
  const updated = [];
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  for (const [relPath, content] of Object.entries(template)) {
    const abs = safeResolve(root, relPath);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    created.push(relPath);
  }
  if (lang === 'web') updated.push(...migrateWebScaffold(root));
  return { root, created, updated };
}

// ── FS CRUD ─────────────────────────────────────────────────────────────────

function buildTree(absDir, projectRoot, ignoreSet) {
  const name = absDir === projectRoot ? '' : (relative(projectRoot, absDir).split(sep).pop() ?? '');
  const node = { name, path: relative(projectRoot, absDir).split(sep).join('/'), type: 'dir', children: [] };

  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return node;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (ignoreSet.has(entry.name)) continue;
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) {
      node.children.push(buildTree(child, projectRoot, ignoreSet));
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: relative(projectRoot, child).split(sep).join('/'),
        type: 'file',
      });
    }
  }
  return node;
}

export function getTree(scope, lang) {
  const root = getProjectRoot(scope, lang);
  if (!existsSync(root)) return { tree: null, scaffolded: false };
  if (lang === 'web') migrateWebScaffold(root);
  return { tree: buildTree(root, root, getTreeIgnore(lang)), scaffolded: true };
}

export function readFile(scope, lang, relPath) {
  const root = getProjectRoot(scope, lang);
  if (lang === 'web') migrateWebScaffold(root);
  const abs = safeResolve(root, relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`file not found: ${relPath}`);
  }
  return { content: readFileSync(abs, 'utf8') };
}

export function writeFile(scope, lang, relPath, content) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const root = getProjectRoot(scope, lang);
  const abs = safeResolve(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  markSelfWrite(abs);
  return { ok: true };
}

export function renameFile(scope, lang, fromRel, toRel) {
  const root = getProjectRoot(scope, lang);
  const fromAbs = safeResolve(root, fromRel);
  const toAbs = safeResolve(root, toRel);
  if (!existsSync(fromAbs)) throw new Error(`source not found: ${fromRel}`);
  if (existsSync(toAbs)) throw new Error(`destination already exists: ${toRel}`);
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  markSelfWrite(fromAbs);
  markSelfWrite(toAbs);
  return { ok: true };
}

export function deleteFile(scope, lang, relPath) {
  const root = getProjectRoot(scope, lang);
  const abs = safeResolve(root, relPath);
  if (abs === root) throw new Error('cannot delete project root');
  if (!existsSync(abs)) return { ok: true };
  rmSync(abs, { recursive: true, force: true });
  markSelfWrite(abs);
  return { ok: true };
}

export function mkdir(scope, lang, relPath) {
  const root = getProjectRoot(scope, lang);
  const abs = safeResolve(root, relPath);
  mkdirSync(abs, { recursive: true });
  markSelfWrite(abs);
  return { ok: true };
}

// ── Process supervision ────────────────────────────────────────────────────

// Persist the `procs` Map across module reloads. Vite restarts its dev server
// (and re-evaluates this module) every time tools/projects.mjs is edited; a
// fresh module instance with an empty procs Map silently abandons every
// running child the previous instance was supervising. Stashing on globalThis
// preserves both PIDs and log-buffer state, so /proj/stop on the next request
// kills the right process tree and the SSE log subscription resumes cleanly.
//
// SSE subscribers (`state.subs`) are deliberately NOT preserved — they're DOM
// observers in the previous request's lifetime, useless after a reload.
const PROCS_GLOBAL_KEY = '__langTutorProcs';
const EXIT_HOOK_KEY = '__langTutorExitHookInstalled';
/** @type {Map<string, ProcState>} */
const procs = (() => {
  const existing = /** @type {Map<string, ProcState> | undefined} */ (globalThis[PROCS_GLOBAL_KEY]);
  if (existing instanceof Map) {
    for (const state of existing.values()) state.subs = new Set();
    return existing;
  }
  const fresh = new Map();
  globalThis[PROCS_GLOBAL_KEY] = fresh;
  return fresh;
})();

// Best-effort cleanup when the dev server itself is killed (Ctrl+C). Without
// this every csharp.exe / vite-spawned node sticks around as an orphan. Guard
// with a global flag so HMR-induced module reloads don't pile up duplicate
// listeners (which would emit-warn after ~10).
if (globalThis[EXIT_HOOK_KEY] !== true) {
  globalThis[EXIT_HOOK_KEY] = true;
  const cleanup = () => {
    for (const state of procs.values()) {
      if (state.proc !== null) killProcessTree(state.proc);
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);
}

/**
 * @typedef {object} ProcState
 * @property {import('node:child_process').ChildProcess | null} proc
 * @property {string} scope
 * @property {string} lang
 * @property {number | null} pid          PID of the supervised child while running.
 * @property {string} phase  'install' | 'starting' | 'ready' | 'stopped' | 'exited' | 'error'
 *   - 'stopped' means the user clicked Stop (or initial state).
 *   - 'exited' means the child closed on its own (e.g. WPF window closed).
 * @property {number | null} lastExitCode Exit code of the most recent self-exit. Reset on next start.
 * @property {number | null} userStoppedAt  Timestamp of the most recent stopProject() call; used
 *   in the 'close' handler to distinguish user-stop from self-exit.
 * @property {number | null} vitePort  Null for desktop projects with no HTTP server.
 * @property {Array<{stream: string, line: string, ts: number}>} logs
 * @property {Set<(entry: {stream: string, line: string, ts: number}) => void>} subs
 * @property {string | null} error
 */

function getOrInitState(scope, lang) {
  const key = stateKey(scope, lang);
  let s = procs.get(key);
  if (!s) {
    s = {
      proc: null,
      scope: scopeSegment(scope),
      lang,
      pid: null,
      phase: 'stopped',
      lastExitCode: null,
      userStoppedAt: null,
      vitePort: getReadinessPort(lang),
      logs: [],
      subs: new Set(),
      error: null,
    };
    procs.set(key, s);
  }
  return s;
}

function pushLog(state, stream, line) {
  const entry = { stream, line, ts: Date.now() };
  state.logs.push(entry);
  if (state.logs.length > LOG_RING_SIZE) state.logs.splice(0, state.logs.length - LOG_RING_SIZE);
  for (const sub of state.subs) {
    try {
      sub(entry);
    } catch {
      // subscriber errors must not break the producer
    }
  }
}

function streamLines(state, streamName, readable) {
  let buf = '';
  readable.setEncoding('utf8');
  readable.on('data', (chunk) => {
    buf += chunk;
    let nl;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      pushLog(state, streamName, line);
    }
  });
  readable.on('end', () => {
    if (buf.length > 0) pushLog(state, streamName, buf);
  });
}

async function probeHttp(port, signal) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + READY_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    try {
      const r = await fetch(url, { signal });
      if (r.ok || r.status < 500) return true;
    } catch {
      // not listening yet
    }
    await new Promise((res) => setTimeout(res, READY_PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * Resolve once the spawned child has stayed alive for `minAliveMs` without
 * exiting. Used for desktop processes that don't expose an HTTP port — once
 * the child is still running after the warm-up window, we declare it ready.
 */
async function probeProcessAlive(state, minAliveMs, signal) {
  const proc = state.proc;
  if (proc === null) return false;
  return new Promise((resolveAlive) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      proc.removeListener('close', onClose);
      resolveAlive(value);
    };
    const onClose = () => finish(false);
    proc.once('close', onClose);
    if (signal.aborted) {
      finish(false);
      return;
    }
    signal.addEventListener?.('abort', () => finish(false));
    setTimeout(() => finish(state.proc !== null), minAliveMs);
  });
}

function probeReady(state, readiness, signal) {
  switch (readiness.kind) {
    case 'http-probe':
      return probeHttp(readiness.port, signal);
    case 'process-alive':
      return probeProcessAlive(state, readiness.minAliveMs ?? PROCESS_ALIVE_DEFAULT_MS, signal);
    default:
      throw new Error(`unknown readiness kind: ${readiness.kind}`);
  }
}

function isPortAlreadyClaimed(port) {
  for (const state of procs.values()) {
    if (state.proc !== null && state.vitePort === port) return true;
  }
  return false;
}

function canListenOnLocalPort(port) {
  return new Promise((resolveCanListen) => {
    const server = createNetServer();
    server.once('error', () => resolveCanListen(false));
    server.once('listening', () => {
      server.close(() => resolveCanListen(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function allocateHttpPort(preferredPort) {
  const start = Number.isFinite(WEB_PORT_START) ? WEB_PORT_START : preferredPort;
  const end = Number.isFinite(WEB_PORT_END) && WEB_PORT_END >= start ? WEB_PORT_END : start + 100;
  const candidates = [preferredPort, ...Array.from({ length: end - start + 1 }, (_, i) => start + i)];
  const seen = new Set();
  for (const port of candidates) {
    if (!Number.isInteger(port) || port < 1024 || seen.has(port)) continue;
    seen.add(port);
    if (isPortAlreadyClaimed(port)) continue;
    if (await canListenOnLocalPort(port)) return port;
  }
  throw new Error(`no free preview port found in ${start}-${end}`);
}

function runtimeReadiness(config, state) {
  if (config.readiness.kind === 'http-probe') {
    if (state.vitePort === null) throw new Error('preview port was not assigned');
    return { kind: 'http-probe', port: state.vitePort };
  }
  return config.readiness;
}

function resolveCommandArgs(args, lang, state) {
  return args.map((arg) => {
    if (arg === '{port}') {
      if (state.vitePort === null) throw new Error('preview port was not assigned');
      return String(state.vitePort);
    }
    if (arg === '{base}') return getPreviewPublicBase(lang);
    return arg;
  });
}

function projectChildEnv() {
  const cacheDirs = {
    npm: join(PROJECT_CACHE_ROOT, 'npm'),
    pnpmCache: join(PROJECT_CACHE_ROOT, 'pnpm-cache'),
    pnpmStore: join(PROJECT_CACHE_ROOT, 'pnpm-store'),
    tmp: join(PROJECT_CACHE_ROOT, 'tmp'),
    xdg: join(PROJECT_CACHE_ROOT, 'xdg'),
    xdgState: join(PROJECT_CACHE_ROOT, 'xdg-state'),
  };
  for (const dir of Object.values(cacheDirs)) mkdirSync(dir, { recursive: true });
  return {
    ...process.env,
    npm_config_cache: cacheDirs.npm,
    npm_config_store_dir: cacheDirs.pnpmStore,
    pnpm_config_cache_dir: cacheDirs.pnpmCache,
    pnpm_config_store_dir: cacheDirs.pnpmStore,
    TMPDIR: cacheDirs.tmp,
    TEMP: cacheDirs.tmp,
    TMP: cacheDirs.tmp,
    XDG_CACHE_HOME: cacheDirs.xdg,
    XDG_STATE_HOME: cacheDirs.xdgState,
  };
}

function spawnLogged(state, cmd, args, cwd, phaseTag) {
  pushLog(state, 'system', `$ ${cmd} ${args.join(' ')}  (in ${cwd})`);
  let proc;
  try {
    // Node 20+ on Windows refuses to spawn .cmd/.bat shims without shell:true
    // (CVE-2024-27980). Args here are hardcoded constants plus validated
    // runtime placeholders; user text never reaches argv.
    proc = spawn(cmd, args, { cwd, env: projectChildEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
  } catch (e) {
    pushLog(state, 'system', `[${phaseTag}] failed to spawn: ${e.message}`);
    state.phase = 'error';
    state.error = `failed to spawn ${cmd}: ${e.message}`;
    return null;
  }
  streamLines(state, 'stdout', proc.stdout);
  streamLines(state, 'stderr', proc.stderr);
  proc.on('error', (e) => {
    pushLog(state, 'system', `[${phaseTag}] process error: ${e.message}`);
    state.error = e.message;
  });
  return proc;
}

function runInstall(state, cwd, install) {
  return new Promise((resolveInstall) => {
    state.phase = 'install';
    const label = `${install.cmd} ${install.args.join(' ')}`;
    // Cold restores / installs can fetch hundreds of MB of packages and easily
    // run 30+ seconds the first time; the 'install' phase pill is opaque, so
    // call out the wait in plain English so the student doesn't think the app
    // hung.
    const isDotnetRestore = install.cmd === 'dotnet' && install.args[0] === 'restore';
    const isPnpmInstall = (install.cmd === 'pnpm' || install.cmd === 'pnpm.cmd') && install.args[0] === 'install';
    let friendlyHint;
    if (isDotnetRestore) {
      friendlyHint = 'Running dotnet restore (one-time, downloads NuGet packages — can take a minute on a cold cache)…';
    } else if (isPnpmInstall) {
      friendlyHint = 'Running pnpm install (one-time, downloads npm dependencies — can take ~30 s on a cold cache)…';
    } else {
      friendlyHint = `Running ${label} (one-time)…`;
    }
    pushLog(state, 'system', friendlyHint);
    const proc = spawnLogged(state, install.cmd, install.args, cwd, 'install');
    if (!proc) {
      resolveInstall(false);
      return;
    }
    proc.on('close', (code) => {
      if (code === 0) {
        pushLog(state, 'system', `${label} complete.`);
        resolveInstall(true);
      } else {
        pushLog(state, 'system', `${label} exited with code ${code}.`);
        state.phase = 'error';
        state.error = `${label} exited ${code}`;
        resolveInstall(false);
      }
    });
  });
}

function describeStartTarget(config, state) {
  const { readiness } = config;
  if (readiness.kind === 'http-probe') return `http://127.0.0.1:${state.vitePort}/`;
  return `${config.dev.cmd} ${config.dev.args.join(' ')}`;
}

export async function startProject(scope, lang) {
  assertLang(lang);
  const config = PROJECT_CONFIG[lang];
  const state = getOrInitState(scope, lang);

  if (state.proc !== null && (state.phase === 'starting' || state.phase === 'ready')) {
    return { ok: true, vitePort: state.vitePort, previewPath: getPreviewRoutePath(lang), ready: state.phase === 'ready' };
  }

  // Scaffold returns the list of newly-created paths (empty if nothing changed).
  // First-time start gets a friendly "creating workspace" line so the student
  // sees what's happening rather than a 30-second blank Output tab.
  const scaffold = ensureScaffold(scope, lang);
  if (scaffold.created.length > 0) {
    pushLog(state, 'system', `Creating ${lang} workspace from template (${scaffold.created.length} files)…`);
    pushLog(state, 'system', 'Workspace ready.');
  }
  if (scaffold.updated?.length > 0) {
    pushLog(state, 'system', `Updated ${lang} workspace config (${scaffold.updated.join(', ')}).`);
  }
  const cwd = getProjectRoot(scope, lang);
  state.error = null;

  if (config.readiness.kind === 'http-probe') {
    state.vitePort = await allocateHttpPort(state.vitePort ?? config.readiness.preferredPort);
  }

  // Preflight: bail out with a friendly hint if any required command is missing.
  // The install/dev commands are the only two that get spawned, and they almost
  // always share a binary (pnpm for web, dotnet for csharp), so the dedupe is
  // worth doing.
  const requiredCmds = new Set([config.dev.cmd]);
  if (config.install !== null) requiredCmds.add(config.install.cmd);
  for (const cmd of requiredCmds) {
    if (!commandExists(cmd)) {
      const hint = missingCmdHint(cmd);
      pushLog(state, 'system', `[error] ${hint}`);
      state.phase = 'error';
      state.error = `${cmd} not found on PATH`;
      return { ok: false, error: state.error };
    }
  }

  // Per-language preflight: catches misconfigurations that produce inscrutable
  // tool-output otherwise. Currently only csharp (missing .csproj, SDK / TFM
  // mismatch). Web has nothing equivalent; pnpm errors are usually clear.
  if (lang === 'csharp') {
    const csharpHint = preflightCsharp(cwd);
    if (csharpHint !== null) {
      pushLog(state, 'system', `[error] ${csharpHint}`);
      state.phase = 'error';
      state.error = csharpHint;
      return { ok: false, error: state.error };
    }
  }

  if (config.install !== null && !existsSync(join(cwd, config.install.marker))) {
    const ok = await runInstall(state, cwd, config.install);
    if (!ok) return { ok: false, error: state.error ?? 'install failed' };
  }

  state.phase = 'starting';
  state.lastExitCode = null;
  state.userStoppedAt = null;
  pushLog(state, 'system', `Starting ${describeStartTarget(config, state)} …`);
  const proc = spawnLogged(state, config.dev.cmd, resolveCommandArgs(config.dev.args, lang, state), cwd, 'dev');
  if (!proc) return { ok: false, error: state.error ?? 'spawn failed' };

  state.proc = proc;
  state.pid = proc.pid ?? null;
  // Abort the readiness probe the moment the proc exits — otherwise probeHttp
  // would keep polling for up to 30 s after Vite dies on EADDRINUSE (or any
  // other startup failure), leaving the frontend pill stuck on "starting".
  const probe = new AbortController();
  proc.on('close', (code) => {
    pushLog(state, 'system', `Dev process exited (code ${code}).`);
    const wasUserStop = state.userStoppedAt !== null && Date.now() - state.userStoppedAt < 5000;
    state.proc = null;
    state.pid = null;
    state.lastExitCode = code;
    state.phase = wasUserStop ? 'stopped' : 'exited';
    probe.abort();
  });

  const ready = await probeReady(state, runtimeReadiness(config, state), probe.signal);
  if (ready) {
    state.phase = 'ready';
    pushLog(state, 'system', 'Dev process ready.');
    return { ok: true, vitePort: state.vitePort, previewPath: getPreviewRoutePath(lang), ready: true };
  }
  return { ok: true, vitePort: state.vitePort, previewPath: getPreviewRoutePath(lang), ready: false };
}

/**
 * Kill the spawned process and any descendants.
 *
 * `proc.kill('SIGTERM')` only signals the immediate child, which leaves
 * grandchildren orphaned in two real cases for this app:
 *   1. `pnpm dev` (Windows) → `pnpm.cmd` is a shell wrapper that spawns
 *      `node vite`. Killing the wrapper doesn't reach the node process.
 *   2. `dotnet run` → spawns the actual app binary (e.g. csharp.exe). The
 *      WPF window survives a SIGTERM to the dotnet host.
 *
 * On Windows we use `taskkill /T /F` to walk the process tree and force-kill
 * everything beneath the supervised PID. On Unix we still rely on SIGTERM
 * here — process-group kill needs `detached: true` at spawn time and isn't
 * worth the complexity until cross-platform desktop projects exist.
 */
function killProcessTree(proc) {
  if (proc === null || proc.pid === undefined) return;
  if (IS_WIN) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

export async function stopProject(scope, lang) {
  assertLang(lang);
  const state = procs.get(stateKey(scope, lang));
  if (!state?.proc) return { ok: true };
  const proc = state.proc;
  state.userStoppedAt = Date.now();
  killProcessTree(proc);
  await new Promise((res) => {
    const timer = setTimeout(() => {
      if (!IS_WIN) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
      res();
    }, STOP_GRACE_MS);
    proc.once('close', () => {
      clearTimeout(timer);
      res();
    });
  });
  state.proc = null;
  state.pid = null;
  state.phase = 'stopped';
  return { ok: true };
}

/**
 * Wipe the on-disk project folder and re-scaffold it from the template.
 * Stops the dev process first (best-effort — succeeds even if nothing is
 * running). Returns the same shape as ensureScaffold so the frontend can
 * trust the rebuild succeeded before reloading the tree / tabs.
 *
 * Throws on filesystem failure (caller should surface as a 500 error).
 */
export async function resetProject(scope, lang) {
  assertLang(lang);
  await stopProject(scope, lang);

  const state = procs.get(stateKey(scope, lang));
  if (state !== undefined) {
    // Clear log buffer, exit-code memory, and any latched 'error' phase so
    // the next /proj/start starts from a clean slate.
    state.logs = [];
    state.lastExitCode = null;
    state.userStoppedAt = null;
    state.error = null;
    state.phase = 'stopped';
  }

  const root = getProjectRoot(scope, lang);
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }

  return ensureScaffold(scope, lang);
}

export function getStatus(scope, lang) {
  assertLang(lang);
  const state = procs.get(stateKey(scope, lang));
  if (!state) {
    return {
      running: false,
      ready: false,
      phase: 'stopped',
      pid: null,
      lastExitCode: null,
      vitePort: getReadinessPort(lang),
      previewPath: getPreviewRoutePath(lang),
      error: null,
    };
  }
  return {
    running: state.proc !== null,
    ready: state.phase === 'ready',
    phase: state.phase,
    pid: state.pid,
    lastExitCode: state.lastExitCode,
    vitePort: state.vitePort,
    previewPath: getPreviewRoutePath(lang),
    error: state.error,
  };
}

export function getPreviewTarget(scope, lang) {
  assertLang(lang);
  const state = procs.get(stateKey(scope, lang));
  if (!state?.proc || state.vitePort === null || PROJECT_CONFIG[lang].readiness.kind !== 'http-probe') return null;
  return { port: state.vitePort };
}

export function getRecentLogs(scope, lang, n = 200) {
  assertLang(lang);
  const state = procs.get(stateKey(scope, lang));
  if (!state) return { lines: [] };
  const slice = state.logs.slice(-Math.max(0, Math.min(n, LOG_RING_SIZE)));
  return { lines: slice };
}

export function subscribeLogs(scope, lang, onEntry) {
  assertLang(lang);
  const state = getOrInitState(scope, lang);
  state.subs.add(onEntry);
  return () => state.subs.delete(onEntry);
}

// ── Open the project in an external editor / file manager ──────────────────

const OPEN_TARGETS = Object.freeze(new Set(['vscode', 'vs', 'explorer']));

let openAvailabilityCache = null;

/**
 * Probe (once per process) which external editors / file managers are
 * available. Cached because installed editors don't change during a dev
 * session, and the probes spawn subprocesses which is wasted work on every
 * dropdown open.
 *
 * @returns {{ vscode: boolean, vs: boolean, explorer: boolean }}
 */
export function getOpenAvailability() {
  if (openAvailabilityCache !== null) return openAvailabilityCache;
  openAvailabilityCache = {
    vscode: commandExists('code'),
    // Visual Studio: detect via PATH for `devenv`. Most installs add it; if not,
    // the option will be greyed out even when VS is technically present. Acceptable.
    vs: IS_WIN && executableInPath('devenv'),
    explorer: IS_WIN,
  };
  return openAvailabilityCache;
}

function findVisualStudioTarget(root) {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    const solution = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sln'));
    if (solution !== undefined) {
      return join(root, solution.name);
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.csproj')) {
        return join(root, entry.name);
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Launch an external editor / file manager pointed at the project root (or,
 * for Visual Studio, the .sln / .csproj inside it). Spawned detached + unref'd so
 * the launched app outlives the dev server.
 *
 * @param {string} lang     Project language id.
 * @param {string} target   One of OPEN_TARGETS.
 * @returns {{ ok: boolean, error?: string }}
 */
export function openProject(scope, lang, target) {
  assertLang(lang);
  if (!OPEN_TARGETS.has(target)) {
    return { ok: false, error: `unknown open target: ${target}` };
  }
  const root = getProjectRoot(scope, lang);
  if (!existsSync(root)) {
    return { ok: false, error: 'project not scaffolded yet' };
  }

  try {
    if (target === 'explorer') {
      if (!IS_WIN) return { ok: false, error: 'File Explorer is Windows-only' };
      spawn('explorer.exe', [root], { stdio: 'ignore', detached: true }).unref();
      return { ok: true };
    }

    if (target === 'vscode') {
      // `code` resolves to `code.cmd` on Windows — shell: true so the launcher finds it.
      spawn('code', [root], { stdio: 'ignore', detached: true, shell: IS_WIN }).unref();
      return { ok: true };
    }

    if (target === 'vs') {
      if (!IS_WIN) return { ok: false, error: 'Visual Studio is Windows-only' };
      const targetFile = findVisualStudioTarget(root);
      if (targetFile === null) return { ok: false, error: 'no .sln or .csproj found in project root' };
      // `start "" "<file>"` opens with the registered file association — Visual
      // Studio if installed. The empty "" is required because start treats
      // its first quoted arg as a window title.
      spawn('cmd', ['/c', 'start', '', targetFile], { stdio: 'ignore', detached: true }).unref();
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ok: false, error: 'no handler for target' };
}

// ── Filesystem watcher (chokidar) ──────────────────────────────────────────

/** @type {Map<string, { watcher: import('chokidar').FSWatcher, subs: Set<(e: {type: string, path: string}) => void> }>} */
const watchers = new Map();

function relPathFromAbs(abs, root) {
  return relative(root, abs).split(sep).join('/');
}

function fanoutFsEvent(state, type, abs, root, ignoreSet) {
  if (isRecentSelfWrite(abs)) return;
  const path = relPathFromAbs(abs, root);
  // Drop events for ignored top-level dirs (defense in depth — chokidar's
  // `ignored` option covers it, but watch events for nested paths inside an
  // ignored tree shouldn't propagate either).
  const top = path.split('/')[0];
  if (top !== undefined && ignoreSet.has(top)) return;
  for (const sub of state.subs) {
    try {
      sub({ type, path });
    } catch {
      // subscriber errors must not break the producer
    }
  }
}

function ensureWatcher(scope, lang) {
  const key = stateKey(scope, lang);
  const cached = watchers.get(key);
  if (cached !== undefined) return cached;

  const root = getProjectRoot(scope, lang);
  const ignoreSet = getTreeIgnore(lang);
  // chokidar's `ignored` accepts patterns or absolute paths; we use a
  // function that matches any path containing one of the per-language
  // ignore segments. This catches both top-level and nested matches.
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p) => {
      const segments = p.split(/[/\\]/);
      return segments.some((s) => ignoreSet.has(s));
    },
  });

  const state = { watcher, subs: new Set() };
  watchers.set(key, state);

  watcher.on('add', (p) => fanoutFsEvent(state, 'add', p, root, ignoreSet));
  watcher.on('change', (p) => fanoutFsEvent(state, 'change', p, root, ignoreSet));
  watcher.on('unlink', (p) => fanoutFsEvent(state, 'unlink', p, root, ignoreSet));
  watcher.on('addDir', (p) => fanoutFsEvent(state, 'addDir', p, root, ignoreSet));
  watcher.on('unlinkDir', (p) => fanoutFsEvent(state, 'unlinkDir', p, root, ignoreSet));
  watcher.on('error', (e) => {
    console.error(`[fs-watch:${lang}]`, e);
  });

  return state;
}

export function subscribeFsEvents(scope, lang, onEvent) {
  assertLang(lang);
  ensureScaffold(scope, lang);
  const state = ensureWatcher(scope, lang);
  state.subs.add(onEvent);
  return () => state.subs.delete(onEvent);
}

// ── WGC screenshot helper for desktop-process workspaces (csharp) ──────────
//
// Lazy-built C# helper at tools/wgc-capture/. On first capture (or when
// WGC_CAPTURE_REBUILD=1) we run `dotnet publish` against whichever Windows SDK
// is installed (probed at runtime), then spawn the resulting exe with the PID
// of the supervised process and two temp output paths.

const WGC_CAPTURE_DIR = join(__dirname, 'wgc-capture');
const WGC_CAPTURE_PUBLISH_DIR = join(WGC_CAPTURE_DIR, 'bin', 'Release', 'publish');
const WGC_CAPTURE_EXE = join(WGC_CAPTURE_PUBLISH_DIR, 'wgc-capture.exe');
const UAP_PLATFORMS_DIR = 'C:\\Program Files (x86)\\Windows Kits\\10\\Platforms\\UAP';

/**
 * Return the highest installed Windows SDK platform version under
 * Windows Kits\10\Platforms\UAP\, or null if none. Format: '10.0.X.X'.
 */
function findWindowsSdkVersion() {
  if (!IS_WIN) return null;
  if (!existsSync(UAP_PLATFORMS_DIR)) return null;
  let entries;
  try {
    entries = readdirSync(UAP_PLATFORMS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^10\.0\.\d+\.\d+$/.test(e.name)) continue;
    if (!existsSync(join(UAP_PLATFORMS_DIR, e.name, 'Platform.xml'))) continue;
    versions.push(e.name);
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    const av = a.split('.').map(Number);
    const bv = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
      const ai = av[i] ?? 0;
      const bi = bv[i] ?? 0;
      if (ai !== bi) return ai - bi;
    }
    return 0;
  });
  return versions[versions.length - 1];
}

/**
 * Lazy-build the WGC capture helper exe. Returns { ok, error? }. The build is
 * cached by the existence of WGC_CAPTURE_EXE; setting WGC_CAPTURE_REBUILD=1
 * forces a fresh publish (useful when iterating on Program.cs).
 */
function ensureWgcHelper() {
  if (process.env.WGC_CAPTURE_REBUILD !== '1' && existsSync(WGC_CAPTURE_EXE)) {
    return { ok: true };
  }
  if (!commandExists('dotnet')) return { ok: false, error: missingCmdHint('dotnet') };
  const sdkVersion = findWindowsSdkVersion();
  if (sdkVersion === null) return { ok: false, error: WGC_NO_SDK_HINT };

  const args = [
    'publish',
    WGC_CAPTURE_DIR,
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'false',
    '-p:PublishSingleFile=true',
    `-p:WgcWindowsSdkVersion=${sdkVersion}`,
    '-p:PublishDir=bin/Release/publish/',
  ];
  let result;
  try {
    result = spawnSync('dotnet', args, { shell: IS_WIN, encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    return { ok: false, error: `dotnet publish threw: ${e.message}` };
  }
  if (result.status !== 0) {
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    // Catch the very specific "no Platform.xml" error and surface the SDK hint
    // — otherwise dump the last few lines of dotnet's output.
    if (/Platform\.xml/i.test(out)) return { ok: false, error: WGC_NO_SDK_HINT };
    const tail = out.split('\n').slice(-8).join('\n');
    return { ok: false, error: `wgc-capture build failed (exit ${result.status}):\n${tail}` };
  }
  if (!existsSync(WGC_CAPTURE_EXE)) {
    return { ok: false, error: `wgc-capture build succeeded but exe not at ${WGC_CAPTURE_EXE}` };
  }
  return { ok: true };
}

const WGC_CAPTURE_TIMEOUT_MS = 4_000;

/**
 * Capture a PNG of the running desktop process's main window via the WGC
 * helper exe. Returns `{ ok, fullDataUrl?, thumbDataUrl?, error? }`. On any
 * failure the error string is suitable to surface directly to the student.
 */
export async function captureProjectScreenshot(scope, lang) {
  assertLang(lang);
  if (PROJECT_CONFIG[lang].readiness.kind !== 'process-alive') {
    return { ok: false, error: `screenshot capture not supported for ${lang}` };
  }
  if (!IS_WIN) {
    return { ok: false, error: 'desktop screenshot capture is Windows-only (WGC).' };
  }
  const state = procs.get(stateKey(scope, lang));
  if (!state?.proc || state.pid === null) {
    return { ok: false, error: 'process not running' };
  }
  const pid = state.pid;

  const build = ensureWgcHelper();
  if (!build.ok) return { ok: false, error: build.error };

  const tempBase = join(tmpdir(), `lang-tutor-shot-${randomBytes(6).toString('hex')}`);
  const fullPath = `${tempBase}-full.png`;
  const thumbPath = `${tempBase}-thumb.png`;

  const exit = await new Promise((res) => {
    let settled = false;
    const child = spawn(WGC_CAPTURE_EXE, ['--pid', String(pid), '--full', fullPath, '--thumb', thumbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      res({ code: null, stderr: `wgc-capture timed out after ${WGC_CAPTURE_TIMEOUT_MS} ms` });
    }, WGC_CAPTURE_TIMEOUT_MS);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, stderr: stderr.trim() });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code: null, stderr: `wgc-capture spawn error: ${err.message}` });
    });
  });

  const cleanup = () => {
    for (const p of [fullPath, thumbPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  };

  if (exit.code !== 0) {
    cleanup();
    return { ok: false, error: mapWgcStderr(exit.stderr) };
  }

  let fullBytes;
  let thumbBytes;
  try {
    fullBytes = readFileSync(fullPath);
    thumbBytes = readFileSync(thumbPath);
  } catch (e) {
    cleanup();
    return { ok: false, error: `wgc-capture exit 0 but PNG read failed: ${e.message}` };
  }
  cleanup();

  const fullDataUrl = `data:image/png;base64,${fullBytes.toString('base64')}`;
  const thumbDataUrl = `data:image/png;base64,${thumbBytes.toString('base64')}`;
  return { ok: true, fullDataUrl, thumbDataUrl };
}

/**
 * Map stderr from the WGC helper to a friendly hint. The Program.cs prints one
 * line per failure; we recognise the common shapes and pass everything else
 * through (truncated).
 */
function mapWgcStderr(stderr) {
  const s = stderr ?? '';
  if (/no top-level window found for PID/i.test(s)) {
    return 'No top-level window found yet — give the app a moment to open its main window, then try again.';
  }
  if (/WGC unavailable/i.test(s) || /RPC_E_DISCONNECTED/i.test(s)) {
    return 'Windows Graphics Capture is unavailable on this system. WGC requires Windows 10 May 2020 Update (build 19041) or newer.';
  }
  if (/window not capturable/i.test(s) || /E_FAIL/i.test(s)) {
    return 'Windows refused to capture this window (it may be transparent, minimised, or use a non-capturable composition layer).';
  }
  if (/no frame arrived/i.test(s) || /timed out/i.test(s)) {
    return 'Capture timed out — the window may be minimised, off-screen, or the renderer is stuck.';
  }
  if (/D3D11CreateDevice failed/i.test(s)) {
    return 'Direct3D 11 device creation failed (graphics driver issue?). Try restarting the app.';
  }
  const tail = s
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(-2)
    .join(' · ');
  return tail.length > 0 ? `wgc-capture: ${tail}` : 'wgc-capture failed with no stderr output.';
}
