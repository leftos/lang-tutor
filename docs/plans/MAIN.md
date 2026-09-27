# Plan index

<!-- plan-doc-hygiene: 2026-09-27 f6393f2 -->

Entry point for open work. Open items are unchecked lines grouped into waves (see the README glossary), current focus first. A finished item is ticked in the commit that ships it; a finished subplan moves to `archive/`. Durable decisions go to `docs/` (for example `docs/lsp.md`).

## Current focus

### Wave 1 — run on demand, retire the droplet

Shared: `lt.ps1`, `README.md`, `CLAUDE.md`. Gate: `Invoke-ScriptAnalyzer ./lt.ps1` + `.\lt.ps1 help`; human check: `.\lt.ps1 launch`, use the app, `.\lt.ps1 stop -Docker`.

- [x] On-demand local run via `.\lt.ps1 launch` / `stop [-Docker]` / `status`; droplet deploy path (`lt.ps1 deploy`, `docs/deployment.md`) removed
- [ ] Human check under `launch`: Run the web workspace (Vite on :5180 in the iframe) and the C# workspace (WPF window + Send-to-tutor screenshot); the API-level checks (sandboxed Python run, state mirror) passed
- [ ] Outside this repo: remove the `location ^~ /lang-tutor/` proxy block from the leftos.dev site's Nginx config (`server-setup.sh` in the leftos.dev repo), then destroy the droplet `24.199.111.154` after copying any `/var/lib/lang-tutor` data worth keeping

## Backlog

### Wave 2 — LSP features in project workspaces

Shared: `src/projectEditor.ts`, `src/lspEditor.ts`. Gate: `.\lt.ps1 typecheck` + `.\lt.ps1 lint`; human check: signature help, inlay hints and Mod-. code actions in the csharp and web workspaces.

- [ ] Wire signature help, inlay hints and code actions (with a multi-file `WorkspaceEdit` applier) into `projectEditor.ts`; today only the single-buffer editor has them

### Singles

- [ ] Drop the droplet-only `NODE_ENV === 'production'` defaults now that nothing sets it: the `/var/lib/lang-tutor/workspaces` workspace root (`tools/projects.mjs:35`) and the secure-cookie default (`tools/auth-routes.mjs:14`), plus the `/var/lib` example in the `src/projectPreview.ts:69` comment
