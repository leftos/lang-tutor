#!/usr/bin/env node
// Runs `biome check --write` on .ts/.tsx/.mts/.cts/.js/.mjs/.json/.css edits under src/ or tools/.
// Auto-fixes lint+format violations. Exits 0 unless biome finds non-fixable errors.

import { stdin, platform } from 'node:process';
import { spawnSync } from 'node:child_process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = payload?.tool_input?.file_path ?? '';
if (!filePath) process.exit(0);

const isLintable = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(filePath);
const inScope = /[/\\](src|tools)[/\\]/.test(filePath);
if (!isLintable || !inScope) process.exit(0);

const isWindows = platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
// shell:true on Windows is required for .cmd/.bat invocation in Node 20.12+ (CVE-2024-27980 fix).
const result = spawnSync(pnpm, ['exec', 'biome', 'check', '--write', filePath], {
  stdio: 'inherit',
  shell: isWindows,
});

if (result.status !== 0) {
  process.stderr.write(`biome reported issues in ${filePath} — review the output above.\n`);
  process.exit(2);
}

process.exit(0);
