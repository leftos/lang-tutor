import './style.css';
import { callClaude, fetchLearnerProfileExtraction, fetchProgressExtraction } from './api';
import {
  type AccountSession,
  canUseHostedTooling,
  isAuthRequired,
  loadAuthSession,
  loginAccount,
  logoutAccount,
  registerAccount,
} from './authClient';
import {
  ACTIVE_LANG_KEY,
  activeTabKey,
  codeKey,
  DEFAULT_LANGUAGE,
  getLanguage,
  historyKey,
  LANGUAGE_IDS,
  LANGUAGES,
  LEARNER_PROFILE_KEY,
  MAX_HISTORY,
  openTabsKey,
  progressKey,
} from './constants';
import { createEditor, type TutorEditor } from './editor';
import { createFileTree, type FileTreeHandle, type OpenInOption } from './fileTree';
import type { LspDiagnostic } from './lspClient';
import {
  deleteFile as apiDeleteFile,
  mkdir as apiMkdir,
  renameFile as apiRenameFile,
  writeFile as apiWriteFile,
  ensureScaffold,
  type FsWatchEvent,
  fetchFile,
  fetchOpenAvailability,
  fetchRecentLogs,
  fetchTree,
  flattenFiles,
  type OpenAvailability,
  type OpenTarget,
  openProjectExternal,
  resetProject,
  subscribeFsEvents,
} from './projectApi';
import { createProjectEditor, type ProjectEditor } from './projectEditor';
import { createProjectPreview, type ProjectPreview, type ScreenshotPair } from './projectPreview';
import {
  DEFAULT_PROVIDER_MODELS,
  fetchProviderModels,
  loadProviderSettings,
  PROVIDER_LABELS,
  type ProviderModel,
  readProviderKey,
  saveProviderSettings,
} from './providerSettings';
import { renderMarkdown, renderPlainWithFences } from './render';
import { runCode } from './runners';
import { hydrateStorageFromDisk, storageDelete, storageGet, storageSet } from './storage';
import type {
  AiProvider,
  ContentBlock,
  ImageBlock,
  Language,
  LanguageId,
  LearnerProfile,
  Message,
  Progress,
  ProjectLanguage,
  ProjectState,
  SingleBufferLanguageId,
  TextBlock,
  TopicStatus,
} from './types';
import { isSingleBufferLanguage } from './types';

const THEME_KEY = 'lang-tutor:theme';
const DASM_FLAGS_KEY = 'lang-tutor:dasm:compiler-flags';
const FOCUS_MODE_KEY = 'lang-tutor:focus-mode';
const DEFAULT_DASM_FLAGS = '-O0 -g -fno-omit-frame-pointer';
const DASM_FLAG_PRESETS = [
  { label: '-O0', flags: DEFAULT_DASM_FLAGS },
  { label: '-O1', flags: '-O1 -g -fno-omit-frame-pointer' },
  { label: '-O2', flags: '-O2 -g -fno-omit-frame-pointer' },
] as const;

// ── State ─────────────────────────────────────────────────────────────────
let activeLang: LanguageId = DEFAULT_LANGUAGE;
let history: Message[] = [];
let progress: Progress | null = null;
let learnerProfile: LearnerProfile | null = null;
let currentSystemPrompt = '';
let extractionQueued = false;
let isSending = false;
let focusMode = false;
let editor: TutorEditor;
let authSession: AccountSession | null = null;
let accountMode: 'sign-in' | 'register' = 'sign-in';
// Per-language project state. Project-kind languages (e.g. 'web') own
// files on disk; this map caches the tree + tab UI state in memory.
const projectStates = new Map<LanguageId, ProjectState>();
let dasmAutoTimer: number | null = null;
let dasmAutoRevision = 0;
let dasmAutoRunning = false;
let dasmAutoQueued = false;
let lastSingleOutputText = '';
let suppressDasmAutoRun = false;

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

// ── Account / provider settings ──────────────────────────────────────────
function renderAccountSummary(): void {
  const status = el('authStatus');
  const accountBtn = el<HTMLButtonElement>('accountBtn');
  if (authSession !== null) {
    status.textContent = authSession.user.email;
    accountBtn.querySelector('span')!.textContent = 'Account';
  } else {
    status.textContent = isAuthRequired() ? 'Sign in required' : 'Local progress';
    accountBtn.querySelector('span')!.textContent = 'Sign in';
  }

  const signedIn = el('signedInPanel');
  const signedOut = el('signedOutPanel');
  signedIn.style.display = authSession !== null ? 'grid' : 'none';
  signedOut.style.display = authSession === null ? 'block' : 'none';
  if (authSession !== null) {
    el('signedInEmail').textContent = authSession.user.email;
  }
  updateAuthGate();
}

function updateAuthGate(): void {
  const locked = isAuthRequired() && authSession === null;
  document.documentElement.classList.toggle('auth-required', locked);
  const gate = document.getElementById('authGate');
  if (gate !== null) {
    gate.hidden = !locked;
  }
}

function renderAccountMode(): void {
  el('signInModeBtn').classList.toggle('is-active', accountMode === 'sign-in');
  el('registerModeBtn').classList.toggle('is-active', accountMode === 'register');
  el<HTMLInputElement>('accountPassword').autocomplete = accountMode === 'sign-in' ? 'current-password' : 'new-password';
  el('accountSubmitBtn').querySelector('span')!.textContent = accountMode === 'sign-in' ? 'Sign in' : 'Create account';
}

async function initializeAuth(): Promise<void> {
  try {
    authSession = await loadAuthSession();
  } catch (e) {
    console.warn('[auth] session load failed', e);
    authSession = null;
  }
  renderAccountSummary();
  renderAccountMode();
}

async function submitAccount(): Promise<void> {
  const email = el<HTMLInputElement>('accountEmail').value.trim();
  const password = el<HTMLInputElement>('accountPassword').value;
  const status = el('accountStatus');
  if (!email || !password) {
    status.textContent = 'Enter an email and password.';
    return;
  }

  el<HTMLButtonElement>('accountSubmitBtn').disabled = true;
  status.textContent = accountMode === 'sign-in' ? 'Signing in...' : 'Creating account...';
  try {
    authSession = accountMode === 'sign-in' ? await loginAccount({ email, password }) : await registerAccount({ email, password });
    el<HTMLInputElement>('accountPassword').value = '';
    status.textContent = 'Progress sync is active.';
    renderAccountSummary();
    await hydrateStorageFromDisk();
    loadLanguageState(activeLang);
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    el<HTMLButtonElement>('accountSubmitBtn').disabled = false;
  }
}

async function signOut(): Promise<void> {
  const status = el('accountStatus');
  el<HTMLButtonElement>('signOutBtn').disabled = true;
  status.textContent = 'Signing out...';
  try {
    await logoutAccount();
    authSession = null;
    status.textContent = 'Signed out. Progress remains cached in this browser.';
    renderAccountSummary();
    loadLanguageState(activeLang);
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    el<HTMLButtonElement>('signOutBtn').disabled = false;
  }
}

const providerHelp: Record<AiProvider, { title: string; steps: string[]; links: Array<{ label: string; href: string }> }> = {
  anthropic: {
    title: 'Anthropic Claude setup',
    steps: [
      'Create or sign in to an Anthropic Console account.',
      'Open Billing, add payment details, and buy usage credits. $20 is a reasonable starting amount for light personal use.',
      'Open API Keys, create a key for Lang Tutor, and paste it here.',
      'Keep auto-reload off at first, or set conservative reload limits while you learn your usage.',
    ],
    links: [
      { label: 'API keys', href: 'https://console.anthropic.com/settings/keys' },
      { label: 'Billing', href: 'https://console.anthropic.com/settings/billing' },
    ],
  },
  openai: {
    title: 'OpenAI ChatGPT setup',
    steps: [
      'Create or sign in to an OpenAI platform account.',
      'Open Billing, add payment details, then add prepaid credits. $20 is a reasonable starting balance for experimentation.',
      'Open API keys and create a restricted key for this project when available.',
      'Set a project budget or usage limit before sharing the app with anyone else.',
    ],
    links: [
      { label: 'API keys', href: 'https://platform.openai.com/api-keys' },
      { label: 'Billing', href: 'https://platform.openai.com/settings/organization/billing/overview' },
    ],
  },
  gemini: {
    title: 'Google Gemini setup',
    steps: [
      'Create or sign in to Google AI Studio.',
      'Create a Gemini API key for a Google Cloud project and paste it here.',
      'Gemini often starts with free-tier usage. For paid quota, attach a Google Cloud billing account instead of prepaid credits.',
      'Set a Cloud Billing budget or alert around $20 so unexpected usage is visible quickly.',
    ],
    links: [
      { label: 'API keys', href: 'https://aistudio.google.com/apikey' },
      { label: 'Billing', href: 'https://console.cloud.google.com/billing' },
    ],
  },
};

function selectedProvider(): AiProvider {
  const raw = el<HTMLSelectElement>('providerSelect').value;
  return raw === 'openai' || raw === 'gemini' ? raw : 'anthropic';
}

const providerModelCache = new Map<AiProvider, { apiKey: string; models: ProviderModel[] }>();
let providerModelRequestId = 0;

function providerFormKey(provider: AiProvider): string {
  return el<HTMLInputElement>('providerApiKey').value.trim() || readProviderKey(provider);
}

function setProviderModelWarning(message: string): void {
  el('providerModelWarning').textContent = message;
}

function updateProviderSaveAvailability(): void {
  const provider = selectedProvider();
  const select = el<HTMLSelectElement>('providerModelSelect');
  const hasKey = providerFormKey(provider).trim().length > 0;
  const hasModel = !select.disabled && select.value.trim().length > 0;
  el<HTMLButtonElement>('saveProviderBtn').disabled = !hasKey || !hasModel;
}

function renderProviderModelPlaceholder(message: string, selectedModel = ''): void {
  const select = el<HTMLSelectElement>('providerModelSelect');
  select.textContent = '';
  const option = document.createElement('option');
  option.value = selectedModel;
  option.textContent = selectedModel ? `${message}: ${selectedModel}` : message;
  select.appendChild(option);
  select.value = selectedModel;
  select.disabled = true;
  updateProviderSaveAvailability();
}

function renderProviderModelOptions(provider: AiProvider, models: readonly ProviderModel[], selectedModel: string): void {
  const select = el<HTMLSelectElement>('providerModelSelect');
  const savedModel = selectedModel.trim();
  const hasSavedModel = savedModel.length > 0;
  const savedStillAvailable = models.some((model) => model.id === savedModel);

  select.textContent = '';
  if (models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No compatible chat models returned';
    select.appendChild(option);
    select.value = '';
    select.disabled = true;
    setProviderModelWarning(`${PROVIDER_LABELS[provider]} did not return any compatible text-generation models for this key.`);
    updateProviderSaveAvailability();
    return;
  }

  if (hasSavedModel && !savedStillAvailable) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Select an available model';
    select.appendChild(option);
    setProviderModelWarning(`Previously selected model "${savedModel}" is no longer available. Pick a new model.`);
  } else {
    setProviderModelWarning('');
  }

  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    select.appendChild(option);
  }

  select.disabled = false;
  select.value = savedStillAvailable ? savedModel : '';
  if (!select.value && !hasSavedModel) select.selectedIndex = 0;
  updateProviderSaveAvailability();
}

async function refreshProviderModels(provider = selectedProvider()): Promise<void> {
  const apiKey = providerFormKey(provider).trim();
  const selectedModel = loadProviderSettings().providers[provider].model || DEFAULT_PROVIDER_MODELS[provider];
  const select = el<HTMLSelectElement>('providerModelSelect');
  const refreshBtn = el<HTMLButtonElement>('refreshProviderModelsBtn');

  if (!apiKey) {
    renderProviderModelPlaceholder('Enter an API key, then load models');
    setProviderModelWarning('Paste this provider API key before loading models.');
    return;
  }

  const cached = providerModelCache.get(provider);
  if (cached !== undefined && cached.apiKey === apiKey) {
    renderProviderModelOptions(provider, cached.models, selectedModel);
    return;
  }

  const requestId = ++providerModelRequestId;
  setProviderModelWarning('Loading live model list...');
  select.disabled = true;
  refreshBtn.disabled = true;
  try {
    const models = await fetchProviderModels(provider, apiKey);
    if (requestId !== providerModelRequestId || provider !== selectedProvider()) return;
    providerModelCache.set(provider, { apiKey, models });
    renderProviderModelOptions(provider, models, selectedModel);
  } catch (e) {
    if (requestId !== providerModelRequestId || provider !== selectedProvider()) return;
    renderProviderModelPlaceholder('Could not load models');
    setProviderModelWarning(e instanceof Error ? e.message : String(e));
  } finally {
    if (requestId === providerModelRequestId) {
      refreshBtn.disabled = false;
    }
  }
}

function renderProviderHelp(provider: AiProvider): void {
  const help = providerHelp[provider];
  el('providerHelpTitle').textContent = help.title;
  const steps = el<HTMLOListElement>('providerHelpSteps');
  steps.textContent = '';
  for (const step of help.steps) {
    const li = document.createElement('li');
    li.textContent = step;
    steps.appendChild(li);
  }
  const links = el('providerHelpLinks');
  links.textContent = '';
  for (const link of help.links) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = link.label;
    links.appendChild(a);
  }
}

