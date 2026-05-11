export type LanguageId = 'rust' | 'cpp' | 'python' | 'csharp' | 'web';

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

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png';
    data: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
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

/** Long-running HTTP server (Vite, Hono dev, etc.) hosted in an iframe. */
export interface WebProjectRuntime {
  readonly kind: 'web-vite';
  /** Port the dev server binds to. Mirrors PROJECT_CONFIG[lang].readiness.port in tools/projects.mjs. */
  readonly port: number;
}

/** Native desktop process (e.g. `dotnet run` opening a WPF window). No HTTP server, no iframe. */
export interface DesktopProjectRuntime {
  readonly kind: 'desktop-process';
}

export type ProjectRuntime = WebProjectRuntime | DesktopProjectRuntime;

export interface ProjectLanguage {
  readonly kind: 'project';
  readonly id: LanguageId;
  readonly name: string;
  readonly scaffoldDir: string;
  readonly runtime: ProjectRuntime;
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
