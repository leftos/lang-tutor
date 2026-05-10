import './style.css';
import { callClaude, fetchProgressExtraction } from './api';
import {
  ACTIVE_LANG_KEY,
  activeTabKey,
  codeKey,
  DEFAULT_LANGUAGE,
  getLanguage,
  historyKey,
  LANGUAGE_IDS,
  LANGUAGES,
  MAX_HISTORY,
  openTabsKey,
  progressKey,
} from './constants';
import { createEditor, type TutorEditor } from './editor';
import { createFileTree, type FileTreeHandle, type OpenInOption } from './fileTree';
import {
  deleteFile as apiDeleteFile,
  mkdir as apiMkdir,
  renameFile as apiRenameFile,
  writeFile as apiWriteFile,
  ensureScaffold,
  type FsWatchEvent,
  fetchOpenAvailability,
  fetchRecentLogs,
  fetchTree,
  flattenFiles,
  type OpenAvailability,
  type OpenTarget,
  openProjectExternal,
  subscribeFsEvents,
} from './projectApi';
import { createProjectEditor, type ProjectEditor } from './projectEditor';
import { createProjectPreview, type ProjectPreview } from './projectPreview';
import { renderMarkdown, renderPlainWithFences } from './render';
import { runCode } from './runners';
import { storageDelete, storageGet, storageSet } from './storage';
import type { Language, LanguageId, Message, Progress, ProjectState, SingleBufferLanguageId, TopicStatus } from './types';
import { isSingleBufferLanguage } from './types';

const THEME_KEY = 'lang-tutor:theme';

// ── State ─────────────────────────────────────────────────────────────────
let activeLang: LanguageId = DEFAULT_LANGUAGE;
let history: Message[] = [];
let progress: Progress | null = null;
let currentSystemPrompt = '';
let extractionQueued = false;
let isSending = false;
let editor: TutorEditor;
// Per-language project state. Project-kind languages (e.g. 'web') own
// files on disk; this map caches the tree + tab UI state in memory.
const projectStates = new Map<LanguageId, ProjectState>();

