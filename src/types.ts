export type LanguageId = 'rust' | 'cpp' | 'dasm' | 'python' | 'csharp' | 'web';

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

export type ProfileSection = 'background' | 'goals' | 'preferences' | 'strengths' | 'struggles';

export interface ProfileFact {
  id: string;
  text: string;
  source: 'tutor' | 'user';
  lang?: LanguageId;
  at: string;
}

export interface LearnerProfile {
  version: 2;
  summary?: string;
  knownLanguages?: string[];
  facts: Record<ProfileSection, ProfileFact[]>;
  updatedAt?: string;
}

/** Changes the memory extractor proposes to the shared learner profile; code decides what lands. */
export interface ProfileDelta {
  summary?: string;
  knownLanguages?: string[];
  add?: Partial<Record<ProfileSection, string[]>>;
  /** Ids of existing facts the conversation contradicts. */
  remove?: string[];
}

/** Language-specific progress fields as the memory extractor returns them. */
export interface ExtractedProgress {
  experienceLevel?: string;
  currentTopic?: string;
  topics?: Array<Pick<TopicStatus, 'id' | 'status'>>;
  strengths?: string[];
  struggles?: string[];
  overallNotes?: string;
}

export interface MemoryExtraction {
  progress: ExtractedProgress;
  profileDelta: ProfileDelta;
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
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

export type AiProvider = 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfig {
  provider: AiProvider;
  label: string;
  model: string;
  apiKey: string;
}

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  /** ISO timestamp of the model's release, when the provider's list reports one. */
  readonly createdAt?: string;
}

/** A provider's live model list as last fetched, kept so Auto can resolve without a network call. */
export interface CachedModelList {
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  models: ProviderModel[];
}

export interface ProviderEntry {
  /** The chosen model id; `''` means Auto (resolved from the cached list, else a pinned fallback). */
  model: string;
  apiKey?: string;
  modelList?: CachedModelList;
}

export interface ProviderSettings {
  activeProvider: AiProvider;
  rememberKeys: boolean;
  providers: Record<AiProvider, ProviderEntry>;
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
