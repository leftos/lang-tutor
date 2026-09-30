import { describe, expect, it } from 'vitest';
import { resolveConfigurationItems } from './lspClient';

const settings = {
  powershell: {
    codeFormatting: { preset: 'OTBS', openBraceOnSameLine: true, whitespaceBetweenParameters: false },
    scriptAnalysis: { enable: true },
  },
};

describe('resolveConfigurationItems', () => {
  it('returns a top-level section', () => {
    expect(resolveConfigurationItems(settings, [{ section: 'powershell' }])).toEqual([settings.powershell]);
  });

  it('follows a nested dotted path, keeping false values', () => {
    expect(
      resolveConfigurationItems(settings, [
        { section: 'powershell.codeFormatting.preset' },
        { section: 'powershell.codeFormatting.whitespaceBetweenParameters' },
      ])
    ).toEqual(['OTBS', false]);
  });

  it('answers null for a missing section, a path through a scalar, and an item without a section', () => {
    expect(
      resolveConfigurationItems(settings, [
        { section: 'powershell.rename' },
        { section: 'python' },
        { section: 'powershell.codeFormatting.preset.value' },
        { section: 'toString' },
        {},
      ])
    ).toEqual([null, null, null, null, null]);
  });

  it('answers null for every item when the server has no settings', () => {
    expect(resolveConfigurationItems(undefined, [{ section: 'powershell' }, { section: 'python.analysis' }])).toEqual([null, null]);
  });

  it('answers an empty list for no items', () => {
    expect(resolveConfigurationItems(settings, [])).toEqual([]);
  });
});