// ── DOM helpers ───────────────────────────────────────────────────────────
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} not found`);
  return found as T;
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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Theme ─────────────────────────────────────────────────────────────────
function applyStoredTheme(): void {
  const stored = storageGet<string>(THEME_KEY);
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function toggleTheme(): void {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Cycle: auto → opposite of system → opposite of that → auto
  // Simpler: if currently auto, lock to opposite of system. Otherwise flip.
  let next: 'light' | 'dark';
  if (current === null) {
    next = systemDark ? 'light' : 'dark';
  } else if (current === 'dark') {
    next = 'light';
  } else {
    next = 'dark';
  }
  root.setAttribute('data-theme', next);
  storageSet(THEME_KEY, next);
}

// ── System prompt builder ─────────────────────────────────────────────────
function buildSystem(prog: Progress | null, lang: Language): string {
  if (prog === null) return `${lang.systemPromptIntro}\n\n${lang.firstSessionPrompt}`;

  const topicLines = lang.topics
    .map((t) => {
      const s = prog.topics?.find((x) => x.id === t.id)?.status ?? 'not-started';
      return `  ${s === 'mastered' ? '✓' : s === 'in-progress' ? '→' : '○'} ${t.title} [${s}]`;
    })
    .join('\n');

  const strengths = prog.strengths && prog.strengths.length > 0 ? prog.strengths.map((s) => `  + ${s}`).join('\n') : '  (none yet)';
  const struggles = prog.struggles && prog.struggles.length > 0 ? prog.struggles.map((s) => `  ! ${s}`).join('\n') : '  (none yet)';

  return (
    `${lang.systemPromptIntro}\n\n` +
    `RETURNING STUDENT — ${prog.sessionCount ?? 1} session(s) so far.\n` +
    `Experience: ${prog.experienceLevel ?? 'unknown'}\n` +
    `Current topic: ${prog.currentTopic ?? 'beginning'}\n\n` +
    `Lesson plan:\n${topicLines}\n\n` +
    `Strengths:\n${strengths}\n\n` +
    `Struggles:\n${struggles}\n\n` +
    `Notes: ${prog.overallNotes ?? 'none'}\n\n` +
    `Welcome the student back, briefly remind them where they left off, and continue from "${prog.currentTopic ?? 'the beginning'}". ` +
    `Reference their strengths and give extra attention to their struggles.`
  );
}

// ── Header / chapter strip ────────────────────────────────────────────────
function findCurrentTopicIndex(prog: Progress | null, lang: Language): number {
  if (prog === null) return -1;
  if (prog.currentTopic !== undefined) {
    const needle = prog.currentTopic.toLowerCase();
    const matchIdx = lang.topics.findIndex((t) => t.title.toLowerCase().includes(needle) || needle.includes(t.title.toLowerCase()));
    if (matchIdx !== -1) return matchIdx;
  }
  // Fallback: first in-progress topic, then first not-started after the last mastered.
  const inProg = lang.topics.findIndex((t) => prog.topics?.find((p) => p.id === t.id)?.status === 'in-progress');
  if (inProg !== -1) return inProg;
  const lastMastered = (() => {
    for (let i = lang.topics.length - 1; i >= 0; i--) {
      const topic = lang.topics[i];
      if (topic === undefined) continue;
      if (prog.topics?.find((p) => p.id === topic.id)?.status === 'mastered') return i;
    }
    return -1;
  })();
  return Math.min(lastMastered + 1, lang.topics.length - 1);
}

function renderChapterStrip(): void {
  const lang = getLanguage(activeLang);
  const folio = el('folio');
  const name = el('chapterName');
  const meta = el('chapterMeta');

  if (progress === null) {
    folio.textContent = 'Pg. —';
    name.textContent = 'A blank page';
    meta.textContent = `awaiting first ${lang.name} session`;
    return;
  }

  const idx = findCurrentTopicIndex(progress, lang);
  const topic = idx >= 0 ? lang.topics[idx] : undefined;
  folio.textContent = topic !== undefined ? `Ch. ${pad2(idx + 1)}` : 'Pg. —';
  name.textContent = progress.currentTopic ?? topic?.title ?? 'In progress';

  const sessionN = progress.sessionCount ?? 1;
  const last = progress.lastSeen ?? '';
  meta.textContent = last ? `session ${pad2(sessionN)} · last seen ${last}` : `session ${pad2(sessionN)}`;
}

function renderLanguageRail(): void {
  for (const id of LANGUAGE_IDS) {
    const tab = document.querySelector<HTMLButtonElement>(`.lang-tab[data-lang="${id}"]`);
    const meta = document.querySelector<HTMLSpanElement>(`[data-lang-meta="${id}"]`);
    if (tab !== null) tab.classList.toggle('is-active', id === activeLang);
    if (meta === null) continue;
    const langProg = id === activeLang ? progress : storageGet<Progress>(progressKey(id));
    const langDef = LANGUAGES[id];
    if (langProg === null) {
      meta.textContent = `${pad2(0)} · ${pad2(langDef.topics.length)}`;
    } else {
      const mastered = (langProg.topics ?? []).filter((t) => t.status === 'mastered').length;
      meta.textContent = `${pad2(mastered)} · ${pad2(langDef.topics.length)}`;
    }
  }
}

function renderFileSpec(): void {
  const spec = el('fileSpec');
  const lang = getLanguage(activeLang);
  const map: Record<LanguageId, string> = {
    rust: 'edition 2021 · stable',
    cpp: 'gcc · c++23',
    python: 'pyodide · 3.12',
    csharp: 'c# 12 · run in vs/rider',
    web: 'vite · http://localhost:5180',
  };
  spec.textContent = map[lang.id];
}

// ── Progress badge ────────────────────────────────────────────────────────
function updateProgBadge(text: string | null): void {
  const badge = el('progBadge');
  if (text !== null) {
    badge.textContent = text;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function updateProgCount(): void {
  const lang = getLanguage(activeLang);
  const mastered = (progress?.topics ?? []).filter((t) => t.status === 'mastered').length;
  const progCount = el('progCount');
  if (mastered > 0) {
    progCount.textContent = `${pad2(mastered)} · ${pad2(lang.topics.length)}`;
    progCount.style.display = 'inline';
  } else {
    progCount.style.display = 'none';
  }
}

// ── Lesson plan renderer ──────────────────────────────────────────────────
function progSectionLabel(text: string): HTMLDivElement {
  const d = div('prog-section-label');
  d.textContent = text;
  return d;
}

function renderProgressTab(): void {
  const lang = getLanguage(activeLang);
  const scroll = el('progressScroll');
  scroll.textContent = '';

  if (progress === null) {
    const empty = div('prog-empty');
    const glyph = span('§', 'empty-glyph');
    empty.appendChild(glyph);
    empty.appendChild(document.createTextNode(`No ${lang.name} progress recorded yet.\nFinish an evaluation to begin tracking.`));
    scroll.appendChild(empty);
    return;
  }

  // ── Summary ──
  const overall = div('prog-section');
  overall.appendChild(progSectionLabel(`${lang.name} progress`));

  const done = (progress.topics ?? []).filter((t) => t.status === 'mastered').length;
  const total = lang.topics.length;
  const pct = Math.round((done / total) * 100);

  const summary = div('prog-summary-line');
  summary.appendChild(document.createTextNode('You have mastered '));
  const doneStrong = document.createElement('strong');
  doneStrong.textContent = String(done);
  summary.appendChild(doneStrong);
  summary.appendChild(document.createTextNode(' of '));
  const totalStrong = document.createElement('strong');
  totalStrong.textContent = String(total);
  summary.appendChild(totalStrong);
  summary.appendChild(document.createTextNode(' topics — '));
  const pctEm = document.createElement('em');
  pctEm.textContent = `${pct}%`;
  summary.appendChild(pctEm);
  summary.appendChild(document.createTextNode('.'));
  overall.appendChild(summary);

  const track = div('prog-bar-track');
  const fill = div('prog-bar-fill');
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  overall.appendChild(track);

  const barMeta = div('prog-bar-meta');
  barMeta.appendChild(span(`session ${pad2(progress.sessionCount ?? 1)}`));
  barMeta.appendChild(span(progress.lastSeen ? `last seen ${progress.lastSeen}` : ''));
  overall.appendChild(barMeta);
  scroll.appendChild(overall);

  // ── Topics ──
  const planSection = div('prog-section');
  planSection.appendChild(progSectionLabel('Lesson plan'));

  lang.topics.forEach((t, i) => {
    const status = progress?.topics?.find((x) => x.id === t.id)?.status ?? 'not-started';
    const isCurrent =
      progress?.currentTopic !== undefined &&
      (t.title === progress.currentTopic || t.title.toLowerCase().includes(progress.currentTopic.toLowerCase()));

    const row = div('topic-row');
    row.appendChild(span(pad2(i + 1), 'topic-num'));

    const glyphCls = status === 'mastered' ? 'is-mastered' : status === 'in-progress' ? 'is-active' : 'is-empty';
    const glyph = div('topic-glyph', glyphCls);
    if (status === 'mastered') glyph.textContent = '✓';
    row.appendChild(glyph);

    const titleCls = status === 'mastered' ? 'is-mastered' : status === 'in-progress' ? 'is-active' : 'is-empty';
    row.appendChild(span(t.title, 'topic-title', titleCls));

    if (isCurrent && status === 'in-progress') {
      row.appendChild(span('here', 'topic-here'));
    }

    planSection.appendChild(row);
  });
  scroll.appendChild(planSection);

  // ── Going well ──
  const strengthsSection = div('prog-section');
  strengthsSection.appendChild(progSectionLabel('Going well'));
  const strengthsRow = div('note-row');
  if (progress.strengths && progress.strengths.length > 0) {
    for (const s of progress.strengths) {
      const p = div('note-pill', 'note-pill--good');
      p.appendChild(span('+', 'pill-marker'));
      p.appendChild(document.createTextNode(s));
      strengthsRow.appendChild(p);
    }
  } else {
    strengthsRow.appendChild(span('Nothing recorded yet', 'muted'));
  }
  strengthsSection.appendChild(strengthsRow);
  scroll.appendChild(strengthsSection);

  // ── Needs work ──
  const strugglesSection = div('prog-section');
  strugglesSection.appendChild(progSectionLabel('Needs work'));
  const strugglesRow = div('note-row');
  if (progress.struggles && progress.struggles.length > 0) {
    for (const s of progress.struggles) {
      const p = div('note-pill', 'note-pill--bad');
      p.appendChild(span('!', 'pill-marker'));
      p.appendChild(document.createTextNode(s));
      strugglesRow.appendChild(p);
    }
  } else {
    strugglesRow.appendChild(span('Nothing recorded yet', 'muted'));
  }
  strugglesSection.appendChild(strugglesRow);
  scroll.appendChild(strugglesSection);

  // ── Notes ──
  if (progress.overallNotes) {
    const notesSection = div('prog-section');
    notesSection.appendChild(progSectionLabel('Marginalia'));
    const notesText = div('prog-notes');
    notesText.textContent = progress.overallNotes;
    notesSection.appendChild(notesText);
    scroll.appendChild(notesSection);
  }
}

// ── Message rendering ─────────────────────────────────────────────────────
function appendMsg(role: 'user' | 'assistant', text: string): void {
  const msgList = el('msgList');
  const bl = div('msg-block');
  const lbl = div('msg-label');
  lbl.textContent = role === 'user' ? 'you' : 'tutor';
  const body = div(role === 'user' ? 'msg-you' : 'msg-ai');
  body.appendChild(role === 'user' ? renderPlainWithFences(text) : renderMarkdown(text));
  bl.appendChild(lbl);
  bl.appendChild(body);
  msgList.appendChild(bl);
  msgList.scrollTop = msgList.scrollHeight;
}

let thinkingEl: HTMLElement | null = null;

function showThinking(): void {
  const wrapper = div('msg-block');
  const lbl = div('msg-label');
  lbl.textContent = 'tutor';
  const body = div('msg-ai');
  body.appendChild(span('···', 'thinking'));
  wrapper.appendChild(lbl);
  wrapper.appendChild(body);
  thinkingEl = wrapper;
  const msgList = el('msgList');
  msgList.appendChild(thinkingEl);
  msgList.scrollTop = msgList.scrollHeight;
}

function removeThinking(): void {
  thinkingEl?.remove();
  thinkingEl = null;
}

interface StreamingBubble {
  onDelta(chunk: string): void;
  finalize(): void;
}

function appendErrorMsg(text: string, onRetry: () => void): void {
  const msgList = el('msgList');
  const bl = div('msg-block', 'is-error');
  const lbl = div('msg-label');
  lbl.textContent = 'tutor';
  const body = div('msg-error');

  const errText = div('msg-error-text');
  errText.textContent = text;
  body.appendChild(errText);

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'retry-btn';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', () => {
    if (isSending) return;
    bl.remove();
    onRetry();
  });
  body.appendChild(retryBtn);

  bl.appendChild(lbl);
  bl.appendChild(body);
  msgList.appendChild(bl);
  msgList.scrollTop = msgList.scrollHeight;
}

// If the previous turn failed, the trailing history entry is a user message
// with no assistant reply. Mark its bubble as not-delivered and remove the
// trailing error bubble. Caller is responsible for popping history.
function discardPendingFailure(): void {
  const msgList = el('msgList');
  for (const block of msgList.querySelectorAll<HTMLElement>('.msg-block.is-error')) {
    block.remove();
  }
  const blocks = msgList.querySelectorAll<HTMLElement>('.msg-block');
  const last = blocks[blocks.length - 1];
  if (last !== undefined && last.querySelector('.msg-you') !== null && !last.classList.contains('is-not-delivered')) {
    last.classList.add('is-not-delivered');
    const caption = div('msg-not-delivered');
    caption.textContent = '(not delivered)';
    last.appendChild(caption);
  }
}

function appendMsgStreaming(): StreamingBubble {
  const msgList = el('msgList');
  const bl = div('msg-block');
  const lbl = div('msg-label');
  lbl.textContent = 'tutor';
  const body = div('msg-ai');
  bl.appendChild(lbl);
  bl.appendChild(body);
  msgList.appendChild(bl);

  let accumulated = '';
  let scheduled = false;

  const render = (): void => {
    body.textContent = '';
    body.appendChild(renderMarkdown(accumulated));
    msgList.scrollTop = msgList.scrollHeight;
  };

  return {
    onDelta(chunk: string): void {
      accumulated += chunk;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          render();
        });
      }
    },
    finalize(): void {
      render();
    },
  };
}

function setSendingState(sending: boolean): void {
  isSending = sending;
  el<HTMLTextAreaElement>('chatInput').disabled = sending;
  el<HTMLButtonElement>('sendBtn').disabled = sending;
  el<HTMLButtonElement>('evalBtn').disabled = sending || history.length === 0;
}

// ── Start screen ──────────────────────────────────────────────────────────
function showStartScreen(): void {
  const msgList = el('msgList');
  const lang = getLanguage(activeLang);

  const screen = div('start-screen');
  screen.id = 'startScreen';

  const folio = div('start-folio');
  folio.textContent = `vol. ${pad2(LANGUAGE_IDS.indexOf(lang.id) + 1)} · ${lang.name.toLowerCase()}`;
  screen.appendChild(folio);

  const rule = div('start-rule');
  screen.appendChild(rule);

  const glyph = div('start-glyph');
  glyph.textContent = '§';
  screen.appendChild(glyph);

  const title = document.createElement('h2');
  title.className = 'start-title';
  title.textContent = `A new ${lang.name} reader.`;
  screen.appendChild(title);

  const body = div('start-body');
  body.textContent = `An interactive manual. Write code in the workshop, run it, and submit your work for review. The tutor adapts to where you are.`;
  screen.appendChild(body);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'start-btn';
  button.appendChild(document.createTextNode(`Open the book`));
  const arrow = document.createElement('i');
  arrow.className = 'ti ti-arrow-narrow-right';
  arrow.setAttribute('aria-hidden', 'true');
  button.appendChild(arrow);
  button.addEventListener('click', () => void startSession());
  screen.appendChild(button);

  msgList.appendChild(screen);
}

function renderChatView(): void {
  const msgList = el('msgList');
  msgList.textContent = '';

  if (history.length > 0) {
    for (const msg of history) appendMsg(msg.role, msg.content);
    el('inputRow').style.display = 'flex';
    el('resetBtn').style.display = 'inline-flex';
  } else {
    showStartScreen();
    el('inputRow').style.display = 'none';
    el('resetBtn').style.display = 'none';
  }
  el<HTMLButtonElement>('evalBtn').disabled = isSending || history.length === 0;
}

function clearOutput(): void {
  const outputPre = el<HTMLPreElement>('outputPre');
  outputPre.style.color = '';
  outputPre.textContent = '';
  outputPre.appendChild(span('Run the program to capture its output here.', 'muted'));
}

// ── Single-buffer vs project workshop layout ─────────────────────────────
const SINGLE_BUFFER_IDS = new Set(['fileLabel', 'fileSpec', 'evalBtn', 'runBtn', 'codeArea', 'resizeBar', 'outputPre']);

function setWorkshopMode(mode: 'single' | 'project'): void {
  const isProject = mode === 'project';
  for (const id of SINGLE_BUFFER_IDS) {
    el(id).style.display = isProject ? 'none' : '';
  }
  const eyebrow = document.querySelector<HTMLElement>('.output-eyebrow');
  if (eyebrow !== null) eyebrow.style.display = isProject ? 'none' : '';

  el('projectWorkspace').style.display = isProject ? 'flex' : 'none';
}

// ── Lazy project UI (rebuilt when the active project language changes) ────
let projectEditorInstance: ProjectEditor | null = null;
let projectFileTree: FileTreeHandle | null = null;
let projectPreviewInstance: ProjectPreview | null = null;
let projectFsUnsub: (() => void) | null = null;
let currentProjectUILang: LanguageId | null = null;
export function _getProjectPreview(): ProjectPreview | null {
  return projectPreviewInstance;
}

// ── External-editor "Open in ▾" availability ─────────────────────────────
//
// Probed once per page load via /proj/open/targets. Per-language filter
// applied at render time — Visual Studio is hidden for web (not a web tool).

let openAvailability: OpenAvailability | null = null;
let openAvailabilityPromise: Promise<OpenAvailability> | null = null;

const OPEN_TARGETS_BY_LANG: Record<LanguageId, readonly { id: OpenTarget; label: string }[]> = {
  rust: [],
  cpp: [],
  python: [],
  csharp: [
    { id: 'vscode', label: 'VS Code' },
    { id: 'vs', label: 'Visual Studio' },
    { id: 'explorer', label: 'File Explorer' },
  ],
  web: [
    { id: 'vscode', label: 'VS Code' },
    { id: 'explorer', label: 'File Explorer' },
  ],
};

function ensureOpenAvailability(): Promise<OpenAvailability> {
  if (openAvailabilityPromise === null) {
    openAvailabilityPromise = fetchOpenAvailability().then((a) => {
      openAvailability = a;
      return a;
    });
  }
  return openAvailabilityPromise;
}

function buildOpenInOptions(id: LanguageId): OpenInOption[] {
  const cfg = OPEN_TARGETS_BY_LANG[id];
  return cfg.map((entry): OpenInOption => {
    const available = openAvailability !== null ? openAvailability[entry.id] : true;
    if (available) {
      return { id: entry.id, label: entry.label, available: true };
    }
    return { id: entry.id, label: entry.label, available: false, unavailableHint: `${entry.label} not found on PATH` };
  });
}

async function openExternal(id: LanguageId, target: string): Promise<void> {
  // The dropdown only fires onOpenIn for items with ids declared in OPEN_TARGETS_BY_LANG,
  // so the cast is safe; defend at runtime anyway.
  const valid = OPEN_TARGETS_BY_LANG[id].some((o) => o.id === target);
  if (!valid) return;
  try {
    const result = await openProjectExternal(id, target as OpenTarget);
    if (!result.ok) alert(`Could not open: ${result.error ?? 'unknown error'}`);
  } catch (e) {
    alert(`Could not open: ${(e as Error).message}`);
  }
}

function destroyProjectUI(): void {
  projectFsUnsub?.();
  projectFsUnsub = null;
  projectEditorInstance?.destroy();
  projectPreviewInstance?.destroy();
  projectEditorInstance = null;
  projectPreviewInstance = null;
  projectFileTree = null;
  // Clear DOM hosts so the next createX() builds into clean containers.
  el('projTree').textContent = '';
  el('projTabs').textContent = '';
  el('projEditor').textContent = '';
  el('projStatus').textContent = '';
  el('projPreviewBody').textContent = '';
  el('projPreviewTabs').textContent = '';
  el('projPreviewStatus').textContent = 'stopped';
  currentProjectUILang = null;
}

async function refreshTree(id: LanguageId): Promise<void> {
  try {
    const response = await fetchTree(id);
    const cached = projectStates.get(id);
    if (cached !== undefined) {
      cached.tree = response.tree;
      cached.scaffolded = response.scaffolded;
    }
    projectFileTree?.render(response.tree);
  } catch (e) {
    console.error('[project] tree refresh failed', e);
  }
}

async function createFile(id: LanguageId): Promise<void> {
  const path = window.prompt('New file path (relative to project root):', '');
  if (path === null || path.trim() === '') return;
  try {
    await apiWriteFile(id, path.trim(), '');
    await refreshTree(id);
    await projectEditorInstance?.openFile(path.trim());
  } catch (e) {
    alert(`Could not create file: ${(e as Error).message}`);
  }
}

async function createFolder(id: LanguageId): Promise<void> {
  const path = window.prompt('New folder path (relative to project root):', '');
  if (path === null || path.trim() === '') return;
  try {
    await apiMkdir(id, path.trim());
    await refreshTree(id);
  } catch (e) {
    alert(`Could not create folder: ${(e as Error).message}`);
  }
}

async function renamePath(id: LanguageId, oldPath: string): Promise<void> {
  const next = window.prompt('Rename to (relative path):', oldPath);
  if (next === null) return;
  const target = next.trim();
  if (target === '' || target === oldPath) return;
  try {
    await apiRenameFile(id, oldPath, target);
    projectEditorInstance?.renameTab(oldPath, target);
    await refreshTree(id);
  } catch (e) {
    alert(`Rename failed: ${(e as Error).message}`);
  }
}

async function deletePath(id: LanguageId, path: string, isDir: boolean): Promise<void> {
  const label = isDir ? `folder ${path} and everything in it` : `file ${path}`;
  if (!confirm(`Delete ${label}?`)) return;
  try {
    await apiDeleteFile(id, path);
    projectEditorInstance?.forgetTab(path);
    await refreshTree(id);
  } catch (e) {
    alert(`Delete failed: ${(e as Error).message}`);
  }
}

function handleFsEvent(id: LanguageId, event: FsWatchEvent): void {
  if (event.type === 'ready' || event.type === 'error') return;
  const eventPath = event.path;
  if (eventPath === undefined) return;

  // Tree-shape changes always invalidate the tree render.
  void refreshTree(id);

  // Per-file content refresh: only when an open tab's file was modified.
  if (event.type === 'change' && projectEditorInstance?.getOpenPaths().includes(eventPath)) {
    void projectEditorInstance.refreshFile(eventPath);
  }
  // If an open tab's file was deleted, drop the tab.
  if (event.type === 'unlink' && projectEditorInstance?.getOpenPaths().includes(eventPath)) {
    projectEditorInstance.forgetTab(eventPath);
  }
}

function ensureProjectUI(id: LanguageId, lang: Language): void {
  if (lang.kind !== 'project') return;
  if (currentProjectUILang === id) return;
  if (currentProjectUILang !== null) destroyProjectUI();

  const state = projectStates.get(id) ?? loadProjectStateFromStorage(id);
  projectStates.set(id, state);

  projectFileTree = createFileTree(el('projTree'), {
    activePath: state.activeTab,
    headerLabel: `projects/${lang.scaffoldDir}/`,
    openInOptions: buildOpenInOptions(id),
    onOpenIn: (target) => void openExternal(id, target),
    onOpenFile: (path) => {
      void projectEditorInstance?.openFile(path);
      projectFileTree?.setActive(path);
    },
    onCreateFile: () => void createFile(id),
    onCreateFolder: () => void createFolder(id),
    onRename: (path) => void renamePath(id, path),
    onDelete: (path, isDir) => void deletePath(id, path, isDir),
  });
  // Probe availability lazily; once it lands, push the refreshed options
  // into the tree so unavailable items grey out with the correct tooltip.
  // Cached for the lifetime of the page after the first call.
  if (openAvailability === null) {
    void ensureOpenAvailability().then(() => {
      // The active project lang might have changed by the time the probe
      // resolves — only update if we're still on the same one.
      if (currentProjectUILang === id) {
        projectFileTree?.setOpenInOptions(buildOpenInOptions(id));
      }
    });
  }
  if (state.activeTab !== null) projectFileTree.expandPath(state.activeTab);

  projectEditorInstance = createProjectEditor({
    editorHost: el('projEditor'),
    tabsHost: el('projTabs'),
    statusHost: el('projStatus'),
    lang: id,
    initialOpenTabs: state.openTabs,
    initialActiveTab: state.activeTab,
    onTabsChanged: (openTabs, activeTab) => {
      const cached = projectStates.get(id);
      if (cached !== undefined) {
        cached.openTabs = openTabs;
        cached.activeTab = activeTab;
      }
      storageSet(openTabsKey(id), openTabs);
      if (activeTab !== null) {
        storageSet(activeTabKey(id), activeTab);
      } else {
        storageDelete(activeTabKey(id));
      }
      projectFileTree?.setActive(activeTab);
    },
  });

  // Subscribe to filesystem events for this lang's chokidar watcher.
  // EventSource auto-reconnects; the unsub is held so we close it cleanly
  // when the user switches to a different project language.
  projectFsUnsub = subscribeFsEvents(id, (event) => handleFsEvent(id, event));

  // The preview pane is iframe-shaped (web-vite) for now. Desktop-process
  // languages get a hidden-pane stub in M2; M3 wires their Output / Build
  // errors UI.
  const previewHost = el('projPreview');
  const previewResize = el('projPreviewResize');
  if (lang.runtime.kind === 'web-vite') {
    previewHost.style.display = '';
    previewResize.style.display = '';
    projectPreviewInstance = createProjectPreview({
      lang,
      tabsHost: el('projPreviewTabs'),
      bodyHost: el('projPreviewBody'),
      statusEl: el('projPreviewStatus'),
      runBtn: el<HTMLButtonElement>('projRunBtn'),
      runLabelEl: el('projRunLabel'),
      reloadBtn: el<HTMLButtonElement>('projReloadBtn'),
      externalBtn: el<HTMLButtonElement>('projOpenExternalBtn'),
    });
  } else {
    previewHost.style.display = 'none';
    previewResize.style.display = 'none';
  }

  currentProjectUILang = id;
}

const PROJ_PREVIEW_HEIGHT_KEY = 'lang-tutor:proj-preview-height';
const PROJ_PREVIEW_MIN = 80;

function clampPreviewHeight(height: number, max: number): number {
  return Math.max(PROJ_PREVIEW_MIN, Math.min(height, max));
}

function updatePreviewAriaValue(bar: HTMLElement, pane: HTMLElement): void {
  const editorPane = pane.parentElement;
  if (editorPane === null) return;
  const total = editorPane.getBoundingClientRect().height;
  if (total <= 0) return;
  const pct = Math.round((pane.getBoundingClientRect().height / total) * 100);
  bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, pct))));
}

function initProjectPreviewResize(): void {
  const bar = el('projPreviewResize');
  const pane = el('projPreview');

  const stored = storageGet<number>(PROJ_PREVIEW_HEIGHT_KEY);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    pane.style.flex = `0 0 ${stored}px`;
  }
  updatePreviewAriaValue(bar, pane);

  let startY = 0;
  let startH = 0;

  function onMove(e: MouseEvent): void {
    const editorPane = pane.parentElement;
    if (editorPane === null) return;
    const max = editorPane.getBoundingClientRect().height - 120;
    const next = clampPreviewHeight(startH - (e.clientY - startY), max);
    pane.style.flex = `0 0 ${next}px`;
    updatePreviewAriaValue(bar, pane);
  }

  function onUp(): void {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    storageSet(PROJ_PREVIEW_HEIGHT_KEY, pane.getBoundingClientRect().height);
    updatePreviewAriaValue(bar, pane);
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    startY = e.clientY;
    startH = pane.getBoundingClientRect().height;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => {
    pane.style.flex = '';
    storageDelete(PROJ_PREVIEW_HEIGHT_KEY);
    requestAnimationFrame(() => updatePreviewAriaValue(bar, pane));
  });
}

// ── Project state hydration ──────────────────────────────────────────────
function loadProjectStateFromStorage(id: LanguageId): ProjectState {
  const openTabs = storageGet<string[]>(openTabsKey(id)) ?? [];
  const activeTab = storageGet<string>(activeTabKey(id));
  return {
    tree: null,
    openTabs,
    activeTab,
    scaffolded: false,
  };
}

async function hydrateProjectState(id: LanguageId, lang: Language): Promise<void> {
  if (lang.kind !== 'project') return;
  const langWhenStarted = id;

  try {
    let response = await fetchTree(id);
    if (!response.scaffolded) {
      await ensureScaffold(id);
      response = await fetchTree(id);
    }
    if (activeLang !== langWhenStarted) return;

    const state = projectStates.get(id) ?? loadProjectStateFromStorage(id);
    state.tree = response.tree;
    state.scaffolded = response.scaffolded;

    // Drop any persisted open-tab paths that no longer exist on disk.
    const liveFiles = new Set(flattenFiles(response.tree));
    state.openTabs = state.openTabs.filter((p) => liveFiles.has(p));
    if (state.activeTab !== null && !liveFiles.has(state.activeTab)) {
      state.activeTab = state.openTabs[0] ?? null;
    }

    projectStates.set(id, state);
    storageSet(openTabsKey(id), state.openTabs);
    if (state.activeTab !== null) {
      storageSet(activeTabKey(id), state.activeTab);
    } else {
      storageDelete(activeTabKey(id));
    }

    projectFileTree?.render(state.tree);
    if (state.activeTab !== null) projectFileTree?.expandPath(state.activeTab);
  } catch (e) {
    console.error('[project] failed to hydrate', id, e);
  }
}

// ── Progress extraction ───────────────────────────────────────────────────
async function extractProgress(): Promise<void> {
  if (extractionQueued) return;
  extractionQueued = true;
  updateProgBadge('Updating');

  const lang = getLanguage(activeLang);
  const langWhenStarted = activeLang;

  try {
    const extracted = await fetchProgressExtraction(history, lang.topics);
    if (extracted === null) return;
    if (langWhenStarted !== activeLang) return;

    const mergedTopics: TopicStatus[] = lang.topics.map((t) => {
      const found = extracted.topics?.find((p) => p.id === t.id);
      const prev = progress?.topics?.find((p) => p.id === t.id);
      return { id: t.id, title: t.title, status: found?.status ?? prev?.status ?? 'not-started' };
    });

    const [datePart] = new Date().toISOString().split('T');
    progress = {
      ...extracted,
      topics: mergedTopics,
      sessionCount: (progress?.sessionCount ?? 0) + (progress !== null ? 0 : 1),
      lastSeen: datePart ?? '',
    };

    storageSet(progressKey(activeLang), progress);
    currentSystemPrompt = buildSystem(progress, getLanguage(activeLang));
    renderProgressTab();
    renderChapterStrip();
    renderLanguageRail();
    updateProgCount();
  } catch (e) {
    console.error('Progress extraction error:', e);
  } finally {
    updateProgBadge(null);
    extractionQueued = false;
  }
}

// ── Session control ───────────────────────────────────────────────────────
async function streamReply(): Promise<{ ok: boolean; text: string }> {
  const state = { bubble: null as StreamingBubble | null };
  const result = await callClaude(history, currentSystemPrompt, (chunk) => {
    if (state.bubble === null) {
      removeThinking();
      state.bubble = appendMsgStreaming();
    }
    state.bubble.onDelta(chunk);
  });

  if (state.bubble !== null) {
    state.bubble.finalize();
    return result;
  }

  removeThinking();
  if (result.ok) {
    appendMsg('assistant', result.text);
  } else {
    appendErrorMsg(result.text, () => void deliverReply());
  }
  return result;
}

async function deliverReply(): Promise<void> {
  setSendingState(true);
  showThinking();
  const result = await streamReply();
  if (result.ok) {
    history.push({ role: 'assistant', content: result.text });
    storageSet(historyKey(activeLang), history.slice(-MAX_HISTORY));
  }
  setSendingState(false);
  el<HTMLTextAreaElement>('chatInput').focus();
}

async function startSession(): Promise<void> {
  document.getElementById('startScreen')?.remove();
  el('inputRow').style.display = 'flex';
  el('resetBtn').style.display = 'inline-flex';

  const lang = getLanguage(activeLang);
  const initMsg = `Hello! I'd like to start a ${lang.name} tutoring session.`;
  history.push({ role: 'user', content: initMsg });

  await deliverReply();
}

