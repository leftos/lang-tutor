/**
 * Project workspace manager for project-kind languages (currently `web`,
 * with `csharp` arriving in Phase 2).
 *
 * Owns:
 *  - Scaffolding the on-disk workspace under projects/<scaffoldDir>/.
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
 * SECURITY: Like tools/checker.mjs, every spawn uses array-form `spawn(cmd, args[])`.
 * No shell, no string concatenation. The only user-controlled input is file content
 * (written via stdin to the file) and file paths (validated against project root).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROJECTS_DIR = join(REPO_ROOT, 'projects');

const LOG_RING_SIZE = 500;
const READY_PROBE_INTERVAL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;
const PROCESS_ALIVE_DEFAULT_MS = 500;

const IS_WIN = process.platform === 'win32';
const PNPM = IS_WIN ? 'pnpm.cmd' : 'pnpm';

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
 *     | { kind: 'http-probe', port: number }
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
    install: { cmd: PNPM, args: ['install'], marker: 'node_modules' },
    dev: { cmd: PNPM, args: ['dev'] },
    readiness: { kind: 'http-probe', port: 5180 },
    treeIgnore: new Set(['node_modules', '.git', 'dist', '.vite']),
    bootstrap: 'web-iframe',
  },
  csharp: {
    scaffoldDir: 'csharp',
    install: { cmd: 'dotnet', args: ['restore'], marker: 'obj' },
    dev: { cmd: 'dotnet', args: ['run'] },
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
  pnpm: 'pnpm not found on PATH. Install with `npm install -g pnpm` and restart the dev server.',
});

function missingCmdHint(cmd) {
  const baseName = cmd.replace(/\.(cmd|exe|bat)$/i, '');
  return MISSING_CMD_HINTS[baseName] ?? `${cmd} not found on PATH. Install it and restart the dev server.`;
}

/**
 * Best-effort check for whether a command can be spawned. Uses spawnSync with
 * `--version` since both `pnpm` and `dotnet` (the only commands we care about
 * today) respond to it cheaply. ENOENT means the executable isn't on PATH.
 *
 * On Windows with `shell: true`, a missing command exits non-zero through
 * cmd.exe rather than emitting the ENOENT error event — so we treat any
 * non-zero exit AND any error event as "missing" here.
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
  return r.kind === 'http-probe' ? r.port : null;
}

// ── Iframe bootstrap (DOM snapshot + console capture for evaluate) ──
//
// Re-injected into projects/<lang>/index.html on every /proj/start so the
// student can't accidentally break the Send-to-tutor flow. Idempotent via
// the marker comments.

const BOOTSTRAP_START = '<!-- lang-tutor:bootstrap-start -->';
const BOOTSTRAP_END = '<!-- lang-tutor:bootstrap-end -->';

const BOOTSTRAP_SCRIPT = `${BOOTSTRAP_START}
<script>
(() => {
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
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'lang-tutor:snapshot-request') return;
    const reply = {
      type: 'lang-tutor:snapshot-reply',
      requestId: data.requestId,
      dom: document.documentElement.outerHTML,
      consoleBuffer: buffer.slice(),
      url: location.href,
      title: document.title,
    };
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(reply, event.origin || '*');
    }
  });
})();
</script>
${BOOTSTRAP_END}`;

function injectBootstrap(lang) {
  if (PROJECT_CONFIG[lang].bootstrap !== 'web-iframe') return;
  const root = getProjectRoot(lang);
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) return;
  const original = readFileSync(indexPath, 'utf8');

  // Strip any existing bootstrap block (so an update to BOOTSTRAP_SCRIPT
  // takes effect on next start).
  const startIdx = original.indexOf(BOOTSTRAP_START);
  const endIdx = original.indexOf(BOOTSTRAP_END);
  let stripped = original;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = original.slice(0, startIdx).replace(/\s+$/, '');
    const after = original.slice(endIdx + BOOTSTRAP_END.length);
    stripped = before + after;
  }

  // Inject right after the opening <head> tag — earliest point where a
  // script can intercept console calls before page scripts run.
  const headOpen = stripped.search(/<head\b[^>]*>/i);
  if (headOpen === -1) return; // not an HTML doc with <head> — skip silently
  const headEnd = stripped.indexOf('>', headOpen) + 1;
  const updated = `${stripped.slice(0, headEnd)}\n${BOOTSTRAP_SCRIPT}\n${stripped.slice(headEnd).replace(/^\s+/, '')}`;

  if (updated === original) return;
  writeFileSync(indexPath, updated, 'utf8');
  markSelfWrite(indexPath);
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

export function getProjectRoot(lang) {
  assertLang(lang);
  return join(PROJECTS_DIR, PROJECT_CONFIG[lang].scaffoldDir);
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
      scripts: { dev: 'vite --port 5180 --strictPort --host 127.0.0.1' },
      devDependencies: { vite: '^7.0.0' },
    },
    null,
    2
  )}\n`,

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

Vite serves it on http://localhost:5180 with hot reload. Edit the files here or
through any other editor — lang-tutor reads and writes them on disk.
`,
};

const SCAFFOLD_CSHARP = {
  'csharp.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>LangTutorWpf</RootNamespace>
  </PropertyGroup>
</Project>
`,

  'App.xaml': `<Application x:Class="LangTutorWpf.App"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             StartupUri="MainWindow.xaml">
    <Application.Resources>
    </Application.Resources>
</Application>
`,

  'App.xaml.cs': `using System.Windows;

namespace LangTutorWpf;

public partial class App : Application
{
}
`,

  'MainWindow.xaml': `<Window x:Class="LangTutorWpf.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Lang Tutor · C# Workshop"
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

  'MainWindow.xaml.cs': `using System.Windows;

namespace LangTutorWpf;

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

  'README.md': `# Your C# workshop

This folder is your sandbox for the C# course in lang-tutor.

- \`csharp.csproj\` — project file: target framework, references, build settings
- \`App.xaml\` / \`App.xaml.cs\` — application entry point, sets the startup window
- \`MainWindow.xaml\` / \`MainWindow.xaml.cs\` — the window that opens when you run

When you click Run in lang-tutor (or run \`dotnet run\` here), .NET will:

1. Restore NuGet packages (one-time, cached after)
2. Compile the C# + XAML
3. Launch the WPF window on your desktop

The window is a real Windows app, not an in-browser preview — it pops up on top
of your other windows. Click the button to watch the click counter increment.

You can also build and run from Visual Studio or JetBrains Rider by opening the
\`.csproj\` file directly.
`,
};

const SCAFFOLDS = Object.freeze({ web: SCAFFOLD_WEB, csharp: SCAFFOLD_CSHARP });

export function ensureScaffold(lang) {
  const root = getProjectRoot(lang);
  const template = SCAFFOLDS[lang];
  if (!template) throw new Error(`no scaffold defined for ${lang}`);

  const created = [];
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  for (const [relPath, content] of Object.entries(template)) {
    const abs = safeResolve(root, relPath);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    created.push(relPath);
  }
  return { root, created };
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

export function getTree(lang) {
  const root = getProjectRoot(lang);
  if (!existsSync(root)) return { tree: null, scaffolded: false };
  return { tree: buildTree(root, root, getTreeIgnore(lang)), scaffolded: true };
}

export function readFile(lang, relPath) {
  const root = getProjectRoot(lang);
  const abs = safeResolve(root, relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`file not found: ${relPath}`);
  }
  return { content: readFileSync(abs, 'utf8') };
}

export function writeFile(lang, relPath, content) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const root = getProjectRoot(lang);
  const abs = safeResolve(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  markSelfWrite(abs);
  return { ok: true };
}

export function renameFile(lang, fromRel, toRel) {
  const root = getProjectRoot(lang);
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

export function deleteFile(lang, relPath) {
  const root = getProjectRoot(lang);
  const abs = safeResolve(root, relPath);
  if (abs === root) throw new Error('cannot delete project root');
  if (!existsSync(abs)) return { ok: true };
  rmSync(abs, { recursive: true, force: true });
  markSelfWrite(abs);
  return { ok: true };
}

export function mkdir(lang, relPath) {
  const root = getProjectRoot(lang);
  const abs = safeResolve(root, relPath);
  mkdirSync(abs, { recursive: true });
  markSelfWrite(abs);
  return { ok: true };
}

// ── Process supervision ────────────────────────────────────────────────────

/** @type {Map<string, ProcState>} */
const procs = new Map();

