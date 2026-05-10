/**
 * Toolchain runner for /check (syntax errors) and /format (auto-format).
 * Shared by Vite dev server middleware and the production proxy server.
 *
 * SECURITY NOTE: This module spawns external compilers/formatters with
 * `spawn(cmd, args[])` only — array form, no shell. The `cmd` and `args`
 * values are hardcoded constants in this file; user code is piped via
 * stdin only. There is no shell-injection vector. We do NOT use
 * child_process.exec() (which would interpret a shell string).
 *
 * Missing toolchains (ENOENT) are reported as `{ available: false }` so the
 * frontend silently falls back rather than nagging about missing tools.
 */

import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 512 * 1024;

/**
 * Spawn a tool, pipe `input` to stdin, return { stdout, stderr, exitCode, available }.
 * `cmd` MUST be a hardcoded constant — never user-supplied.
 * `args` MUST be a hardcoded array — never built from user input.
 * `input` may contain user code; it goes to stdin, never to argv or shell.
 */
function spawnTool(cmd, args, input) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const isNotFound = e && e.code === 'ENOENT';
      resolve({ stdout: '', stderr: String(e), exitCode: -1, available: !isNotFound });
      return;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let unavailable = false;

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (e && e.code === 'ENOENT') {
        unavailable = true;
      } else {
        stderr += String(e);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: killed ? `${stderr}\n[killed: timeout after ${TIMEOUT_MS}ms]` : stderr,
        exitCode: code ?? -1,
        available: !unavailable,
      });
    });

    try {
      proc.stdin.write(input);
      proc.stdin.end();
    } catch {
      /* process error event will fire */
    }
  });
}

// ── Rust ────────────────────────────────────────────────────────────────────

async function rustCheck(code) {
  const result = await spawnTool('rustc', ['--edition=2021', '--error-format=json', '--emit=metadata', '-o', devNull, '-'], code);

  if (!result.available) return { available: false, diagnostics: [] };

  const diagnostics = [];
  for (const line of result.stderr.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || (j.level !== 'error' && j.level !== 'warning')) continue;
    if (!Array.isArray(j.spans) || j.spans.length === 0) continue;
    const span = j.spans.find((s) => s.is_primary) ?? j.spans[0];
    diagnostics.push({
      severity: j.level === 'error' ? 'error' : 'warning',
      line: span.line_start ?? 1,
      column: span.column_start ?? 1,
      endLine: span.line_end ?? span.line_start ?? 1,
      endColumn: span.column_end ?? (span.column_start ?? 1) + 1,
      message: j.message ?? '',
    });
  }
  return { available: true, diagnostics };
}

async function rustFormat(code) {
  const result = await spawnTool('rustfmt', ['--emit=stdout', '--edition=2021'], code);
  if (!result.available) return { ok: false, available: false, error: 'rustfmt not found in PATH' };
  if (result.exitCode !== 0) return { ok: false, available: true, error: result.stderr.trim() || 'rustfmt failed' };
  return { ok: true, available: true, code: result.stdout };
}

// ── C++ ─────────────────────────────────────────────────────────────────────

async function cppCheck(code) {
  const result = await spawnTool(
    'clang',
    ['-fsyntax-only', '-x', 'c++', '-std=c++23', '-Wall', '-fno-color-diagnostics', '-fno-caret-diagnostics', '-'],
    code
  );

  if (!result.available) return { available: false, diagnostics: [] };

  const diagnostics = [];
  // `<stdin>:LINE:COL: severity: message`
  const re = /^<stdin>:(\d+):(\d+):\s+(error|warning|note|fatal error):\s+(.*)$/;
  for (const line of result.stderr.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const sev = m[3] === 'note' ? 'info' : m[3] === 'warning' ? 'warning' : 'error';
    diagnostics.push({
      severity: sev,
      line: Number.parseInt(m[1], 10),
      column: Number.parseInt(m[2], 10),
      message: m[4],
    });
  }
  return { available: true, diagnostics };
}

async function cppFormat(code) {
  const result = await spawnTool('clang-format', ['--assume-filename=main.cpp'], code);
  if (!result.available) return { ok: false, available: false, error: 'clang-format not found in PATH' };
  if (result.exitCode !== 0) return { ok: false, available: true, error: result.stderr.trim() || 'clang-format failed' };
  return { ok: true, available: true, code: result.stdout };
}

// ── Python ──────────────────────────────────────────────────────────────────

const PY_CHECK_SCRIPT = `
import ast, sys, json
src = sys.stdin.read()
try:
    ast.parse(src)
    print(json.dumps([]))
except SyntaxError as e:
    print(json.dumps([{
        "severity": "error",
        "line": e.lineno or 1,
        "column": (e.offset or 1),
        "endLine": e.end_lineno or e.lineno or 1,
        "endColumn": (e.end_offset or (e.offset or 1) + 1),
        "message": e.msg or "syntax error"
    }]))
except Exception as e:
    print(json.dumps([{
        "severity": "error", "line": 1, "column": 1, "message": str(e)
    }]))
`;

function parsePythonOutput(stdout) {
  try {
    const arr = JSON.parse(stdout.trim() || '[]');
    return { available: true, diagnostics: Array.isArray(arr) ? arr : [] };
  } catch {
    return { available: true, diagnostics: [] };
  }
}

async function pythonCheck(code) {
  const result = await spawnTool('python', ['-c', PY_CHECK_SCRIPT], code);
  if (!result.available) {
    // Fall back to the Windows `py` launcher.
    const fallback = await spawnTool('py', ['-c', PY_CHECK_SCRIPT], code);
    if (!fallback.available) return { available: false, diagnostics: [] };
    return parsePythonOutput(fallback.stdout);
  }
  return parsePythonOutput(result.stdout);
}

async function pythonFormat(code) {
  const result = await spawnTool('black', ['-q', '-'], code);
  if (!result.available) return { ok: false, available: false, error: 'black not found in PATH (pip install black)' };
  if (result.exitCode !== 0) return { ok: false, available: true, error: result.stderr.trim() || 'black failed' };
  return { ok: true, available: true, code: result.stdout };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function checkCode(lang, code) {
  switch (lang) {
    case 'rust':
      return rustCheck(code);
    case 'cpp':
      return cppCheck(code);
    case 'python':
      return pythonCheck(code);
    default:
      return { available: false, diagnostics: [] };
  }
}

export async function formatCode(lang, code) {
  switch (lang) {
    case 'rust':
      return rustFormat(code);
    case 'cpp':
      return cppFormat(code);
    case 'python':
      return pythonFormat(code);
    default:
      return { ok: false, error: `unknown language: ${lang}` };
  }
}