async function sendMessage(text: string): Promise<void> {
  if (!text.trim() || isSending) return;
  el<HTMLTextAreaElement>('chatInput').value = '';

  if (history.at(-1)?.role === 'user') {
    history.pop();
    discardPendingFailure();
  }

  history.push({ role: 'user', content: text });
  appendMsg('user', text);
  await deliverReply();
}

// ── Code panel ────────────────────────────────────────────────────────────
async function runActiveCode(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return;

  const code = editor.getContent();
  const runBtn = el<HTMLButtonElement>('runBtn');
  const outputPre = el<HTMLPreElement>('outputPre');
  runBtn.disabled = true;
  el('runLabel').textContent = 'Running…';
  outputPre.style.color = '';
  outputPre.textContent = '';

  const langAtStart = activeLang;
  const result = await runCode(lang.id as SingleBufferLanguageId, code, (msg) => {
    if (activeLang === langAtStart) outputPre.textContent = msg;
  });

  if (activeLang !== langAtStart) {
    runBtn.disabled = false;
    el('runLabel').textContent = 'Run';
    return;
  }

  outputPre.style.color = result.ok ? '' : 'var(--danger)';
  outputPre.textContent = result.output;
  runBtn.disabled = false;
  el('runLabel').textContent = 'Run';
}

