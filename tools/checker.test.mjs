import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkCode, formatCode, parsePowershellOutput } from './checker.mjs';
import { PSSA_MODULE_DIR } from './pses.mjs';

const HAS_PWSH = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
const HAS_PSES = existsSync(PSSA_MODULE_DIR);

describe('parsePowershellOutput', () => {
  it('reads an empty array as no diagnostics', () => {
    expect(parsePowershellOutput('[]\n')).toEqual({ available: true, diagnostics: [] });
  });

  it('passes one diagnostic object through', () => {
    const diagnostic = {
      severity: 'error',
      line: 1,
      column: 10,
      endLine: 1,
      endColumn: 11,
      message: 'Missing function body in function declaration.',
    };
    expect(parsePowershellOutput(`${JSON.stringify([diagnostic])}\n`)).toEqual({ available: true, diagnostics: [diagnostic] });
  });

  it('treats malformed stdout as available with no diagnostics', () => {
    expect(parsePowershellOutput('pwsh: something went wrong')).toEqual({ available: true, diagnostics: [] });
  });
});

describe.skipIf(!HAS_PWSH)('checkCode powershell (needs pwsh on PATH)', () => {
  it('reports a parse error on line 1', async () => {
    const result = await checkCode('powershell', 'function {');
    expect(result.available).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', line: 1 });
  }, 20_000);

  it('widens a zero-width parse error to one column so it underlines', async () => {
    const result = await checkCode('powershell', 'function {');
    const first = result.diagnostics[0];
    expect(first.endLine).toBe(first.line);
    expect(first.endColumn).toBeGreaterThan(first.column);
  }, 20_000);

  it('reports nothing for a valid script', async () => {
    const result = await checkCode('powershell', 'Write-Output 1');
    expect(result).toEqual({ available: true, diagnostics: [] });
  }, 20_000);
});

describe.skipIf(!HAS_PWSH || !HAS_PSES)('formatCode powershell (needs pwsh and the PowerShell Editor Services bundle)', () => {
  it('reindents with Invoke-Formatter', async () => {
    const result = await formatCode('powershell', 'if($true){\nWrite-Output 1}');
    expect(result).toMatchObject({ ok: true, available: true });
    expect(result.code).toContain('if ($true) {');
  }, 20_000);
});
