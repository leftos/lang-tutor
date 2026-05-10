# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, multi-language programming tutor (Rust, C++, Python, C#, Web). Two workspace shapes:

- **Single-buffer** (`rust` / `cpp` / `python`): one editor, one Run, one output pane. Code runs through a remote sandbox (Playground / Wandbox) or in-browser runtime (Pyodide).
- **Project workspace** (`csharp` / `web`): on-disk project under `projects/<lang>/` with sidebar file tree, multi-tab editor, supervisor that runs `dotnet run` / `pnpm dev`, and an Output / preview pane. Run/Stop wired to the supervisor; logs streamed via SSE.

The user chats with Claude (via the Anthropic API), writes code, runs it, and submits code+output (single-buffer) or files+output/dom (project) for evaluation. Lesson progress is extracted by a second LLM call into structured JSON and persisted in `localStorage`, **independently per language**. Switching language is non-destructive — each language has its own conversation history, lesson progress, and saved editor / tab state.

## Stack

- **TypeScript** (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlight, autocomplete, search, lint, multi-cursor, fold gutter)
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin (config-in-CSS via `@theme`)
- **Pyodide** for in-browser Python (lazy-loaded from CDN on first run)
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20+** runtime for the production proxy (`server.mjs`) and for the local `/check` + `/format` toolchain endpoints
- **chokidar** for filesystem watch on project workspaces (SSE-broadcast tree-change events to the frontend)
- Optional local toolchains:
  - Single-buffer: `rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`
  - Project: `dotnet` (.NET 8+ SDK for csharp), `pnpm` (for web), `code` / `devenv` / `explorer.exe` for the "Open in" launchers

## Run

