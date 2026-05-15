import type { Diagnostic } from '@codemirror/lint';
import type { EditorState } from '@codemirror/state';
import { appUrl } from './appUrls';
import { canUseHostedTooling } from './authClient';
import type { LanguageId } from './types';

interface BackendDiagnostic {
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
}

interface CheckResponse {
  available: boolean;
  diagnostics: BackendDiagnostic[];
}

interface FormatResponse {
  ok: boolean;
  available?: boolean;
  code?: string;
  error?: string;
}

// Cache toolchain availability per language so we don't keep poking when something
// isn't installed. Reset is via reload — installing a toolchain mid-session is rare.
const unavailable = new Set<LanguageId>();

/**
 * Convert a 1-based (line, column) into an absolute document offset.
 * Out-of-range coords clamp to the document end.
 */
function lineColToPos(state: EditorState, line: number, col: number): number {
  if (line < 1) return 0;
  if (line > state.doc.lines) return state.doc.length;
  const lineObj = state.doc.line(line);
  const offset = Math.max(0, Math.min(col - 1, lineObj.length));
  return lineObj.from + offset;
}

/**
 * Fetch diagnostics from the backend for the given language and document.
 * Returns CodeMirror's Diagnostic[] ready to feed to the lint extension.
 * Returns [] silently if the toolchain is unavailable.
 */
export async function fetchDiagnostics(lang: LanguageId, state: EditorState): Promise<Diagnostic[]> {
  if (!canUseHostedTooling()) return [];
  if (unavailable.has(lang)) return [];
  const code = state.doc.toString();
  if (!code.trim()) return [];

  let response: Response;
  try {
    response = await fetch(appUrl('/check'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, code }),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  let data: CheckResponse;
  try {
    data = (await response.json()) as CheckResponse;
  } catch {
    return [];
  }

  if (!data.available) {
    if (!unavailable.has(lang)) {
      console.info(`[lint] live error checking unavailable for ${lang} — install the toolchain to enable.`);
      unavailable.add(lang);
    }
    return [];
  }

  return data.diagnostics.map((d) => {
    const from = lineColToPos(state, d.line, d.column);
    const to =
      d.endLine !== undefined && d.endColumn !== undefined
        ? Math.max(from + 1, lineColToPos(state, d.endLine, d.endColumn))
        : Math.min(state.doc.length, from + 1);
    return {
      from,
      to,
      severity: d.severity,
      message: d.message,
    };
  });
}

/**
 * Format the current document via the backend. Returns the formatted code, or
 * null if the formatter is unavailable / failed (caller should leave content untouched).
 */
export async function fetchFormatted(lang: LanguageId, code: string): Promise<string | null> {
  if (!canUseHostedTooling()) return null;
  let response: Response;
  try {
    response = await fetch(appUrl('/format'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, code }),
    });
  } catch (e) {
    console.warn('[format] request failed:', e);
    return null;
  }
  if (!response.ok) return null;
  const data = (await response.json()) as FormatResponse;
  if (data.ok && typeof data.code === 'string') return data.code;
  if (data.available === false) {
    console.info(`[format] formatter unavailable for ${lang}.`);
  } else if (data.error) {
    console.warn(`[format] ${lang} failed:`, data.error);
  }
  return null;
}
