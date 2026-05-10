/**
 * File tree sidebar for project-kind languages.
 *
 * Pure rendering: takes an FsNode and a callback, builds a clickable tree.
 * State (which directories are expanded) lives in a Set<string> of paths.
 * Built with document.createElement only — never innerHTML — so user file
 * names can't inject markup.
 */

import type { FsNode } from './types';

export interface OpenInOption {
  /** Stable id sent back to onOpenIn. */
  readonly id: string;
  /** Visible label in the dropdown. */
  readonly label: string;
  /** Whether the target is currently launchable; greyed out otherwise. */
  readonly available: boolean;
  /** Tooltip shown when unavailable. */
  readonly unavailableHint?: string;
}

export interface FileTreeOptions {
  /** Called when the user clicks a file row. */
  onOpenFile: (path: string) => void;
  /** Called when the user clicks the "+ file" header button. */
  onCreateFile: () => void;
  /** Called when the user clicks the "+ folder" header button. */
  onCreateFolder: () => void;
  /** Called when the user clicks a row's rename action. */
  onRename: (path: string, isDir: boolean) => void;
  /** Called when the user clicks a row's delete action. */
  onDelete: (path: string, isDir: boolean) => void;
  /** Currently focused file path — gets a highlight class. */
  activePath: string | null;
  /** Header label shown above the tree, e.g. "projects/web/". */
  headerLabel: string;
  /** External-editor / file-manager options for the "Open in ▾" header dropdown. Empty array hides the button. */
  openInOptions: readonly OpenInOption[];
  /** Called when the user picks an enabled item from the "Open in ▾" dropdown. */
  onOpenIn: (id: string) => void;
}

export interface FileTreeHandle {
  render(tree: FsNode | null): void;
  setActive(path: string | null): void;
  expandPath(path: string): void;
  /** Replace the "Open in ▾" dropdown's options (e.g. once the availability probe resolves). */
  setOpenInOptions(options: readonly OpenInOption[]): void;
}

const COLLAPSED_BY_DEFAULT = new Set<string>(['node_modules', '.vite', 'dist']);

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

