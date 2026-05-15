/**
 * Lang Tutor — production server
 * Serves the Vite build (dist/), account/session APIs, state persistence, and
 * local code/project tooling. Model-provider API keys stay in the browser.
 *
 * Usage:
 *   .\lt.ps1 build                          # build dist/
 *   .\lt.ps1 serve                          # node --env-file=.env server.mjs
 *   or: node server.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStateRequest } from './tools/app-state.mjs';
import { handleAuthRequest, readAuthSession } from './tools/auth-routes.mjs';
import { checkCode, formatCode } from './tools/checker.mjs';
import { handleLspRequest, handleLspUpgrade } from './tools/lsp.mjs';
import { handleProjectRequest } from './tools/project-routes.mjs';
import { runSnippet } from './tools/runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DIST_DIR = join(__dirname, 'dist');

function normalizeBasePath(value) {
  const raw = value?.trim();
  if (!raw || raw === './') return '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const BASE_PATH = normalizeBasePath(process.env.LANG_TUTOR_BASE_PATH);
const BASE_PREFIX = BASE_PATH === '/' ? null : BASE_PATH.slice(0, -1);
const REQUIRE_AUTH = process.env.LANG_TUTOR_REQUIRE_AUTH === 'true';
const TOOL_PATHS = ['/check', '/format', '/run', '/lsp', '/fs', '/proj'];

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://cdn.jsdelivr.net ws: wss:",
  "frame-src 'self' http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  stripBasePath(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (await handleAuthRequest(req, res)) return;
  if (await handleStateRequest(req, res)) return;
  if (isToolRequest(req) && !(await requireSignedInUser(req, res))) return;
  if (await handleLspRequest(req, res)) return;
  if (await handleProjectRequest(req, res)) return;

  if (req.method === 'POST' && (req.url === '/check' || req.url === '/format' || req.url === '/run')) {
    try {
      const body = await readBody(req);
      const { lang, code } = JSON.parse(body);
      if (!lang || typeof code !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { lang, code }' }));
        return;
      }
      let result;
      if (req.url === '/check') {
        result = await checkCode(lang, code);
      } else if (req.url === '/format') {
        result = await formatCode(lang, code);
      } else {
        result = await runSnippet(lang, code);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const urlPath = requestPath(req);
    let filePath = safeStaticPath(urlPath);
    if (filePath === null) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (!existsSync(filePath)) filePath = join(DIST_DIR, 'index.html');
    const mime = MIME_TYPES.get(extname(filePath)) ?? 'application/octet-stream';
    try {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  stripBasePath(req);
  if (!isLspUpgrade(req)) {
    handleLspUpgrade(req, socket, head);
    return;
  }
  requireSignedInUpgrade(req, socket)
    .then((allowed) => {
      if (allowed) handleLspUpgrade(req, socket, head);
    })
    .catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
});

server.listen(PORT, () => {
  console.log(`\n  Lang Tutor running at http://localhost:${PORT}${BASE_PATH === '/' ? '' : BASE_PATH}\n`);
  if (!existsSync(DIST_DIR)) {
    console.log('  Warning: dist/ not found — run "pnpm build" first.\n');
  }
});

function stripBasePath(req) {
  if (BASE_PREFIX === null || typeof req.url !== 'string') return;
  if (req.url === BASE_PREFIX) {
    req.url = '/';
    return;
  }
  if (req.url.startsWith(`${BASE_PREFIX}/`)) {
    req.url = req.url.slice(BASE_PREFIX.length) || '/';
    return;
  }
  if (req.url.startsWith(`${BASE_PREFIX}?`)) {
    req.url = `/${req.url.slice(BASE_PREFIX.length)}`;
  }
}

function requestPath(req) {
  return (req.url ?? '/').split('?')[0];
}

function safeStaticPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0')) return null;

  const distRoot = resolve(DIST_DIR);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = resolve(distRoot, relativePath);
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) return null;
  return filePath;
}

function isToolRequest(req) {
  const path = requestPath(req);
  return TOOL_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isLspUpgrade(req) {
  return requestPath(req) === '/lsp';
}

async function requireSignedInUser(req, res) {
  if (!REQUIRE_AUTH) return true;
  if (await readAuthSession(req)) return true;
  writeJsonResponse(res, 401, { error: 'Sign in to use hosted tooling.' });
  return false;
}

async function requireSignedInUpgrade(req, socket) {
  if (!REQUIRE_AUTH) return true;
  if (await readAuthSession(req)) return true;
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
  return false;
}

function writeJsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