async function evaluateCode(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return;

  const code = editor.getContent().trim();
  const out = el<HTMLPreElement>('outputPre').textContent ?? '';
  const hasOut = out && !out.includes('Run the program') && out !== 'Compiling…' && out !== 'Running…';
  const msg = `[CODE]\n\`\`\`${lang.fenceLang}\n${code}\n\`\`\`\n\n[OUTPUT]\n\`\`\`\n${hasOut ? out : '(not run yet)'}\n\`\`\``;
  await sendMessage(msg);
  void extractProgress();
}

function fenceLangFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'jsx':
      return 'jsx';
    case 'ts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'md';
    default:
      return '';
  }
}

async function evaluateProjectCode(): Promise<void> {
  if (projectEditorInstance === null) return;
  const langWhenStarted = activeLang;

  const files = projectEditorInstance.getOpenFiles();
  const preview = projectPreviewInstance;

  const snapshotPromise = preview?.isRunning() ? preview.requestSnapshot() : Promise.resolve(null);
  const logsPromise = fetchRecentLogs(langWhenStarted, 60).catch(() => ({ lines: [] as { stream: string; line: string; ts: number }[] }));

  const [snapshot, logs] = await Promise.all([snapshotPromise, logsPromise]);
  if (langWhenStarted !== activeLang) return;

  const blocks: string[] = [];

  if (files.length > 0) {
    const fileBlock = files
      .map((f) => `--- ${f.path}${f.dirty ? ' (unsaved)' : ''} ---\n\`\`\`${fenceLangFromPath(f.path)}\n${f.content}\n\`\`\``)
      .join('\n\n');
    blocks.push(`[FILES]\n${fileBlock}`);
  } else {
    blocks.push('[FILES]\n(no files open — open a file in the tree first so the tutor can see what you are working on)');
  }

  if (snapshot !== null) {
    blocks.push(`[DOM] (rendered at ${snapshot.url})\n\`\`\`html\n${snapshot.dom}\n\`\`\``);
    if (snapshot.consoleBuffer.length > 0) {
      const consoleBlock = snapshot.consoleBuffer.map((c) => `${c.level}: ${c.line}`).join('\n');
      blocks.push(`[CONSOLE]\n\`\`\`\n${consoleBlock}\n\`\`\``);
    } else {
      blocks.push('[CONSOLE]\n(empty)');
    }
  } else if (preview !== null && !preview.isRunning()) {
    blocks.push('[DOM]\n(dev server is stopped — Run to capture)');
  }

  if (logs.lines.length > 0) {
    const serverBlock = logs.lines.map((l) => l.line).join('\n');
    blocks.push(`[SERVER]\n\`\`\`\n${serverBlock}\n\`\`\``);
  }

  await sendMessage(blocks.join('\n\n'));
  void extractProgress();
}

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(tab: 'chat' | 'progress'): void {
  el('chatView').style.display = tab === 'chat' ? 'flex' : 'none';
  el('progressView').style.display = tab === 'progress' ? 'flex' : 'none';
  el('tabChatBtn').classList.toggle('is-active', tab === 'chat');
  el('tabProgBtn').classList.toggle('is-active', tab === 'progress');
}

