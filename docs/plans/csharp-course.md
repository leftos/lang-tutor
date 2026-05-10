# C# course (modern features → WPF → MVVM)

Adding a fifth "language" entry — a Windows-flavoured C# course covering modern language features (records, pattern matching, nullable refs, async, LINQ), WPF fundamentals (XAML, layout, dependency properties), and MVVM patterns (INotifyPropertyChanged, commands, DI). Phase 1 (lessons + editor) is shipped. Phase 2 (project workspace + `dotnet run` execution) is the work this plan describes.

## Decisions (signed off)

- **Topic order**: Modern C# first (8 topics) → WPF fundamentals (6) → MVVM patterns (5). 19 topics total. Locked in [src/constants.ts](src/constants.ts) `CSHARP.topics`.
- **Execution model (long-term target)**: Project workspace, mirroring how `web` works today — file tree + multi-tab editor + a "Run" button that launches `dotnet run` as a local process. WPF windows pop up on the user's desktop (no in-browser preview is possible — XAML rendering requires the actual WPF runtime on Windows).
- **No remote sandbox**: There is no public free C# execution sandbox comparable to the Rust Playground / Wandbox. Local `dotnet` is required.
- **Single project workspace**: One persistent `projects/csharp/` workspace per user, just like `projects/web/`. Lessons add to it; a Reset wipes the whole folder.
- **System prompts neutral on prior experience**: Tutor interviews the student on the first session (per the recent rewrite of all language prompts). Don't bake assumptions about C# / WPF / MVVM background into the prompt.

## What's shipped (Phase 1 — done)

Lessons + editor only. No execution. Student copies code into Visual Studio / Rider to run it.

- [x] `'csharp'` added to `LanguageId` in [src/types.ts](src/types.ts:1)
- [x] `CSHARP` `Language` record in [src/constants.ts](src/constants.ts) — single-buffer, `Program.cs` starter, 19 topics, neutral interview-driven `systemPromptIntro` + `firstSessionPrompt` that explicitly tells the model "this app does NOT execute C# — Run button is informational only"
- [x] `'csharp'` added to `LANGUAGE_IDS` so the rail and progress UI pick it up
- [x] `csharp: () => csharp()` wired into the editor's language compartment in [src/editor.ts](src/editor.ts) using `@replit/codemirror-lang-csharp@6.2.0` (peer-deps already satisfied; no other CodeMirror changes needed)
- [x] `runCSharp()` in [src/runners.ts](src/runners.ts) returns `{ ok: true, output: '<copy to VS/Rider…>' }` so the Run button shows an informational message rather than an error
- [x] `'csharp'` entry in `fileSpec` map in [src/main.ts](src/main.ts) (`'c# 12 · run in vs/rider'`)
- [x] `<button data-lang="csharp" class="lang-tab">` added to [index.html](index.html); Web tab renumbered to `v.`
- [x] `@replit/codemirror-lang-csharp` 6.2.0 added to `dependencies`

End-to-end verified in browser preview: lang-rail shows `iv. C# 00 · 19`, switching activates the C# starter `Program.cs` with proper syntax highlighting, lesson plan empty-state renders, Run button shows the "not executed" message, Send-to-tutor / chat / progress flow all work.

## What's left (Phase 2 — this plan)

The job: make C# a `kind: 'project'` language with a real `dotnet run` execution loop and a console-output preview pane (not an iframe). Today's project pattern in `tools/projects.mjs` and `src/projectPreview.ts` is **heavily web-shaped**:

- Hardcoded `pnpm install` + `pnpm dev` commands
- HTTP-port readiness probe (`fetch http://127.0.0.1:5180/`)
- Iframe preview pointing at the dev port
- Bootstrap script injected into `index.html` to capture DOM + console
- Send-to-tutor bundles `[FILES] + [DOM] + [CONSOLE] + [SERVER]`
- Tree-ignore list = `node_modules`, `.git`, `dist`, `.vite`

For C# / WPF, **none of those apply directly**. The Phase 2 work is to generalize the project pattern so it can support both shapes.

## Architecture

### Generalize `Language` (no breaking change)

`ProjectLanguage` in [src/types.ts:54](src/types.ts:54) currently has `defaultVitePort: number`, which assumes a long-running HTTP server. Replace with a `runtime` discriminator so different project types declare what they need:

