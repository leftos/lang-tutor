# Learner memory

What the tutors remember about the learner, where each fact lives, and how it is merged. Owning files: `src/learnerMemory.ts` (pure merge and migration, tested in `src/learnerMemory.test.ts`), `fetchMemoryExtraction` in `src/api.ts`, `extractMemory` and `buildSystem` in `src/main.ts`, `src/modelResolution.ts` and `src/providerSettings.ts` (Auto models).

## Two stores

- **Progress** is per language (`lang-tutor:{lang}:progress`): topic status, current topic, experience level, overall notes, and strengths and struggles that are specific to that language.
- **The learner profile** is global (`LEARNER_PROFILE_KEY`): every fact true of the learner whatever the language (background, other languages, goals, preferences, learning style, general strengths and struggles). Any tutor adds to it and every tutor reads it, so a new language's tutor does not re-ask.

The profile is version 2: `facts` holds one list per section (`background`, `goals`, `preferences`, `strengths`, `struggles`), and each `ProfileFact` carries an id, its text, its `source` (`tutor` or `user`), the language it was learned in (shown as a badge on the Profile tab) and a timestamp. A version 1 object (string arrays, `experienceNotes`, `recentSignals`) is migrated on load by `migrateProfile`: each string becomes a `tutor` fact, `experienceNotes` goes to `background`, and `recentSignals` is dropped. A change to the shape bumps the version and extends that migration.

## One extraction per turn

`fetchMemoryExtraction` is the only memory call: one request per turn, on the provider's memory model, that returns both the language's progress and a profile delta. It sends the previous progress, the profile facts with their ids, and the last 16 messages at up to 1200 characters each (Send-to-tutor bundle blocks such as `[CODE]`, `[OUTPUT]` and `[LSP]` stripped for length, `[NOTE]` kept). The prompt sends language-specific observations to progress and everything else to the profile delta, and allows a removal only for a fact the conversation contradicts, by id. The reply is shape-checked by `validateExtraction`; a reply that fails is dropped with a `console.error`.

The model proposes and code merges. Letting the model rewrite the whole profile each turn was rejected: the profile grew without bound until the JSON reply truncated, failed to parse, and the profile froze. Two calls per turn (progress, then profile) were folded into this one call on a cheaper model.

The request turns the model's reasoning down as far as its provider allows (`lowReasoningFields`); a model that rejects that setting is retried once at its default. A memory model the provider rejects (a 400 or 404 naming the model) is retried once on the chat model.

## Merge rules

- `applyProfileDelta`: additions are deduplicated case- and whitespace-insensitively against existing text; removals never touch a `user` fact or an unknown id; each section holds at most 8 facts (`PROFILE_SECTION_CAP`), evicting the oldest tutor fact first and a user fact only when no tutor fact is left.
- `mergeProgress`: a topic's status only advances (`not-started` → `in-progress` → `mastered`); current topic, experience level and overall notes take the new value when one is given; strengths and struggles are unioned, deduplicated and capped at 8, newest kept (`PROGRESS_LIST_CAP`).
- Facts the learner adds or deletes on the Profile tab are `user` facts: the model never removes them. Reset all clears the profile with everything else.

## When it runs

`extractMemory` runs one extraction at a time; a request during a run asks for one trailing rerun. The profile delta always applies, since the profile is global; progress applies only when the active language is unchanged and no rewind happened since the run started (CLAUDE.md, Gotchas). `sessionCount` goes up once per language per page load, on the first user message, not in extraction.

## Read path

`buildSystem` renders the profile from its facts, the known languages and the languages that have progress. When the profile has content (`hasProfileContent`), a language's first session opens with `returningLearnerPrompt` (greet, say what matters for this language, ask only what the profile leaves out, start teaching) instead of the language's own interview prompt, which stays for a learner the profile knows nothing about. The system prompt is rebuilt only by `refreshSystemPrompt`, never after an extraction, so the provider's prompt cache holds across turns (CLAUDE.md, Rules).

## Auto models

A provider's saved model may be empty, meaning **Auto**; a saved model equal to the old hard-coded default `claude-sonnet-4-20250514` is read as Auto. Auto is resolved in the app from the provider's live model list (`fetchProviderModels`), cached per provider and refreshed in the background at load when it is older than 24 hours and a key is present:

| Provider | Chat | Memory |
|---|---|---|
| Anthropic | newest `claude-sonnet-*` | newest `claude-haiku-*`, else newest Sonnet |
| OpenAI | newest dateless `gpt-<n>-mini` (no dated snapshots, no audio, realtime, search, transcribe or tts variants) | the chat pick |
| Gemini | `gemini-flash-latest`, no lookup | the chat pick |

"Newest" is the list's creation timestamp, else the version number in the id. With no cached list (offline, or no key yet) Auto falls back to the pinned `FALLBACK_MODELS`. The AI Provider dialog shows the model Auto resolved to beside it.

Resolution from the live list exists because Anthropic has no moving alias (every Claude model id is a pinned snapshot) and OpenAI's aliases only track snapshots within one generation; only Gemini publishes `-latest` aliases that move to each new release, so Gemini needs no lookup.
