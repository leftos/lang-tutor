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

import { fetchDiagnostics, fetchFormatted } from './lint';
import type { SingleBufferLanguageId } from './types';

const langExtension: Record<SingleBufferLanguageId, () => Extension> = {
  rust: () => rust(),
  cpp: () => cpp(),
  python: () => python(),
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
}

export function createEditor(opts: EditorOptions): TutorEditor {
  const langCompartment = new Compartment();
  const linterCompartment = new Compartment();
  let currentLang: SingleBufferLanguageId = opts.lang;

  const formatNow = async (): Promise<void> => {
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
    autocompletion(),
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
  ];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: opts.initialDoc, extensions: baseExtensions }),
  });

  return {
    getContent(): string {
      return view.state.doc.toString();
    },
    setContent(text: string): void {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setLanguage(lang: SingleBufferLanguageId): void {
      if (lang === currentLang) return;
      currentLang = lang;
      view.dispatch({ effects: langCompartment.reconfigure(langExtension[lang]()) });
      view.dispatch({ effects: linterCompartment.reconfigure(lintSource) });
    },
    format: formatNow,
    destroy(): void {
      view.destroy();
    },
  };
}