```ts
export interface WebProjectRuntime {
  readonly kind: 'web-vite';
  readonly port: number;          // mirrors PORTS in tools/projects.mjs
}

export interface DesktopProjectRuntime {
  readonly kind: 'desktop-process';
  // no port. Run button is one-shot ("Run program" / "Stop program").
}

export type ProjectRuntime = WebProjectRuntime | DesktopProjectRuntime;

export interface ProjectLanguage {
  readonly kind: 'project';
  readonly id: LanguageId;
  readonly name: string;
  readonly scaffoldDir: string;
  readonly runtime: ProjectRuntime;
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}
```

Then `WEB.runtime = { kind: 'web-vite', port: 5180 }` and `CSHARP.runtime = { kind: 'desktop-process' }`. Every site that touches `defaultVitePort` (currently in `main.ts:201` and the `projectPreview` constructor) gates on `runtime.kind`.

### Generalize `tools/projects.mjs`

The supervisor currently bakes web assumptions into module-level constants. Refactor to a per-language config table:

```js
const PROJECT_CONFIG = Object.freeze({
  web: {
    scaffoldDir: 'web',
    install: { cmd: 'pnpm', args: ['install'] },
    dev: { cmd: 'pnpm', args: ['dev'] },
    readiness: { kind: 'http-probe', url: 'http://127.0.0.1:5180/' },
    treeIgnore: new Set(['node_modules', '.git', 'dist', '.vite']),
    bootstrap: 'web-iframe',  // injects DOM-snapshot bootstrap into index.html
  },
  csharp: {
    scaffoldDir: 'csharp',
    install: { cmd: 'dotnet', args: ['restore'] },
    dev: { cmd: 'dotnet', args: ['run'] },
    readiness: { kind: 'process-alive' },
    treeIgnore: new Set(['bin', 'obj', '.vs']),
    bootstrap: null,
  },
});
```

`startProject(lang)` reads from this table:

- If `install.cmd` is set, runs it once when no marker exists (e.g. `node_modules` for web, `obj/` for csharp). Tee output into the log ring buffer.
- Spawns `dev.cmd dev.args[]` with `cwd = projects/<scaffoldDir>/`.
- Readiness:
  - `http-probe`: existing logic (poll URL until 200 / 4xx).
  - `process-alive`: declare ready as soon as the process has been alive for ~500 ms without exiting. (No URL to probe; for WPF, the window has launched.)
- If `bootstrap === 'web-iframe'`, run `injectBootstrap(lang)`. Otherwise skip.
- `IS_WIN && cmd.endsWith('.exe')` doesn't apply to `dotnet`, but the `shell: IS_WIN` shim already handles it for `pnpm.cmd`. `dotnet` is a real `.exe` on Windows so `shell: false` works; current code passes `shell: IS_WIN` always, which is fine.

### Generalize `src/projectPreview.ts`

The preview pane today is built around an iframe pointing at the Vite port. For desktop projects:

- **No iframe**. Replace the Preview tab with a "Program output" tab that shows the same SSE log stream as the existing Server-logs tab, but as the primary view.
  - Easiest: collapse the three tabs (`Preview` / `Server logs` / `Build errors`) down to two for desktop projects (`Output` / `Build errors`).
- **Run button label**: "Run" → "Run program" while stopped, "Stop" while running. (Web today uses "Run" → "Stop" — same wording works.)
- **Status pill**: web shows "running on :5180". Desktop shows "running (PID 1234)" / "exited (code 0)" / "exited (code 1)" so the student can tell whether the program exited normally or crashed.
- **No `requestSnapshot()`**. The `ProjectPreview.requestSnapshot()` method is iframe-specific. For desktop, return `null` so `evaluateProjectCode` skips the `[DOM]` and `[CONSOLE]` blocks.
- **Reload + open-in-tab buttons**: hide for desktop projects (no URL to reload, nothing to open externally — the WPF window itself is the program).

Implementation: branch on `runtime.kind` inside `createProjectPreview()`. Two render functions sharing common helpers (status pill, log SSE subscription, run/stop wiring) is cleaner than one function with `if`s threaded throughout.

### Generalize Send-to-tutor (`evaluateProjectCode` in `main.ts`)

