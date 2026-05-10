/**
 * Project workspace manager for the web-course "language".
 *
 * Owns:
 *  - Scaffolding the on-disk workspace under projects/<scaffoldDir>/.
 *  - File CRUD (tree / read / write / rename / delete / mkdir) with strict
 *    path-traversal rejection — every path is resolved against the project root
 *    and rejected if it escapes.
 *  - Process supervision: lazy `pnpm install`, then `pnpm dev` on a fixed port.
 *    Stdout/stderr are streamed into a per-language ring buffer and broadcast
 *    to SSE subscribers.
 *  - Readiness probe: poll the dev port until it responds 2xx, then mark ready.
 *
 * SECURITY: Like tools/checker.mjs, every spawn uses array-form `spawn(cmd, args[])`.
 * No shell, no string concatenation. The only user-controlled input is file content
 * (written via stdin to the file) and file paths (validated against project root).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROJECTS_DIR = join(REPO_ROOT, 'projects');

const SCAFFOLD_DIRS = Object.freeze({ web: 'web' });
const ALLOWED_LANGS = Object.freeze(new Set(['web']));

const PORTS = Object.freeze({ web: { vite: 5180 } });

const LOG_RING_SIZE = 500;
const READY_PROBE_INTERVAL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;

const IS_WIN = process.platform === 'win32';
const PNPM = IS_WIN ? 'pnpm.cmd' : 'pnpm';

const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', '.vite']);

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
  return join(PROJECTS_DIR, SCAFFOLD_DIRS[lang]);
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

const SCAFFOLDS = Object.freeze({ web: SCAFFOLD_WEB });

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

function buildTree(absDir, projectRoot) {
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
    if (TREE_IGNORE.has(entry.name)) continue;
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) {
      node.children.push(buildTree(child, projectRoot));
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
  return { tree: buildTree(root, root), scaffolded: true };
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
 * @property {number} vitePort
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
      vitePort: PORTS[lang].vite,
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

async function probeReady(port, signal) {
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

function runInstall(state, cwd) {
  return new Promise((resolveInstall) => {
    state.phase = 'install';
    pushLog(state, 'system', 'Running pnpm install (one-time)…');
    const proc = spawnLogged(state, PNPM, ['install'], cwd, 'install');
    if (!proc) {
      resolveInstall(false);
      return;
    }
    proc.on('close', (code) => {
      if (code === 0) {
        pushLog(state, 'system', 'pnpm install complete.');
        resolveInstall(true);
      } else {
        pushLog(state, 'system', `pnpm install exited with code ${code}.`);
        state.phase = 'error';
        state.error = `pnpm install exited ${code}`;
        resolveInstall(false);
      }
    });
  });
}

export async function startProject(lang) {
  assertLang(lang);
  const state = getOrInitState(lang);

  if (state.proc !== null && (state.phase === 'starting' || state.phase === 'ready')) {
    return { ok: true, vitePort: state.vitePort, ready: state.phase === 'ready' };
  }

  ensureScaffold(lang);
  const cwd = getProjectRoot(lang);
  state.error = null;

  if (!existsSync(join(cwd, 'node_modules'))) {
    const ok = await runInstall(state, cwd);
    if (!ok) return { ok: false, error: state.error ?? 'install failed' };
  }

  state.phase = 'starting';
  pushLog(state, 'system', `Starting Vite on http://127.0.0.1:${state.vitePort} …`);
  const proc = spawnLogged(state, PNPM, ['dev'], cwd, 'dev');
  if (!proc) return { ok: false, error: state.error ?? 'spawn failed' };

  state.proc = proc;
  proc.on('close', (code) => {
    pushLog(state, 'system', `Dev server exited (code ${code}).`);
    state.proc = null;
    state.phase = 'stopped';
  });

  const probe = new AbortController();
  const ready = await probeReady(state.vitePort, probe.signal);
  if (ready) {
    state.phase = 'ready';
    pushLog(state, 'system', 'Dev server ready.');
    return { ok: true, vitePort: state.vitePort, ready: true };
  }
  return { ok: true, vitePort: state.vitePort, ready: false };
}

export async function stopProject(lang) {
  assertLang(lang);
  const state = procs.get(lang);
  if (!state?.proc) return { ok: true };
  const proc = state.proc;
  proc.kill('SIGTERM');
  await new Promise((res) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already dead
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
    return { running: false, ready: false, phase: 'stopped', vitePort: PORTS[lang].vite, error: null };
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

// ── Filesystem watcher (chokidar) ──────────────────────────────────────────

/** @type {Map<string, { watcher: import('chokidar').FSWatcher, subs: Set<(e: {type: string, path: string}) => void> }>} */
const watchers = new Map();

function relPathFromAbs(abs, root) {
  return relative(root, abs).split(sep).join('/');
}

function fanoutFsEvent(state, type, abs, root) {
  if (isRecentSelfWrite(abs)) return;
  const path = relPathFromAbs(abs, root);
  // Drop events for ignored top-level dirs (defense in depth — chokidar's
  // `ignored` option covers it, but watch events for nested paths inside an
  // ignored tree shouldn't propagate either).
  const top = path.split('/')[0];
  if (top !== undefined && TREE_IGNORE.has(top)) return;
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
  // chokidar's `ignored` accepts patterns or absolute paths; we use a
  // function that matches any path containing one of the TREE_IGNORE
  // segments. This catches both top-level and nested matches.
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p) => {
      const segments = p.split(/[/\\]/);
      return segments.some((s) => TREE_IGNORE.has(s));
    },
  });

  const state = { watcher, subs: new Set() };
  watchers.set(lang, state);

  watcher.on('add', (p) => fanoutFsEvent(state, 'add', p, root));
  watcher.on('change', (p) => fanoutFsEvent(state, 'change', p, root));
  watcher.on('unlink', (p) => fanoutFsEvent(state, 'unlink', p, root));
  watcher.on('addDir', (p) => fanoutFsEvent(state, 'addDir', p, root));
  watcher.on('unlinkDir', (p) => fanoutFsEvent(state, 'unlinkDir', p, root));
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