function renderProviderSettings(providerOverride?: AiProvider): void {
  const settings = loadProviderSettings();
  const provider = providerOverride ?? settings.activeProvider;
  const model = settings.providers[provider].model || DEFAULT_PROVIDER_MODELS[provider];
  const apiKey = readProviderKey(provider);
  el<HTMLSelectElement>('providerSelect').value = provider;
  el<HTMLInputElement>('providerApiKey').value = apiKey;
  el<HTMLInputElement>('rememberProviderKey').checked = settings.rememberKeys;
  el('providerBtn').querySelector('span')!.textContent = PROVIDER_LABELS[settings.activeProvider];
  renderProviderHelp(provider);
  setProviderModelWarning('');
  const cached = providerModelCache.get(provider);
  if (apiKey && cached !== undefined && cached.apiKey === apiKey) {
    renderProviderModelOptions(provider, cached.models, model);
  } else {
    renderProviderModelPlaceholder(apiKey ? 'Load models to choose' : 'Enter an API key, then load models', model);
    if (apiKey) void refreshProviderModels(provider);
  }
}

function saveProviderForm(): void {
  const provider = selectedProvider();
  const settings = loadProviderSettings();
  const model = el<HTMLSelectElement>('providerModelSelect').value.trim();
  const apiKey = el<HTMLInputElement>('providerApiKey').value.trim() || readProviderKey(provider);
  const rememberKeys = el<HTMLInputElement>('rememberProviderKey').checked;
  if (!apiKey) {
    setProviderModelWarning('Paste this provider API key before saving.');
    updateProviderSaveAvailability();
    return;
  }
  if (!model) {
    setProviderModelWarning('Pick an available model from the live provider list before saving.');
    updateProviderSaveAvailability();
    return;
  }
  settings.activeProvider = provider;
  settings.rememberKeys = rememberKeys;
  settings.providers[provider] = apiKey ? { model, apiKey } : { model };
  saveProviderSettings(settings);
  renderProviderSettings(provider);
  el('providerStatus').textContent = apiKey
    ? `Using ${PROVIDER_LABELS[provider]} with ${model}.`
    : `Saved ${PROVIDER_LABELS[provider]} model. Paste an API key before chatting.`;
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
function listProfileItems(items: readonly string[] | undefined, limit = 6): string {
  if (items === undefined || items.length === 0) return '  (none recorded)';
  return items
    .slice(0, limit)
    .map((item) => `  - ${item}`)
    .join('\n');
}

function learnerProfileBlock(profile: LearnerProfile | null): string {
  if (profile === null) return '';
  return (
    '\n\nGLOBAL LEARNER PROFILE — use across all language courses.\n' +
    `Summary: ${profile.summary ?? 'No summary recorded yet.'}\n` +
    `Known languages:\n${listProfileItems(profile.knownLanguages)}\n` +
    `Experience notes:\n${listProfileItems(profile.experienceNotes)}\n` +
    `Goals:\n${listProfileItems(profile.goals)}\n` +
    `Teaching preferences:\n${listProfileItems(profile.preferences)}\n` +
    `Cross-language strengths:\n${listProfileItems(profile.strengths)}\n` +
    `Cross-language struggles:\n${listProfileItems(profile.struggles)}\n` +
    'Do not re-ask for background already captured here. Ask only missing course-specific context, and update your assumptions when the student corrects you.'
  );
}

function buildSystem(prog: Progress | null, lang: Language, profile: LearnerProfile | null): string {
  const profileText = learnerProfileBlock(profile);
  if (prog === null) {
    const profileGuidance =
      profile === null
        ? ''
        : '\n\nIf the global learner profile already answers any background question above, do not ask that question again; use the recorded answer and ask only for missing details specific to this course.';
    return `${lang.systemPromptIntro}${profileText}\n\n${lang.firstSessionPrompt}${profileGuidance}`;
  }

  const topicLines = lang.topics
    .map((t) => {
      const s = prog.topics?.find((x) => x.id === t.id)?.status ?? 'not-started';
      return `  ${s === 'mastered' ? '✓' : s === 'in-progress' ? '→' : '○'} ${t.title} [${s}]`;
    })
    .join('\n');

  const strengths = prog.strengths && prog.strengths.length > 0 ? prog.strengths.map((s) => `  + ${s}`).join('\n') : '  (none yet)';
  const struggles = prog.struggles && prog.struggles.length > 0 ? prog.struggles.map((s) => `  ! ${s}`).join('\n') : '  (none yet)';

  return (
    `${lang.systemPromptIntro}${profileText}\n\n` +
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
    folio.textContent = 'Start';
    name.textContent = 'Ready to begin';
    meta.textContent = `No ${lang.name} progress yet`;
    return;
  }

  const idx = findCurrentTopicIndex(progress, lang);
  const topic = idx >= 0 ? lang.topics[idx] : undefined;
  folio.textContent = topic !== undefined ? `Topic ${pad2(idx + 1)}` : 'Progress';
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
    cpp: 'clang · c++23',
    dasm: 'clang · objdump · x86-64',
    python: 'local python · 3.13',
    csharp: 'dotnet 8 · c# 12',
    web: `vite · http://${window.location.hostname || 'localhost'}:5180`,
  };
  spec.textContent = map[lang.id];
}

function normalizeDasmFlags(flags: string): string {
  const normalized = flags.trim().replace(/\s+/g, ' ');
  return normalized || DEFAULT_DASM_FLAGS;
}

function currentDasmFlags(): string {
  return normalizeDasmFlags(el<HTMLInputElement>('dasmFlagsInput').value);
}

function syncDasmPreset(flags: string): void {
  const preset = el<HTMLSelectElement>('dasmFlagsPreset');
  const match = DASM_FLAG_PRESETS.find((p) => p.flags === flags);
  preset.value = match?.flags ?? 'custom';
}

function renderDasmFlagsControl(): void {
  const control = el<HTMLDivElement>('dasmFlagsControl');
  const input = el<HTMLInputElement>('dasmFlagsInput');
  const visible = activeLang === 'dasm';
  control.hidden = !visible;
  if (!visible) return;

  const flags = normalizeDasmFlags(storageGet<string>(DASM_FLAGS_KEY) ?? DEFAULT_DASM_FLAGS);
  input.value = flags;
  syncDasmPreset(flags);
}

function setDasmAutoStatus(text: string): void {
  const outputPre = el<HTMLPreElement>('outputPre');
  outputPre.textContent = '';
  outputPre.appendChild(span(text, 'muted'));
  setDasmAsmUpdating(true);
  syncSingleOutputPanes();
  renderSingleOutputTabs();
}

/** Toggle the "Updating…" overlay on the disassembly pane while a re-run is in flight.
 *  The current content stays mounted (dimmed) so the user can still scroll / reference it. */
function setDasmAsmUpdating(updating: boolean): void {
  const asmPre = el<HTMLPreElement>('dasmAsmPre');
  const parent = asmPre.parentElement;
  if (parent === null) return;
  parent.classList.toggle('is-dasm-updating', updating);
}

function saveDasmFlags(flags: string): void {
  const normalized = normalizeDasmFlags(flags);
  el<HTMLInputElement>('dasmFlagsInput').value = normalized;
  syncDasmPreset(normalized);
  storageSet(DASM_FLAGS_KEY, normalized);
  scheduleDasmAutoRun();
}

function cancelDasmAutoRun(): void {
  if (dasmAutoTimer !== null) {
    window.clearTimeout(dasmAutoTimer);
    dasmAutoTimer = null;
  }
}

function scheduleDasmAutoRun(): void {
  if (activeLang !== 'dasm') return;
  dasmAutoRevision += 1;
  if (dasmAutoTimer !== null) window.clearTimeout(dasmAutoTimer);
  dasmAutoTimer = window.setTimeout(() => {
    dasmAutoTimer = null;
    void runDasmAutoDisassembly();
  }, 900);
}

async function runDasmAutoDisassembly(): Promise<void> {
  if (activeLang !== 'dasm') return;
  if (!canUseHostedTooling()) return;
  if (dasmAutoRunning) {
    dasmAutoQueued = true;
    return;
  }

  dasmAutoRunning = true;
  const revision = dasmAutoRevision;
  const code = editor.getContent();
  const flags = currentDasmFlags();
  singleOutputTab = 'output';
  setDasmAutoStatus(`Updating disassembly with ${flags}...`);

  try {
    const result = await runCode(
      'dasm',
      code,
      (msg) => {
        if (activeLang === 'dasm' && revision === dasmAutoRevision) renderSingleOutput(msg, true);
      },
      { compilerFlags: flags }
    );
    if (activeLang === 'dasm' && revision === dasmAutoRevision) {
      renderSingleOutput(result.output, result.ok, { autoSelect: true });
    }
  } finally {
    dasmAutoRunning = false;
    if (dasmAutoQueued) {
      dasmAutoQueued = false;
      scheduleDasmAutoRun();
    }
  }
}

function setFocusMode(next: boolean): void {
  focusMode = next;
  document.documentElement.classList.toggle('focus-mode', focusMode);
  storageSet(FOCUS_MODE_KEY, focusMode);

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-focus-mode-toggle]')) {
    button.setAttribute('aria-pressed', focusMode ? 'true' : 'false');
    button.title = focusMode ? 'Show tutor panel' : 'Collapse tutor panel';
    const icon = button.querySelector('i');
    if (icon !== null) icon.className = focusMode ? 'ti ti-layout-sidebar-left-expand' : 'ti ti-layout-sidebar-left-collapse';
    const label = button.querySelector('span');
    if (label !== null) label.textContent = focusMode ? 'Tutor' : 'Focus';
  }
}

function applyStoredFocusMode(): void {
  setFocusMode(storageGet<boolean>(FOCUS_MODE_KEY) === true);
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

function appendLearnerProfileSection(scroll: HTMLElement): void {
  if (learnerProfile === null) return;

  const section = div('prog-section');
  section.appendChild(progSectionLabel('Cross-language profile'));

  if (learnerProfile.summary) {
    const notesText = div('prog-notes');
    notesText.textContent = learnerProfile.summary;
    section.appendChild(notesText);
  }

  const chips = div('note-row');
  const items = [
    ...(learnerProfile.knownLanguages ?? []).slice(0, 4),
    ...(learnerProfile.goals ?? []).slice(0, 2),
    ...(learnerProfile.preferences ?? []).slice(0, 2),
  ];

  if (items.length === 0) {
    chips.appendChild(span('No cross-language notes recorded yet', 'muted'));
  } else {
    for (const item of items) {
      const pill = div('note-pill');
      pill.appendChild(document.createTextNode(item));
      chips.appendChild(pill);
    }
  }

  section.appendChild(chips);
  scroll.appendChild(section);
}

function renderProgressTab(): void {
  const lang = getLanguage(activeLang);
  const scroll = el('progressScroll');
  scroll.textContent = '';
  appendLearnerProfileSection(scroll);

  if (progress === null) {
    const empty = div('prog-empty');
    const glyph = span('§', 'empty-glyph');
    empty.appendChild(glyph);
    empty.appendChild(document.createTextNode(`No ${lang.name} progress recorded yet.\nSend a tutor message or evaluation to begin tracking.`));
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

/** Strip the `data:image/png;base64,` prefix if present and return raw base64. */
function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

function imageBlockFromDataUrl(dataUrl: string): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: dataUrlToBase64(dataUrl) },
  };
}

function renderImageAttachment(block: ImageBlock): HTMLElement {
  const a = document.createElement('a');
  a.target = '_blank';
  a.rel = 'noopener';
  a.className = 'msg-attachment-link';
  a.draggable = false;
  const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
  a.href = dataUrl;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'screenshot';
  img.className = 'msg-attachment';
  img.draggable = false;
  a.appendChild(img);
  return a;
}

