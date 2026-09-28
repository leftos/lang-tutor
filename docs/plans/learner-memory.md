# Learner memory: one cross-language profile, reliable per-language progress, a Profile page

## Context

The tutor should know the learner across languages: a new language's tutor should not re-interview them, and per-language progress should be accurate. The audit (oracle) found the shared learner profile exists (`LEARNER_PROFILE_KEY`, `fetchLearnerProfileExtraction`) but:

- every `firstSessionPrompt` (`src/constants.ts:41-43` and one per language) unconditionally interviews and "waits before teaching", overriding the profile's "do not re-ask" line;
- the profile is rewritten whole by the LLM each turn, arrays are uncapped, and at `max_tokens: 700` (`src/api.ts:341`) the JSON eventually truncates → parse fails → the profile silently freezes forever;
- progress extraction sees 14 messages × 280 chars and no previous state, and its topic status overwrites the old one (`src/main.ts:2568`), so mastered topics regress; strengths/struggles are replaced wholesale and hold non-language facts that then get lost;
- `extractionQueued` drops a second turn's extraction (`main.ts:2543`); a mid-flight language switch discards the (global) profile result too (`main.ts:2554`);
- two chat-model calls per turn; the system prompt is rebuilt after every turn (`main.ts:2584`), so the Anthropic prompt cache misses every turn;
- `sessionCount` never passes 1 (`main.ts:2577`); `recentSignals` is extracted but never used; the profile is only shown as a summary + a few chips, with no way to correct it.

User decisions: **Profile page with view + delete + add**; **code-side union with caps** (the model proposes additions/removals, code merges; user-added facts are never removed by the model); **one combined extraction per turn on a cheap model**.

## Design

### Data model (`src/types.ts`)

```ts
type ProfileSection = 'background' | 'goals' | 'preferences' | 'strengths' | 'struggles';
interface ProfileFact { id: string; text: string; source: 'tutor' | 'user'; lang?: LanguageId; at: string }
interface LearnerProfile { version: 2; summary?: string; knownLanguages?: string[]; facts: Record<ProfileSection, ProfileFact[]>; updatedAt?: string }
```

- Drop `recentSignals`, `experienceNotes` → `background` facts, `goals`/`preferences`/`strengths`/`struggles` string arrays → facts.
- Migration on load: a v1 object (no `version`) maps each string to `{ id: crypto.randomUUID(), text, source: 'tutor', at: updatedAt ?? now }`; `experienceNotes` → `background`. Written back as v2 on first save.
- `Progress` keeps its shape; its `strengths`/`struggles`/`overallNotes` become language-specific only (enforced by the prompt), capped at 8 each.

### Pure merge module (new `src/learnerMemory.ts`, unit-tested)

- `migrateProfile(raw: unknown): LearnerProfile`
- `applyProfileDelta(profile, delta, lang, now): LearnerProfile`: delta = `{ summary?, knownLanguages?, add?: Partial<Record<ProfileSection, string[]>>, remove?: string[] /* fact ids */ }`. Adds are deduped case-insensitively against existing text; removes ignore `source: 'user'` facts; each section capped at 8, newest kept (user facts never evicted by the cap before tutor facts).
- `mergeProgress(prev, extracted, topics)`: topic status only advances (`not-started → in-progress → mastered`); `currentTopic`/`experienceLevel`/`overallNotes` take the new value when present; strengths/struggles union + dedupe + cap 8 newest.
- `validateExtraction(json): ExtractionResult | null`: shape check of the model's JSON (no blind casts).
- `hasProfileContent(profile): boolean`.

### One combined extraction (`src/api.ts`)

- Replace `fetchProgressExtraction` + `fetchLearnerProfileExtraction` with `fetchMemoryExtraction(history, topics, prevProgress, profile, lang)` → `{ progress, profileDelta } | null`.
- Input: previous progress JSON, profile facts **with ids**, and the last 16 messages at up to 1200 chars each (blocks like `[CODE]`/`[LSP]` still stripped for length, `[NOTE]` kept). Prompt states the split: language-specific observations → progress; anything true of the learner regardless of language (background, other languages, goals, preferences, learning style, general strengths/struggles) → profile delta; propose removals only for facts the conversation contradicts, by id.
- `max_tokens: 1500`; `validateExtraction` on the parsed JSON; failure → `null` + `console.error` (as today).
- Model: new `MEMORY_MODELS: Record<AiProvider, string>` in `src/providerSettings.ts` (anthropic `claude-haiku-4-5`, openai `gpt-5.4-mini`, gemini `gemini-2.5-flash` — the latter two are the existing defaults, the Haiku id verified against the Anthropic models endpoint during implementation). If the call fails with a 400/404 model error, retry once on the chat model.

### Trigger and guards (`src/main.ts` `extractProgress` → `extractMemory`)

- Replace the drop with a trailing rerun: a second request while one runs sets `rerunRequested`; after finishing, run once more.
- Profile delta is applied regardless of a language switch (it is global); progress is applied only if `activeLang` is unchanged.
- `sessionCount` increments once per language per page load, on the first user message, not in extraction.

