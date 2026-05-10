/**
 * Multi-file editor for project-kind languages.
 *
 * Owns a single CodeMirror EditorView and a Map<path, EditorState> so that
 * switching tabs preserves cursor + scroll + history per file. Files are
 * fetched lazily from /fs/read on first open and cached in a content map for
 * dirty tracking. Edits trigger a 600 ms debounced PUT to /fs/write.
 *
 * Tab strip and editor view live in two separate hosts (passed in by the
 * caller) but are driven by this single state machine.
 */

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
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
import { csharp } from '@replit/codemirror-lang-csharp';

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { tutorHighlight, tutorTheme } from './editor';
import { connectLsp, type LspClient } from './lspClient';
import { fetchFile, writeFile } from './projectApi';
import type { LanguageId } from './types';

// LSP languageId tag per-extension (the value the language server expects in
// textDocument/didOpen). Project workspaces are multi-language; only files
// whose extension maps here get pushed to the LSP.
const LSP_LANGUAGE_ID_BY_EXT: Record<string, string> = {
  cs: 'csharp',
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  html: 'html',
  htm: 'html',
  css: 'css',
  json: 'json',
};

function lspLanguageIdForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return LSP_LANGUAGE_ID_BY_EXT[ext] ?? null;
}

/** Build a `file:///` URI for a project-relative path under the LSP rootUri. */
function pathToFileUri(rootUri: string, relativePath: string): string {
  const trimmedRoot = rootUri.replace(/\/$/, '');
  const trimmedPath = relativePath.replace(/^[/\\]+/, '').replaceAll('\\', '/');
  return `${trimmedRoot}/${trimmedPath}`;
}

// GitHub-flavoured markdown defaults: tables, strikethrough, autolinks,
// task lists. Newlines inside paragraphs become <br/>.
marked.setOptions({ gfm: true, breaks: false });

function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return ext === 'md' || ext === 'markdown';
}

function renderMarkdownToSafeHTML(source: string): string {
  // marked.parse can be async with custom extensions; force sync for our
  // simple use-case so we can synchronously swap the preview content.
  const rawHtml = marked.parse(source, { async: false }) as string;
  // DOMPurify strips <script>, on*= handlers, javascript: URLs, and any other
  // HTML/attribute that could execute. Markdown can embed raw HTML; the user
  // is the author here, but defence-in-depth — and a future `git pull` could
  // bring in scaffold content from elsewhere.
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });
}

const SAVE_DEBOUNCE_MS = 600;

export interface ProjectEditorOptions {
  editorHost: HTMLElement;
  tabsHost: HTMLElement;
  statusHost: HTMLElement;
  lang: LanguageId;
  initialOpenTabs: readonly string[];
  initialActiveTab: string | null;
  onTabsChanged: (openTabs: string[], activeTab: string | null) => void;
  onSaveStateChanged?: (path: string, dirty: boolean) => void;
}

export interface ProjectEditor {
  openFile(path: string): Promise<void>;
  switchTo(path: string): void;
  closeFile(path: string): void;
  saveAll(): Promise<void>;
  refreshTabs(): void;
  /** Active LSP client for the project workspace, or null if not connected / unavailable. */
  getLspClient(): LspClient | null;
  /** Re-read the file from disk. If the tab is dirty, the in-memory content is preserved. */
  refreshFile(path: string): Promise<void>;
  /** Re-key an open tab after a rename and rebuild its state with the new file's language extension. */
  renameTab(oldPath: string, newPath: string): void;
  /** Close a tab that has been deleted on disk without attempting to flush a save. */
  forgetTab(path: string): void;
  /** Currently open tab paths (for external callers checking what's affected by FS events). */
  getOpenPaths(): string[];
  /** Currently open files with their in-memory contents (includes unsaved edits). */
  getOpenFiles(): Array<{ path: string; content: string; dirty: boolean }>;
  /**
   * Open `path` (if not already open), focus the tab, place the cursor at
   * 1-based (line, col), and scroll it into view. Out-of-range coordinates
   * clamp to the document end. No-op if the file fails to open.
   */
  revealAt(path: string, line: number, col: number): Promise<void>;
  destroy(): void;
}

interface TabState {
  path: string;
  state: EditorState;
  /** Last content that was saved to disk. Used for dirty tracking. */
  savedContent: string;
  /** Pending debounced-save timer. */
  saveTimer: number | null;
  /** Per-tab markdown view mode. Only meaningful when isMarkdownPath(path). */
  mdMode: 'raw' | 'preview';
}

