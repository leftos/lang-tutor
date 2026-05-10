export type LanguageId = 'rust' | 'cpp' | 'python' | 'web';

export interface Topic {
  readonly id: string;
  readonly title: string;
}

export type TopicStatusValue = 'not-started' | 'in-progress' | 'mastered';

export interface TopicStatus {
  id: string;
  title: string;
  status: TopicStatusValue;
}

export interface Progress {
  experienceLevel?: string;
  currentTopic?: string;
  topics?: TopicStatus[];
  strengths?: string[];
  struggles?: string[];
  overallNotes?: string;
  sessionCount?: number;
  lastSeen?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeResponse {
  content?: Array<{ type: string; text: string }>;
  error?: { message: string };
}

export interface RunResult {
  ok: boolean;
  output: string;
}

export interface SingleBufferLanguage {
  readonly kind: 'single';
  readonly id: LanguageId;
  readonly name: string;
  readonly fileName: string;
  readonly fenceLang: string;
  readonly starterCode: string;
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}

export interface ProjectLanguage {
  readonly kind: 'project';
  readonly id: LanguageId;
  readonly name: string;
  readonly scaffoldDir: string;
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}

export type Language = SingleBufferLanguage | ProjectLanguage;

export type SingleBufferLanguageId = Exclude<LanguageId, 'web'>;

export function isSingleBufferLanguage(lang: Language): lang is SingleBufferLanguage {
  return lang.kind === 'single';
}

// ── Project-language file system & UI state ─────────────────────────────

export interface FsFile {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
}

export interface FsDir {
  readonly type: 'dir';
  readonly name: string;
  readonly path: string;
  readonly children: readonly FsNode[];
}

export type FsNode = FsFile | FsDir;

export interface FsTreeResponse {
  readonly tree: FsNode | null;
  readonly scaffolded: boolean;
}

export interface ProjectState {
  tree: FsNode | null;
  openTabs: string[];
  activeTab: string | null;
  scaffolded: boolean;
}
