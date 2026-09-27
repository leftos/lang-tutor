import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { cmDiagnosticsToLsp, parseOutputProblems } from './outputProblems';

/** rustc's output for the `cannot assign twice to immutable variable` example. */
const RUSTC_OUTPUT = [
  'error[E0384]: cannot assign twice to immutable variable `x`',
  ' --> main.rs:3:5',
  '  |',
  '2 |     let x = 5;',
  '  |         - first assignment to `x`',
  '3 |     x = 6;',
  '  |         ^^^^^ cannot assign twice to immutable variable',
  'warning: unused variable: `x`',
  ' --> main.rs:2:9',
  '  |',
  '2 |     let x = 5;',
  '  |         ^^^^ help: if this is intentional, prefix it with an underscore: `_x`',
  '  |',
  '  = note: `#[warn(unused_variables)]` on by default',
  '',
  'warning: 2 warnings generated',
  'error: aborting due to 1 previous error',
  'For more information about this error, try `rustc --explain E0384`.',
].join('\n');

const PYTHON_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "main.py", line 3, in <module>',
  '    foo()',
  '  File "main.py", line 7, in foo',
  '    bar()',
  "NameError: name 'bar' is not defined",
].join('\n');

describe('parseOutputProblems — rustc', () => {
  it('takes the message and severity from the header above the pointer', () => {
    const problems = parseOutputProblems(RUSTC_OUTPUT, 'main.rs');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      severity: 'error',
      line: 3,
      col: 5,
      displayLocation: 'main.rs:3:5',
      message: 'cannot assign twice to immutable variable `x` [E0384]',
    });
  });

  it('pairs the warning header with its own pointer', () => {
    expect(parseOutputProblems(RUSTC_OUTPUT, 'main.rs')[1]).toMatchObject({
      severity: 'warning',
      line: 2,
      col: 9,
      displayLocation: 'main.rs:2:9',
      message: 'unused variable: `x`',
    });
  });

  it('reports nothing for the gutter and caret lines', () => {
    const gutter = [
      '  |',
      '2 |     let x = 5;',
      '  |         - first assignment to `x`',
      '  |         ^^^^^ cannot assign twice to immutable variable',
    ].join('\n');
    expect(parseOutputProblems(gutter, 'main.rs')).toEqual([]);
  });

  it('reports nothing for the trailing summary lines', () => {
    const summary = [
      'warning: 2 warnings generated',
      'error: aborting due to 1 previous error',
      'For more information about this error, try `rustc --explain E0384`.',
    ].join('\n');
    expect(parseOutputProblems(summary, 'main.rs')).toEqual([]);
  });

  it('leaves a pointer with no header above it as it was', () => {
    expect(parseOutputProblems('  --> main.rs:3:5', 'main.rs')[0]).toMatchObject({
      severity: 'info',
      line: 3,
      col: 5,
      message: '--> main.rs:3:5',
    });
  });
});

describe('parseOutputProblems — one-line diagnostics', () => {
  it('leaves a clang diagnostic on its own line unchanged', () => {
    const problems = parseOutputProblems("main.cpp:3:5: error: use of undeclared identifier 'y'", 'main.cpp');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      severity: 'error',
      line: 3,
      col: 5,
      displayLocation: 'main.cpp:3:5',
      message: "main.cpp:3:5: error: use of undeclared identifier 'y'",
    });
  });

  it('leaves a Python traceback unchanged', () => {
    expect(parseOutputProblems(PYTHON_TRACEBACK, 'main.py')).toEqual([
      {
        id: 'output:1:2:3:1',
        severity: 'error',
        source: 'output',
        line: 3,
        col: 1,
        displayLocation: 'main.py:3:1',
        message: 'File "main.py", line 3, in <module>',
        raw: '  File "main.py", line 3, in <module>',
        sourceLineIndex: 1,
        matchStart: 2,
        matchEnd: 24,
      },
      {
        id: 'output:3:2:7:1',
        severity: 'error',
        source: 'output',
        line: 7,
        col: 1,
        displayLocation: 'main.py:7:1',
        message: 'File "main.py", line 7, in foo',
        raw: '  File "main.py", line 7, in foo',
        sourceLineIndex: 3,
        matchStart: 2,
        matchEnd: 24,
      },
    ]);
  });
});

describe('cmDiagnosticsToLsp', () => {
  const doc = Text.of(['abc', 'def']);

  it('converts an offset on the first line, keeping severity and source', () => {
    const converted = cmDiagnosticsToLsp(doc, [{ from: 1, to: 3, severity: 'error', message: 'bad', source: 'rustc' }]);
    expect(converted).toEqual([
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
        severity: 1,
        message: 'bad',
        source: 'rustc',
      },
    ]);
  });

  it('converts an offset on a later line', () => {
    const converted = cmDiagnosticsToLsp(doc, [{ from: 5, to: 7, severity: 'warning', message: 'meh' }]);
    expect(converted).toEqual([{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } }, severity: 2, message: 'meh' }]);
  });

  it('converts a diagnostic spanning two lines', () => {
    const converted = cmDiagnosticsToLsp(doc, [{ from: 2, to: 5, severity: 'info', message: 'spanning' }]);
    expect(converted).toEqual([{ range: { start: { line: 0, character: 2 }, end: { line: 1, character: 1 } }, severity: 3, message: 'spanning' }]);
  });
});
