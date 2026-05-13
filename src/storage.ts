const STATE_PREFIX = 'lang-tutor:';
const STATE_ENDPOINT = '/state/local-storage';

let remoteStateAvailable = false;

function isMirroredKey(key: string): boolean {
  return key.startsWith(STATE_PREFIX);
}

function collectMirroredEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || !isMirroredKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) {
      entries[key] = value;
    }
  }
  return entries;
}

async function postState(payload: unknown): Promise<void> {
  if (!remoteStateAvailable) return;
  try {
    await fetch(STATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    remoteStateAvailable = false;
  }
}

export async function hydrateStorageFromDisk(): Promise<void> {
  try {
    const response = await fetch(STATE_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = (await response.json()) as { entries?: Record<string, string> };
    remoteStateAvailable = true;

    const entries = payload.entries ?? {};
    for (const [key, value] of Object.entries(entries)) {
      if (isMirroredKey(key) && localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
      }
    }

    await postState({ op: 'bulkSet', entries: collectMirroredEntries() });
  } catch {
    remoteStateAvailable = false;
  }
}

export function storageGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, val: unknown): void {
  try {
    const raw = JSON.stringify(val);
    localStorage.setItem(key, raw);
    if (isMirroredKey(key)) {
      void postState({ op: 'set', key, value: raw });
    }
  } catch {
    // quota exceeded — silently ignore
  }
}

export function storageDelete(key: string): void {
  try {
    localStorage.removeItem(key);
    if (isMirroredKey(key)) {
      void postState({ op: 'delete', key });
    }
  } catch {
    // silently ignore
  }
}
