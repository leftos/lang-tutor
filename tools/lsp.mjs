/**
 * LSP bridge — long-lived language servers fronted by WebSocket.
 *
 * Architecture:
 *   Browser ── WS /lsp?session=<id> ──> tools/lsp.mjs ── stdio (LSP) ──> clangd | rust-analyzer | ...
 *
 * Lifecycle:
 *   POST /lsp/spawn { lang }                   → { ok, rootUri, mainFileUri?,
 *                                                  servers: [{ serverKey, sessionId, acceptsLanguageIds }],
 *                                                  unavailable: [...] }
 *                                                One bundle per language: a single LSP_CONFIG entry
 *                                                for single-server langs (cpp/rust/python/csharp), or a
 *                                                fan-out across tsserver+html+css+biome for `web`.
 *   GET  /lsp/availability?lang=<lang>         → { available, version?, error? } (per-server, takes a
 *                                                serverKey — used by setup probes; the spawn endpoint
 *                                                short-circuits per-server when the bin is missing.)
 *   WS   /lsp?session=<id>                     → bidirectional JSON-RPC (raw JSON over WS,
 *                                                Content-Length-framed on stdio)
 *   POST /lsp/dispose { sessionId }            → graceful shutdown + reap (also auto on WS close)
 *
 * New languages are added by extending LSP_CONFIG (one entry per server) and LANG_SERVERS (the
 * ordered fan-out per user-facing language).
 *
 * SECURITY: all spawns use the array form of `spawn` from node:child_process — no shell.
 * The binary names and arg arrays are hardcoded constants in LSP_CONFIG. User code travels
 * through stdin only, never argv. Workspace paths are generated server-side; the client
 * only supplies a `lang` enum which we validate against LSP_CONFIG keys.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMP_LSP_ROOT = join(REPO_ROOT, '.tmp', 'lsp');

// Windows: `shell: true` lets spawn resolve .cmd / .bat shims (npm-global
// installs like typescript-language-server) which Node otherwise can't run
// directly. Safe here because every spawn argv is a hardcoded LSP_CONFIG
// constant — never user input — so there's no shell-injection vector.
const IS_WIN = process.platform === 'win32';

// ── Per-language config ─────────────────────────────────────────────────────

/**
 * @typedef {object} LspConfig
 * @property {string} bin                   - executable on PATH
 * @property {string[]} args                - hardcoded argv (no user data)
 * @property {'fresh' | 'project'} [workspaceMode] - 'fresh' (default) creates `.tmp/lsp/<sid>/`
 *           and seeds files; 'project' uses the existing `projects/<projectDir>/` directory and
 *           does not seed any files.
 * @property {string} [projectDir]          - subdirectory under projects/ (project mode only)
 * @property {string} [mainFile]            - filename inside the workspace dir (fresh mode)
 * @property {Record<string,string>} [workspaceFiles]  - extra files to seed (fresh mode)
 * @property {string[]} versionArgs         - args to call for availability probe
 * @property {string} [probeBin]            - optional alternate binary for the probe (defaults to `bin`).
 *           Useful when the LSP binary itself doesn't support a clean `--version`
 *           but a sibling CLI does (e.g. basedpyright-langserver vs basedpyright).
 * @property {boolean} [syncToDisk]         - when true, the bridge intercepts didChange / didOpen
 *           notifications, debounces, and writes the buffer to the file the URI points to. Use
 *           for servers whose flycheck (or equivalent) reads on-disk content rather than the LSP
 *           buffer (rust-analyzer + cargo check is the canonical case).
 * @property {string[]} [acceptsLanguageIds] - LSP languageIds this server handles. The frontend
 *           dispatches per-file didOpen / didChange to every server whose set covers the file's
 *           languageId. Omit for single-server languages (the frontend treats those as universal).
 */

/**
 * LSP server entries are keyed by `serverKey`. Single-server languages reuse
 * the language name as the key (`cpp`, `rust`, `python`, `csharp`); the `web`
 * project workspace fans out to multiple servers (typescript-language-server
 * primary, plus HTML / CSS / Biome) and each gets its own key.
 *
 * @type {Record<string, LspConfig>}
 */
