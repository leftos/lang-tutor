#!/usr/bin/env node
// Blocks Read/Edit/Write/MultiEdit on .env files (allows .env.example).
// Reads the hook payload (JSON) from stdin, exits 2 to block, 0 to allow.

import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  // Be permissive on parse errors — don't block legitimate tool calls just because the harness changed shape.
  process.exit(0);
}

const filePath = payload?.tool_input?.file_path ?? '';
if (!filePath) process.exit(0);

const basename = filePath.split(/[\\/]/).pop() ?? '';

// Match `.env`, `.env.local`, `.env.production`, etc. — but not `.env.example`.
const isSecrets = /^\.env(\..+)?$/.test(basename) && !/\.example$/.test(basename);

if (isSecrets) {
  process.stderr.write(
    `Blocked: ${filePath} is a secrets file. Reading or editing .env files leaks API keys into context. ` +
      `If you only need variable names, parse them out (e.g. grep '^[A-Z_]\\+=') without exposing values.\n`,
  );
  process.exit(2);
}

process.exit(0);
