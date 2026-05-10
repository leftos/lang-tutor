/**
 * Shared HTTP handler for /fs/* and /proj/* endpoints.
 *
 * Used by both the Vite dev-server middleware and the production server. The
 * handler reads the request itself (body / query) and writes the response.
 * Returns `true` if the request was handled, `false` if the caller should
 * continue dispatching to other handlers.
 *
 * Routes (all return JSON unless noted):
 *   POST /fs/list      { lang }                           → { tree, scaffolded }
 *   POST /fs/read      { lang, path }                     → { content }
 *   POST /fs/write     { lang, path, content }            → { ok }
 *   POST /fs/rename    { lang, from, to }                 → { ok }
 *   POST /fs/delete    { lang, path }                     → { ok }
 *   POST /fs/mkdir     { lang, path }                     → { ok }
 *   POST /proj/start          { lang }                    → { ok, vitePort, ready }
 *   POST /proj/stop           { lang }                    → { ok }
 *   POST /proj/reset          { lang }                    → { root, created } (stop + wipe folder + rescaffold)
 *   POST /proj/open           { lang, target }            → { ok, error? }   target = vscode|vs|explorer
 *   GET  /proj/open/targets                               → { vscode, vs, explorer }   bool availability
 *   GET  /proj/status?lang=…                              → { running, ready, … }
 *   GET  /proj/logs?lang=…&n=200                          → { lines } (or SSE if Accept: text/event-stream)
 */

import {
  deleteFile,
  ensureScaffold,
  getOpenAvailability,
  getRecentLogs,
  getStatus,
  getTree,
  mkdir,
  openProject,
  readFile,
  renameFile,
  resetProject,
  startProject,
  stopProject,
  subscribeFsEvents,
  subscribeLogs,
  writeFile,
} from './projects.mjs';

const PROJECT_PATHS = ['/fs/', '/proj/'];

export function isProjectRoute(urlPath) {
  return PROJECT_PATHS.some((p) => urlPath === p.slice(0, -1) || urlPath.startsWith(p));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return {};
  const params = new URLSearchParams(url.slice(qIdx + 1));
  return Object.fromEntries(params.entries());
}

function getUrlPath(url) {
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function handleFs(method, urlPath, req, res) {
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const body = await readJsonBody(req);
  const { lang, path, from, to, content } = body;
  if (!lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  switch (urlPath) {
    case '/fs/list':
      sendJson(res, 200, getTree(lang));
      return;
    case '/fs/read':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, readFile(lang, path));
      return;
    case '/fs/write':
      if (typeof path !== 'string' || typeof content !== 'string') {
        sendJson(res, 400, { error: 'missing path or content' });
        return;
      }
      sendJson(res, 200, writeFile(lang, path, content));
      return;
    case '/fs/rename':
      if (typeof from !== 'string' || typeof to !== 'string') {
        sendJson(res, 400, { error: 'missing from or to' });
        return;
      }
      sendJson(res, 200, renameFile(lang, from, to));
      return;
    case '/fs/delete':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, deleteFile(lang, path));
      return;
    case '/fs/mkdir':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, mkdir(lang, path));
      return;
    default:
      sendJson(res, 404, { error: 'unknown fs route' });
  }
}

async function handleProjStart(req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  const result = await startProject(body.lang);
  sendJson(res, result.ok ? 200 : 500, result);
}

async function handleProjStop(req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, await stopProject(body.lang));
}

function handleProjStatus(query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, getStatus(query.lang));
}

function handleProjScaffold(query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, ensureScaffold(query.lang));
}

async function handleProjReset(req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  try {
    sendJson(res, 200, await resetProject(body.lang));
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

function handleProjLogsRecent(query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  const n = query.n ? Number.parseInt(query.n, 10) : 200;
  sendJson(res, 200, getRecentLogs(query.lang, Number.isFinite(n) ? n : 200));
}

function handleProjLogsStream(query, req, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const entry of getRecentLogs(query.lang, 200).lines) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsub = subscribeLogs(query.lang, (entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      unsub();
    }
  });
  req.on('close', unsub);
  req.on('error', unsub);
}

function handleFsWatchStream(query, req, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send a hello so the EventSource connects cleanly even if the watcher is
  // quiet for a while (some proxies close idle SSE).
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);

  let unsub = () => {};
  try {
    unsub = subscribeFsEvents(query.lang, (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsub();
      }
    });
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : String(e) })}\n\n`);
    res.end();
    return;
  }

  // Heartbeat every 30s — keeps the connection warm through proxies and
  // gives the client a quick way to notice broken connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
  req.on('error', () => {
    clearInterval(heartbeat);
    unsub();
  });
}

async function handleProjOpen(req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  if (typeof body.target !== 'string') {
    sendJson(res, 400, { error: 'missing target' });
    return;
  }
  const result = openProject(body.lang, body.target);
  sendJson(res, result.ok ? 200 : 400, result);
}

function handleProjOpenTargets(res) {
  sendJson(res, 200, getOpenAvailability());
}

async function handleProj(method, urlPath, req, res) {
  const query = parseQuery(req.url);

  if (method === 'POST' && urlPath === '/proj/start') return handleProjStart(req, res);
  if (method === 'POST' && urlPath === '/proj/stop') return handleProjStop(req, res);
  if (method === 'POST' && urlPath === '/proj/scaffold') return handleProjScaffold(query, res);
  if (method === 'POST' && urlPath === '/proj/reset') return handleProjReset(req, res);
  if (method === 'POST' && urlPath === '/proj/open') return handleProjOpen(req, res);
  if (method === 'GET' && urlPath === '/proj/open/targets') return handleProjOpenTargets(res);
  if (method === 'GET' && urlPath === '/proj/status') return handleProjStatus(query, res);
  if (method === 'GET' && urlPath === '/proj/logs/recent') return handleProjLogsRecent(query, res);
  if (method === 'GET' && urlPath === '/proj/logs') {
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/event-stream')) return handleProjLogsStream(query, req, res);
    return handleProjLogsRecent(query, res);
  }

  sendJson(res, 404, { error: 'unknown proj route' });
}

function handleFsWatch(method, req, res) {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const query = parseQuery(req.url);
  handleFsWatchStream(query, req, res);
}

export async function handleProjectRequest(req, res) {
  const url = req.url ?? '/';
  const urlPath = getUrlPath(url);
  if (!isProjectRoute(urlPath)) return false;

  try {
    if (urlPath === '/fs/watch') {
      handleFsWatch(req.method, req, res);
    } else if (urlPath.startsWith('/fs/')) {
      await handleFs(req.method, urlPath, req, res);
    } else if (urlPath.startsWith('/proj/')) {
      await handleProj(req.method, urlPath, req, res);
    } else {
      sendJson(res, 404, { error: 'unknown route' });
    }
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return true;
}
