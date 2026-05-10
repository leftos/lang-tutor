export type LanguageId = 'rust' | 'cpp' | 'python';

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

export interface Language {
  readonly id: LanguageId;
  readonly name: string;
  readonly fileName: string;
  readonly fenceLang: string;
  readonly starterCode: string;
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}