### Read path

- `firstSessionPrompt` gets a profile-aware counterpart: `buildSystem` uses a shared `returningLearnerPrompt(lang)` when `hasProfileContent(profile)`: "You already know this learner (profile above). Greet them, say in one sentence what you know that matters for <lang>, ask only for what the profile doesn't cover for <lang>, then start teaching." The six per-language interview prompts stay for truly new learners.
- `learnerProfileBlock` renders sections from facts (all facts, capped at 8 per section already) plus `knownLanguages` and a line listing which languages have progress.
- Prompt caching: `currentSystemPrompt` is rebuilt only at load, language switch, session start, Reset, and after a user edit on the Profile page — not after each extraction.

### Profile page (`index.html`, `src/main.ts`, `src/style.css`)

- Third aside tab `iii. Profile` next to "The Tutor" and "Lesson Plan" (`index.html:~238`, `switchTab` gains `'profile'`).
- Sections: Summary, Languages known, Background, Goals, Preferences, Strengths, Struggles. Each fact shows its text, a small language badge (`lang`) or "you" for user facts, and a × delete button; each section has an "Add…" input (Enter adds a `source: 'user'` fact). Built with `createElement` (no `innerHTML`), matching `renderProgressTab`'s helpers and `.prog-*` styles. Empty state: "Nothing noted yet — tutors add to this as you chat."
- Edits save via `storageSet(LEARNER_PROFILE_KEY, …)` and rebuild the system prompt.
- The Lesson Plan tab's current profile chips (`main.ts:776-807`) are removed (the Profile tab replaces them).

### Tests

No test runner exists. Add `vitest` as a devDependency (current stable looked up at install) with `"test": "vitest run"` and `src/learnerMemory.test.ts` covering: v1→v2 migration (every field, empty, malformed); dedupe (case, whitespace); cap eviction order and user facts surviving; removal ignoring user facts and unknown ids; topic monotonicity (mastered never regresses, in-progress advances); strengths union + cap; `validateExtraction` rejecting wrong shapes, non-arrays, missing sections.

### Default models that stay current (brief 1b)

Facts (checked 2026-09-27): Gemini documents `gemini-flash-latest` / `gemini-pro-latest` / `gemini-flash-lite-latest` aliases that hot-swap to each new release (two weeks' notice for breaking changes). Anthropic has no moving alias: "every Claude model ID is a pinned snapshot, including the dateless IDs" (platform.claude.com models overview); Claude Haiku 4.5 retires no sooner than 2026-10-15 and has no successor listed. OpenAI aliases only track snapshots within one generation.

- A provider's model setting may be empty, meaning **Auto**; the AI Provider dialog's model list gets an "Auto (newest …)" first option. A stored value equal to the old hard-coded default (`claude-sonnet-4-20250514`) migrates to Auto.
- Auto resolves from the provider's live model list (the existing `fetchProviderModels`), cached per provider with a fetch time and refreshed in the background at load when older than 24 h and a key is present. Chat: newest `claude-sonnet-*` (Anthropic), newest `gpt-<n>-mini` excluding dated snapshots and audio/realtime/search/transcribe/tts variants (OpenAI), `gemini-flash-latest` (Gemini, no lookup). Memory: newest `claude-haiku-*`, else the newest Sonnet (Anthropic); the chat pick (OpenAI, Gemini). "Newest" = the list's creation timestamp, falling back to the version number in the id.
- With no cached list (offline, no key yet), fall back to pinned IDs (`claude-sonnet-5`, `claude-haiku-4-5`, `gpt-5.4-mini`, `gemini-flash-latest`).
- The model actually used is shown next to "Auto" in the dialog so the user can see what they're on.

## Execution

Two implementer briefs, serialized (both edit `src/main.ts`), each in its own worktree:

1. **Memory core** — `src/types.ts`, `src/learnerMemory.ts` (+ test), `package.json` (vitest), `src/api.ts`, `src/providerSettings.ts`, `src/constants.ts`, `src/main.ts` (extraction, guards, sessionCount, buildSystem, cache rebuild points). Proving: `pnpm test`, `tsc --noEmit`, biome.
2. **Profile page** — `index.html`, `src/style.css`, `src/main.ts` (tab, render, add/delete). Proving: `tsc`, biome, plus the orchestrator's Playwright check.

Then docs: CLAUDE.md (Per-language model / AI provider plumbing / Storage sections, new `test` command), `docs/plans/MAIN.md` Wave 2 ticks, README glossary if a new term lands.

## Verification

- `pnpm test` green; `.\lt.ps1 typecheck`, `.\lt.ps1 lint` clean.
- Playwright (scripted, own worktree state on :3100): seed a v1 profile → loads as v2 facts on the Profile tab; delete a fact and add one → persisted to disk; Reset all clears it.
- Live (human, needs an API key): tell the Python tutor a background fact and a goal; switch to a fresh language → its first message acknowledges them and doesn't ask; check the Profile tab shows the facts with a `python` badge; Anthropic `[api] cache: HIT` appears on the second turn of a session.
