/**
 * Frontend client for project-language backend endpoints (/fs/* and /proj/*).
 *
 * Mirrors the supervisor in tools/projects.mjs: file CRUD lives on disk; this
 * module just fetches and posts. All errors surface as thrown exceptions so
 * call sites can decide whether to retry, fall back, or bubble up.
 */

import type { FsTreeResponse, LanguageId } from './types';

interface ScaffoldResponse {
  readonly root: string;
  readonly created: readonly string[];
}

interface ProjectStatus {
  readonly running: boolean;
  readonly ready: boolean;
  readonly phase: string;
  readonly vitePort: number;
  readonly error: string | null;
}

interface StartResponse {
  readonly ok: boolean;
  readonly vitePort?: number;
  readonly ready?: boolean;
  readonly error?: string;
}

interface StopResponse {
  readonly ok: boolean;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

export async function ensureScaffold(lang: LanguageId): Promise<ScaffoldResponse> {
  const response = await fetch(`/proj/scaffold?lang=${encodeURIComponent(lang)}`, { method: 'POST' });
  if (!response.ok) throw new Error(`/proj/scaffold → ${response.status}`);
  return (await response.json()) as ScaffoldResponse;
}

export async function fetchTree(lang: LanguageId): Promise<FsTreeResponse> {
  return postJson('/fs/list', { lang });
}

export async function fetchFile(lang: LanguageId, path: string): Promise<string> {
  const result = await postJson<{ content: string }>('/fs/read', { lang, path });
  return result.content;
}

export async function writeFile(lang: LanguageId, path: string, content: string): Promise<void> {
  await postJson<{ ok: boolean }>('/fs/write', { lang, path, content });
}

export async function renameFile(lang: LanguageId, from: string, to: string): Promise<void> {
  await postJson<{ ok: boolean }>('/fs/rename', { lang, from, to });
}

export async function deleteFile(lang: LanguageId, path: string): Promise<void> {
  await postJson<{ ok: boolean }>('/fs/delete', { lang, path });
}

export async function mkdir(lang: LanguageId, path: string): Promise<void> {
  await postJson<{ ok: boolean }>('/fs/mkdir', { lang, path });
}

export async function startProject(lang: LanguageId): Promise<StartResponse> {
  return postJson('/proj/start', { lang });
}

export async function stopProject(lang: LanguageId): Promise<StopResponse> {
  return postJson('/proj/stop', { lang });
}

export async function getStatus(lang: LanguageId): Promise<ProjectStatus> {
  return getJson(`/proj/status?lang=${encodeURIComponent(lang)}`);
}

/** Walk the tree depth-first and return all file paths (no directories). */
export function flattenFiles(node: import('./types').FsNode | null): string[] {
  if (node === null) return [];
  const out: string[] = [];
  const visit = (n: import('./types').FsNode): void => {
    if (n.type === 'file') {
      out.push(n.path);
    } else {
      for (const child of n.children) visit(child);
    }
  };
  visit(node);
  return out;
}

export type FsWatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'ready' | 'error';

export interface FsWatchEvent {
  readonly type: FsWatchEventType;
  readonly path?: string;
  readonly message?: string;
}

export interface ProjectLogEntry {
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly line: string;
  readonly ts: number;
}

/**
 * Open an SSE connection to /fs/watch?lang=… and call onEvent for each event.
 * The connection auto-reconnects on disconnect (EventSource behavior).
 * Returns a function that closes the EventSource.
 */
export function subscribeFsEvents(lang: LanguageId, onEvent: (event: FsWatchEvent) => void): () => void {
  const url = `/fs/watch?lang=${encodeURIComponent(lang)}`;
  const source = new EventSource(url);

  source.addEventListener('message', (e) => {
    try {
      onEvent(JSON.parse(e.data) as FsWatchEvent);
    } catch {
      // ignore malformed events
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; surface the connection state but don't
    // tear down — the SSE client will retry.
    onEvent({ type: 'error', message: 'fs-watch connection error (auto-retrying)' });
  });

  return () => source.close();
}

export async function fetchRecentLogs(lang: LanguageId, n: number): Promise<{ lines: ProjectLogEntry[] }> {
  return getJson(`/proj/logs/recent?lang=${encodeURIComponent(lang)}&n=${n}`);
}

/**
 * Open an SSE connection to /proj/logs?lang=… and call onEntry for each log line.
 * The server sends recent buffered logs first, then live log lines as they arrive.
 */
export function subscribeProjectLogs(lang: LanguageId, onEntry: (entry: ProjectLogEntry) => void): () => void {
  const url = `/proj/logs?lang=${encodeURIComponent(lang)}`;
  const source = new EventSource(url);

  source.addEventListener('message', (e) => {
    try {
      onEntry(JSON.parse(e.data) as ProjectLogEntry);
    } catch {
      // ignore malformed events
    }
  });

  return () => source.close();
}