function langExtensionForPath(path: string): Extension | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'xml':
    case 'xaml':
    case 'csproj':
      return xml();
    case 'cs':
      return csharp();
    default:
      return null;
  }
}

function baseExtensions(): Extension[] {
  return [
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
    EditorView.lineWrapping,
    tutorTheme,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
  ];
}

function div(...classes: string[]): HTMLDivElement {
  const d = document.createElement('div');
  if (classes.length) d.className = classes.join(' ');
  return d;
}

function span(text: string, ...classes: string[]): HTMLSpanElement {
  const s = document.createElement('span');
  if (classes.length) s.className = classes.join(' ');
  s.textContent = text;
  return s;
}

export function createProjectEditor(opts: ProjectEditorOptions): ProjectEditor {
  const tabs = new Map<string, TabState>();
  let openOrder: string[] = [];
  let active: string | null = null;
  let suppressUpdate = false;

  // ── LSP lifecycle (project workspace, multi-file) ──────────────────────────
  // The client stays null until connectLsp resolves. All call sites use a
  // short-circuit (`lspClient?.didChangeUri(…)`) so the editor is fully usable
  // before / without the LSP, and silently if the server isn't installed.
  let lspClient: LspClient | null = null;
  // didOpen/didClose calls that arrive before the client is ready are queued
  // and replayed once connectLsp resolves.
  const pendingLspOps: Array<(c: LspClient) => void> = [];

  const enqueueLsp = (op: (c: LspClient) => void): void => {
    if (lspClient !== null) op(lspClient);
    else pendingLspOps.push(op);
  };

  void (async (): Promise<void> => {
    const client = await connectLsp(opts.lang);
    if (client === null) return;
    lspClient = client;
    while (pendingLspOps.length > 0) {
      const op = pendingLspOps.shift();
      if (op !== undefined) {
        try {
          op(client);
        } catch (e) {
          console.warn('[projectEditor] queued lsp op threw:', e);
        }
      }
    }
  })();

  const lspDidOpen = (path: string, content: string): void => {
    const langId = lspLanguageIdForPath(path);
    if (langId === null) return;
    enqueueLsp((client) => {
      const uri = pathToFileUri(client.rootUri, path);
      client.didOpenUri(uri, langId, content);
    });
  };

  const lspDidChange = (path: string, content: string): void => {
    const langId = lspLanguageIdForPath(path);
    if (langId === null) return;
    enqueueLsp((client) => {
      const uri = pathToFileUri(client.rootUri, path);
      client.didChangeUri(uri, content);
    });
  };

  const lspDidClose = (path: string): void => {
    const langId = lspLanguageIdForPath(path);
    if (langId === null) return;
    enqueueLsp((client) => {
      const uri = pathToFileUri(client.rootUri, path);
      client.didCloseUri(uri);
    });
  };

  // The update listener has to live inside every per-file state we build —
  // view.setState() replaces extensions wholesale, so a single instance
  // attached only to the initial state would be lost on first tab switch.
  const updateListener = EditorView.updateListener.of((update) => {
    if (suppressUpdate) return;
    if (!update.docChanged) return;
    if (active === null) return;
    const tab = tabs.get(active);
    if (tab === undefined) return;
    tab.state = update.state;
    // Push the new content to the LSP before kicking off the disk save.
    // OmniSharp / Roslyn / tsserver maintain their own in-memory buffer that
    // overrides on-disk content as long as didOpen is in effect.
    lspDidChange(tab.path, update.state.doc.toString());
    scheduleSave(tab);
    renderTabs();
  });

  // Wrap CodeMirror's root so we can toggle the WRAPPER's display when the
  // user flips to Markdown preview. Setting display:none on .cm-editor itself
  // loses to CM's own injected display:flex and would need !important.
  const editorWrap = div('cm-editor-wrap');
  opts.editorHost.appendChild(editorWrap);
  const view = new EditorView({
    parent: editorWrap,
    state: EditorState.create({ doc: '', extensions: [...baseExtensions(), updateListener] }),
  });

  // Markdown preview pane lives in the same editorHost; we toggle visibility
  // instead of unmounting so the editor's compartments / history aren't
  // rebuilt every time the user flips the mode.
  const mdPreview = div('proj-md-preview');
  mdPreview.style.display = 'none';
  opts.editorHost.appendChild(mdPreview);

  function renderMarkdownInto(host: HTMLElement, source: string): void {
    // Two-stage safety: marked → DOMPurify (in renderMarkdownToSafeHTML) →
    // parsed into a DocumentFragment and appended. Using
    // createContextualFragment instead of innerHTML so the assignment isn't
    // textual `innerHTML =`; the parser still runs but on already-sanitised
    // markup. textContent first to clear any prior render.
    host.textContent = '';
    const safeHtml = renderMarkdownToSafeHTML(source);
    const fragment = document.createRange().createContextualFragment(safeHtml);
    host.appendChild(fragment);
  }

  function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    opts.statusHost.textContent = '';
    const cls = kind === 'error' ? 'proj-status-line proj-status-error' : 'proj-status-line';
    opts.statusHost.appendChild(span(text, cls));
    // For markdown files, append the Raw / Preview segmented control to the
    // status line. Switching tabs calls setStatus again so the toggle
    // re-renders for the new tab's mode.
    if (active !== null) {
      const tab = tabs.get(active);
      if (tab !== undefined && isMarkdownPath(tab.path)) {
        opts.statusHost.appendChild(buildMdToggle(tab));
      }
    }
  }

  function buildMdToggle(tab: TabState): HTMLElement {
    const group = div('md-mode-toggle');
    for (const mode of ['raw', 'preview'] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `md-mode-btn${tab.mdMode === mode ? ' is-active' : ''}`;
      btn.textContent = mode === 'raw' ? 'Raw' : 'Preview';
      btn.addEventListener('click', () => setMdMode(tab, mode));
      group.appendChild(btn);
    }
    return group;
  }

  function setMdMode(tab: TabState, mode: 'raw' | 'preview'): void {
    if (tab.mdMode === mode) return;
    tab.mdMode = mode;
    if (active === tab.path) applyMdView(tab);
    setStatus(tab.path); // re-render the toggle's active state
  }

  function applyMdView(tab: TabState): void {
    if (!isMarkdownPath(tab.path)) {
      editorWrap.classList.remove('is-hidden');
      mdPreview.style.display = 'none';
      return;
    }
    if (tab.mdMode === 'preview') {
      // Pull content from the live editor state when this tab is active so
      // unsaved edits are reflected when the student flips to Preview.
      const content = tab.path === active ? view.state.doc.toString() : tab.state.doc.toString();
      renderMarkdownInto(mdPreview, content);
      mdPreview.style.display = '';
      editorWrap.classList.add('is-hidden');
    } else {
      editorWrap.classList.remove('is-hidden');
      mdPreview.style.display = 'none';
    }
  }

  function isDirty(tab: TabState): boolean {
    return tab.state.doc.toString() !== tab.savedContent;
  }

  function renderTabs(): void {
    opts.tabsHost.textContent = '';
    if (openOrder.length === 0) {
      const empty = div('proj-tabs-empty');
      empty.appendChild(span('Click a file in the tree to open it.', 'muted'));
      opts.tabsHost.appendChild(empty);
      return;
    }
    for (const path of openOrder) {
      const tab = tabs.get(path);
      if (tab === undefined) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `proj-tab${path === active ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.dataset.path = path;
      const dirty = isDirty(tab);
      if (dirty) btn.appendChild(span('●', 'proj-tab-dirty'));
      btn.appendChild(span(path.split('/').pop() ?? path, 'proj-tab-name'));
      const close = document.createElement('span');
      close.className = 'proj-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close tab');
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(path);
      });
      btn.appendChild(close);
      btn.addEventListener('click', () => {
        if (active !== path) switchTo(path);
      });
      opts.tabsHost.appendChild(btn);
    }
  }

  function buildState(content: string, path: string): EditorState {
    const langExt = langExtensionForPath(path);
    const extensions = langExt === null ? [...baseExtensions(), updateListener] : [...baseExtensions(), langExt, updateListener];
    return EditorState.create({ doc: content, extensions });
  }

  function setViewToTab(path: string | null): void {
    active = path;
    if (path === null) {
      suppressUpdate = true;
      view.setState(EditorState.create({ doc: '', extensions: [...baseExtensions(), updateListener] }));
      suppressUpdate = false;
      // Reset the markdown preview pane so a stale render isn't visible after
      // the last tab is closed.
      mdPreview.style.display = 'none';
      mdPreview.textContent = '';
      editorWrap.classList.remove('is-hidden');
      setStatus('No file open.');
      return;
    }
    const tab = tabs.get(path);
    if (tab === undefined) return;
    suppressUpdate = true;
    view.setState(tab.state);
    suppressUpdate = false;
    applyMdView(tab);
    setStatus(path);
    renderTabs();
  }

  async function openFile(path: string): Promise<void> {
    if (tabs.has(path)) {
      switchTo(path);
      return;
    }
    setStatus(`Opening ${path}…`);
    let content: string;
    try {
      content = await fetchFile(opts.lang, path);
    } catch (e) {
      setStatus(`Failed to open ${path}: ${(e as Error).message}`, 'error');
      return;
    }
    const state = buildState(content, path);
    // Default markdown files to Preview on first open — students typically
    // want to *read* a README, not edit it. Toggling to Raw flips into the
    // editor view. Non-markdown files ignore this field.
    tabs.set(path, { path, state, savedContent: content, saveTimer: null, mdMode: 'preview' });
    openOrder.push(path);
    lspDidOpen(path, content);
    switchTo(path);
    notifyTabs();
  }

  function switchTo(path: string): void {
    if (!tabs.has(path)) return;
    const prev = active !== null ? tabs.get(active) : undefined;
    if (prev !== undefined) {
      prev.state = view.state;
    }
    setViewToTab(path);
    notifyTabs();
  }

  function closeTab(path: string): void {
    const tab = tabs.get(path);
    if (tab === undefined) return;
    if (tab.saveTimer !== null) {
      window.clearTimeout(tab.saveTimer);
      // Flush immediately so we don't lose a pending edit on close.
      void flushSave(tab);
    }
    tabs.delete(path);
    openOrder = openOrder.filter((p) => p !== path);
    lspDidClose(path);
    if (active === path) {
      const fallback = openOrder[openOrder.length - 1] ?? null;
      setViewToTab(fallback);
    } else {
      renderTabs();
    }
    notifyTabs();
  }

  function notifyTabs(): void {
    opts.onTabsChanged([...openOrder], active);
  }

  function scheduleSave(tab: TabState): void {
    if (tab.saveTimer !== null) window.clearTimeout(tab.saveTimer);
    tab.saveTimer = window.setTimeout(() => {
      tab.saveTimer = null;
      void flushSave(tab);
    }, SAVE_DEBOUNCE_MS);
    opts.onSaveStateChanged?.(tab.path, isDirty(tab));
  }

  async function flushSave(tab: TabState): Promise<void> {
    const content = tab.state.doc.toString();
    if (content === tab.savedContent) return;
    try {
      await writeFile(opts.lang, tab.path, content);
      tab.savedContent = content;
      opts.onSaveStateChanged?.(tab.path, false);
      renderTabs();
    } catch (e) {
      setStatus(`Save failed for ${tab.path}: ${(e as Error).message}`, 'error');
    }
  }

  async function saveAll(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const tab of tabs.values()) {
      if (tab.saveTimer !== null) {
        window.clearTimeout(tab.saveTimer);
        tab.saveTimer = null;
      }
      if (isDirty(tab)) pending.push(flushSave(tab));
    }
    await Promise.all(pending);
  }

  // Mod+S = save all (overrides single-buffer Ctrl+S = format)
  view.dom.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void saveAll();
    }
  });

  // Hydrate initial tabs.
  void (async (): Promise<void> => {
    for (const path of opts.initialOpenTabs) {
      try {
        const content = await fetchFile(opts.lang, path);
        const state = buildState(content, path);
        tabs.set(path, { path, state, savedContent: content, saveTimer: null, mdMode: 'preview' });
        openOrder.push(path);
        // Push hydrated tab content to the LSP. enqueueLsp handles the case
        // where connectLsp hasn't resolved yet — these calls queue and replay.
        lspDidOpen(path, content);
      } catch {
        // skip files that no longer exist
      }
    }
    const target = opts.initialActiveTab !== null && tabs.has(opts.initialActiveTab) ? opts.initialActiveTab : (openOrder[0] ?? null);
    setViewToTab(target);
    renderTabs();
    notifyTabs();
  })();

  // Default empty render so the tab strip isn't blank during hydration.
  renderTabs();
  setStatus(opts.initialOpenTabs.length === 0 ? 'No file open.' : 'Restoring tabs…');

  async function refreshFile(path: string): Promise<void> {
    const tab = tabs.get(path);
    if (tab === undefined) return;
    if (isDirty(tab)) {
      // Don't clobber unsaved edits. Status row is the only signal we surface
      // for now; future M3.5 could add a conflict prompt.
      setStatus(`${path} changed on disk — local edits kept (save to overwrite).`, 'error');
      return;
    }
    let content: string;
    try {
      content = await fetchFile(opts.lang, path);
    } catch (e) {
      setStatus(`Refresh failed for ${path}: ${(e as Error).message}`, 'error');
      return;
    }
    if (content === tab.savedContent) return; // unchanged
    const newState = buildState(content, path);
    tab.state = newState;
    tab.savedContent = content;
    if (active === path) {
      suppressUpdate = true;
      view.setState(newState);
      suppressUpdate = false;
      // Re-render the markdown preview if currently in preview mode — the
      // file just changed on disk, the rendered output needs to reflect that.
      applyMdView(tab);
    }
    renderTabs();
  }

  function renameTab(oldPath: string, newPath: string): void {
    const tab = tabs.get(oldPath);
    if (tab === undefined) return;
    const wasActive = active === oldPath;
    const content = tab.state.doc.toString();
    const dirty = isDirty(tab);
    if (tab.saveTimer !== null) {
      window.clearTimeout(tab.saveTimer);
      tab.saveTimer = null;
    }
    const newState = buildState(content, newPath);
    const newTab: TabState = {
      path: newPath,
      state: newState,
      savedContent: dirty ? '' : content, // preserve dirty status
      saveTimer: null,
      // Carry mdMode across so a rename within markdown preserves view state;
      // a rename that changes the extension to a non-md type just ignores it
      // (applyMdView's first guard returns the editor view).
      mdMode: tab.mdMode,
    };
    tabs.delete(oldPath);
    tabs.set(newPath, newTab);
    openOrder = openOrder.map((p) => (p === oldPath ? newPath : p));
    lspDidClose(oldPath);
    lspDidOpen(newPath, content);
    if (wasActive) {
      active = newPath;
      suppressUpdate = true;
      view.setState(newState);
      suppressUpdate = false;
      applyMdView(newTab);
      setStatus(newPath);
    }
    renderTabs();
    notifyTabs();
  }

  function forgetTab(path: string): void {
    const tab = tabs.get(path);
    if (tab === undefined) return;
    if (tab.saveTimer !== null) {
      window.clearTimeout(tab.saveTimer);
      tab.saveTimer = null;
    }
    tabs.delete(path);
    openOrder = openOrder.filter((p) => p !== path);
    lspDidClose(path);
    if (active === path) {
      const fallback = openOrder[openOrder.length - 1] ?? null;
      setViewToTab(fallback);
    } else {
      renderTabs();
    }
    notifyTabs();
  }

  async function revealAt(path: string, line: number, col: number): Promise<void> {
    // openFile is idempotent: already-open tabs short-circuit through switchTo.
    // For a fresh file it awaits the /fs/read fetch and only then switches the
    // view. Either way, after this returns the tab is the active one.
    await openFile(path);
    if (active !== path) return; // openFile failed (unreadable, deleted)
    const tab = tabs.get(path);
    if (tab === undefined) return;
    // If the file is markdown and the user landed in Preview mode, flip to Raw
    // so the cursor placement is actually visible. Build errors don't really
    // hit markdown, but the same revealAt API may serve other callers later.
    if (isMarkdownPath(path) && tab.mdMode === 'preview') {
      setMdMode(tab, 'raw');
    }
    const doc = view.state.doc;
    const safeLine = Math.max(1, Math.min(line, doc.lines));
    const lineObj = doc.line(safeLine);
    const safeCol = Math.max(0, Math.min(col - 1, lineObj.length));
    const offset = lineObj.from + safeCol;
    view.dispatch({
      selection: { anchor: offset },
      scrollIntoView: true,
    });
    view.focus();
  }

  return {
    openFile,
    switchTo,
    closeFile: closeTab,
    saveAll,
    refreshTabs: renderTabs,
    refreshFile,
    renameTab,
    forgetTab,
    revealAt,
    getOpenPaths(): string[] {
      return [...openOrder];
    },
    getOpenFiles(): Array<{ path: string; content: string; dirty: boolean }> {
      // The active tab's authoritative state lives on view.state, not the
      // cached tab.state — sync it before snapshotting.
      if (active !== null) {
        const tab = tabs.get(active);
        if (tab !== undefined) tab.state = view.state;
      }
      return openOrder
        .map((path) => {
          const tab = tabs.get(path);
          if (tab === undefined) return null;
          return { path, content: tab.state.doc.toString(), dirty: isDirty(tab) };
        })
        .filter((f): f is { path: string; content: string; dirty: boolean } => f !== null);
    },
    getLspClient(): LspClient | null {
      return lspClient;
    },
    destroy(): void {
      // Flush any in-flight saves.
      for (const tab of tabs.values()) {
        if (tab.saveTimer !== null) {
          window.clearTimeout(tab.saveTimer);
          void flushSave(tab);
        }
      }
      // Drop the LSP session — the supervisor reaps the child server-side.
      if (lspClient !== null) {
        const client = lspClient;
        lspClient = null;
        void client.dispose();
      }
      view.destroy();
    },
  };
}

export const __test__ = { langExtensionForPath };
