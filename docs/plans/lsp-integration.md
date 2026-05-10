# LSP Integration

**Status as of 2026-05-10:** core integration shipped for all five languages.
Bridge, frontend client, editor wiring, `[LSP]` block, and per-language system
prompts are live. Outstanding work is a list of nice-to-haves at the bottom of
this doc — none are blocking.

This doc serves two purposes now:
1. A snapshot of what was built and how, so a fresh agent can pick up.
2. A residual-work checklist for the next pass.

## Goal

Replace the one-shot `spawn(compiler …)` lint pipeline with long-lived LSP
servers, fronting them through a single bridge so the editor gets autocomplete
/ hover / signature help / formatting AND the tutor gets structured semantic
diagnostics in `evaluateCode`.

## Architecture (shipped)

```
Browser (CodeMirror)
  └── src/lspClient.ts (hand-rolled JSON-RPC over WS)
       └── WebSocket /lsp?session=<id>
              ↑
              ↓  (raw JSON over WS, Content-Length-framed on stdio)
Node (server.mjs / vite middleware)
  └── tools/lsp.mjs
       ├── spawn manager (one child per (lang, sessionId))
       ├── workspace materializer (fresh ephemeral OR project mode)
       └── LSP_CONFIG table (binary, args, init-options, root-marker)
              ↓
       clangd | rust-analyzer | basedpyright-langserver | omnisharp | typescript-language-server
```

Two workspace modes:
- **fresh** (`cpp`/`rust`/`python`): bridge creates `.tmp/lsp/<sessionId>/`,
  seeds a main file + manifest (Cargo.toml / pyrightconfig.json /
  compile_flags.txt), kills the dir on session exit.
- **project** (`csharp`/`web`): bridge re-uses the existing `projects/<lang>/`
  directory (the dev-server supervisor already manages files there); never
  deletes it on session exit.

## The bridge — `tools/lsp.mjs` (shipped)

- [x] `POST /lsp/spawn` body `{ lang }` → `{ ok, sessionId, mainFileUri?, rootUri }`. (Capabilities are negotiated by the client itself in `initialize`, not returned here — that turned out to be the more idiomatic LSP shape.)
- [x] WebSocket on `GET /lsp?session=<id>` (path with query param, not path-segment-based — easier to route in Node `http.upgrade`).
- [x] `POST /lsp/dispose` body `{ sessionId }` — graceful `shutdown` + `exit`, plus `proc.stdin.end()` to silence libuv shutdown-asserts on Windows.
- [x] Per-lang `LSP_CONFIG` table.
- [x] HMR-orphan guard via `globalThis['__langTutorLsps']`, `__langTutorLspExitHookInstalled`, `__langTutorLspAvailability`, `__langTutorLspWss`.
- [x] Process-exit / SIGINT / SIGTERM handlers SIGKILL all children.
- [x] `available()` probe — fast PATH lookup via `where`/`which` + optional bounded `--version` fetch. Servers that don't support `--version` (OmniSharp starts the full server on it; basedpyright-langserver crashes without `--stdio`) report available via PATH alone.
- [x] Per-session idle timeout (10 min default) + 4 MB stdout buffer cap.
- [x] **Cross-server URI normalization** (added during smoke): basedpyright canonicalizes the Windows drive-letter colon as `%3A` while clangd / rust-analyzer keep it literal. `normalizeUri()` decodes `%3A` → `:` so diagnostics key consistently regardless of encoder.
- [x] **Disk-sync for flycheck-style servers**: `LSP_CONFIG.<lang>.syncToDisk = true` makes the bridge intercept `didOpen` / `didChange`, debounce 500 ms, and write the buffer to the URI's on-disk path. Used by rust because `cargo check` reads the file from disk. Defended against path-traversal by case-insensitive workspace-containment check.

## Frontend — `src/lspClient.ts` + `src/lspEditor.ts` (shipped)