const LSP_CONFIG = {
  cpp: {
    bin: 'clangd',
    args: ['--log=error', '--background-index=false', '--pch-storage=memory', '--clang-tidy=false', '--limit-results=50'],
    mainFile: 'main.cpp',
    workspaceFiles: {
      'compile_flags.txt': '-std=c++23\n-Wall\n-Wextra\n',
    },
    versionArgs: ['--version'],
  },

  rust: {
    bin: 'rust-analyzer',
    args: [],
    // rust-analyzer expects a Cargo workspace; the main file lives under src/.
    mainFile: 'src/main.rs',
    // rust-analyzer's flycheck (cargo check) reads on-disk content, not the
    // LSP buffer, so without disk sync the server's name-resolution and type
    // errors lag the editor by however long until the user saves. With this
    // on, every didChange triggers a debounced disk write.
    syncToDisk: true,
    workspaceFiles: {
      'Cargo.toml': [
        '[package]',
        'name = "lesson"',
        'version = "0.0.1"',
        'edition = "2021"',
        '',
        '[[bin]]',
        'name = "lesson"',
        'path = "src/main.rs"',
        '',
      ].join('\n'),
    },
    versionArgs: ['--version'],
  },

  python: {
    // basedpyright ships the langserver as `basedpyright-langserver`; --stdio
    // is required to speak LSP over our pipe-based bridge. The langserver
    // binary itself doesn't accept `--version` (it crashes without a transport
    // flag), so probe via the sibling `basedpyright` CLI which reports cleanly.
    bin: 'basedpyright-langserver',
    args: ['--stdio'],
    probeBin: 'basedpyright',
    mainFile: 'main.py',
    workspaceFiles: {
      'pyrightconfig.json': JSON.stringify({ pythonVersion: '3.13', typeCheckingMode: 'standard', reportMissingImports: 'warning' }, null, 2),
    },
    versionArgs: ['--version'],
  },

  csharp: {
    // OmniSharp's modern LSP entry point. `omnisharp -lsp` speaks LSP over
    // stdin/stdout and reads the .csproj/.sln in cwd. Microsoft's Roslyn LSP
    // (`Microsoft.CodeAnalysis.LanguageServer`) is preferable when available
    // but its install path is undocumented and version-coupled to the C# Dev
    // Kit extension; OmniSharp is the more reliable single-binary install.
    //
    // versionArgs is empty: `omnisharp --version` actually starts the full
    // server (no quick exit), which would block our availability probe past
    // the 5 s timeout. The PATH lookup in whichBin is enough to confirm
    // installation; the version string falls back to the resolved path.
    bin: 'omnisharp',
    args: ['-lsp'],
    workspaceMode: 'project',
    projectDir: 'csharp',
    versionArgs: [],
  },

  // ── Web project: tsserver (primary) + HTML/CSS/Biome (fan-out) ───────────
  // All four share `projects/web/` as the workspace dir. The frontend routes
  // didOpen / didChange / didClose per-file to the servers whose
  // acceptsLanguageIds set includes the file's languageId, then merges
  // diagnostics across them in [LSP] / gutter.
  web: {
    // typescript-language-server wraps tsserver and speaks LSP over --stdio.
    // It handles `.js` files when a jsconfig.json with checkJs is present in
    // the workspace, so we get type-checking-quality diagnostics even on
    // plain JavaScript lessons.
    bin: 'typescript-language-server',
    args: ['--stdio'],
    workspaceMode: 'project',
    projectDir: 'web',
    acceptsLanguageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    versionArgs: ['--version'],
  },

  'web-html': {
    // vscode-html-language-server (from `vscode-langservers-extracted`).
    // The npm-global shim is `.cmd` on Windows so spawn needs `shell: true` —
    // that's set globally by IS_WIN.
    bin: 'vscode-html-language-server',
    args: ['--stdio'],
    workspaceMode: 'project',
    projectDir: 'web',
    acceptsLanguageIds: ['html'],
    versionArgs: ['--version'],
  },

  'web-css': {
    bin: 'vscode-css-language-server',
    args: ['--stdio'],
    workspaceMode: 'project',
    projectDir: 'web',
    acceptsLanguageIds: ['css', 'scss', 'less'],
    versionArgs: ['--version'],
  },

  'web-biome': {
    // Biome's LSP for fast lint feedback alongside tsserver. Biome is already
    // in projects/web/'s devDependencies (used by vite-plugin-checker), so
    // when typescript-language-server is installed Biome usually is too.
    bin: 'biome',
    args: ['lsp-proxy'],
    workspaceMode: 'project',
    projectDir: 'web',
    acceptsLanguageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'json'],
    versionArgs: ['--version'],
  },
};

