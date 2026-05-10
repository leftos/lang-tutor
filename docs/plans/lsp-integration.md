# LSP Integration

**Status as of 2026-05-10:** core integration + the residual nice-to-haves
shipped for all five languages. Bridge, frontend client, editor wiring,
`[LSP]` block, signature help, inlay hints, code actions, multi-LSP fan-out
for web, HMR overlay capture, OmniSharp first-load nudge, and Roslyn LSP
discovery are all live. The doc remains a snapshot of what was built and how.

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

Residual pass (this batch):
- `b317812` — Item 1: signature help tooltip
- `3bf84d0` — Item 7: Vite HMR overlay capture in `[BUILD]`
- `b0c0231` — Item 2: viewport-driven inlay hints
- `06ab777` — Item 8: `[LSP]` block enrichment with symbols + hover-at-cursor
- `4073b4b` — Items 4+5: multi-LSP fan-out for web (HTML/CSS/Biome)
- `dbfb5eb` — Item 9: OmniSharp first-load nudge (`workspace/didChangeWatchedFiles`)
- `a8e4ffe` — Item 6: Roslyn LSP discovery + fallback groups
- `0a9b5c4` — Item 3: Mod-. code actions popup

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

## Residual work — shipped

All nine residual items landed in this pass.

- [x] **`signatureHelp` wired into the editor** — `lspSignatureHelpExtension` in `src/lspEditor.ts`; trigger characters from server capabilities, active-parameter highlighting via `labelOffsetSupport`, multi-overload counter. Single-buffer only.
- [x] **Inlay hints** — `lspInlayHintExtension` in `src/lspEditor.ts`. Viewport-driven, 300ms debounced, in-flight cancellation via generation counter. Renders as inline `WidgetType` decorations. Single-buffer only.
- [x] **Code actions / quickfix** — `lspCodeActionExtension` in `src/lspEditor.ts`. Mod-. opens a popup of available actions for the current cursor (filtered by overlapping diagnostics); fans out across every server in the bundle that advertises `codeActionProvider`. Resolves lazy `data`-bearing actions, applies the resulting `WorkspaceEdit` via a `WorkspaceEditApplier` closure. Single-buffer wiring done; project-workspace applier deferred. Server-side `command` execution is intentionally NOT wired (arbitrary side effects).
- [x] **HTML LS + CSS LS for the web project** — `web-html` (vscode-html-language-server) + `web-css` (vscode-css-language-server) added to `LSP_CONFIG`. `setup.ps1` installs `vscode-langservers-extracted`. Per-file dispatch via `acceptsLanguageIds` in the bundle.
- [x] **Biome `lsp-proxy` alongside tsserver for web** — `web-biome` config added. Diagnostics merge across servers in `getDiagnosticsByUri` so tsserver type errors and Biome lint warnings both surface.
- [x] **Roslyn LSP discovery for csharp** — `resolveCsharpRoslynBin` walks `~/.vscode/extensions/ms-dotnettools.csdevkit-*/.roslyn/` (and `csharp-*` as fallback). LANG_SERVERS for csharp is now a fallback group `[['csharp-roslyn', 'csharp']]` — Roslyn preferred, OmniSharp falls in when not found.
- [x] **Iframe Vite HMR overlay capture** — `BOOTSTRAP_SCRIPT` in `tools/projects.mjs` watches `document.body` for `vite-error-overlay` via MutationObserver, captures shadowRoot text, and includes it in the snapshot reply. `evaluateProjectCode` hoists it into a `[BUILD]` block above `[DOM]`.
- [x] **`[LSP]` block enrichment** — `buildLspBlock` and `buildProjectLspBlock` are now async and emit three nullable sub-blocks: `diagnostics`, `symbols` (top-level only, capped at 20, suppressed for files <20 lines), and `hover at <cursor>` (clipped to 6 lines / 200 chars).
- [x] **OmniSharp first-load timing** — Speculative `workspace/didChangeWatchedFiles` notification broadcast after initial tab hydration in `projectEditor.ts`. Servers with sluggish indexers (OmniSharp on cold start) re-evaluate seeded files. Effect needs interactive verification on a real csharp cold-start.

## Architecture (post-residual)

```
Browser (CodeMirror)
  └── src/lspClient.ts (LspClient bundle wrapping ServerSession[])
       └── one WebSocket /lsp?session=<id> per server, all sharing rootUri
              ↑
              ↓  (raw JSON over WS, Content-Length-framed on stdio)
Node (server.mjs / vite middleware)
  └── tools/lsp.mjs
       ├── spawn manager (one child per (serverKey, sessionId))
       ├── workspace materializer (fresh ephemeral OR project mode)
       ├── LSP_CONFIG[serverKey] (binary, args, init-options, root-marker, acceptsLanguageIds)
       ├── LANG_SERVERS[lang] (Array<string | string[]> — fallback groups for csharp)
       └── resolveBinPath() resolver (Roslyn LSP path discovery)
              ↓
       clangd | rust-analyzer | basedpyright-langserver | omnisharp / Microsoft.CodeAnalysis.LanguageServer | typescript-language-server | vscode-html-language-server | vscode-css-language-server | biome lsp-proxy
```

The bundle merges per-URI diagnostics across servers, picks the first server matching a file's languageId AND advertising the requested capability for hover/completion/sigHelp/inlayHint/codeAction/documentSymbol/formatting, and dispatches didOpen/didChange to every matching server.

## Resolved risks (keep for context)

- ~~codemirror-languageserver lib stale~~ — went hand-rolled, ~600 LOC in `src/lspClient.ts` + `src/lspEditor.ts`, no upstream dependency.
- ~~rust-analyzer flycheck reads disk, not buffer~~ — closed by the `syncToDisk` debounced writer (`1a0f05e`).
- ~~Roslyn LSP path discovery undocumented~~ — sidestepped by shipping OmniSharp instead.
- ~~Project workspace + LSP file-watch conflicts~~ — supervisor owns the disk; LSP gets `didChange` from CodeMirror; chokidar's events are observers only.
- ~~Memory ceiling on rust-analyzer~~ — single-file lessons keep it to tens of MB; idle-timeout dispose handles concurrent-tab accumulation.

## Known caveats

- The libuv `UV_HANDLE_CLOSING` assertion still prints during smoke shutdown on Windows even after `proc.stdin.end()`. Benign — the test result line precedes it. If it's irksome, the next step is calling `proc.stdout.unpipe()` / `proc.stderr.unpipe()` before kill, or moving from `child_process.spawn` to `node-pty` for cleaner Windows teardown.
- Drive-letter case (Windows): URIs use lowercase (`file:///x:/...`), workspace dirs come back uppercase from `path.resolve`. The bridge case-insensitively normalizes for containment checks, but if you add new path comparisons elsewhere remember to match the convention.
