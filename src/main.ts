import './style.css';
import { callClaude, fetchProgressExtraction } from './api';
import { ACTIVE_LANG_KEY, codeKey, DEFAULT_LANGUAGE, getLanguage, historyKey, LANGUAGE_IDS, MAX_HISTORY, progressKey } from './constants';
import { createEditor, type TutorEditor } from './editor';
import { renderMarkdown, renderPlainWithFences } from './render';
import { runCode } from './runners';
import { storageDelete, storageGet, storageSet } from './storage';
import type { Language, LanguageId, Message, Progress, TopicStatus } from './types';

// ── State ─────────────────────────────────────────────────────────────────
let activeLang: LanguageId = DEFAULT_LANGUAGE;
let history: Message[] = [];
let progress: Progress | null = null;
let currentSystemPrompt = '';
let extractionQueued = false;
let isSending = false;
let editor: TutorEditor;

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

// ── Progress badge ────────────────────────────────────────────────────────
function updateProgBadge(text: string | null): void {
  const badge = el('progBadge');
  if (text !== null) {
    badge.textContent = text;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

function updateProgCount(): void {
  const lang = getLanguage(activeLang);
  const mastered = (progress?.topics ?? []).filter((t) => t.status === 'mastered').length;
  const progCount = el('progCount');
  progCount.textContent = ` ${mastered}/${lang.topics.length}`;
  progCount.style.display = mastered > 0 ? 'inline' : 'none';
}

// ── Progress tab renderer ─────────────────────────────────────────────────
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
    const p = document.createElement('p');
    p.className = 'text-muted text-[13px] py-5 text-center';
    p.textContent = `No ${lang.name} progress recorded yet. Complete an evaluation to begin tracking.`;
    scroll.appendChild(p);
    return;
  }

  // Overall progress
  const overallSection = div('mb-4');
  overallSection.appendChild(progSectionLabel(`${lang.name} progress`));
  const done = (progress.topics ?? []).filter((t) => t.status === 'mastered').length;
  const pct = Math.round((done / lang.topics.length) * 100);
  const countLine = div('text-[13px] mb-1.5');
  countLine.textContent = `${done} of ${lang.topics.length} topics mastered`;
  overallSection.appendChild(countLine);
  const track = div('prog-bar-track');
  const fill = div('prog-bar-fill');
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  overallSection.appendChild(track);
  if (progress.lastSeen) {
    const lastSeen = div('text-[11px] text-muted mt-1');
    lastSeen.textContent = `Last session: ${progress.lastSeen}`;
    overallSection.appendChild(lastSeen);
  }
  scroll.appendChild(overallSection);

  // Lesson plan
  const planSection = div('mb-4');
  planSection.appendChild(progSectionLabel('Lesson plan'));
  for (const t of lang.topics) {
    const status = progress.topics?.find((x) => x.id === t.id)?.status ?? 'not-started';
    const dotCls = status === 'mastered' ? 'dot-done' : status === 'in-progress' ? 'dot-active' : 'dot-empty';
    const dotIcon = status === 'mastered' ? '✓' : status === 'in-progress' ? '→' : '';
    const titleCls = status === 'mastered' ? 'done' : status === 'in-progress' ? 'active' : 'empty';
    const isCurrent =
      progress.currentTopic !== undefined &&
      (t.title === progress.currentTopic || t.title.toLowerCase().includes(progress.currentTopic.toLowerCase()));

    const row = div('flex items-center gap-2 py-1');
    const dot = div('topic-dot', dotCls);
    dot.textContent = dotIcon;
    row.appendChild(dot);
    row.appendChild(span(t.title, 'topic-title', titleCls));
    if (isCurrent && status === 'in-progress') {
      row.appendChild(span('← here', 'text-[10px] text-muted'));
    }
    planSection.appendChild(row);
  }
  scroll.appendChild(planSection);

  // Strengths
  const strengthsSection = div('mb-4');
  strengthsSection.appendChild(progSectionLabel('Going well'));
  const strengthsContainer = div();
  if (progress.strengths && progress.strengths.length > 0) {
    for (const s of progress.strengths) strengthsContainer.appendChild(span(`+ ${s}`, 'note-pill'));
  } else {
    strengthsContainer.appendChild(span('None recorded yet', 'text-muted text-[12.5px]'));
  }
  strengthsSection.appendChild(strengthsContainer);
  scroll.appendChild(strengthsSection);

  // Struggles
  const strugglesSection = div('mb-4');
  strugglesSection.appendChild(progSectionLabel('Needs work'));
  const strugglesContainer = div();
  if (progress.struggles && progress.struggles.length > 0) {
    for (const s of progress.struggles) strugglesContainer.appendChild(span(`! ${s}`, 'note-pill'));
  } else {
    strugglesContainer.appendChild(span('None recorded yet', 'text-muted text-[12.5px]'));
  }
  strugglesSection.appendChild(strugglesContainer);
  scroll.appendChild(strugglesSection);

  // Notes
  if (progress.overallNotes) {
    const notesSection = div('mb-4');
    notesSection.appendChild(progSectionLabel('Notes'));
    const notesText = div('text-[12.5px] leading-relaxed text-muted');
    notesText.textContent = progress.overallNotes;
    notesSection.appendChild(notesText);
    scroll.appendChild(notesSection);
  }
}

