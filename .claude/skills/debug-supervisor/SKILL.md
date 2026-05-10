---
name: debug-supervisor
description: Diagnose project workspace supervisor issues (tools/projects.mjs) — orphaned processes, readiness failures, build-phase regressions, log buffer drops, file watcher misbehavior, dotnet quiet output. Use when project-workspace Run/Stop/Reset misbehaves or processes accumulate across HMR reloads.
---

# Debugging the project-workspace supervisor

`tools/projects.mjs` is the most complex moving part in this codebase. This skill collects the things to check first — symptoms, root causes, and one-liners.

## Where state lives

| What | Where |
|------|-------|
| Live processes | `globalThis['__langTutorProcs']` (Map, lang-keyed) — stashed on globalThis so Vite HMR reloading `tools/projects.mjs` doesn't lose track of children |
| Log buffer | per-lang ring buffer; replayed on SSE connect |
| Status snapshot | `GET /proj/status?lang=<lang>` → `{ running, ready, phase, pid, lastExitCode, vitePort, error }` |
| Recent logs | `GET /proj/logs/recent?lang=<lang>&n=200` |
| Live log stream | `GET /proj/logs?lang=<lang>` (SSE) |
| File-tree watcher | `GET /fs/watch?lang=<lang>` (SSE; chokidar) |

## Symptoms → checks

### "Run does nothing" or "Run starts the wrong language"
- Most likely: stale event handler from a prior workspace. `createWebVitePreview` / `createDesktopPreview` register clicks via `AbortController`; their `destroy()` MUST call `ctrl.abort()`. Grep `src/projectPreview.ts` for `AbortController` and confirm both factories use it.
- Header DOM elements (`#projRunBtn`, `#projReloadBtn`, `#projOpenExternalBtn`) survive language switches by design — don't try to "fix" that by replacing them.

### "Status pill stuck on `spawning…`"
Two failure modes — readiness probe or build-phase regex.

- **Web (`http-probe`)**: probe target is `http://127.0.0.1:<port>/`. If the dev server picked a different port, the probe will timeout. Check `vitePort` field of `/proj/status` against `PROJECT_CONFIG.web.readiness.port` (5180).
- **C# (`process-alive` + build phases)**: phase advancement is regex-driven on dotnet `--verbosity minimal` stdout:
  - `Determining projects to restore` → `restoring NuGet…`
  - `All projects are up-to-date for restore` OR `^\s*Restored\b` → past restore
  - `^\s+\S.* -> .+\.dll` → `building…` complete (running)
  - System-stream lines (the supervisor's own pushLog markers) are **skipped** so a literal "Restored" in our banner can't flip phases.
  - Phase only ever advances forward within a Run cycle — by design.

### "dotnet output is empty until exit"
`dotnet run` defaults to **quiet** verbosity under non-TTY stdout — no output, no build phases, nothing until exit. `PROJECT_CONFIG.csharp.dev.args` MUST include `--verbosity minimal`. If it doesn't, restore it; otherwise check whether the args got reordered and `--verbosity minimal` is appearing after the program-arg separator (`--`).

### "Process leaks after dev server restart"
- Process-exit / SIGINT / SIGTERM handlers are registered once via a global flag. If they aren't cleaning up, the global flag may be set on a stale module instance from a prior HMR cycle. The `procs` Map should always be looked up via `globalThis['__langTutorProcs']`.
- Manual cleanup: `GET /proj/status?lang=<lang>` to find PID, then on Windows: `taskkill /T /F /PID <pid>` (the `/T` is critical — kills the whole tree). On POSIX: `kill -- -<pid>` (negative PID = process group).

### "File tree doesn't update after edits outside the editor"
- Check the SSE connection at `GET /fs/watch?lang=<lang>` in DevTools Network tab — it should be open and streaming events.
- `treeIgnore` in `PROJECT_CONFIG[lang]` filters paths from the tree. If a directory is incorrectly hidden/shown, this is the lever.

### "/fs/* request rejected with traversal error"
- Every path passed to `/fs/list|read|write|rename|delete|mkdir` is resolved against the project root and rejected if it escapes. Treat this as a feature, not a bug — the rejection prevents writing outside `projects/<lang>/`.
- If a legitimate operation is being rejected, the operation is wrong (probably a `..` snuck into the path), not the resolver.

### "ENOENT on the dev command"
- Friendly install hint should be pushed into the log buffer. If the supervisor exits silently instead, check the spawn-error handler in `tools/projects.mjs` — it should `pushLog(state, 'system', '<install hint>')` and set `error` in status.

## Useful one-liners

```powershell
# Reset a workspace cleanly (stops process, deletes folder, re-scaffolds)
Invoke-RestMethod -Method Post http://localhost:5173/proj/reset -Body (@{lang='web'} | ConvertTo-Json) -ContentType application/json

# Tail recent logs
Invoke-RestMethod "http://localhost:5173/proj/logs/recent?lang=csharp&n=400"

# Status snapshot
Invoke-RestMethod "http://localhost:5173/proj/status?lang=csharp"
```

## DON'T

- Don't delete `.claude/worktrees/` — those are agent worktrees, unrelated to project workspaces.
- Don't swallow spawn ENOENT silently — install hints in the log buffer are intentional and the user needs them.
- Don't change `child_process.spawn(cmd, args[])` (array form) to the shell form. Shell form is a command-injection vector when project paths can include user-controlled data.
- Don't try to make the build-phase pill advance backward — phase is forward-only by design, and a regression to "spawning" when running would mask real problems.