/**
 * User-facing language → ordered list of serverKeys to spawn. The first entry
 * is the "primary" — its capabilities seed the frontend's `LspClient.capabilities`
 * snapshot, and its mainFileUri (if any) is exposed for single-buffer convenience.
 *
 * @type {Record<string, string[]>}
 */
const LANG_SERVERS = {
  cpp: ['cpp'],
  rust: ['rust'],
  python: ['python'],
  csharp: ['csharp'],
  web: ['web', 'web-html', 'web-css', 'web-biome'],
};

// ── Globals (HMR-safe) ──────────────────────────────────────────────────────
//
// Vite re-evaluates this module every time it's edited; a fresh module
// instance with empty maps would orphan every running LSP child the previous
// instance was supervising. Stashing on globalThis preserves PIDs.

const SESSIONS_KEY = '__langTutorLsps';
const EXIT_HOOK_KEY = '__langTutorLspExitHookInstalled';
const AVAILABILITY_KEY = '__langTutorLspAvailability';
const WSS_KEY = '__langTutorLspWss';

/**
 * @typedef {object} LspSession
 * @property {string} lang
 * @property {import('node:child_process').ChildProcessWithoutNullStreams} proc
 * @property {string} workspaceDir
 * @property {boolean} workspaceEphemeral - true → delete on exit; false → leave projects/ alone
 * @property {import('ws').WebSocket | null} ws
 * @property {Buffer} stdoutBuffer        - partial Content-Length frame buffer
 * @property {number} lastActivity        - epoch ms; bumped on every byte either direction
 * @property {NodeJS.Timeout | null} idleTimer
 * @property {Map<string, { timer: NodeJS.Timeout; text: string }>} [syncQueue] - per-URI debounced disk writes (lazy)
 */

/** @type {Map<string, LspSession>} */
const sessions = (() => {
  const existing = /** @type {Map<string, LspSession> | undefined} */ (globalThis[SESSIONS_KEY]);
  if (existing instanceof Map) {
    // Drop stale ws references — the previous module instance's WebSockets
    // are dead even if the LSP children are alive.
    for (const s of existing.values()) s.ws = null;
    return existing;
  }
  const fresh = new Map();
  globalThis[SESSIONS_KEY] = fresh;
  return fresh;
})();

