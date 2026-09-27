/**
 * Readiness report: which runtimes, host checkers and language servers this
 * machine has, what each one enables, and how to fix what is missing.
 *
 *   node scripts/doctor.mjs          → table on stdout
 *   node scripts/doctor.mjs --json   → { rows, missing } for scripts/setup.ps1
 *
 * Exits 1 when any row is missing. Rows come from the server's own tables
 * (`LSP_CONFIG` / `LANG_SERVERS` in tools/lsp.mjs, `CHECKER_TOOLS` in
 * tools/checker.mjs), so a new server or checker gets a row without an edit
 * here. Every probe runs the tool and requires exit 0; PATH presence alone is
 * not enough (the rustup proxy puts `rust-analyzer.exe` on PATH whether or
 * not the component is installed).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECKER_TOOLS } from '../tools/checker.mjs';
import { __internals, classifyVersionRun, probeServer, runCommand } from '../tools/lsp.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 5_000;
const TOOLCHAIN_IMAGE = 'lang-tutor-toolchains:latest';
const SANDBOX_LANGS = ['rust', 'cpp', 'dasm', 'python', 'csharp'];

/**
 * @typedef {import('../tools/lsp.mjs').CommandRunner} CommandRunner
 * @typedef {{ available: boolean; version?: string; error?: string }} Outcome
 * @typedef {object} Row
 * @property {string} id
 * @property {'runtime' | 'checker' | 'lsp'} section
 * @property {string} name
 * @property {string} capability
 * @property {string[]} languages
 * @property {'ready' | 'missing'} status
 * @property {string | null} version
 * @property {string | null} error
 * @property {string | null} fix      - a command, or a hint when it can't be automated
 * @property {string | null} recipe   - the scripts/setup.ps1 recipe that installs it
 */

/** What each setup.ps1 recipe runs, shown as the fix for rows that need it. */
const RECIPE_FIX = {
  node: 'winget install OpenJS.NodeJS.LTS',
  pnpm: 'corepack enable pnpm (or winget install pnpm.pnpm)',
  'pnpm-install': 'pnpm install',
  'docker-desktop': 'winget install Docker.DockerDesktop',
  'docker-engine': 'docker desktop start',
  'toolchain-image': '.\\lt.ps1 toolchain',
  'dotnet-sdk': 'winget install Microsoft.DotNet.SDK.8',
  rustup: 'winget install Rustlang.Rustup, then rustup component add rustfmt rust-analyzer',
  python: 'winget install Python.Python.3.13',
  black: 'uv tool install black',
  llvm: 'winget install LLVM.LLVM, then add its bin folder to PATH',
  csdevkit: 'code --install-extension ms-dotnettools.csdevkit',
};

const CHECKER_META = {
  rustc: { capability: 'Rust syntax check when rust-analyzer is unavailable', languages: ['rust'], recipe: 'rustup' },
  rustfmt: { capability: 'Rust formatting', languages: ['rust'], recipe: 'rustup' },
  clang: { capability: 'C++ syntax check when clangd is unavailable', languages: ['cpp', 'dasm'], recipe: 'llvm' },
  'clang-format': { capability: 'C++ formatting', languages: ['cpp', 'dasm'], recipe: 'llvm' },
  python: { capability: 'Python syntax check when basedpyright is unavailable', languages: ['python'], recipe: 'python' },
  black: { capability: 'Python formatting', languages: ['python'], recipe: 'black' },
};

const LSP_META = {
  cpp: { capability: 'C++ live diagnostics, hover, completion', recipe: 'llvm' },
  rust: { capability: 'Rust live diagnostics, hover, completion', recipe: 'rustup' },
  python: { capability: 'Python live diagnostics, hover, completion', recipe: 'pnpm-install' },
  'csharp-roslyn': { capability: 'C# live diagnostics, hover, completion (Roslyn, preferred)', recipe: 'csdevkit' },
  csharp: {
    capability: 'C# live diagnostics, hover, completion (OmniSharp fallback)',
    recipe: null,
    fix: 'scoop install omnisharp, or a release from https://github.com/OmniSharp/omnisharp-roslyn/releases',
  },
  web: { capability: 'JavaScript/TypeScript live diagnostics, hover, completion', recipe: 'pnpm-install' },
  'web-html': { capability: 'HTML live diagnostics and completion', recipe: 'pnpm-install' },
  'web-css': { capability: 'CSS live diagnostics and completion', recipe: 'pnpm-install' },
  'web-biome': { capability: 'Biome lint diagnostics', recipe: 'pnpm-install' },
};

