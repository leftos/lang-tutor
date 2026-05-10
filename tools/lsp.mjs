/**
 * LSP bridge — long-lived language servers fronted by WebSocket.
 *
 * Architecture:
 *   Browser ── WS /lsp?session=<id> ──> tools/lsp.mjs ── stdio (LSP) ──> clangd | rust-analyzer | ...
 *
 * Lifecycle:
 *   POST /lsp/spawn { lang }                   → { ok, sessionId } (binary spawned, awaiting WS)
 *   GET  /lsp/availability?lang=<lang>         → { available, version?, error? }
 *   WS   /lsp?session=<id>                     → bidirectional JSON-RPC (raw JSON over WS,
 *                                                Content-Length-framed on stdio)
 *   POST /lsp/dispose { sessionId }            → graceful shutdown + reap (also auto on WS close)
 *
 * Phase 0 wires only `cpp` (clangd). New languages are added by extending LSP_CONFIG.
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

// ── Per-language config ─────────────────────────────────────────────────────

/**
 * @typedef {object} LspConfig
 * @property {string} bin                   - executable on PATH
 * @property {string[]} args                - hardcoded argv (no user data)
 * @property {string} mainFile              - filename inside the workspace dir
 * @property {Record<string,string>} workspaceFiles  - extra files to seed (e.g., compile_flags.txt)
 * @property {string[]} versionArgs         - args to call for availability probe
 */

/** @type {Record<string, LspConfig>} */
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
    // is required to speak LSP over our pipe-based bridge.
    bin: 'basedpyright-langserver',
    args: ['--stdio'],
    mainFile: 'main.py',
    workspaceFiles: {
      'pyrightconfig.json': JSON.stringify({ pythonVersion: '3.13', typeCheckingMode: 'standard', reportMissingImports: 'warning' }, null, 2),
    },
    versionArgs: ['--version'],
  },
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
 * @property {import('ws').WebSocket | null} ws
 * @property {Buffer} stdoutBuffer        - partial Content-Length frame buffer
 * @property {number} lastActivity        - epoch ms; bumped on every byte either direction
 * @property {NodeJS.Timeout | null} idleTimer
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

// ── Availability probe ──────────────────────────────────────────────────────

/**
 * Run `bin --version` once and cache. `available: false` means ENOENT or non-zero exit;
 * the frontend should silently fall back to the old `/check` path in that case.
 *
 * @param {string} lang
 * @returns {Promise<{ available: boolean; version?: string; error?: string }>}
 */
async function probeAvailability(lang) {
  const cached = availabilityCache.get(lang);
  if (cached !== undefined) return cached;
  const config = LSP_CONFIG[lang];
  if (config === undefined) {
    const result = { available: false, error: `unknown lang: ${lang}` };
    availabilityCache.set(lang, result);
    return result;
  }
  const result = await new Promise((resolveProbe) => {
    let proc;
    try {
      proc = spawn(config.bin, config.versionArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolveProbe({ available: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let unavailable = false;
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (e) => {
      if (e && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') unavailable = true;
    });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, PROBE_TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (unavailable) {
        resolveProbe({ available: false, error: `${config.bin} not on PATH` });
        return;
      }
      if (code !== 0) {
        resolveProbe({ available: false, error: stderr.trim() || `exit ${code}` });
        return;
      }
      const firstLine = (stdout + stderr).split('\n')[0]?.trim() ?? '';
      resolveProbe({ available: true, version: firstLine });
    });
  });
  availabilityCache.set(lang, result);
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
function createWorkspace(lang, sessionId) {
  const config = LSP_CONFIG[lang];
  if (config === undefined) throw new Error(`unknown lang: ${lang}`);
  const dir = join(TMP_LSP_ROOT, sessionId);
  mkdirSync(dir, { recursive: true });
  // Seed an empty main file so root discovery has something to anchor to.
  // mainFile may include a subdirectory (e.g. rust's `src/main.rs`); ensure
  // its parent exists before writing.
  const mainPath = join(dir, config.mainFile);
  mkdirSync(dirname(mainPath), { recursive: true });
  writeFileSync(mainPath, '');
  for (const [name, body] of Object.entries(config.workspaceFiles)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }
  return dir;
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
 * Spawn an LSP child for the given language and return a sessionId. The child
 * is alive but has no WS attached yet — call attachWebSocket() to wire it up.
 *
 * @param {string} lang
 * @returns {Promise<{ ok: true; sessionId: string; mainFileUri: string; rootUri: string } | { ok: false; error: string }>}
 */
async function startSession(lang) {
  const config = LSP_CONFIG[lang];
  if (config === undefined) return { ok: false, error: `unknown lang: ${lang}` };

  const probe = await probeAvailability(lang);
  if (!probe.available) return { ok: false, error: probe.error ?? 'unavailable' };

  const sessionId = randomUUID();
  const workspaceDir = createWorkspace(lang, sessionId);

  let proc;
  try {
    proc = spawn(config.bin, config.args, {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    destroyWorkspace(workspaceDir);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  /** @type {LspSession} */
  const session = {
    lang,
    proc,
    workspaceDir,
    ws: null,
    stdoutBuffer: Buffer.alloc(0),
    lastActivity: Date.now(),
    idleTimer: null,
  };

  proc.on('error', (e) => {
    console.warn(`[lsp:${lang}:${sessionId.slice(0, 8)}] proc error:`, e);
  });
  proc.on('exit', (code, signal) => {
    console.info(`[lsp:${lang}:${sessionId.slice(0, 8)}] exited code=${code} signal=${signal}`);
    // If the WS is still open, close it so the client knows the server is gone.
    if (session.ws !== null) {
      try {
        session.ws.close(1011, 'lsp-process-exit');
      } catch {
        // ignore
      }
    }
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    sessions.delete(sessionId);
    destroyWorkspace(session.workspaceDir);
  });

  // stderr is informational; surface it in the dev-server console for debugging.
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString('utf8').trim();
    if (line.length > 0) console.info(`[lsp:${lang}:${sessionId.slice(0, 8)}] stderr: ${line}`);
  });

  proc.stdout.on('data', (chunk) => {
    session.lastActivity = Date.now();
    if (session.stdoutBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
      console.warn(`[lsp:${lang}:${sessionId.slice(0, 8)}] stdout buffer overrun, killing`);
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
    destroyWorkspace(workspaceDir);
    return { ok: false, error: `lsp exited immediately with code ${proc.exitCode}` };
  }

  return {
    ok: true,
    sessionId,
    mainFileUri: pathToFileUri(join(workspaceDir, config.mainFile)),
    rootUri: pathToFileUri(workspaceDir),
  };
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
      const result = await startSession(lang);
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
export const __internals = { LSP_CONFIG, sessions, parseFrames, frameMessage, TMP_LSP_ROOT };
