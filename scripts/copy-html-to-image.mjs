// Bundles html-to-image into a single IIFE that exposes `window.htmlToImage`,
// then writes it under public/lang-tutor-assets/. The supervisor reads this
// file at module load and inlines it into the iframe's <head> via the
// BOOTSTRAP_SCRIPT in tools/projects.mjs. Inline embedding sidesteps the
// cross-origin barrier (parent at :5173, iframe at :5180): a same-origin
// dynamic import would need CORS headers we don't control.
//
// Wired into package.json as postinstall + predev + prebuild so the asset is
// kept in sync with the installed html-to-image version.

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'node_modules', 'html-to-image', 'es', 'index.js');
const outDir = path.join(projectRoot, 'public', 'lang-tutor-assets');
const outFile = path.join(outDir, 'html-to-image.js');

if (!existsSync(entry)) {
  console.warn(`[copy-html-to-image] skipping: ${entry} not present (run pnpm install first).`);
  process.exit(0);
}

const entryStat = await stat(entry);
let needsRebuild = true;
if (existsSync(outFile)) {
  const outStat = await stat(outFile);
  if (outStat.mtimeMs >= entryStat.mtimeMs) needsRebuild = false;
}

if (!needsRebuild) {
  console.log('[copy-html-to-image] up to date.');
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: 'htmlToImage',
  minify: true,
  target: 'es2020',
  write: false,
  logLevel: 'warning',
});

const out = result.outputFiles[0];
if (!out) {
  console.error('[copy-html-to-image] esbuild produced no output.');
  process.exit(1);
}

// Escape `</script>` so the bundle is safe to embed inside an inline <script>
// tag (the supervisor inlines this file into the iframe's <head>).
const safeText = out.text.replace(/<\/script>/gi, '<\\/script>');
await writeFile(outFile, safeText, 'utf8');

const pkgJson = JSON.parse(await readFile(path.join(projectRoot, 'node_modules', 'html-to-image', 'package.json'), 'utf8'));
console.log(`[copy-html-to-image] wrote ${out.text.length} bytes (html-to-image@${pkgJson.version}) -> public/lang-tutor-assets/html-to-image.js`);