```powershell
pnpm install                # first time
pnpm dev                    # Vite dev server (default port 5173) — proxies /v1/messages → Anthropic API
pnpm build                  # type-check + Vite build to dist/
pnpm serve                  # node --env-file=.env server.mjs (default port 3000)
pnpm preview                # vite preview (preview the production build via Vite)
pnpm typecheck              # tsc --noEmit
pnpm lint                   # biome check --write .
```

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` before first run. The browser never sees the key — Vite's dev proxy and `server.mjs` both inject it server-side.

**Windows Ctrl+C tip:** `pnpm dev` / `pnpm serve` go through a `.cmd` wrapper, so Ctrl+C triggers the *"Terminate batch job (Y/N)?"* prompt. Use `.\dev.ps1` and `.\serve.ps1` instead — they invoke Node directly so Ctrl+C kills cleanly. Prefer these when iterating.

**Slow-command output:** capture builds, test runs, and Vite/dotnet logs to `.tmp/` (gitignored, project-root) instead of re-running. `cmd 2>&1 | tee .tmp/output.log` then Read/Grep the file.

## Architecture

**Source layout:**

```
src/
  main.ts            Entry: state, session control, language switching, event wiring, init
  editor.ts          CodeMirror 6 wrapper for the single-buffer editor: createEditor() → TutorEditor
  projectEditor.ts   Multi-file CodeMirror wrapper (Map<path, EditorState>) for project workspaces
  projectPreview.ts  createProjectPreview() — dispatches on runtime.kind:
                       - createWebVitePreview (iframe + tabs Preview/Server logs/Build errors)
                       - createDesktopPreview (no iframe + tabs Output/Build errors, dotnet build-phase pill)
  fileTree.ts        File tree UI with rename/delete/Open-in launcher menu
  projectApi.ts      Frontend client for /fs/* + /proj/* (typed fetch wrappers + SSE subscribers)
  lint.ts            Frontend client for /check (returns CodeMirror Diagnostic[]) and /format
  api.ts             callClaude (streaming) + fetchProgressExtraction (non-streaming) — proxied through /v1/messages
  runners.ts         runCode dispatch: runRust (Rust Playground), runCpp (Wandbox), runPython (Pyodide)
  render.ts          renderMarkdown, setInline, renderPlainWithFences (DocumentFragment builders)
  storage.ts         localStorage wrapper (typed get/set/delete)
  constants.ts       LANGUAGES record (topics, prompts, starter / scaffold metadata), storage-key helpers
  types.ts           Language (SingleBufferLanguage | ProjectLanguage), runtime variants, FsNode, etc.
  style.css          @import "tailwindcss" + @theme tokens + --syn-* syntax tokens + @layer base/components/utilities

tools/
  checker.mjs        Single-buffer toolchain backend: spawns rustc/clang/python (--check) and
                     rustfmt/clang-format/black (--format).
  projects.mjs       Project workspace supervisor: scaffolding, file CRUD with traversal-rejection,
                     per-language dev/install command spawn (PROJECT_CONFIG table), SSE log broadcast,
                     readiness probes (http-probe / process-alive), HMR-orphan guard via globalThis stash.
  project-routes.mjs Shared HTTP handler for /fs/* + /proj/* — used by the Vite dev middleware AND
                     the production server.mjs. Returns true when handled.

scripts/
  setup.ps1          Idempotent Windows quickstart: winget-installs runtimes, runs pnpm install,
                     starts dev server in background, opens browser.

projects/            On-disk project workspaces (gitignored except scaffolds). Reset wipes & re-scaffolds.
```

### Per-language model

Active language is one of `'rust' | 'cpp' | 'python' | 'csharp' | 'web'` (`LanguageId`). Each language is a `Language` record in `LANGUAGES` (`src/constants.ts`); `Language` is a discriminated union:

- `SingleBufferLanguage` (`kind: 'single'`) — `rust` / `cpp` / `python`. Carries `starterCode`, `fileName`, `fenceLang` (the inline-editor metadata).
- `ProjectLanguage` (`kind: 'project'`) — `csharp` / `web`. Carries `scaffoldDir` and a `runtime` discriminator:
  - `WebProjectRuntime` (`{ kind: 'web-vite', port }`) — Vite dev server in an iframe. Web's port is `5180` — the iframe loads `http://127.0.0.1:5180/` and the readiness probe polls the same.
  - `DesktopProjectRuntime` (`{ kind: 'desktop-process' }`) — supervised native process (no HTTP, no iframe). For C# the WPF window opens on the user's actual desktop.

Both shapes share `topics`, `systemPromptIntro`, `firstSessionPrompt`. The runtime kind drives every per-language UI decision in `projectPreview.ts` (`createWebVitePreview` vs `createDesktopPreview`) and per-language config in `tools/projects.mjs` (`PROJECT_CONFIG[lang]` — install / dev commands, readiness probe, treeIgnore, bootstrap).

Adding a single-buffer language: add to `LanguageId` + `LANGUAGE_IDS`, add a `Language` record to `LANGUAGES`, add a tab to `index.html`'s language rail. Adding a project language: also add a `PROJECT_CONFIG` entry in `tools/projects.mjs` and a scaffold under `tools/projects.mjs`'s ensureScaffold (or follow the existing csharp / web scaffold patterns).

Adding/renaming topics for an existing language: edit only that language's `topics` array.

### Storage namespacing

Helpers in `constants.ts`:

- `historyKey(lang)`     → `lang-tutor:{lang}:history`
- `progressKey(lang)`    → `lang-tutor:{lang}:progress`
- `codeKey(lang)`        → `lang-tutor:{lang}:code` (single-buffer only — project workspaces own files on disk)
- `openTabsKey(lang)`    → `lang-tutor:{lang}:openTabs` (project workspaces; ordered list of tab paths)
- `activeTabKey(lang)`   → `lang-tutor:{lang}:activeTab` (project workspaces)
- `ACTIVE_LANG_KEY`      → `lang-tutor:active`

`migrateOldStorage()` (called on init):
- Copies the legacy `rust-history` / `rust-progress` keys to the namespaced keys for backward compatibility, then deletes the originals.
- Deletes `lang-tutor:csharp:code` — Phase 1 of the C# course shipped a single-buffer editor; the course is now a project workspace.

### Two LLM call sites

Both POST to `/v1/messages` (the local proxy):

1. `callClaude()` (`api.ts`) — the tutoring conversation. Uses a system prompt built by `buildSystem(progress, lang)` in `main.ts` that embeds the active language's intro + lesson plan + strengths + struggles + resume context.
2. `fetchProgressExtraction()` (`api.ts`) — fires after each `evaluateCode()` via `extractProgress()` in `main.ts`. Takes `topics` as a parameter (so the schema reflects the active language). Result is merged with prior progress (preserving any topic statuses the extractor didn't return) and persisted under the active language's key. Guarded against late-arriving results from a previous active language.

`CLAUDE_MODEL` is in `src/constants.ts`. Bumping the model means changing it there only.

### Code execution dispatch

**Single-buffer** — `runCode(lang, code, onProgress?)` in `src/runners.ts` returns `Promise<{ ok: boolean; output: string }>`:

- `runRust` → POST `https://play.rust-lang.org/execute` (channel: stable, edition: 2021).
- `runCpp` → POST `https://wandbox.org/api/compile.json` (compiler: `gcc-head`, options: `warning,c++23,boost-nothing`). Treats `status !== '0'` or compiler messages containing `error:` as failure.
- `runPython` → Lazy-loads Pyodide on first call (`import('pyodide')` plus CDN `indexURL`). Captures stdout/stderr via `setStdout`/`setStderr` batched callbacks. Calls `loadPackagesFromImports(code)` so importing `numpy`, etc. just works.

Pyodide is a `dependency`, not `devDependency`, because the loader code is bundled into the production build. The heavy WASM/Python-stdlib assets (~15 MB) come from the jsDelivr CDN on first run, cached aggressively after.

**Project workspaces** — supervised by `tools/projects.mjs`. Run/Stop hits `POST /proj/start` / `/proj/stop`; status pill streams from `POST /proj/status` polled every 2 s + log SSE on `/proj/logs`. PROJECT_CONFIG drives the install/dev commands (web → `pnpm install` + `pnpm dev`; csharp → `dotnet restore` + `dotnet run --verbosity minimal`). Readiness is `http-probe` for web (Vite port 5180) or `process-alive` for csharp (500 ms warm-up). The C# pill additionally reflects build phases derived from dotnet's `--verbosity minimal` output: `spawning…` → `restoring NuGet…` → `building…` → `running (PID N)`.

### Evaluate flow

`evaluateCode()` (single-buffer) formats the editor contents and last output as `[CODE]\n\`\`\`{fenceLang}\n…\n\`\`\`\n\n[OUTPUT]\n\`\`\`\n…\n\`\`\``, sends it through the normal chat path, then triggers `extractProgress()`. The system prompt explicitly tells the model to recognize this format.

`evaluateProjectCode()` (project workspaces) branches on `runtime.kind`:

- **web-vite**: `[FILES]` (open tabs, `(unsaved)` marker on dirty) + `[DOM]` (iframe `documentElement.outerHTML` snapshot via postMessage) + `[CONSOLE]` (recent iframe console + uncaught errors) + `[SERVER]` (recent Vite stdout/stderr).
- **desktop-process**: `[FILES]` + `[OUTPUT]` (recent dotnet stdout/stderr including build errors). No DOM/CONSOLE — the C# tutor system prompt instructs the model to ask for screenshots when UI behaviour matters and quotes regex hints (`error CS\d+:`, `error MSB\d+:`, `Unhandled exception:`) so it knows what to look for.

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

Two backend modules, both shared between `vite.config.ts` (dev middleware in a `configureServer` plugin) and `server.mjs` (route handlers):

`tools/checker.mjs` — single-buffer linting/formatting:
- `POST /check` body `{ lang, code }` → `{ available, diagnostics: [{severity, line, column, endLine?, endColumn?, message}] }`
- `POST /format` body `{ lang, code }` → `{ ok, available?, code?, error? }`

`tools/projects.mjs` (routed via `tools/project-routes.mjs`) — project workspaces:
- `POST /fs/list|read|write|rename|delete|mkdir` body `{ lang, path?, … }` — file CRUD with strict path-traversal rejection (every `path` is resolved against the project root and rejected if it escapes).
- `GET /fs/watch?lang=…` (SSE) — chokidar-driven tree-change events.
- `POST /proj/scaffold|start|stop|reset` body `{ lang }` — supervisor lifecycle. `/proj/reset` stops the process, deletes `projects/<lang>/`, and re-scaffolds atomically.
- `GET /proj/status?lang=…` → `{ running, ready, phase, pid, lastExitCode, vitePort, error }`.
- `GET /proj/logs?lang=…` (SSE) — replays buffered log lines then streams live.
- `GET /proj/logs/recent?lang=…&n=200` → `{ lines }`.
- `GET /proj/open/targets` + `POST /proj/open` body `{ lang, target }` — "Open in" launcher (vscode / vs / explorer); availability cached after first probe.

All spawns use `child_process.spawn(cmd, args[])` — array form, no shell injection vector. User code is piped via stdin only (single-buffer) or read from disk (project). ENOENT on the executable returns `{ available: false }` (single-buffer) or a friendly install hint pushed into the project's log buffer (project).

The supervisor stashes its `procs` Map on `globalThis['__langTutorProcs']` so Vite HMR reloading `tools/projects.mjs` doesn't lose track of running children. Process-exit / SIGINT / SIGTERM handlers (registered once via a global flag) call `killProcessTree` for every supervised PID so children die with the dev server.

## Styling

Tailwind v4 utilities for layout, plus component classes in `src/style.css` (`.btn`, `.input-base`, `.subtab`, `.msg-you`, `.msg-ai`, `.code-fence`, `.inline-code`, `.topic-dot`, `.note-pill`, `.resize-bar`, `.bdr*`). Design tokens are CSS custom properties in `@theme` (light defaults) with a `prefers-color-scheme: dark` override on `:root`. Editor syntax colors live in matching `--syn-*` tokens (light + dark) and are referenced from CodeMirror's `HighlightStyle` via `var(...)`.

## Gotchas

- `extractionQueued` is a single-flight guard within a page-load. Concurrent `evaluateCode()` calls within one language won't double-extract. After-language-switch results are dropped via the `langWhenStarted` check.
- `history` is sliced to the last `MAX_HISTORY` (30) entries on every persist; older context is gone from `localStorage` but may still be in memory for the current session until reload.
- Refreshing the page restores the last active language and its full visible history.
- The Reset button (`resetCurrentLanguage`) wipes only the **active** language's history, progress, and code (single-buffer) or `projects/<lang>/` folder (project workspaces, via `POST /proj/reset` — confirmation dialog calls out the destructive on-disk delete). Switch language first if you want to reset a different one.
- Project workspace gotcha: shared header DOM elements (`#projRunBtn`, `#projReloadBtn`, `#projOpenExternalBtn`) survive language switches. Both `createWebVitePreview` and `createDesktopPreview` register their click handlers via an `AbortController`; `destroy()` calls `ctrl.abort()` to remove them. Without this, switching between csharp and web would accumulate handlers and the wrong runtime's startProject would fire on Run.
- C# build-phase pill (`spawning…` → `restoring NuGet…` → `building…` → `running`) is derived from regex matches on `dotnet --verbosity minimal`'s stdout (`Determining projects to restore`, `All projects are up-to-date for restore` / `^\s*Restored\b`, `^\s+\S.* -> .+\.dll`). Phase only ever advances forward within a Run cycle. System-stream lines (the supervisor's own pushLog markers) are skipped so a literal "Restored" in our banner can't flip phases.
- `dotnet run` defaults to `quiet` verbosity under non-TTY stdout — meaning *no* output until exit. The csharp dev command in PROJECT_CONFIG explicitly passes `--verbosity minimal` to get the build milestones above.
- `.env` is gitignored. Never commit a real key. The `.env.example` only declares `ANTHROPIC_API_KEY`.
- The output pane height is controlled by `outputPre.style.flex = "0 0 Npx"` set by the resize handle drag (clamped 60–500 px).
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- `noUncheckedIndexedAccess` is on — array indexing yields `T | undefined`. Code uses `?? ''` and explicit checks rather than `!`.
- DOM mutation never uses `innerHTML` with dynamic strings (XSS-safe). The progress tab and start screen are built with `document.createElement` plus the `div`/`span` helpers in `main.ts`.
- The Vite proxy strips `Set-Cookie` from Anthropic responses to suppress the `_cfuvid` cookie warning in DevTools.
- Pyodide loads from a CDN URL of the form `https://cdn.jsdelivr.net/pyodide/v{version}/full/`, where `version` is the version reported by the bundled npm package — they stay in sync automatically.
