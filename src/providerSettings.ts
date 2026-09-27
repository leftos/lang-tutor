import { resolveChatModel, resolveMemoryModel } from './modelResolution';
import { storageGet, storageSet } from './storage';
import type { AiProvider, CachedModelList, ProviderConfig, ProviderEntry, ProviderModel, ProviderSettings } from './types';

export const PROVIDER_SETTINGS_KEY = 'lang-tutor:provider-settings';

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI ChatGPT',
  gemini: 'Google Gemini',
};

/** The Anthropic default the app used to hard-code; a stored model equal to it migrates to Auto. */
const LEGACY_DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** A cached model list older than this is refreshed in the background at load. */
const MODEL_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let sessionOnlyKeys: Partial<Record<AiProvider, string>> = {};

const PROVIDER_IDS: readonly AiProvider[] = ['anthropic', 'openai', 'gemini'] as const;

function normalizeProvider(value: unknown): AiProvider {
  return PROVIDER_IDS.includes(value as AiProvider) ? (value as AiProvider) : 'anthropic';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const openAiTextModel = (id: string): boolean => {
  if (id.startsWith('ft:gpt-')) return true;
  if (/^(gpt|o)\d/i.test(id)) return true;
  if (id.startsWith('chatgpt-')) return true;
  return false;
};

const notOpenAiSpecialPurpose = (id: string): boolean =>
  !['audio', 'babbage', 'codex', 'dall-e', 'embedding', 'image', 'moderation', 'realtime', 'search', 'sora', 'tts', 'transcribe', 'whisper'].some(
    (needle) => id.toLowerCase().includes(needle)
  );

/** OpenAI reports `created` in Unix seconds. */
function openAiModelFromRow(row: Record<string, unknown>): ProviderModel | null {
  const id = asString(row.id);
  if (id === null) return null;
  return typeof row.created === 'number' && Number.isFinite(row.created)
    ? { id, label: id, createdAt: new Date(row.created * 1000).toISOString() }
    : { id, label: id };
}

function compactText(value: string, maxLength = 700): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}...` : compacted;
}

function redactSensitiveText(value: string, apiKey: string): string {
  let redacted = value;
  if (apiKey.length >= 8) {
    redacted = redacted.replaceAll(apiKey, '[redacted API key]');
  }
  redacted = redacted.replace(/\b(sk|sk-ant|AIza)[A-Za-z0-9._-]{12,}\b/g, '[redacted API key]');
  redacted = redacted.replace(/\b(api[-_ ]?key|bearer|authorization)\s*[:=]\s*[A-Za-z0-9._-]{12,}\b/gi, '$1: [redacted]');
  return redacted;
}

function errorDetailParts(value: Record<string, unknown>): string[] {
  const parts = [asString(value.message), asString(value.type), asString(value.code), asString(value.status), asString(value.param)].filter(
    (part): part is string => part !== null
  );
  const unique = new Set<string>();
  return parts.filter((part) => {
    if (unique.has(part)) return false;
    unique.add(part);
    return true;
  });
}

function providerErrorDetails(body: unknown, rawBody: string): string | null {
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (isRecord(error)) {
      const detail = errorDetailParts(error).join(' ');
      if (detail) return detail;
    }

    const detail = errorDetailParts(body).join(' ');
    if (detail) return detail;
  }

  const raw = compactText(rawBody);
  return raw || null;
}

function formatProviderHttpError(provider: AiProvider, response: Response, body: unknown, rawBody: string, apiKey: string): string {
  const statusText = response.statusText.trim();
  const status = statusText ? `${response.status} ${statusText}` : String(response.status);
  const detail = providerErrorDetails(body, rawBody);
  const suffix = detail ? `: ${redactSensitiveText(compactText(detail), apiKey)}` : '.';
  return `${PROVIDER_LABELS[provider]} model list failed (HTTP ${status})${suffix}`;
}

function fetchNetworkErrorMessage(provider: AiProvider, endpoint: string, error: unknown, apiKey: string): string {
  const host = new URL(endpoint).hostname;
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'The browser did not expose a detailed network error.';
  return (
    `${PROVIDER_LABELS[provider]} model list could not be reached (${redactSensitiveText(compactText(detail), apiKey)}). ` +
    `The browser could not connect to ${host}; DevTools Network may show a lower-level reason such as ERR_CONNECTION_RESET. ` +
    'Check VPN, firewall, browser extension, or corporate network rules, then try another browser or network.'
  );
}

async function fetchProviderJson(provider: AiProvider, endpoint: string, init: RequestInit, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch (error) {
    console.warn(`[provider-models] ${PROVIDER_LABELS[provider]} network failure`, error);
    throw new Error(fetchNetworkErrorMessage(provider, endpoint, error, apiKey), { cause: error });
  }

  if (!response.ok) {
    let rawBody = '';
    let body: unknown = null;
    try {
      rawBody = await response.text();
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    throw new Error(formatProviderHttpError(provider, response, body, rawBody, apiKey));
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`${PROVIDER_LABELS[provider]} returned a model list response that was not valid JSON (${compactText(detail)}).`, {
      cause: error,
    });
  }
}

function uniqueSortedModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  return models
    .filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' }));
}

export function defaultProviderSettings(): ProviderSettings {
  return {
    activeProvider: 'anthropic',
    rememberKeys: true,
    providers: {
      anthropic: { model: '' },
      openai: { model: '' },
      gemini: { model: '' },
    },
  };
}

function parseCachedModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (id === null) return null;
  const label = asString(value.label) ?? id;
  const createdAt = asString(value.createdAt);
  return createdAt === null ? { id, label } : { id, label, createdAt };
}

function parseCachedModelList(value: unknown): CachedModelList | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const fetchedAt = asString(value.fetchedAt);
  if (fetchedAt === null) return null;
  const models = value.models.map(parseCachedModel).filter((model): model is ProviderModel => model !== null);
  return { fetchedAt, models };
}

function parseProviderEntry(candidate: Record<string, unknown>): ProviderEntry {
  const stored = asString(candidate.model) ?? '';
  const entry: ProviderEntry = { model: stored === LEGACY_DEFAULT_MODEL ? '' : stored };
  if (typeof candidate.apiKey === 'string' && candidate.apiKey) entry.apiKey = candidate.apiKey;
  const modelList = parseCachedModelList(candidate.modelList);
  if (modelList !== null) entry.modelList = modelList;
  return entry;
}

export function loadProviderSettings(): ProviderSettings {
  const raw = storageGet<Partial<ProviderSettings>>(PROVIDER_SETTINGS_KEY);
  const defaults = defaultProviderSettings();
  if (raw === null) return defaults;

  const activeProvider = normalizeProvider(raw.activeProvider);
  const rememberKeys = typeof raw.rememberKeys === 'boolean' ? raw.rememberKeys : defaults.rememberKeys;

  const providers = { ...defaults.providers };
  if (raw.providers && typeof raw.providers === 'object') {
    for (const provider of PROVIDER_IDS) {
      const candidate: unknown = raw.providers[provider];
      if (!isRecord(candidate)) continue;
      providers[provider] = parseProviderEntry(candidate);
    }
  }

  return { activeProvider, rememberKeys, providers };
}

export function saveProviderSettings(settings: ProviderSettings): void {
  const persisted: ProviderSettings = {
    ...settings,
    providers: {
      anthropic: { ...settings.providers.anthropic },
      openai: { ...settings.providers.openai },
      gemini: { ...settings.providers.gemini },
    },
  };

  if (!persisted.rememberKeys) {
    const nextSessionKeys: Partial<Record<AiProvider, string>> = {};
    for (const provider of PROVIDER_IDS) {
      const apiKey = persisted.providers[provider].apiKey ?? sessionOnlyKeys[provider];
      if (apiKey !== undefined) nextSessionKeys[provider] = apiKey;
    }
    sessionOnlyKeys = nextSessionKeys;
    for (const provider of PROVIDER_IDS) {
      delete persisted.providers[provider].apiKey;
    }
  }

  storageSet(PROVIDER_SETTINGS_KEY, persisted);
}

export function readProviderKey(provider: AiProvider): string {
  const settings = loadProviderSettings();
  return settings.providers[provider].apiKey ?? sessionOnlyKeys[provider] ?? '';
}

export function resolveProviderConfig(): ProviderConfig | null {
  const settings = loadProviderSettings();
  const provider = settings.activeProvider;
  const providerSettings = settings.providers[provider];
  const apiKey = (providerSettings.apiKey ?? sessionOnlyKeys[provider] ?? '').trim();
  if (!apiKey) return null;
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    model: providerSettings.model.trim() || resolveChatModel(provider, cachedProviderModels(provider)),
    apiKey,
  };
}

/** The provider's model list as last fetched, or `null` when none is cached. */
export function cachedProviderModels(provider: AiProvider): ProviderModel[] | null {
  return loadProviderSettings().providers[provider].modelList?.models ?? null;
}

/** The model the per-turn memory extraction runs on for this chat configuration. */
export function resolveProviderMemoryModel(config: ProviderConfig): string {
  return resolveMemoryModel(config.provider, cachedProviderModels(config.provider), config.model);
}

/** Stores a freshly fetched model list for the provider, stamped with the current time. */
export function storeProviderModels(provider: AiProvider, models: readonly ProviderModel[]): void {
  const settings = loadProviderSettings();
  settings.providers[provider] = { ...settings.providers[provider], modelList: { fetchedAt: new Date().toISOString(), models: [...models] } };
  saveProviderSettings(settings);
}

function isModelListStale(list: CachedModelList | undefined, now: number): boolean {
  if (list === undefined) return true;
  const fetchedAt = Date.parse(list.fetchedAt);
  return Number.isNaN(fetchedAt) || now - fetchedAt > MODEL_LIST_MAX_AGE_MS;
}

/**
 * Refreshes the active provider's cached model list when it is missing or older than 24 hours and a key is
 * present. A failure is logged and the previous cache kept.
 */
export async function refreshStaleProviderModels(): Promise<void> {
  const settings = loadProviderSettings();
  const provider = settings.activeProvider;
  const apiKey = readProviderKey(provider).trim();
  if (!apiKey || !isModelListStale(settings.providers[provider].modelList, Date.now())) return;
  try {
    storeProviderModels(provider, await fetchProviderModels(provider, apiKey));
  } catch (error) {
    console.warn(`[provider-models] Background refresh of the ${PROVIDER_LABELS[provider]} model list failed; keeping the cached list.`, error);
  }
}

export function providerSetupUrl(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'https://console.anthropic.com/settings/keys';
    case 'openai':
      return 'https://platform.openai.com/api-keys';
    case 'gemini':
      return 'https://aistudio.google.com/apikey';
  }
}

export async function fetchProviderModels(provider: AiProvider, apiKey: string): Promise<ProviderModel[]> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('Paste an API key before loading models.');

  switch (provider) {
    case 'anthropic': {
      const body = await fetchProviderJson(
        provider,
        'https://api.anthropic.com/v1/models',
        {
          headers: {
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'x-api-key': trimmedKey,
          },
        },
        trimmedKey
      );
      const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      return uniqueSortedModels(
        rows
          .filter(isRecord)
          .map((row) => {
            const id = asString(row.id);
            if (!id) return null;
            const displayName = asString(row.display_name);
            const label = displayName ? `${displayName} (${id})` : id;
            const createdAt = asString(row.created_at);
            return createdAt === null ? { id, label } : { id, label, createdAt };
          })
          .filter((model): model is ProviderModel => model !== null)
      );
    }
    case 'openai': {
      const body = await fetchProviderJson(
        provider,
        'https://api.openai.com/v1/models',
        {
          headers: { Authorization: `Bearer ${trimmedKey}` },
        },
        trimmedKey
      );
      const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      return uniqueSortedModels(
        rows
          .filter(isRecord)
          .map(openAiModelFromRow)
          .filter((model): model is ProviderModel => model !== null && openAiTextModel(model.id) && notOpenAiSpecialPurpose(model.id))
      );
    }
    case 'gemini': {
      const body = await fetchProviderJson(
        provider,
        'https://generativelanguage.googleapis.com/v1beta/models',
        {
          headers: { 'x-goog-api-key': trimmedKey },
        },
        trimmedKey
      );
      const rows = isRecord(body) && Array.isArray(body.models) ? body.models : [];
      return uniqueSortedModels(
        rows
          .filter(isRecord)
          .filter((row) => Array.isArray(row.supportedGenerationMethods) && row.supportedGenerationMethods.includes('generateContent'))
          .map((row) => {
            const rawName = asString(row.name);
            if (!rawName) return null;
            const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
            const displayName = asString(row.displayName);
            return { id, label: displayName ? `${displayName} (${id})` : id };
          })
          .filter((model): model is ProviderModel => model !== null)
      );
    }
  }
}