// ── Fixes ───────────────────────────────────────────────────────────────────

const RUSTUP_FIXES = [
  { re: /Unknown binary '([^']+)' in official toolchain/, fix: (m) => `rustup component add ${stripExe(m[1])}` },
  { re: /'([^']+)' is not installed for the toolchain/, fix: (m) => `rustup component add ${stripExe(m[1])}` },
  { re: /no default (toolchain )?is configured/, fix: () => 'rustup default stable' },
];

function stripExe(name) {
  return name.replace(/\.exe$/i, '');
}

/**
 * The rustup command that fixes a rustup proxy error, or null when `error` is
 * not one. The proxy answers for every rustup-managed binary, so this applies
 * to rustc, rustfmt and rust-analyzer alike.
 *
 * @param {string} error
 * @returns {string | null}
 */
export function rustupFix(error) {
  for (const { re, fix } of RUSTUP_FIXES) {
    const match = re.exec(error);
    if (match !== null) return fix(match);
  }
  return null;
}

// ── Row assembly ────────────────────────────────────────────────────────────

/**
 * @param {{ id: string; section: Row['section']; name: string; capability: string; languages: string[]; recipe: string | null; fix?: string }} spec
 * @param {Outcome} outcome
 * @returns {Row}
 */
export function makeRow(spec, outcome) {
  const ready = outcome.available;
  const error = ready ? null : (outcome.error ?? 'unavailable');
  const recipeFix = spec.recipe === null ? null : (RECIPE_FIX[spec.recipe] ?? null);
  return {
    id: spec.id,
    section: spec.section,
    name: spec.name,
    capability: spec.capability,
    languages: spec.languages,
    status: ready ? 'ready' : 'missing',
    version: outcome.version ?? null,
    error,
    fix: ready ? null : (rustupFix(error ?? '') ?? spec.fix ?? recipeFix ?? `install ${spec.name} and put it on PATH`),
    recipe: ready ? null : spec.recipe,
  };
}

/** Run `cmd args` and classify it like the LSP probe: exit 0 → available. */
async function probeCommand(run, cmd, args, shell = IS_WIN) {
  return classifyVersionRun(await run(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS, shell }), cmd);
}

/**
 * Require `outcome.version` to carry at least `major.minor`.
 *
 * @param {Outcome} outcome
 * @param {number} major
 * @param {number} minor
 * @returns {Outcome}
 */
export function requireVersion(outcome, major, minor) {
  if (!outcome.available) return outcome;
  const match = /(\d+)\.(\d+)/.exec(outcome.version ?? '');
  if (match === null) return { available: false, error: `could not read a version from "${outcome.version ?? ''}"` };
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  if (have > major || (have === major && haveMinor >= minor)) return outcome;
  return { available: false, version: outcome.version, error: `${outcome.version} is older than ${major}.${minor}` };
}

/** Newest .NET SDK from `dotnet --list-sdks`, ready when its major is at least 8. */
async function probeDotnetSdk(run) {
  const result = await run('dotnet', ['--list-sdks'], { timeoutMs: PROBE_TIMEOUT_MS, shell: false });
  const listed = classifyVersionRun(result, 'dotnet');
  if (!listed.available) return listed;
  const versions = result.stdout
    .split('\n')
    .map((line) => line.trim().split(' ')[0] ?? '')
    .filter((v) => /^\d+\./.test(v));
  const newest = versions.sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]))[0];
  if (newest === undefined) return { available: false, error: 'no .NET SDK installed' };
  return requireVersion({ available: true, version: newest }, 8, 0);
}

