import { resolveProviderConfig } from './providerSettings';
import type { ClaudeResponse, ContentBlock, ImageBlock, Message, Progress, ProviderConfig, TextBlock, Topic } from './types';

/** Extract the plain-text content of a message, ignoring any image blocks. */
function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

interface PostResult {
  ok: boolean;
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

function missingProviderResult(): CallResult {
  return {
    ok: false,
    text:
      'Add an AI provider API key before chatting. Open AI Provider, choose Anthropic Claude, OpenAI ChatGPT, or Google Gemini, then paste your key.',
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

function toOpenAiContent(content: Message['content']): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
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
        max_tokens: 1000,
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
        max_completion_tokens: 1000,
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
        generationConfig: { maxOutputTokens: 1000 },
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

async function postAnthropic(config: ProviderConfig, prompt: string): Promise<PostResult> {
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
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) return { ok: false, text: await parseError(response) };
  const parsed = (await response.json()) as ClaudeResponse;
  return { ok: true, text: parsed.content?.find((b) => b.type === 'text')?.text ?? '' };
}

async function postOpenAi(config: ProviderConfig, prompt: string): Promise<PostResult> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_completion_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) return { ok: false, text: await parseError(response) };
  const parsed = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { ok: true, text: parsed.choices?.[0]?.message?.content ?? '' };
}

async function postGemini(config: ProviderConfig, prompt: string): Promise<PostResult> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 700 },
    }),
  });
  if (!response.ok) return { ok: false, text: await parseError(response) };
  const parsed = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return { ok: true, text: parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '' };
}

async function postCompletion(prompt: string): Promise<PostResult> {
  const config = resolveProviderConfig();
  if (config === null) return missingProviderResult();

  try {
    switch (config.provider) {
      case 'anthropic':
        return await postAnthropic(config, prompt);
      case 'openai':
        return await postOpenAi(config, prompt);
      case 'gemini':
        return await postGemini(config, prompt);
    }
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchProgressExtraction(history: Message[], topics: readonly Topic[]): Promise<Progress | null> {
  const topicSchema = topics.map((t) => `{"id":"${t.id}","title":"${t.title}","status":"?"}`).join(',');
  const snippet = history
    .slice(-14)
    .map((m) => `${m.role.toUpperCase()}: ${messageText(m).slice(0, 280)}`)
    .join('\n\n');

  const prompt = `Analyze this tutoring conversation and return ONLY valid JSON (no markdown, no other text) with this schema. Set each topic status to "not-started", "in-progress", or "mastered".

{
  "experienceLevel": "beginner|intermediate|advanced",
  "currentTopic": "topic currently being worked on",
  "topics": [${topicSchema}],
  "strengths": ["specific strength observed"],
  "struggles": ["specific struggle observed"],
  "overallNotes": "1-2 sentence summary"
}

Conversation:\n${snippet}`;

  const result = await postCompletion(prompt);

  if (!result.ok) {
    console.error('[api] Progress extraction failed:', result.text);
    return null;
  }

  const raw = result.text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw) as Progress;
  } catch (e) {
    console.error('[api] Progress extraction JSON parse failed:', e, 'raw:', raw);
    return null;
  }
}