/** @type {Map<string, { available: boolean; version?: string; error?: string }>} */
const availabilityCache = (() => {
  const existing = globalThis[AVAILABILITY_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map();
  globalThis[AVAILABILITY_KEY] = fresh;
  return fresh;
})();

if (globalThis[EXIT_HOOK_KEY] !== true) {
  globalThis[EXIT_HOOK_KEY] = true;
  const cleanup = () => {
    for (const sid of Array.from(sessions.keys())) {
      // Best-effort kill — process is exiting, no time for graceful shutdown.
      const s = sessions.get(sid);
      if (s?.proc.pid !== undefined) {
        try {
          s.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
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

// One WSS instance shared across all sessions; we route by session query param
// in the upgrade handler. Stash so HMR doesn't pile up listeners.
/** @type {WebSocketServer} */
const wss = (() => {
  const existing = globalThis[WSS_KEY];
  if (existing instanceof WebSocketServer) return existing;
  const fresh = new WebSocketServer({ noServer: true });
  globalThis[WSS_KEY] = fresh;
  return fresh;
})();

// ── Constants ────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min of no traffic → auto-dispose
const PROBE_TIMEOUT_MS = 5_000;
const SPAWN_GRACE_MS = 1_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB stdout-buffer ceiling per session

// ── Frame parsing (LSP `Content-Length: N\r\n\r\n<json>`) ───────────────────

/**
 * Parse all complete Content-Length frames from a buffer. Returns the parsed
 * message strings and any unconsumed tail (partial frame waiting for more bytes).
 *
 * @param {Buffer} buf
 * @returns {{ messages: string[]; remaining: Buffer }}
 */
function parseFrames(buf) {
  /** @type {string[]} */
  const messages = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const headerEnd = buf.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) break;
    const headers = buf.slice(cursor, headerEnd).toString('utf8');
    const match = headers.match(/Content-Length:\s*(\d+)/i);
    if (match === null) {
      // Malformed header block — skip past it to avoid an infinite loop.
      cursor = headerEnd + 4;
      continue;
    }
    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buf.length < bodyEnd) break; // need more bytes
    messages.push(buf.slice(bodyStart, bodyEnd).toString('utf8'));
    cursor = bodyEnd;
  }
  return { messages, remaining: buf.slice(cursor) };
}

/** Serialize a JSON string into an LSP-framed Buffer ready for stdin. */
function frameMessage(json) {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Convert a `file:///...` URI back to an absolute on-disk path. Inverse of
 * pathToFileUri — handles percent-encoding (e.g. `%3A` → `:`) and the
 * Windows-vs-POSIX leading-slash convention.
 *
 * Returns null for non-file URIs.
 *
 * @param {string} uri
 * @returns {string | null}
 */
function fileUriToPath(uri) {
  if (!uri.startsWith('file://')) return null;
  // Strip the scheme; on Windows the path starts with /x:/...
  let raw = uri.slice('file://'.length);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (IS_WIN) {
    // Drop the leading slash before the drive letter: '/x:/foo' → 'x:/foo'.
    if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
    return raw.replaceAll('/', '\\');
  }
  return raw;
}

/**
 * Per-session debounced disk-sync writer. Holds the latest pending write per
 * URI and flushes after `delay` ms of quiet. Bounded to paths inside the
 * session's workspace as a defense-in-depth check.
 */
const SYNC_DEBOUNCE_MS = 500;

function scheduleDiskSync(session, uri, text) {
  const filePath = fileUriToPath(uri);
  if (filePath === null) return;
  // Defense in depth: never write outside the session's workspace dir, even
  // though all URIs we generate point inside it. On Windows paths are
  // case-insensitive but JS string comparison isn't, so lowercase both sides
  // before checking containment — otherwise a `x:\foo` URI rejects against
  // an `X:\foo` workspace.
  const resolved = resolve(filePath);
  const normResolved = IS_WIN ? resolved.toLowerCase() : resolved;
  const normWorkspace = IS_WIN ? session.workspaceDir.toLowerCase() : session.workspaceDir;
  if (!normResolved.startsWith(normWorkspace)) return;

  if (session.syncQueue === undefined) session.syncQueue = new Map();
  const queue = session.syncQueue;
  const existing = queue.get(uri);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    queue.delete(uri);
    try {
      writeFileSync(resolved, text);
      console.info(`[lsp:${session.lang}] disk sync → ${resolved} (${text.length} bytes)`);
    } catch (e) {
      console.warn(`[lsp:${session.lang}] disk sync failed for ${resolved}:`, e instanceof Error ? e.message : e);
    }
  }, SYNC_DEBOUNCE_MS);
  queue.set(uri, { timer, text });
}

/**
 * Inspect an outgoing JSON-RPC message; if it's a textDocument/didOpen or
 * didChange and the session opts into syncToDisk, queue a debounced write of
 * the buffer to the file's on-disk path.
 */
function maybeSyncToDisk(session, jsonText) {
  const config = LSP_CONFIG[session.lang];
  if (config?.syncToDisk !== true) return;
  let msg;
  try {
    msg = JSON.parse(jsonText);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== 'object') return;
  const params = msg.params;
  if (params === undefined || params === null) return;
  if (msg.method === 'textDocument/didOpen') {
    const td = params.textDocument;
    if (td?.uri !== undefined && typeof td.text === 'string') {
      scheduleDiskSync(session, td.uri, td.text);
    }
  } else if (msg.method === 'textDocument/didChange') {
    const td = params.textDocument;
    const changes = params.contentChanges;
    // Full-sync mode: contentChanges[0] is the entire new doc. Incremental
    // mode would require re-applying ranges, which we don't implement; the
    // frontend uses full-sync (see lspClient.didChange).
    if (td?.uri !== undefined && Array.isArray(changes) && changes.length > 0) {
      const last = changes[changes.length - 1];
      if (typeof last?.text === 'string' && Object.keys(last).length === 1) {
        scheduleDiskSync(session, td.uri, last.text);
      }
    }
  }
}

// ── Availability probe ──────────────────────────────────────────────────────

/**
 * Run `bin --version` once and cache. `available: false` means ENOENT or non-zero exit;
 * the frontend should silently fall back to the old `/check` path in that case.
 *
 * @param {string} lang
 * @returns {Promise<{ available: boolean; version?: string; error?: string }>}
 */
/**
 * Run `where <bin>` (Windows) / `which <bin>` (POSIX) to check whether the
 * binary is reachable. Returns the resolved path on success, null otherwise.
 * Used in two scenarios:
 *  - Existence probe (always): confirms the LSP binary is installed.
 *  - Version-string fetch (optional, gated by config): some servers take too
 *    long or don't support a clean --version (e.g. OmniSharp starts the full
 *    server on `--version`); for those we report availability only.
 */
function whichBin(bin) {
  return new Promise((resolveWhich) => {
    const lookup = IS_WIN ? 'where' : 'which';
    let proc;
    try {
      proc = spawn(lookup, [bin], { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
    } catch {
      resolveWhich(null);
      return;
    }
    let stdout = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    proc.on('error', () => resolveWhich(null));
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolveWhich(null);
    }, 3_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolveWhich(null);
        return;
      }
      const first = stdout.split('\n')[0]?.trim() ?? '';
      resolveWhich(first.length > 0 ? first : null);
    });
  });
}

