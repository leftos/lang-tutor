/**
 * Tab binding shared by the single-buffer and the project editor.
 *
 * Tab first gives an open completion the chance to accept; when none is open it
 * inserts one indent unit at each cursor, or indents the selected lines when a
 * range is non-empty. Shift-Tab outdents the selected lines.
 */

import { acceptCompletion } from '@codemirror/autocomplete';
import { indentLess, indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import type { Command, KeyBinding } from '@codemirror/view';

/** A Tab binding whose two commands are always present. */
export type TabBinding = KeyBinding & { run: Command; shift: Command };

/**
 * Build the Tab binding around the given completion-accepting command, which
 * returns false when there is nothing to accept.
 */
export function makeTabBinding(accept: Command): TabBinding {
  const run: Command = (view) => {
    if (accept(view)) return true;
    const { state } = view;
    if (state.readOnly) return false;
    if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
    view.dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), { userEvent: 'input.indent' }));
    return true;
  };
  return { key: 'Tab', run, shift: indentLess };
}

/** Tab accepts a completion or inserts an indent unit; Shift-Tab outdents. */
export const tabBinding: TabBinding = makeTabBinding(acceptCompletion);