Today it bundles `[FILES] + [DOM] + [CONSOLE] + [SERVER]`. For desktop:

- `[FILES]` — same logic, just iterates over open `.cs` / `.xaml` / `.csproj` tabs
- `[DOM]` — omit (no rendered HTML)
- `[CONSOLE]` — omit (no iframe; whatever the program writes to stdout is in `[SERVER]`)
- `[SERVER]` — same, fetches recent log lines from `/proj/logs/recent`. For desktop, this is the program's stdout/stderr.

Branch on `lang.runtime.kind`. The web prompt explains all four blocks; the C# prompt should explain only `[FILES]` + `[SERVER]` and tell the model to ask for screenshots / paste-output if it needs runtime UI behavior.

### Scaffold

A minimal WPF project under `projects/csharp/`:

```
projects/csharp/
  csharp.csproj         # net8.0-windows, UseWPF=true
  App.xaml              # Application + StartupUri="MainWindow.xaml"
  App.xaml.cs
  MainWindow.xaml       # one Grid + a TextBlock + a Button
  MainWindow.xaml.cs    # button click handler that updates the TextBlock
  Program.cs            # only if the student asks; WPF auto-generates Main otherwise
  README.md             # what each file does, how `dotnet run` works
```

The `.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

`UseWPF=true` is the magic flag — turns on the WPF SDK without needing `<UseWindowsForms>` etc. Targets `net8.0-windows` because WPF requires the Windows-specific framework.

When the curriculum hits MVVM (Phase 3 of the topics), the lesson walks the student through adding `CommunityToolkit.Mvvm` via `dotnet add package`. The supervisor doesn't need to know — `dotnet run` re-restores on next invocation.

### Editor: XAML highlighting

`@replit/codemirror-lang-csharp` covers `.cs`. For `.xaml` files in the multi-tab project editor, use `@codemirror/lang-xml` (already a CodeMirror first-party package — likely already pulled in transitively by `@codemirror/lang-html`; if not, add it).

In [src/projectEditor.ts](src/projectEditor.ts) (or wherever the per-file extension lookup lives), add the extension map:

```ts
case 'xaml':
  return xml();
case 'cs':
  return csharp();
case 'csproj':
  return xml();  // .csproj is XML