async function resetCurrentLanguage(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!confirm(`Reset all ${lang.name} progress and start fresh?`)) return;
  storageDelete(progressKey(activeLang));
  storageDelete(historyKey(activeLang));
  if (isSingleBufferLanguage(lang)) {
    storageDelete(codeKey(activeLang));
  } else {
    storageDelete(openTabsKey(activeLang));
    storageDelete(activeTabKey(activeLang));
    projectStates.delete(activeLang);
  }
  location.reload();
}

// ── Language switching ────────────────────────────────────────────────────
function loadLanguageState(id: LanguageId): void {
  activeLang = id;
  storageSet(ACTIVE_LANG_KEY, activeLang);
  document.documentElement.setAttribute('data-lang', activeLang);

  history = storageGet<Message[]>(historyKey(activeLang)) ?? [];
  progress = storageGet<Progress>(progressKey(activeLang));
  const lang = getLanguage(activeLang);
  currentSystemPrompt = buildSystem(progress, lang);

  renderFileSpec();

  if (isSingleBufferLanguage(lang)) {
    setWorkshopMode('single');
    el('fileLabel').textContent = lang.fileName;

    const storedCode = storageGet<string>(codeKey(activeLang));
    editor.setContent(storedCode ?? lang.starterCode);
    editor.setLanguage(lang.id as SingleBufferLanguageId);

    clearOutput();
  } else {
    setWorkshopMode('project');
    ensureProjectUI(id, lang);
    const cached = projectStates.get(id) ?? loadProjectStateFromStorage(id);
    projectStates.set(id, cached);
    projectFileTree?.render(cached.tree);
    void hydrateProjectState(id, lang);
  }

  renderChatView();
  renderProgressTab();
  renderChapterStrip();
  renderLanguageRail();
  updateProgCount();
}

