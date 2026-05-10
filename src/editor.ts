import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { csharp } from '@replit/codemirror-lang-csharp';

import { fetchDiagnostics, fetchFormatted } from './lint';
import { connectLsp, type LspClient } from './lspClient';
import {
  applyLspDiagnostics,
  lspCompletionExtension,
  lspDocSyncExtension,
  lspHoverExtension,
  lspPositionToOffset,
  lspSignatureHelpExtension,
} from './lspEditor';
import type { SingleBufferLanguageId } from './types';

const langExtension: Record<SingleBufferLanguageId, () => Extension> = {
  rust: () => rust(),
  cpp: () => cpp(),
  python: () => python(),
  csharp: () => csharp(),
};

export const tutorHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.logicOperator], color: 'var(--syn-operator)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--syn-variable)' },
  { tag: [t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket], color: 'var(--syn-punctuation)' },
  { tag: [t.meta, t.annotation, t.attributeName], color: 'var(--syn-meta)' },
  { tag: t.invalid, color: 'var(--color-danger)' },
]);

// Editor chrome consumes design tokens so light/dark + signature colour flow naturally.
export const tutorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--paper-2)',
    color: 'var(--ink)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--sig)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sig)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--sig-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--paper-2)',
    color: 'var(--ink-mute)',
    border: 'none',
    paddingRight: '6px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    fontStyle: 'italic',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--sig)' },
  '.cm-activeLine': { backgroundColor: 'var(--sig-soft)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '30px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--ink-mute)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--paper)',
    color: 'var(--ink)',
    border: '1px solid var(--rule-2)',
    borderRadius: '1px',
    fontFamily: 'var(--font-body)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--sig-soft)',
    color: 'var(--ink)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--sig-soft)', outline: '1px solid var(--sig)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--sig)', color: 'var(--sig-fg)' },
  '.cm-panels': {
    backgroundColor: 'var(--paper)',
    color: 'var(--ink)',
    borderTop: '1px solid var(--rule)',
  },
  '.cm-panels input, .cm-panels button': {
    fontFamily: 'var(--font-mono)',
    fontSize: '11.5px',
    backgroundColor: 'var(--paper-2)',
    color: 'var(--ink)',
    border: '1px solid var(--rule-2)',
    borderRadius: '1px',
    padding: '3px 7px',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--sig)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--ink-mute)' },
});

export interface EditorOptions {
  parent: HTMLElement;
  initialDoc: string;
  lang: SingleBufferLanguageId;
  onChange: (doc: string) => void;
}

export interface TutorEditor {
  getContent(): string;
  setContent(text: string): void;
  setLanguage(lang: SingleBufferLanguageId): void;
  format(): Promise<void>;
  destroy(): void;
  /** Return the active LSP client, or null if LSP isn't connected for the current language. */
  getLspClient(): LspClient | null;
}

