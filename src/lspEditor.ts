/**
 * Glue between LspClient and CodeMirror 6: position converters, diagnostic
 * mappers, and extension factories for hover / completion / view-plugin sync.
 *
 * Imports stay tight: lspClient.ts knows nothing about CodeMirror; this file
 * knows about both.
 */

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { type Diagnostic, setDiagnostics } from '@codemirror/lint';
import { type EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type {
  LspClient,
  LspCodeAction,
  LspDiagnostic,
  LspHover,
  LspInlayHint,
  LspPosition,
  LspRange,
  LspSeverity,
  LspSignatureHelp,
  LspTextEdit,
  LspWorkspaceEdit,
} from './lspClient';

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

function renderHoverContents(contents: LspHover['contents'] | { kind: string; value: string } | undefined): string {
  if (contents === undefined) return '';
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

// ── Signature help ──────────────────────────────────────────────────────────

const setSignatureHelpTooltip = StateEffect.define<Tooltip | null>();

const signatureHelpField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSignatureHelpTooltip)) return e.value;
    }
    return value;
  },
  provide: (f) => showTooltip.from(f),
});

function buildSignatureTooltip(sig: LspSignatureHelp, pos: number): Tooltip | null {
  if (sig.signatures.length === 0) return null;
  const idx = Math.max(0, Math.min(sig.activeSignature ?? 0, sig.signatures.length - 1));
  const active = sig.signatures[idx];
  if (active === undefined) return null;
  const activeParam = active.activeParameter ?? sig.activeParameter ?? 0;

  return {
    pos,
    above: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-tooltip-cursor lsp-sig-help';
      dom.style.padding = '6px 9px';
      dom.style.maxWidth = '80ch';
      dom.style.whiteSpace = 'pre-wrap';
      dom.style.fontFamily = 'var(--font-mono)';
      dom.style.fontSize = '12px';

      const sigLine = document.createElement('div');
      const label = active.label;
      const params = active.parameters ?? [];
      const ap = params[activeParam];
      let highlighted = false;
      if (ap !== undefined) {
        if (Array.isArray(ap.label)) {
          const [s, e] = ap.label;
          if (s >= 0 && e <= label.length && s < e) {
            sigLine.appendChild(document.createTextNode(label.slice(0, s)));
            const strong = document.createElement('strong');
            strong.textContent = label.slice(s, e);
            sigLine.appendChild(strong);
            sigLine.appendChild(document.createTextNode(label.slice(e)));
            highlighted = true;
          }
        } else if (typeof ap.label === 'string' && ap.label.length > 0) {
          const at = label.indexOf(ap.label);
          if (at >= 0) {
            sigLine.appendChild(document.createTextNode(label.slice(0, at)));
            const strong = document.createElement('strong');
            strong.textContent = ap.label;
            sigLine.appendChild(strong);
            sigLine.appendChild(document.createTextNode(label.slice(at + ap.label.length)));
            highlighted = true;
          }
        }
      }
      if (!highlighted) sigLine.textContent = label;
      dom.appendChild(sigLine);

      // Doc for the active parameter, then for the signature as a whole.
      const docs: string[] = [];
      if (ap !== undefined) {
        const pdoc = renderHoverContents(ap.documentation).trim();
        if (pdoc.length > 0) docs.push(pdoc);
      }
      const sdoc = renderHoverContents(active.documentation).trim();
      if (sdoc.length > 0) docs.push(sdoc);
      if (docs.length > 0) {
        const docDiv = document.createElement('div');
        docDiv.className = 'lsp-sig-help-doc';
        docDiv.style.marginTop = '4px';
        docDiv.style.color = 'var(--ink-mute)';
        docDiv.style.whiteSpace = 'pre-wrap';
        docDiv.textContent = docs.join('\n\n');
        dom.appendChild(docDiv);
      }

      // Signature counter when the server returned multiple overloads.
      if (sig.signatures.length > 1) {
        const counter = document.createElement('div');
        counter.className = 'lsp-sig-help-counter';
        counter.style.marginTop = '4px';
        counter.style.fontSize = '11px';
        counter.style.color = 'var(--ink-mute)';
        counter.textContent = `${idx + 1} of ${sig.signatures.length}`;
        dom.appendChild(counter);
      }

      return { dom };
    },
  };
}

/**
 * CodeMirror extension that fetches `textDocument/signatureHelp` from the
 * given LSP client when the user types a trigger character (default `(`,
 * `,`) and re-fetches as the cursor moves between arguments. The popup
 * dismisses automatically when the server reports no signatures.
 *
 * For project workspaces, pass an optional `getUri` to query a specific
 * file's URI; if omitted, falls back to the client's `mainFileUri`
 * (single-buffer case).
 */