function setLanguage(newLang: LanguageId): void {
  if (newLang === activeLang) return;
  const prev = getLanguage(activeLang);
  if (isSingleBufferLanguage(prev)) {
    storageSet(codeKey(activeLang), editor.getContent());
  }
  loadLanguageState(newLang);
}

// ── Resize handle ─────────────────────────────────────────────────────────
function initResize(): void {
  const bar = el('resizeBar');
  const out = el<HTMLPreElement>('outputPre');
  let startY = 0;
  let startH = 0;

  function onMove(e: MouseEvent): void {
    const newH = Math.max(60, Math.min(startH - (e.clientY - startY), 500));
    out.style.flex = `0 0 ${newH}px`;
  }

  function onUp(): void {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    startY = e.clientY;
    startH = out.getBoundingClientRect().height;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

const ASIDE_WIDTH_KEY = 'lang-tutor:aside-width';
const ASIDE_MIN_WIDTH = 320;

function clampAsideWidth(width: number): number {
  const split = el('bodySplit').getBoundingClientRect().width;
  const max = Math.max(ASIDE_MIN_WIDTH + 200, split * 0.75);
  return Math.max(ASIDE_MIN_WIDTH, Math.min(width, max));
}

function updateAsideAriaValue(bar: HTMLElement, aside: HTMLElement): void {
  const total = el('bodySplit').getBoundingClientRect().width;
  if (total <= 0) return;
  const pct = Math.round((aside.getBoundingClientRect().width / total) * 100);
  bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, pct))));
}

