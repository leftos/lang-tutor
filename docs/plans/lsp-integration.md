# LSP Integration Plan — clangd + 4 more

## Goal

Replace the current one-shot `spawn(compiler …)` lint pipeline with a long-lived LSP bridge that serves both the editor (autocomplete, hover, signature help, inlay hints, fix-its) and the tutor (structured semantic snapshots in `evaluateCode`).

## Architecture: one bridge, many backends

Single bridge module, one LSP child per `(lang, sessionId)` pair. Frontend speaks LSP-over-WebSocket; backend proxies to clangd / rust-analyzer / basedpyright / Roslyn / tsserver.

```
Browser (CodeMirror)
  └── codemirror-languageserver client (per editor instance)
       └── WebSocket /lsp/<lang>/<sessionId>
              ↑
              ↓  (JSON-RPC framed over WS)
Node (server.mjs / vite middleware)
  └── tools/lsp.mjs
       ├── spawn manager (one child per (lang, sessionId))
       ├── workspace materializer (ephemeral root per session)
       └── per-lang config table (binary, args, root-uri rules, capabilities)
              ↓
       clangd | rust-analyzer | basedpyright | Microsoft.CodeAnalysis.LanguageServer | typescript-language-server | biome lsp-proxy
```

**Why one bridge:** LSP is standard. Per-lang differences (binary, args, root-marker file, init options) collapse into a config table.

**Workspace materializer:** LSPs need a directory.
- Single-buffer (`rust`/`cpp`/`python`): create `.tmp/lsp/<sessionId>/main.<ext>` plus a minimal manifest (`Cargo.toml` for Rust, `pyproject.toml` for Python, nothing for clang). Sync on every CodeMirror change via `textDocument/didChange`.
- Project workspaces (`csharp`/`web`): point root-uri at `projects/<lang>/`. The dev server already manages files there — LSP just observes.

## The bridge — `tools/lsp.mjs`

- [ ] `POST /lsp/spawn` body `{ lang }` → `{ sessionId, capabilities }` — creates session, scaffolds workspace, spawns LSP child, returns server capabilities for the client to negotiate features
- [ ] `GET /lsp/<sessionId>` — WebSocket upgrade; pipes JSON-RPC bidirectionally. Frame using LSP's `Content-Length:` headers on the stdio side, plain JSON messages on the WS side.
- [ ] `POST /lsp/dispose` body `{ sessionId }` — graceful `shutdown` + `exit` request, reap child
- [ ] Per-lang `LSP_CONFIG` table (binary, args, init-options, root-marker)
- [ ] HMR-orphan guard via `globalThis['__langTutorLsps']` (mirror the `__langTutorProcs` pattern in `tools/projects.mjs`)
- [ ] Process-exit / SIGINT handlers to terminate all children
- [ ] `available()` probe — same fail-soft semantics as today (`{ available: false }` so frontend silently falls back to current `clang -fsyntax-only` path)
- [ ] Output cap + idle timeout (kill servers after N min of no traffic)

## Frontend — `src/lspClient.ts`

- [ ] Thin wrapper around `codemirror-languageserver` (community lib) OR hand-rolled JSON-RPC if it doesn't fit. Hand-rolled is ~300 LOC; the lib saves time but pins us to its API quirks.
- [ ] Reuse `Compartment` pattern from `editor.ts` for the LSP extension
- [ ] Replace `linter()` source for the languages we wire up; keep current `fetchDiagnostics` as fallback when LSP is unavailable
- [ ] Wire `Mod-S` to LSP `textDocument/formatting` (currently calls `/format`)
- [ ] Wire hover, completion, signature help, inlay hints, code actions

## Per-language backends

### C++ — `clangd`
- [ ] Workspace: `.tmp/lsp/<sid>/main.cpp` + a minimal `compile_flags.txt` (`-std=c++23 -Wall`)
- [ ] No `compile_commands.json` needed for single-file
- [ ] **Install:** `winget install LLVM.LLVM` (already in setup.ps1 per the merge commit `49eede5`)

### Rust — `rust-analyzer`
- [ ] Workspace: `.tmp/lsp/<sid>/Cargo.toml` (bin crate) + `src/main.rs`
- [ ] Init option `cargo.allTargets=false`, `checkOnSave.command="check"` (faster than `clippy` on stdlib lessons)
- [ ] **Install:** `rustup component add rust-analyzer`

### Python — `basedpyright`
- [ ] Workspace: `.tmp/lsp/<sid>/main.py` + `pyrightconfig.json` with `pythonVersion = "3.13"`, `typeCheckingMode = "standard"`
- [ ] Install hint: `pip install basedpyright`
- [ ] Note: linting now flags type errors — far stronger tutor signal than current `ast.parse`

### C# — Microsoft.CodeAnalysis.LanguageServer (Roslyn LSP)
- [ ] Workspace: existing `projects/csharp/` (no scaffolding — supervisor already owns it)
- [ ] Binary ships in dotnet SDK; locate via `dotnet --list-sdks` then path into `Microsoft.CodeAnalysis.LanguageServer/<ver>/`
- [ ] Multi-file (project workspace) — wire to `projectEditor.ts` per-tab, not single-buffer
- [ ] Roslyn LSP needs `--logLevel`, `--extensionLogDirectory`, `--starredCompletionsPath` flags — config-table material

