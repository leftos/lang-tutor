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
