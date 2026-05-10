# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, multi-language programming tutor (Rust, C++, Python). The user chats with Claude (via the Anthropic API), writes code in an inline editor, runs it through a language-appropriate runtime, and submits code+output for evaluation. Lesson progress is extracted by a second LLM call into structured JSON and persisted in `localStorage`, **independently per language**. Switching language is non-destructive — each language has its own conversation history, lesson progress, and saved editor content.

## Stack

- **TypeScript** (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlight, autocomplete, search, lint, multi-cursor, fold gutter)
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin (config-in-CSS via `@theme`)
- **Pyodide** for in-browser Python (lazy-loaded from CDN on first run)
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20+** runtime for the production proxy (`server.mjs`) and for the local `/check` + `/format` toolchain endpoints
- Optional local toolchains: `rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`

## Run

```powershell
pnpm install                # first time
pnpm dev                    # Vite dev server (default port 5173) — proxies /v1/messages → Anthropic API
pnpm build                  # type-check + Vite build to dist/
pnpm serve                  # node --env-file=.env server.mjs (default port 3000)
pnpm typecheck              # tsc --noEmit
pnpm lint                   # biome check --write .
```

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` before first run. The browser never sees the key — Vite's dev proxy and `server.mjs` both inject it server-side.

## Architecture

**Source layout:**

```
src/
  main.ts        Entry: state, session control, language switching, event wiring, init
  editor.ts      CodeMirror 6 wrapper: createEditor() returns TutorEditor with getContent/setContent/setLanguage/format
  lint.ts        Frontend client for /check (returns CodeMirror Diagnostic[]) and /format
  api.ts         callClaude (streaming) + fetchProgressExtraction (non-streaming) — proxied through /v1/messages
  runners.ts     runCode dispatch: runRust (Rust Playground), runCpp (Wandbox), runPython (Pyodide)
  render.ts      renderMarkdown, setInline, renderPlainWithFences (DocumentFragment builders)
  storage.ts     localStorage wrapper (typed get/set/delete)
  constants.ts   LANGUAGES record (topics, prompts, starter code, file names), storage-key helpers
  types.ts       Language, LanguageId, Topic, TopicStatus, Progress, Message, RunResult interfaces
  style.css      @import "tailwindcss" + @theme tokens + --syn-* syntax tokens + @layer base/components/utilities

tools/
  checker.mjs    Backend: spawns rustc/clang/python (--check) and rustfmt/clang-format/black (--format),
                 returns JSON diagnostics. Used by both Vite dev middleware and server.mjs production.

scripts/
  setup.ps1      Idempotent Windows quickstart: winget-installs runtimes, runs pnpm install,
                 starts dev server in background, opens browser.
```

### Per-language model

Active language is one of `'rust' | 'cpp' | 'python'` (`LanguageId`). Each language is a `Language` record in `LANGUAGES` (`src/constants.ts`) carrying:

- `topics` — readonly Topic[] (lesson plan)
- `systemPromptIntro` — the "you are a teacher who…" system prompt segment
- `firstSessionPrompt` — appended to the system prompt only on first session
- `starterCode` — default editor content
- `fileName` — editor file label (`main.rs`, `main.cpp`, `main.py`)
- `fenceLang` — markdown fence label for [CODE] blocks (`rust`, `cpp`, `python`)

Adding a language means: add to `LanguageId`, add to `LANGUAGE_IDS`, add a `Language` record to `LANGUAGES`, add an `<option>` in `index.html`. Nothing else changes — the rest of `main.ts` reads from the active language record.

Adding/renaming topics for an existing language: edit only that language's `topics` array.

### Storage namespacing

Helpers in `constants.ts`:

- `historyKey(lang)`  → `lang-tutor:{lang}:history`
- `progressKey(lang)` → `lang-tutor:{lang}:progress`
- `codeKey(lang)`     → `lang-tutor:{lang}:code`
- `ACTIVE_LANG_KEY`   → `lang-tutor:active`

`migrateOldStorage()` (called on init) copies the legacy `rust-history` / `rust-progress` keys to the namespaced keys for backward compatibility, then deletes the originals.

### Two LLM call sites

Both POST to `/v1/messages` (the local proxy):

1. `callClaude()` (`api.ts`) — the tutoring conversation. Uses a system prompt built by `buildSystem(progress, lang)` in `main.ts` that embeds the active language's intro + lesson plan + strengths + struggles + resume context.
2. `fetchProgressExtraction()` (`api.ts`) — fires after each `evaluateCode()` via `extractProgress()` in `main.ts`. Takes `topics` as a parameter (so the schema reflects the active language). Result is merged with prior progress (preserving any topic statuses the extractor didn't return) and persisted under the active language's key. Guarded against late-arriving results from a previous active language.

`CLAUDE_MODEL` is in `src/constants.ts`. Bumping the model means changing it there only.

### Code execution dispatch

`runCode(lang, code, onProgress?)` in `src/runners.ts` returns `Promise<{ ok: boolean; output: string }>`:

- `runRust` → POST `https://play.rust-lang.org/execute` (channel: stable, edition: 2021).
- `runCpp` → POST `https://wandbox.org/api/compile.json` (compiler: `gcc-head`, options: `warning,c++23,boost-nothing`). Treats `status !== '0'` or compiler messages containing `error:` as failure.
- `runPython` → Lazy-loads Pyodide on first call (`import('pyodide')` plus CDN `indexURL`). Captures stdout/stderr via `setStdout`/`setStderr` batched callbacks. Calls `loadPackagesFromImports(code)` so importing `numpy`, etc. just works.

