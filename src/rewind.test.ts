import { describe, expect, it } from 'vitest';
import { isBundleMessage, noteOf, rewindAt, undoRewind } from './rewind';
import type { ImageBlock, Message, Progress } from './types';

const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const bundleWithNote = '[NOTE]\nWhy does this panic?\n\n[CODE]\n```rust\nfn main() {}\n```\n\n[OUTPUT]\n```\n(not run yet)\n```';
const bundleWithoutNote = '[FILES]\n`Program.cs`\n```csharp\nclass P {}\n```\n\n[OUTPUT]\n(process is stopped)';

const before: Progress = { currentTopic: 'ownership', sessionCount: 2 };

function conversation(): Message[] {
  return [
    { role: 'user', content: 'Hello', progressBefore: null },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Explain borrowing', progressBefore: before },
    { role: 'assistant', content: 'Borrowing is…' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'Welcome' },
  ];
}

describe('rewindAt', () => {
  it('removes the target and everything after it', () => {
    const history = conversation();
    const { kept, removed } = rewindAt(history, 2);
    expect(kept).toEqual(history.slice(0, 2));
    expect(removed).toEqual(history.slice(2));
  });

  it("returns the target's progressBefore", () => {
    expect(rewindAt(conversation(), 2).progressBefore).toEqual(before);
    expect(rewindAt(conversation(), 0).progressBefore).toBeNull();
  });

  it('returns undefined for a message without a snapshot, so current progress is kept', () => {
    expect(rewindAt(conversation(), 4).progressBefore).toBeUndefined();
  });
});

describe('isBundleMessage', () => {
  it('is true for evaluate payloads with string content', () => {
    expect(isBundleMessage({ role: 'user', content: bundleWithNote })).toBe(true);
    expect(isBundleMessage({ role: 'user', content: bundleWithoutNote })).toBe(true);
  });

  it('is true for evaluate payloads with block content including an image', () => {
    expect(isBundleMessage({ role: 'user', content: [{ type: 'text', text: bundleWithoutNote }, image] })).toBe(true);
  });

  it('is false for plain text that mentions [NOTE] mid-sentence', () => {
    expect(isBundleMessage({ role: 'user', content: 'What does the [NOTE]\nblock do before [CODE]\nin a bundle?' })).toBe(false);
    expect(isBundleMessage({ role: 'user', content: 'Just a question' })).toBe(false);
  });
});

describe('noteOf', () => {
  it('returns the note text of a string bundle', () => {
    expect(noteOf({ role: 'user', content: bundleWithNote })).toBe('Why does this panic?');
  });

  it('returns the note text of a block bundle with an image', () => {
    expect(noteOf({ role: 'user', content: [{ type: 'text', text: bundleWithNote }, image] })).toBe('Why does this panic?');
  });

  it("returns '' when the bundle has no [NOTE]", () => {
    expect(noteOf({ role: 'user', content: bundleWithoutNote })).toBe('');
  });
});

describe('undoRewind', () => {
  it('restores exactly the removed slice after dropping the new exchange', () => {
    const history = conversation();
    const { kept, removed } = rewindAt(history, 2);
    const afterResend: Message[] = [...kept, { role: 'user', content: 'Explain lifetimes' }, { role: 'assistant', content: 'Lifetimes…' }];
    expect(undoRewind(afterResend, kept.length, removed)).toEqual(history);
  });
});
