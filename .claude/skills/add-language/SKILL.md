---
name: add-language
description: Add a new tutored language to lang-tutor. Walks every file you must touch — LanguageId, LANGUAGES record, language rail, runner (single-buffer) or PROJECT_CONFIG + scaffold (project workspace). Trigger when the user says "add a new language", "tutor X", or invokes /add-language.
disable-model-invocation: true
---

# Adding a new tutored language

This codebase supports two workspace shapes (`src/types.ts`). Pick one before starting:

- **Single-buffer** (`rust`/`cpp`/`python` today): one editor, one Run, code runs through a remote sandbox or in-browser runtime. No on-disk project.
- **Project workspace** (`csharp`/`web` today): on-disk project under `projects/<lang>/`, multi-tab editor, supervised process for `pnpm dev` / `dotnet run` / etc.

Ask the user which shape they want if it isn't obvious.

## Before starting — read these

- `src/constants.ts` — see the exact shape of an existing `LANGUAGES` entry. Match the closest existing language to the new one (Go → cpp; Lua → python; Tauri → web; etc.).
- `src/types.ts` — `LanguageId`, `LANGUAGE_IDS`, `Language`, `SingleBufferLanguage`, `ProjectLanguage`, `WebProjectRuntime`, `DesktopProjectRuntime`.
- `src/main.ts` — `evaluateCode()` / `evaluateProjectCode()` — they emit `[CODE]/[OUTPUT]` or `[FILES]/[DOM]/[CONSOLE]/[SERVER]` markers. The `systemPromptIntro` you write must describe the right markers for the runtime you pick.
- For project languages: `tools/projects.mjs` — `PROJECT_CONFIG` and `ensureScaffold` for the closest existing language.

## Common steps (both shapes)

1. **`src/types.ts`** — add the new id to the `LanguageId` union AND to `LANGUAGE_IDS` array. They must stay in sync; the array is used for migration / iteration.
2. **`src/constants.ts`** — add a new entry to `LANGUAGES`. Required:
   - `id`, `kind`, `label`, `topics: string[]`, `firstSessionPrompt`, `systemPromptIntro` (lesson plan + describe to the model the marker format it will receive — copy from an existing language with the same workspace shape and adapt).
3. **`index.html`** — add a button to the language rail (`#langRail`) with `data-lang="<id>"`. Match the existing pattern (icon, label, ARIA).
4. **`src/editor.ts`** — register a CodeMirror language pack for syntax highlighting in the `LANG_PACKS` map (or wherever the compartment is fed). If no pack exists in `@codemirror/lang-*`, fall back to plain text and document.

## Single-buffer-only

5. Add `starterCode`, `fileName`, `fenceLang` to the LANGUAGES record. The `fenceLang` value MUST match what `evaluateCode()` writes inside the ` ```{fenceLang} ` fence — Claude reads this to know how to interpret submissions.
6. Add a runner in `src/runners.ts`: a function returning `Promise<{ ok: boolean; output: string }>`. Wire into `runCode()`'s dispatch table.
7. (Optional) Add `/check` and `/format` cases in `tools/checker.mjs` if a local toolchain exists. Spawn with `child_process.spawn(cmd, args[])` (array form — never shell form). On `ENOENT`, return `{ available: false }` so the editor silently disables the feature.

## Project-workspace-only

5. Add `scaffoldDir` and `runtime` to the LANGUAGES record. `runtime` is one of:
   - `{ kind: 'web-vite', port: <number> }` — HTTP-served preview (iframe). Pick a port not already used by the user's tutor (web is on 5180).
   - `{ kind: 'desktop-process' }` — native window or TUI; no iframe, the process opens its own UI.
6. **`tools/projects.mjs`** — add a `PROJECT_CONFIG[<id>]` entry:
   - `scaffoldDir` — must match the LANGUAGES record.
   - `install` and `dev` — each `{ cmd, args[] }`. On Windows, prefer `pnpm.cmd` / `dotnet.exe` resolution. **Verbosity matters**: `dotnet run` defaults to quiet under non-TTY stdout (no output until exit). Pass `--verbosity minimal` or equivalent.
   - `readiness` — `{ kind: 'http-probe', port: N }` for HTTP servers; `{ kind: 'process-alive', minAliveMs: N }` for desktop processes (typically 500 ms).
   - `treeIgnore` — paths to hide in the file tree (`node_modules`, `bin`, `obj`, `target`, etc.).
   - `bootstrap` — set to `'web-iframe'` to inject the parent-postMessage shim used by the DOM snapshot capture; omit for desktop runtimes.
7. **`tools/projects.mjs` `ensureScaffold`** — add a scaffold template that writes the minimal project files. Reuse the existing csharp / web scaffold pattern.
8. **`src/projectPreview.ts`** — only edit if introducing a new `runtime.kind`. Today only `web-vite` and `desktop-process` are handled (`createWebVitePreview` / `createDesktopPreview`). A new kind needs its own branch in `createProjectPreview()`.

## Verification

```powershell
pnpm typecheck    # MUST pass
pnpm lint         # MUST pass (auto-fixes via biome --write)
pnpm dev          # smoke-test in browser
```

In the browser:
1. Click the new language tab — start screen renders, first lesson kicks off.
2. (Single-buffer) Type starter code, click Run, confirm output / errors flow through.
3. (Project) Click Run, watch the status pill advance to `running` (web) or process-alive (desktop). Click Stop, confirm graceful shutdown. Click Reset, confirm the on-disk folder is wiped and re-scaffolded.
4. Switch to another language, then back — confirm history/progress are preserved per-language.

## If you're renaming or replacing a language

Add a cleanup line to `migrateOldStorage()` in `src/main.ts` that deletes the old keys (`historyKey`/`progressKey`/`codeKey`/`openTabsKey`/`activeTabKey`). See the existing csharp single-buffer cleanup (the C# course shipped as single-buffer in Phase 1, then became project-shaped) as a template.

## Watch out for

- **Per-language storage namespacing**: `lang-tutor:{lang}:*` keys. Don't share state across languages.
- **Async language-switch races**: any async work (Claude calls, code runs, progress extraction) must capture `langWhenStarted = activeLang` and bail if the user switched mid-flight.
- **System prompt ↔ evaluate format contract**: if you describe `[CODE]/[OUTPUT]` in `systemPromptIntro` but the runtime emits `[FILES]/[DOM]`, the tutor silently misreads submissions. Match what the actual emitter for that workspace shape sends.
