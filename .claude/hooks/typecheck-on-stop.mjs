#!/usr/bin/env node
// Runs `pnpm typecheck` once when Claude finishes a turn. Catches strict-TS regressions
// (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax) before
// they survive into the next prompt. Exits non-zero on failure so the user sees errors.

import { platform } from 'node:process';
import { spawnSync } from 'node:child_process';

const isWindows = platform === 'win32';
// shell:true on Windows lets PATHEXT resolve either install shape (winget's pnpm.exe or npm's pnpm.cmd);
// Node 20.12+ also requires it for .cmd/.bat invocation (CVE-2024-27980 fix).
const result = spawnSync('pnpm', ['typecheck'], { stdio: 'inherit', shell: isWindows });

if (result.status !== 0) {
  process.stderr.write('typecheck failed — fix TS errors before continuing.\n');
  process.exit(2);
}

process.exit(0);
