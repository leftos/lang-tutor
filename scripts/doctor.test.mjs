import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKER_TOOLS } from '../tools/checker.mjs';
import { __internals } from '../tools/lsp.mjs';
import { applyFallbackGroups, collectRows, formatTable, makeRow, requireVersion, rustupFix } from './doctor.mjs';

const RUSTUP_STDERR = "error: Unknown binary 'rust-analyzer.exe' in official toolchain 'stable-x86_64-pc-windows-msvc'.\n";

/**
 * A machine where every command exits 0 with a version line, `where`/`which`
 * finds every bin, and `override(cmd, args)` can answer differently.
 */
function machine(override = () => undefined) {
  return async (cmd, args) => {
    const answer = override(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === 'where' || cmd === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n`, stderr: '' };
    if (cmd === 'node') return { code: 0, stdout: 'v24.1.0\n', stderr: '' };
    if (cmd === 'dotnet') return { code: 0, stdout: '8.0.100 [C:\\dotnet\\sdk]\n9.0.200 [C:\\dotnet\\sdk]\n', stderr: '' };
    return { code: 0, stdout: `${cmd} 1.0.0\n`, stderr: '' };
  };
}

const byId = (rows, id) => rows.find((r) => r.id === id);

let root;

beforeEach(() => {
  // An empty repo root: no node_modules/.bin, so every server goes through the injected runner.
  root = mkdtempSync(join(tmpdir(), 'doctor-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectRows', () => {
  it('yields a row for every LSP_CONFIG key and every CHECKER_TOOLS entry', async () => {
    const rows = await collectRows({ run: machine(), root });
    const ids = rows.map((r) => r.id);
    for (const key of Object.keys(__internals.LSP_CONFIG)) expect(ids).toContain(`lsp:${key}`);
    for (const tool of CHECKER_TOOLS) expect(ids).toContain(`checker:${tool.bin}`);
    for (const id of ['node', 'pnpm', 'docker', 'docker-engine', 'toolchain-image', 'dotnet-sdk']) expect(ids).toContain(id);
    for (const row of rows) expect(row.capability.length).toBeGreaterThan(0);
  });

  it('marks an exit-0 probe ready with the version from stdout', async () => {
    const rows = await collectRows({ run: machine(), root });
    expect(byId(rows, 'checker:rustc')).toMatchObject({ status: 'ready', version: 'rustc 1.0.0', fix: null, recipe: null });
    expect(byId(rows, 'lsp:cpp')).toMatchObject({ status: 'ready', version: 'clangd 1.0.0' });
    expect(byId(rows, 'node')).toMatchObject({ status: 'ready', version: 'v24.1.0' });
    expect(byId(rows, 'dotnet-sdk')).toMatchObject({ status: 'ready', version: '9.0.200' });
  });

  it('marks a non-zero exit missing, with the recipe fix', async () => {
    const run = machine((cmd) => (cmd === 'black' ? { code: 1, stdout: '', stderr: 'black is broken\n' } : undefined));
    const row = byId(await collectRows({ run, root }), 'checker:black');
    expect(row).toMatchObject({ status: 'missing', error: 'black: black is broken', fix: 'uv tool install black', recipe: 'black' });
  });

  it('marks ENOENT missing', async () => {
    const run = machine((cmd) =>
      cmd === 'clang-format' ? { code: null, stdout: '', stderr: '', spawnError: 'spawn clang-format ENOENT' } : undefined
    );
    const row = byId(await collectRows({ run, root }), 'checker:clang-format');
    expect(row).toMatchObject({ status: 'missing', recipe: 'llvm' });
    expect(row.error).toContain('ENOENT');
  });

  it('marks the rustup proxy "Unknown binary" error missing with the rustup fix', async () => {
    const run = machine((cmd) => (cmd === 'rust-analyzer' ? { code: 1, stdout: '', stderr: RUSTUP_STDERR } : undefined));
    const row = byId(await collectRows({ run, root }), 'lsp:rust');
    expect(row).toMatchObject({ status: 'missing', fix: 'rustup component add rust-analyzer', recipe: 'rustup' });
    expect(row.languages).toEqual(['rust']);
  });

  it('marks Node older than 20.6 missing', async () => {
    const run = machine((cmd) => (cmd === 'node' ? { code: 0, stdout: 'v20.5.1\n', stderr: '' } : undefined));
    expect(byId(await collectRows({ run, root }), 'node')).toMatchObject({ status: 'missing', recipe: 'node' });
  });

  it('marks the toolchain image missing when the Docker engine is down, without probing the image', async () => {
    const calls = [];
    const base = machine((cmd, args) => (cmd === 'docker' && args[0] === 'info' ? { code: 1, stdout: '', stderr: 'engine down\n' } : undefined));
    const run = async (cmd, args, options) => {
      calls.push([cmd, ...args].join(' '));
      return base(cmd, args, options);
    };
    const rows = await collectRows({ run, root });
    expect(byId(rows, 'docker-engine')).toMatchObject({ status: 'missing', recipe: 'docker-engine' });
    expect(byId(rows, 'toolchain-image')).toMatchObject({ status: 'missing', error: 'Docker engine is not running' });
    expect(calls.some((c) => c.startsWith('docker image'))).toBe(false);
  });
});

describe('applyFallbackGroups', () => {
  it('treats a missing Roslyn as ready when OmniSharp covers C#', () => {
    const result = applyFallbackGroups(
      new Map([
        ['csharp-roslyn', { available: false, error: 'not found' }],
        ['csharp', { available: true, version: 'C:\\omnisharp.exe' }],
      ])
    );
    expect(result.get('csharp-roslyn')).toEqual({ available: true, version: 'not installed; csharp covers it' });
    expect(result.get('csharp')).toEqual({ available: true, version: 'C:\\omnisharp.exe' });
  });

  it('leaves both missing when neither C# server is installed', () => {
    const result = applyFallbackGroups(
      new Map([
        ['csharp-roslyn', { available: false, error: 'a' }],
        ['csharp', { available: false, error: 'b' }],
      ])
    );
    expect(result.get('csharp-roslyn')?.available).toBe(false);
    expect(result.get('csharp')?.available).toBe(false);
  });
});

describe('rustupFix', () => {
  it('maps rustup proxy errors to the component or default fix', () => {
    expect(rustupFix(RUSTUP_STDERR)).toBe('rustup component add rust-analyzer');
    expect(rustupFix("error: 'rustfmt.exe' is not installed for the toolchain 'stable'")).toBe('rustup component add rustfmt');
    expect(
      rustupFix("error: rustup could not choose a version of rustc to run, because one wasn't specified explicitly, and no default is configured.")
    ).toBe('rustup default stable');
    expect(rustupFix('spawn x ENOENT')).toBeNull();
  });
});

describe('requireVersion', () => {
  it('accepts equal or newer and rejects older', () => {
    expect(requireVersion({ available: true, version: 'v20.6.0' }, 20, 6).available).toBe(true);
    expect(requireVersion({ available: true, version: 'v21.0.0' }, 20, 6).available).toBe(true);
    expect(requireVersion({ available: true, version: 'v20.5.9' }, 20, 6).available).toBe(false);
    expect(requireVersion({ available: true, version: 'nonsense' }, 20, 6).available).toBe(false);
  });
});

describe('formatTable', () => {
  it('lists missing rows with their reason and fix, and counts them', () => {
    const spec = { id: 'x', section: 'lsp', name: 'thing', capability: 'Does things', languages: ['rust'], recipe: 'rustup' };
    const table = formatTable([
      makeRow(spec, { available: false, error: RUSTUP_STDERR.trim() }),
      makeRow({ ...spec, id: 'y' }, { available: true, version: '1.0' }),
    ]);
    expect(table).toContain('MISSING  thing');
    expect(table).toContain('fix:     rustup component add rust-analyzer');
    expect(table).toContain('enables: Does things [rust]');
    expect(table).toContain('1 of 2 checks missing.');
  });
});
