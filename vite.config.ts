import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
// @ts-expect-error -- plain JS module with JSDoc types
import { checkCode, formatCode } from './tools/checker.mjs';
// @ts-expect-error -- plain JS module
import { handleProjectRequest } from './tools/project-routes.mjs';

interface CheckBody {
  lang?: 'rust' | 'cpp' | 'python';
  code?: string;
}

function readJsonBody(req: { on: (e: string, cb: (...a: unknown[]) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Vite plugin: mounts /check and /format middleware that delegate to tools/checker.mjs. */
function toolchainPlugin(): Plugin {
  return {
    name: 'lang-tutor-toolchain',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handleProjectRequest(req, res)) return;
        next();
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
    plugins: [tailwindcss(), toolchainPlugin()],
    server: {
      proxy: {
        '/v1': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('x-api-key', env.ANTHROPIC_API_KEY ?? '');
              proxyReq.setHeader('anthropic-version', '2023-06-01');
              proxyReq.removeHeader('origin');
              proxyReq.removeHeader('referer');
            });
            proxy.on('proxyRes', (proxyRes) => {
              // Cloudflare cookies meant for api.anthropic.com would be rejected by the
              // browser as cross-origin and noisy in DevTools. Strip them.
              delete proxyRes.headers['set-cookie'];
            });
          },
        },
      },
    },
  };
});