- [x] Hand-rolled JSON-RPC 2.0 client (skipped the `codemirror-languageserver` lib — stale upstream, didn't fit our compartment pattern).
- [x] `LspClient` is dual-API: single-buffer (`didOpen` / `didChange` / `hover` etc.) wraps multi-file (`didOpenUri` / `didChangeUri` / `didCloseUri` / `hoverUri` etc.) using `mainFileUri`. Project workspaces use the multi-file API directly.
- [x] Reuses `Compartment` pattern from `editor.ts` for the LSP extension swap on language change.
- [x] When LSP connects, the polling `linter()` source is replaced with `[]` and diagnostics arrive via `setDiagnostics(state, …)` from the LSP listener instead. Polling-`/check` path remains as fall-soft.
- [x] `Mod-S` prefers LSP `textDocument/formatting`; falls back to `/format` when the server lacks `documentFormattingProvider`.
- [x] Hover and completion wired into editor.ts via `lspHoverExtension` / `lspCompletionExtension` (positional helpers in `lspEditor.ts`).
- [x] Mid-flight language switches guarded by `lspGeneration` counter so a slow `connectLsp` resolution can't paint diagnostics for a language the user already left.
- [x] Per-tab editor-gutter diagnostics for project workspaces via `client.onAnyDiagnostics`; tab switches re-paint cached diagnostics for the new active URI.

## Per-language backends

### C++ — `clangd` (shipped)

- [x] Workspace: `.tmp/lsp/<sid>/main.cpp` + `compile_flags.txt` (`-std=c++23 -Wall -Wextra`).
- [x] Install: `winget install LLVM.LLVM` already in `setup.ps1`; verifies `clangd` on PATH after install (extending the prior `clang` check).

### Rust — `rust-analyzer` (shipped)

- [x] Workspace: `.tmp/lsp/<sid>/Cargo.toml` (bin crate `lesson`) + `src/main.rs`.
- [x] **`syncToDisk: true`** — flycheck (cargo check) reads on-disk content, so the bridge debounces buffer writes to disk to keep rustc errors fresh.
- [x] Install: `setup.ps1` runs `rustup component add rust-analyzer` after the `Rustlang.Rustup` winget install.

### Python — `basedpyright` (shipped)

- [x] Workspace: `.tmp/lsp/<sid>/main.py` + `pyrightconfig.json` (`pythonVersion: 3.13`, `typeCheckingMode: standard`, `reportMissingImports: warning`).
- [x] `bin: 'basedpyright-langserver'`, `args: ['--stdio']`. The langserver crashes on `--version` so `probeBin: 'basedpyright'` (the sibling CLI) is used for the version probe.
- [x] Install: `pip install --user basedpyright` in `setup.ps1`.

### C# — `omnisharp -lsp` (shipped)

- [x] Workspace: existing `projects/csharp/` (project mode — supervisor owns it).
- [x] Multi-file: wired through `projectEditor.ts` per-tab via `LspClient.didOpenUri / didChangeUri / didCloseUri`.
- [x] **Roslyn LSP NOT used.** Original plan considered Microsoft.CodeAnalysis.LanguageServer; its install path is undocumented and version-coupled to the C# Dev Kit. OmniSharp ships as a single binary via Scoop / Choco / GitHub release — easier to recommend.
- [x] Install: `setup.ps1` logs install hints (scoop / choco / GitHub release) but does NOT auto-install. Fall-soft when missing.
- [x] `versionArgs: []` (and PATH-only probe) because `omnisharp --version` actually starts the full server with no quick exit.

### Web — `typescript-language-server` (shipped)

- [x] `bin: 'typescript-language-server'`, `args: ['--stdio']` in project mode rooted at `projects/web/`.
- [x] Wired through `projectEditor.ts` for files mapping to a known LSP languageId via `LSP_LANGUAGE_ID_BY_EXT`: `.cs / .ts / .tsx / .js / .jsx / .mjs / .cjs / .html / .css / .json`. Other extensions (xml, csproj, md) are not pushed to the LSP.
- [x] **Vite-plugin-checker in the scaffold**: `tools/projects.mjs` SCAFFOLD_WEB now seeds `vite.config.js`, `jsconfig.json` (with `checkJs: true` so plain `.js` files type-check), `biome.json`, and the matching devDependencies. Errors flow into Vite stderr → supervisor log buffer → `[SERVER]` block.
- [x] Install: `npm install -g typescript-language-server typescript` in `setup.ps1`. Windows `.cmd` shim handled via `shell: IS_WIN` on spawn (args are hardcoded constants — no injection vector).

## `[LSP]` block in user messages (shipped)

- [x] `evaluateCode` (single-buffer): `buildLspBlock()` in `src/main.ts` pulls `client.getDiagnostics()`, sorts errors → warnings → info → hint, caps at 30 lines, formats as `main:LINE:COL severity [code] — source: message`.
- [x] `evaluateProjectCode` (project): `buildProjectLspBlock()` walks `client.getDiagnosticsByUri()` across every URI the LSP has reported, basenames the file, same 30-line cap. URIs normalized.
- [x] System prompts updated for all five languages (cpp / rust / python / csharp / web) — each tells the model `[LSP]` is authoritative and to lead with the specific server-reported issues.

## `setup.ps1` (shipped)

- [x] LLVM/clangd verify (extends prior `clang` check)
- [x] `rustup component add rust-analyzer`
- [x] `pip install --user basedpyright`
- [x] OmniSharp: install hint only, no auto-install (no stable winget id)
- [x] `npm install -g typescript-language-server typescript`
- [x] Python winget id bumped to 3.13 (mid-flight ask, `Python.Python.3.13`)
- [x] Each install fail-softs to a warning; runtime fall-soft picks up the slack.

## Phasing — all merged to `main`

1. [x] **Phase 0** — bridge skeleton (`22cad82`)
2. [x] **Phase 1** — clangd / C++ + Python 3.13 (`0ac0307`)
3. [x] **Phase 2** — rust-analyzer + basedpyright (`94a1854`)
4. [x] **Phase 3** — OmniSharp via project workspace (`37c42ff`)
5. [x] **Phase 4** — typescript-language-server + vite-plugin-checker (`d8aa558`)
6. [x] **Phase 5 polish** — gutter diagnostics for project workspaces, fall-soft tightening, `proc.stdin.end()` (`bdbcefc`)

Plus follow-ups during smoke / Playwright verification:
- `f6f5ddb` — file tree on the right + all dividers resizable (mid-flight ask)
- `d8077e1` — `probeBin`, `whichBin`, `shell:true`, URI normalization (smoke fixes)
- `1a0f05e` — debounced disk-sync for rust (closes the flycheck buffer/disk gap)
- `a4bf65d` — gitignore `.playwright-mcp/`

## Smoke results

| lang | server | result |
|---|---|---|
| cpp | clangd 22.1.5 | PASS — `undeclared_var_use` |
| rust | rust-analyzer 1.92.0 | PASS — parse + `E0425 cannot find value` (after disk sync) |
| python | basedpyright 1.39.3 | PASS — `reportArgumentType` |
| web | typescript-language-server 5.2.0 | PASS — `TS2322` on `.js` via `checkJs` |
| csharp | OmniSharp 1.39.15 | handshake confirmed; ad-hoc-file diagnostics didn't fire in 120 s on cold start. Bridge architecture verified end-to-end; full diagnostic flow needs in-app testing. |

UI (Playwright): all four dividers resize and persist, file tree confirmed on
the right for both project workspaces, clangd connects via the dev server.

## Residual work — actionable handoff list

These items would each ship on their own; none are blocking.

- [ ] **`signatureHelp` wired into the editor.** `LspClient.signatureHelp()` already exists and works at the protocol level; `lspEditor.ts` just doesn't expose it via a CodeMirror tooltip extension. Trigger should be typing `(` (CompletionContext.matchBefore + a small request), display via the existing `tooltips` facet. Estimate: 1–2 hours, all in `lspEditor.ts`.
- [ ] **Inlay hints.** Highest tutor-value of the missing features — param names + deduced types make code much more legible to a learner. Needs a CodeMirror `WidgetType` decoration layer that requests `textDocument/inlayHint` over a viewport range and renders the result as inline widgets. Will cap at the current viewport to keep request volume sane. Estimate: a day.
- [ ] **Code actions / quickfix.** Each diagnostic from clangd / rust-analyzer / tsserver carries `data` with `codeAction`-resolvable fixes ("did you mean ⋯", "add missing `&`", "import X"). UI surface: lightbulb in the gutter on hover OR Mod-`.` keybind to open a popup. Estimate: 1–2 days for a basic flow.
- [ ] **HTML LS + CSS LS for the web project.** `vscode-html-language-server` and `vscode-css-language-server` (both shipped via the `vscode-langservers-extracted` npm package). Wire in `tools/lsp.mjs` as additional configs OR more-elegantly: a single `web` config that dispatches to the right LS by file extension. Affects `projectEditor.ts` (currently single-LSP-per-lang). Estimate: half a day.
- [ ] **Biome `lsp-proxy` alongside tsserver for web.** Faster lint-time feedback than vite-plugin-checker (which runs in a worker). Same multi-LSP-per-lang plumbing as HTML/CSS. Probably does not need a separate setup step — Biome is already in the web scaffold's devDependencies.
- [ ] **Roslyn LSP discovery as a C# alternative to OmniSharp.** Microsoft.CodeAnalysis.LanguageServer ships with the C# Dev Kit VS Code extension at `~/.vscode/extensions/ms-dotnettools.csdevkit-*/⋯/Microsoft.CodeAnalysis.LanguageServer.exe`. A discovery probe that prefers Roslyn-LSP-when-found and falls back to OmniSharp would give better C# 12 / .NET 8 fidelity. Risk: the path is undocumented and changes per VS Code extension release.
- [ ] **Iframe Vite HMR overlay capture in `evaluateProjectCode` for web.** Currently the iframe-bootstrap snapshot grabs `documentElement.outerHTML` + console. The HMR overlay (the red box Vite injects on build error) is in a sibling div outside the user's tree; `[CONSOLE]` / `[SERVER]` already cover the underlying error text but verbatim overlay capture would let the tutor see what the user sees. Estimate: 1–2 hours, all in the bootstrap script in `tools/projects.mjs`.
- [ ] **`[LSP]` block enrichment.** Today: diagnostics only. Original plan also wanted symbol map + hover-at-cursor for richer tutor context. Each piece is a small protocol request (`textDocument/documentSymbol`, `textDocument/hover` at last-known cursor) — main design call is what to include and at what cap. Estimate: half a day.
- [ ] **C# OmniSharp first-load timing.** The smoke caught that ad-hoc-file diagnostics don't fire within 120 s on first cold start. Investigation: send `workspace/didChangeWatchedFiles` after the file is created on disk, OR force a `csharp/v2/codestructure` request to nudge OmniSharp's workspace. Probably half a day of poking.

## Resolved risks (keep for context)

- ~~codemirror-languageserver lib stale~~ — went hand-rolled, ~600 LOC in `src/lspClient.ts` + `src/lspEditor.ts`, no upstream dependency.
- ~~rust-analyzer flycheck reads disk, not buffer~~ — closed by the `syncToDisk` debounced writer (`1a0f05e`).
- ~~Roslyn LSP path discovery undocumented~~ — sidestepped by shipping OmniSharp instead.
- ~~Project workspace + LSP file-watch conflicts~~ — supervisor owns the disk; LSP gets `didChange` from CodeMirror; chokidar's events are observers only.
- ~~Memory ceiling on rust-analyzer~~ — single-file lessons keep it to tens of MB; idle-timeout dispose handles concurrent-tab accumulation.

## Known caveats

- The libuv `UV_HANDLE_CLOSING` assertion still prints during smoke shutdown on Windows even after `proc.stdin.end()`. Benign — the test result line precedes it. If it's irksome, the next step is calling `proc.stdout.unpipe()` / `proc.stderr.unpipe()` before kill, or moving from `child_process.spawn` to `node-pty` for cleaner Windows teardown.
- Drive-letter case (Windows): URIs use lowercase (`file:///x:/...`), workspace dirs come back uppercase from `path.resolve`. The bridge case-insensitively normalizes for containment checks, but if you add new path comparisons elsewhere remember to match the convention.
