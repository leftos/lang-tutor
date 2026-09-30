# Plan index

<!-- plan-doc-hygiene: 2026-09-27 f6393f2 -->

Entry point for open work. Open items are unchecked lines grouped into waves (see the README glossary), current focus first. A finished item is ticked in the commit that ships it; a finished subplan moves to `archive/`. Durable decisions go to `docs/` (for example `docs/lsp.md`).

## Current focus

### Wave 1 — run on demand, retire the droplet

Shared: `lt.ps1`, `README.md`, `CLAUDE.md`. Gate: `Invoke-ScriptAnalyzer ./lt.ps1` + `.\lt.ps1 help`; human check: `.\lt.ps1 launch`, use the app, `.\lt.ps1 stop -Docker`.

- [x] On-demand local run via `.\lt.ps1 launch` / `stop [-Docker]` / `status`; droplet deploy path (`lt.ps1 deploy`, `docs/deployment.md`) removed
- [ ] Human check under `launch`: Run the web workspace (Vite on :5180 in the iframe) and the C# workspace (WPF window + Send-to-tutor screenshot); the API-level checks (sandboxed Python run, state mirror) passed
- [ ] Outside this repo: remove the `location ^~ /lang-tutor/` proxy block from the leftos.dev site's Nginx config (`server-setup.sh` in the leftos.dev repo), then destroy the droplet `24.199.111.154` after copying any `/var/lib/lang-tutor` data worth keeping

## Next up

- [x] "Reset all" button: wipe every language's history, progress, code and workspace plus the shared learner profile in one confirmed action

### Wave 2 — cross-language user profile and per-language memory

Subplan: [learner-memory.md](./learner-memory.md) (audit findings, decided design, two implementer briefs).

- [x] Default models stay current without code edits: Gemini uses `gemini-flash-latest`; Anthropic/OpenAI resolve the newest family member (Sonnet / mini for chat, newest Haiku else Sonnet / mini for memory) from the provider's live model list when the user hasn't picked one; pinned IDs are only the offline fallback. Replaces the stale `claude-sonnet-4-20250514` default. Brief 1b on the learner-memory branch — see the subplan

Shared: `src/api.ts` (extraction calls), `src/main.ts` (`buildSystem`, `extractProgress`, profile merge), `src/types.ts` (`LearnerProfile`, progress shape), `src/constants.ts` (prompts, storage keys). Gate: `.\lt.ps1 typecheck` + `.\lt.ps1 lint`; human check: tell one language's tutor a background fact, switch to a fresh language and confirm its tutor already knows it and doesn't re-ask.

- [x] Evaluate and scrutinize how per-language memory (progress extraction, history, system prompt) and the existing shared learner profile work today; findings decide the items below
- [x] Make the user profile the single home for every non-language-specific fact about the learner (background, goals, preferences, learning style, trends), learned from any language and used by every tutor so a new language doesn't re-ask
- [x] A "Profile" view, like the per-language Progress tab, showing everything the tutors have noted about the learner across languages (and, pending the design interview, letting them correct or delete a fact)
- [ ] Live check with an API key: tell one tutor a background fact and a goal, open a fresh language and confirm its first message uses them without re-asking; the Profile tab shows them with that language's badge; Anthropic `[api] cache: HIT` on a session's second turn; Auto resolves to the expected model in the AI Provider dialog
- [ ] Unit-test the per-model reasoning fields (`lowReasoningFields` / `geminiLowThinking` / `isReasoningRejected` in `src/api.ts`) by moving them into `src/modelResolution.ts`

### Wave 4 — rewind the conversation

- [x] Resend one of my earlier messages and restore the conversation to that point: later tutor and user turns drop out of the context (Edit & resend, PR #7)
- [ ] Live check: Edit & resend a plain message and a Send-to-tutor message with a real key; the tutor answers from the rewound point, and lesson progress matches that point

### Singles (current)

- [ ] PowerShell course: single-buffer `powershell` language (PowerShell 7 core curriculum, `pwsh` in the sandbox image, host `pwsh` parser check), then PowerShell Editor Services as its language server with `Invoke-Formatter` for format

- [x] One command prepares this PC to run the server with full capabilities (runtimes, host checkers/formatters, every LSP, Docker + toolchain image) and reports what is missing
- [x] Rust Error list shows only `main.rs:L:C` + severity with no message text (e.g. "warning --> main.rs:2:9"); the editor tooltips have the messages
- [x] Autocomplete opens on its own only after a partial identifier or a trigger character (not after `;`), so Enter after `;` makes a new line
- [x] Tab accepts the open autocomplete suggestion instead of indenting (single-buffer and project editors)
- [x] Copy buttons: a copy icon on every code block in chat, and a copy button on every tutor reply and user message in the history

## Backlog

### Wave 3 — LSP features in project workspaces

Shared: `src/projectEditor.ts`, `src/lspEditor.ts`. Gate: `.\lt.ps1 typecheck` + `.\lt.ps1 lint`; human check: signature help, inlay hints and Mod-. code actions in the csharp and web workspaces.

- [ ] Wire signature help, inlay hints and code actions (with a multi-file `WorkspaceEdit` applier) into `projectEditor.ts`; today only the single-buffer editor has them

### Singles

- [ ] `.claude/hooks/biome-on-edit.mjs` runs `biome check --write` after every edit, so its fixes land mid-change: it rewrote a new `let` to `const` before the variable's first assignment existed (seen twice in implementer runs). Run the check without `--write` in the hook and leave fixing to `.\lt.ps1 lint`

- [ ] `.\lt.ps1 launch` never returns when its output is piped (`launch | rg ...`): the hidden server inherits the pipe handle, so the reader waits for ever; redirecting to a file works. Start the server without inheriting the console handles
- [ ] Drop the droplet-only `NODE_ENV === 'production'` defaults now that nothing sets it: the `/var/lib/lang-tutor/workspaces` workspace root (`tools/projects.mjs:35`) and the secure-cookie default (`tools/auth-routes.mjs:14`), plus the `/var/lib` example in the `src/projectPreview.ts:69` comment
- [ ] DASM missing from language lists: `CheckBody.lang` in `vite.config.ts:15` omits `'dasm'` though `/check` serves it (`tools/checker.mjs` `case 'dasm'`); `README.md` "Single-buffer" line (§ Languages) and the `lang-tutor:active` values (§ Per-language state) omit `dasm`
- [ ] `docs/README.md` is absent: the docs start page the glossary and architecture doc should hang from; today the glossary lives in the root `README.md`
- [ ] `.env.example` sets `NODE_ENV=production`, against the CLAUDE.md rule to leave `NODE_ENV` unset on Windows; drop it with the defaults above (found 2026-09-30 while folding CLAUDE.md into `docs/ARCHITECTURE.md`).