function initAsideResize(): void {
  const bar = el('asideResize');
  const aside = document.querySelector<HTMLElement>('.aside');
  if (aside === null) return;

  const stored = storageGet<number>(ASIDE_WIDTH_KEY);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    aside.style.flex = `0 0 ${clampAsideWidth(stored)}px`;
  }
  updateAsideAriaValue(bar, aside);

  let startX = 0;
  let startW = 0;

  function onMove(e: MouseEvent): void {
    const next = clampAsideWidth(startW + (e.clientX - startX));
    if (aside !== null) {
      aside.style.flex = `0 0 ${next}px`;
      updateAsideAriaValue(bar, aside);
    }
  }

  function onUp(): void {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (aside !== null) {
      const finalWidth = aside.getBoundingClientRect().width;
      storageSet(ASIDE_WIDTH_KEY, finalWidth);
      updateAsideAriaValue(bar, aside);
    }
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    if (aside === null) return;
    startX = e.clientX;
    startW = aside.getBoundingClientRect().width;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => {
    if (aside === null) return;
    aside.style.flex = '';
    storageDelete(ASIDE_WIDTH_KEY);
    requestAnimationFrame(() => updateAsideAriaValue(bar, aside));
  });
}

// ── Migration: old rust-* keys → namespaced lang-tutor:rust:* ─────────────
function migrateOldStorage(): void {
  const oldHistory = storageGet<Message[]>('rust-history');
  if (oldHistory !== null && storageGet(historyKey('rust')) === null) {
    storageSet(historyKey('rust'), oldHistory);
  }
  storageDelete('rust-history');

  const oldProgress = storageGet<Progress>('rust-progress');
  if (oldProgress !== null && storageGet(progressKey('rust')) === null) {
    storageSet(progressKey('rust'), oldProgress);
  }
  storageDelete('rust-progress');
}

