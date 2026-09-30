# Lang tutor — architecture

A single-page, multi-language programming tutor: the browser talks to the learner's own AI provider directly, and a local Node backend supplies code execution, project supervision, language servers and state mirroring. Two layers: the TypeScript frontend (`src/`) and the Node backend (`tools/`, `server.mjs`, mounted by the Vite dev plugin in `vite.config.ts`), plus setup tooling (`scripts/`, `lt.ps1`). The rule that shapes it: provider API keys live only in browser `localStorage` and never reach the backend; per-language state (history, progress, code) is namespaced by `LanguageId`, while the learner profile is the one global. Terms used in a project sense are in the glossary in `README.md`.

## Task Index

| Task | Files, in order | Deep doc |
|---|---|---|
| Add a language (single-buffer or project) | `src/types.ts` (`LanguageId`) → `src/constants.ts` (`LANGUAGE_IDS`, `LANGUAGES`) → `index.html` → `src/editor.ts` (`langExtension`) → `tools/runner.mjs` (`LANG_CONFIG`) → `tools/checker.mjs` → `tools/lsp.mjs` → `tools/projects.mjs` (`PROJECT_CONFIG`) | `.claude/skills/add-language/SKILL.md` |
| Change a lesson plan or tutor system prompt | `src/constants.ts` → `buildSystem` in `src/main.ts` → `.claude/agents/tutor-prompt-reviewer.md` | none |
| Change what Send to tutor bundles (`[CODE]`, `[OUTPUT]`, `[LSP]`, `[FILES]`, `[DOM]`) | `evaluateCode` / `evaluateProjectCode` in `src/main.ts` → the matching prompt text in `src/constants.ts` | none |
| Change learner memory or progress merging | `src/learnerMemory.ts` → `fetchMemoryExtraction` in `src/api.ts` → `extractMemory` in `src/main.ts` → `src/learnerMemory.test.ts` | [`plans/learner-memory.md`](plans/learner-memory.md) |
| Change AI provider or Auto model resolution | `src/providerSettings.ts` → `src/modelResolution.ts` → `src/api.ts` → `src/modelResolution.test.ts` | none |
| Change edit & resend (conversation rewind) | `src/rewind.ts` → chat handlers in `src/main.ts` → `src/rewind.test.ts` | none |
| Add or change a language server | `LSP_CONFIG` and `LANG_SERVERS` in `tools/lsp.mjs` → `LSP_LANGUAGE_IDS` in `src/lspClient.ts` → `src/lspEditor.ts` → `scripts/doctor.mjs` | [`lsp.md`](lsp.md) |
| Change project workspace run, scaffold or logs | `PROJECT_CONFIG` and `ensureScaffold` in `tools/projects.mjs` → `tools/project-routes.mjs` → `src/projectApi.ts` → `src/projectPreview.ts` | `.claude/skills/debug-supervisor/SKILL.md` |
| Change the single-buffer sandbox run | `src/runners.ts` → `tools/runner.mjs` → `docker/toolchains/Dockerfile` | none |
| Change editor behaviour (keys, completion, lint) | `src/editor.ts` (single buffer) or `src/projectEditor.ts` (project) → `src/editorKeys.ts` → `src/lspEditor.ts` → `src/editorKeys.test.ts` | none |
| Change the Output / Error list | `src/outputProblems.ts` → `src/editor.ts` → the Error list code in `src/main.ts` → `src/outputProblems.test.ts` | none |
| Change accounts or the localStorage mirror | `tools/auth-routes.mjs` → `tools/account-store.mjs` → `tools/app-state.mjs` → `src/authClient.ts` → `src/storage.ts` | none |
| Change setup, doctor or on-demand launch | `scripts/doctor.mjs` → `scripts/setup.ps1` → `lt.ps1` → `scripts/doctor.test.mjs` | none |
| Add a tool-run endpoint | `tools/<module>.mjs` → mount in both `server.mjs` and `toolchainPlugin` in `vite.config.ts` | none |

## Layers

