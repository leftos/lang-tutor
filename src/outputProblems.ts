import type { Diagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';
import type { LspDiagnostic } from './lspClient';

export type ProblemSeverity = 'error' | 'warning' | 'info';
export type ProblemSource = 'output' | 'diagnostic';

export interface SingleProblem {
  id: string;
  severity: ProblemSeverity;
  source: ProblemSource;
  line: number;
  col: number;
  displayLocation: string;
  message: string;
  raw: string;
  sourceLineIndex?: number;
  matchStart?: number;
  matchEnd?: number;
}

interface LocatedText {
  token: string;
  line: number;
  col: number;
  start: number;
  end: number;
  matchText: string;
}

const CSHARP_LOCATION_RE = /(^|[\s([{'"])((?:[A-Za-z]:)?[^\s()\r\n]+?\.\w+)\((\d+),(\d+)\)/g;
const PYTHON_LOCATION_RE = /File "([^"]+)", line (\d+)/g;
const COLON_LOCATION_RE = /(^|[\s([{'"])((?:(?:[A-Za-z]:)?[\\/])?(?:[^\s:()[\]{}'"`]+[\\/])*[A-Za-z0-9_.<>-]+):(\d+)(?::(\d+))?/g;
/** rustc's own diagnostic header: `error[E0384]: cannot assign twice to immutable variable \`x\``. */
const RUSTC_HEADER_RE = /^(error|warning|note|help)(\[[A-Za-z0-9_]+\])?:\s*(.+)$/;
/** rustc's location pointer, printed on the line *after* the header: ` --> main.rs:3:5`. */
const RUSTC_POINTER_RE = /^(\s*-->\s*)(\S+):(\d+):(\d+)/;

/** Basename of a path written with either separator. */
function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

/**
 * Whether a location token plausibly names the file the student is editing:
 * angle-bracket placeholders and bare `main`, or the active language's file
 * name (by basename, or by its extension).
 */
function isLikelySingleBufferLocation(token: string, fileName: string): boolean {
  const clean = token.trim().replace(/^["']|["']$/g, '');
  if (/^<[^>]+>$/.test(clean)) return true;
  if (clean === 'main') return true;

  const base = fileBasename(clean);
  if (base === fileName) return true;

  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot) : '';
  return ext.length > 0 && base.endsWith(ext);
}

function addLocatedText(out: LocatedText[], loc: LocatedText, fileName: string): void {
  if (!Number.isFinite(loc.line) || loc.line < 1 || !Number.isFinite(loc.col) || loc.col < 1) return;
  if (!isLikelySingleBufferLocation(loc.token, fileName)) return;
  if (out.some((existing) => loc.start < existing.end && loc.end > existing.start)) return;
  out.push(loc);
}

/** Every `path:line[:col]` / `File "…", line N` / `File.cs(L,C)` location on one line. */
function findLocationsInLine(line: string, fileName: string): LocatedText[] {
  const out: LocatedText[] = [];

  for (const m of line.matchAll(PYTHON_LOCATION_RE)) {
    const token = m[1];
    const lineStr = m[2];
    if (token === undefined || lineStr === undefined || m.index === undefined) continue;
    addLocatedText(
      out,
      {
        token,
        line: Number.parseInt(lineStr, 10),
        col: 1,
        start: m.index,
        end: m.index + m[0].length,
        matchText: m[0],
      },
      fileName
    );
  }

  for (const m of line.matchAll(CSHARP_LOCATION_RE)) {
    const prefix = m[1] ?? '';
    const token = m[2];
    const lineStr = m[3];
    const colStr = m[4];
    if (token === undefined || lineStr === undefined || colStr === undefined || m.index === undefined) continue;
    const matchText = `${token}(${lineStr},${colStr})`;
    addLocatedText(
      out,
      {
        token,
        line: Number.parseInt(lineStr, 10),
        col: Number.parseInt(colStr, 10),
        start: m.index + prefix.length,
        end: m.index + prefix.length + matchText.length,
        matchText,
      },
      fileName
    );
  }

  for (const m of line.matchAll(COLON_LOCATION_RE)) {
    const prefix = m[1] ?? '';
    const token = m[2];
    const lineStr = m[3];
    const colStr = m[4];
    if (token === undefined || lineStr === undefined || m.index === undefined) continue;
    const matchText = `${token}:${lineStr}${colStr === undefined ? '' : `:${colStr}`}`;
    addLocatedText(
      out,
      {
        token,
        line: Number.parseInt(lineStr, 10),
        col: colStr === undefined ? 1 : Number.parseInt(colStr, 10),
        start: m.index + prefix.length,
        end: m.index + prefix.length + matchText.length,
        matchText,
      },
      fileName
    );
  }

  return out.sort((a, b) => a.start - b.start);
}

interface RustcHeader {
  severity: ProblemSeverity;
  message: string;
}

/**
 * Read an rustc diagnostic header. rustc prints the message above its `-->`
 * pointer line, so the caller holds this until a pointer consumes it.
 */
function rustcHeaderFromLine(line: string): RustcHeader | null {
  const match = RUSTC_HEADER_RE.exec(line);
  if (match === null) return null;
  const kind = match[1];
  const code = match[2];
  const text = match[3];
  if (kind === undefined || text === undefined) return null;
  const severity: ProblemSeverity = kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info';
  return { severity, message: code === undefined ? text : `${text} ${code}` };
}

/** Turn a rustc `-->` pointer into a problem, taking severity and message from its header. */
function rustcPointerProblem(line: string, index: number, header: RustcHeader, match: RegExpExecArray): SingleProblem | null {
  const prefix = match[1] ?? '';
  const token = match[2];
  const lineStr = match[3];
  const colStr = match[4];
  if (token === undefined || lineStr === undefined || colStr === undefined) return null;
  const lineNo = Number.parseInt(lineStr, 10);
  const colNo = Number.parseInt(colStr, 10);
  if (!Number.isFinite(lineNo) || lineNo < 1 || !Number.isFinite(colNo) || colNo < 1) return null;
  const start = match.index + prefix.length;
  return {
    id: `output:${index}:${start}:${lineNo}:${colNo}`,
    severity: header.severity,
    source: 'output',
    line: lineNo,
    col: colNo,
    displayLocation: `${fileBasename(token)}:${lineNo}:${colNo}`,
    message: header.message,
    raw: line,
    sourceLineIndex: index,
    matchStart: start,
    matchEnd: start + token.length + lineStr.length + colStr.length + 2,
  };
}

/** Every problem a single output line carries, read as a plain `file:line[:col]` location. */
function locationProblems(line: string, index: number, fileName: string, severity: ProblemSeverity): SingleProblem[] {
  return findLocationsInLine(line, fileName).map((loc) => ({
    id: `output:${index}:${loc.start}:${loc.line}:${loc.col}`,
    severity,
    source: 'output',
    line: loc.line,
    col: loc.col,
    displayLocation: `${fileBasename(loc.token)}:${loc.line}:${loc.col}`,
    message: problemMessageFromLine(line, loc.matchText),
    raw: line,
    sourceLineIndex: index,
    matchStart: loc.start,
    matchEnd: loc.end,
  }));
}

function severityFromText(text: string): ProblemSeverity | null {
  if (/\b(traceback|exception|error|failed|fatal|panic)\b/i.test(text)) return 'error';
  if (/\b(warning|warn)\b/i.test(text)) return 'warning';
  return null;
}

function problemMessageFromLine(line: string, matchText: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return matchText;
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}

/**
 * Turn a program's stdout / stderr into Error-list entries. Every line is
 * scanned for a `file:line[:col]` style location; the active language's file
 * name is what makes a location count. `fileName` empty (a project workspace)
 * leaves only the language-agnostic `<placeholder>` / `main` forms.
 *
 * rustc is the exception: it prints the message on the line above its `-->`
 * pointer, so a pointer line takes its severity and message from the most
 * recent header instead of from itself.
 */
export function parseOutputProblems(text: string, fileName: string): SingleProblem[] {
  if (text.trim().length === 0) return [];

  const problems: SingleProblem[] = [];
  let contextSeverity: { severity: ProblemSeverity; ttl: number } | null = null;
  let pendingHeader: RustcHeader | null = null;
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const header = rustcHeaderFromLine(line);
    if (header !== null) pendingHeader = header;

    const explicitSeverity = severityFromText(line);
    if (explicitSeverity !== null) {
      contextSeverity = { severity: explicitSeverity, ttl: explicitSeverity === 'error' && /traceback/i.test(line) ? 8 : 3 };
    }

    const pointer = header === null ? RUSTC_POINTER_RE.exec(line) : null;
    if (pointer !== null && pendingHeader !== null) {
      const problem = rustcPointerProblem(line, index, pendingHeader, pointer);
      pendingHeader = null;
      if (problem !== null) problems.push(problem);
    } else {
      problems.push(...locationProblems(line, index, fileName, explicitSeverity ?? contextSeverity?.severity ?? 'info'));
    }

    if (contextSeverity !== null) {
      contextSeverity.ttl -= 1;
      if (contextSeverity.ttl <= 0) contextSeverity = null;
    }
  });

  return problems;
}

function cmSeverity(d: Diagnostic): 1 | 2 | 3 {
  if (d.severity === 'error') return 1;
  if (d.severity === 'warning') return 2;
  return 3;
}

/**
 * Convert CodeMirror diagnostics (offsets) into LSP diagnostics (0-based line /
 * character), so the host linter's findings can be listed in the same shape as
 * the language server's.
 */
export function cmDiagnosticsToLsp(doc: Text, diagnostics: readonly Diagnostic[]): LspDiagnostic[] {
  return diagnostics.map((d) => {
    const from = Math.max(0, Math.min(d.from, doc.length));
    const to = Math.max(from, Math.min(d.to, doc.length));
    const start = doc.lineAt(from);
    const end = doc.lineAt(to);
    const converted: LspDiagnostic = {
      range: {
        start: { line: start.number - 1, character: from - start.from },
        end: { line: end.number - 1, character: to - end.from },
      },
      severity: cmSeverity(d),
      message: d.message,
    };
    if (d.source !== undefined) converted.source = d.source;
    return converted;
  });
}
