import type { AiProvider, ProviderModel } from './types';

export interface ModelPair {
  readonly chat: string;
  readonly memory: string;
}

/** Pinned models used when no live model list is cached or the list has no match. */
export const FALLBACK_MODELS: Record<AiProvider, ModelPair> = {
  anthropic: { chat: 'claude-sonnet-5', memory: 'claude-haiku-4-5' },
  openai: { chat: 'gpt-5.4-mini', memory: 'gpt-5.4-mini' },
  gemini: { chat: 'gemini-flash-latest', memory: 'gemini-flash-latest' },
};

const ANTHROPIC_SONNET = /^claude-sonnet-\d/;
const ANTHROPIC_HAIKU = /^claude-haiku-\d/;
/** Dateless `gpt-<n>-mini` / `gpt-<n>.<m>-mini` only: dated snapshots and -audio/-realtime/-search/-tts variants never match. */
const OPENAI_MINI = /^gpt-\d+(\.\d+)?-mini$/;

/** Digit groups of 8 or more are release dates (`20250929`); shorter groups are version numbers. */
interface ParsedVersion {
  readonly parts: readonly number[];
  readonly date: number;
}

function parseVersion(id: string): ParsedVersion {
  const parts: number[] = [];
  let date = 0;
  for (const token of id.match(/\d+/g) ?? []) {
    if (token.length >= 8) date = Number(token);
    else parts.push(Number(token));
  }
  return { parts, date };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.parts[i] ?? -1) - (b.parts[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.date - b.date;
}

function timestamp(model: ProviderModel): number {
  return model.createdAt === undefined ? Number.NaN : Date.parse(model.createdAt);
}

/** Positive when `left` is newer: by release timestamp when both have distinct ones, else by the version in the id. */
function compareNewest(left: ProviderModel, right: ProviderModel): number {
  const a = timestamp(left);
  const b = timestamp(right);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a - b;
  return compareVersions(left.id, right.id);
}

function newestMatching(models: readonly ProviderModel[] | null, pattern: RegExp): string | null {
  let best: ProviderModel | null = null;
  for (const model of models ?? []) {
    if (!pattern.test(model.id)) continue;
    if (best === null || compareNewest(model, best) > 0) best = model;
  }
  return best === null ? null : best.id;
}

/**
 * The chat model Auto stands for: newest Sonnet (Anthropic), newest dateless `gpt-<n>-mini` (OpenAI),
 * `gemini-flash-latest` (Gemini, which never consults the list). Falls back to {@link FALLBACK_MODELS}.
 */
export function resolveChatModel(provider: AiProvider, models: readonly ProviderModel[] | null): string {
  switch (provider) {
    case 'anthropic':
      return newestMatching(models, ANTHROPIC_SONNET) ?? FALLBACK_MODELS.anthropic.chat;
    case 'openai':
      return newestMatching(models, OPENAI_MINI) ?? FALLBACK_MODELS.openai.chat;
    case 'gemini':
      return FALLBACK_MODELS.gemini.chat;
  }
}

/**
 * The model for the per-turn memory extraction: newest Haiku, else newest Sonnet, else the pinned Haiku
 * (Anthropic); the chat model in use (OpenAI, Gemini).
 */
export function resolveMemoryModel(provider: AiProvider, models: readonly ProviderModel[] | null, chatModel: string): string {
  switch (provider) {
    case 'anthropic':
      return newestMatching(models, ANTHROPIC_HAIKU) ?? newestMatching(models, ANTHROPIC_SONNET) ?? FALLBACK_MODELS.anthropic.memory;
    case 'openai':
    case 'gemini':
      return chatModel;
  }
}
