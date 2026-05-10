import { CLAUDE_MODEL } from './constants';
import type { ClaudeResponse, Message, Progress, Topic } from './types';

interface PostResult {
  ok: boolean;
  text: string;
  raw: ClaudeResponse | null;
}

async function postMessages(body: object): Promise<PostResult> {
  let r: Response;
  try {
    r = await fetch('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[api] fetch /v1/messages threw:', e);
    return { ok: false, text: `Network error: ${msg}. Is the dev server running and the proxy reachable?`, raw: null };
  }

  let parsed: ClaudeResponse | null = null;
  let bodyText = '';
  try {
    bodyText = await r.text();
    parsed = JSON.parse(bodyText) as ClaudeResponse;
  } catch {
    console.error(`[api] /v1/messages returned non-JSON (HTTP ${r.status}):`, bodyText.slice(0, 500));
    return { ok: false, text: `API returned non-JSON (HTTP ${r.status}). Check the dev server / proxy.`, raw: null };
  }

  if (!r.ok) {
    const apiMsg = parsed.error?.message ?? `HTTP ${r.status}`;
    console.error(`[api] Anthropic API error (HTTP ${r.status}):`, parsed);
    return { ok: false, text: `API error: ${apiMsg}`, raw: parsed };
  }

  const text = parsed.content?.find((b) => b.type === 'text')?.text;
  if (text === undefined) {
    console.error('[api] Unexpected response shape (no text content):', parsed);
    return { ok: false, text: 'Response had no text content. See console for the raw payload.', raw: parsed };
  }
  return { ok: true, text, raw: parsed };
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  error?: { message: string };
  message?: { usage?: StreamUsage };
  usage?: StreamUsage;
}

export interface CallResult {
  ok: boolean;
  text: string;
}

/**
 * Stream a Claude completion. Calls `onDelta` with each text chunk as it arrives,
 * and resolves with `{ ok, text }`. On `ok: false`, `text` is a user-facing error
 * message and no deltas were emitted. Partial-stream-then-error is treated as a
 * success: callers see whatever text streamed, and the trailing error is logged.
 *
 * Prompt caching: marks the system block and the final message with
 * `cache_control: { type: 'ephemeral' }`. The next turn within the 5-minute TTL
 * reuses the entire prefix (system + every prior message including this one's
 * last) at ~10 % of the input-token cost. Cache misses on the first turn or
 * after the system text changes (language switch / progress refresh) — that's
 * billed at the normal write-cost (~125 % of input) once, then amortised
 * across subsequent reuse turns. cache_read / cache_creation token counts are
 * surfaced via console.info from `message_start`.
 *
 * Heads-up: Anthropic silently ignores cache_control when the cached prefix
 * is under the model's minimum (verified empirically as ~2048 tokens for
 * claude-sonnet-4-6 — between 1960 t and 2103 t in a binary search). For
 * most languages the first-session prompt is under that threshold, so
 * caching only kicks in after a few exchanges add enough history. The
 * markers themselves cost nothing — Anthropic just bills as normal input.
 */
export async function callClaude(msgs: Message[], sys: string, onDelta?: (chunk: string) => void): Promise<CallResult> {
  // Convert the final message to block form so we can attach cache_control.
  // Earlier messages stay as plain { role, content: string } — Anthropic only
  // needs the marker on the last block of the prefix we want cached.
  const lastIdx = msgs.length - 1;
  const messagesPayload = msgs.map((m, i) => {
    if (i !== lastIdx) return m;
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
    };
  });

  let r: Response;
  try {
    r = await fetch('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: messagesPayload,
        stream: true,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[api] streaming fetch threw:', e);
    return { ok: false, text: `Network error: ${msg}. Is the dev server running and the proxy reachable?` };
  }

  if (!r.ok) {
    let errMsg = `HTTP ${r.status}`;
    try {
      const errBody = (await r.json()) as ClaudeResponse;
      errMsg = errBody.error?.message ?? errMsg;
      console.error(`[api] Anthropic API error (HTTP ${r.status}):`, errBody);
    } catch {
      console.error(`[api] Anthropic API error (HTTP ${r.status}), no JSON body.`);
    }
    return { ok: false, text: `API error: ${errMsg}` };
  }

  if (r.body === null) {
    console.error('[api] streaming response had no body.');
    return { ok: false, text: 'API returned no response body.' };
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let streamError: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Each SSE event ends with a blank line ("\n\n").
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(dataStr) as StreamEvent;
          } catch {
            continue;
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            fullText += event.delta.text;
            onDelta?.(event.delta.text);
          } else if (event.type === 'message_start' && event.message?.usage !== undefined) {
            // message_start carries the input-side numbers (input_tokens,
            // cache_read_input_tokens, cache_creation_input_tokens). One log
            // per turn so the user can confirm caching is hitting.
            const u = event.message.usage;
            const read = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            const fresh = u.input_tokens ?? 0;
            const cacheStatus = read > 0 ? `HIT (${read}t cached)` : created > 0 ? `MISS (${created}t cached for next turn)` : 'no-cache';
            console.info(`[api] cache: ${cacheStatus} · uncached input=${fresh}t`);
          } else if (event.type === 'error' && event.error) {
            streamError = event.error.message;
            console.error('[api] stream error event:', event.error);
          }
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } catch (e) {
    console.error('[api] stream read error:', e);
    if (fullText === '') return { ok: false, text: `Stream error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (streamError !== null && fullText === '') return { ok: false, text: `API error: ${streamError}` };
  if (fullText === '') return { ok: false, text: 'Stream produced no text. See console for details.' };
  return { ok: true, text: fullText };
}

export async function fetchProgressExtraction(history: Message[], topics: readonly Topic[]): Promise<Progress | null> {
  const topicSchema = topics.map((t) => `{"id":"${t.id}","title":"${t.title}","status":"?"}`).join(',');
  const snippet = history
    .slice(-14)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 280)}`)
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

  const result = await postMessages({
    model: CLAUDE_MODEL,
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

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