function scrollMessageToTop(block: HTMLElement): void {
  const msgList = el('msgList');
  const top = msgList.scrollTop + block.getBoundingClientRect().top - msgList.getBoundingClientRect().top;
  msgList.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function scrollMessageTowardTopBoundary(block: HTMLElement): void {
  const msgList = el('msgList');
  const topDelta = block.getBoundingClientRect().top - msgList.getBoundingClientRect().top;
  if (topDelta <= 1) return;

  const maxTop = Math.max(0, msgList.scrollHeight - msgList.clientHeight);
  const nextTop = Math.min(maxTop, msgList.scrollTop + topDelta);
  msgList.scrollTo({ top: nextTop, behavior: 'auto' });
}

function addTutorBackToTop(block: HTMLElement): void {
  const actions = div('msg-actions');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-top-btn';
  btn.title = 'Scroll to the start of this response';
  btn.appendChild(span('Back to top'));
  const icon = document.createElement('i');
  icon.className = 'ti ti-arrow-up';
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  btn.addEventListener('click', () => scrollMessageToTop(block));
  actions.appendChild(btn);
  block.appendChild(actions);
}

function appendMsg(role: 'user' | 'assistant', content: string | ContentBlock[]): void {
  const msgList = el('msgList');
  const bl = div('msg-block');
  const lbl = div('msg-label');
  lbl.textContent = role === 'user' ? 'you' : 'tutor';
  const body = div(role === 'user' ? 'msg-you' : 'msg-ai');

  if (role === 'user' && tryRenderUserBundle(body, content)) {
    bl.appendChild(lbl);
    bl.appendChild(body);
    msgList.appendChild(bl);
    msgList.scrollTop = msgList.scrollHeight;
    return;
  }

  if (typeof content === 'string') {
    body.appendChild(role === 'user' ? renderPlainWithFences(content) : renderMarkdown(content));
  } else {
    for (const blk of content) {
      if (blk.type === 'text') {
        body.appendChild(role === 'user' ? renderPlainWithFences(blk.text) : renderMarkdown(blk.text));
      } else {
        body.appendChild(renderImageAttachment(blk));
      }
    }
  }
  bl.appendChild(lbl);
  bl.appendChild(body);
  if (role === 'assistant') addTutorBackToTop(bl);
  msgList.appendChild(bl);
  msgList.scrollTop = msgList.scrollHeight;
}

// ── Send-to-tutor bundle: collapsible rendering ──────────────────────────
// A "bundle" is the structured payload emitted by evaluateCode / evaluateProjectCode:
// `[NOTE]\n…\n\n[CODE]\n```…```\n\n[OUTPUT]\n…` etc. Render the note inline
// (it's the student's actual question) and stash everything else under one chevron.

const BUNDLE_TAG_PATTERN = /^\[(NOTE|CODE|OUTPUT|LSP|FILES|DOM|CONSOLE|SERVER|BUILD|COMPILER FLAGS|SCREENSHOT)\]\n/;
const BUNDLE_NON_NOTE_PATTERN = /\[(?:CODE|OUTPUT|LSP|FILES|DOM|CONSOLE|SERVER|BUILD|COMPILER FLAGS|SCREENSHOT)\]\n/;
const BUNDLE_TAG_LABEL: Record<string, string> = {
  CODE: 'code',
  OUTPUT: 'output',
  LSP: 'diagnostics',
  FILES: 'files',
  DOM: 'DOM',
  CONSOLE: 'console',
  SERVER: 'server logs',
  BUILD: 'build errors',
  'COMPILER FLAGS': 'compiler flags',
  SCREENSHOT: 'screenshot status',
};

interface BundleBlock {
  tag: string;
  body: string;
}

function isBundleText(text: string): boolean {
  return BUNDLE_TAG_PATTERN.test(text) && BUNDLE_NON_NOTE_PATTERN.test(text);
}

function parseBundleBlocks(text: string): BundleBlock[] {
  const blocks: BundleBlock[] = [];
  const re = /\[([A-Z][A-Z ]*)\]\n([\s\S]*?)(?=\n\n\[[A-Z][A-Z ]*\]\n|$)/g;
  for (const m of text.matchAll(re)) {
    const tag = m[1] ?? '';
    const body = (m[2] ?? '').trimEnd();
    if (tag === '') continue;
    blocks.push({ tag, body });
  }
  return blocks;
}

function bundleSummaryText(blocks: BundleBlock[], imageCount: number): string {
  const labels: string[] = [];
  for (const b of blocks) {
    const label = BUNDLE_TAG_LABEL[b.tag];
    if (label !== undefined && !labels.includes(label)) labels.push(label);
  }
  if (imageCount > 0 && !labels.includes('screenshot')) labels.push('screenshot');
  const count = blocks.length + imageCount;
  const items = labels.length > 0 ? labels.join(' + ') : 'context';
  return `Sent ${items} (${count})`;
}

function tryRenderUserBundle(body: HTMLElement, content: string | ContentBlock[]): boolean {
  const text = typeof content === 'string' ? content : (content.find((b): b is TextBlock => b.type === 'text')?.text ?? '');
  if (!isBundleText(text)) return false;

  const images: ImageBlock[] = typeof content === 'string' ? [] : content.filter((b): b is ImageBlock => b.type === 'image');
  const blocks = parseBundleBlocks(text);
  const note = blocks.find((b) => b.tag === 'NOTE');
  const others = blocks.filter((b) => b.tag !== 'NOTE');

  if (note !== undefined && note.body !== '') {
    const noteEl = div('msg-bundle-note');
    noteEl.appendChild(renderPlainWithFences(note.body));
    body.appendChild(noteEl);
  }

  if (others.length === 0 && images.length === 0) return true;

  const details = document.createElement('details');
  details.className = 'msg-bundle-details';
  const summary = document.createElement('summary');
  summary.className = 'msg-bundle-summary';
  summary.textContent = bundleSummaryText(others, images.length);
  details.appendChild(summary);

  for (const block of others) {
    const sec = div('msg-bundle-block');
    const head = div('msg-bundle-block-tag');
    head.textContent = `[${block.tag}]`;
    sec.appendChild(head);
    sec.appendChild(renderPlainWithFences(block.body));
    details.appendChild(sec);
  }

  for (const image of images) {
    const sec = div('msg-bundle-block');
    const head = div('msg-bundle-block-tag');
    head.textContent = '[SCREENSHOT]';
    sec.appendChild(head);
    sec.appendChild(renderImageAttachment(image));
    details.appendChild(sec);
  }

  body.appendChild(details);
  return true;
}

// ── Chat attachment chip (single-slot, replace-not-stack) ─────────────────
let pendingAttachment: ScreenshotPair | null = null;

function setChatAttachment(pair: ScreenshotPair | null): void {
  pendingAttachment = pair;
  const slot = el('chatAttachment');
  slot.textContent = '';
  if (pair === null) {
    slot.style.display = 'none';
    return;
  }
  slot.style.display = 'flex';
  const chip = div('chat-attachment-chip');
  const img = document.createElement('img');
  img.src = pair.thumb;
  img.alt = 'screenshot attachment';
  img.className = 'chat-attachment-thumb';
  const meta = span('Screenshot attached to next message', 'chat-attachment-label');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'chat-attachment-close';
  closeBtn.setAttribute('aria-label', 'Remove attachment');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => setChatAttachment(null));
  chip.appendChild(img);
  chip.appendChild(meta);
  chip.appendChild(closeBtn);
  slot.appendChild(chip);
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
    scrollMessageTowardTopBoundary(bl);
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
      addTutorBackToTop(bl);
    },
  };
}

