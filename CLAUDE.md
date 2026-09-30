# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, multi-language programming tutor (Rust, C++, DASM, Python, PowerShell, C#, Web). Two workspace shapes:

- **Single-buffer** (`rust` / `cpp` / `dasm` / `python` / `powershell`): one editor, one Run, one output pane. Code runs in the local Docker sandbox image (`lang-tutor-toolchains:latest`).
- **Project workspace** (`csharp` / `web`): on-disk project with sidebar file tree, multi-tab editor, Run / Send controls above the code, supervisor that runs `dotnet run` / `pnpm dev`, and an Output / preview pane. Run/Stop wired to the supervisor; logs streamed via SSE.

The user chats with their selected AI provider (Anthropic Claude, OpenAI ChatGPT, or Google Gemini) directly from the browser using their own API key. They write code, run it, and click "Send to tutor" to submit a structured bundle (note + code + output + LSP diagnostics, plus DOM/console/server logs for project workspaces, plus a screenshot of the WPF window or rendered iframe). Lesson progress is extracted by a second LLM call into structured JSON and persisted independently per language. A shared learner profile is also extracted and mirrored across languages so tutors can reuse stable background, goals, preferences, and learning trends. Switching language is non-destructive — each language has its own conversation history, lesson progress, and saved editor / tab state.