/** @param {CommandRunner} run */
async function runtimeRows(run) {
  const docker = await probeCommand(run, 'docker', ['--version'], false);
  const engine = docker.available
    ? await probeCommand(run, 'docker', ['info', '--format', '{{.ServerVersion}}'], false)
    : { available: false, error: 'Docker CLI is missing' };
  const image = engine.available
    ? await probeCommand(run, 'docker', ['image', 'inspect', TOOLCHAIN_IMAGE, '--format', '{{.Id}}'], false)
    : { available: false, error: 'Docker engine is not running' };
  const [node, pnpm, dotnet] = await Promise.all([
    probeCommand(run, 'node', ['--version'], false).then((o) => requireVersion(o, 20, 6)),
    probeCommand(run, 'pnpm', ['--version']),
    probeDotnetSdk(run),
  ]);
  const all = ['rust', 'cpp', 'dasm', 'python', 'csharp', 'web'];
  const sandbox = 'Run button for Rust, C++, DASM, Python and C# console snippets';
  return [
    makeRow(
      { id: 'node', section: 'runtime', name: 'Node >= 20.6', capability: 'The app server and its tooling', languages: all, recipe: 'node' },
      node
    ),
    makeRow(
      { id: 'pnpm', section: 'runtime', name: 'pnpm', capability: 'Installs the project and its language servers', languages: all, recipe: 'pnpm' },
      pnpm
    ),
    makeRow(
      { id: 'docker', section: 'runtime', name: 'Docker CLI', capability: sandbox, languages: SANDBOX_LANGS, recipe: 'docker-desktop' },
      docker
    ),
    makeRow(
      { id: 'docker-engine', section: 'runtime', name: 'Docker engine', capability: sandbox, languages: SANDBOX_LANGS, recipe: 'docker-engine' },
      engine
    ),
    makeRow(
      { id: 'toolchain-image', section: 'runtime', name: TOOLCHAIN_IMAGE, capability: sandbox, languages: SANDBOX_LANGS, recipe: 'toolchain-image' },
      image
    ),
    makeRow(
      { id: 'dotnet-sdk', section: 'runtime', name: '.NET SDK >= 8', capability: 'C# WPF project Run', languages: ['csharp'], recipe: 'dotnet-sdk' },
      dotnet
    ),
  ];
}

/** Checkers spawn without a shell, so a probe does the same: a `.cmd` shim does not count. */
async function probeChecker(run, tool) {
  const outcome = await probeCommand(run, tool.bin, ['--version'], false);
  if (outcome.available || tool.fallbackBin === undefined) return outcome;
  const fallback = await probeCommand(run, tool.fallbackBin, ['--version'], false);
  return fallback.available ? fallback : outcome;
}

/** @param {CommandRunner} run */
async function checkerRows(run) {
  return Promise.all(
    CHECKER_TOOLS.map(async (tool) => {
      const meta = CHECKER_META[tool.bin] ?? { capability: `${tool.bin} (host checker)`, languages: [], recipe: null };
      const spec = { id: `checker:${tool.bin}`, section: 'checker', name: tool.bin, ...meta };
      return makeRow(spec, await probeChecker(run, tool));
    })
  );
}

/** User-facing languages whose server list names `serverKey`, directly or in a fallback group. */
function languagesFor(serverKey) {
  return Object.entries(__internals.LANG_SERVERS)
    .filter(([, entries]) => entries.some((e) => (Array.isArray(e) ? e.includes(serverKey) : e === serverKey)))
    .map(([lang]) => lang);
}

/**
 * A member of a fallback group (Roslyn, then OmniSharp) that is not installed
 * is ready when another member is: the language still gets its server.
 *
 * @param {Map<string, Outcome>} outcomes
 * @returns {Map<string, Outcome>}
 */