async function probeAvailability(serverKey) {
  const cached = availabilityCache.get(serverKey);
  if (cached !== undefined) return cached;
  const config = LSP_CONFIG[serverKey];
  if (config === undefined) {
    const result = { available: false, error: `unknown serverKey: ${serverKey}` };
    availabilityCache.set(serverKey, result);
    return result;
  }
  const probeBin = config.probeBin ?? config.bin;

  // Step 1: PATH lookup. Fast (≤ 3s), reliable, doesn't spawn the LSP server.
  const resolved = await whichBin(probeBin);
  if (resolved === null) {
    const result = { available: false, error: `${probeBin} not on PATH` };
    availabilityCache.set(lang, result);
    return result;
  }

  // Step 2: optional version-string fetch. Skipped when versionArgs is empty.
  // Bounded by PROBE_TIMEOUT_MS so misbehaving --version commands (looking at
  // you, OmniSharp) don't block availability.
  const versionArgs = config.versionArgs ?? [];
  if (versionArgs.length === 0) {
    const result = { available: true, version: resolved };
    availabilityCache.set(serverKey, result);
    return result;
  }
  const version = await new Promise((resolveVer) => {
    let proc;
    try {
      proc = spawn(probeBin, versionArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
    } catch {
      resolveVer(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', () => resolveVer(null));
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolveVer(null);
    }, PROBE_TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolveVer(null);
        return;
      }
      const firstLine = (stdout + stderr).split('\n')[0]?.trim() ?? '';
      resolveVer(firstLine.length > 0 ? firstLine : null);
    });
  });
  const result = { available: true, version: version ?? resolved };
  availabilityCache.set(serverKey, result);
  return result;
}

// ── Workspace materializer ──────────────────────────────────────────────────

/**
 * Create `.tmp/lsp/<sid>/` and seed any workspace files for the given language.
 * Returns the absolute path of the workspace.
 *
 * @param {string} lang
 * @param {string} sessionId
 * @returns {string}
 */
/**
 * Resolve the workspace directory for a session. Project-mode languages reuse
 * the on-disk `projects/<projectDir>/` directory (the dev-server supervisor
 * already manages files there); fresh-mode creates a per-session directory
 * under `.tmp/lsp/<sid>/` and seeds the configured workspace files.
 *
 * @param {string} serverKey
 * @param {string} sessionId
 * @returns {{ dir: string; ephemeral: boolean }}
 */
function createWorkspace(serverKey, sessionId) {
  const config = LSP_CONFIG[serverKey];
  if (config === undefined) throw new Error(`unknown serverKey: ${serverKey}`);

  if (config.workspaceMode === 'project') {
    if (typeof config.projectDir !== 'string' || config.projectDir.length === 0) {
      throw new Error(`project mode requires projectDir for ${serverKey}`);
    }
    const dir = resolve(REPO_ROOT, 'projects', config.projectDir);
    return { dir, ephemeral: false };
  }

  const dir = join(TMP_LSP_ROOT, sessionId);
  mkdirSync(dir, { recursive: true });
  if (typeof config.mainFile === 'string') {
    const mainPath = join(dir, config.mainFile);
    mkdirSync(dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, '');
  }
  for (const [name, body] of Object.entries(config.workspaceFiles ?? {})) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }
  return { dir, ephemeral: true };
}

