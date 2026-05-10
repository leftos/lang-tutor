/**
 * Glue between LspClient and CodeMirror 6: position converters, diagnostic
 * mappers, and extension factories for hover / completion / view-plugin sync.
 *
 * Imports stay tight: lspClient.ts knows nothing about CodeMirror; this file
 * knows about both.
 */

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { type Diagnostic, setDiagnostics } from '@codemirror/lint';
import type { EditorState } from '@codemirror/state';
import { EditorView, hoverTooltip, type Tooltip, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { LspClient, LspDiagnostic, LspHover, LspPosition, LspSeverity } from './lspClient';

// ── Position / range converters (LSP uses UTF-16 offsets, matching JS strings) ─

export function offsetToLspPosition(state: EditorState, offset: number): LspPosition {
  const line = state.doc.lineAt(Math.max(0, Math.min(offset, state.doc.length)));
  return { line: line.number - 1, character: offset - line.from };
}

export function lspPositionToOffset(state: EditorState, pos: LspPosition): number {
  if (pos.line < 0) return 0;
  if (pos.line >= state.doc.lines) return state.doc.length;
  const line = state.doc.line(pos.line + 1);
  return line.from + Math.min(line.length, Math.max(0, pos.character));
}

// ── Diagnostic mapping ──────────────────────────────────────────────────────

function severityToCm(severity?: LspSeverity): Diagnostic['severity'] {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
    case 4:
      return 'info';
    default:
      return 'info';
  }
}

export function lspToCmDiagnostic(state: EditorState, d: LspDiagnostic): Diagnostic {
  const from = lspPositionToOffset(state, d.range.start);
  const rawTo = lspPositionToOffset(state, d.range.end);
  const to = Math.max(from + 1, Math.min(state.doc.length, rawTo));
  const prefix = d.source !== undefined && d.source.length > 0 ? `${d.source}: ` : '';
  return {
    from,
    to,
    severity: severityToCm(d.severity),
    message: prefix + d.message,
  };
}

/**
 * Push the latest LSP diagnostics into the CodeMirror lint extension. Call
 * from the LSP client's onDiagnostics listener.
 */
export function applyLspDiagnostics(view: EditorView, diagnostics: LspDiagnostic[]): void {
  const cmDiags = diagnostics.map((d) => lspToCmDiagnostic(view.state, d));
  view.dispatch(setDiagnostics(view.state, cmDiags));
}

// ── Hover ───────────────────────────────────────────────────────────────────

function renderHoverContents(contents: LspHover['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n');
  }
  return contents.value;
}

export function lspHoverExtension(getClient: () => LspClient | null) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const client = getClient();
    if (client === null || !client.isOpen()) return null;
    const lspPos = offsetToLspPosition(view.state, pos);
    const result = await client.hover(lspPos.line, lspPos.character);
    if (result === null || result === undefined) return null;
    const text = renderHoverContents(result.contents).trim();
    if (text.length === 0) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-tooltip-cursor lsp-hover';
        // Tooltip content is plaintext (or markdown converted to text). We never
        // inject HTML — textContent is XSS-safe by construction.
        dom.textContent = text;
        dom.style.padding = '6px 9px';
        dom.style.maxWidth = '60ch';
        dom.style.whiteSpace = 'pre-wrap';
        dom.style.fontFamily = 'var(--font-mono)';
        dom.style.fontSize = '12px';
        return { dom };
      },
    };
  });
}

// ── Completion ──────────────────────────────────────────────────────────────

// LSP CompletionItemKind → CodeMirror autocomplete type tag (used for icons).
const KIND_TO_TYPE: Record<number, string> = {
  1: 'text', // Text
  2: 'method',
  3: 'function',
  4: 'function', // Constructor
  5: 'property', // Field
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'namespace',
  10: 'property',
  11: 'type', // Unit
  12: 'constant', // Value
  13: 'enum',
  14: 'keyword',
  15: 'text', // Snippet
  16: 'constant', // Color
  17: 'text', // File
  18: 'text', // Reference
  19: 'namespace', // Folder
  20: 'enum', // EnumMember
  21: 'constant',
  22: 'class', // Struct
  23: 'keyword', // Event
  24: 'method', // Operator
  25: 'type', // TypeParameter
};

export function lspCompletionExtension(getClient: () => LspClient | null) {
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const client = getClient();
    if (client === null || !client.isOpen()) return null;

    // Determine trigger character (e.g., `.` after object → member completion).
    let triggerCharacter: string | undefined;
    if (context.pos > 0) {
      const before = context.state.doc.sliceString(context.pos - 1, context.pos);
      const triggers = client.capabilities.completionProvider?.triggerCharacters ?? [];
      if (triggers.includes(before)) triggerCharacter = before;
    }

    const lspPos = offsetToLspPosition(context.state, context.pos);
    const result = await client.completion(lspPos.line, lspPos.character, triggerCharacter);
    if (result === null || result.items.length === 0) return null;

    // CodeMirror uses `from` = the start of the prefix being replaced.
    const word = context.matchBefore(/[\w$_]*/);
    const from = word !== null ? word.from : context.pos;

    return {
      from,
      options: result.items.map((item) => {
        const info =
          item.documentation === undefined ? undefined : typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
        return {
          label: item.label,
          type: item.kind !== undefined ? (KIND_TO_TYPE[item.kind] ?? 'variable') : 'variable',
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
          ...(info !== undefined ? { info } : {}),
          apply: item.insertText ?? item.label,
        };
      }),
      validFor: /^[\w$_]*$/,
    };
  };
  return autocompletion({ override: [source] });
}

// ── Doc-sync ViewPlugin ─────────────────────────────────────────────────────

/**
 * ViewPlugin that mirrors editor doc changes into LSP textDocument/didChange.
 * Returns nothing; the plugin self-registers when added to the editor's
 * extension list.
 */
export function lspDocSyncExtension(getClient: () => LspClient | null) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        const client = getClient();
        if (client === null || !client.isOpen()) return;
        client.didChange(update.state.doc.toString());
      }
    }
  );
}

// ── Re-export for editor.ts convenience ─────────────────────────────────────

export { EditorView };
