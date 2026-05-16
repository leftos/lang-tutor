import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
// @ts-expect-error -- plain JS module
import { handleStateRequest } from './tools/app-state.mjs';
// @ts-expect-error -- plain JS module with JSDoc types
import { checkCode, formatCode } from './tools/checker.mjs';
// @ts-expect-error -- plain JS module
import { handleLspRequest, handleLspUpgrade } from './tools/lsp.mjs';
// @ts-expect-error -- plain JS module
import { handleProjectRequest, handleProjectUpgrade } from './tools/project-routes.mjs';
// @ts-expect-error -- plain JS module with JSDoc types
import { runSnippet } from './tools/runner.mjs';

interface CheckBody {
  lang?: 'rust' | 'cpp' | 'python' | 'csharp';
  code?: string;
}

function normalizeBasePath(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return '/';
  if (raw === './') return raw;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function readJsonBody(req: { on: (e: string, cb: (...a: unknown[]) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Vite plugin: mounts local toolchain middleware for run / check / format. */
function toolchainPlugin(): Plugin {
  return {
    name: 'lang-tutor-toolchain',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handleStateRequest(req, res)) return;
        if (await handleLspRequest(req, res)) return;
        if (await handleProjectRequest(req, res)) return;
        next();
      });

      // WebSocket upgrades on /lsp need to attach to the underlying http.Server.
      // Vite's own HMR socket lives on /__hmr (no path collision).
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (handleLspUpgrade(req, socket, head)) return;
        handleProjectUpgrade(req, socket, head);
      });

      server.middlewares.use('/check', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        try {
          const body = await readJsonBody(req);
          const { lang, code } = JSON.parse(body) as CheckBody;
          if (!lang || typeof code !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'expected { lang, code }' }));
            return;
          }
          const result = await checkCode(lang, code);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });

      server.middlewares.use('/run', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        try {
          const body = await readJsonBody(req);
          const { lang, code } = JSON.parse(body) as CheckBody;
          if (!lang || typeof code !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'expected { lang, code }' }));
            return;
          }
          const result = await runSnippet(lang, code);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });

      server.middlewares.use('/format', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        try {
          const body = await readJsonBody(req);
          const { lang, code } = JSON.parse(body) as CheckBody;
          if (!lang || typeof code !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'expected { lang, code }' }));
            return;
          }
          const result = await formatCode(lang, code);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: normalizeBasePath(process.env.LANG_TUTOR_BASE_PATH ?? env.LANG_TUTOR_BASE_PATH),
    plugins: [tailwindcss(), toolchainPlugin()],
    build: {
      // CodeMirror language packages are intentionally isolated into one editor vendor chunk.
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id: string): string | undefined {
            const normalized = id.replace(/\\/g, '/');
            if (!normalized.includes('/node_modules/')) return undefined;
            if (normalized.includes('/@codemirror/') || normalized.includes('/@lezer/') || normalized.includes('/@replit/codemirror-lang-csharp/')) {
              return 'editor-vendor';
            }
            if (normalized.includes('/marked/') || normalized.includes('/dompurify/') || normalized.includes('/html-to-image/')) {
              return 'content-vendor';
            }
            return 'vendor';
          },
        },
      },
    },
    server: {
      host: true,
    },
  };
});
