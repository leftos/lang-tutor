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

import { tutorHighlight, tutorTheme } from './editor';
import { fetchFile, writeFile } from './projectApi';
import type { LanguageId } from './types';

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
  destroy(): void;
}

interface TabState {
  path: string;
  state: EditorState;
  /** Last content that was saved to disk. Used for dirty tracking. */
  savedContent: string;
  /** Pending debounced-save timer. */
  saveTimer: number | null;
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
    scheduleSave(tab);
    renderTabs();
  });

  const view = new EditorView({
    parent: opts.editorHost,
    state: EditorState.create({ doc: '', extensions: [...baseExtensions(), updateListener] }),
  });

  view.dom.style.height = '100%';

  function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    opts.statusHost.textContent = '';
    const cls = kind === 'error' ? 'proj-status-line proj-status-error' : 'proj-status-line';
    opts.statusHost.appendChild(span(text, cls));
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
      setStatus('No file open.');
      return;
    }
    const tab = tabs.get(path);
    if (tab === undefined) return;
    suppressUpdate = true;
    view.setState(tab.state);
    suppressUpdate = false;
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
    tabs.set(path, { path, state, savedContent: content, saveTimer: null });
    openOrder.push(path);
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
        tabs.set(path, { path, state, savedContent: content, saveTimer: null });
        openOrder.push(path);
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
    };
    tabs.delete(oldPath);
    tabs.set(newPath, newTab);
    openOrder = openOrder.map((p) => (p === oldPath ? newPath : p));
    if (wasActive) {
      active = newPath;
      suppressUpdate = true;
      view.setState(newState);
      suppressUpdate = false;
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
    if (active === path) {
      const fallback = openOrder[openOrder.length - 1] ?? null;
      setViewToTab(fallback);
    } else {
      renderTabs();
    }
    notifyTabs();
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
    destroy(): void {
      // Flush any in-flight saves.
      for (const tab of tabs.values()) {
        if (tab.saveTimer !== null) {
          window.clearTimeout(tab.saveTimer);
          void flushSave(tab);
        }
      }
      view.destroy();
    },
  };
}

export const __test__ = { langExtensionForPath };