function loadInitialActiveLang(): LanguageId {
  const stored = storageGet<string>(ACTIVE_LANG_KEY);
  if (stored !== null && (LANGUAGE_IDS as readonly string[]).includes(stored)) {
    return stored as LanguageId;
  }
  return DEFAULT_LANGUAGE;
}

function makeDebouncedCodeSaver(): (doc: string) => void {
  let saveTimer: number | null = null;
  return (doc: string) => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      // Only persist editor content for single-buffer languages — project
      // languages own their files on disk, not in localStorage.
      if (isSingleBufferLanguage(getLanguage(activeLang))) {
        storageSet(codeKey(activeLang), doc);
      }
    }, 400);
  };
}

// ── Event wiring ──────────────────────────────────────────────────────────
el('tabChatBtn').addEventListener('click', () => switchTab('chat'));
el('tabProgBtn').addEventListener('click', () => switchTab('progress'));
el('sendBtn').addEventListener('click', () => void sendMessage(el<HTMLTextAreaElement>('chatInput').value));
el<HTMLTextAreaElement>('chatInput').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendMessage(el<HTMLTextAreaElement>('chatInput').value);
  }
});
el('runBtn').addEventListener('click', () => void runActiveCode());
el('evalBtn').addEventListener('click', () => void evaluateCode());
el('projEvalBtn').addEventListener('click', () => void evaluateProjectCode());
el('resetBtn').addEventListener('click', () => void resetCurrentLanguage());
el('themeToggle').addEventListener('click', toggleTheme);

for (const tab of document.querySelectorAll<HTMLButtonElement>('.lang-tab')) {
  tab.addEventListener('click', () => {
    const id = tab.getAttribute('data-lang') as LanguageId | null;
    if (id !== null) setLanguage(id);
  });
}

initResize();
initAsideResize();
initProjectPreviewResize();

// ── Init ──────────────────────────────────────────────────────────────────
applyStoredTheme();
migrateOldStorage();
const initialLang = loadInitialActiveLang();
const initialLangObj = getLanguage(initialLang);

// The CodeMirror editor only handles single-buffer languages. If the user's
// last session was a project language (e.g. 'web'), boot the editor with a
// fallback single-buffer language; loadLanguageState will hide it anyway.
const editorBootLang: SingleBufferLanguageId = isSingleBufferLanguage(initialLangObj) ? (initialLangObj.id as SingleBufferLanguageId) : 'rust';
const editorBootCode = isSingleBufferLanguage(initialLangObj) ? (storageGet<string>(codeKey(initialLang)) ?? initialLangObj.starterCode) : '';
editor = createEditor({
  parent: el('codeArea'),
  initialDoc: editorBootCode,
  lang: editorBootLang,
  onChange: makeDebouncedCodeSaver(),
});
loadLanguageState(initialLang);