Pyodide is a `dependency`, not `devDependency`, because the loader code is bundled into the production build. The heavy WASM/Python-stdlib assets (~15 MB) come from the jsDelivr CDN on first run, cached aggressively after.

### Evaluate flow

`evaluateCode()` formats the editor contents and last output as `[CODE]\n\`\`\`{fenceLang}\n…\n\`\`\`\n\n[OUTPUT]\n\`\`\`\n…\n\`\`\``, sends it through the normal chat path, then triggers `extractProgress()`. The system prompt explicitly tells the model to recognize this format.

### Language switching

`setLanguage(newLang)` in `main.ts`:

1. Saves current editor content under the old language's `codeKey`.
2. Calls `loadLanguageState(newLang)`, which:
   - Updates `activeLang` and persists to `ACTIVE_LANG_KEY`.
   - Loads `history`, `progress`, code from the new language's keys (or starter code).
   - Rebuilds `currentSystemPrompt`.
   - Updates `#fileLabel`, syncs `#langSelect` value, refills `#codeArea`.
   - Clears `#outputPre`.
   - Calls `renderChatView()` (renders messages or the start screen) and `renderProgressTab()`.

Async operations (Claude calls, code runs, progress extraction) capture `langWhenStarted = activeLang` at start and bail out if the user switched language mid-flight.

### Start screen

`showStartScreen()` builds the start screen dynamically inside `#msgList` (no longer hardcoded HTML). Shown when `history.length === 0` for the active language. Hidden once a session begins. The Start button only appears for fresh languages — for languages with existing history, the chat is shown directly with the input row enabled.

### Editor

`src/editor.ts` wraps CodeMirror 6 with `createEditor(opts) → TutorEditor`. Internals use `Compartment`s for the language pack and the linter so they swap on language change without recreating the view. `linter()` runs with a 600 ms debounce and calls `fetchDiagnostics(lang, state)` from `src/lint.ts`. `Mod-S` (Ctrl+S) is bound to `formatNow()` which calls `fetchFormatted` and replaces the doc.

### Backend toolchain endpoints

`tools/checker.mjs` is plain-Node ESM, shared between `vite.config.ts` (dev middleware mounted in a `configureServer` plugin) and `server.mjs` (route handlers). Both expose:

- `POST /check` body `{ lang, code }` → `{ available, diagnostics: [{severity, line, column, endLine?, endColumn?, message}] }`
- `POST /format` body `{ lang, code }` → `{ ok, available?, code?, error? }`

Tools are spawned with `child_process.spawn(cmd, args[])` — array form, no shell, no injection vector. User code is piped via stdin only. ENOENT on the executable returns `{ available: false }` so the frontend gracefully disables those features (one console.info on first miss; no further requests).

## Styling

Tailwind v4 utilities for layout, plus component classes in `src/style.css` (`.btn`, `.input-base`, `.subtab`, `.msg-you`, `.msg-ai`, `.code-fence`, `.inline-code`, `.topic-dot`, `.note-pill`, `.resize-bar`, `.bdr*`). Design tokens are CSS custom properties in `@theme` (light defaults) with a `prefers-color-scheme: dark` override on `:root`. Editor syntax colors live in matching `--syn-*` tokens (light + dark) and are referenced from CodeMirror's `HighlightStyle` via `var(...)`.

## Gotchas

- `extractionQueued` is a single-flight guard within a page-load. Concurrent `evaluateCode()` calls within one language won't double-extract. After-language-switch results are dropped via the `langWhenStarted` check.
- `history` is sliced to the last `MAX_HISTORY` (30) entries on every persist; older context is gone from `localStorage` but may still be in memory for the current session until reload.
- Refreshing the page restores the last active language and its full visible history.
- The Reset button (`resetCurrentLanguage`) wipes only the **active** language's history, progress, and code, then reloads. Switch language first if you want to reset a different one.
- `.env` is gitignored. Never commit a real key. The `.env.example` only declares `ANTHROPIC_API_KEY`.
- The output pane height is controlled by `outputPre.style.flex = "0 0 Npx"` set by the resize handle drag (clamped 60–500 px).
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- `noUncheckedIndexedAccess` is on — array indexing yields `T | undefined`. Code uses `?? ''` and explicit checks rather than `!`.
- DOM mutation never uses `innerHTML` with dynamic strings (XSS-safe). The progress tab and start screen are built with `document.createElement` plus the `div`/`span` helpers in `main.ts`.
- The Vite proxy strips `Set-Cookie` from Anthropic responses to suppress the `_cfuvid` cookie warning in DevTools.
- Pyodide loads from a CDN URL of the form `https://cdn.jsdelivr.net/pyodide/v{version}/full/`, where `version` is the version reported by the bundled npm package — they stay in sync automatically.
