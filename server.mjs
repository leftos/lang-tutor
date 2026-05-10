/**
 * Rust teacher — production server
 * Serves the Vite build (dist/) and proxies POST /v1/messages to the Anthropic API,
 * injecting x-api-key from ANTHROPIC_API_KEY so the browser never sees the key.
 *
 * Usage:
 *   pnpm build                              # build dist/
 *   pnpm serve                              # node --env-file=.env server.mjs
 *   or: ANTHROPIC_API_KEY=sk-ant-... node server.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkCode, formatCode } from './tools/checker.mjs';
import { handleProjectRequest } from './tools/project-routes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const DIST_DIR = join(__dirname, 'dist');

if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  pnpm serve');
  console.error('  (runs: node --env-file=.env server.mjs)');
  process.exit(1);
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (await handleProjectRequest(req, res)) return;

  if (req.method === 'POST' && (req.url === '/check' || req.url === '/format')) {
    try {
      const body = await readBody(req);
      const { lang, code } = JSON.parse(body);
      if (!lang || typeof code !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { lang, code }' }));
        return;
      }
      const result = req.url === '/check' ? await checkCode(lang, code) : await formatCode(lang, code);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    try {
      const body = await readBody(req);
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
      // Pipe the upstream body straight through so SSE streaming works.
      // Don't buffer with .json() — that defeats streaming for stream:true requests.
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } else {
        res.end();
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  if (req.method === 'GET') {
    const urlPath = (req.url ?? '/').split('?')[0];
    let filePath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
    if (!existsSync(filePath)) filePath = join(DIST_DIR, 'index.html');
    const mime = MIME_TYPES.get(extname(filePath)) ?? 'application/octet-stream';
    try {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Rust teacher running at http://localhost:${PORT}\n`);
  if (!existsSync(DIST_DIR)) {
    console.log('  Warning: dist/ not found — run "pnpm build" first.\n');
  }
});
