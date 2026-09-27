import { PROFILE_SECTIONS, validateExtraction } from './learnerMemory';
import { resolveProviderConfig, resolveProviderMemoryModel } from './providerSettings';
import type {
  ClaudeResponse,
  ContentBlock,
  ImageBlock,
  LearnerProfile,
  MemoryExtraction,
  Message,
  Progress,
  ProviderConfig,
  TextBlock,
  Topic,
} from './types';

/** Extract the plain-text content of a message, ignoring any image blocks. */
function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Message text with bulky bundle blocks ([CODE], [OUTPUT], [LSP], …) stripped; [NOTE] is kept. */
function conversationText(m: Message): string {
  const text = messageText(m);
  return text
    .replace(/\n?\[(?:COMPILER FLAGS|CODE|OUTPUT|LSP|FILES|DOM|CONSOLE|SERVER|BUILD|SCREENSHOT)\][\s\S]*?(?=\n\n\[[A-Z ]+\]|\s*$)/g, '')
    .trim();
}

interface PostResult {
  ok: boolean;
  /** HTTP status of the response; 0 when the request never got one. */
  status: number;
  text: string;
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  error?: { message: string };
  message?: { usage?: StreamUsage };
}

interface OpenAiStreamEvent {
  error?: { message?: string };
  choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }>;
}

interface GeminiStreamEvent {
  error?: { message?: string };
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export interface CallResult {
  ok: boolean;
  text: string;
}

/** Output limit for a chat reply; on thinking models it also covers the thinking tokens. */
const CHAT_MAX_TOKENS = 4000;

function missingProviderResult(): CallResult {
  return {
    ok: false,
    text: 'Add an AI provider API key before chatting. Open AI Provider, choose Anthropic Claude, OpenAI ChatGPT, or Google Gemini, then paste your key.',
  };
}

async function parseError(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: { message?: string } };
    return parsed.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function streamSse(response: Response, onData: (data: string) => void): Promise<void> {
  if (response.body === null) throw new Error('API returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split('\n')) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data && data !== '[DONE]') onData(data);
      }
      sep = buffer.indexOf('\n\n');
    }
  }
}

function dataUrlFromImageBlock(block: ImageBlock): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

function anthropicMessageContent(content: Message['content']): string | ContentBlock[] {
  return content;
}

function withAnthropicCache(msgs: Message[]): Message[] {
  const lastIdx = msgs.length - 1;
  return msgs.map((m, i) => {
    if (i !== lastIdx) return m;
    if (typeof m.content === 'string') {
      return {
        role: m.role,
        content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
      };
    }
    let lastTextIdx = -1;
    for (let j = m.content.length - 1; j >= 0; j--) {
      if (m.content[j]?.type === 'text') {
        lastTextIdx = j;
        break;
      }
    }
    if (lastTextIdx === -1) {
      return {
        role: m.role,
        content: [...m.content, { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }],
      };
    }
    const newContent: ContentBlock[] = m.content.map((b, j) => {
      if (j !== lastTextIdx || b.type !== 'text') return b;
      return { ...b, cache_control: { type: 'ephemeral' } };
    });
    return { role: m.role, content: newContent };
  });
}

function toOpenAiContent(
  content: Message['content']
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    return { type: 'image_url', image_url: { url: dataUrlFromImageBlock(block) } };
  });
}

function toGeminiParts(content: Message['content']): Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((block) => {
    if (block.type === 'text') return { text: block.text };
    return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
  });
}