function destroyWorkspace(workspaceDir) {
  if (!workspaceDir.startsWith(TMP_LSP_ROOT)) return; // safety: never delete outside .tmp/lsp
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // ignore — the next session creates a fresh dir under a different sid
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Compute a `file:///` URI for an absolute on-disk path. Windows paths need
 * forward-slash normalization and a leading slash before the drive letter
 * (`file:///x:/foo/bar` not `file://X:\foo\bar`). The drive letter is
 * lowercased — rust-analyzer (and some other servers) canonicalize this way,
 * and a mismatch means publishDiagnostics fires for a different URI than the
 * client opened, silently breaking diagnostic delivery.
 *
 * @param {string} absPath
 * @returns {string}
 */
function pathToFileUri(absPath) {
  const normalized = absPath.replaceAll('\\', '/');
  // Lowercase the drive letter on Windows. The match accepts either an
  // already-leading-slashed path (`/c:/foo`) or a raw drive path (`X:/foo`).
  const lowerDrive = normalized.replace(/^(\/?)([A-Za-z]):/, (_, slash, letter) => `${slash}${letter.toLowerCase()}:`);
  return lowerDrive.startsWith('/') ? `file://${lowerDrive}` : `file:///${lowerDrive}`;
}

/**
 * Spawn an LSP child for a single serverKey and return a sessionId. The child
 * is alive but has no WS attached yet — call attachWebSocket() to wire it up.
 *
 * @param {string} serverKey
 * @returns {Promise<{ ok: true; sessionId: string; mainFileUri?: string; rootUri: string } | { ok: false; error: string }>}
 */
async function startSession(serverKey) {
  const config = LSP_CONFIG[serverKey];
  if (config === undefined) return { ok: false, error: `unknown serverKey: ${serverKey}` };

  const probe = await probeAvailability(serverKey);
  if (!probe.available) return { ok: false, error: probe.error ?? 'unavailable' };

  const sessionId = randomUUID();
  const { dir: workspaceDir, ephemeral } = createWorkspace(serverKey, sessionId);

  let proc;
  try {
    proc = spawn(config.bin, config.args, {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WIN,
    });
  } catch (e) {
    if (ephemeral) destroyWorkspace(workspaceDir);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  /** @type {LspSession} */
  const session = {
    lang: serverKey,
    proc,
    workspaceDir,
    workspaceEphemeral: ephemeral,
    ws: null,
    stdoutBuffer: Buffer.alloc(0),
    lastActivity: Date.now(),
    idleTimer: null,
  };

  proc.on('error', (e) => {
    console.warn(`[lsp:${serverKey}:${sessionId.slice(0, 8)}] proc error:`, e);
  });
  proc.on('exit', (code, signal) => {
    console.info(`[lsp:${serverKey}:${sessionId.slice(0, 8)}] exited code=${code} signal=${signal}`);
    // If the WS is still open, close it so the client knows the server is gone.
    if (session.ws !== null) {
      try {
        session.ws.close(1011, 'lsp-process-exit');
      } catch {
        // ignore
      }
    }
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    if (session.syncQueue !== undefined) {
      for (const { timer } of session.syncQueue.values()) clearTimeout(timer);
      session.syncQueue.clear();
    }
    sessions.delete(sessionId);
    if (session.workspaceEphemeral) destroyWorkspace(session.workspaceDir);
  });

  // stderr is informational; surface it in the dev-server console for debugging.
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString('utf8').trim();
    if (line.length > 0) console.info(`[lsp:${serverKey}:${sessionId.slice(0, 8)}] stderr: ${line}`);
  });

  proc.stdout.on('data', (chunk) => {
    session.lastActivity = Date.now();
    if (session.stdoutBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
      console.warn(`[lsp:${serverKey}:${sessionId.slice(0, 8)}] stdout buffer overrun, killing`);
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      return;
    }
    session.stdoutBuffer = Buffer.concat([session.stdoutBuffer, chunk]);
    const { messages, remaining } = parseFrames(session.stdoutBuffer);
    session.stdoutBuffer = remaining;
    if (session.ws !== null && session.ws.readyState === 1 /* OPEN */) {
      for (const msg of messages) session.ws.send(msg);
    }
    // If no WS is attached, the messages buffer up in `remaining` indefinitely
    // (only complete messages are dropped). For a real LSP this is fine —
    // initialize is the first thing the client sends, so the server stays
    // quiet until then. Worst case the buffer caps at MAX_BUFFER_BYTES.
  });

  sessions.set(sessionId, session);
  scheduleIdleTimer(session, sessionId);

  // Tiny grace period so the spawn can fail-fast on a missing binary that ENOENT'd
  // after the version probe (e.g., race with PATH change).
  await new Promise((res) => setTimeout(res, SPAWN_GRACE_MS));
  if (proc.exitCode !== null) {
    sessions.delete(sessionId);
    if (ephemeral) destroyWorkspace(workspaceDir);
    return { ok: false, error: `lsp exited immediately with code ${proc.exitCode}` };
  }

  return {
    ok: true,
    sessionId,
    // Project-mode workspaces have no fixed mainFile (tabs are open dynamically
    // by the frontend); only fresh-mode bridges expose a mainFileUri.
    ...(typeof config.mainFile === 'string' ? { mainFileUri: pathToFileUri(join(workspaceDir, config.mainFile)) } : {}),
    rootUri: pathToFileUri(workspaceDir),
  };
}