export function createFileTree(host: HTMLElement, options: FileTreeOptions): FileTreeHandle {
  const expanded = new Set<string>(['']);
  let activePath = options.activePath;
  let currentTree: FsNode | null = null;
  let openInOptions: readonly OpenInOption[] = options.openInOptions;

  function renderNode(node: FsNode, depth: number): HTMLElement {
    if (node.type === 'dir') return renderDir(node, depth);
    return renderFile(node, depth);
  }

  function makeActions(path: string, isDir: boolean): HTMLElement {
    const actions = div('tree-row-actions');

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'tree-action';
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename ${path}`);
    rename.textContent = '✎';
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onRename(path, isDir);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tree-action';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete ${path}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onDelete(path, isDir);
    });

    actions.appendChild(rename);
    actions.appendChild(del);
    return actions;
  }

  function renderDir(node: FsNode & { type: 'dir' }, depth: number): HTMLElement {
    const isOpen = expanded.has(node.path);
    const wrapper = div('tree-node', 'tree-dir');

    const row = div('tree-row');
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    const chevron = span(isOpen ? '▾' : '▸', 'tree-chevron');
    const label = span(node.name || 'workspace', 'tree-label', 'tree-label-dir');
    row.appendChild(chevron);
    row.appendChild(label);
    row.appendChild(makeActions(node.path, true));

    row.addEventListener('click', () => {
      if (expanded.has(node.path)) {
        expanded.delete(node.path);
      } else {
        expanded.add(node.path);
      }
      doRender();
    });

    wrapper.appendChild(row);

    if (isOpen && node.children.length > 0) {
      const childrenBox = div('tree-children');
      for (const child of node.children) {
        childrenBox.appendChild(renderNode(child, depth + 1));
      }
      wrapper.appendChild(childrenBox);
    }
    return wrapper;
  }

  function renderFile(node: FsNode & { type: 'file' }, depth: number): HTMLElement {
    const wrapper = div('tree-node', 'tree-file');
    const row = div('tree-row');
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    if (node.path === activePath) row.classList.add('is-active');

    const indent = span('', 'tree-chevron-spacer');
    const label = span(node.name, 'tree-label', 'tree-label-file');
    row.appendChild(indent);
    row.appendChild(label);
    row.appendChild(makeActions(node.path, false));
    row.addEventListener('click', () => options.onOpenFile(node.path));

    wrapper.appendChild(row);
    return wrapper;
  }

  function renderHeader(): HTMLElement {
    const header = div('tree-header');
    const title = span(options.headerLabel, 'tree-header-title');
    header.appendChild(title);

    const newFileBtn = document.createElement('button');
    newFileBtn.type = 'button';
    newFileBtn.className = 'tree-header-action';
    newFileBtn.title = 'New file';
    newFileBtn.setAttribute('aria-label', 'New file');
    newFileBtn.textContent = '+ file';
    newFileBtn.addEventListener('click', options.onCreateFile);
    header.appendChild(newFileBtn);

    const newFolderBtn = document.createElement('button');
    newFolderBtn.type = 'button';
    newFolderBtn.className = 'tree-header-action';
    newFolderBtn.title = 'New folder';
    newFolderBtn.setAttribute('aria-label', 'New folder');
    newFolderBtn.textContent = '+ dir';
    newFolderBtn.addEventListener('click', options.onCreateFolder);
    header.appendChild(newFolderBtn);

    if (openInOptions.length > 0) {
      header.appendChild(renderOpenInButton());
    }

    return header;
  }

  function renderOpenInButton(): HTMLElement {
    const wrapper = div('tree-header-openin');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-header-action';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Open the project in an external editor or file manager';
    btn.appendChild(document.createTextNode('open in '));
    const caret = span('▾', 'tree-header-openin-caret');
    btn.appendChild(caret);

    const menu = div('tree-header-openin-menu');
    menu.setAttribute('role', 'menu');
    menu.style.display = 'none';

    for (const option of openInOptions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tree-header-openin-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = option.label;
      if (!option.available) {
        item.classList.add('is-disabled');
        item.disabled = true;
        item.title = option.unavailableHint ?? 'Not available';
      } else {
        item.addEventListener('click', () => {
          closeMenu();
          options.onOpenIn(option.id);
        });
      }
      menu.appendChild(item);
    }

    function openMenu(): void {
      menu.style.display = 'block';
      btn.setAttribute('aria-expanded', 'true');
      // Close on next outside-click. Capture phase so a click on a tree row
      // also closes the menu before triggering its own handler.
      setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
      document.addEventListener('keydown', onEscape);
    }

    function closeMenu(): void {
      menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onEscape);
    }

    function onOutside(e: MouseEvent): void {
      if (!wrapper.contains(e.target as Node)) closeMenu();
    }

    function onEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        closeMenu();
        btn.focus();
      }
    }

    btn.addEventListener('click', () => {
      if (menu.style.display === 'none') openMenu();
      else closeMenu();
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    return wrapper;
  }

  function doRender(): void {
    host.textContent = '';
    host.appendChild(renderHeader());

    if (currentTree === null) {
      const empty = div('tree-empty');
      empty.appendChild(span('Loading workspace…', 'muted'));
      host.appendChild(empty);
      return;
    }
    if (currentTree.type === 'dir' && currentTree.children.length === 0) {
      const empty = div('tree-empty');
      empty.appendChild(span('No files yet.', 'muted'));
      host.appendChild(empty);
      return;
    }

    if (currentTree.type === 'dir') {
      // Don't show the root row itself — render children directly so the
      // sidebar isn't a single-item nesting.
      const root = div('tree-root');
      for (const child of currentTree.children) {
        if (child.type === 'dir' && COLLAPSED_BY_DEFAULT.has(child.name) && !expanded.has(child.path)) {
          // ensure these stay collapsed unless the user has opened them
        }
        root.appendChild(renderNode(child, 0));
      }
      host.appendChild(root);
    } else {
      host.appendChild(renderNode(currentTree, 0));
    }
  }

  return {
    render(tree: FsNode | null): void {
      currentTree = tree;
      doRender();
    },
    setActive(path: string | null): void {
      activePath = path;
      doRender();
    },
    expandPath(path: string): void {
      // Expand all ancestor directories of the given path.
      const parts = path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc === '' ? (parts[i] ?? '') : `${acc}/${parts[i] ?? ''}`;
        expanded.add(acc);
      }
      doRender();
    },
    setOpenInOptions(opts: readonly OpenInOption[]): void {
      openInOptions = opts;
      doRender();
    },
  };
}