function initChatTextSelection(): void {
  const msgList = el('msgList');

  msgList.addEventListener('mousedown', () => {
    if (document.body.style.userSelect === 'none') {
      document.body.style.userSelect = '';
    }
  });

  msgList.addEventListener('dragstart', (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

function setSendingState(sending: boolean): void {
  isSending = sending;
  el<HTMLTextAreaElement>('chatInput').disabled = sending;
  el<HTMLButtonElement>('sendBtn').disabled = sending;
  el<HTMLButtonElement>('evalBtn').disabled = sending || history.length === 0;
  el<HTMLButtonElement>('projEvalBtn').disabled = sending || history.length === 0;
}

// ── Start screen ──────────────────────────────────────────────────────────
function showStartScreen(): void {
  const msgList = el('msgList');
  const lang = getLanguage(activeLang);

  const screen = div('start-screen');
  screen.id = 'startScreen';

  const folio = div('start-folio');
  folio.textContent = `course ${pad2(LANGUAGE_IDS.indexOf(lang.id) + 1)} · ${lang.name.toLowerCase()}`;
  screen.appendChild(folio);

  const rule = div('start-rule');
  screen.appendChild(rule);

  const glyph = div('start-glyph');
  glyph.textContent = '§';
  screen.appendChild(glyph);

  const title = document.createElement('h2');
  title.className = 'start-title';
  title.textContent = `Start a new ${lang.name} session.`;
  screen.appendChild(title);

  const body = div('start-body');
  body.textContent = `Practice in the editor, run your code, and send your work to the tutor for review. The tutor adapts to your background and progress.`;
  screen.appendChild(body);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'start-btn';
  button.appendChild(document.createTextNode(`Start session`));
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
  el<HTMLButtonElement>('projEvalBtn').disabled = isSending || history.length === 0;
}

type SingleOutputTab = 'output' | 'errors' | 'dasm';
type DasmLayout = 'split' | 'tab';
const DASM_LAYOUT_KEY = 'lang-tutor:dasm:disasm-layout';
type ProblemSeverity = 'error' | 'warning' | 'info';
type ProblemSource = 'output' | 'diagnostic';

interface SingleProblem {
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

interface DasmOutputParts {
  run: string;
  asm: string;
}

interface AsmRenderState {
  nextGroup: number;
  currentGroup: number | null;
  /** 1-based C++ line number from the most recent `main.cpp:N` marker, awaiting attachment to the next source-text group. */
  pendingSourceLine: number | null;
  /** Built during render: group id → 1-based C++ source line (when known). */
  groupToSource: Map<number, number>;
  /** Built during render: 1-based C++ source line → group ids (multiple groups can share a line in optimized output). */
  sourceToGroups: Map<number, number[]>;
}

/** Snapshot of the most recent DASM render's source↔group maps. Used by the editor-side hover bridge. */
const dasmGroupToSource: Map<number, number> = new Map();
const dasmSourceToGroups: Map<number, number[]> = new Map();

const OUTPUT_PLACEHOLDER = 'Run the program to capture its output here.';
const CSHARP_LOCATION_RE = /(^|[\s([{'"])((?:[A-Za-z]:)?[^\s()\r\n]+?\.\w+)\((\d+),(\d+)\)/g;
const PYTHON_LOCATION_RE = /File "([^"]+)", line (\d+)/g;
const COLON_LOCATION_RE = /(^|[\s([{'"])((?:(?:[A-Za-z]:)?[\\/])?(?:[^\s:()[\]{}'"`]+[\\/])*[A-Za-z0-9_.<>-]+):(\d+)(?::(\d+))?/g;

let singleOutputTab: SingleOutputTab = 'output';
let dasmLayout: DasmLayout = (storageGet<DasmLayout>(DASM_LAYOUT_KEY) ?? 'split') as DasmLayout;
let outputProblems: SingleProblem[] = [];
let lspProblems: SingleProblem[] = [];

function problemPlural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

function isLikelySingleBufferLocation(token: string): boolean {
  const clean = token.trim().replace(/^["']|["']$/g, '');
  if (/^<[^>]+>$/.test(clean)) return true;
  if (clean === 'main') return true;

  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return false;

  const base = fileBasename(clean);
  if (base === lang.fileName) return true;

  const dot = lang.fileName.lastIndexOf('.');
  const ext = dot >= 0 ? lang.fileName.slice(dot) : '';
  return ext.length > 0 && base.endsWith(ext);
}

function addLocatedText(out: LocatedText[], loc: LocatedText): void {
  if (!Number.isFinite(loc.line) || loc.line < 1 || !Number.isFinite(loc.col) || loc.col < 1) return;
  if (!isLikelySingleBufferLocation(loc.token)) return;
  if (out.some((existing) => loc.start < existing.end && loc.end > existing.start)) return;
  out.push(loc);
}

function findLocationsInLine(line: string): LocatedText[] {
  const out: LocatedText[] = [];

  for (const m of line.matchAll(PYTHON_LOCATION_RE)) {
    const token = m[1];
    const lineStr = m[2];
    if (token === undefined || lineStr === undefined || m.index === undefined) continue;
    addLocatedText(out, {
      token,
      line: Number.parseInt(lineStr, 10),
      col: 1,
      start: m.index,
      end: m.index + m[0].length,
      matchText: m[0],
    });
  }

  for (const m of line.matchAll(CSHARP_LOCATION_RE)) {
    const prefix = m[1] ?? '';
    const token = m[2];
    const lineStr = m[3];
    const colStr = m[4];
    if (token === undefined || lineStr === undefined || colStr === undefined || m.index === undefined) continue;
    const matchText = `${token}(${lineStr},${colStr})`;
    addLocatedText(out, {
      token,
      line: Number.parseInt(lineStr, 10),
      col: Number.parseInt(colStr, 10),
      start: m.index + prefix.length,
      end: m.index + prefix.length + matchText.length,
      matchText,
    });
  }

  for (const m of line.matchAll(COLON_LOCATION_RE)) {
    const prefix = m[1] ?? '';
    const token = m[2];
    const lineStr = m[3];
    const colStr = m[4];
    if (token === undefined || lineStr === undefined || m.index === undefined) continue;
    const matchText = `${token}:${lineStr}${colStr === undefined ? '' : `:${colStr}`}`;
    addLocatedText(out, {
      token,
      line: Number.parseInt(lineStr, 10),
      col: colStr === undefined ? 1 : Number.parseInt(colStr, 10),
      start: m.index + prefix.length,
      end: m.index + prefix.length + matchText.length,
      matchText,
    });
  }

  return out.sort((a, b) => a.start - b.start);
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

function parseOutputProblems(text: string): SingleProblem[] {
  if (text.trim().length === 0 || text === OUTPUT_PLACEHOLDER) return [];

  const problems: SingleProblem[] = [];
  let contextSeverity: { severity: ProblemSeverity; ttl: number } | null = null;
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const explicitSeverity = severityFromText(line);
    if (explicitSeverity !== null) {
      contextSeverity = { severity: explicitSeverity, ttl: explicitSeverity === 'error' && /traceback/i.test(line) ? 8 : 3 };
    }

    const locations = findLocationsInLine(line);
    for (const loc of locations) {
      const severity = explicitSeverity ?? contextSeverity?.severity ?? 'info';
      const displayPath = fileBasename(loc.token);
      problems.push({
        id: `output:${index}:${loc.start}:${loc.line}:${loc.col}`,
        severity,
        source: 'output',
        line: loc.line,
        col: loc.col,
        displayLocation: `${displayPath}:${loc.line}:${loc.col}`,
        message: problemMessageFromLine(line, loc.matchText),
        raw: line,
        sourceLineIndex: index,
        matchStart: loc.start,
        matchEnd: loc.end,
      });
    }

    if (contextSeverity !== null) {
      contextSeverity.ttl -= 1;
      if (contextSeverity.ttl <= 0) contextSeverity = null;
    }
  });

  return problems;
}

function severityFromDiagnostic(d: LspDiagnostic): ProblemSeverity {
  if (d.severity === 1) return 'error';
  if (d.severity === 2) return 'warning';
  return 'info';
}

function diagnosticsToProblems(diagnostics: readonly LspDiagnostic[]): SingleProblem[] {
  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return [];
  return diagnostics.map((d, index) => {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const code = d.code !== undefined ? ` [${d.code}]` : '';
    const source = d.source !== undefined && d.source.length > 0 ? `${d.source}: ` : '';
    return {
      id: `lsp:${index}:${line}:${col}:${d.message}`,
      severity: severityFromDiagnostic(d),
      source: 'diagnostic',
      line,
      col,
      displayLocation: `${lang.fileName}:${line}:${col}`,
      message: `${source}${d.message}${code}`,
      raw: d.message,
    };
  });
}

function allSingleProblems(): SingleProblem[] {
  return [...lspProblems, ...outputProblems];
}

function singleProblemCounts(): { errors: number; warnings: number } {
  const problems = allSingleProblems();
  return {
    errors: problems.filter((p) => p.severity === 'error').length,
    warnings: problems.filter((p) => p.severity === 'warning').length,
  };
}

function syncSingleOutputPanes(): void {
  const outputPre = el<HTMLPreElement>('outputPre');
  const errorList = el('errorListPane');
  const dasmTabPane = el('dasmAsmTabPane');
  outputPre.hidden = singleOutputTab !== 'output';
  errorList.hidden = singleOutputTab !== 'errors';
  dasmTabPane.hidden = singleOutputTab !== 'dasm';
  outputPre.setAttribute('aria-hidden', singleOutputTab === 'output' ? 'false' : 'true');
  errorList.setAttribute('aria-hidden', singleOutputTab === 'errors' ? 'false' : 'true');
  dasmTabPane.setAttribute('aria-hidden', singleOutputTab === 'dasm' ? 'false' : 'true');
}

function renderSingleOutputTabs(): void {
  const outputBtn = el<HTMLButtonElement>('outputTabBtn');
  const problemsBtn = el<HTMLButtonElement>('problemsTabBtn');
  const dasmTabBtn = el<HTMLButtonElement>('dasmTabBtn');
  const errorChip = el('problemErrorChip');
  const warningChip = el('problemWarningChip');
  const counts = singleProblemCounts();

  outputBtn.classList.toggle('is-active', singleOutputTab === 'output');
  problemsBtn.classList.toggle('is-active', singleOutputTab === 'errors');
  dasmTabBtn.classList.toggle('is-active', singleOutputTab === 'dasm');
  outputBtn.setAttribute('aria-selected', singleOutputTab === 'output' ? 'true' : 'false');
  problemsBtn.setAttribute('aria-selected', singleOutputTab === 'errors' ? 'true' : 'false');
  dasmTabBtn.setAttribute('aria-selected', singleOutputTab === 'dasm' ? 'true' : 'false');

  errorChip.textContent = problemPlural(counts.errors, 'error');
  warningChip.textContent = problemPlural(counts.warnings, 'warning');
  errorChip.style.display = counts.errors > 0 ? 'inline-flex' : 'none';
  warningChip.style.display = counts.warnings > 0 ? 'inline-flex' : 'none';
  problemsBtn.title =
    counts.errors === 0 && counts.warnings === 0
      ? 'No errors or warnings detected'
      : `${problemPlural(counts.errors, 'error')}, ${problemPlural(counts.warnings, 'warning')}`;
}

function setSingleOutputTab(tab: SingleOutputTab): void {
  singleOutputTab = tab;
  syncSingleOutputPanes();
  renderSingleOutputTabs();
}

/** Apply the persisted DASM disassembly layout (split = right column / tab = lower-pane tab). */
function applyDasmLayout(): void {
  const isDasm = activeLang === 'dasm';
  const wantSplit = isDasm && dasmLayout === 'split';
  const wantTab = isDasm && dasmLayout === 'tab';

  const asmCol = el('dasmAsmColumn');
  const vbar = el('dasmVerticalResize');
  const tabBtn = el('dasmTabBtn');
  const tabPane = el('dasmAsmTabPane');
  const asmPre = el<HTMLPreElement>('dasmAsmPre');
  const layoutBtn = el<HTMLButtonElement>('dasmLayoutBtn');
  const layoutLabel = el('dasmLayoutBtnLabel');

  asmCol.hidden = !wantSplit;
  vbar.hidden = !wantSplit;
  tabBtn.hidden = !wantTab;

  const desiredParent = wantTab ? tabPane : asmCol;
  if (asmPre.parentElement !== desiredParent) desiredParent.appendChild(asmPre);

  if (!wantTab && singleOutputTab === 'dasm') singleOutputTab = 'output';

  layoutBtn.setAttribute('aria-pressed', wantTab ? 'true' : 'false');
  layoutLabel.textContent = dasmLayout === 'split' ? 'Side-by-side' : 'In tab';
  layoutBtn.title = `Currently ${dasmLayout === 'split' ? 'side-by-side' : 'showing as tab'}. Click to switch.`;

  syncSingleOutputPanes();
  renderSingleOutputTabs();
}

function toggleDasmLayout(): void {
  dasmLayout = dasmLayout === 'split' ? 'tab' : 'split';
  storageSet(DASM_LAYOUT_KEY, dasmLayout);
  applyDasmLayout();
}

function jumpToSingleProblem(problem: SingleProblem): void {
  editor.revealAt(problem.line, problem.col);
}

function renderLinkedOutput(text: string, failed: boolean, placeholder = false, host?: HTMLPreElement): void {
  const outputPre = host ?? el<HTMLPreElement>('outputPre');
  outputPre.textContent = '';
  outputPre.classList.toggle('is-error', failed);

  if (placeholder) {
    outputPre.appendChild(span(OUTPUT_PLACEHOLDER, 'muted'));
    return;
  }

  if (text.length === 0) return;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineProblems = outputProblems
      .filter((p) => p.sourceLineIndex === index && p.matchStart !== undefined && p.matchEnd !== undefined)
      .sort((a, b) => (a.matchStart ?? 0) - (b.matchStart ?? 0));
    let cursor = 0;

    for (const problem of lineProblems) {
      const start = problem.matchStart ?? cursor;
      const end = problem.matchEnd ?? start;
      if (start > cursor) outputPre.appendChild(document.createTextNode(line.slice(cursor, start)));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = `output-location-link is-${problem.severity}`;
      link.textContent = line.slice(start, end);
      link.title = `Jump to line ${problem.line}, column ${problem.col}`;
      link.addEventListener('click', () => jumpToSingleProblem(problem));
      outputPre.appendChild(link);
      cursor = end;
    }

    if (cursor < line.length) outputPre.appendChild(document.createTextNode(line.slice(cursor)));
    if (index < lines.length - 1) outputPre.appendChild(document.createTextNode('\n'));
  });
}

function splitDasmOutput(text: string): DasmOutputParts {
  const marker = '\n[disassembly:';
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return { run: text.trimEnd(), asm: '' };

  const run = text.slice(0, markerIdx).trimEnd();
  const asmWithHeader = text.slice(markerIdx + 1);
  const firstBreak = asmWithHeader.indexOf('\n');
  const asm = firstBreak === -1 ? '' : asmWithHeader.slice(firstBreak + 1).trimEnd();
  return { run, asm };
}

function appendAsmText(host: HTMLElement, text: string, className: string): void {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  host.appendChild(s);
}

function appendHighlightedAsmOperands(host: HTMLElement, operands: string): void {
  const tokenRe =
    /\b(?:r(?:[abcd]x|[sb]p|[sd]i|[0-9]{1,2}[bwd]?)|e(?:[abcd]x|[sb]p|[sd]i)|[abcd][lh]|[er]?ip|xmm\d+|ymm\d+|zmm\d+)\b|0x[0-9a-f]+|\b\d+\b|#.*$/gi;
  let cursor = 0;
  for (const m of operands.matchAll(tokenRe)) {
    if (m.index === undefined) continue;
    if (m.index > cursor) host.appendChild(document.createTextNode(operands.slice(cursor, m.index)));
    const token = m[0];
    const cls = token.startsWith('#') ? 'asm-comment' : /^0x|\d/.test(token) ? 'asm-number' : 'asm-register';
    appendAsmText(host, token, cls);
    cursor = m.index + token.length;
  }
  if (cursor < operands.length) host.appendChild(document.createTextNode(operands.slice(cursor)));
}

function groupClass(group: number): string {
  return `asm-group-${group % 6}`;
}

/** `main.cpp:42` — file:line marker emitted by `objdump -l`. Carries the editor line into the next source group. */
const DASM_SRC_MARKER_RE = /^([A-Za-z0-9_./-]+\.(?:cpp|cc|cxx|c\+\+|c|h|hpp|hxx)):(\d+)\s*$/;
/** `add(int, int):`, `MyClass::foo():`, `main():` — objdump function-context line. Meta, not a source group. */
const DASM_FUNC_CONTEXT_RE = /^[A-Za-z_~][A-Za-z0-9_:<>~,\s*&()]*\(.*\):\s*$/;

function appendHighlightedAsmLine(host: HTMLElement, line: string, state: AsmRenderState): void {
  const lineEl = document.createElement('span');
  lineEl.className = 'asm-line';

  const label = /^([0-9a-f]+)\s+<([^>]+)>:$/i.exec(line);
  if (label !== null) {
    lineEl.classList.add('asm-label-line');
    appendAsmText(lineEl, label[1] ?? '', 'asm-address');
    lineEl.appendChild(document.createTextNode(' <'));
    appendAsmText(lineEl, label[2] ?? '', 'asm-label');
    lineEl.appendChild(document.createTextNode('>:'));
    host.appendChild(lineEl);
    return;
  }

  const insn = /^(\s*)([0-9a-f]+):\s+([a-z][a-z0-9._]*)\s*(.*)$/i.exec(line);
  if (insn !== null) {
    lineEl.classList.add('asm-instruction-line');
    if (state.currentGroup !== null) {
      lineEl.dataset.asmGroup = String(state.currentGroup);
      lineEl.classList.add(groupClass(state.currentGroup));
    }
    lineEl.appendChild(document.createTextNode(insn[1] ?? ''));
    appendAsmText(lineEl, insn[2] ?? '', 'asm-address');
    lineEl.appendChild(document.createTextNode(':  '));
    appendAsmText(lineEl, insn[3] ?? '', 'asm-mnemonic');
    const operands = insn[4] ?? '';
    if (operands.length > 0) {
      lineEl.appendChild(document.createTextNode('   '));
      appendHighlightedAsmOperands(lineEl, operands);
    }
    host.appendChild(lineEl);
    return;
  }

  if (/\bR_X86_64_/.test(line)) {
    lineEl.classList.add('asm-relocation-line');
    if (state.currentGroup !== null) {
      lineEl.dataset.asmGroup = String(state.currentGroup);
      lineEl.classList.add(groupClass(state.currentGroup));
    }
    appendAsmText(lineEl, line, 'asm-relocation');
    host.appendChild(lineEl);
    return;
  }

  // `main.cpp:42` — file:line marker from `objdump -l`. Stash the line so the
  // next source-text group can be attached to that editor line for hover.
  const srcMarker = DASM_SRC_MARKER_RE.exec(line);
  if (srcMarker !== null) {
    const parsedLine = Number.parseInt(srcMarker[2] ?? '', 10);
    if (Number.isFinite(parsedLine) && parsedLine > 0) {
      state.pendingSourceLine = parsedLine;
    }
    lineEl.classList.add('asm-meta-line');
    appendAsmText(lineEl, line, 'asm-meta');
    host.appendChild(lineEl);
    return;
  }

  // Function-context lines like `add(int, int):` — meta, never a source group.
  if (DASM_FUNC_CONTEXT_RE.test(line)) {
    lineEl.classList.add('asm-meta-line');
    appendAsmText(lineEl, line, 'asm-meta');
    host.appendChild(lineEl);
    return;
  }

  if (/^\s*(Disassembly of section|\/tmp\/|\.\.\.)/.test(line)) {
    lineEl.classList.add('asm-meta-line');
    appendAsmText(lineEl, line, 'asm-meta');
    host.appendChild(lineEl);
    return;
  }

  if (line.trim().length === 0) {
    appendAsmText(lineEl, line, 'asm-blank');
    host.appendChild(lineEl);
    return;
  }

  state.currentGroup = state.nextGroup;
  state.nextGroup += 1;
  lineEl.dataset.asmGroup = String(state.currentGroup);
  lineEl.classList.add('asm-source-line', groupClass(state.currentGroup));

  if (state.pendingSourceLine !== null) {
    const src = state.pendingSourceLine;
    lineEl.dataset.asmSourceLine = String(src);
    state.groupToSource.set(state.currentGroup, src);
    const existing = state.sourceToGroups.get(src);
    if (existing === undefined) {
      state.sourceToGroups.set(src, [state.currentGroup]);
    } else {
      existing.push(state.currentGroup);
    }
    state.pendingSourceLine = null;
  }

  appendAsmText(lineEl, line, 'asm-source');
  host.appendChild(lineEl);
}

function setAsmGroupHover(host: HTMLElement, groups: number | readonly number[] | null): void {
  const wanted: Set<string> | null = groups === null ? null : new Set((typeof groups === 'number' ? [groups] : groups).map((g) => String(g)));
  for (const line of host.querySelectorAll<HTMLElement>('.asm-line[data-asm-group]')) {
    const attr = line.dataset.asmGroup;
    line.classList.toggle('is-hovered', wanted !== null && attr !== undefined && wanted.has(attr));
  }
}

function attachAsmHover(host: HTMLElement): void {
  for (const line of host.querySelectorAll<HTMLElement>('.asm-line[data-asm-group]')) {
    const groupAttr = line.dataset.asmGroup;
    if (groupAttr === undefined) continue;
    const group = Number.parseInt(groupAttr, 10);
    if (!Number.isFinite(group)) continue;
    line.addEventListener('mouseenter', () => {
      setAsmGroupHover(host, group);
      editor?.setHoveredAsmGroup?.(group);
    });
    line.addEventListener('mouseleave', () => {
      setAsmGroupHover(host, null);
      editor?.setHoveredAsmGroup?.(null);
    });
  }
}

function renderHighlightedAsm(text: string): void {
  const asmPre = el<HTMLPreElement>('dasmAsmPre');
  setDasmAsmUpdating(false);
  asmPre.textContent = '';
  dasmGroupToSource.clear();
  dasmSourceToGroups.clear();

  if (text.trim().length === 0) {
    asmPre.appendChild(span('No disassembly captured yet.', 'muted'));
    publishDasmSourceMap();
    return;
  }

  const lines = text.split(/\r?\n/);
  const state: AsmRenderState = {
    nextGroup: 0,
    currentGroup: null,
    pendingSourceLine: null,
    groupToSource: dasmGroupToSource,
    sourceToGroups: dasmSourceToGroups,
  };
  lines.forEach((line) => {
    appendHighlightedAsmLine(asmPre, line, state);
  });
  attachAsmHover(asmPre);
  publishDasmSourceMap();
}

/** Notify the editor about the new group↔source map so it can paint line stripes. */
function publishDasmSourceMap(): void {
  if (activeLang !== 'dasm' || editor === undefined) return;
  editor.setDasmSourceMap?.(dasmSourceToGroups);
}

/** Editor → asm pane: pointer entered a C++ line. Highlight all matching asm groups for that line. */
function handleDasmEditorLineHover(line: number | null): void {
  if (activeLang !== 'dasm') return;
  const asmPre = el<HTMLPreElement>('dasmAsmPre');
  if (line === null) {
    setAsmGroupHover(asmPre, null);
    editor?.setHoveredAsmGroup?.(null);
    return;
  }
  const groups = dasmSourceToGroups.get(line);
  if (groups === undefined || groups.length === 0) {
    setAsmGroupHover(asmPre, null);
    editor?.setHoveredAsmGroup?.(null);
    return;
  }
  setAsmGroupHover(asmPre, groups);
  // The editor side highlights based on a single hovered group; pick the first to drive
  // its `is-asm-hovered` state so the stripe brightens consistently.
  const primary = groups[0];
  if (primary !== undefined) editor?.setHoveredAsmGroup?.(primary);
}

function renderDasmOutput(text: string, ok: boolean, placeholder = false): DasmOutputParts {
  if (placeholder) {
    renderLinkedOutput(OUTPUT_PLACEHOLDER, false, true);
    renderHighlightedAsm('');
    return { run: '', asm: '' };
  }

  const parts = splitDasmOutput(text);
  const runText = parts.run.trim().length > 0 ? parts.run : '(program produced no stdout/stderr)';
  renderLinkedOutput(runText, !ok, false);

  // The asm pane is only refreshed when the call carries actual disassembly
  // text (i.e. the final result) or a final-error signal — progress callbacks
  // ("Compiling…", "Running…") deliver no DASM markers, and we don't want to
  // wipe the previous disassembly while the new compile is still in flight.
  if (parts.asm.length > 0 || text.includes('[disassembly:')) {
    renderHighlightedAsm(parts.asm);
  } else if (!ok || text.includes('[program exited')) {
    // Final error result with no new asm — drop the "Updating…" overlay but
    // leave the prior asm content in place so the user can still reference it.
    setDasmAsmUpdating(false);
  }
  return parts;
}

function renderProblemSection(title: string, problems: SingleProblem[], host: HTMLElement): void {
  if (problems.length === 0) return;
  const heading = div('output-problems-section-title');
  heading.textContent = title;
  host.appendChild(heading);

  for (const problem of problems) {
    const row = div('output-problem-line', `is-${problem.severity}`);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'output-problem-link';
    link.textContent = problem.displayLocation;
    link.title = `Jump to line ${problem.line}, column ${problem.col}`;
    link.addEventListener('click', () => jumpToSingleProblem(problem));
    row.appendChild(link);

    const severity = span(problem.severity, 'output-problem-severity');
    row.appendChild(severity);
    row.appendChild(span(problem.message, 'output-problem-message'));
    host.appendChild(row);
  }
}

function renderSingleProblemList(): void {
  const pane = el('errorListPane');
  pane.textContent = '';

  const diagnostics = [...lspProblems].sort((a, b) => a.line - b.line || a.col - b.col);
  const output = [...outputProblems].sort((a, b) => a.line - b.line || a.col - b.col);
  if (diagnostics.length === 0 && output.length === 0) {
    pane.appendChild(span('No file or line references detected.', 'muted'));
    return;
  }

  renderProblemSection('Live diagnostics', diagnostics, pane);
  renderProblemSection('Run output', output, pane);
}

function renderSingleOutput(text: string, ok: boolean, opts: { placeholder?: boolean; autoSelect?: boolean } = {}): void {
  lastSingleOutputText = opts.placeholder ? '' : text;
  const dasmMode = activeLang === 'dasm';
  const problemText = dasmMode && !opts.placeholder ? splitDasmOutput(text).run : text;
  outputProblems = opts.placeholder ? [] : parseOutputProblems(problemText);
  if (dasmMode) {
    renderDasmOutput(text, ok, opts.placeholder ?? false);
  } else {
    renderLinkedOutput(text, !ok, opts.placeholder ?? false);
  }
  renderSingleProblemList();

  if (opts.placeholder) {
    singleOutputTab = 'output';
  } else if (opts.autoSelect) {
    singleOutputTab = !ok && outputProblems.length > 0 ? 'errors' : 'output';
  }

  syncSingleOutputPanes();
  renderSingleOutputTabs();
}

function updateSingleDiagnostics(diagnostics: readonly LspDiagnostic[]): void {
  lspProblems = diagnosticsToProblems(diagnostics);
  renderSingleProblemList();
  renderSingleOutputTabs();
}

function clearOutput(): void {
  renderSingleOutput(OUTPUT_PLACEHOLDER, true, { placeholder: true });
}

// ── Single-buffer vs project workshop layout ─────────────────────────────
const SINGLE_BUFFER_IDS = new Set(['fileLabel', 'fileSpec', 'evalBtn', 'runBtn', 'workshopBody', 'resizeBar', 'singleOutputPanel']);

function setWorkshopMode(mode: 'single' | 'project'): void {
  const isProject = mode === 'project';
  for (const id of SINGLE_BUFFER_IDS) {
    el(id).style.display = isProject ? 'none' : '';
  }
  const mainToolbar = document.querySelector<HTMLElement>('.main-toolbar');
  if (mainToolbar !== null) mainToolbar.style.display = isProject ? 'none' : 'flex';
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
  dasm: [],
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
  if (!canUseHostedTooling()) {
    return Promise.resolve({ vscode: false, vs: false, explorer: false });
  }
  if (openAvailabilityPromise === null) {
    openAvailabilityPromise = fetchOpenAvailability().then((a) => {
      openAvailability = a;
      return a;
    });
  }
  return openAvailabilityPromise;
}

function renderProjectAuthRequired(lang: Language): void {
  if (currentProjectUILang !== null || projectEditorInstance !== null || projectPreviewInstance !== null || projectFileTree !== null) {
    destroyProjectUI();
  }
  el('projTree').textContent = 'Sign in to use hosted project files.';
  el('projTabs').textContent = '';
  el('projEditor').textContent = '';
  el('projStatus').textContent = 'Sign in required';
  el('projPreviewBody').textContent = `${lang.name} projects run on the hosted server and require an account.`;
  el('projPreviewTabs').textContent = '';
  el('projPreviewStatus').textContent = 'locked';
  el('projReloadBtn').setAttribute('disabled', 'true');
  el('projOpenExternalBtn').setAttribute('disabled', 'true');
  el('projScreenshotBtn').setAttribute('disabled', 'true');
  el('projConsoleRunBtn').setAttribute('disabled', 'true');
  el('projResetFilesBtn').setAttribute('disabled', 'true');
  el('projRunBtn').setAttribute('disabled', 'true');
  el('projRunLabel').textContent = 'Sign in';
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
  if (!canUseHostedTooling()) {
    renderProjectAuthRequired(lang);
    return;
  }
  if (currentProjectUILang === id) return;
  if (currentProjectUILang !== null) destroyProjectUI();

  el('projReloadBtn').removeAttribute('disabled');
  el('projOpenExternalBtn').removeAttribute('disabled');
  el('projScreenshotBtn').removeAttribute('disabled');
  el('projConsoleRunBtn').removeAttribute('disabled');
  el('projResetFilesBtn').removeAttribute('disabled');
  el('projRunBtn').removeAttribute('disabled');

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

  // Both runtime flavours own the preview pane; createProjectPreview
  // dispatches on lang.runtime.kind to pick the iframe (web-vite) or
  // Output/Build-errors (desktop-process) variant.
  el('projPreview').style.display = '';
  el('projPreviewResize').style.display = '';
  el('projEvalBtn').style.display = '';
  projectPreviewInstance = createProjectPreview({
    lang,
    tabsHost: el('projPreviewTabs'),
    bodyHost: el('projPreviewBody'),
    statusEl: el('projPreviewStatus'),
    runBtn: el<HTMLButtonElement>('projRunBtn'),
    runLabelEl: el('projRunLabel'),
    reloadBtn: el<HTMLButtonElement>('projReloadBtn'),
    externalBtn: el<HTMLButtonElement>('projOpenExternalBtn'),
    screenshotBtn: el<HTMLButtonElement>('projScreenshotBtn'),
    consoleRunBtn: el<HTMLButtonElement>('projConsoleRunBtn'),
    getConsoleSnippet: () => projectEditorInstance?.getActiveFile() ?? null,
    onScreenshot: (pair) => setChatAttachment(pair),
    onScreenshotError: (reason) => {
      console.warn('[screenshot]', reason);
    },
    onJumpTo: (path, line, col) => {
      void projectEditorInstance?.revealAt(path, line, col);
      projectFileTree?.expandPath(path);
      projectFileTree?.setActive(path);
    },
  });

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

const PROJ_TREE_WIDTH_KEY = 'lang-tutor:proj-tree-width';
const PROJ_TREE_MIN = 140;
const PROJ_TREE_DEFAULT = 220;

function clampTreeWidth(width: number, total: number): number {
  // Tree takes ≥ PROJ_TREE_MIN px, ≤ 60% of the workspace width. The 60% cap
  // keeps the editor usable even on narrow screens.
  const max = Math.max(PROJ_TREE_MIN + 200, total * 0.6);
  return Math.max(PROJ_TREE_MIN, Math.min(width, max));
}

function updateTreeAriaValue(bar: HTMLElement, tree: HTMLElement): void {
  const workspace = tree.parentElement;
  if (workspace === null) return;
  const total = workspace.getBoundingClientRect().width;
  if (total <= 0) return;
  const pct = Math.round((tree.getBoundingClientRect().width / total) * 100);
  bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, pct))));
}

function initProjectTreeResize(): void {
  const bar = el('projTreeResize');
  const tree = el('projTree');

  const stored = storageGet<number>(PROJ_TREE_WIDTH_KEY);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    const workspace = tree.parentElement;
    const total = workspace?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    tree.style.flex = `0 0 ${clampTreeWidth(stored, total)}px`;
  }
  updateTreeAriaValue(bar, tree);

  let startX = 0;
  let startW = 0;

  function onMove(e: MouseEvent): void {
    const workspace = tree.parentElement;
    if (workspace === null) return;
    const total = workspace.getBoundingClientRect().width;
    // Tree is on the RIGHT edge of the workspace, so dragging the handle to
    // the left grows the tree (negative dx = wider tree).
    const next = clampTreeWidth(startW - (e.clientX - startX), total);
    tree.style.flex = `0 0 ${next}px`;
    updateTreeAriaValue(bar, tree);
  }

  function onUp(): void {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    storageSet(PROJ_TREE_WIDTH_KEY, tree.getBoundingClientRect().width);
    updateTreeAriaValue(bar, tree);
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    startX = e.clientX;
    startW = tree.getBoundingClientRect().width;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => {
    tree.style.flex = `0 0 ${PROJ_TREE_DEFAULT}px`;
    storageDelete(PROJ_TREE_WIDTH_KEY);
    requestAnimationFrame(() => updateTreeAriaValue(bar, tree));
  });
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
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
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
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
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
  if (!canUseHostedTooling()) return;
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
  const profileWhenStarted = learnerProfile;

  try {
    const extracted = await fetchProgressExtraction(history, lang.topics);
    const extractedProfile = await fetchLearnerProfileExtraction(history, lang.name, profileWhenStarted);
    if (langWhenStarted !== activeLang) return;

    const [datePart] = new Date().toISOString().split('T');
    const date = datePart ?? '';

    if (extractedProfile !== null) {
      learnerProfile = {
        ...extractedProfile,
        updatedAt: date,
      };
      storageSet(LEARNER_PROFILE_KEY, learnerProfile);
    }

    if (extracted !== null) {
      const mergedTopics: TopicStatus[] = lang.topics.map((t) => {
        const found = extracted.topics?.find((p) => p.id === t.id);
        const prev = progress?.topics?.find((p) => p.id === t.id);
        return { id: t.id, title: t.title, status: found?.status ?? prev?.status ?? 'not-started' };
      });

      progress = {
        ...extracted,
        topics: mergedTopics,
        sessionCount: (progress?.sessionCount ?? 0) + (progress !== null ? 0 : 1),
        lastSeen: date,
      };

      storageSet(progressKey(activeLang), progress);
    }

    currentSystemPrompt = buildSystem(progress, getLanguage(activeLang), learnerProfile);
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
//
// `lastMessageOverride` lets the caller swap out the persisted final message
// with a heavier one for the API call only — used for screenshots so history
// keeps the 256 px thumbnail but Claude sees the 1568 px full-res frame.
async function streamReply(lastMessageOverride?: Message): Promise<{ ok: boolean; text: string }> {
  const msgsForApi = lastMessageOverride !== undefined ? [...history.slice(0, -1), lastMessageOverride] : history;
  const state = { bubble: null as StreamingBubble | null };
  const result = await callClaude(msgsForApi, currentSystemPrompt, (chunk) => {
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
    appendErrorMsg(result.text, () => void deliverReply(lastMessageOverride));
  }
  return result;
}

async function deliverReply(lastMessageOverride?: Message): Promise<boolean> {
  setSendingState(true);
  showThinking();
  const result = await streamReply(lastMessageOverride);
  if (result.ok) {
    history.push({ role: 'assistant', content: result.text });
    storageSet(historyKey(activeLang), history.slice(-MAX_HISTORY));
  }
  setSendingState(false);
  el<HTMLTextAreaElement>('chatInput').focus();
  return result.ok;
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

/**
 * Send a chat or evaluate message to the tutor.
 *
 * `attachment` semantics:
 *  - `undefined` (param omitted)   → consume `pendingAttachment` (the chip
 *                                    set via the manual screenshot button)
 *                                    and clear it after pushing to history.
 *  - explicit `ScreenshotPair`     → use this pair *without* touching the
 *                                    chip — used by `evaluateProjectCode`
 *                                    when it auto-captures fresh.
 *  - explicit `null`               → force text-only, ignoring any chip.
 *
 * History keeps the 256 px thumbnail; the API gets the 1568 px full image via
 * `deliverReply`'s `lastMessageOverride`.
 */
async function sendMessage(text: string, attachment?: ScreenshotPair | null): Promise<void> {
  if (!text.trim() || isSending) return;
  el<HTMLTextAreaElement>('chatInput').value = '';

  const consumePending = attachment === undefined;
  const att = consumePending ? pendingAttachment : attachment;

  if (history.at(-1)?.role === 'user') {
    history.pop();
    discardPendingFailure();
  }

  let storedContent: string | ContentBlock[];
  let apiOverride: Message | undefined;
  if (att !== null && att !== undefined) {
    const textBlock: TextBlock = { type: 'text', text };
    storedContent = [textBlock, imageBlockFromDataUrl(att.thumb)];
    apiOverride = { role: 'user', content: [textBlock, imageBlockFromDataUrl(att.full)] };
  } else {
    storedContent = text;
  }

  history.push({ role: 'user', content: storedContent });
  appendMsg('user', storedContent);
  if (consumePending && pendingAttachment !== null) setChatAttachment(null);

  const ok = await deliverReply(apiOverride);
  if (ok) void extractProgress();
}

function draftNoteBlock(): string | null {
  const note = el<HTMLTextAreaElement>('chatInput').value.trim();
  return note ? `[NOTE]\n${note}` : null;
}

// ── Code panel ────────────────────────────────────────────────────────────
async function runActiveCode(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return;

  const code = editor.getContent();
  if (lang.id === 'dasm') {
    cancelDasmAutoRun();
    dasmAutoRevision += 1;
  }
  const runBtn = el<HTMLButtonElement>('runBtn');
  runBtn.disabled = true;
  el('runLabel').textContent = 'Running…';
  singleOutputTab = 'output';
  if (lang.id === 'dasm') {
    setDasmAutoStatus(`Running with ${currentDasmFlags()}...`);
  } else {
    renderSingleOutput('', true);
  }

  const langAtStart = activeLang;
  const options = lang.id === 'dasm' ? { compilerFlags: currentDasmFlags() } : undefined;
  const result = await runCode(
    lang.id as SingleBufferLanguageId,
    code,
    (msg) => {
      if (activeLang === langAtStart) renderSingleOutput(msg, true);
    },
    options
  );

  if (activeLang !== langAtStart) {
    runBtn.disabled = false;
    el('runLabel').textContent = 'Run';
    return;
  }

  renderSingleOutput(result.output, result.ok, { autoSelect: true });
  runBtn.disabled = false;
  el('runLabel').textContent = 'Run';
}

async function evaluateCode(): Promise<void> {
  const lang = getLanguage(activeLang);
  if (!isSingleBufferLanguage(lang)) return;

  const code = editor.getContent().trim();
  const out = lastSingleOutputText || (el<HTMLPreElement>('outputPre').textContent ?? '');
  const hasOut =
    out.trim().length > 0 &&
    !out.includes('Run the program') &&
    !out.startsWith('Updating disassembly') &&
    out !== 'Compiling…' &&
    out !== 'Running…';
  const noteBlock = draftNoteBlock();
  const lspBlock = await buildLspBlock();
  const blocks = [
    noteBlock,
    lang.id === 'dasm' ? `[COMPILER FLAGS]\n${currentDasmFlags()}` : null,
    `[CODE]\n\`\`\`${lang.fenceLang}\n${code}\n\`\`\``,
    `[OUTPUT]\n\`\`\`\n${hasOut ? out : '(not run yet)'}\n\`\`\``,
    lspBlock,
  ].filter((block): block is string => block !== null);
  await sendMessage(blocks.join('\n\n'));
}

const LSP_SEVERITY_RANK = (s: number | undefined): number => (s === 1 ? 0 : s === 2 ? 1 : s === 3 ? 2 : 3);
const LSP_SEVERITY_LABEL = (s: number | undefined): string => (s === 1 ? 'error' : s === 2 ? 'warning' : s === 3 ? 'info' : 'hint');

/** Truncate a multiline blob (e.g., LSP hover markdown) so it doesn't dominate the prompt. */
function clipBlock(text: string, maxLines: number, maxLineLen: number): string {
  const lines = text.split('\n');
  const clipped = lines.slice(0, maxLines).map((l) => (l.length > maxLineLen ? `${l.slice(0, maxLineLen)}…` : l));
  if (lines.length > maxLines) clipped.push(`…(+${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'})`);
  return clipped.join('\n');
}

/** Render LSP MarkupContent / MarkedString[] to a plaintext string. Same shape as lspEditor's renderHoverContents but kept local to keep main.ts free of editor imports. */
function renderHoverText(contents: unknown): string {
  if (contents === undefined || contents === null) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === 'string' ? c : ((c as { value?: string }).value ?? ''))).join('\n\n');
  const obj = contents as { value?: string };
  return obj.value ?? '';
}

/** Names of LSP SymbolKind values we surface — top-level structural shapes worth knowing about. */
const SYMBOL_KIND_NAME: Record<number, string> = {
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  22: 'struct',
  23: 'event',
};

interface FlatSymbol {
  name: string;
  kindLabel: string;
  line: number;
}

/** Flatten DocumentSymbol[] to a depth ≤ 1 list of named tutor-relevant kinds. */
function flattenSymbols(
  symbols: ReadonlyArray<{
    name: string;
    kind: number;
    range: { start: { line: number } };
    children?: ReadonlyArray<{ name: string; kind: number; range: { start: { line: number } } }>;
  }>
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  for (const s of symbols) {
    const kindLabel = SYMBOL_KIND_NAME[s.kind];
    if (kindLabel !== undefined) out.push({ name: s.name, kindLabel, line: s.range.start.line + 1 });
    if (s.children !== undefined) {
      for (const c of s.children) {
        const ck = SYMBOL_KIND_NAME[c.kind];
        if (ck !== undefined) out.push({ name: `${s.name}.${c.name}`, kindLabel: ck, line: c.range.start.line + 1 });
      }
    }
  }
  return out;
}

/**
 * Build an `[LSP]` block from the active language's LSP diagnostics, plus
 * (when meaningful) a short top-level symbol map and the hover text at the
 * student's cursor. Returns null when there's nothing useful to surface.
 *
 * Sub-blocks are independently nullable — a clean file with informative
 * symbols / hover still emits an [LSP] block; a noisy file with no symbols
 * still emits diagnostics-only.
 */
async function buildLspBlock(): Promise<string | null> {
  const client = editor.getLspClient();
  if (client === null) return null;

  const diagnostics = client.getDiagnostics();
  const sortedDiags = [...diagnostics].sort((a, b) => {
    const r = LSP_SEVERITY_RANK(a.severity) - LSP_SEVERITY_RANK(b.severity);
    if (r !== 0) return r;
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });

  // Symbols + hover only fire requests when capabilities exist; both calls
  // already short-circuit when not supported, so this is safe to fan out.
  const code = editor.getContent();
  const lineCount = code === '' ? 0 : code.split('\n').length;
  const cursor = editor.getCursorPosition();
  const symbolsPromise = lineCount >= 20 ? client.documentSymbol() : Promise.resolve(null);
  const hoverPromise = client.hover(cursor.line, cursor.character);
  const [symbols, hover] = await Promise.all([symbolsPromise, hoverPromise]);

  const sections: string[] = [];

  if (sortedDiags.length > 0) {
    const lines = sortedDiags.slice(0, 30).map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const code = d.code !== undefined ? ` [${d.code}]` : '';
      const source = d.source !== undefined && d.source.length > 0 ? `${d.source}: ` : '';
      return `  main:${line}:${col} ${LSP_SEVERITY_LABEL(d.severity)}${code} — ${source}${d.message}`;
    });
    const overflow = sortedDiags.length > lines.length ? `\n  …${sortedDiags.length - lines.length} more diagnostics` : '';
    sections.push(`diagnostics:\n${lines.join('\n')}${overflow}`);
  }

  if (symbols !== null && symbols.length > 0) {
    const flat = flattenSymbols(symbols).slice(0, 20);
    if (flat.length > 0) {
      const symLines = flat.map((s) => `  main:${s.line} ${s.kindLabel} ${s.name}`);
      sections.push(`symbols:\n${symLines.join('\n')}`);
    }
  }

  if (hover !== null) {
    const text = renderHoverText(hover.contents).trim();
    if (text.length > 0) {
      const cursorLabel = `main:${cursor.line + 1}:${cursor.character + 1}`;
      sections.push(`hover at ${cursorLabel}:\n${clipBlock(text, 6, 200)}`);
    }
  }

  if (sections.length === 0) return null;
  return `[LSP]\n${sections.join('\n\n')}`;
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
    case 'xml':
    case 'xaml':
    case 'csproj':
      return 'xml';
    case 'cs':
      return 'csharp';
    default:
      return '';
  }
}

const PROJECT_CONTEXT_MAX_FILES = 18;
const PROJECT_CONTEXT_MAX_CHARS = 70_000;
const PROJECT_CONTEXT_MAX_FILE_CHARS = 24_000;
const PROJECT_CONTEXT_OMITTED_PREVIEW = 12;
const BOOTSTRAP_START = '<!-- lang-tutor:bootstrap-start -->';
const BOOTSTRAP_END = '<!-- lang-tutor:bootstrap-end -->';

interface ProjectContextFile {
  path: string;
  content: string;
  dirty: boolean;
  source: 'open' | 'workspace';
  truncatedFrom?: number;
}

interface ProjectContextResult {
  files: ProjectContextFile[];
  omitted: string[];
  failed: string[];
}

function normalizeProjectPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function stripGeneratedProjectContext(path: string, content: string): string {
  if (normalizeProjectPath(path).toLowerCase() !== 'index.html') return content;
  const startIdx = content.indexOf(BOOTSTRAP_START);
  const endIdx = content.indexOf(BOOTSTRAP_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return content;
  const before = content.slice(0, startIdx).replace(/\s+$/, '');
  const after = content.slice(endIdx + BOOTSTRAP_END.length).replace(/^\s+/, '');
  return `${before}\n${after}`;
}

function isProjectContextPath(lang: ProjectLanguage, path: string): boolean {
  const normalized = normalizeProjectPath(path);
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');
  if (segments.some((part) => ['node_modules', '.git', 'dist', '.vite', '.vite-temp', 'bin', 'obj', '.vs'].includes(part))) return false;
  if (lower.endsWith('.map') || lower.endsWith('.lock') || lower.endsWith('pnpm-lock.yaml') || lower.endsWith('package-lock.json')) return false;

  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot + 1);
  if (lang.id === 'web') {
    return ['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json'].includes(ext);
  }
  if (lang.id === 'csharp') {
    return ['cs', 'xaml', 'csproj', 'sln'].includes(ext);
  }
  return false;
}

function projectContextRank(lang: ProjectLanguage, path: string): number {
  const normalized = normalizeProjectPath(path);
  const lower = normalized.toLowerCase();
  if (lang.id === 'web') {
    const primary = ['index.html', 'app.js', 'style.css', 'package.json', 'vite.config.js', 'jsconfig.json', 'biome.json'];
    const idx = primary.indexOf(lower);
    if (idx !== -1) return idx;
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 20;
    if (lower.endsWith('.css')) return 30;
    if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(lower)) return 40;
    if (lower.endsWith('.json')) return 80;
  }
  if (lang.id === 'csharp') {
    const primary = [
      'LangTutor.Console/Program.cs',
      'LangTutor.Wpf/MainWindow.xaml',
      'LangTutor.Wpf/MainWindow.xaml.cs',
      'LangTutor.Wpf/App.xaml',
      'LangTutor.Wpf/App.xaml.cs',
      'LangTutor.Wpf/LangTutor.Wpf.csproj',
      'LangTutor.Console/LangTutor.Console.csproj',
      'LangTutor.sln',
    ].map((p) => p.toLowerCase());
    const idx = primary.indexOf(lower);
    if (idx !== -1) return idx;
    if (lower.endsWith('.cs')) return 20;
    if (lower.endsWith('.xaml')) return 30;
    if (lower.endsWith('.csproj')) return 50;
    if (lower.endsWith('.sln')) return 60;
  }
  return 100;
}

async function projectTreeForContext(lang: ProjectLanguage): Promise<import('./types').FsNode | null> {
  const cached = projectStates.get(lang.id);
  if (cached?.tree !== null && cached?.tree !== undefined) return cached.tree;

  let response = await fetchTree(lang.id);
  if (!response.scaffolded) {
    await ensureScaffold(lang.id);
    response = await fetchTree(lang.id);
  }

  const state = projectStates.get(lang.id) ?? loadProjectStateFromStorage(lang.id);
  state.tree = response.tree;
  state.scaffolded = response.scaffolded;
  projectStates.set(lang.id, state);
  projectFileTree?.render(response.tree);
  return response.tree;
}

async function collectProjectContextFiles(
  lang: ProjectLanguage,
  openFiles: Array<{ path: string; content: string; dirty: boolean }>
): Promise<ProjectContextResult> {
  const openByPath = new Map(openFiles.map((file) => [normalizeProjectPath(file.path), file]));
  let candidatePaths: string[] = [];

  try {
    const tree = await projectTreeForContext(lang);
    candidatePaths = flattenFiles(tree)
      .map(normalizeProjectPath)
      .filter((path) => isProjectContextPath(lang, path))
      .sort((a, b) => projectContextRank(lang, a) - projectContextRank(lang, b) || a.localeCompare(b));
  } catch (e) {
    console.warn('[project] failed to collect workspace file context', e);
  }

  const openPaths = [...openByPath.keys()];
  const autoSlots = Math.max(0, PROJECT_CONTEXT_MAX_FILES - openPaths.length);
  const autoPaths = candidatePaths.filter((path) => !openByPath.has(path));
  const selectedPaths = [...openPaths, ...autoPaths.slice(0, autoSlots)];
  const omitted = autoPaths.slice(autoSlots);
  const failed: string[] = [];
  const files: ProjectContextFile[] = [];
  let totalChars = 0;

  for (const path of selectedPaths) {
    const openFile = openByPath.get(path);
    let content: string;
    let dirty = false;
    let source: ProjectContextFile['source'] = 'workspace';
    try {
      if (openFile !== undefined) {
        content = openFile.content;
        dirty = openFile.dirty;
        source = 'open';
      } else {
        content = await fetchFile(lang.id, path);
      }
    } catch {
      failed.push(path);
      continue;
    }

    content = stripGeneratedProjectContext(path, content);
    const truncatedFrom = content.length > PROJECT_CONTEXT_MAX_FILE_CHARS ? content.length : undefined;
    if (truncatedFrom !== undefined) {
      content = content.slice(0, PROJECT_CONTEXT_MAX_FILE_CHARS);
    }

    if (files.length > 0 && totalChars + content.length > PROJECT_CONTEXT_MAX_CHARS) {
      omitted.push(path);
      continue;
    }

    totalChars += content.length;
    const contextFile: ProjectContextFile = { path, content, dirty, source };
    if (truncatedFrom !== undefined) contextFile.truncatedFrom = truncatedFrom;
    files.push(contextFile);
  }

  return { files, omitted, failed };
}

function formatProjectFilesBlock(context: ProjectContextResult): string {
  if (context.files.length === 0) {
    const suffix = context.failed.length > 0 ? `\n(unable to read: ${context.failed.slice(0, PROJECT_CONTEXT_OMITTED_PREVIEW).join(', ')})` : '';
    return `[FILES]\n(no relevant project files found${suffix})`;
  }

  const fileBlock = context.files
    .map((file) => {
      const flags = [
        file.dirty ? 'unsaved' : null,
        file.source === 'workspace' ? 'auto-included' : null,
        file.truncatedFrom !== undefined ? `truncated from ${file.truncatedFrom} chars` : null,
      ].filter((flag): flag is string => flag !== null);
      const label = flags.length > 0 ? ` (${flags.join(', ')})` : '';
      return `--- ${file.path}${label} ---\n\`\`\`${fenceLangFromPath(file.path)}\n${file.content}\n\`\`\``;
    })
    .join('\n\n');

  const notes: string[] = [];
  if (context.omitted.length > 0) {
    const preview = context.omitted.slice(0, PROJECT_CONTEXT_OMITTED_PREVIEW).join(', ');
    const more =
      context.omitted.length > PROJECT_CONTEXT_OMITTED_PREVIEW ? `, +${context.omitted.length - PROJECT_CONTEXT_OMITTED_PREVIEW} more` : '';
    notes.push(`omitted: ${preview}${more}`);
  }
  if (context.failed.length > 0) {
    const preview = context.failed.slice(0, PROJECT_CONTEXT_OMITTED_PREVIEW).join(', ');
    const more = context.failed.length > PROJECT_CONTEXT_OMITTED_PREVIEW ? `, +${context.failed.length - PROJECT_CONTEXT_OMITTED_PREVIEW} more` : '';
    notes.push(`unable to read: ${preview}${more}`);
  }

  return notes.length > 0 ? `[FILES]\n${fileBlock}\n\n(${notes.join('; ')})` : `[FILES]\n${fileBlock}`;
}

async function evaluateProjectCode(): Promise<void> {
  if (projectEditorInstance === null) return;
  const langWhenStarted = activeLang;
  const lang = getLanguage(langWhenStarted);
  if (lang.kind !== 'project') return;

  const openFiles = projectEditorInstance.getOpenFiles();
  const preview = projectPreviewInstance;
  const isWeb = lang.runtime.kind === 'web-vite';
  const noteBlock = draftNoteBlock();

  // The DOM/console snapshot only exists for web-vite (iframe-based). Desktop
  // projects skip it — there is no rendered page to capture.
  const snapshotPromise = isWeb && preview?.isRunning() ? preview.requestSnapshot() : Promise.resolve(null);
  const logsPromise = fetchRecentLogs(langWhenStarted, 60).catch(() => ({ lines: [] as { stream: string; line: string; ts: number }[] }));
  // Auto-capture a screenshot in parallel with the other prep. Either runtime
  // (web-vite or desktop-process) can supply one through requestScreenshot().
  // Hard-cap so a stuck capture never blocks the evaluate forever.
  const screenshotPromise: Promise<ScreenshotPair | null> =
    preview?.isRunning() === true
      ? Promise.race([preview.requestScreenshot(), new Promise<null>((res) => window.setTimeout(() => res(null), 15_000))])
      : Promise.resolve(null);

  const filesPromise = collectProjectContextFiles(lang, openFiles);
  const [snapshot, logs, screenshot, fileContext] = await Promise.all([snapshotPromise, logsPromise, screenshotPromise, filesPromise]);
  if (langWhenStarted !== activeLang) return;

  const blocks: string[] = [];
  if (noteBlock !== null) blocks.push(noteBlock);
  blocks.push(formatProjectFilesBlock(fileContext));

  if (isWeb) {
    if (snapshot !== null) {
      // Vite's HMR error overlay is a sibling of the user tree, so the [DOM]
      // block doesn't surface it. Hoist its text into a [BUILD] block above
      // [DOM] when present so the tutor leads with the actual build error.
      if (snapshot.hmrOverlay !== null) {
        blocks.push(`[BUILD]\n\`\`\`\n${snapshot.hmrOverlay}\n\`\`\``);
      }
      const cleanDom = stripGeneratedProjectContext('index.html', snapshot.dom);
      blocks.push(`[DOM] (rendered at ${snapshot.url})\n\`\`\`html\n${cleanDom}\n\`\`\``);
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
  } else {
    // Desktop projects: no iframe, no DOM, no console — just process output.
    // Label as [OUTPUT] (not [SERVER]) so the tutor prompt can talk about
    // dotnet stdout/stderr without "server" being misleading.
    if (logs.lines.length > 0) {
      const outputBlock = logs.lines.map((l) => l.line).join('\n');
      blocks.push(`[OUTPUT]\n\`\`\`\n${outputBlock}\n\`\`\``);
    } else {
      blocks.push(
        preview?.isRunning() === true
          ? '[OUTPUT]\n(process running but has produced no output yet — typical for a fresh WPF launch where the build is silent and the window is up)'
          : '[OUTPUT]\n(process is stopped — Run to capture build output and runtime logs; for UI behaviour paste a screenshot)'
      );
    }
  }

  // [LSP] block for project workspaces — surfaces every LSP-published
  // diagnostic across the open tabs. Only included when the LSP is actually
  // connected and reporting something.
  const projectLspBlock = await buildProjectLspBlock();
  if (projectLspBlock !== null) blocks.push(projectLspBlock);

  // [SCREENSHOT] note — added only when capture was attempted but failed so
  // the tutor can either ask for a manual share or proceed without visual.
  // On success the image rides as an Anthropic content block (see sendMessage).
  if (preview?.isRunning() === true && screenshot === null) {
    blocks.push('[SCREENSHOT]\n(capture failed or timed out — proceed with the text payload, or ask the student to share a screenshot manually)');
  }

  await sendMessage(blocks.join('\n\n'), screenshot);
}

/**
 * Build an `[LSP]` block from the project workspace's LSP diagnostics across
 * all currently-open files, plus (when available) symbols for the active tab
 * and the hover text at the student's cursor. Returns null when nothing
 * useful surfaces. URIs are stripped to file basenames so the tutor sees
 * `Program.cs:14:8` rather than the full session-temp path.
 */
async function buildProjectLspBlock(): Promise<string | null> {
  const client = projectEditorInstance?.getLspClient() ?? null;
  if (client === null) return null;
  const editorRef = projectEditorInstance;

  const byUri = client.getDiagnosticsByUri();
  const diagLines: string[] = [];
  let totalDiagnostics = 0;
  for (const [uri, diagnostics] of byUri.entries()) {
    if (diagnostics.length === 0) continue;
    const fileName = uri.split('/').pop() ?? uri;
    const sorted = [...diagnostics].sort((a, b) => {
      const r = LSP_SEVERITY_RANK(a.severity) - LSP_SEVERITY_RANK(b.severity);
      if (r !== 0) return r;
      if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
      return a.range.start.character - b.range.start.character;
    });
    for (const d of sorted) {
      if (totalDiagnostics >= 30) break;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const code = d.code !== undefined ? ` [${d.code}]` : '';
      const source = d.source !== undefined && d.source.length > 0 ? `${d.source}: ` : '';
      diagLines.push(`  ${fileName}:${line}:${col} ${LSP_SEVERITY_LABEL(d.severity)}${code} — ${source}${d.message}`);
      totalDiagnostics += 1;
    }
    if (totalDiagnostics >= 30) break;
  }

  const cursor = editorRef?.getCursorPosition() ?? null;
  const cursorFileName = cursor !== null ? (cursor.uri.split('/').pop() ?? cursor.uri) : null;
  const symbolsPromise = cursor !== null ? client.documentSymbolUri(cursor.uri) : Promise.resolve(null);
  const hoverPromise = cursor !== null ? client.hoverUri(cursor.uri, cursor.line, cursor.character) : Promise.resolve(null);
  const [symbols, hover] = await Promise.all([symbolsPromise, hoverPromise]);

  const sections: string[] = [];
  if (diagLines.length > 0) sections.push(`diagnostics:\n${diagLines.join('\n')}`);

  if (symbols !== null && symbols.length > 0 && cursorFileName !== null) {
    const flat = flattenSymbols(symbols).slice(0, 20);
    if (flat.length > 0) {
      const symLines = flat.map((s) => `  ${cursorFileName}:${s.line} ${s.kindLabel} ${s.name}`);
      sections.push(`symbols (active file):\n${symLines.join('\n')}`);
    }
  }

  if (hover !== null && cursor !== null && cursorFileName !== null) {
    const text = renderHoverText(hover.contents).trim();
    if (text.length > 0) {
      const cursorLabel = `${cursorFileName}:${cursor.line + 1}:${cursor.character + 1}`;
      sections.push(`hover at ${cursorLabel}:\n${clipBlock(text, 6, 200)}`);
    }
  }

  if (sections.length === 0) return null;
  return `[LSP]\n${sections.join('\n\n')}`;
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
  // Project-kind languages also have on-disk files we need to wipe — call out
  // the destructive step so the user knows their edited XAML / cs / config is
  // about to vanish, not just chat history and progress.
  const prompt = isSingleBufferLanguage(lang)
    ? `Reset all ${lang.name} progress and start fresh?`
    : `Reset all ${lang.name} progress, delete projects/${lang.scaffoldDir}/, and re-scaffold from the template?`;
  if (!confirm(prompt)) return;

  storageDelete(progressKey(activeLang));
  storageDelete(historyKey(activeLang));
  if (isSingleBufferLanguage(lang)) {
    storageDelete(codeKey(activeLang));
  } else {
    storageDelete(openTabsKey(activeLang));
    storageDelete(activeTabKey(activeLang));
    projectStates.delete(activeLang);
    try {
      await resetProject(activeLang);
    } catch (e) {
      alert(
        `Failed to reset project files: ${(e as Error).message}\n\nLocal storage was cleared, but the on-disk project may be in a half-deleted state.`
      );
      return;
    }
  }
  location.reload();
}

let projectResetLang: LanguageId | null = null;

function openProjectResetDialog(): void {
  const lang = getLanguage(activeLang);
  if (lang.kind !== 'project') return;

  projectResetLang = activeLang;
  el('projectResetCopy').textContent = `Restore projects/${lang.scaffoldDir}/ for ${lang.name} from the starter template?`;
  el('projectResetStatus').textContent = '';
  const confirmBtn = el<HTMLButtonElement>('confirmProjectResetBtn');
  confirmBtn.disabled = false;
  const label = confirmBtn.querySelector('span');
  if (label !== null) label.textContent = 'Reset files';
  el<HTMLDialogElement>('projectResetDialog').showModal();
}

async function resetCurrentProjectFiles(): Promise<void> {
  const id = projectResetLang;
  if (id === null) return;
  const lang = getLanguage(id);
  if (lang.kind !== 'project') return;

  const dialog = el<HTMLDialogElement>('projectResetDialog');
  const status = el('projectResetStatus');
  const confirmBtn = el<HTMLButtonElement>('confirmProjectResetBtn');
  confirmBtn.disabled = true;
  const label = confirmBtn.querySelector('span');
  if (label !== null) label.textContent = 'Resetting…';
  status.textContent = `Resetting projects/${lang.scaffoldDir}/…`;

  try {
    await resetProject(id);
    storageDelete(openTabsKey(id));
    storageDelete(activeTabKey(id));
    projectStates.delete(id);

    if (activeLang === id) {
      destroyProjectUI();
      const nextState = loadProjectStateFromStorage(id);
      projectStates.set(id, nextState);
      ensureProjectUI(id, lang);
      await hydrateProjectState(id, lang);
    }

    status.textContent = 'Project files reset.';
    dialog.close();
  } catch (e) {
    status.textContent = `Reset failed: ${(e as Error).message}`;
    confirmBtn.disabled = false;
    if (label !== null) label.textContent = 'Reset files';
  }
}

// ── Language switching ────────────────────────────────────────────────────
function loadLanguageState(id: LanguageId): void {
  activeLang = id;
  storageSet(ACTIVE_LANG_KEY, activeLang);
  document.documentElement.setAttribute('data-lang', activeLang);

  history = storageGet<Message[]>(historyKey(activeLang)) ?? [];
  progress = storageGet<Progress>(progressKey(activeLang));
  const lang = getLanguage(activeLang);
  currentSystemPrompt = buildSystem(progress, lang, learnerProfile);

  renderFileSpec();
  renderDasmFlagsControl();
  if (activeLang !== 'dasm') cancelDasmAutoRun();

  lspProblems = [];
  updateSingleDiagnostics([]);

  if (isSingleBufferLanguage(lang)) {
    setWorkshopMode('single');
    applyDasmLayout();
    el('fileLabel').textContent = lang.fileName;

    const storedCode = storageGet<string>(codeKey(activeLang));
    suppressDasmAutoRun = activeLang === 'dasm';
    editor.setContent(storedCode ?? lang.starterCode);
    suppressDasmAutoRun = false;
    editor.setLanguage(lang.id as SingleBufferLanguageId);

    if (lang.id !== 'dasm') {
      dasmGroupToSource.clear();
      dasmSourceToGroups.clear();
    }
    editor.setDasmSourceMap?.(lang.id === 'dasm' ? dasmSourceToGroups : new Map());

    clearOutput();

    // Populate the disassembly the moment the user enters the DASM workspace —
    // no edit-and-wait-for-debounce needed. The auto-run guard handles the
    // case where the user switches away mid-run.
    if (lang.id === 'dasm') {
      void runDasmAutoDisassembly();
    }
  } else {
    setWorkshopMode('project');
    applyDasmLayout();
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
  const out = el('singleOutputPanel');

  // Restore persisted height. Single source of truth for the clamp range
  // (60–500 px) is shared between init and the drag handler.
  const stored = storageGet<number>(OUTPUT_HEIGHT_KEY);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    out.style.flex = `0 0 ${Math.max(60, Math.min(stored, 500))}px`;
  }

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
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    storageSet(OUTPUT_HEIGHT_KEY, out.getBoundingClientRect().height);
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    startY = e.clientY;
    startH = out.getBoundingClientRect().height;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => {
    out.style.flex = '0 0 120px';
    storageDelete(OUTPUT_HEIGHT_KEY);
  });
}

function initDasmVerticalResize(): void {
  const bar = el('dasmVerticalResize');
  const body = el('workshopBody');
  const col = el('dasmAsmColumn');

  const stored = storageGet<number>(DASM_COLUMN_WIDTH_KEY);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    body.style.setProperty('--dasm-column-width', `${clampDasmColumnWidth(stored, body.getBoundingClientRect().width)}px`);
  }

  let startX = 0;
  let startW = 0;
  let totalW = 0;

  function onMove(e: MouseEvent): void {
    const newW = clampDasmColumnWidth(startW - (e.clientX - startX), totalW);
    body.style.setProperty('--dasm-column-width', `${newW}px`);
  }

  function onUp(): void {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    storageSet(DASM_COLUMN_WIDTH_KEY, col.getBoundingClientRect().width);
  }

  bar.addEventListener('mousedown', (e: MouseEvent) => {
    startX = e.clientX;
    startW = col.getBoundingClientRect().width;
    totalW = body.getBoundingClientRect().width;
    bar.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => {
    body.style.removeProperty('--dasm-column-width');
    storageDelete(DASM_COLUMN_WIDTH_KEY);
  });
}

function clampDasmColumnWidth(width: number, totalWidth: number): number {
  const min = 220;
  const max = Math.max(min, totalWidth - 280);
  return Math.max(min, Math.min(width, max));
}

const OUTPUT_HEIGHT_KEY = 'lang-tutor:output-height';
const DASM_COLUMN_WIDTH_KEY = 'lang-tutor:dasm-column-width';

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
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
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
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
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

  // Phase 1 of the C# course shipped a single-buffer editor that persisted to
  // lang-tutor:csharp:code. The course is now a project workspace with files
  // on disk, so the legacy key is dead weight.
  storageDelete(codeKey('csharp'));
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
    if (activeLang === 'dasm' && !suppressDasmAutoRun) scheduleDasmAutoRun();
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
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-focus-mode-toggle]')) {
  button.addEventListener('click', () => setFocusMode(!focusMode));
}
el<HTMLSelectElement>('dasmFlagsPreset').addEventListener('change', () => {
  const selected = el<HTMLSelectElement>('dasmFlagsPreset').value;
  if (selected !== 'custom') saveDasmFlags(selected);
});
el<HTMLInputElement>('dasmFlagsInput').addEventListener('change', () => saveDasmFlags(el<HTMLInputElement>('dasmFlagsInput').value));
el<HTMLInputElement>('dasmFlagsInput').addEventListener('input', () =>
  syncDasmPreset(normalizeDasmFlags(el<HTMLInputElement>('dasmFlagsInput').value))
);
el('outputTabBtn').addEventListener('click', () => setSingleOutputTab('output'));
el('problemsTabBtn').addEventListener('click', () => setSingleOutputTab('errors'));
el('dasmTabBtn').addEventListener('click', () => setSingleOutputTab('dasm'));
el('dasmLayoutBtn').addEventListener('click', () => {
  toggleDasmLayout();
});
el('projEvalBtn').addEventListener('click', () => void evaluateProjectCode());
el('projResetFilesBtn').addEventListener('click', openProjectResetDialog);
el('confirmProjectResetBtn').addEventListener('click', () => void resetCurrentProjectFiles());
el('projectResetDialog').addEventListener('close', () => {
  projectResetLang = null;
});
el('resetBtn').addEventListener('click', () => void resetCurrentLanguage());
el('themeToggle').addEventListener('click', toggleTheme);
el('providerBtn').addEventListener('click', () => {
  renderProviderSettings();
  el<HTMLDialogElement>('providerDialog').showModal();
});
el('accountBtn').addEventListener('click', () => {
  renderAccountSummary();
  renderAccountMode();
  el('accountStatus').textContent = '';
  el<HTMLDialogElement>('accountDialog').showModal();
});
el('authGateAccountBtn').addEventListener('click', () => {
  renderAccountSummary();
  renderAccountMode();
  el('accountStatus').textContent = '';
  el<HTMLDialogElement>('accountDialog').showModal();
});
el<HTMLSelectElement>('providerSelect').addEventListener('change', () => renderProviderSettings(selectedProvider()));
el<HTMLSelectElement>('providerModelSelect').addEventListener('change', () => {
  setProviderModelWarning('');
  updateProviderSaveAvailability();
});
el<HTMLInputElement>('providerApiKey').addEventListener('input', () => {
  providerModelRequestId++;
  const provider = selectedProvider();
  providerModelCache.delete(provider);
  renderProviderModelPlaceholder('Load models with this API key');
  setProviderModelWarning('');
});
el('refreshProviderModelsBtn').addEventListener('click', () => void refreshProviderModels());
el('saveProviderBtn').addEventListener('click', saveProviderForm);
el('signInModeBtn').addEventListener('click', () => {
  accountMode = 'sign-in';
  renderAccountMode();
});
el('registerModeBtn').addEventListener('click', () => {
  accountMode = 'register';
  renderAccountMode();
});
el('accountSubmitBtn').addEventListener('click', () => void submitAccount());
el<HTMLInputElement>('accountPassword').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void submitAccount();
  }
});
el('signOutBtn').addEventListener('click', () => void signOut());

for (const tab of document.querySelectorAll<HTMLButtonElement>('.lang-tab')) {
  tab.addEventListener('click', () => {
    const id = tab.getAttribute('data-lang') as LanguageId | null;
    if (id !== null) setLanguage(id);
  });
}

initResize();
initDasmVerticalResize();
initAsideResize();
initProjectPreviewResize();
initProjectTreeResize();
initChatTextSelection();

// ── Init ──────────────────────────────────────────────────────────────────
renderProviderSettings();
await initializeAuth();
await hydrateStorageFromDisk();
applyStoredTheme();
applyStoredFocusMode();
migrateOldStorage();
learnerProfile = storageGet<LearnerProfile>(LEARNER_PROFILE_KEY);
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
  onDiagnostics: updateSingleDiagnostics,
  onDasmLineHover: handleDasmEditorLineHover,
});
loadLanguageState(initialLang);
