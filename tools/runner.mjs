/**
 * Local sandbox runner for single-buffer languages.
 *
 * Student code never goes to public execution providers. The backend writes it
 * into an untracked temp workspace and runs the repo's toolchain image with a
 * read-only root filesystem, no network, no Linux capabilities, and tight CPU /
 * memory / process limits.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RUN_ROOT = join(REPO_ROOT, '.tmp', 'runs');

const TOOLCHAIN_IMAGE = process.env.LANG_TUTOR_TOOLCHAIN_IMAGE ?? 'lang-tutor-toolchains:latest';
const RUN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 512 * 1024;

const LANG_CONFIG = Object.freeze({
  cpp: { file: 'main.cpp' },
  rust: { file: 'main.rs' },
  python: { file: 'main.py' },
  csharp: { file: 'main.cs' },
});

function dockerProblem() {
  const version = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (version.error !== undefined && version.error !== null) {
    return 'docker not found on PATH. Install Docker Desktop, start it, then run .\\lt.ps1 toolchain.';
  }

  const info = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
  if (info.status !== 0) {
    return 'Docker is installed but the engine is not reachable. Start Docker Desktop, then run .\\lt.ps1 toolchain.';
  }

  const image = spawnSync('docker', ['image', 'inspect', TOOLCHAIN_IMAGE], { stdio: 'ignore', timeout: 10_000 });
  if (image.status !== 0) {
    return `Local toolchain image ${TOOLCHAIN_IMAGE} was not found. Run .\\lt.ps1 toolchain before running code.`;
  }

  return null;
}

function assertRepoChild(path) {
  const root = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep;
  const resolved = resolve(path);
  if (!resolved.startsWith(root)) {
    throw new Error(`refusing to use path outside repo: ${resolved}`);
  }
  return resolved;
}

function createWorkspace(lang) {
  mkdirSync(RUN_ROOT, { recursive: true });
  return mkdtempSync(join(RUN_ROOT, `${lang}-`));
}

function removeWorkspace(path) {
  const target = assertRepoChild(path);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
}

function appendChunk(output, chunk) {
  if (output.length >= MAX_OUTPUT) return output;
  const text = chunk.toString('utf8');
  const remaining = MAX_OUTPUT - output.length;
  return output + text.slice(0, remaining);
}

function formatOutput(stdout, stderr, exitCode, timedOut) {
  const parts = [stdout.trimEnd(), stderr.trimEnd()].filter((p) => p.length > 0);
  let output = parts.join('\n');
  if (timedOut) {
    output = [output, `Run timed out after ${RUN_TIMEOUT_MS / 1000} seconds.`].filter(Boolean).join('\n');
  } else if (exitCode !== 0 && output.length === 0) {
    output = `Process exited with code ${exitCode}.`;
  }
  if (stdout.length + stderr.length >= MAX_OUTPUT) {
    output += '\n[output truncated]';
  }
  return output || '(no output)';
}

function runDocker(lang, workspace) {
  return new Promise((resolveResult) => {
    const name = `lang-tutor-run-${process.pid}-${randomBytes(4).toString('hex')}`;
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '-e',
      'DOTNET_CLI_TELEMETRY_OPTOUT=1',
      '-e',
      'DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1',
      '-e',
      'DOTNET_NOLOGO=1',
      '-e',
      'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1',
      '-e',
      'NUGET_XMLDOC_MODE=skip',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=512m',
      '--mount',
      `type=bind,source=${workspace},target=/workspace,readonly`,
      TOOLCHAIN_IMAGE,
      lang,
    ];

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 5_000 });
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveResult({ ok: false, output: `Docker run failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolveResult({
        ok: exitCode === 0 && !timedOut,
        output: formatOutput(stdout, stderr, exitCode, timedOut),
      });
    });
  });
}

export async function runSnippet(lang, code) {
  const config = LANG_CONFIG[lang];
  if (config === undefined) {
    return { ok: false, output: `Unsupported run language: ${lang}` };
  }
  if (typeof code !== 'string') {
    return { ok: false, output: 'Expected code to be a string.' };
  }

  const problem = dockerProblem();
  if (problem !== null) {
    return { ok: false, output: problem };
  }

  const workspace = createWorkspace(lang);
  try {
    writeFileSync(join(workspace, config.file), code, 'utf8');
    return await runDocker(lang, workspace);
  } finally {
    removeWorkspace(workspace);
  }
}
