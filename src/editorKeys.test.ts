import { indentUnit } from '@codemirror/language';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { makeTabBinding } from './editorKeys';

const FOUR_SPACES = '    ';

interface Harness {
  view: EditorView;
  state: EditorState;
  dispatches: number;
}

/**
 * An `EditorView` stand-in that holds a real EditorState and counts the
 * transactions it is dispatched: the binding only reads `state` and calls
 * `dispatch`, and the test environment has no DOM.
 */
function harness(doc: string, selection: EditorSelection): Harness {
  let state = EditorState.create({ doc, selection, extensions: [indentUnit.of(FOUR_SPACES)] });
  let dispatches = 0;
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      dispatches += 1;
      state = tr.state;
    },
  } as unknown as EditorView;
  return {
    view,
    get state() {
      return state;
    },
    get dispatches() {
      return dispatches;
    },
  };
}

/** The leading whitespace of a 1-based line, or '' when there is none. */
function leading(state: EditorState, line: number): string {
  return /^\s*/.exec(state.doc.line(line).text)?.[0] ?? '';
}

describe('tabBinding', () => {
  it('keeps Tab bound in the editor', () => {
    expect(makeTabBinding(() => false).key).toBe('Tab');
  });

  it('accepts an open completion first and does nothing else when it does', () => {
    const accept = vi.fn(() => true);
    const h = harness('let x = 5;', EditorSelection.single(5));
    const binding = makeTabBinding(accept);

    expect(binding.run(h.view)).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(h.dispatches).toBe(0);
    expect(h.state.doc.toString()).toBe('let x = 5;');
    expect(h.state.selection.main.head).toBe(5);
  });

  it('inserts the indent unit at the cursor mid-line when no completion is open', () => {
    const h = harness('let x = 5;', EditorSelection.single(5));

    expect(makeTabBinding(() => false).run(h.view)).toBe(true);
    expect(h.dispatches).toBe(1);
    expect(h.state.doc.toString()).toBe(`let x${FOUR_SPACES} = 5;`);
    expect(leading(h.state, 1)).toBe('');
    expect(h.state.selection.main.head).toBe(5 + FOUR_SPACES.length);
  });

  it('inserts the indent unit at the cursor at the start of a line', () => {
    const h = harness('let x = 5;', EditorSelection.single(0));

    expect(makeTabBinding(() => false).run(h.view)).toBe(true);
    expect(h.state.doc.toString()).toBe(`${FOUR_SPACES}let x = 5;`);
    expect(leading(h.state, 1)).toBe(FOUR_SPACES);
    expect(h.state.selection.main.head).toBe(FOUR_SPACES.length);
  });

  it('indents every selected line when a selection range is non-empty', () => {
    const h = harness('one\ntwo\nthree', EditorSelection.single(5, 1));

    expect(makeTabBinding(() => false).run(h.view)).toBe(true);
    expect(h.state.doc.toString()).toBe(`${FOUR_SPACES}one\n${FOUR_SPACES}two\nthree`);
  });

  it('outdents the selected lines on Shift-Tab', () => {
    const accept = vi.fn(() => true);
    const h = harness(`${FOUR_SPACES}one\n${FOUR_SPACES}two\nthree`, EditorSelection.single(10, 5));

    expect(makeTabBinding(accept).shift(h.view)).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(h.state.doc.toString()).toBe('one\ntwo\nthree');
  });
});
