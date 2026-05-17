# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, multi-language programming tutor (Rust, C++, DASM, Python, C#, Web). Two workspace shapes:

- **Single-buffer** (`rust` / `cpp` / `dasm` / `python`): one editor, one Run, one output pane. Code runs in the local Docker sandbox image (`lang-tutor-toolchains:latest`).
- **Project workspace** (`csharp` / `web`): on-disk project with sidebar file tree, multi-tab editor, Run / Send controls above the code, supervisor that runs `dotnet run` / `pnpm dev`, and an Output / preview pane. Run/Stop wired to the supervisor; logs streamed via SSE.

The user chats with their selected AI provider (Anthropic Claude, OpenAI ChatGPT, or Google Gemini) directly from the browser using their own API key. They write code, run it, and click "Send to tutor" to submit a structured bundle (note + code + output + LSP diagnostics, plus DOM/console/server logs for project workspaces, plus a screenshot of the WPF window or rendered iframe). Lesson progress is extracted by a second LLM call into structured JSON and persisted independently per language. A shared learner profile is also extracted and mirrored across languages so tutors can reuse stable background, goals, preferences, and learning trends. Switching language is non-destructive — each language has its own conversation history, lesson progress, and saved editor / tab state.

`localStorage` is mirrored to `.local/state/local-storage.json` (or to the signed-in account's SQLite row when hosted) via the local `/state/local-storage` endpoint. This keeps progress portable across dev-server origins such as `localhost`, `127.0.0.1`, LAN IPs, and port changes. Provider API keys are explicitly excluded from the mirror.

## Stack

- **TypeScript** (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlight, autocomplete, search, lint, multi-cursor, fold gutter), driven by real LSP diagnostics for inline errors
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin (config-in-CSS via `@theme`)
- **Docker Desktop** for the local sandbox image used by Rust / C++ / DASM / Python / C# console runs
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20.6+** runtime for the production server (`server.mjs`) and the local `/run` + `/check` + `/format` + `/lsp` + `/proj` + `/fs` + `/state` + `/auth` endpoints
- **chokidar** for filesystem watch on project workspaces (SSE-broadcast tree-change events)
- **ws** for WebSocket transport of LSP JSON-RPC traffic
- **@node-rs/argon2** + `cookie` for account hashing and session cookies (httpOnly + CSRF)
- **dompurify** + **marked** for XSS-safe markdown rendering of assistant messages
- **html-to-image** for rasterising the web preview iframe into a PNG vision block
- Optional local toolchains (auto-detected; features silently disable if missing):
  - Single-buffer host tools: `rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`
  - Project: `dotnet` (.NET 8+ SDK), `pnpm`, `code` / `devenv` / `explorer.exe` for the "Open in" launchers
  - LSP binaries: `clangd`, `rust-analyzer`, `basedpyright-langserver`, Roslyn LSP (discovered from C# Dev Kit install), `typescript-language-server`, `vscode-html-languageserver`, `vscode-css-languageserver`, `@biomejs/biome lsp-proxy`

## Run

```powershell
pnpm install                # first time
.\lt.ps1 dev                # Vite dev server (default port 5173)
.\lt.ps1 build              # type-check + Vite build to dist/
.\lt.ps1 serve              # node --env-file=.env server.mjs (default port 3000)
.\lt.ps1 preview            # vite preview (preview the production build)
.\lt.ps1 typecheck          # tsc --noEmit
.\lt.ps1 lint               # biome check --write .
.\lt.ps1 toolchain          # build lang-tutor-toolchains:latest for /run
.\lt.ps1 deploy             # deploy an immutable release to leftos.dev/lang-tutor/
```

`.env` holds **runtime config** only — provider API keys are entered in the browser via the AI Provider dialog and persist to `localStorage`. The interesting env vars are in `.env.example`: `PORT`, `LANG_TUTOR_BASE_PATH`, `LANG_TUTOR_REQUIRE_AUTH`, `LANG_TUTOR_SECURE_COOKIES`, `LANG_TUTOR_DB_FILE`, `LANG_TUTOR_RUN_ROOT`, `LANG_TUTOR_TOOLCHAIN_IMAGE`. Auth is off in local dev (`LANG_TUTOR_REQUIRE_AUTH=false`) and on for the hosted droplet.

**Windows Ctrl+C tip:** `pnpm dev` / `pnpm serve` go through a `.cmd` wrapper, so Ctrl+C triggers *"Terminate batch job (Y/N)?"*. Use `.\lt.ps1 dev` and `.\lt.ps1 serve` — they invoke Node directly and Ctrl+C kills cleanly.

**Slow-command output:** capture builds, test runs, and Vite/dotnet logs to `.tmp/` (gitignored, project-root) instead of re-running. `cmd 2>&1 | tee .tmp/output.log` then Read/Grep the file.

## Architecture

**Source layout (frontend):**

```
src/
  main.ts            Entry: state, session control, language switching, event wiring, init
  appUrls.ts         appUrl()/appWsUrl() — prepends Vite BASE_URL so the app works under /lang-tutor/
  api.ts             callClaude (streaming, provider-aware) + fetchProgressExtraction + fetchLearnerProfileExtraction
  authClient.ts      AI provider–independent account auth: register / login / logout / session refresh + CSRF
  providerSettings.ts Per-provider config (Anthropic / OpenAI / Gemini): API key, model list, default model
  editor.ts          CodeMirror 6 wrapper for single-buffer editor: createEditor() → TutorEditor
  projectEditor.ts   Multi-file CodeMirror wrapper (Map<path, EditorState>) for project workspaces
  lspClient.ts       Hand-rolled LSP-over-WebSocket client. One bundle per language; fans out across servers
                     (e.g. web: typescript-language-server + html + css + biome). Tracks per-URI diagnostics.
  lspEditor.ts       CodeMirror extension that bridges editor events ↔ lspClient (didOpen/didChange,
                     hover, completion, signatureHelp, inlay hints, document symbols, formatting, diagnostics).
  projectPreview.ts  createProjectPreview() — dispatches on runtime.kind:
                       - createWebVitePreview (iframe + tabs Preview/Server logs/Build errors)
                       - createDesktopPreview (no iframe + tabs Output/Build errors, dotnet build-phase pill)
  fileTree.ts        File tree UI with rename/delete/Open-in launcher menu
  projectApi.ts      Frontend client for /fs/* + /proj/* (typed fetch wrappers + SSE subscribers)
  lint.ts            Frontend client for /check (CodeMirror Diagnostic[]) and /format — legacy host-tool path
                     for languages whose LSP isn't available; live LSP diagnostics are preferred when present.
  runners.ts         runCode dispatch to /run, backed by the local Docker sandbox image
  render.ts          renderMarkdown, setInline, renderPlainWithFences (DocumentFragment builders, DOMPurify-sanitised)
  storage.ts         localStorage wrapper (typed get/set/delete) + disk hydration via /state/local-storage
  constants.ts       LANGUAGES record (topics, prompts, starter / scaffold metadata), storage-key helpers
  types.ts           Language (SingleBufferLanguage | ProjectLanguage), runtime variants, FsNode,
                     AiProvider, ProviderConfig, LearnerProfile, etc.
  style.css          @import "tailwindcss" + @theme tokens + --syn-* syntax tokens + @layer base/components/utilities
```

**Backend (Node — mounted both by Vite dev middleware and `server.mjs`):**

```
tools/
  checker.mjs        Single-buffer linting/formatting via host tools: rustc/clang/python --check,
                     rustfmt/clang-format/black --format. Returns { available, diagnostics } / { ok, code }.
  runner.mjs         /run dispatcher — writes single-buffer code into .tmp/runs/<lang>-* and spawns
                     lang-tutor-toolchains:latest with --network none, read-only root, dropped caps,
                     no-new-privileges, CPU/memory/process limits.
  projects.mjs       Project workspace supervisor: scaffolding, file CRUD with traversal-rejection,
                     per-language dev/install command spawn (PROJECT_CONFIG), SSE log broadcast,
                     readiness probes (http-probe / process-alive), HMR-orphan guard via globalThis stash,
                     WPF window screenshot via wgc-capture/.
  project-routes.mjs Shared HTTP/WS handler for /fs/* + /proj/* — used by both Vite middleware and server.mjs.
  lsp.mjs            LSP bridge: POST /lsp/spawn → spawns child language servers, returns session IDs.
                     WS /lsp?session=<id> bridges browser ↔ stdio JSON-RPC. POST /lsp/dispose graceful shutdown.
                     LSP_CONFIG/LANG_SERVERS describes single-server and fan-out (web) language bundles.
                     Hardcoded argv only — user code travels via stdin, never argv.
  auth-routes.mjs    /auth/register|login|logout|session. argon2id hashing, httpOnly session cookie +
                     CSRF double-submit. Gated by LANG_TUTOR_REQUIRE_AUTH.
  account-store.mjs  SQLite-backed (sql.js) account + session store. Path from LANG_TUTOR_DB_FILE.
  app-state.mjs      /state/local-storage GET/POST — mirrors browser localStorage to disk
                     (or to the signed-in account's SQLite row when auth is on). Skips provider keys.
  http.mjs           Shared helpers: readRequestBody, writeJson, isRecord.
  wgc-capture/       Native helper exe (built on demand from a small C# project) that uses Windows
                     Graphics Capture to PNG-rasterise a process's top-level window — used to attach
                     a screenshot vision block when the user clicks "Send to tutor" on a running WPF app.
```

**Other entry points:**

```
server.mjs               Production HTTP server: serves dist/, wires /auth /state /run /check /format /lsp
                         /fs /proj. Strips LANG_TUTOR_BASE_PATH prefix so hosting under /lang-tutor/ works.
vite.config.ts           Dev plugin "lang-tutor-toolchain" mounts every backend module above as middleware,
                         hooks /lsp + /fs WebSocket upgrades on the Vite HTTP server. Manual chunks:
                         editor-vendor (@codemirror/@lezer/csharp), content-vendor (marked/dompurify/html-to-image), vendor.
scripts/setup.ps1        Idempotent Windows quickstart: winget-installs runtimes, pnpm install, starts dev server.
scripts/build-toolchain-image.ps1   Builds lang-tutor-toolchains:latest from docker/toolchains/.
scripts/copy-html-to-image.mjs      predev/prebuild step: copies the html-to-image bundle into public/.
projects/                Scaffold templates per project language (csharp, web). Reset re-scaffolds from here.
docker/toolchains/       Dockerfile + tooling for the sandbox image (Clang/LLVM, Rust, Python 3.13, .NET SDK,
                         formatters, LSPs).
docs/                    deployment.md (one-time host setup) + plans/ (milestone checklists).
```

### Per-language model

Active language is one of `'rust' | 'cpp' | 'dasm' | 'python' | 'csharp' | 'web'` (`LanguageId`). Each is a `Language` record in `LANGUAGES` (`src/constants.ts`); `Language` is a discriminated union:

- `SingleBufferLanguage` (`kind: 'single'`) — `rust` / `cpp` / `dasm` / `python`. Carries `starterCode`, `fileName`, `fenceLang`.
- `ProjectLanguage` (`kind: 'project'`) — `csharp` / `web`. Carries `scaffoldDir` and a `runtime` discriminator:
  - `WebProjectRuntime` (`{ kind: 'web-vite', port }`) — Vite dev server in an iframe. Web's port is `5180` — the iframe loads `http://127.0.0.1:5180/` and the readiness probe polls the same.
  - `DesktopProjectRuntime` (`{ kind: 'desktop-process' }`) — supervised native process (no HTTP, no iframe). For C# the WPF window opens on the user's actual desktop.

DASM is special: same C++ source compile as `cpp`, but the runner emits an Intel-syntax, source-interleaved `objdump` excerpt focused on user-defined symbols from `main.cpp` (filtered to avoid CRT startup noise) along with program output. The DASM toolbar exposes compiler-flag presets (`-O0` / `-O1` / `-O2` plus a free-form input) so the student can A/B optimisation levels, and edits auto-trigger a debounced disassembly refresh.

Runtime kind drives every per-language UI decision in `projectPreview.ts` (`createWebVitePreview` vs `createDesktopPreview`) and per-language config in `tools/projects.mjs` (`PROJECT_CONFIG[lang]` — install / dev commands, readiness probe, treeIgnore, bootstrap).

Adding a single-buffer language: extend `LanguageId` + `LANGUAGE_IDS`, add a `Language` record, add a tab to `index.html`, add a runner branch in `tools/runner.mjs` (and host-tool support in `tools/checker.mjs` if applicable), add an `LSP_CONFIG` + `LANG_SERVERS` entry in `tools/lsp.mjs` if a language server exists. Adding a project language: also add a `PROJECT_CONFIG` entry in `tools/projects.mjs` and a scaffold under `projects/<lang>/`.

### Storage namespacing

Helpers in `constants.ts`:

- `historyKey(lang)`     → `lang-tutor:{lang}:history`
- `progressKey(lang)`    → `lang-tutor:{lang}:progress`
- `codeKey(lang)`        → `lang-tutor:{lang}:code` (single-buffer only — project workspaces own files on disk)
- `openTabsKey(lang)`    → `lang-tutor:{lang}:openTabs` (project workspaces; ordered list of tab paths)
- `activeTabKey(lang)`   → `lang-tutor:{lang}:activeTab`
- `treeStateKey(lang)`   → `lang-tutor:{lang}:treeState` (expanded folders)
- `ACTIVE_LANG_KEY`      → `lang-tutor:active`
- `LEARNER_PROFILE_KEY`  → `lang-tutor:learner-profile` (shared across languages)
- `PROVIDER_SETTINGS_KEY` (in `providerSettings.ts`) → `lang-tutor:provider-settings`

Local-only UI keys (declared in `main.ts`): `lang-tutor:theme`, `lang-tutor:dasm:compiler-flags`, `lang-tutor:focus-mode`.

`migrateOldStorage()` (called on init):
- Copies the legacy `rust-history` / `rust-progress` keys to the namespaced keys for backward compatibility, then deletes the originals.
- Deletes `lang-tutor:csharp:code` — Phase 1 of the C# course shipped a single-buffer editor; the course is now a project workspace.

`hydrateStorageFromDisk()` runs before any other init step. It fetches `/state/local-storage` and overlays disk-persisted keys onto browser `localStorage` so progress survives an origin/port change. Provider API keys are intentionally excluded from the mirror.

### AI provider plumbing

`src/providerSettings.ts` defines three providers (`anthropic`, `openai`, `gemini`), each with its own model list, default model, and API key (`readProviderKey(provider)`). Keys live only in browser `localStorage` — they never leave the device, are not stored on the server, and are excluded from the `/state/local-storage` mirror. The "AI Provider" dialog lets the user paste a key, click **Load models** to fetch that provider's currently available chat/generation models live, and pick one. If the saved model disappears from the provider's list, the app warns and forces re-selection.

Both LLM call sites go from the browser **directly to the provider** with the user's key — no local proxy:

1. `callClaude()` (`src/api.ts`) — the tutoring conversation, streamed. Provider-aware (Anthropic / OpenAI / Gemini SSE parsers). System prompt is built by `buildSystem(progress, learnerProfile, lang)` in `main.ts` and embeds the active language's intro + lesson plan + strengths + struggles + resume context + shared learner profile.
2. `fetchProgressExtraction()` (non-streaming) fires after each `evaluateCode()`. Takes `topics` as a parameter (so the schema reflects the active language). Result merged with prior progress (preserving any topic statuses the extractor didn't return) and persisted under the active language's key. Guarded against late-arriving results from a previous active language.
3. `fetchLearnerProfileExtraction()` extracts the shared learner profile (`LEARNER_PROFILE_KEY`) from the active language's recent conversation.

There is no `CLAUDE_MODEL` constant. The active model lives in `providerSettings` keyed by provider; changing it is a per-provider dropdown in the UI, not a code edit.

### Code execution dispatch

**Single-buffer** — `runCode(lang, code, onProgress?, options?)` in `src/runners.ts` returns `Promise<{ ok, output }>`. All four single-buffer langs POST `/run` with `{ lang, code, options }`; `tools/runner.mjs` writes the code into `.tmp/runs/<lang>-*/` and spawns `lang-tutor-toolchains:latest` with `--network none`, a read-only container root, dropped capabilities, `no-new-privileges`, and CPU / memory / process limits. C++ uses `clang++ -std=c++23`, Rust uses `rustc --edition=2021`, Python uses `python3`, DASM compiles the C++ file with the user-controlled compiler flags and runs an `objdump --disassemble --source` filtered to user-defined symbols. C# console snippets (from the C# toolbar's terminal button) also hit `/run` with `lang: "csharp"` and are compiled into a temporary console app inside the same image.

The toolchain image is built by `.\lt.ps1 toolchain` from `docker/toolchains/`.

**Project workspaces** — supervised by `tools/projects.mjs`. Run/Stop hits `POST /proj/start` / `/proj/stop`; status pill polls `POST /proj/status` every 2 s + log SSE on `/proj/logs`. PROJECT_CONFIG drives install/dev commands (web → `pnpm install` + `pnpm dev`; csharp → `dotnet restore LangTutor.sln` + `dotnet run --project LangTutor.Wpf/LangTutor.Wpf.csproj --verbosity minimal`). Readiness is `http-probe` for web (Vite port 5180) or `process-alive` for csharp (500 ms warm-up). The C# pill reflects build phases derived from `dotnet --verbosity minimal` output: `spawning…` → `restoring NuGet…` → `building…` → `running (PID N)`.

Project files live under a **user-scoped path**: locally `.local/workspaces/<user>/<lang>/`, on the hosted droplet `/var/lib/lang-tutor/workspaces/<user>/<lang>/`. Templates live in `projects/<lang>/` and are copied on first scaffold. `POST /proj/reset` stops the supervised process, deletes the user's workspace folder, and re-scaffolds from the template.

### Send-to-tutor / Evaluate flow

`evaluateCode()` (single-buffer) bundles the student's current editor state into a structured message and sends it through the normal chat path, then triggers `extractProgress()`. The system prompt is explicit about the format. Blocks the bundle may contain:

- `[NOTE]` — the student's optional free-text question/confusion (shown first in the prompt; tutors are told to answer it before the code).
- `[COMPILER FLAGS]` — DASM only (the active `-O0/-O1/-O2 …` flags).
- `[CODE]` — fenced editor contents using the language's `fenceLang`.
- `[OUTPUT]` — the last run's stdout/stderr (DASM includes program output + the objdump excerpt).
- `[LSP]` — diagnostics straight from the active language server (rust-analyzer / clangd / basedpyright / Roslyn), authoritative source-level errors with `file:line:col` locations and (often) a rule/error code in brackets. The system prompt tells the model to lead with these.

`evaluateProjectCode()` branches on `runtime.kind`:

- **web-vite**: `[NOTE]` + `[FILES]` (open tabs plus likely-edited workspace files; `(unsaved)` marker on dirty tabs) + `[BUILD]` (verbatim Vite HMR error overlay text — only present when a build error is currently on screen; lead with it) + `[DOM]` (iframe `documentElement.outerHTML` snapshot via postMessage) + `[CONSOLE]` (recent iframe console + uncaught errors) + `[SERVER]` (recent Vite stdout/stderr including vite-plugin-checker output) + `[LSP]` (diagnostics from typescript-language-server, html, css, biome — reflects unsaved buffers). When the iframe is rendering, a PNG of the page is attached as a Claude vision block via `html-to-image`. Caveats: doesn't capture `<canvas>` contents, `<video>` frames, `backdrop-filter`, or some animations — the prompt tells the model to trust `[DOM]` over the image on disagreement.
- **desktop-process** (C#): `[NOTE]` + `[FILES]` + `[OUTPUT]` (recent dotnet stdout/stderr including build errors and any console-run snippets) + `[LSP]` (Roslyn diagnostics across open tabs). When the WPF window is on screen, a PNG captured server-side via Windows Graphics Capture (`tools/wgc-capture/`) is attached as a vision block — it handles transparency and hardware-accelerated rendering correctly. If capture failed, `[SCREENSHOT]` carries a "(capture failed …)" note instead.

### Language switching

`setLanguage(newLang)` in `main.ts`:

1. Saves current editor content under the old language's `codeKey` (single-buffer) or flushes dirty tabs (project).
2. Calls `loadLanguageState(newLang)`, which updates `activeLang`, loads namespaced history/progress/code, rebuilds the system prompt, refills the editor, and rerenders chat + progress.

Async operations (provider calls, code runs, progress extraction, screenshot capture) capture `langWhenStarted = activeLang` at start and bail out if the user switched language mid-flight.

### LSP integration

`src/lspClient.ts` is a hand-rolled JSON-RPC client over WebSocket. `connectLsp(lang)` POSTs `/lsp/spawn` to get back a bundle of `{serverKey, sessionId, acceptsLanguageIds}` entries (one for single-server langs, fan-out for `web`: tsserver + html + css + biome). It opens one WS per server, initialises each, and merges per-URI `publishDiagnostics` into a unified diagnostic map. `lspEditor.ts` is the CodeMirror extension that bridges editor events ↔ client: `didOpenUri`/`didChange` on text changes, on-demand `hover` / `completion` / `signatureHelp` / `inlayHint` / `documentSymbol` / `formatting`, and pushes merged diagnostics back into CodeMirror's lint gutter. `client.dispose()` runs on language switch / page unload and closes every server gracefully (with auto-reap if the WS just drops).

`tools/lsp.mjs` (backend) holds `LSP_CONFIG` (binary name + argv per server) and `LANG_SERVERS` (ordered fan-out per user-facing language). Every spawn uses the array form of `child_process.spawn` — user code travels via stdin only, never argv. `GET /lsp/availability?lang=…&server=…` is a per-server probe used by setup; spawn endpoints short-circuit per-server when the bin is missing and report which servers couldn't start so the UI can degrade gracefully.

The frontend `lint.ts` `/check` + `/format` path is now the **legacy fallback** for single-buffer langs whose LSP isn't available or hasn't loaded yet. Prefer LSP diagnostics when present.

### Start screen & editor

`showStartScreen()` builds the start screen dynamically inside `#msgList` (no hardcoded HTML). Shown when `history.length === 0` for the active language. Hidden once a session begins. The Start button only appears for fresh languages — for languages with existing history, the chat is shown directly with the input row enabled.

`src/editor.ts` wraps CodeMirror 6 with `createEditor(opts) → TutorEditor`. Internals use `Compartment`s for the language pack and the linter so they swap on language change without recreating the view. The linter pulls from LSP when connected and falls back to `fetchDiagnostics(lang, state)` from `src/lint.ts` (debounced) otherwise. `Mod-S` (Ctrl+S) prefers LSP `textDocument/formatting`; falls back to the `/format` host-tool route when LSP doesn't support it. `src/lspEditor.ts` adds hover tooltips, signature-help popups, inlay hints, and autocomplete sourced from the active LSP bundle.

### Backend endpoints

Both Vite dev middleware (`vite.config.ts` → `toolchainPlugin`) and `server.mjs` mount the same handler modules. Endpoints:

- `POST /run` `{ lang, code, options? }` → `{ ok, output }`. Sandbox image, all single-buffer langs + csharp console.
- `POST /check` / `POST /format` `{ lang, code }` — legacy host-tool diagnostics/format for single-buffer.
- `POST /lsp/spawn` `{ lang }` → bundle of `{ serverKey, sessionId, acceptsLanguageIds, rootUri, mainFileUri }`.
- `GET /lsp/availability?lang=…&server=…` → `{ available, version?, error? }`.
- `WS /lsp?session=<id>` — bidirectional JSON-RPC (raw JSON over WS, Content-Length-framed on the spawn stdio).
- `POST /lsp/dispose` `{ sessionId }` — graceful shutdown.
- `POST /fs/list|read|write|rename|delete|mkdir` — file CRUD with strict path-traversal rejection (every `path` resolved against the project root and rejected if it escapes).
- `GET /fs/watch?lang=…` (SSE) — chokidar-driven tree-change events.
- `POST /proj/scaffold|start|stop|reset` — supervisor lifecycle.
- `GET /proj/status?lang=…` → `{ running, ready, phase, pid, lastExitCode, vitePort, error }`.
- `GET /proj/logs?lang=…` (SSE) — replays buffered log lines then streams live.
- `GET /proj/logs/recent?lang=…&n=200` → `{ lines }`.
- `GET /proj/open/targets` + `POST /proj/open` — "Open in" launcher (vscode / vs / explorer); availability cached after first probe.
- `POST /proj/screenshot` `{ lang }` → PNG bytes for the WPF window via `tools/wgc-capture/`.
- `GET /state/local-storage` / `POST /state/local-storage` — disk/account mirror of `localStorage`. Provider keys excluded.
- `POST /auth/register|login|logout` + `GET /auth/session` — argon2id, httpOnly session cookie + CSRF double-submit. Gated by `LANG_TUTOR_REQUIRE_AUTH`.

All spawns use `child_process.spawn(cmd, args[])` — array form, no shell injection vector (the LSP module uses `shell: true` only on Windows to resolve `.cmd` shims for npm-global installs; argv is still hardcoded constants, never user input). Single-buffer code is written to an untracked temp workspace and mounted into the local Docker sandbox; project code is read from the user's on-disk workspace. ENOENT on host tools returns `{ available: false }` (single-buffer) or a friendly install hint pushed into the project's log buffer (project).

The supervisor stashes its `procs` Map on `globalThis['__langTutorProcs']` so Vite HMR reloading `tools/projects.mjs` doesn't lose track of running children. Process-exit / SIGINT / SIGTERM handlers (registered once via a global flag) call `killProcessTree` for every supervised PID so children die with the dev server.

## Production deploy

`.\lt.ps1 deploy` is the production shortcut. It runs the local type-check/build gate, pushes the current branch, archives `HEAD` (or the working tree with `-Worktree`), uploads an immutable release to the droplet, builds with `LANG_TUTOR_BASE_PATH` derived from `-DeployUrl`, restarts `lang-tutor.service`, and smoke-tests both `/lang-tutor` and `/lang-tutor/`. It also verifies hosted auth is required before account-specific endpoints are reachable, ensures the host has the checker/LSP binaries, and (re)builds the hosted `lang-tutor-toolchains:latest` Docker image. New-host bootstrap: `docs/deployment.md` records the one-time Node / Docker / Caddy / systemd / app-user / runtime-env setup.

Useful flags: `-DeployHost <ssh-target>`, `-DeployUrl <url>`, `-SkipCheck`, `-SkipPush`, `-SkipSmoke`, `-Worktree`.

## Styling

Tailwind v4 utilities for layout, plus component classes in `src/style.css` (`.btn`, `.input-base`, `.subtab`, `.msg-you`, `.msg-ai`, `.code-fence`, `.inline-code`, `.topic-dot`, `.note-pill`, `.resize-bar`, `.bdr*`). Design tokens are CSS custom properties in `@theme` (light defaults) with a `prefers-color-scheme: dark` override on `:root`. Editor syntax colors live in matching `--syn-*` tokens (light + dark) and are referenced from CodeMirror's `HighlightStyle` via `var(...)`.

## Gotchas

- `extractionQueued` is a single-flight guard within a page-load. Concurrent `evaluateCode()` calls within one language won't double-extract. After-language-switch results are dropped via the `langWhenStarted` check.
- `history` is sliced to the last `MAX_HISTORY` (30) entries on every persist; older context is gone from `localStorage` but may still be in memory for the current session until reload.
- Refreshing the page restores the last active language and its full visible history.
- The Reset button wipes only the **active** language's history, progress, and either code (single-buffer) or the user's workspace folder (project workspaces, via `POST /proj/reset` — confirmation dialog calls out the destructive on-disk delete). Switch language first if you want to reset a different one.
- Project workspace gotcha: shared header DOM elements (`#projRunBtn`, `#projReloadBtn`, `#projOpenExternalBtn`) survive language switches. Both `createWebVitePreview` and `createDesktopPreview` register click handlers via an `AbortController`; `destroy()` calls `ctrl.abort()` so switching between csharp and web doesn't accumulate handlers and fire the wrong runtime's startProject on Run.
- C# build-phase pill (`spawning…` → `restoring NuGet…` → `building…` → `running`) is derived from regex matches on `dotnet --verbosity minimal`'s stdout. Phase only ever advances forward within a Run cycle. System-stream lines (the supervisor's own pushLog markers) are skipped so a literal "Restored" in our banner can't flip phases.
- `dotnet run` defaults to `quiet` verbosity under non-TTY stdout — meaning *no* output until exit. The csharp dev command in PROJECT_CONFIG explicitly passes `--verbosity minimal` to get the build milestones above.
- `.env` is gitignored. It holds runtime knobs only — provider keys are browser-side and must never appear in `.env`.
- The output pane height is controlled by `outputPre.style.flex = "0 0 Npx"` set by the resize handle drag (clamped 60–500 px).
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- `noUncheckedIndexedAccess` is on — array indexing yields `T | undefined`. Code uses `?? ''` and explicit checks rather than `!`.
- DOM mutation never uses `innerHTML` with dynamic strings (XSS-safe). Assistant markdown goes through `marked` → DOMPurify (`src/render.ts`); the progress tab, start screen, and other UI is built with `document.createElement` plus helpers in `main.ts`.
- LSP availability is per-server: a `web` session may have tsserver up but biome missing — diagnostics arrive only from the servers that actually started. The `/lsp/spawn` response's `unavailable` list tells the UI which to hide.
- The screenshot block on Send-to-tutor is best-effort: `html-to-image` skips canvas/video/backdrop-filter; WGC capture can fail if the window hasn't appeared yet. Both report `(capture failed …)` cleanly so the rest of the bundle still makes it to the model.
- DASM auto-refresh: editing the C++ file kicks off a debounced disassembly run unless `suppressDasmAutoRun` is set during a language switch (avoids spurious runs on `loadLanguageState`).
- Workspaces are user-scoped — every `/fs/*` and `/proj/*` call requires a session (or an unauthenticated local dev fallback when `LANG_TUTOR_REQUIRE_AUTH=false`). A hosted login is needed before the project tree shows anything.
