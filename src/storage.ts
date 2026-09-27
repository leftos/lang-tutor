import { appUrl } from './appUrls';
import { csrfHeader, hasAuthSession, isAuthRequired } from './authClient';
import { ACTIVE_LANG_KEY } from './constants';

const STATE_PREFIX = 'lang-tutor:';
const STATE_ENDPOINT = '/state/local-storage';
const SENSITIVE_KEYS = new Set(['lang-tutor:provider-settings']);

// Bumped by markResetEpoch() after a reset. A second origin still holding the
// erased keys in its localStorage sees a mismatch and adopts the emptied disk
// state instead of re-uploading them.
export const RESET_EPOCH_KEY = 'lang-tutor:reset-epoch';

// Display preferences, not learner state: shared by every origin and kept
// through a reset, including one performed on another origin.
const UI_PREFERENCE_KEYS: ReadonlySet<string> = new Set<string>([
  ACTIVE_LANG_KEY,
  'lang-tutor:theme',
  'lang-tutor:dasm:compiler-flags',
  'lang-tutor:focus-mode',
]);

const NO_KEYS: ReadonlySet<string> = new Set<string>();

let remoteStateAvailable = false;

function isMirroredKey(key: string): boolean {
  return key.startsWith(STATE_PREFIX) && !SENSITIVE_KEYS.has(key);
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
    const response = await fetch(appUrl(STATE_ENDPOINT), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(payload),
    });
    if (!response.ok) remoteStateAvailable = false;
  } catch {
    remoteStateAvailable = false;
  }
}

// Replaces every local mirrored entry with the remote one, sparing `keepKeys`.
function adoptRemoteState(entries: Record<string, string>, keepKeys: ReadonlySet<string>): void {
  for (const key of Object.keys(collectMirroredEntries())) {
    if (!keepKeys.has(key)) localStorage.removeItem(key);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (isMirroredKey(key)) {
      localStorage.setItem(key, value);
    }
  }
}

// True when the disk copy records a reset this origin has not seen.
function resetEpochChanged(entries: Record<string, string>): boolean {
  const remoteEpoch = entries[RESET_EPOCH_KEY];
  if (remoteEpoch === undefined) return false;
  return remoteEpoch !== localStorage.getItem(RESET_EPOCH_KEY);
}

export async function hydrateStorageFromDisk(): Promise<void> {
  const authRequired = isAuthRequired();
  const signedIn = hasAuthSession();
  if (authRequired && !signedIn) {
    remoteStateAvailable = false;
    return;
  }
  try {
    const response = await fetch(appUrl(STATE_ENDPOINT), { cache: 'no-store' });
    if (!response.ok) return;
    const payload = (await response.json()) as { entries?: Record<string, string> };
    remoteStateAvailable = true;

    const entries = payload.entries ?? {};
    const remoteHasState = Object.keys(entries).some(isMirroredKey);

    if (authRequired && signedIn && remoteHasState) {
      adoptRemoteState(entries, NO_KEYS);
    } else if (resetEpochChanged(entries)) {
      adoptRemoteState(entries, UI_PREFERENCE_KEYS);
    } else {
      for (const [key, value] of Object.entries(entries)) {
        if (isMirroredKey(key) && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
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

// Removes the keys locally and waits for the disk mirror to drop them, so a
// caller that reloads right after cannot cancel the deletes in flight.
export async function storageDeleteKeys(keys: readonly string[]): Promise<void> {
  const mirrored: string[] = [];
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // silently ignore
    }
    if (isMirroredKey(key)) mirrored.push(key);
  }
  await Promise.all(mirrored.map((key) => postState({ op: 'delete', key })));
}

// Records that a reset happened, so every other origin hydrates from disk
// instead of restoring the erased keys from its own localStorage.
export async function markResetEpoch(): Promise<void> {
  const epoch = String(Date.now());
  try {
    localStorage.setItem(RESET_EPOCH_KEY, epoch);
  } catch {
    // quota exceeded — the posted epoch still marks the reset for other origins
  }
  await postState({ op: 'set', key: RESET_EPOCH_KEY, value: epoch });
}