/**
 * Spawn every available server for a user-facing language. Skips servers
 * whose binary is not installed and reports them under `unavailable`. Returns
 * `ok: false` only when no server in LANG_SERVERS[lang] could start.
 *
 * @param {string} lang
 * @returns {Promise<
 *   | { ok: true; rootUri: string; mainFileUri?: string;
 *       servers: Array<{ serverKey: string; sessionId: string; acceptsLanguageIds: string[] }>;
 *       unavailable: Array<{ serverKey: string; error: string }>; }
 *   | { ok: false; error: string }>}
 */
async function startBundle(lang) {
  const serverKeys = LANG_SERVERS[lang];
  if (serverKeys === undefined || serverKeys.length === 0) {
    return { ok: false, error: `unknown lang: ${lang}` };
  }

  const servers = [];
  const unavailable = [];
  let rootUri;
  let mainFileUri;

  for (const serverKey of serverKeys) {
    const result = await startSession(serverKey);
    if (!result.ok) {
      unavailable.push({ serverKey, error: result.error });
      continue;
    }
    if (rootUri === undefined) rootUri = result.rootUri;
    if (mainFileUri === undefined && result.mainFileUri !== undefined) mainFileUri = result.mainFileUri;
    servers.push({
      serverKey,
      sessionId: result.sessionId,
      acceptsLanguageIds: LSP_CONFIG[serverKey]?.acceptsLanguageIds ?? [],
    });
  }

  if (servers.length === 0) {
    const reasons = unavailable.map((u) => `${u.serverKey}: ${u.error}`).join('; ');
    return { ok: false, error: reasons.length > 0 ? reasons : 'no servers available' };
  }
  if (rootUri === undefined) return { ok: false, error: 'unreachable: bundle has servers but no rootUri' };

  return mainFileUri !== undefined ? { ok: true, rootUri, mainFileUri, servers, unavailable } : { ok: true, rootUri, servers, unavailable };
}

/**
 * Attach a freshly-upgraded WebSocket to an existing session and wire up
 * bidirectional piping. Idempotent in the sense that re-attaching closes the
 * previous WS first.
 *
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 */
function attachWebSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    ws.close(1008, 'unknown-session');
    return;
  }
  if (session.ws !== null) {
    try {
      session.ws.close(1000, 'replaced');
    } catch {
      // ignore
    }
  }
  session.ws = ws;

  // Flush any frames we already buffered while waiting for the WS to attach.
  const { messages, remaining } = parseFrames(session.stdoutBuffer);
  session.stdoutBuffer = remaining;
  for (const msg of messages) ws.send(msg);

  ws.on('message', (data) => {
    session.lastActivity = Date.now();
    // ws may give us Buffer | ArrayBuffer | Buffer[]; normalize to string.
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof Buffer
        ? data.toString('utf8')
        : Buffer.from(/** @type {ArrayBuffer} */ (data)).toString('utf8');
    maybeSyncToDisk(session, text);
    try {
      session.proc.stdin.write(frameMessage(text));
    } catch (e) {
      console.warn(`[lsp:${session.lang}:${sessionId.slice(0, 8)}] stdin write failed:`, e);
    }
  });

  const teardown = () => {
    if (session.ws === ws) session.ws = null;
  };
  ws.on('close', teardown);
  ws.on('error', teardown);
}