### Web — TypeScript LS + HTML LS + CSS LS + Biome + Vite-plugin-checker
- [ ] **Editor LSPs (per-tab dispatch by file extension in `projectEditor.ts`):**
  - `typescript-language-server --stdio` for `.ts`/`.tsx`/`.js`
  - `vscode-html-language-server --stdio` for `.html`
  - `vscode-css-language-server --stdio` for `.css`
  - `biome lsp-proxy` runs alongside TS LS for fast linting/formatting
- [ ] **Vite-side build/type signals (the "include Vite" piece):**
  - Add `vite-plugin-checker` to `projects/web/` scaffold, configured to run `tsc --noEmit` + `biome check` in a worker
  - Errors surface in Vite's HMR overlay AND get pushed to stderr → already captured by `tools/projects.mjs` log buffer → flows into the existing `[SERVER]` block in `evaluateProjectCode`
  - Net effect: the tutor sees TS type errors and lint violations *as part of the build*, in addition to runtime DOM/console signals
- [ ] **Iframe overlay capture:** also extend the `postMessage` snapshot to include Vite's HMR error-overlay DOM if present, so the tutor sees the user-visible error UI verbatim

## Tutor-side integration — `[LSP]` block

- [ ] In `evaluateCode` (single-buffer) and `evaluateProjectCode` (project), if an LSP session is alive, request a snapshot:
  - All current diagnostics (`textDocument/publishDiagnostics` from the latest push)
  - Symbol map (top-level decls in current file)
  - For symbol under cursor: hover info + signature
- [ ] Append as a fenced `[LSP]` block in the user message Claude sees:
  ```
  [LSP]
  diagnostics:
    main.cpp:14:8 error: no member named 'value' in 'std::vector<int>::iterator'
    main.cpp:14:8 fix-it: replace '.value' with '*'
  hovering symbol: it (std::vector<int>::iterator)
  ```
- [ ] Update each language's system prompt to mention the `[LSP]` block format and instruct the model to lead with concrete LSP-reported errors before generic guidance

## setup.ps1 additions

- [ ] LLVM/clangd — extend the existing `winget install LLVM.LLVM` block to verify clangd is on PATH, not just clang
- [ ] rust-analyzer — `rustup component add rust-analyzer` (idempotent)
- [ ] basedpyright — `pip install --user basedpyright` (gated on Python being present)
- [ ] Roslyn LSP — already bundled with .NET 8 SDK; verify path resolution on first run
- [ ] TypeScript LS — `pnpm add -g typescript typescript-language-server vscode-langservers-extracted` (the latter packages HTML/CSS/JSON/ESLint LSPs)
- [ ] Biome — already in repo via pnpm
- [ ] Each install is wrapped in a try/skip so missing tools don't break setup; runtime fall-soft semantics handle the rest

## Phasing

1. [ ] **Phase 0 — bridge skeleton.** `tools/lsp.mjs`, WS upgrade, spawn manager, dispose, HMR guard. No language wired yet — ship with a stub that echoes JSON-RPC for unit testing.
2. [ ] **Phase 1 — C++ via clangd** (single-buffer; rails for everything else). Frontend `lspClient.ts`, `editor.ts` Compartment swap, `[LSP]` block in `evaluateCode`. Validates the architecture end-to-end.
3. [ ] **Phase 2 — Rust + Python.** Same shape as C++; only LSP_CONFIG entries + workspace manifests differ.
4. [ ] **Phase 3 — C# Roslyn.** First project-workspace integration; multi-file dispatch in `projectEditor.ts`. Wire the supervisor to share its file-watch with the LSP.
5. [ ] **Phase 4 — Web (TS + HTML + CSS + Biome).** Per-extension LSP dispatch. Vite-plugin-checker added to scaffold.
6. [ ] **Phase 5 — Polish.** Inlay hints, code actions, idle-timeout tuning, telemetry on LSP latency, fall-soft path verification.

## Risks / open decisions

- **codemirror-languageserver vs hand-rolled** — the lib is ~6k LOC and last-published 2 years ago; might be safer to fork or hand-roll the ~300 LOC we actually need.
- **Memory ceiling.** rust-analyzer can hit 500 MB on real crates; for our single-file lessons it'll be tens of MB, but multiple concurrent tabs in dev could add up. Mitigation: idle-timeout dispose.
- **Roslyn LSP path discovery** — undocumented and version-coupled. May need a small probe routine; expect breakage on .NET SDK upgrades.
- **Project workspace + LSP file-watch conflicts.** chokidar (supervisor) and the LSP both watch `projects/<lang>/`. Coordinating who's authoritative on file changes is fiddly; the simplest model is "supervisor owns the disk, LSP gets `didChange` from CodeMirror, ignore inotify". Need to verify Roslyn/tsserver tolerate this.
