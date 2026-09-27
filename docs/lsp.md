# LSP bridge: decisions and caveats

How the pieces fit is in `CLAUDE.md` ("LSP integration"). This page keeps the decisions behind them and the traps that are not visible from the code.

## Decisions

- **Hand-rolled client.** `src/lspClient.ts` + `src/lspEditor.ts` implement JSON-RPC over WebSocket directly. `codemirror-languageserver` was rejected: stale upstream, and it did not fit the editor's `Compartment` swap on language change.
- **Capabilities are negotiated by the client in `initialize`**, not returned by `POST /lsp/spawn`.
- **Rust uses disk sync.** rust-analyzer's flycheck (`cargo check`) reads files from disk, not the buffer, so `LSP_CONFIG.<server>.syncToDisk = true` makes the bridge debounce `didOpen`/`didChange` (500 ms) and write the buffer to the URI's path, with a case-insensitive workspace-containment check.
- **C#: Roslyn preferred, OmniSharp as fallback.** `LANG_SERVERS.csharp` is the fallback group `[['csharp-roslyn', 'csharp']]`; `resolveCsharpRoslynBin` finds the Roslyn LSP under `~/.vscode/extensions/ms-dotnettools.csdevkit-*/.roslyn/` (then `csharp-*`). OmniSharp is never auto-installed (no stable winget id).
- **Version probes.** `omnisharp --version` starts the full server and `basedpyright-langserver` crashes without `--stdio`, so those report availability from a PATH lookup alone (basedpyright probes its sibling CLI via `probeBin`).
- **Server-side `command` execution from code actions is not wired**: it has arbitrary side effects. Only `WorkspaceEdit`s are applied.
- **Signature help, inlay hints and code actions are single-buffer only**; project workspaces get diagnostics, hover, completion and formatting.

## Caveats

- **URI encoding differs by server.** basedpyright encodes the Windows drive colon as `%3A`, clangd and rust-analyzer keep it literal. `normalizeUri()` decodes `%3A` so diagnostics key consistently.
- **Drive-letter case on Windows.** URIs use lowercase (`file:///x:/...`) while `path.resolve` returns uppercase; any new path comparison must compare case-insensitively.
- **libuv `UV_HANDLE_CLOSING` assertion** can still print at shutdown on Windows despite `proc.stdin.end()`. It is benign. Next steps if it matters: `unpipe()` stdout/stderr before kill, or `node-pty`.
- **OmniSharp cold start** can take minutes before diagnostics arrive; `projectEditor.ts` broadcasts a speculative `workspace/didChangeWatchedFiles` after tab hydration to nudge it.