export function createEditor(opts: EditorOptions): TutorEditor {
  const langCompartment = new Compartment();
  const linterCompartment = new Compartment();
  const lspExtCompartment = new Compartment();
  let currentLang: SingleBufferLanguageId = opts.lang;

  // The LSP client lifecycle runs in parallel to the editor's lifecycle.
  // `lspClient` is mutated as we connect / disconnect; closures captured in
  // CodeMirror extensions read it via `getLspClient`.
  let lspClient: LspClient | null = null;
  let lspGeneration = 0;
  const getLspClient = (): LspClient | null => lspClient;

  const lspExtensionsActive = [
    lspCompletionExtension(getLspClient),
    lspHoverExtension(getLspClient),
    lspSignatureHelpExtension(getLspClient),
    lspDocSyncExtension(getLspClient),
  ];

  /**
   * Try to apply an LSP TextEdit to the current view. Returns true if any edit
   * was applied. Edits are applied in document order (LSP guarantees no overlap
   * but doesn't guarantee ordering on the wire).
   */
  const applyLspTextEdits = (edits: ReturnType<NonNullable<LspClient['formatting']>> extends Promise<infer R> ? R : never): boolean => {
    if (edits === null || edits.length === 0) return false;
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
  };

  const formatNow = async (): Promise<void> => {
    // Prefer the LSP formatter (clangd, rust-analyzer, etc.) when available.
    if (lspClient !== null && lspClient.isOpen()) {
      const edits = await lspClient.formatting();
      if (applyLspTextEdits(edits)) return;
    }
    const code = view.state.doc.toString();
    const formatted = await fetchFormatted(currentLang, code);
    if (formatted === null) return;
    if (formatted === code) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      selection: { anchor: Math.min(view.state.selection.main.anchor, formatted.length) },
    });
  };

  const lintSource = linter(async (v) => fetchDiagnostics(currentLang, v.state), { delay: 600 });

  const baseExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(tutorHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    lintGutter(),
    EditorView.lineWrapping,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
      {
        key: 'Mod-s',
        run: () => {
          void formatNow();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
    }),
    tutorTheme,
    langCompartment.of(langExtension[opts.lang]()),
    linterCompartment.of(lintSource),
    // LSP-aware extensions live in their own compartment so we can swap between
    // the default `autocompletion()` and the LSP-overridden version when a
    // language server connects / disconnects.
    lspExtCompartment.of(autocompletion()),
  ];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: opts.initialDoc, extensions: baseExtensions }),
  });

  /**
   * (Re)connect the LSP for the given language. Dispose any previously
   * connected client. Mid-flight language switches are guarded by `generation`.
   */
  const startLspForLang = async (lang: SingleBufferLanguageId): Promise<void> => {
    const generation = ++lspGeneration;

    // Tear down the previous client. Reconfigure compartments back to defaults
    // so we don't leak diagnostics from the old language while we (maybe) wait
    // for the new one to connect.
    if (lspClient !== null) {
      const old = lspClient;
      lspClient = null;
      void old.dispose();
    }
    view.dispatch({
      effects: [linterCompartment.reconfigure(lintSource), lspExtCompartment.reconfigure(autocompletion())],
    });

    let client: LspClient | null = null;
    try {
      client = await connectLsp(lang);
    } catch (e) {
      console.warn(`[lsp:${lang}] connect threw:`, e);
    }
    if (client === null) return;

    // The user may have switched away while we were connecting. Drop this
    // client without wiring it up.
    if (generation !== lspGeneration || lang !== currentLang) {
      void client.dispose();
      return;
    }

    lspClient = client;

    // Push the current doc as the initial open.
    client.didOpen(view.state.doc.toString());

    // Diagnostics: replace the polling linter with LSP-pushed setDiagnostics.
    client.onDiagnostics((diags) => {
      if (lspClient !== client) return; // stale
      applyLspDiagnostics(view, diags);
    });

    view.dispatch({
      effects: [
        // Disable the polling linter — LSP pushes diagnostics directly.
        linterCompartment.reconfigure([]),
        lspExtCompartment.reconfigure(lspExtensionsActive),
      ],
    });
  };

  // Kick off LSP connect for the initial language. Fire-and-forget; the editor
  // is fully usable in fall-soft (poll-based) mode while we connect.
  void startLspForLang(opts.lang);

  return {
    getContent(): string {
      return view.state.doc.toString();
    },
    setContent(text: string): void {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      // Sync to LSP so diagnostics reflect the new doc immediately (e.g., when
      // resetting starter code or pasting).
      if (lspClient !== null && lspClient.isOpen()) {
        lspClient.didChange(text);
      }
    },
    setLanguage(lang: SingleBufferLanguageId): void {
      if (lang === currentLang) return;
      currentLang = lang;
      view.dispatch({ effects: langCompartment.reconfigure(langExtension[lang]()) });
      void startLspForLang(lang);
    },
    format: formatNow,
    destroy(): void {
      const generation = ++lspGeneration;
      if (lspClient !== null) {
        const old = lspClient;
        lspClient = null;
        void old.dispose();
      }
      void generation; // silence unused-var lint when destroy isn't followed by reuse
      view.destroy();
    },
    getLspClient: getLspClient,
  };
}