// ── Message rendering ─────────────────────────────────────────────────────
function appendMsg(role: 'user' | 'assistant', text: string): void {
  const msgList = el('msgList');
  const bl = div('mb-[14px]');
  const lbl = div('msg-label');
  lbl.textContent = role === 'user' ? 'You' : 'Tutor';
  const body = div(role === 'user' ? 'msg-you' : 'msg-ai');
  body.appendChild(role === 'user' ? renderPlainWithFences(text) : renderMarkdown(text));
  bl.appendChild(lbl);
  bl.appendChild(body);
  msgList.appendChild(bl);
  msgList.scrollTop = msgList.scrollHeight;
}

let thinkingEl: HTMLElement | null = null;

function showThinking(): void {
  const wrapper = div('mb-[14px]');
  const lbl = div('msg-label');
  lbl.textContent = 'Tutor';
  const body = div('msg-ai');
  body.appendChild(span('···', 'thinking', 'text-[20px]', 'tracking-[4px]'));
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

function appendMsgStreaming(): StreamingBubble {
  const msgList = el('msgList');
  const bl = div('mb-[14px]');
  const lbl = div('msg-label');
  lbl.textContent = 'Tutor';
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

// ── Start screen (per-language, dynamic) ──────────────────────────────────
function showStartScreen(): void {
  const msgList = el('msgList');
  const lang = getLanguage(activeLang);

  const screen = div('flex flex-col items-center justify-center h-full gap-[13px] text-center px-5');
  screen.id = 'startScreen';

  const icon = document.createElement('i');
  icon.className = 'ti ti-terminal-2 text-[44px] text-muted';
  icon.setAttribute('aria-hidden', 'true');
  screen.appendChild(icon);

  const startMsg = div('text-muted text-[13.5px] leading-relaxed whitespace-pre-line');
  startMsg.textContent = `Learn ${lang.name} with an interactive AI tutor.\nWrite code, run it, get evaluated.`;
  screen.appendChild(startMsg);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn py-2 px-5 text-[13px]';
  button.textContent = `Start ${lang.name} session →`;
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
    el('resetBtn').style.display = 'inline-block';
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
  outputPre.appendChild(span('Run your code to see output here', 'text-muted'));
}

// ── Progress extraction ───────────────────────────────────────────────────
async function extractProgress(): Promise<void> {
  if (extractionQueued) return;
  extractionQueued = true;
  updateProgBadge('Updating…');

  const lang = getLanguage(activeLang);
  const langWhenStarted = activeLang;

  try {
    const extracted = await fetchProgressExtraction(history, lang.topics);
    if (extracted === null) return;
    // If user switched language during extraction, abandon — the result is for the wrong language
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
    updateProgCount();
  } catch (e) {
    console.error('Progress extraction error:', e);
  } finally {
    updateProgBadge(null);
    extractionQueued = false;
  }
}

// ── Session control ───────────────────────────────────────────────────────
async function streamReply(): Promise<string> {
  // Wrap in an object so TS tracks the property type, not a closure-narrowed local.
  const state = { bubble: null as StreamingBubble | null };
  const reply = await callClaude(history, currentSystemPrompt, (chunk) => {
    if (state.bubble === null) {
      removeThinking();
      state.bubble = appendMsgStreaming();
    }
    state.bubble.onDelta(chunk);
  });
  if (state.bubble === null) {
    // No deltas arrived (error / empty stream) — render whatever we got as a normal message.
    removeThinking();
    appendMsg('assistant', reply);
  } else {
    state.bubble.finalize();
  }
  return reply;
}

async function startSession(): Promise<void> {
  document.getElementById('startScreen')?.remove();
  el('inputRow').style.display = 'flex';
  el('resetBtn').style.display = 'inline-block';
  setSendingState(true);

  const lang = getLanguage(activeLang);
  const initMsg = `Hello! I'd like to start a ${lang.name} tutoring session.`;
  history.push({ role: 'user', content: initMsg });

  showThinking();
  const reply = await streamReply();
  history.push({ role: 'assistant', content: reply });
  storageSet(historyKey(activeLang), history.slice(-MAX_HISTORY));
  setSendingState(false);
  el<HTMLTextAreaElement>('chatInput').focus();
}

async function sendMessage(text: string): Promise<void> {
  if (!text.trim() || isSending) return;
  el<HTMLTextAreaElement>('chatInput').value = '';
  history.push({ role: 'user', content: text });
  appendMsg('user', text);
  setSendingState(true);
  showThinking();
  const reply = await streamReply();
  history.push({ role: 'assistant', content: reply });
  storageSet(historyKey(activeLang), history.slice(-MAX_HISTORY));
  setSendingState(false);
  el<HTMLTextAreaElement>('chatInput').focus();
}

// ── Code panel ────────────────────────────────────────────────────────────
async function runActiveCode(): Promise<void> {
  const code = editor.getContent();
  const runBtn = el<HTMLButtonElement>('runBtn');
  const outputPre = el<HTMLPreElement>('outputPre');
  runBtn.disabled = true;
  el('runLabel').textContent = 'Running…';
  outputPre.style.color = '';
  outputPre.textContent = '';

  const langAtStart = activeLang;
  const result = await runCode(activeLang, code, (msg) => {
    if (activeLang === langAtStart) outputPre.textContent = msg;
  });

  // Bail if user switched language while we were running
  if (activeLang !== langAtStart) {
    runBtn.disabled = false;
    el('runLabel').textContent = 'Run';
    return;
  }

  outputPre.style.color = result.ok ? '' : 'var(--color-danger)';
  outputPre.textContent = result.output;
  runBtn.disabled = false;
  el('runLabel').textContent = 'Run';
}

async function evaluateCode(): Promise<void> {
  const lang = getLanguage(activeLang);
  const code = editor.getContent().trim();
  const out = el<HTMLPreElement>('outputPre').textContent ?? '';
  const hasOut = out && !out.includes('Run your code') && out !== 'Compiling…' && out !== 'Running…';
  const msg = `[CODE]\n\`\`\`${lang.fenceLang}\n${code}\n\`\`\`\n\n[OUTPUT]\n\`\`\`\n${hasOut ? out : '(not run yet)'}\n\`\`\``;
  await sendMessage(msg);
  void extractProgress();
}

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(tab: 'chat' | 'progress'): void {
  el('chatView').style.display = tab === 'chat' ? 'flex' : 'none';
  el('progressView').style.display = tab === 'progress' ? 'flex' : 'none';
  el('tabChatBtn').classList.toggle('active', tab === 'chat');
  el('tabProgBtn').classList.toggle('active', tab === 'progress');
}

async function resetCurrentLanguage(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!confirm(`Reset all ${lang.name} progress and start fresh?`)) return;
  storageDelete(progressKey(activeLang));
  storageDelete(historyKey(activeLang));
  storageDelete(codeKey(activeLang));
  location.reload();
}

// ── Language switching ────────────────────────────────────────────────────
function loadLanguageState(id: LanguageId): void {
  activeLang = id;
  storageSet(ACTIVE_LANG_KEY, activeLang);
  history = storageGet<Message[]>(historyKey(activeLang)) ?? [];
  progress = storageGet<Progress>(progressKey(activeLang));
  const lang = getLanguage(activeLang);
  currentSystemPrompt = buildSystem(progress, lang);

  el('fileLabel').textContent = lang.fileName;
  const select = el<HTMLSelectElement>('langSelect');
  if (select.value !== activeLang) select.value = activeLang;

  const storedCode = storageGet<string>(codeKey(activeLang));
  editor.setContent(storedCode ?? lang.starterCode);
  editor.setLanguage(activeLang);

  clearOutput();
  renderChatView();
  renderProgressTab();
  updateProgCount();
}

function setLanguage(newLang: LanguageId): void {
  if (newLang === activeLang) return;
  // Save current language's editor content
  storageSet(codeKey(activeLang), editor.getContent());
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

// ── Editor persistence: debounced save to localStorage on edit ────────────
function makeDebouncedCodeSaver(): (doc: string) => void {
  let saveTimer: number | null = null;
  return (doc: string) => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      storageSet(codeKey(activeLang), doc);
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
el('resetBtn').addEventListener('click', () => void resetCurrentLanguage());
el<HTMLSelectElement>('langSelect').addEventListener('change', (e) => {
  const target = e.target as HTMLSelectElement;
  setLanguage(target.value as LanguageId);
});

initResize();

// ── Init ──────────────────────────────────────────────────────────────────
migrateOldStorage();
const initialLang = loadInitialActiveLang();
const initialLangObj = getLanguage(initialLang);
const initialCode = storageGet<string>(codeKey(initialLang)) ?? initialLangObj.starterCode;
editor = createEditor({
  parent: el('codeArea'),
  initialDoc: initialCode,
  lang: initialLang,
  onChange: makeDebouncedCodeSaver(),
});
loadLanguageState(initialLang);
