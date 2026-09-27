import { describe, expect, it } from 'vitest';
import { FALLBACK_MODELS, resolveChatModel, resolveMemoryModel } from './modelResolution';
import type { ProviderModel } from './types';

const model = (id: string, createdAt?: string): ProviderModel => (createdAt === undefined ? { id, label: id } : { id, label: id, createdAt });

describe('resolveChatModel — Anthropic', () => {
  it('picks the newest Sonnet by creation time', () => {
    const models = [
      model('claude-sonnet-4-6', '2026-02-17T00:00:00Z'),
      model('claude-sonnet-5', '2026-08-01T00:00:00Z'),
      model('claude-opus-5', '2026-09-01T00:00:00Z'),
      model('claude-haiku-4-5', '2025-10-01T00:00:00Z'),
    ];
    expect(resolveChatModel('anthropic', models)).toBe('claude-sonnet-5');
  });

  it('falls back to the version in the id when timestamps are missing', () => {
    const models = [model('claude-sonnet-4-5-20250929'), model('claude-sonnet-5'), model('claude-sonnet-4-6')];
    expect(resolveChatModel('anthropic', models)).toBe('claude-sonnet-5');
  });

  it('orders 4-6 above a dated 4-5 and above the legacy 4 snapshot when timestamps tie', () => {
    const at = '2026-01-01T00:00:00Z';
    const models = [model('claude-sonnet-4-20250601', at), model('claude-sonnet-4-5-20250929', at), model('claude-sonnet-4-6', at)];
    expect(resolveChatModel('anthropic', models)).toBe('claude-sonnet-4-6');
  });

  it('ignores models that are not Sonnet, including old claude-3-x-sonnet ids', () => {
    const models = [model('claude-3-7-sonnet-20250219', '2027-01-01T00:00:00Z'), model('claude-sonnet-4-6', '2026-02-17T00:00:00Z')];
    expect(resolveChatModel('anthropic', models)).toBe('claude-sonnet-4-6');
  });

  it('falls back to the pinned Sonnet with no list or no match', () => {
    expect(resolveChatModel('anthropic', null)).toBe(FALLBACK_MODELS.anthropic.chat);
    expect(resolveChatModel('anthropic', [])).toBe('claude-sonnet-5');
    expect(resolveChatModel('anthropic', [model('claude-opus-5')])).toBe('claude-sonnet-5');
  });
});

describe('resolveChatModel — OpenAI', () => {
  it('picks the newest dateless mini by version when timestamps are missing', () => {
    const models = [model('gpt-5.4-mini'), model('gpt-5.6-mini'), model('gpt-5-mini'), model('gpt-5.6')];
    expect(resolveChatModel('openai', models)).toBe('gpt-5.6-mini');
  });

  it('never picks a dated snapshot, even one newer by creation time', () => {
    const models = [model('gpt-5-mini', '2025-08-07T00:00:00Z'), model('gpt-5-mini-2025-08-07', '2025-08-08T00:00:00Z')];
    expect(resolveChatModel('openai', models)).toBe('gpt-5-mini');
  });

  it('never picks audio, realtime, search, transcribe or tts variants', () => {
    const late = '2027-01-01T00:00:00Z';
    const models = [
      model('gpt-5.4-mini-audio', late),
      model('gpt-5.4-mini-realtime', late),
      model('gpt-5.4-mini-search', late),
      model('gpt-5.4-mini-transcribe', late),
      model('gpt-5.4-mini-tts', late),
      model('gpt-5.4-mini', '2026-03-01T00:00:00Z'),
    ];
    expect(resolveChatModel('openai', models)).toBe('gpt-5.4-mini');
  });

  it('prefers the later creation time over a higher version number', () => {
    const models = [
      model('gpt-5.6-mini', '2026-05-01T00:00:00Z'),
      model('gpt-6-mini', '2026-09-01T00:00:00Z'),
      model('gpt-5.8-mini', '2026-07-01T00:00:00Z'),
    ];
    expect(resolveChatModel('openai', models)).toBe('gpt-6-mini');
  });

  it('falls back to the pinned mini with no list or no match', () => {
    expect(resolveChatModel('openai', null)).toBe('gpt-5.4-mini');
    expect(resolveChatModel('openai', [model('gpt-5.4'), model('gpt-5.4-mini-2026-03-01')])).toBe('gpt-5.4-mini');
  });
});

describe('resolveChatModel — Gemini', () => {
  it('always uses gemini-flash-latest and never looks at the list', () => {
    expect(resolveChatModel('gemini', [model('gemini-3.8-flash', '2027-01-01T00:00:00Z'), model('gemini-2.5-flash')])).toBe('gemini-flash-latest');
    expect(resolveChatModel('gemini', null)).toBe('gemini-flash-latest');
  });
});

describe('resolveMemoryModel', () => {
  it('Anthropic: picks the newest Haiku', () => {
    const models = [model('claude-haiku-4-5', '2025-10-01T00:00:00Z'), model('claude-haiku-5', '2026-10-01T00:00:00Z'), model('claude-sonnet-5')];
    expect(resolveMemoryModel('anthropic', models, 'claude-sonnet-5')).toBe('claude-haiku-5');
  });

  it('Anthropic: with no Haiku in the list, resolves to the newest Sonnet', () => {
    const models = [model('claude-sonnet-4-6', '2026-02-17T00:00:00Z'), model('claude-sonnet-5', '2026-08-01T00:00:00Z')];
    expect(resolveMemoryModel('anthropic', models, 'claude-opus-5')).toBe('claude-sonnet-5');
  });

  it('Anthropic: falls back to the pinned Haiku with no list, an empty list, or neither family present', () => {
    expect(resolveMemoryModel('anthropic', null, 'claude-sonnet-5')).toBe(FALLBACK_MODELS.anthropic.memory);
    expect(resolveMemoryModel('anthropic', [], 'claude-sonnet-5')).toBe('claude-haiku-4-5');
    expect(resolveMemoryModel('anthropic', [model('claude-opus-5')], 'claude-opus-5')).toBe('claude-haiku-4-5');
  });

  it('OpenAI: uses the chat model in use', () => {
    expect(resolveMemoryModel('openai', [model('gpt-5.6-mini')], 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(resolveMemoryModel('openai', null, 'gpt-5.4')).toBe('gpt-5.4');
  });

  it('Gemini: uses the chat model in use and never looks at the list', () => {
    expect(resolveMemoryModel('gemini', [model('gemini-3.8-flash')], 'gemini-flash-latest')).toBe('gemini-flash-latest');
    expect(resolveMemoryModel('gemini', null, 'gemini-flash-latest')).toBe('gemini-flash-latest');
  });
});
