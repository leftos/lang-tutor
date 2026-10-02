---
name: lang-tutor-nextup
description: Profile for the user-level `nextup` skill in the lang-tutor repo — loaded by `nextup` at its step 0 for this project's plan order and gates. Not a loop of its own; invoke `/nextup`.
---

# lang-tutor profile for `nextup`

The generic loop is the user-level `nextup` skill; this file supplies only what is lang-tutor-specific.

siblings: none
linear: lang-tutor

## Plan and tracker

- The plan lives in Linear: every task is a Linear issue in team LANG, per `~/.claude/docs/plan-operations.md`; `docs/plans/MAIN.md` is its generated snapshot. Project order, which is the order the queue is worked: `Wave 1 — run on demand, retire the droplet`, `Wave 2 — cross-language user profile and per-language memory`, `Wave 4 — rewind the conversation`, `Wave 3 — LSP features in project workspaces`, `Singles`. The next item is the first Todo of the first project that has one.
- A steer or a finding the item does not fix gets an **add**, in the project whose files it shares, else in `Singles`.
- Tracker: **triage** as plan-operations says (GitHub issues reach the team through Linear's sync; an untriaged one is top-level with no project), each untriaged issue placed in the project that shares its files, else in `Singles`.
- A finished design file in `docs/plans/` moves to `docs/plans/archive/`, after its rulings are promoted into `docs/`.

## Gates

`.\lt.ps1 typecheck`, `.\lt.ps1 lint`, `pnpm test` (vitest) and, for a change to `lt.ps1`, `Invoke-ScriptAnalyzer ./lt.ps1`.