function scheduleIdleTimer(session, sessionId) {
  if (session.idleTimer !== null) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    const idle = Date.now() - session.lastActivity;
    if (idle >= IDLE_TIMEOUT_MS) {
      console.info(`[lsp:${session.lang}:${sessionId.slice(0, 8)}] idle timeout, disposing`);
      void disposeSession(sessionId);
      return;
    }
    scheduleIdleTimer(session, sessionId);
  }, IDLE_TIMEOUT_MS);
}

/**
 * Graceful shutdown: send `shutdown` + `exit` LSP requests, give the child
 * a moment to comply, then SIGKILL if it's still around.
 *
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean }>}
 */
async function disposeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session === undefined) return { ok: true };
  // Send shutdown/exit best-effort. If the proc is already dead the writes throw.
  try {
    const shutdownMsg = JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'shutdown' });
    session.proc.stdin.write(frameMessage(shutdownMsg));
    const exitMsg = JSON.stringify({ jsonrpc: '2.0', method: 'exit' });
    session.proc.stdin.write(frameMessage(exitMsg));
    // Closing stdin tells libuv we're done writing, which avoids the
    // `!(handle->flags & UV_HANDLE_CLOSING)` assertion on Windows during
    // process teardown. Safe even if the child has already exited — the
    // write end of the pipe ignores the close.
    session.proc.stdin.end();
  } catch {
    // ignore — we'll SIGKILL below
  }
  if (session.ws !== null) {
    try {
      session.ws.close(1000, 'disposed');
    } catch {
      // ignore
    }
  }
  await new Promise((res) => setTimeout(res, 300));
  if (session.proc.exitCode === null) {
    try {
      session.proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  // The proc 'exit' handler removes from sessions and cleans up the workspace.
  return { ok: true };
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

const LSP_PATH_PREFIX = '/lsp';

function isLspRoute(urlPath) {
  return urlPath === LSP_PATH_PREFIX || urlPath.startsWith(`${LSP_PATH_PREFIX}/`);
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getUrlPath(url) {
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return {};
  const params = new URLSearchParams(url.slice(qIdx + 1));
  return Object.fromEntries(params.entries());
}

/**
 * Handle non-upgrade HTTP requests on /lsp/*. Returns true if handled.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleLspRequest(req, res) {
  const urlPath = getUrlPath(req.url ?? '/');
  if (!isLspRoute(urlPath)) return false;

  try {
    if (req.method === 'GET' && urlPath === '/lsp/availability') {
      const { lang } = parseQuery(req.url ?? '/');
      if (typeof lang !== 'string') {
        sendJson(res, 400, { error: 'missing lang' });
        return true;
      }
      sendJson(res, 200, await probeAvailability(lang));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/lsp/spawn') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return true;
      }
      const { lang } = parsed;
      if (typeof lang !== 'string') {
        sendJson(res, 400, { error: 'missing lang' });
        return true;
      }
      const result = await startBundle(lang);
      sendJson(res, result.ok ? 200 : 503, result);
      return true;
    }

    if (req.method === 'POST' && urlPath === '/lsp/dispose') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return true;
      }
      const { sessionId } = parsed;
      if (typeof sessionId !== 'string') {
        sendJson(res, 400, { error: 'missing sessionId' });
        return true;
      }
      sendJson(res, 200, await disposeSession(sessionId));
      return true;
    }

    sendJson(res, 404, { error: 'unknown lsp route' });
    return true;
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
}

/**
 * Handle a WebSocket upgrade on /lsp?session=<id>. Returns true if handled
 * (caller should not pass to other upgrade handlers); false if the upgrade
 * is for a different path.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @returns {boolean}
 */
export function handleLspUpgrade(req, socket, head) {
  const urlPath = getUrlPath(req.url ?? '/');
  if (urlPath !== '/lsp') return false;
  const { session } = parseQuery(req.url ?? '/');
  if (typeof session !== 'string' || session.length === 0) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return true;
  }
  if (!sessions.has(session)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachWebSocket(session, ws);
  });
  return true;
}

// Internal exports for tests and the smoke script under .tmp/.
export const __internals = { LSP_CONFIG, LANG_SERVERS, sessions, parseFrames, frameMessage, TMP_LSP_ROOT };
