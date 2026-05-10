# C# course (modern features → WPF → MVVM)

A fifth "language": a Windows-flavoured C# course covering modern language
features (records, pattern matching, nullable refs, async, LINQ), WPF
fundamentals (XAML, layout, dependency properties), and MVVM patterns
(INotifyPropertyChanged, commands, DI).

## Decisions (signed off)

- **Topic order**: Modern C# (8) → WPF fundamentals (6) → MVVM patterns (5). 19 total. Locked in [src/constants.ts](src/constants.ts) `CSHARP.topics`.
- **Execution model**: Project workspace mirroring `web` — file tree + multi-tab editor + Run that launches `dotnet run`. WPF windows pop up on the user's desktop; no in-browser preview.
- **No remote sandbox**: no free hosted C# sandbox comparable to Rust Playground / Wandbox. Local `dotnet` is required.
- **Single project workspace** per language under `projects/csharp/`. Reset wipes the whole folder.
- **Neutral system prompts**: the tutor interviews on first session; never bake assumptions about C# / WPF / MVVM background.

## What's shipped

### Phase 1 — lessons + editor (commit `eff2ad6`)

`'csharp'` `LanguageId`; CSHARP record with single-buffer `Program.cs` starter, 19 topics, neutral interview-driven prompts (explicitly telling the model "this app does NOT execute C#"). `@replit/codemirror-lang-csharp` wired into the editor compartment; `runCSharp()` returns informational message; nav tab `iv. C#`; web renumbered to `v.`

### M1 — Generalize project shape (commit `21d94dc`)

- `ProjectRuntime` discriminated union (`web-vite { port }` | `desktop-process`) replaces the hardcoded `defaultVitePort`. WEB.runtime = `{ kind: 'web-vite', port: 5180 }`.
- `tools/projects.mjs` reads everything from `PROJECT_CONFIG[lang]`: scaffold dir, install/dev cmds, readiness model, `treeIgnore`, bootstrap kind.
- `injectBootstrap` no-op when bootstrap is null. `buildTree`, the chokidar `ignored` callback, and `fanoutFsEvent` all take a per-lang ignore set.
- `probeProcessAlive` (resolves once the spawned child stays alive past a warm-up window) sits alongside the existing `http-probe`.
- `createProjectPreview` dispatches on `runtime.kind`; desktop branch is wired but throws until M3 implements it.

### M2 — C# scaffold + supervisor (commit `ecd1537`)