- **`src/`** (frontend, one Vite bundle): owns UI state, the two LLM call sites, editor wiring and per-language state. Entry is `src/main.ts`. Pure, unit-tested logic is split out: `src/learnerMemory.ts`, `src/modelResolution.ts`, `src/rewind.ts`, `src/outputProblems.ts`, `src/editorKeys.ts`. Reaches the backend only through `src/runners.ts`, `src/lint.ts`, `src/projectApi.ts`, `src/lspClient.ts`, `src/authClient.ts` and `src/storage.ts`; calls providers directly from `src/api.ts`. Assistant markdown is rendered only through `src/render.ts` (`marked` then DOMPurify); DOM mutation never uses raw-HTML sinks with dynamic strings (`.claude/agents/xss-invariant-auditor.md` audits this).
- **`tools/`** (backend modules, plain `.mjs`): `runner.mjs` (Docker sandbox runs), `checker.mjs` (host-tool `/check` and `/format`), `projects.mjs` and `project-routes.mjs` (project supervisor, `/fs`, `/proj`), `lsp.mjs` (LSP stdio-to-WebSocket bridge), `auth-routes.mjs` and `account-store.mjs` (accounts), `app-state.mjs` (state mirror), `http.mjs` (shared helpers). Every spawn uses the array form with hardcoded argv; user code travels via stdin or files, never argv. `shell: true` is set only on Windows (`IS_WIN`), to resolve `.cmd` shims.
- **`tools/wgc-capture/`** (C# console project, `wgc-capture.csproj`): Windows Graphics Capture helper that PNG-rasterises a process window for the WPF screenshot. Built on demand by `tools/projects.mjs`; `lang-tutor.sln` at the root is separate.
- **`server.mjs`**: production server that serves `dist/` and mounts the same `tools/` handlers as the dev plugin; `stripBasePath` removes the `LANG_TUTOR_BASE_PATH` prefix so the app can be hosted under a sub-path.
- **`vite.config.ts`**: `toolchainPlugin` mounts every `tools/` module as dev middleware and hooks the `/lsp` and `/fs` WebSocket upgrades.
- **`scripts/`, `lt.ps1`**: setup, doctor and launch. `scripts/doctor.mjs` is built from `LSP_CONFIG`, `LANG_SERVERS` and `CHECKER_TOOLS`, so it imports from `tools/` and nothing imports it.
- **`docker/toolchains/`**: the `lang-tutor-toolchains:latest` sandbox image, built by `scripts/build-toolchain-image.ps1`.
- **`.local/`** (gitignored): per-user project workspaces (`.local/workspaces/<scope>/<scaffoldDir>/`, scope `local` when auth is off), the state mirror (`.local/state/local-storage.json`) and the sql.js account database (`.local/account.sqlite`, `LANG_TUTOR_DB_FILE`). Scaffold templates are the inline `SCAFFOLDS` in `tools/projects.mjs`.

Flows across the layers:

- **Language model**: `Language` (`src/types.ts`) is `SingleBufferLanguage` (`kind: 'single'`: rust, cpp, dasm, python; one editor, runs through `/run`) or `ProjectLanguage` (`kind: 'project'`: csharp, web; on-disk workspace, multi-tab editor, supervised process). A project's `runtime.kind` (`web-vite` or `desktop-process`) picks `createWebVitePreview` or `createDesktopPreview` in `src/projectPreview.ts`, the branch in `evaluateProjectCode`, and the `PROJECT_CONFIG` readiness probe (`http-probe` or `process-alive`). DASM compiles the C++ buffer and returns an `objdump` excerpt of the user's symbols (`docker/toolchains/run-code.sh`); its compiler flags are allowlisted by `DASM_ALLOWED_FLAGS` in `tools/runner.mjs`.
- **Sandbox runs**: `tools/runner.mjs` writes the code into `.tmp/runs/` (`LANG_TUTOR_RUN_ROOT`) and runs the toolchain image with no network, a read-only root, dropped capabilities, `no-new-privileges` and CPU, memory and process limits. C# console snippets use the same `/run` path with `lang: 'csharp'`.
- **LLM calls**: `callClaude` (streamed chat) and `fetchMemoryExtraction` (once per turn, via `extractMemory`) go from the browser straight to the provider. The system prompt comes from `buildSystem` in `src/main.ts`; Auto (a saved model of `''`) is resolved in the app from the provider's cached live model list, with `FALLBACK_MODELS` when the list is missing.
- **Send to tutor**: `evaluateCode` / `evaluateProjectCode` build a marker-tagged bundle sent through the normal chat path. The web screenshot is rasterised inside the iframe by `html-to-image`; the WPF screenshot comes from `POST /proj/screenshot` through `tools/wgc-capture/`. A failed capture becomes a `[SCREENSHOT]` note, so the text bundle still goes out.
- **Browser state**: `localStorage` keys are per language (`lang-tutor:{lang}:<name>`, built by helpers such as `historyKey` in `src/constants.ts`); `LEARNER_PROFILE_KEY` and the provider settings are global. `hydrateStorageFromDisk` (`src/storage.ts`) runs at init right after auth (and again after sign-in), before any language state loads, and overlays the `/state/local-storage` mirror, so progress survives an origin or port change.
- **Project workspaces**: `tools/projects.mjs` supervises one process per user and language. The web preview iframe loads through the same-origin proxy `/proj/preview/<lang>/`; logs stream over SSE on `/proj/logs` and chokidar tree changes over `/fs/watch`. SIGINT and SIGTERM handlers kill every supervised process tree, so children die with the server.
- **LSP**: `connectLsp` (`src/lspClient.ts`) posts `/lsp/spawn`, gets one session per server (web fans out to typescript-language-server, html, css and biome), opens one WebSocket per session on `/lsp?session=<id>` and merges diagnostics per URI; `src/lspEditor.ts` bridges it to CodeMirror. The `/check` and `/format` host-tool path in `src/lint.ts` is the fallback when no server is up. Servers that fail to start come back in the spawn response's `unavailable` list.
- **Endpoints to modules**: `/run` → `runner.mjs`; `/check`, `/format` → `checker.mjs`; `/lsp*` → `lsp.mjs`; `/fs/*`, `/proj/*` → `project-routes.mjs`; `/state/local-storage` → `app-state.mjs`; `/api/auth/*` → `auth-routes.mjs` (gated by `LANG_TUTOR_REQUIRE_AUTH`, CSRF double-submit).

## Integration Footguns

- **Add a `LanguageId`** → also extend `LANGUAGE_IDS` (`src/constants.ts`), `LSP_LANGUAGE_IDS` (`src/lspClient.ts`), `langExtension` (`src/editor.ts`, single-buffer only), `LANG_CONFIG` (`tools/runner.mjs`), the `checker.mjs` switch, `LANG_SERVERS` (`tools/lsp.mjs`) and `PROJECT_CONFIG` plus `SCAFFOLDS` (`tools/projects.mjs`, project languages); the union and the array are separate declarations and only `tsc` catches some of the misses.
- **Add a language server or checker** → list it in `LSP_CONFIG` / `CHECKER_TOOLS`; `scripts/doctor.test.mjs` fails if doctor has no row for a key.
- **Change the Send-to-tutor bundle markers** → also change the `systemPromptIntro` text in `src/constants.ts`; nothing enforces the match except `.claude/agents/tutor-prompt-reviewer.md`.
- **Change the provider-key exclusion** → `SENSITIVE_KEYS` is declared twice, in `src/storage.ts` and `tools/app-state.mjs`; both must list `lang-tutor:provider-settings` or a key reaches the server mirror.
- **Edit a supervised or LSP module under Vite HMR** → running children survive only through the `globalThis` stashes (`__langTutorProcs` in `tools/projects.mjs`; `__langTutorLsps` and friends in `tools/lsp.mjs`); a new module-level `Map` for processes orphans them.
- **Change the learner profile shape** → bump the version and extend the migration in `src/learnerMemory.ts`; the model only proposes deltas, code merges them (`src/learnerMemory.test.ts`).
- **Add an endpoint** → mount it in both `server.mjs` and `toolchainPlugin`; the two are hand-kept in parallel.

## Test locations

Vitest (`pnpm test`) runs `*.test.*` under `src/`, `tools/` and `scripts/`; there is no separate test project.

- `src/*.test.ts`: the pure frontend modules (`learnerMemory`, `modelResolution`, `rewind`, `outputProblems`, `editorKeys`, `lspEditor`).
- `tools/lsp.test.mjs`: local binary resolution and version-probe classification for the LSP bridge.
- `scripts/doctor.test.mjs`: doctor covers every `LSP_CONFIG` key and `CHECKER_TOOLS` entry.
- A new test goes beside its module as `<module>.test.ts` or `.test.mjs`. `main.ts`, `runners.ts`, `tools/projects.mjs` and `tools/runner.mjs` have no unit tests; they are checked by hand under `.\lt.ps1 dev` or `launch`.

## Deep docs

- [`lsp.md`](lsp.md): LSP bridge decisions, per-server caveats, URI and drive-letter traps.
- [`plans/MAIN.md`](plans/MAIN.md): plan index, waves and open items.
- [`plans/learner-memory.md`](plans/learner-memory.md): learner memory design (data model, merge rules, combined extraction).
- [`../CLAUDE.md`](../CLAUDE.md): run commands, coding rules and gotchas.
