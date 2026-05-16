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
 *   POST /proj/screenshot     { lang }                    → { ok, fullDataUrl?, thumbDataUrl?, error? } (desktop only)
 *   POST /proj/open           { lang, target }            → { ok, error? }   target = vscode|vs|explorer
 *   GET  /proj/open/targets                               → { vscode, vs, explorer }   bool availability
 *   GET  /proj/status?lang=…                              → { running, ready, … }
 *   GET  /proj/logs?lang=…&n=200                          → { lines } (or SSE if Accept: text/event-stream)
 *   GET  /proj/preview/<lang>/*                           → same-origin proxy to the user's dev server
 */

import { request as httpRequest } from 'node:http';
import { readAuthSession } from './auth-routes.mjs';
import {
  captureProjectScreenshot,
  deleteFile,
  ensureScaffold,
  getOpenAvailability,
  getPreviewPublicBase,
  getPreviewTarget,
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
const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: http: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http: https:",
  "style-src 'self' 'unsafe-inline' http: https:",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' data: blob: http: https:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

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

function sendPreviewError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

async function scopeFromRequest(req) {
  const session = await readAuthSession(req);
  if (session !== null) return session.user.id;
  return process.env.LANG_TUTOR_REQUIRE_AUTH === 'true' ? null : 'local';
}

async function resolveScope(req, res) {
  const scope = await scopeFromRequest(req);
  if (scope === null) {
    sendJson(res, 401, { error: 'Sign in to use hosted project tooling.' });
    return null;
  }
  return scope;
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

async function handleFs(scope, method, urlPath, req, res) {
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
      sendJson(res, 200, getTree(scope, lang));
      return;
    case '/fs/read':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, readFile(scope, lang, path));
      return;
    case '/fs/write':
      if (typeof path !== 'string' || typeof content !== 'string') {
        sendJson(res, 400, { error: 'missing path or content' });
        return;
      }
      sendJson(res, 200, writeFile(scope, lang, path, content));
      return;
    case '/fs/rename':
      if (typeof from !== 'string' || typeof to !== 'string') {
        sendJson(res, 400, { error: 'missing from or to' });
        return;
      }
      sendJson(res, 200, renameFile(scope, lang, from, to));
      return;
    case '/fs/delete':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, deleteFile(scope, lang, path));
      return;
    case '/fs/mkdir':
      if (typeof path !== 'string') {
        sendJson(res, 400, { error: 'missing path' });
        return;
      }
      sendJson(res, 200, mkdir(scope, lang, path));
      return;
    default:
      sendJson(res, 404, { error: 'unknown fs route' });
  }
}

async function handleProjStart(scope, req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  const result = await startProject(scope, body.lang);
  sendJson(res, result.ok ? 200 : 500, result);
}

async function handleProjStop(scope, req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, await stopProject(scope, body.lang));
}

function handleProjStatus(scope, query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, getStatus(scope, query.lang));
}

function handleProjScaffold(scope, query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  sendJson(res, 200, ensureScaffold(scope, query.lang));
}