export function lspSignatureHelpExtension(getClient: () => LspClient | null, getUri?: () => string | null) {
  const plugin = ViewPlugin.fromClass(
    class {
      private pendingId = 0;
      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet) return;
        const client = getClient();
        if (client === null || !client.isOpen()) return;
        const sigCap = client.capabilities.signatureHelpProvider;
        if (sigCap === undefined) return;

        const triggers = sigCap.triggerCharacters ?? ['(', ','];
        const retriggers = sigCap.retriggerCharacters ?? [];
        const tooltipShowing = update.startState.field(signatureHelpField, false) !== null;

        let shouldFetch = false;
        if (update.docChanged) {
          // Inspect the last inserted character for trigger / retrigger.
          let lastChar = '';
          update.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
            const s = ins.toString();
            if (s.length > 0) lastChar = s.charAt(s.length - 1);
          });
          if (triggers.includes(lastChar) || retriggers.includes(lastChar)) shouldFetch = true;
          else if (tooltipShowing) shouldFetch = true; // refresh while popup is up; server hides if context lost
        } else if (update.selectionSet && tooltipShowing) {
          shouldFetch = true;
        }
        if (!shouldFetch) return;

        const id = ++this.pendingId;
        const pos = update.state.selection.main.head;
        const lspPos = offsetToLspPosition(update.state, pos);
        const uri = getUri?.() ?? null;
        const req = uri !== null ? client.signatureHelpUri(uri, lspPos.line, lspPos.character) : client.signatureHelp(lspPos.line, lspPos.character);
        void req.then((sig) => {
          if (id !== this.pendingId) return;
          if (sig === null) {
            this.view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
            return;
          }
          const tooltip = buildSignatureTooltip(sig, pos);
          this.view.dispatch({ effects: setSignatureHelpTooltip.of(tooltip) });
        });
      }
    }
  );

  // Escape dismisses an open signature help tooltip without affecting the
  // rest of the editor's escape behaviour (handlers are tried in order).
  const dismissKeymap = keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        if (view.state.field(signatureHelpField, false) === null) return false;
        view.dispatch({ effects: setSignatureHelpTooltip.of(null) });
        return true;
      },
    },
  ]);

  return [signatureHelpField, plugin, dismissKeymap];
}

// ── Inlay hints ─────────────────────────────────────────────────────────────

class InlayHintWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly kind: number | undefined,
    private readonly tooltip: string | undefined,
    private readonly paddingLeft: boolean,
    private readonly paddingRight: boolean
  ) {
    super();
  }

  override eq(other: InlayHintWidget): boolean {
    return (
      this.text === other.text &&
      this.kind === other.kind &&
      this.tooltip === other.tooltip &&
      this.paddingLeft === other.paddingLeft &&
      this.paddingRight === other.paddingRight
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-lsp-inlay cm-lsp-inlay-${this.kind === 2 ? 'param' : 'type'}`;
    span.textContent = (this.paddingLeft ? ' ' : '') + this.text + (this.paddingRight ? ' ' : '');
    span.style.opacity = '0.7';
    span.style.fontStyle = 'italic';
    span.style.color = 'var(--ink-mute)';
    span.style.fontSize = '11px';
    if (this.tooltip !== undefined && this.tooltip.length > 0) span.title = this.tooltip;
    return span;
  }

  override get estimatedHeight(): number {
    return -1;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function inlayHintLabelToText(label: LspInlayHint['label']): string {
  if (typeof label === 'string') return label;
  return label.map((p) => p.value).join('');
}

function inlayHintTooltipText(hint: LspInlayHint): string | undefined {
  if (hint.tooltip !== undefined) {
    const t = renderHoverContents(hint.tooltip).trim();
    if (t.length > 0) return t;
  }
  if (Array.isArray(hint.label)) {
    const parts: string[] = [];
    for (const p of hint.label) {
      const t = renderHoverContents(p.tooltip).trim();
      if (t.length > 0) parts.push(t);
    }
    if (parts.length > 0) return parts.join('\n\n');
  }
  return undefined;
}

const setInlayHints = StateEffect.define<DecorationSet>();

const inlayHintField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setInlayHints)) next = e.value;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildInlayDecorations(state: EditorState, hints: LspInlayHint[]): DecorationSet {
  // RangeSetBuilder requires entries in ascending `from` order; sort to be safe.
  const sorted = [...hints].sort((a, b) => {
    if (a.position.line !== b.position.line) return a.position.line - b.position.line;
    return a.position.character - b.position.character;
  });
  const builder = new RangeSetBuilder<Decoration>();
  for (const h of sorted) {
    const offset = lspPositionToOffset(state, h.position);
    const text = inlayHintLabelToText(h.label).trim();
    if (text.length === 0) continue;
    const widget = new InlayHintWidget(text, h.kind, inlayHintTooltipText(h), h.paddingLeft === true, h.paddingRight === true);
    builder.add(offset, offset, Decoration.widget({ widget, side: 1 }));
  }
  return builder.finish();
}

const INLAY_DEBOUNCE_MS = 300;

/**
 * CodeMirror extension that requests `textDocument/inlayHint` for the visible
 * range and renders each hint as an inline widget. Requests are debounced
 * after viewport / doc changes; in-flight requests are cancelled by an
 * incrementing generation counter so a slow response can't paint stale hints.
 *
 * Pass `getUri` to query a specific URI in project workspaces; otherwise the
 * single-buffer `mainFileUri` is used.
 */
export function lspInlayHintExtension(getClient: () => LspClient | null, getUri?: () => string | null) {
  return [
    inlayHintField,
    ViewPlugin.fromClass(
      class {
        private generation = 0;
        private timer: number | null = null;
        constructor(private readonly view: EditorView) {
          this.schedule();
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged) this.schedule();
        }

        private schedule(): void {
          if (this.timer !== null) window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.fetch();
          }, INLAY_DEBOUNCE_MS);
        }

        private async fetch(): Promise<void> {
          const client = getClient();
          if (client === null || !client.isOpen()) return;
          if (client.capabilities.inlayHintProvider === undefined || client.capabilities.inlayHintProvider === false) return;

          const id = ++this.generation;
          const { from, to } = this.view.viewport;
          const range: LspRange = {
            start: offsetToLspPosition(this.view.state, from),
            end: offsetToLspPosition(this.view.state, to),
          };
          const uri = getUri?.() ?? null;
          const hints = uri !== null ? await client.inlayHintUri(uri, range) : await client.inlayHint(range);
          if (id !== this.generation) return;
          if (hints === null || hints.length === 0) {
            this.view.dispatch({ effects: setInlayHints.of(Decoration.none) });
            return;
          }
          const decos = buildInlayDecorations(this.view.state, hints);
          this.view.dispatch({ effects: setInlayHints.of(decos) });
        }

        destroy(): void {
          if (this.timer !== null) window.clearTimeout(this.timer);
          this.generation += 1;
        }
      }
    ),
  ];
}

// ── Code actions / quickfix ─────────────────────────────────────────────────

/**
 * Apply a list of LSP `TextEdit`s to a single CodeMirror view. Edits are
 * sorted in document order (LSP guarantees no overlap but not delivery
 * order); applied as a single dispatched transaction.
 */
function applyTextEditsToView(view: EditorView, edits: readonly LspTextEdit[]): boolean {
  if (edits.length === 0) return false;
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
  const changes = sorted.map((e) => ({
    from: lspPositionToOffset(view.state, e.range.start),
    to: lspPositionToOffset(view.state, e.range.end),
    insert: e.newText,
  }));
  view.dispatch({ changes });
  return true;
}

/**
 * Type used by the code-action extension to apply a WorkspaceEdit. The
 * single-buffer editor passes a closure that knows about its lone view; a
 * project-workspace caller would pass a closure that routes per-URI to the
 * appropriate tab. Returns the count of URIs successfully applied to.
 */
export type WorkspaceEditApplier = (edit: LspWorkspaceEdit) => number;

/**
 * Build a `WorkspaceEditApplier` for a single-buffer editor. Edits whose URI
 * doesn't match the view's `viewUri` are skipped — single-buffer extensions
 * never have other tabs to write to. Both arguments are getters so the
 * applier resolves them lazily at call time (the view is typically created
 * after the extension list).
 */
export function buildSingleBufferApplier(getView: () => EditorView | null, getViewUri: () => string | null): WorkspaceEditApplier {
  return (edit: LspWorkspaceEdit): number => {
    const view = getView();
    const viewUri = getViewUri();
    if (view === null || viewUri === null) return 0;
    let applied = 0;
    if (edit.changes !== undefined) {
      const editsForView = edit.changes[viewUri];
      if (editsForView !== undefined && applyTextEditsToView(view, editsForView)) applied += 1;
    }
    if (edit.documentChanges !== undefined) {
      for (const dc of edit.documentChanges) {
        if (dc.textDocument.uri !== viewUri) continue;
        if (applyTextEditsToView(view, dc.edits)) applied += 1;
      }
    }
    return applied;
  };
}

const setCodeActionTooltip = StateEffect.define<Tooltip | null>();

const codeActionField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCodeActionTooltip)) return e.value;
    }
    return value;
  },
  provide: (f) => showTooltip.from(f),
});

function buildCodeActionTooltip(actions: LspCodeAction[], pos: number, onPick: (action: LspCodeAction) => void): Tooltip | null {
  if (actions.length === 0) return null;
  return {
    pos,
    above: false,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-tooltip-cursor lsp-code-actions';
      dom.style.padding = '4px 0';
      dom.style.maxWidth = '60ch';
      dom.style.fontFamily = 'var(--font-body)';
      dom.style.fontSize = '12px';
      dom.style.minWidth = '24ch';

      const list = document.createElement('ul');
      list.style.listStyle = 'none';
      list.style.margin = '0';
      list.style.padding = '0';

      for (const action of actions) {
        const item = document.createElement('li');
        item.style.padding = '4px 9px';
        item.style.cursor = 'pointer';
        item.style.borderLeft = action.isPreferred === true ? '2px solid var(--sig)' : '2px solid transparent';
        item.style.userSelect = 'none';
        item.textContent = action.title;
        if (action.kind !== undefined && action.kind.length > 0) {
          const tag = document.createElement('span');
          tag.style.marginLeft = '8px';
          tag.style.opacity = '0.5';
          tag.style.fontSize = '10px';
          tag.textContent = action.kind;
          item.appendChild(tag);
        }
        item.addEventListener('mouseenter', () => {
          item.style.backgroundColor = 'var(--sig-soft)';
        });
        item.addEventListener('mouseleave', () => {
          item.style.backgroundColor = '';
        });
        item.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          onPick(action);
        });
        list.appendChild(item);
      }
      dom.appendChild(list);
      return { dom };
    },
  };
}

/**
 * CodeMirror extension that fetches `textDocument/codeAction` on Mod-. and
 * shows a popup of available actions. Clicking an action resolves it (if the
 * server lazy-defers `edit`/`command`) and applies the resulting WorkspaceEdit
 * via the supplied `applyEdit` closure. Escape dismisses.
 *
 * `getDiagnostics` returns the LSP diagnostics overlapping the current cursor
 * range — passed as `context.diagnostics` so the server scopes the action set
 * to the issue at hand instead of returning every refactor it can think of.
 *
 * Pass `getUri` for project workspaces; single-buffer falls back to the
 * client's `mainFileUri`.
 */
export function lspCodeActionExtension(
  getClient: () => LspClient | null,
  getDiagnostics: () => LspDiagnostic[],
  applyEdit: WorkspaceEditApplier,
  getUri?: () => string | null
) {
  const trigger = async (view: EditorView): Promise<boolean> => {
    const client = getClient();
    if (client === null || !client.isOpen()) return false;
    const cap = client.capabilities.codeActionProvider;
    if (cap === undefined || cap === false) return false;

    const sel = view.state.selection.main;
    const range: LspRange = {
      start: offsetToLspPosition(view.state, Math.min(sel.from, sel.to)),
      end: offsetToLspPosition(view.state, Math.max(sel.from, sel.to)),
    };

    // Filter diagnostics to the ones whose range overlaps the cursor's line.
    const cursorLine = range.start.line;
    const relevantDiags = getDiagnostics().filter((d) => d.range.start.line <= cursorLine && d.range.end.line >= cursorLine);

    const uri = getUri?.() ?? null;
    const actions = uri !== null ? await client.codeActionUri(uri, range, relevantDiags) : await client.codeAction(range, relevantDiags);
    if (actions === null || actions.length === 0) {
      view.dispatch({ effects: setCodeActionTooltip.of(null) });
      return true;
    }

    const onPick = async (action: LspCodeAction): Promise<void> => {
      view.dispatch({ effects: setCodeActionTooltip.of(null) });
      const resolved = await client.resolveCodeAction(action);
      if (resolved === null) return;
      if (resolved.edit !== undefined) {
        applyEdit(resolved.edit);
      }
      // We deliberately do NOT execute server commands — that opens a
      // separate workspace/executeCommand flow with arbitrary side-effects.
      // For now, action.edit is sufficient for the common quickfix surface.
    };

    const tooltip = buildCodeActionTooltip(actions, sel.from, (a) => void onPick(a));
    view.dispatch({ effects: setCodeActionTooltip.of(tooltip) });
    return true;
  };

  return [
    codeActionField,
    keymap.of([
      {
        key: 'Mod-.',
        run: (view) => {
          void trigger(view);
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (view.state.field(codeActionField, false) === null) return false;
          view.dispatch({ effects: setCodeActionTooltip.of(null) });
          return true;
        },
      },
    ]),
  ];
}

// ── Re-export for editor.ts convenience ─────────────────────────────────────

export { EditorView };
