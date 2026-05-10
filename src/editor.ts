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
import type { LanguageId } from './types';

const langExtension: Record<LanguageId, () => Extension> = {
  rust: () => rust(),
  cpp: () => cpp(),
  python: () => python(),
};

// Syntax highlight using CSS custom properties so light/dark mode flows naturally.
const tutorHighlight = HighlightStyle.define([
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

// Editor chrome that consumes our design tokens. Fonts and colors come from CSS vars.
const tutorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--color-raised)',
    color: 'var(--color-primary)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-family-mono)',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--color-primary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(99, 153, 34, 0.22)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-raised)',
    color: 'var(--color-muted)',
    border: 'none',
    paddingRight: '4px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-primary)' },
  '.cm-activeLine': { backgroundColor: 'rgba(127, 127, 127, 0.06)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 12px', minWidth: '28px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-primary)',
    border: '0.5px solid var(--bdr-strong)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-raised)',
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(186, 117, 23, 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(186, 117, 23, 0.5)' },
  '.cm-panels': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-primary)',
    borderTop: '0.5px solid var(--bdr)',
  },
  '.cm-panels input, .cm-panels button': {
    fontFamily: 'inherit',
    fontSize: '12px',
    backgroundColor: 'var(--color-raised)',
    color: 'var(--color-primary)',
    border: '0.5px solid var(--bdr-strong)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--color-danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: '#ba7517' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--color-muted)' },
});

export interface EditorOptions {
  parent: HTMLElement;
  initialDoc: string;
  lang: LanguageId;
  onChange: (doc: string) => void;
}

export interface TutorEditor {
  getContent(): string;
  setContent(text: string): void;
  setLanguage(lang: LanguageId): void;
  format(): Promise<void>;
  destroy(): void;
}

export function createEditor(opts: EditorOptions): TutorEditor {
  const langCompartment = new Compartment();
  const linterCompartment = new Compartment();
  let currentLang: LanguageId = opts.lang;

  const formatNow = async (): Promise<void> => {
    const code = view.state.doc.toString();
    const formatted = await fetchFormatted(currentLang, code);
    if (formatted === null) return;
    if (formatted === code) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      // Preserve cursor position roughly — clamp to new doc end if it would overflow.
      selection: { anchor: Math.min(view.state.selection.main.anchor, formatted.length) },
    });
  };

  // Linter source captures `currentLang` by reference so language switches feed through.
  const lintSource = linter(
    async (v) => fetchDiagnostics(currentLang, v.state),
    { delay: 600 } // debounce: don't pelt the toolchain on every keystroke
  );

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
    setLanguage(lang: LanguageId): void {
      if (lang === currentLang) return;
      currentLang = lang;
      view.dispatch({ effects: langCompartment.reconfigure(langExtension[lang]()) });
      // Force the linter to re-run for the new language by reconfiguring the compartment.
      view.dispatch({ effects: linterCompartment.reconfigure(lintSource) });
    },
    format: formatNow,
    destroy(): void {
      view.destroy();
    },
  };
}
