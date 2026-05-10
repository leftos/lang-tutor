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

- [ ] Re-show `#projPreview` and `#projPreviewResize` for desktop runtime in `ensureProjectUI` (M2 hid them via `display: none`).
- [ ] Implement the desktop-mode branch in [src/projectPreview.ts](src/projectPreview.ts) (currently throws "not implemented yet"):
  - Tabs: `Output` (primary) | `Build errors`
  - `Output` tab = SSE log stream (same source as web's "Server logs"), with stderr lines styled red and `system` lines styled italic-muted
  - `Build errors` tab: lines matching `error CS\d+:` (C# compiler) or `error MSB\d+:` (MSBuild); count badge when populated
  - Status pill: `stopped` / `starting` / `running (PID N)` / `exited (code N)`
  - Hide Reload + Open-in-tab buttons (no URL)
  - `requestSnapshot()` returns `null`
- [ ] Wire Run/Stop to `/proj/start` and `/proj/stop` (no new endpoints — supervisor already handles both shapes).
- [ ] When `dotnet run` exits on its own (user closed the WPF window), status auto-updates via the existing exit handler. Confirm without the existing polling loop's HTTP-probe assumption.
- [ ] Visual check: switch to C#, click Run, WPF window appears on desktop, output streams into the Output tab, click Stop or close the window → status flips to `exited`.

### M4 — XAML editor support

Multi-file editor handles `.xaml` and `.csproj`.

- [ ] Add `@codemirror/lang-xml` to dependencies (may already be transitive via `lang-html`).
- [ ] In the per-file extension lookup in [src/projectEditor.ts](src/projectEditor.ts) (search for the `html` case in `langExtensionForPath`), add `xaml` → `xml()`, `cs` → `csharp()`, `csproj` → `xml()`.
- [ ] In [src/main.ts](src/main.ts) `fenceLangFromPath`, add `xaml` → `xml`, `cs` → `csharp`, `csproj` → `xml` so Send-to-tutor uses correct fence labels.

### M5 — Send-to-tutor for desktop projects

Project-mode `evaluateProjectCode()` works for both project shapes; tutor prompt updated.

- [ ] Branch on `lang.runtime.kind` in `evaluateProjectCode()`. For `desktop-process`:
  - Build `[FILES]` block as today (open tabs, dirty marked)
  - Skip `[DOM]` and `[CONSOLE]` blocks
  - Build `[SERVER]` block as today (recent log lines from `/proj/logs/recent`)
  - Concatenate `[FILES] + [SERVER]`
- [ ] Rewrite C# `systemPromptIntro`: student is in a project workspace at `projects/csharp/`, file tree + tabs available, Run launches a real WPF window, Send-to-tutor bundles `[FILES] + [SERVER]` (no DOM / iframe), ask for screenshots if you need UI behavior. Mention the "Open in" launchers (VS Code / Visual Studio / File Explorer) so the tutor knows to suggest them.
- [ ] Update C# `firstSessionPrompt` accordingly.
- [ ] Data migration: Phase 1 users will have a `lang-tutor:csharp:code` localStorage entry from the single-buffer era. Delete it in `migrateOldStorage()` — single-buffer artifact, no longer relevant.

### M6 — Polish

- [ ] **First-`dotnet restore` UX**: cold restore can take 30+s. Show "restoring NuGet packages (one-time, can take a minute)…" → "ready" in the Output tab.
- [ ] **Build-phase awareness**: process-alive declares ready at 500 ms but the WPF window doesn't show until `dotnet run` finishes building (5–15s cold). Parse the log stream for `Build succeeded.` and flip "starting…" → "ready" then.
- [ ] **HMR-orphan mitigation**: register a process-exit / module-unload handler in `tools/projects.mjs` that calls `killProcessTree` for every live `procs` entry when the module is replaced. The current `taskkill` only fires on explicit `/proj/stop`; Vite HMR replacing the module silently abandons all spawned children.
- [ ] **Build error linkification** (stretch): clickable line-number jumps from the `Build errors` tab into the editor. Needs a parser for the `Foo.cs(12,5): error CS0103: …` format. Can defer.
- [ ] **Reset for csharp**: confirm ("This will delete projects/csharp/ and re-scaffold. Continue?"), stop the process, delete the folder, re-scaffold.
- [ ] **Friendly errors**: target-framework mismatch (e.g. user edits csproj to `net6.0`), missing `.csproj`.
- [ ] Update [CLAUDE.md](CLAUDE.md) and [README.md](README.md) to describe the C# project workspace alongside the web one.

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