- CSHARP switched to `kind: 'project'`, `runtime: { kind: 'desktop-process' }`, `scaffoldDir: 'csharp'`.
- WPF scaffold template: `csharp.csproj` (`net8.0-windows`, `UseWPF`), `App.xaml` + `.cs`, `MainWindow.xaml` + `.cs` with click counter, README.
- `csharp` `PROJECT_CONFIG` entry: install = `dotnet restore` (marker `obj/`), dev = `dotnet run`, readiness = `process-alive` (500 ms), `treeIgnore = { bin, obj, .vs }`, no iframe bootstrap.
- `commandExists()` preflight; a missing `dotnet` logs the install-from-aka.ms hint and bails out before spawning anything.
- `killProcessTree()` walks the process tree on Windows via `taskkill /T /F`. Required for `dotnet run` cleanup (`SIGTERM` to the dotnet host doesn't reach the WPF child); also fixes the long-standing `pnpm dev → vite` orphan that caused intermittent 5180 collisions.
- `ensureProjectUI` rebuilds when the active project lang changes (was single-shot — would have reused web's editor for csharp file ops). `destroyProjectUI` tears down editor / preview / fs subscription / DOM hosts.
- Project preview pane hidden for desktop runtime in M2 — its UI lands in M3.
- `createFileTree` takes a `headerLabel` parameter (was hardcoded `projects/web/`).

### Off-plan: "Open in ▾" header dropdown (commit `3169b80`)

Per-lang quick-launch into external editors / file managers. csharp menu = VS Code · Visual Studio · File Explorer; web menu = VS Code · File Explorer.

- `GET /proj/open/targets` (cached availability probe via `where.exe` / `which`).
- `POST /proj/open { lang, target }` spawns detached:
  - `vscode` → `code <projectRoot>` (`shell: true` on Windows for `code.cmd`)
  - `vs` → `cmd /c start "" <csproj>` (file association → Visual Studio)
  - `explorer` → `explorer.exe <projectRoot>`
- Frontend dropdown lives in the file-tree header. Unavailable items grey out with a "<editor> not found on PATH" tooltip. Closes on Escape / outside mousedown.

## What's left

### M3 — C# preview pane

Frontend gets a working Output pane for desktop projects.

- [x] Re-show `#projPreview` and `#projPreviewResize` for desktop runtime in `ensureProjectUI` (M2 hid them via `display: none`).
- [x] Implement the desktop-mode branch in [src/projectPreview.ts](src/projectPreview.ts) (`createDesktopPreview`):
  - [x] Tabs: `Output` (primary) | `Build errors`
  - [x] `Output` tab = SSE log stream (same source as web's "Server logs"), with stderr lines styled red and `system` lines styled italic-muted
  - [x] `Build errors` tab: lines matching `error CS\d+:` (C# compiler) or `error MSB\d+:` (MSBuild); count badge when populated. (No automatic stderr promotion — `dotnet` writes telemetry / NuGet noise to stderr that isn't a build error.)
  - [x] Status pill: `stopped` / `starting` / `running (PID N)` / `exited (code N)`. Distinguishes user-stop from self-exit via `userStoppedAt` timestamp on the supervisor; `getStatus` now returns `pid` + `lastExitCode` + `phase: 'exited'`.
  - [x] Hide Reload + Open-in-tab buttons (no URL); restored on destroy in case the next ensureProjectUI swaps to a web-vite project (shared DOM nodes).
  - [x] `requestSnapshot()` returns `null`
- [x] Wire Run/Stop to `/proj/start` and `/proj/stop` (no new endpoints — supervisor already handles both shapes).
- [x] When `dotnet run` exits on its own (user closed the WPF window), the 2 s status reconciliation loop catches it: phase flips to `exited`, pill shows `exited (code N)`. The plan's "without HTTP-probe assumption" note is satisfied because the desktop loop calls `getStatus` and reacts to `running` regardless of `ready`.
- [x] **Bonus fix**: hardened both web and desktop previews against zombie click-handlers via `AbortController`. Previously `addEventListener` on shared `#projRunBtn`/`#projReloadBtn`/`#projOpenExternalBtn` was never removed, so language switches accumulated handlers — Run on csharp would also re-trigger web's startProject, race its `pollUntilReady`, and overwrite tabs. Caught during M3 visual verification.
- [x] Visual check: switch to C#, click Run → status pill `running (PID 80056)`, WPF window opens, output streams, click Stop → pill `stopped`. Self-exit path (force-killed `csharp.exe`) flips pill to `exited (code 4294967295)` within 2 s.

Also gated the `Send to tutor` button (`#projEvalBtn`) behind `runtime.kind !== 'desktop-process'` until M5 lands the desktop-shaped payload.

### M4 — XAML editor support

Multi-file editor handles `.xaml` and `.csproj`.

- [x] Added `@codemirror/lang-xml@6.1.0` (not transitive via `lang-html`).
- [x] [src/projectEditor.ts](src/projectEditor.ts) `langExtensionForPath`: `xml` / `xaml` / `csproj` → `xml()`, `cs` → `csharp()` (reusing `@replit/codemirror-lang-csharp` already in deps from Phase 1).
- [x] [src/main.ts](src/main.ts) `fenceLangFromPath`: `xml` / `xaml` / `csproj` → `xml`, `cs` → `csharp`.
- [x] Visual: opened `MainWindow.xaml`, `MainWindow.xaml.cs`, `csharp.csproj` — each gets distinct token classes (`<Project>` / attribute / value for XML; `using` / type / `.` for C#). All three tabs co-existed in the multi-file editor.

### M5 — Send-to-tutor for desktop projects

Project-mode `evaluateProjectCode()` works for both project shapes; tutor prompt updated.

- [x] Branched [src/main.ts](src/main.ts) `evaluateProjectCode()` on `lang.runtime.kind`. Desktop path skips snapshot + DOM/CONSOLE entirely and labels its log block `[OUTPUT]` (not `[SERVER]` — accurate for `dotnet run` stdout/stderr). Empty-output placeholder distinguishes "running but silent" (typical for a fresh WPF launch) from "stopped".
- [x] Removed the M3 desktop gate on `#projEvalBtn` in `ensureProjectUI` — Send-to-tutor now lights up for csharp.
- [x] Rewrote CSHARP `systemPromptIntro`: workspace shape (file tree, multi-tab editor, Output / Build errors pane), Run executes real `dotnet run` opening a WPF window on the desktop, "Open in" launcher hint for VS Code / Visual Studio / Explorer, exact `[FILES]` + `[OUTPUT]` block contract, no `[DOM]`/`[CONSOLE]`, ask for screenshots for UI behaviour, regex hints for `error CS\d+:` / `error MSB\d+:` / `Unhandled exception:` so the tutor can quote the right line. Dropped the stale "this app does NOT execute C#" and "XAML pasted will look unstyled" lines.
- [x] Updated CSHARP `firstSessionPrompt` to mention the workspace shape and Send-to-tutor's bundle contract; dropped the "this app does not execute C#" disclaimer.
- [x] Added `storageDelete(codeKey('csharp'))` to `migrateOldStorage()` — Phase 1 single-buffer `lang-tutor:csharp:code` is now dead weight.
- [x] Visual: opened `MainWindow.xaml`, `MainWindow.xaml.cs`, `csharp.csproj`; clicked Send-to-tutor with `/v1/messages` stubbed. Captured payload contains `[FILES]` (xml + csharp + xml fences) + `[OUTPUT]` (supervisor log lines), no DOM/CONSOLE block. System prompt tail confirms the new text is live.

### M6 — Polish

- [x] **First-`dotnet restore` UX**: `runInstall` in [tools/projects.mjs](tools/projects.mjs) now prints "Running dotnet restore (one-time, downloads NuGet packages — can take a minute on a cold cache)…" instead of the opaque "Running dotnet restore (one-time)…".
- [x] **Build-phase awareness**: switched csharp dev cmd to `dotnet run --verbosity minimal` (default `quiet` under non-TTY emits *no* output until exit). Frontend [createDesktopPreview](src/projectPreview.ts) regex-matches `Determining projects to restore` / `All projects are up-to-date` / `^\s+\S.* -> .+\.dll` and advances a `DesktopBuildPhase` (`starting → restoring → building → ready`). Status pill shows `spawning… (PID N)` → `restoring NuGet… (PID N)` → `building… (PID N)` → `running (PID N)`. Phase only ever advances forward within a Run cycle; system-stream lines (the supervisor's own banners) are skipped so a stray "Restored" can't flip phases. Verified live: `0ms starting → 700ms spawning… → 900ms restoring NuGet… → 1100ms building… → 1400ms running` on a warm cache.
- [x] **HMR-orphan mitigation**: `procs` Map stashed on `globalThis['__langTutorProcs']` so a module reload (Vite restarts on every `tools/projects.mjs` edit) preserves child PIDs and log buffers. Subscribers (`state.subs`) are deliberately reset because they're DOM observers from a dead request lifetime. `process.on('SIGINT'/'SIGTERM'/'exit')` registered once via a global-flag guard so duplicate listeners don't pile up across reloads — calls `killProcessTree` for every supervised PID so Ctrl+C cleans up children.
- [x] **Reset for csharp**: new `POST /proj/reset` endpoint in [tools/projects.mjs](tools/projects.mjs) → [tools/project-routes.mjs](tools/project-routes.mjs) atomically stops the process, deletes `projects/<lang>/`, and re-scaffolds. Frontend [resetCurrentLanguage](src/main.ts) calls it via `resetProject` ([src/projectApi.ts](src/projectApi.ts)) and shows a runtime-aware confirmation prompt ("Reset all C# progress, delete projects/csharp/, and re-scaffold from the template?"). Verified end-to-end with a marker file: scaffold rebuilt, marker gone.
- [x] **Friendly errors**: `preflightCsharp` runs after the `commandExists` check, before `dotnet restore` / `dotnet run`. Catches missing `.csproj` ("No .csproj found in projects/csharp/. The project scaffold is incomplete — click Reset to re-scaffold.") and TargetFramework / SDK mismatch ("Project targets .NET 99+ but only these SDK majors are installed: 8, 10. Install .NET 99 SDK from https://aka.ms/dotnet/download (or edit csharp.csproj's <TargetFramework> to match)."). Verified live by editing csproj to `net99.0-windows`.
- [x] [CLAUDE.md](CLAUDE.md) and [README.md](README.md) updated: workspace shapes (single-buffer vs project), per-language run / live-error / format-on-save table now includes csharp + web, project-supervisor architecture (`PROJECT_CONFIG`, readiness, build-phase pill, globalThis stash), evaluate-flow contract per runtime kind, full route table for `/fs/*` + `/proj/*` (incl. `/proj/reset`), Reset semantics call out the destructive on-disk delete, AbortController gotcha around shared header DOM, csharp `--verbosity minimal` rationale.
- [x] **Build error linkification**: parsed `<path>(<line>,<col>):` prefix in each [Build errors row](src/projectPreview.ts) renders as a `proj-preview-error-link` button — click to open the file in the editor, jump the cursor to (line, col), scroll into view, focus. Detector + parser cover CS / MC (XAML markup compiler) / MSB error codes. Absolute paths from dotnet are stripped to project-relative via the `projects/<scaffoldDir>/` segment so the editor can open them without the supervisor exposing a project root. dotnet emits each error twice (compile + Build FAILED summary), so a per-Run-cycle `Set<string>` keyed by `path:line:col:code` dedupes to a single row. New [ProjectEditor.revealAt(path, line, col)](src/projectEditor.ts) hosts the open + jump logic; `main.ts` wires it via the new `onJumpTo` callback on `createProjectPreview`. Verified live with both an MC3072 (XAML attribute) and a pair of CS errors (CS0103 + CS0029): badge shows the deduped count, click jumps cursor to the exact (line, col) and focuses the editor.

## Out of scope (deferred)

- **In-browser C# execution** (Blazor / Mono.WASM). Not feasible for WPF; not worth the runtime weight for console-only either.
- **WPF rendering inside the app** (Avalonia / browser XAML preview). Partial-fidelity preview vs. real WPF is more confusing than helpful.
- **Hot reload for WPF**. `dotnet watch` exists but is flaky with XAML; stick with stop → edit → run.
- **Multi-project solutions** (`*.sln` with multiple `*.csproj`). One project per workspace.
- **Cross-platform .NET**. The course is explicitly Windows-flavoured. Modern C# topics work cross-platform; WPF/MVVM don't.
- **Visual designer for XAML**. The student writes XAML by hand. (Visual Studio's designer is the right tool for visual layout work — use the "Open in" launcher for that.)
- **NuGet package management UI**. The student runs `dotnet add package X` in the lessons.

## Risks / open questions

- **HMR-orphaned children** (confirmed real): when Vite hot-reloads `tools/projects.mjs`, the `procs` Map state is lost but spawned children keep running. M2's `killProcessTree` only fires on explicit `/proj/stop`. M6 polish item.
- **`dotnet run` cold start** (5–15s): the process-alive probe declares ready before the WPF window appears. Parse log for `Build succeeded.` (M6).
- **WPF window focus**: when Run is clicked, the WPF window appears on top of the browser. User has to alt-tab back. Acceptable; mention in lesson copy.
- **Dotnet SDK version**: `<TargetFramework>net8.0-windows</TargetFramework>` requires .NET 8+. A student with only .NET 6/7 will see `dotnet restore` fail. M6 should detect and surface "install .NET 8 SDK".
- **XAML namespace boilerplate**: every XAML file starts with `xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"` etc. Lessons should explain once and treat as boilerplate. Curriculum note for the M5 prompt rewrite.