/**
 * @typedef {object} ProcState
 * @property {import('node:child_process').ChildProcess | null} proc
 * @property {string} phase  'install' | 'starting' | 'ready' | 'stopped' | 'error'
 * @property {number | null} vitePort  Null for desktop projects with no HTTP server.
 * @property {Array<{stream: string, line: string, ts: number}>} logs
 * @property {Set<(entry: {stream: string, line: string, ts: number}) => void>} subs
 * @property {string | null} error
 */

function getOrInitState(lang) {
  let s = procs.get(lang);
  if (!s) {
    s = {
      proc: null,
      phase: 'stopped',
      vitePort: getReadinessPort(lang),
      logs: [],
      subs: new Set(),
      error: null,
    };
    procs.set(lang, s);
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

function spawnLogged(state, cmd, args, cwd, phaseTag) {
  pushLog(state, 'system', `$ ${cmd} ${args.join(' ')}  (in ${cwd})`);
  let proc;
  try {
    // Node 20+ on Windows refuses to spawn .cmd/.bat files without shell:true
    // (CVE-2024-27980). Args here are hardcoded constants ('install', 'dev'),
    // and cwd is a validated absolute path — no injection vector.
    proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
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
    pushLog(state, 'system', `Running ${label} (one-time)…`);
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

function describeStartTarget(config) {
  const { readiness } = config;
  if (readiness.kind === 'http-probe') return `http://127.0.0.1:${readiness.port}`;
  return `${config.dev.cmd} ${config.dev.args.join(' ')}`;
}

export async function startProject(lang) {
  assertLang(lang);
  const config = PROJECT_CONFIG[lang];
  const state = getOrInitState(lang);

  if (state.proc !== null && (state.phase === 'starting' || state.phase === 'ready')) {
    return { ok: true, vitePort: state.vitePort, ready: state.phase === 'ready' };
  }

  ensureScaffold(lang);
  injectBootstrap(lang);
  const cwd = getProjectRoot(lang);
  state.error = null;

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

  if (config.install !== null && !existsSync(join(cwd, config.install.marker))) {
    const ok = await runInstall(state, cwd, config.install);
    if (!ok) return { ok: false, error: state.error ?? 'install failed' };
  }

  state.phase = 'starting';
  pushLog(state, 'system', `Starting ${describeStartTarget(config)} …`);
  const proc = spawnLogged(state, config.dev.cmd, config.dev.args, cwd, 'dev');
  if (!proc) return { ok: false, error: state.error ?? 'spawn failed' };

  state.proc = proc;
  proc.on('close', (code) => {
    pushLog(state, 'system', `Dev process exited (code ${code}).`);
    state.proc = null;
    state.phase = 'stopped';
  });

  const probe = new AbortController();
  const ready = await probeReady(state, config.readiness, probe.signal);
  if (ready) {
    state.phase = 'ready';
    pushLog(state, 'system', 'Dev process ready.');
    return { ok: true, vitePort: state.vitePort, ready: true };
  }
  return { ok: true, vitePort: state.vitePort, ready: false };
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

export async function stopProject(lang) {
  assertLang(lang);
  const state = procs.get(lang);
  if (!state?.proc) return { ok: true };
  const proc = state.proc;
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
  state.phase = 'stopped';
  return { ok: true };
}

export function getStatus(lang) {
  assertLang(lang);
  const state = procs.get(lang);
  if (!state) {
    return { running: false, ready: false, phase: 'stopped', vitePort: getReadinessPort(lang), error: null };
  }
  return {
    running: state.proc !== null,
    ready: state.phase === 'ready',
    phase: state.phase,
    vitePort: state.vitePort,
    error: state.error,
  };
}

export function getRecentLogs(lang, n = 200) {
  assertLang(lang);
  const state = procs.get(lang);
  if (!state) return { lines: [] };
  const slice = state.logs.slice(-Math.max(0, Math.min(n, LOG_RING_SIZE)));
  return { lines: slice };
}

export function subscribeLogs(lang, onEntry) {
  assertLang(lang);
  const state = getOrInitState(lang);
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

function findCsproj(root) {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.csproj')) {
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
 * for Visual Studio, the .csproj inside it). Spawned detached + unref'd so
 * the launched app outlives the dev server.
 *
 * @param {string} lang     Project language id.
 * @param {string} target   One of OPEN_TARGETS.
 * @returns {{ ok: boolean, error?: string }}
 */
export function openProject(lang, target) {
  assertLang(lang);
  if (!OPEN_TARGETS.has(target)) {
    return { ok: false, error: `unknown open target: ${target}` };
  }
  const root = getProjectRoot(lang);
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
      const csproj = findCsproj(root);
      if (csproj === null) return { ok: false, error: 'no .csproj found in project root' };
      // `start "" "<file>"` opens with the registered file association — Visual
      // Studio if installed. The empty "" is required because start treats
      // its first quoted arg as a window title.
      spawn('cmd', ['/c', 'start', '', csproj], { stdio: 'ignore', detached: true }).unref();
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

function ensureWatcher(lang) {
  const cached = watchers.get(lang);
  if (cached !== undefined) return cached;

  const root = getProjectRoot(lang);
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
  watchers.set(lang, state);

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

export function subscribeFsEvents(lang, onEvent) {
  assertLang(lang);
  ensureScaffold(lang);
  const state = ensureWatcher(lang);
  state.subs.add(onEvent);
  return () => state.subs.delete(onEvent);
}