`localStorage` is mirrored to `.local/state/local-storage.json` (or to the signed-in account's SQLite row when hosted) via the local `/state/local-storage` endpoint. This keeps progress portable across dev-server origins such as `localhost`, `127.0.0.1`, LAN IPs, and port changes. Provider API keys are explicitly excluded from the mirror.

## Stack

- **TypeScript** (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlight, autocomplete, search, lint, multi-cursor, fold gutter), driven by real LSP diagnostics for inline errors
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin (config-in-CSS via `@theme`)
- **Docker Desktop** for the local sandbox image used by Rust / C++ / DASM / Python / PowerShell / C# console runs
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20.6+** runtime for the production server (`server.mjs`) and the local `/run` + `/check` + `/format` + `/lsp` + `/proj` + `/fs` + `/state` + `/auth` endpoints
- **chokidar** for filesystem watch on project workspaces (SSE-broadcast tree-change events)
- **ws** for WebSocket transport of LSP JSON-RPC traffic
- **@node-rs/argon2** + `cookie` for account hashing and session cookies (httpOnly + CSRF)
- **dompurify** + **marked** for XSS-safe markdown rendering of assistant messages
- **html-to-image** for rasterising the web preview iframe into a PNG vision block
- Optional local toolchains (auto-detected; features silently disable if missing):
  - Single-buffer host tools: `rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`, `pwsh`
  - Project: `dotnet` (.NET 8+ SDK), `pnpm`, `code` / `devenv` / `explorer.exe` for the "Open in" launchers
  - LSP binaries: machine-level `clangd`, `rust-analyzer` (rustup component) and Roslyn LSP (discovered from the C# Dev Kit install, OmniSharp as fallback); project devDependencies `typescript-language-server`, `vscode-langservers-extracted` (html + css), `basedpyright` (`basedpyright-langserver`), `@biomejs/biome`. `tools/lsp.mjs` resolves `node_modules/.bin` before PATH.
  - `.\lt.ps1 doctor` (`scripts/doctor.mjs`) lists every one of these as ready or missing, built from `LSP_CONFIG` and `CHECKER_TOOLS` so a new server or checker is reported automatically; each probe runs the tool (a rustup proxy for an uninstalled component exits non-zero and counts as missing). `.\lt.ps1 setup` installs what doctor reports missing by each row's `recipe`.

## Run

```powershell
.\lt.ps1 setup              # first time: install everything missing, then print the readiness report
.\lt.ps1 doctor [--json]    # readiness report only (exit 1 when anything is missing)
.\lt.ps1 dev                # Vite dev server (default port 5173)
.\lt.ps1 launch             # on-demand background run: build if stale, start Docker Desktop, serve on :3000, open browser
.\lt.ps1 stop [-Docker]     # stop what launch started (whole process tree); -Docker also quits Docker Desktop
.\lt.ps1 status             # launched app + Docker engine state
.\lt.ps1 build              # type-check + Vite build to dist/
.\lt.ps1 serve              # node --env-file=.env server.mjs in the foreground (default port 3000)
.\lt.ps1 preview            # vite preview (preview the production build)
.\lt.ps1 typecheck          # tsc --noEmit
.\lt.ps1 lint               # biome check --write .
pnpm test                   # vitest run (src/, tools/, scripts/ *.test.*)
.\lt.ps1 toolchain          # build lang-tutor-toolchains:latest for /run
```

`.env` holds **runtime config** only — provider API keys are entered in the browser via the AI Provider dialog and persist to `localStorage`. The interesting env vars are in `.env.example`: `PORT`, `LANG_TUTOR_BASE_PATH`, `LANG_TUTOR_REQUIRE_AUTH`, `LANG_TUTOR_SECURE_COOKIES`, `LANG_TUTOR_DB_FILE`, `LANG_TUTOR_RUN_ROOT`, `LANG_TUTOR_TOOLCHAIN_IMAGE`. Auth is off by default (`LANG_TUTOR_REQUIRE_AUTH` unset or `false`); `true` requires accounts.

**Windows Ctrl+C tip:** `pnpm dev` / `pnpm serve` go through a `.cmd` wrapper, so Ctrl+C triggers *"Terminate batch job (Y/N)?"*. Use `.\lt.ps1 dev` and `.\lt.ps1 serve` — they invoke Node directly and Ctrl+C kills cleanly.

**Slow-command output:** capture builds, test runs, and Vite/dotnet logs to `.tmp/` (gitignored, project-root) instead of re-running. `cmd 2>&1 | tee .tmp/output.log` then Read/Grep the file.

## Architecture

The architecture entry point is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): Task Index, layers, integration footguns, test locations and the deep docs.

## Rules

- Every backend `fetch`, `WebSocket` and `EventSource` URL goes through `appUrl()` / `appWsUrl()` (`src/appUrls.ts`), which prepend Vite's `BASE_URL`; a bare path breaks hosting under a sub-path.
- New `localStorage` keys go through the key helpers in `src/constants.ts` (`lang-tutor:{lang}:<name>` for per-language state, e.g. `historyKey(lang)`); only the learner profile and provider settings are global.
- Async work that can outlive a language switch (provider calls, code runs, memory extraction, screenshot capture) captures `langWhenStarted = activeLang` at start and drops its result if the language changed.
- Rebuild the system prompt only through `refreshSystemPrompt()` in `src/main.ts` (load, language switch, session start, Profile edit), never after each extraction, so the provider's prompt cache holds across turns.
- Every workspace path from a request goes through `safeResolve` in `tools/projects.mjs`, which rejects a path that escapes the project root.
- Leave `NODE_ENV` unset on Windows: `production` moves the default workspace root to `/var/lib/lang-tutor/workspaces` (`tools/projects.mjs`) and turns on secure cookies by default (`tools/auth-routes.mjs`).

## Running on demand

The app runs natively on the Windows PC; there is no hosted deployment (a WPF window needs a real desktop session, which rules out containers). `.\lt.ps1 launch` starts `server.mjs` hidden via `Start-Process`, logs to `.tmp/serve.log` / `.tmp/serve.err.log`, and records `{ pid, port, startTicks }` in `.tmp/serve.pid.json`; the start ticks guard against stopping a reused pid. `.\lt.ps1 stop` uses `taskkill /T /F`, because a forced kill on Windows skips `server.mjs`'s SIGINT/SIGTERM cleanup, so the whole tree has to go. `launch` rebuilds `dist/` only when `src/`, `public/` (minus the generated `lang-tutor-assets/`), `index.html`, `vite.config.ts`, `package.json` or `pnpm-lock.yaml` is newer than `dist/index.html`, starts Docker Desktop via `docker desktop start` when `docker info` fails, and builds the toolchain image when it is missing.

## Styling

Tailwind v4 utilities for layout, plus component classes in `src/style.css` (`.btn`, `.input-base`, `.subtab`, `.msg-you`, `.msg-ai`, `.code-fence`, `.inline-code`, `.topic-dot`, `.note-pill`, `.resize-bar`, `.bdr*`). Design tokens are CSS custom properties in `@theme` (light defaults) with a `prefers-color-scheme: dark` override on `:root`. Editor syntax colors live in matching `--syn-*` tokens (light + dark) and are referenced from CodeMirror's `HighlightStyle` via `var(...)`.

## Gotchas

- `extractMemory()` runs one extraction at a time; a request during a run sets `rerunRequested` for one trailing rerun. Progress from a run that outlived a language switch is dropped via the `langWhenStarted` check; its profile delta still applies.
- **Edit & resend** (rewind): each user message can be edited and resent; on send, it and every later message leave `history`, and a Send-to-tutor bundle is re-captured fresh from the current editor with the input as its note. Each user message stores `progressBefore` (the language's progress snapshot at send time), restored on rewind; the learner profile is not rolled back. Undo lasts until the next send or a language switch. `progressBefore` never reaches a provider: every request maps messages to `role` + `content` only. A `historyGeneration` counter drops progress from an extraction that started before a rewind. History is persisted only after a successful reply, so a failed resend leaves the rewound history on disk.
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
