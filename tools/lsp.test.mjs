import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyVersionRun, probeServer, resolveLocalBin } from './lsp.mjs';

const IS_WIN = process.platform === 'win32';
const shimName = (bin) => (IS_WIN ? `${bin}.cmd` : bin);

/** Runner that records every call and answers from `answer`, defaulting to exit 0. */
function recordingRunner(answer = () => undefined) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return answer(cmd, args) ?? { code: 0, stdout: `${cmd} 1.2.3\n`, stderr: '' };
  };
  return { run, calls };
}

const isLookup = (cmd) => cmd === 'where' || cmd === 'which';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsp-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installShim(bin) {
  const dir = join(root, 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, shimName(bin));
  writeFileSync(path, '');
  return path;
}

describe('resolveLocalBin', () => {
  it('returns the node_modules/.bin shim when the project installs it', () => {
    const path = installShim('typescript-language-server');
    expect(resolveLocalBin('typescript-language-server', root)).toBe(path);
  });

  it('returns null when the project does not install it', () => {
    expect(resolveLocalBin('typescript-language-server', root)).toBeNull();
  });
});

describe('probeServer bin resolution', () => {
  it('prefers node_modules/.bin over PATH and never looks the bin up on PATH', async () => {
    const path = installShim('typescript-language-server');
    const { run, calls } = recordingRunner();
    const result = await probeServer('web', { run, root });
    expect(result).toMatchObject({ available: true, path });
    expect(calls.some((c) => isLookup(c.cmd))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd.replaceAll('"', '')).toBe(path);
    expect(calls[0]?.args).toEqual(['--version']);
  });

  it('falls back to a PATH lookup and spawns the bare bin when no shim exists', async () => {
    const { run, calls } = recordingRunner((cmd, args) => (isLookup(cmd) ? { code: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: '' } : undefined));
    const result = await probeServer('web', { run, root });
    expect(result).toMatchObject({ available: true, path: 'typescript-language-server', version: 'typescript-language-server 1.2.3' });
    expect(calls.map((c) => c.cmd)).toEqual([IS_WIN ? 'where' : 'which', 'typescript-language-server']);
  });

  it('probes via probeBin but spawns bin, both from node_modules/.bin', async () => {
    installShim('basedpyright');
    const serverPath = installShim('basedpyright-langserver');
    const { run, calls } = recordingRunner();
    const result = await probeServer('python', { run, root });
    expect(result).toMatchObject({ available: true, path: serverPath });
    expect(calls[0]?.cmd.replaceAll('"', '')).toBe(join(root, 'node_modules', '.bin', shimName('basedpyright')));
  });

  it('is unavailable when neither node_modules/.bin nor PATH has the bin', async () => {
    const { run } = recordingRunner((cmd) => (isLookup(cmd) ? { code: 1, stdout: '', stderr: 'not found' } : undefined));
    const result = await probeServer('rust', { run, root });
    expect(result.available).toBe(false);
    expect(result.error).toContain('rust-analyzer not found');
  });

  it('is unavailable when the rustup proxy is on PATH but the component is not installed', async () => {
    const stderr = "error: Unknown binary 'rust-analyzer.exe' in official toolchain 'stable-x86_64-pc-windows-msvc'.\n";
    const { run } = recordingRunner((cmd) =>
      isLookup(cmd) ? { code: 0, stdout: 'C:\\Users\\me\\.cargo\\bin\\rust-analyzer.exe\n', stderr: '' } : { code: 1, stdout: '', stderr }
    );
    const result = await probeServer('rust', { run, root });
    expect(result.available).toBe(false);
    expect(result.error).toContain("Unknown binary 'rust-analyzer.exe'");
  });

  it('is unavailable with a setup hint when the PowerShell Editor Services bundle is missing', async () => {
    const { run } = recordingRunner();
    const result = await probeServer('powershell', { run, root });
    const startScript = join(root, '.local', 'tools', 'PowerShellEditorServices', 'PowerShellEditorServices', 'Start-EditorServices.ps1');
    expect(result).toEqual({
      available: false,
      error: `powershell: PowerShell Editor Services bundle missing at ${startScript} — run .\\lt.ps1 setup`,
    });
  });

  it('locates a server with empty versionArgs without running it', async () => {
    const { run, calls } = recordingRunner((cmd) => (isLookup(cmd) ? { code: 0, stdout: 'C:\\tools\\omnisharp.exe\n', stderr: '' } : undefined));
    const result = await probeServer('csharp', { run, root });
    expect(result).toMatchObject({ available: true, version: 'C:\\tools\\omnisharp.exe' });
    expect(calls.every((c) => isLookup(c.cmd))).toBe(true);
  });
});

describe('classifyVersionRun', () => {
  it('is available with the first output line on exit 0', () => {
    expect(classifyVersionRun({ code: 0, stdout: '\nclangd version 19.1.0\nmore\n', stderr: '' }, 'clangd')).toEqual({
      available: true,
      version: 'clangd version 19.1.0',
    });
  });

  it('is unavailable on a non-zero exit, citing stderr', () => {
    expect(classifyVersionRun({ code: 2, stdout: '', stderr: 'boom\n' }, 'x')).toEqual({ available: false, error: 'x: boom' });
  });

  it('is unavailable when the command could not run', () => {
    expect(classifyVersionRun({ code: null, stdout: '', stderr: '', spawnError: 'spawn x ENOENT' }, 'x')).toEqual({
      available: false,
      error: 'x: spawn x ENOENT',
    });
  });
});