```

### File watcher / tree-ignore

The chokidar watcher in `tools/projects.mjs` ignores anything matching `TREE_IGNORE`. This is currently a module-level constant. With the per-language config table (above), `TREE_IGNORE` becomes per-language: web = `node_modules / .git / dist / .vite`, csharp = `bin / obj / .vs`. The watcher reads the active language's set when fanning out events.

Both the chokidar `ignored` callback and the `buildTree` traversal need to consult the per-language ignore. Currently both reference `TREE_IGNORE` — refactor to take the lang as a parameter.

### Storage keys (already done in M1 of the web work)

- `historyKey('csharp')`, `progressKey('csharp')` work unchanged
- `openTabsKey('csharp')`, `activeTabKey('csharp')`, `treeStateKey('csharp')` work unchanged
- `codeKey('csharp')` becomes unused once we flip to project mode (files live on disk)

The Phase 1 → Phase 2 transition for an existing user means: their localStorage `lang-tutor:csharp:code` (single-buffer scratch) is orphaned. Wipe it during the same migration that adds the project workspace, or just leave it — it's harmless.

## Milestones

### M1 — Architecture refactor (no user-visible change for `web`)

Foundation. Web should keep working identically; C# stays single-buffer.

- [ ] Add `ProjectRuntime` discriminated union to [src/types.ts](src/types.ts); `WEB.runtime = { kind: 'web-vite', port: 5180 }`.
- [ ] Refactor [tools/projects.mjs](tools/projects.mjs) to read from a `PROJECT_CONFIG` table: `install`, `dev`, `readiness`, `treeIgnore`, `bootstrap` per language. Keep the web entry's behavior byte-identical.
- [ ] Generalize `injectBootstrap()` so it's a no-op when `bootstrap` is `null`.
- [ ] Generalize the chokidar `ignored` callback + `buildTree` to take a per-language ignore set.
- [ ] Generalize the readiness probe: `http-probe` (existing) and `process-alive` (new — resolves once the spawned child has been alive for ~500 ms without exiting).
- [ ] Refactor [src/projectPreview.ts](src/projectPreview.ts) to branch on `runtime.kind`: web path stays as-is; desktop path is a stub that throws "not implemented" for now.
- [ ] `pnpm typecheck` + `pnpm lint` + manual smoke-test of the web course end-to-end (start Vite, open files, edit + save, send-to-tutor with [DOM]).

### M2 — C# scaffold + supervisor

Backend can spawn `dotnet run` for the C# project workspace. Frontend not yet wired.

- [ ] Switch `CSHARP.kind` from `'single'` to `'project'` in [src/constants.ts](src/constants.ts). Add `runtime: { kind: 'desktop-process' }`. Add `scaffoldDir: 'csharp'`.
- [ ] Bake the WPF scaffold (csproj + App.xaml + MainWindow.xaml + .cs files + README) into [tools/projects.mjs](tools/projects.mjs) as a constant template, parallel to `SCAFFOLD_WEB`.
- [ ] Add `csharp` to `PROJECT_CONFIG` (install: `dotnet restore`, dev: `dotnet run`, readiness: `process-alive`, ignore: `bin / obj / .vs`, bootstrap: `null`).
- [ ] Detect missing `dotnet` CLI: if `spawn` returns ENOENT, push a friendly system log line ("dotnet SDK not found — install from https://aka.ms/dotnet/download and restart the dev server") and mark phase = `error`.
- [ ] Manual test: `curl -X POST /proj/start -d '{"lang":"csharp"}'` opens the WPF MainWindow on the desktop. `/proj/stop` kills it. `/proj/logs?lang=csharp` streams stdout/stderr. `/fs/list?lang=csharp` returns the tree without `bin/`/`obj/`.

### M3 — C# preview pane

Frontend gets a working "Output" pane for desktop projects.

- [ ] Implement the desktop-mode branch in [src/projectPreview.ts](src/projectPreview.ts):
  - Tabs: `Output` (primary) | `Build errors`
  - `Output` tab = SSE log stream (same source as web's "Server logs" tab), with stderr lines styled red and system lines styled italic-muted
  - `Build errors` tab: lines matching `error CS\d+:` (C# compiler errors) or `error MSB\d+:` (MSBuild errors); count badge when populated
  - Status pill: "stopped" / "starting" / "running (PID N)" / "exited (code N)"
  - Hide Reload + Open-in-tab buttons (no URL)
  - `requestSnapshot()` returns `null`
- [ ] Wire Run/Stop button to the existing `/proj/start` and `/proj/stop` endpoints (no new endpoints needed — the supervisor abstraction handles both project types).
- [ ] When a `dotnet run` process exits on its own (user closed the WPF window), the status pill auto-updates via the existing exit handler. Confirm this works without the polling loop assuming an HTTP probe.
- [ ] Visual check: switch to C#, click Run, WPF window appears on desktop, output streams into the Output tab, click Stop or close the window → status flips to "exited".

### M4 — XAML editor support

Multi-file editor handles `.xaml` and `.csproj` correctly.

- [ ] Add `@codemirror/lang-xml` to dependencies (if not already present transitively).
- [ ] In the per-file extension lookup in [src/projectEditor.ts](src/projectEditor.ts) (or wherever it lives — search for `.html` case), add `xaml` → `xml()`, `cs` → `csharp()`, `csproj` → `xml()`.
- [ ] In [src/main.ts](src/main.ts) `fenceLangFromPath`, add `xaml` → `xml`, `cs` → `csharp`, `csproj` → `xml` so Send-to-tutor uses the right fence labels.

### M5 — Send-to-tutor for desktop projects

Project-mode `evaluateProjectCode()` works for both project shapes.

- [ ] Branch on `lang.runtime.kind` in `evaluateProjectCode()`. For `desktop-process`:
  - Build `[FILES]` block as today (open tabs, dirty marked)
  - Skip `[DOM]` and `[CONSOLE]` blocks
  - Build `[SERVER]` block as today (recent log lines)
  - Concatenate just `[FILES] + [SERVER]`
- [ ] Rewrite the C# `systemPromptIntro` to describe the new shape: the student is in a project workspace at `projects/csharp/`, file tree + tabs available, Run button launches a real WPF window on their desktop, Send-to-tutor bundles `[FILES] + [SERVER]` (no DOM, no iframe), ask for screenshots if you need to see UI behavior.
- [ ] Update the C# `firstSessionPrompt` accordingly (mention the project workspace).
- [ ] Data migration: existing users who started Phase 1 will have a `lang-tutor:csharp:code` localStorage entry. On first load after the upgrade, delete it (it's a single-buffer artifact — no longer relevant). Add a one-shot migration in `migrateOldStorage()` or similar.

### M6 — Polish

- [ ] First-`dotnet restore` UX: scaffolding + restore can take 30+s on cold cache. Show a friendly "restoring NuGet packages (one-time, can take a minute)…" → "ready" sequence in the Output tab.
- [ ] Build error styling: clickable line-number jumps from the `Build errors` tab into the editor. (Stretch — needs a parser for the `Foo.cs(12,5): error CS0103: ...` format. Can defer.)
- [ ] Reset button for `csharp`: confirm ("This will delete projects/csharp/ and re-scaffold. Continue?"), stop the process, delete the folder, re-scaffold.
- [ ] Friendly error states: `dotnet` not on PATH, csproj missing, target framework mismatch (e.g. user changed it to `net6.0`).
- [ ] Update [CLAUDE.md](CLAUDE.md) and [README.md](README.md) — describe the C# project workspace alongside the web one. Both are now `kind: 'project'` languages with different runtimes.

## Out of scope (deferred)

- **In-browser C# execution** (Blazor / Mono.WASM). Not feasible for WPF specifically, and even console-only would require shipping a runtime; not worth it when we have local `dotnet`.
- **WPF rendering inside the app** (Avalonia / browser XAML preview). Same reason — partial-fidelity preview vs. real WPF is more confusing than helpful.
- **Hot reload for WPF**. `dotnet watch` exists but adds complexity and has issues with XAML changes. Stick with stop → edit → run.
- **Multi-project solutions** (`*.sln` with multiple `*.csproj`). The course assumes a single project per workspace.
- **Cross-platform .NET** (Mac/Linux for non-WPF parts of the curriculum). The course is explicitly Windows-flavoured. Modern C# topics still work cross-platform if a user wants to follow along on Mac, but WPF/MVVM don't.
- **Visual designer for XAML**. The student writes XAML by hand. (Visual Studio's designer is the right tool for visual layout work; this app teaches you the markup.)
- **NuGet package management UI**. The student runs `dotnet add package X` in the lessons. No UI affordance needed.

## Risks / open questions

- **Process supervision under HMR**: Vite (in dev mode) restarts when [tools/projects.mjs](tools/projects.mjs) changes. The web supervisor handles this gracefully because `pnpm dev` reconnects via HMR. For C#, a Vite restart would orphan the spawned `dotnet run` child. Verify that the existing supervisor tracks PIDs in a way that survives module reloads, or accept that Vite restarts kill running C# programs (probably acceptable for a dev tool).
- **`dotnet run` cold start**: 5–15 seconds for a fresh build. The "process-alive" readiness probe (~500 ms) will declare the project "ready" before the WPF window actually opens. UX: show "starting…" through the build phase by parsing the log stream for `Build succeeded.`, then flip to "ready".
- **WPF window focus**: when the user clicks Run, the WPF window appears on top. They have to alt-tab back to the browser. Acceptable, but worth noting in the lesson copy.
- **Dotnet SDK version pinning**: `<TargetFramework>net8.0-windows</TargetFramework>` requires the .NET 8 SDK. If the student has only .NET 6 or .NET 7 installed, `dotnet restore` will fail with a clear-ish error. The friendly-error pass in M6 should detect this and surface a "install .NET 8 SDK" hint.
- **XAML namespace declarations are noisy**: every XAML file starts with `xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"` etc. The lessons should explain these once and then treat them as boilerplate. (Not a code concern, just a curriculum note for the tutor prompt.)
- **`bin/` and `obj/` churn**: every `dotnet build` rewrites these directories. The chokidar watcher will fire constantly unless we ignore them properly. M1's per-language ignore set is the fix; verify it actually suppresses watch events for nested paths inside `bin/` and `obj/` (the existing web watcher uses a function-based `ignored` callback that handles nesting).
