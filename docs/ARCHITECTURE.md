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
- **`tools/`** (backend modules, plain `.mjs`): `runner.mjs` (Docker sandbox runs), `checker.mjs` (host-tool `/check` and `/format`), `projects.mjs` and `project-routes.mjs` (project supervisor, `/fs`, `/proj`), `lsp.mjs` (LSP stdio-to-WebSocket bridge), `auth-routes.mjs` and `account-store.mjs` (accounts), `app-state.mjs` (state mirror), `http.mjs` (shared helpers). Every spawn uses the array form with hardcoded argv; user code travels via stdin or files, never argv.
- **`tools/wgc-capture/`** (C# console project, `wgc-capture.csproj`): Windows Graphics Capture helper that PNG-rasterises a process window for the WPF screenshot. Built on demand by `tools/projects.mjs`; `lang-tutor.sln` at the root is separate.
- **`server.mjs`**: production server that serves `dist/` and mounts the same `tools/` handlers as the dev plugin.
- **`vite.config.ts`**: `toolchainPlugin` mounts every `tools/` module as dev middleware and hooks the `/lsp` and `/fs` WebSocket upgrades.
- **`scripts/`, `lt.ps1`**: setup, doctor and launch. `scripts/doctor.mjs` is built from `LSP_CONFIG`, `LANG_SERVERS` and `CHECKER_TOOLS`, so it imports from `tools/` and nothing imports it.
- **`docker/toolchains/`**: the `lang-tutor-toolchains:latest` sandbox image, built by `scripts/build-toolchain-image.ps1`.
- **`projects/`** (gitignored, created on demand): scaffold templates and per-user workspaces; `.local/` holds the state mirror and account database.

## Integration Footguns

- **Add a `LanguageId`** → also extend `LANGUAGE_IDS` (`src/constants.ts`), `LSP_LANGUAGE_IDS` (`src/lspClient.ts`), `langExtension` (`src/editor.ts`, single-buffer only), `LANG_CONFIG` (`tools/runner.mjs`), the `checker.mjs` switch, `LANG_SERVERS` (`tools/lsp.mjs`) and `PROJECT_CONFIG` (`tools/projects.mjs`, project languages); the union and the array are separate declarations and only `tsc` catches some of the misses.
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
- [`../CLAUDE.md`](../CLAUDE.md): source layout, storage keys, endpoints, send-to-tutor flow and gotchas.