async function callAnthropic(config: ProviderConfig, msgs: Message[], sys: string, onDelta?: (chunk: string) => void): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: CHAT_MAX_TOKENS,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: withAnthropicCache(msgs).map((m) => ({ role: m.role, content: anthropicMessageContent(m.content) })),
        stream: true,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Network error: ${msg}. Check that this browser can reach Anthropic's API.` };
  }

  if (!response.ok) return { ok: false, text: `API error: ${await parseError(response)}` };

  let fullText = '';
  let streamError: string | null = null;
  try {
    await streamSse(response, (data) => {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        fullText += event.delta.text;
        onDelta?.(event.delta.text);
      } else if (event.type === 'message_start' && event.message?.usage !== undefined) {
        const u = event.message.usage;
        const read = u.cache_read_input_tokens ?? 0;
        const created = u.cache_creation_input_tokens ?? 0;
        const fresh = u.input_tokens ?? 0;
        const cacheStatus = read > 0 ? `HIT (${read}t cached)` : created > 0 ? `MISS (${created}t cached for next turn)` : 'no-cache';
        console.info(`[api] Anthropic cache: ${cacheStatus} · uncached input=${fresh}t`);
      } else if (event.type === 'error' && event.error) {
        streamError = event.error.message;
      }
    });
  } catch (e) {
    if (fullText === '') return { ok: false, text: `Stream error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (streamError !== null && fullText === '') return { ok: false, text: `API error: ${streamError}` };
  if (fullText === '') return { ok: false, text: 'Stream produced no text. See console for details.' };
  return { ok: true, text: fullText };
}

async function callOpenAi(config: ProviderConfig, msgs: Message[], sys: string, onDelta?: (chunk: string) => void): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_completion_tokens: CHAT_MAX_TOKENS,
        messages: [{ role: 'system', content: sys }, ...msgs.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) }))],
        stream: true,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Network error: ${msg}. Check that this browser can reach OpenAI's API.` };
  }

  if (!response.ok) return { ok: false, text: `API error: ${await parseError(response)}` };

  let fullText = '';
  let streamError: string | null = null;
  try {
    await streamSse(response, (data) => {
      let event: OpenAiStreamEvent;
      try {
        event = JSON.parse(data) as OpenAiStreamEvent;
      } catch {
        return;
      }
      if (event.error?.message) {
        streamError = event.error.message;
        return;
      }
      const delta = event.choices?.[0]?.delta?.content;
      const chunk = typeof delta === 'string' ? delta : Array.isArray(delta) ? delta.map((part) => part.text ?? '').join('') : '';
      if (chunk) {
        fullText += chunk;
        onDelta?.(chunk);
      }
    });
  } catch (e) {
    if (fullText === '') return { ok: false, text: `Stream error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (streamError !== null && fullText === '') return { ok: false, text: `API error: ${streamError}` };
  if (fullText === '') return { ok: false, text: 'Stream produced no text. See console for details.' };
  return { ok: true, text: fullText };
}

async function callGemini(config: ProviderConfig, msgs: Message[], sys: string, onDelta?: (chunk: string) => void): Promise<CallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: toGeminiParts(m.content) })),
        generationConfig: { maxOutputTokens: CHAT_MAX_TOKENS },
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Network error: ${msg}. Check that this browser can reach Google's Gemini API.` };
  }

  if (!response.ok) return { ok: false, text: `API error: ${await parseError(response)}` };

  let fullText = '';
  let streamError: string | null = null;
  try {
    await streamSse(response, (data) => {
      let event: GeminiStreamEvent;
      try {
        event = JSON.parse(data) as GeminiStreamEvent;
      } catch {
        return;
      }
      if (event.error?.message) {
        streamError = event.error.message;
        return;
      }
      const chunk = event.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
      if (chunk) {
        fullText += chunk;
        onDelta?.(chunk);
      }
    });
  } catch (e) {
    if (fullText === '') return { ok: false, text: `Stream error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (streamError !== null && fullText === '') return { ok: false, text: `API error: ${streamError}` };
  if (fullText === '') return { ok: false, text: 'Stream produced no text. See console for details.' };
  return { ok: true, text: fullText };
}

export async function callClaude(msgs: Message[], sys: string, onDelta?: (chunk: string) => void): Promise<CallResult> {
  const config = resolveProviderConfig();
  if (config === null) return missingProviderResult();

  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, msgs, sys, onDelta);
    case 'openai':
      return callOpenAi(config, msgs, sys, onDelta);
    case 'gemini':
      return callGemini(config, msgs, sys, onDelta);
  }
}

const MEMORY_MAX_TOKENS = 4000;
const MEMORY_MESSAGE_COUNT = 16;
const MEMORY_MESSAGE_CHARS = 1200;

/**
 * Request fields that turn a model's reasoning down as far as its provider allows, for the extraction call.
 *
 * Anthropic: every Claude model accepts `thinking: {type: "disabled"}` except the always-on Fable/Mythos ones.
 * OpenAI: `none` is the lowest `reasoning_effort` on gpt-5.1 and later; earlier models get no field.
 * Gemini: 2.5 models take `thinkingBudget` (0 turns thinking off on Flash, 128 is the Pro minimum), 3.x and the
 * `-latest` aliases take `thinkingLevel`, where `low` is the lowest level every current model accepts.
 * A model that rejects the field anyway is retried without it by {@link postWithReasoningFallback}.
 */
function lowReasoningFields(config: ProviderConfig): Record<string, unknown> {
  switch (config.provider) {
    case 'anthropic':
      return { thinking: { type: 'disabled' } };
    case 'openai': {
      const major = Number(/^gpt-(\d+)/.exec(config.model)?.[1] ?? 0);
      return major >= 5 ? { reasoning_effort: 'none' } : {};
    }
    case 'gemini':
      return { thinkingConfig: geminiLowThinking(config.model) };
  }
}

function geminiLowThinking(model: string): Record<string, unknown> {
  if (model.startsWith('gemini-2.5-pro')) return { thinkingBudget: 128 };
  if (model.startsWith('gemini-2.5-')) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

/** Gemini models before 2.5 do not think, so they get no thinking config. */
function geminiThinks(model: string): boolean {
  return !/^gemini-(1\.|2\.0)/.test(model);
}

async function postAnthropic(config: ProviderConfig, prompt: string, lowReasoning: boolean): Promise<PostResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: MEMORY_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      ...(lowReasoning ? lowReasoningFields(config) : {}),
    }),
  });
  if (!response.ok) return { ok: false, status: response.status, text: await parseError(response) };
  const parsed = (await response.json()) as ClaudeResponse;
  return { ok: true, status: response.status, text: parsed.content?.find((b) => b.type === 'text')?.text ?? '' };
}

async function postOpenAi(config: ProviderConfig, prompt: string, lowReasoning: boolean): Promise<PostResult> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_completion_tokens: MEMORY_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      ...(lowReasoning ? lowReasoningFields(config) : {}),
    }),
  });
  if (!response.ok) return { ok: false, status: response.status, text: await parseError(response) };
  const parsed = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { ok: true, status: response.status, text: parsed.choices?.[0]?.message?.content ?? '' };
}

async function postGemini(config: ProviderConfig, prompt: string, lowReasoning: boolean): Promise<PostResult> {
  const thinking = lowReasoning && geminiThinks(config.model) ? lowReasoningFields(config) : {};
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MEMORY_MAX_TOKENS, ...thinking },
    }),
  });
  if (!response.ok) return { ok: false, status: response.status, text: await parseError(response) };
  const parsed = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return { ok: true, status: response.status, text: parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '' };
}

async function postCompletion(config: ProviderConfig, prompt: string, lowReasoning: boolean): Promise<PostResult> {
  try {
    switch (config.provider) {
      case 'anthropic':
        return await postAnthropic(config, prompt, lowReasoning);
      case 'openai':
        return await postOpenAi(config, prompt, lowReasoning);
      case 'gemini':
        return await postGemini(config, prompt, lowReasoning);
    }
  } catch (e) {
    return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
  }
}

function isReasoningRejected(result: PostResult): boolean {
  return result.status === 400 && /thinking|reasoning|effort/i.test(result.text);
}

function isModelUnavailable(result: PostResult): boolean {
  return (result.status === 400 || result.status === 404) && /model/i.test(result.text);
}

/** Posts with reasoning turned down, and once more at the model's default when the model rejects that setting. */
async function postWithReasoningFallback(config: ProviderConfig, prompt: string): Promise<PostResult> {
  const result = await postCompletion(config, prompt, true);
  if (result.ok || !isReasoningRejected(result)) return result;
  console.warn(`[api] ${config.model} rejected the low-reasoning setting (${result.text}); retrying at its default.`);
  return postCompletion(config, prompt, false);
}

/** Posts on the provider's memory model, retrying once on the chat model when the memory model is rejected. */
async function postMemoryCompletion(config: ProviderConfig, prompt: string): Promise<PostResult> {
  const memoryModel = resolveProviderMemoryModel(config);
  const result = await postWithReasoningFallback({ ...config, model: memoryModel }, prompt);
  if (result.ok || memoryModel === config.model || !isModelUnavailable(result)) return result;
  console.warn(`[api] Memory model ${memoryModel} unavailable (${result.text}); retrying on chat model ${config.model}.`);
  return postWithReasoningFallback(config, prompt);
}

function conversationSnippet(history: readonly Message[]): string {
  return history
    .slice(-MEMORY_MESSAGE_COUNT)
    .map((m) => {
      const text = conversationText(m);
      return text === '' ? null : `${m.role.toUpperCase()}: ${text.slice(0, MEMORY_MESSAGE_CHARS)}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

function profileFactsText(profile: LearnerProfile): string {
  const lines: string[] = [
    `summary: ${profile.summary ?? '(none)'}`,
    `knownLanguages: ${profile.knownLanguages?.length ? profile.knownLanguages.join(', ') : '(none)'}`,
  ];
  for (const section of PROFILE_SECTIONS) {
    const facts = profile.facts[section];
    lines.push(`${section}:`);
    if (facts.length === 0) lines.push('  (none)');
    for (const fact of facts) lines.push(`  - [${fact.id}] ${fact.text}${fact.source === 'user' ? ' (added by the learner)' : ''}`);
  }
  return lines.join('\n');
}

function memoryPrompt(
  history: readonly Message[],
  topics: readonly Topic[],
  prevProgress: Progress | null,
  profile: LearnerProfile,
  langName: string
): string {
  const topicSchema = topics.map((t) => `{"id":"${t.id}","status":"not-started|in-progress|mastered"}`).join(', ');
  const topicList = topics.map((t) => `${t.id} = ${t.title}`).join('; ');
  const previousProgress = prevProgress === null ? '(none yet)' : JSON.stringify(prevProgress, null, 2);

  return `You maintain a programming tutor's memory of one learner. Read this ${langName} tutoring conversation and update two things:

1. PROGRESS — observations specific to ${langName}: topic statuses, current topic, ${langName}-specific strengths and struggles, notes about their ${langName} work.
2. PROFILE DELTA — facts true of the learner regardless of language: background, other languages they know, goals, teaching preferences, learning style, general strengths and struggles. These are shared with the tutors of every other language.

Put each observation in exactly one of the two. Do not put ${langName}-specific observations in the profile, and do not put language-independent facts in progress.

Return JSON only — no markdown fences, no other text — with this exact schema:

{
  "progress": {
    "experienceLevel": "beginner|intermediate|advanced",
    "currentTopic": "title of the ${langName} topic currently being worked on",
    "topics": [${topicSchema}],
    "strengths": ["specific ${langName} strength observed"],
    "struggles": ["specific ${langName} struggle observed"],
    "overallNotes": "1-2 sentence summary of their ${langName} progress"
  },
  "profileDelta": {
    "summary": "2-4 sentence learner summary, only if it should replace the current one",
    "knownLanguages": ["full replacement list, only if it changed"],
    "add": {
      "background": ["new fact"],
      "goals": ["new fact"],
      "preferences": ["new fact"],
      "strengths": ["new fact"],
      "struggles": ["new fact"]
    },
    "remove": ["id of an existing profile fact"]
  }
}

Topics for this course (id = title): ${topicList}. Use only these ids; a topic status reflects the whole conversation, so do not mark a topic lower than the previous progress shows.
Previous progress is below: keep what still holds and return the updated values.
Under "add", list only facts that are new — not ones already in the current profile. Omit sections with nothing to add.
Propose removals only for facts the conversation contradicts, by id. Facts marked "(added by the learner)" stay regardless.
Do NOT store API keys, passwords, access tokens, emails, billing details, private URLs, or unrelated personal data.
Avoid inventing facts. If there is no evidence for a field, omit it or return an empty array.

Previous ${langName} progress:
${previousProgress}

Current learner profile (fact ids in brackets):
${profileFactsText(profile)}

Conversation:
${conversationSnippet(history)}`;
}

/**
 * Runs the one per-turn memory extraction: language-specific progress plus a delta to the shared profile.
 *
 * Returns `null` (and logs why) when no provider is configured, the call fails, or the reply is not
 * valid JSON of the expected shape.
 */
export async function fetchMemoryExtraction(
  history: readonly Message[],
  topics: readonly Topic[],
  prevProgress: Progress | null,
  profile: LearnerProfile,
  langName: string
): Promise<MemoryExtraction | null> {
  const config = resolveProviderConfig();
  if (config === null) {
    console.error('[api] Memory extraction skipped:', missingProviderResult().text);
    return null;
  }

  const result = await postMemoryCompletion(config, memoryPrompt(history, topics, prevProgress, profile, langName));
  if (!result.ok) {
    console.error(`[api] Memory extraction failed (${langName}, HTTP ${result.status}):`, result.text);
    return null;
  }

  const raw = result.text.replace(/```json|```/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[api] Memory extraction JSON parse failed (${langName}):`, e, 'raw:', raw);
    return null;
  }

  const extraction = validateExtraction(
    parsed,
    topics.map((t) => t.id)
  );
  if (extraction === null) console.error(`[api] Memory extraction returned an unexpected shape (${langName}):`, parsed);
  return extraction;
}
