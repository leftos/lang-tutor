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
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // quota exceeded — silently ignore
  }
}

export function storageDelete(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // silently ignore
  }
}
