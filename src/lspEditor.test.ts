import { describe, expect, it } from 'vitest';
import { shouldQueryCompletion } from './lspEditor';

describe('shouldQueryCompletion', () => {
  it('does not open on typing with no partial identifier (e.g. right after `;`)', () => {
    expect(shouldQueryCompletion(false, '', undefined)).toBe(false);
  });

  it('opens once a partial identifier is typed', () => {
    expect(shouldQueryCompletion(false, 'va', undefined)).toBe(true);
  });

  it('opens right after a server trigger character such as `.`', () => {
    expect(shouldQueryCompletion(false, '', '.')).toBe(true);
  });

  it('always opens on an explicit request (Ctrl+Space)', () => {
    expect(shouldQueryCompletion(true, '', undefined)).toBe(true);
  });
});