export function applyFallbackGroups(outcomes) {
  const result = new Map(outcomes);
  for (const entries of Object.values(__internals.LANG_SERVERS)) {
    for (const group of entries.filter((e) => Array.isArray(e))) {
      const covering = group.find((key) => outcomes.get(key)?.available === true);
      if (covering === undefined) continue;
      for (const key of group) {
        if (outcomes.get(key)?.available !== true) result.set(key, { available: true, version: `not installed; ${covering} covers it` });
      }
    }
  }
  return result;
}

/** @param {CommandRunner} run @param {string} root */
async function lspRows(run, root) {
  const keys = Object.keys(__internals.LSP_CONFIG);
  const probed = await Promise.all(keys.map(async (key) => /** @type {const} */ ([key, await probeServer(key, { run, root })])));
  const outcomes = applyFallbackGroups(new Map(probed.map(([key, p]) => [key, { available: p.available, version: p.version, error: p.error }])));
  return keys.map((key) => {
    const config = __internals.LSP_CONFIG[key];
    const meta = LSP_META[key] ?? { capability: `${key} language server`, recipe: null };
    const spec = { id: `lsp:${key}`, section: 'lsp', name: `${config.bin} (${key})`, languages: languagesFor(key), ...meta };
    return makeRow(spec, outcomes.get(key) ?? { available: false, error: 'not probed' });
  });
}

/**
 * Probe everything and return one row per runtime, checker and language server.
 *
 * @param {{ run?: CommandRunner; root?: string }} [deps]
 * @returns {Promise<Row[]>}
 */
export async function collectRows({ run = runCommand, root = REPO_ROOT } = {}) {
  const [runtime, checkers, lsps] = await Promise.all([runtimeRows(run), checkerRows(run), lspRows(run, root)]);
  return [...runtime, ...checkers, ...lsps];
}

// ── Output ──────────────────────────────────────────────────────────────────

const SECTION_TITLES = { runtime: 'Runtimes', checker: 'Host checkers (/check, /format)', lsp: 'Language servers' };

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** @param {Row} row @param {boolean} color */
function formatRow(row, color) {
  const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const status = row.status === 'ready' ? paint('32', 'ready  ') : paint('33', 'MISSING');
  const detail = row.status === 'ready' ? truncate(row.version ?? '', 70) : '';
  const lines = [`  ${status}  ${row.name.padEnd(54)} ${detail}`.trimEnd()];
  if (row.status === 'missing') {
    lines.push(`           why:     ${row.error ?? ''}`);
    lines.push(`           enables: ${row.capability}${row.languages.length > 0 ? ` [${row.languages.join(', ')}]` : ''}`);
    lines.push(`           fix:     ${row.fix ?? ''}`);
  }
  return lines.join('\n');
}

/**
 * Render the readiness table.
 *
 * @param {Row[]} rows
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
export function formatTable(rows, { color = false } = {}) {
  const out = ['Lang Tutor readiness'];
  for (const section of /** @type {const} */ (['runtime', 'checker', 'lsp'])) {
    out.push('', SECTION_TITLES[section]);
    for (const row of rows.filter((r) => r.section === section)) out.push(formatRow(row, color));
  }
  const missing = rows.filter((r) => r.status === 'missing').length;
  out.push('');
  out.push(missing === 0 ? `All ${rows.length} checks ready.` : `${missing} of ${rows.length} checks missing. .\\lt.ps1 setup installs what it can.`);
  return out.join('\n');
}

async function main(argv) {
  // The probes spawn .cmd shims with `shell: true` and hardcoded argv, which
  // Node flags as DEP0190 on every run; the warning is noise in a report.
  process.noDeprecation = true;
  const rows = await collectRows();
  const missing = rows.filter((r) => r.status === 'missing').length;
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ rows, missing }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(rows, { color: process.stdout.isTTY === true })}\n`);
  }
  // tools/lsp.mjs and tools/projects.mjs install process hooks meant for a
  // long-running server; exit explicitly once stdout has drained.
  process.stdout.write('', () => process.exit(missing > 0 ? 1 : 0));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`doctor failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(2);
  });
}
