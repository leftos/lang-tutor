import { appUrl } from './appUrls';
import { canUseHostedTooling } from './authClient';
import type { RunResult, SingleBufferLanguageId } from './types';

interface RunResponse {
  ok: boolean;
  output?: string;
  error?: string;
}

export async function runLocalSnippet(lang: 'rust' | 'cpp' | 'python' | 'csharp', code: string): Promise<RunResult> {
  if (!canUseHostedTooling()) {
    return { ok: false, output: 'Sign in to run code on the hosted server.' };
  }
  try {
    const r = await fetch(appUrl('/run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, code }),
    });
    const d = (await r.json()) as RunResponse;
    if (!r.ok) {
      return { ok: false, output: d.error ?? `Run request failed (HTTP ${r.status})` };
    }
    return { ok: d.ok, output: d.output ?? '(no output)' };
  } catch {
    return { ok: false, output: 'Could not reach the local run endpoint. Is the dev server running?' };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────
export async function runCode(lang: SingleBufferLanguageId, code: string, onProgress?: (msg: string) => void): Promise<RunResult> {
  switch (lang) {
    case 'rust':
      onProgress?.('Running in local sandbox…');
      return runLocalSnippet('rust', code);
    case 'cpp':
      onProgress?.('Compiling with Clang in local sandbox…');
      return runLocalSnippet('cpp', code);
    case 'python':
      onProgress?.('Running Python in local sandbox…');
      return runLocalSnippet('python', code);
    case 'csharp':
      onProgress?.('Running C# in local sandbox…');
      return runLocalSnippet('csharp', code);
  }
}