async function handleProjReset(scope, req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  try {
    sendJson(res, 200, await resetProject(scope, body.lang));
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

function handleProjLogsRecent(scope, query, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  const n = query.n ? Number.parseInt(query.n, 10) : 200;
  sendJson(res, 200, getRecentLogs(scope, query.lang, Number.isFinite(n) ? n : 200));
}

function handleProjLogsStream(scope, query, req, res) {
  if (!query.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const entry of getRecentLogs(scope, query.lang, 200).lines) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsub = subscribeLogs(scope, query.lang, (entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      unsub();
    }
  });
  req.on('close', unsub);
  req.on('error', unsub);
}

function handleFsWatchStream(scope, query, req, res) {
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
    unsub = subscribeFsEvents(scope, query.lang, (event) => {
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

async function handleProjScreenshot(scope, req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  try {
    const result = await captureProjectScreenshot(scope, body.lang);
    sendJson(res, result.ok ? 200 : 500, result);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleProjOpen(scope, req, res) {
  const body = await readJsonBody(req);
  if (!body.lang) {
    sendJson(res, 400, { error: 'missing lang' });
    return;
  }
  if (typeof body.target !== 'string') {
    sendJson(res, 400, { error: 'missing target' });
    return;
  }
  const result = openProject(scope, body.lang, body.target);
  sendJson(res, result.ok ? 200 : 400, result);
}

function handleProjOpenTargets(res) {
  sendJson(res, 200, getOpenAvailability());
}

function parsePreviewRoute(urlPath) {
  const match = urlPath.match(/^\/proj\/preview\/([^/]*)(\/.*)?$/);
  if (match === null || match[1] === undefined) return null;
  try {
    return { lang: decodeURIComponent(match[1]), targetPath: match[2] ?? '/' };
  } catch {
    return null;
  }
}

function proxyHeaders(headers, targetPort) {
  const next = { ...headers, host: `127.0.0.1:${targetPort}` };
  delete next.connection;
  delete next['keep-alive'];
  delete next['proxy-authenticate'];
  delete next['proxy-authorization'];
  delete next.te;
  delete next.trailer;
  delete next.upgrade;
  return next;
}

function responseHeaders(headers) {
  const next = { ...headers };
  delete next.connection;
  delete next['content-security-policy'];
  delete next['content-security-policy-report-only'];
  delete next['keep-alive'];
  delete next['proxy-authenticate'];
  delete next['proxy-authorization'];
  delete next.te;
  delete next.trailer;
  delete next.upgrade;
  next['access-control-allow-origin'] = '*';
  next['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
  next['content-security-policy'] = PREVIEW_CONTENT_SECURITY_POLICY;
  return next;
}

function handlePreviewProxy(scope, route, req, res) {
  const target = getPreviewTarget(scope, route.lang);
  if (target === null) {
    sendPreviewError(res, 502, 'Project preview is not running.');
    return;
  }

  const queryIndex = (req.url ?? '').indexOf('?');
  const suffix = route.targetPath === '/' ? '' : route.targetPath.replace(/^\/+/, '');
  const targetPath = `${getPreviewPublicBase(route.lang)}${suffix}${queryIndex === -1 ? '' : (req.url ?? '').slice(queryIndex)}`;
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: targetPath,
      headers: proxyHeaders(req.headers, target.port),
    },
    (proxyRes) => {
      res.removeHeader('Content-Security-Policy');
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (error) => {
    if (!res.headersSent) sendPreviewError(res, 502, `Project preview proxy failed: ${error.message}`);
    else res.destroy(error);
  });
  req.pipe(proxyReq);
}

function proxyPreviewUpgrade(scope, route, req, socket, head) {
  const target = getPreviewTarget(scope, route.lang);
  if (target === null) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nProject preview is not running.');
    socket.destroy();
    return;
  }

  const queryIndex = (req.url ?? '').indexOf('?');
  const suffix = route.targetPath === '/' ? '' : route.targetPath.replace(/^\/+/, '');
  const targetPath = `${getPreviewPublicBase(route.lang)}${suffix}${queryIndex === -1 ? '' : (req.url ?? '').slice(queryIndex)}`;
  const proxyReq = httpRequest({
    hostname: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: targetPath,
    headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const headers = [`HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      const name = proxyRes.rawHeaders[i];
      const value = proxyRes.rawHeaders[i + 1];
      if (name !== undefined && value !== undefined) headers.push(`${name}: ${value}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket).pipe(proxySocket);
  });
  proxyReq.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nProject preview proxy failed.');
    socket.destroy();
  });
  proxyReq.end();
}

async function handleProj(scope, method, urlPath, req, res) {
  const query = parseQuery(req.url);
  const previewRoute = parsePreviewRoute(urlPath);
  if (previewRoute !== null) {
    if (urlPath === `/proj/preview/${encodeURIComponent(previewRoute.lang)}`) {
      res.writeHead(308, { Location: getPreviewPublicBase(previewRoute.lang) });
      res.end();
      return;
    }
    return handlePreviewProxy(scope, previewRoute, req, res);
  }

  if (method === 'POST' && urlPath === '/proj/start') return handleProjStart(scope, req, res);
  if (method === 'POST' && urlPath === '/proj/stop') return handleProjStop(scope, req, res);
  if (method === 'POST' && urlPath === '/proj/scaffold') return handleProjScaffold(scope, query, res);
  if (method === 'POST' && urlPath === '/proj/reset') return handleProjReset(scope, req, res);
  if (method === 'POST' && urlPath === '/proj/screenshot') return handleProjScreenshot(scope, req, res);
  if (method === 'POST' && urlPath === '/proj/open') return handleProjOpen(scope, req, res);
  if (method === 'GET' && urlPath === '/proj/open/targets') return handleProjOpenTargets(res);
  if (method === 'GET' && urlPath === '/proj/status') return handleProjStatus(scope, query, res);
  if (method === 'GET' && urlPath === '/proj/logs/recent') return handleProjLogsRecent(scope, query, res);
  if (method === 'GET' && urlPath === '/proj/logs') {
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/event-stream')) return handleProjLogsStream(scope, query, req, res);
    return handleProjLogsRecent(scope, query, res);
  }

  sendJson(res, 404, { error: 'unknown proj route' });
}

function handleFsWatch(scope, method, req, res) {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const query = parseQuery(req.url);
  handleFsWatchStream(scope, query, req, res);
}

export async function handleProjectRequest(req, res) {
  const url = req.url ?? '/';
  const urlPath = getUrlPath(url);
  if (!isProjectRoute(urlPath)) return false;

  try {
    const scope = await resolveScope(req, res);
    if (scope === null) return true;
    if (urlPath === '/fs/watch') {
      handleFsWatch(scope, req.method, req, res);
    } else if (urlPath.startsWith('/fs/')) {
      await handleFs(scope, req.method, urlPath, req, res);
    } else if (urlPath.startsWith('/proj/')) {
      await handleProj(scope, req.method, urlPath, req, res);
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

export function handleProjectUpgrade(req, socket, head) {
  const url = req.url ?? '/';
  const urlPath = getUrlPath(url);
  const previewRoute = parsePreviewRoute(urlPath);
  if (previewRoute === null) return false;

  scopeFromRequest(req)
    .then((scope) => {
      if (scope === null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      proxyPreviewUpgrade(scope, previewRoute, req, socket, head);
    })
    .catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
  return true;
}
