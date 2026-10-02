# Lang tutor

A single-page, multi-language programming tutor. You chat with your chosen AI provider (Anthropic Claude, OpenAI ChatGPT, or Google Gemini), write code in an inline editor with full IDE features (syntax highlighting, autocomplete, multi-cursor, alt+up/down line moves, Ctrl+F search, Ctrl+S format-on-save, live error checking via local toolchains), run it through a language-appropriate runtime, and submit code+output for evaluation with an optional note about what is confusing you. Lesson progress is extracted by a second LLM call into structured JSON and persisted independently per language.

Switch language at any time from the topbar — each language has its own conversation history, lesson progress, and saved editor content.

## Quick start (Windows)

Prepare this PC to run everything, then check what's ready:

```powershell
.\lt.ps1 setup     # install whatever is missing, then print the readiness report
.\lt.ps1 doctor    # the readiness report only: each capability, ready or missing, and the command that fixes it
```

`setup` is idempotent and needs no admin: it runs `doctor`, installs each missing piece (winget for Node, pnpm, Docker Desktop, .NET SDK, Rust, Python, PowerShell 7 and LLVM; `rustup component add rust-analyzer`; `uv tool install black`; the pinned PowerShell Editor Services bundle into `.local/tools/`; `pnpm install`, which brings the TypeScript, HTML/CSS, Biome and basedpyright language servers; starting Docker and building the toolchain image; the C# Dev Kit for Roslyn when VS Code is installed), then prints the report again. `doctor` runs each tool rather than just finding it on PATH, so a rustup stub for an uninstalled component shows as missing. First run takes 5–10 minutes of downloads; later runs take seconds.

Then use `.\lt.ps1 dev` for development, or `.\lt.ps1 launch` / `.\lt.ps1 stop` to run the built app on demand (see [Running it for real](#running-it-for-real)); `launch` prints a one-line warning when `doctor` finds anything missing.

## Languages

Two workspace shapes:

- **Single-buffer** (Rust / C++ / DASM / Python / PowerShell): one editor, one Run button, one output pane. Lessons are short snippets compiled or interpreted in a local Docker sandbox.
- **Project workspace** (C# / Web): on-disk project under `projects/<lang>/` with a sidebar file tree, multi-tab editor, Run / Send controls above the code, integrated supervisor that runs `dotnet run` / `pnpm dev`, and an Output / preview pane. Edits autosave; the supervisor streams stdout/stderr into the Output tab.

| Language | Workspace | Lesson focus | Run target | Live errors | Format on save |
|----------|-----------|--------------|------------|-------------|----------------|
| **Rust** | single-buffer | Beginner-to-intermediate fundamentals | local Docker sandbox (`rustc`) | local `rustc` | local `rustfmt` |
| **C++** | single-buffer | STL-first then modern features (C++20/23) for someone coming from a custom no-STL C++ derivative | local Docker sandbox (`clang++ -std=c++23`) | local `clang -fsyntax-only` | local `clang-format` |
| **Python** | single-buffer | Intermediate-to-advanced for C++/C# devs (idioms, generators, decorators, async, GIL) | local Docker sandbox (`python3`) | local `python ast.parse` | local `black` |
| **PowerShell** | single-buffer | Cross-platform PowerShell 7: the object pipeline, functions and parameters, error handling, classes, regex, JSON/CSV | local Docker sandbox (`pwsh`) | PSES (parse errors + PSScriptAnalyzer), else local `pwsh` parser | PSScriptAnalyzer `Invoke-Formatter` |
| **C#** | project workspace | Modern C# 12 → WPF fundamentals → MVVM patterns | local `dotnet run` for the WPF project, plus console snippets in Docker | dotnet build (streamed into the Build errors tab) | — |
| **Web** | project workspace | Vanilla HTML/CSS/JS → TS → React → Hono → SQLite | private Vite server, same-origin Preview tab | TS compile via Vite | — |

Live error checking and format-on-save are optional for the single-buffer languages — if a host toolchain isn't installed, those features silently fall back. The Run button uses the local `lang-tutor-toolchains:latest` Docker image built by setup.

The C# workspace requires the .NET 8+ SDK on PATH (the supervisor preflights and prints an install hint if it's missing or the project's `<TargetFramework>` is newer than any installed SDK). The Web workspace requires `pnpm` on PATH.

Each project workspace has an "Open in ▾" launcher in the file-tree header (VS Code · Visual Studio (csharp only) · File Explorer) that delegates to the user's installed editor — handy when the visual XAML designer or a debugger is wanted.

Reset wipes the active language's progress + chat history. For project workspaces it also deletes that user's on-disk language workspace and re-scaffolds it from the template — so a confirmation dialog calls that out explicitly.

The lesson plan for each language is in `src/constants.ts`. Edit it freely.

Progress, chat history, editor buffers, and UI state are mirrored to
`.local/state/local-storage.json` through the local backend in development, or to
the signed-in account database in hosted mode. Browser `localStorage` is still
used as a cache, but provider API keys are explicitly excluded from the server
mirror and account sync.

## Stack

- **TypeScript** (strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlighting, autocomplete, search, lint, fold gutter, multi-cursor)
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via the `@tailwindcss/vite` plugin (config-in-CSS)
- **Docker Desktop** for local sandboxed Rust / C++ / Python / PowerShell / C# console runs
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20+** runtime for the production proxy (`server.mjs`) and for the `/run` / `/check` / `/format` toolchain endpoints

Optional local toolchains (auto-detected; gracefully disabled if missing; `.\lt.ps1 doctor` lists them all): `rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`, `pwsh`, and the machine-level language servers `clangd`, `rust-analyzer` and Roslyn or OmniSharp. The npm-published language servers are project devDependencies.

## Prerequisites

- **Node 20.6+** (uses `--env-file` flag)
- **pnpm** — install with `npm install -g pnpm` if you don't have it
- **Docker Desktop** running Linux containers for local sandboxed code execution
- A provider API key for **Anthropic Claude**, **OpenAI ChatGPT**, or **Google Gemini**

## Setup

```powershell
# 1. Install dependencies
pnpm install

# 2. Optional: create runtime config
copy .env.example .env
```

Open the app, click **AI Provider**, choose a provider, and paste your API key.
The key stays in the browser on that device; it is not stored in `.env`, SQLite,
or any server-side state. After a key is entered, use **Load models** to fetch
that provider's currently available chat/generation models and choose one from
the dropdown.

## Provider Accounts

The AI Provider dialog includes setup links and basic funding guidance:

- **Anthropic Claude**: create an Anthropic Console account, buy usage credits
  from Billing, then create an API key. Start with about **$20** and keep
  auto-reload conservative until usage is predictable.
- **OpenAI ChatGPT**: create an OpenAI platform account, add prepaid credits in
  Billing, then create an API key. Start with about **$20** and set a project
  budget or usage limit.
- **Google Gemini**: create a Google AI Studio key. Gemini may start on free-tier
  usage; paid quota uses Google Cloud Billing rather than prepaid credits, so set
  a budget or alert around **$20**.

## Development

The Vite dev server hosts the app and local toolchain endpoints. AI provider requests are made directly from the browser with the user's own key, so the server never stores provider credentials. HMR is on for `.ts` and `.css` changes.

```powershell
.\lt.ps1 dev
```

Open the URL Vite prints (default `http://localhost:5173`).

**Windows Ctrl+C tip:** `pnpm dev` is invoked through a `.cmd` wrapper, so Ctrl+C triggers the *"Terminate batch job (Y/N)?"* prompt. Use `.\lt.ps1 dev` instead — it runs Vite via Node directly so Ctrl+C kills it cleanly. Same idea for the production server: use `.\lt.ps1 serve` instead of `pnpm serve`.

## Running it for real

`launch` starts the app in the background on demand, and `stop` shuts it down so nothing is left using resources between sessions:

```powershell
.\lt.ps1 launch           # build if needed, start Docker Desktop if needed, serve on http://localhost:3000, open the browser
.\lt.ps1 status           # is it running? is the Docker engine up?
.\lt.ps1 stop             # stop the server and everything it started (project dev servers, LSPs)
.\lt.ps1 stop -Docker     # ...and quit Docker Desktop too
```

`launch` runs `pnpm install` when `node_modules` is missing, rebuilds `dist/` when any of its sources are newer, starts Docker Desktop and waits for the engine, and builds `lang-tutor-toolchains:latest` the first time (several minutes). The server runs hidden; its output goes to `.tmp/serve.log` and `.tmp/serve.err.log`. `-Port <n>` picks another port and `-NoBrowser` skips opening the browser.

Progress, chat history and project workspaces persist under `.local/` in the repo (auth is off by default), so they survive restarts and are shared with `.\lt.ps1 dev`.

To run the server in the foreground instead (Ctrl+C stops it):

```powershell
.\lt.ps1 build      # type-checks, then builds to dist/
.\lt.ps1 serve      # node server.mjs (uses .env if present)
```

When hosting under a path prefix, set `LANG_TUTOR_BASE_PATH` before building so asset URLs and internal API calls include that prefix; `server.mjs` accepts requests with or without it. Set `LANG_TUTOR_REQUIRE_AUTH=true` to require accounts.

## Other commands

```powershell
.\lt.ps1 typecheck  # tsc --noEmit
.\lt.ps1 lint       # biome check --write . (lint + format)
.\lt.ps1 preview    # vite preview (preview the production build via Vite)
.\lt.ps1 toolchain  # build lang-tutor-toolchains:latest for local code runs
```

## Project structure

```
.
├── src/
│   ├── main.ts        Entry: state, session control, language switching, event wiring
│   ├── editor.ts      CodeMirror 6 setup (theme, syntax highlight, lint, format-on-save)
│   ├── lint.ts        Frontend client for /check + /format
│   ├── api.ts         Provider API calls (chat + progress extraction, streaming)
│   ├── runners.ts     Code execution dispatch (/run local sandbox endpoint)
│   ├── render.ts      Markdown rendering, message DOM construction
│   ├── storage.ts     localStorage wrapper
│   ├── constants.ts   LANGUAGES record (topics, prompts, starter code), storage-key helpers
│   ├── types.ts       TypeScript interfaces
│   └── style.css      Tailwind import + design tokens + component classes
├── tools/
│   ├── checker.mjs    Backend: spawns rustc/clang/python/pwsh/rustfmt/clang-format/black
│   └── runner.mjs     Backend: runs single-buffer code in the Docker sandbox image
├── scripts/
│   ├── build-toolchain-image.ps1  Builds lang-tutor-toolchains:latest
│   ├── doctor.mjs     Readiness report behind `lt.ps1 doctor`
│   └── setup.ps1      Installs what doctor reports missing (`lt.ps1 setup`)
├── docker/
│   └── toolchains/    Docker image with Clang/LLVM, Rust, Python, PowerShell, .NET, formatters, and LSPs
├── index.html         Vite entry HTML
├── vite.config.ts     Dev server proxy + Tailwind plugin + /check + /format middleware
├── tsconfig.json      Strict TypeScript config
├── biome.json         Lint + format config
├── server.mjs         Production server (serves dist/ + account/state APIs + /run + /check + /format)
├── lt.ps1             Root helper for dev/build/serve/check workflows
└── .env               Optional runtime config (gitignored)
```

## How it works

### Per-language state

Each language has its own `localStorage` namespace:

- `lang-tutor:active` — currently selected language (`rust` | `cpp` | `dasm` | `python` | `powershell` | `csharp` | `web`)
- `lang-tutor:{lang}:history` — last 30 messages
- `lang-tutor:{lang}:progress` — structured progress blob (topic statuses, strengths, struggles, notes)
- `lang-tutor:{lang}:code` — saved editor content (single-buffer languages only)
- `lang-tutor:{lang}:openTabs` / `:activeTab` — multi-tab UI state (project workspaces only; the files themselves live on disk under `.local/workspaces/<user>/<lang>/`, or under `LANG_TUTOR_WORKSPACE_ROOT` when set)

Switching language saves the current editor content, then loads everything for the new language. Conversations are non-destructive — switching back restores exactly where you were.

### Two LLM call sites

Both use the selected browser-side provider:

1. `callClaude()` — the tutoring conversation. Uses a system prompt built from the active language's `systemPromptIntro`, lesson plan, resume context and the shared learner profile.
2. `fetchMemoryExtraction()` — runs after each turn on a cheaper model. One JSON reply updates the active language's progress and proposes additions or removals for the learner profile; code merges both (topics only advance, lists are deduped and capped, facts you added are never removed by a tutor).

The **Profile** tab shows everything the tutors have noted about you across languages; you can remove any fact or add your own.

### Code execution

- **Rust** → browser `POST /run`, backend runs `rustc --edition=2021` inside `lang-tutor-toolchains:latest`.
- **C++** → browser `POST /run`, backend runs `clang++ -std=c++23` inside `lang-tutor-toolchains:latest`.
- **Python** → browser `POST /run`, backend runs `python3` inside `lang-tutor-toolchains:latest`.
- **PowerShell** → browser `POST /run`, backend runs `pwsh -NoProfile -NonInteractive -File main.ps1` inside `lang-tutor-toolchains:latest`.
- **C#** → local `dotnet run --project LangTutor.Wpf/LangTutor.Wpf.csproj --verbosity minimal` supervised by `tools/projects.mjs`. The default scaffold is `projects/csharp/LangTutor.sln` with `LangTutor.Wpf/` for WPF/XAML work and `LangTutor.Console/Program.cs` for console exercises. The Run button starts the WPF project; status pill shows `restoring NuGet…` → `building…` → `running (PID …)` derived from dotnet's stdout. The WPF window opens on the user's desktop. Stop or close the window → status flips to `stopped` or `exited (code N)`. For non-GUI lessons, the terminal button above the editor runs the active `.cs` file as a temporary console app inside `lang-tutor-toolchains:latest`.
- **Web** → local `pnpm dev` Vite server supervised by `tools/projects.mjs`, rendered into a sandboxed iframe at `http://127.0.0.1:5180/`.

The snippet sandbox uses Docker with `--network none`, a read-only container root, dropped Linux capabilities, `no-new-privileges`, and CPU / memory / process limits. Build or refresh it with `.\lt.ps1 toolchain`.

### Evaluate flow

`evaluateCode()` (single-buffer) formats the editor contents and last output as a `[CODE]…[OUTPUT]…` user message in a fence appropriate to the active language (`rust` / `cpp` / `python` / `powershell`), sends it through the normal chat path, then triggers progress extraction.

`evaluateProjectCode()` (project workspaces) bundles richer context:

- **Web**: `[FILES]` (open tabs) + `[DOM]` (rendered HTML snapshot) + `[CONSOLE]` (recent iframe console / errors) + `[SERVER]` (recent Vite stdout/stderr).
- **C#**: `[FILES]` (open tabs) + `[OUTPUT]` (recent dotnet stdout/stderr including build errors). No DOM/CONSOLE — the tutor system prompt instructs the model to ask for screenshots when UI behaviour matters.

## Notes

- The `.env` file is gitignored. Do not put provider API keys in it.
- Provider models are loaded live from the selected provider after an API key is
  entered. If a saved model disappears from that provider's model list, the app
  warns the user and requires a new selection.
- Resetting progress only affects the **active** language. Switch first if you want to reset a different one.
- Rust, C++, DASM, Python, PowerShell, and C# console snippets run locally in Docker. If Run reports that `lang-tutor-toolchains:latest` is missing, run `.\lt.ps1 toolchain`.
- The XSS-safe DOM construction means you can paste arbitrary content from the AI without risk.

## Glossary

- **PSES**: PowerShell Editor Services, the PowerShell language server (and the host of PSScriptAnalyzer), installed by `.\lt.ps1 setup` into `.local/tools/PowerShellEditorServices/`.
- **Wave**: a group of open plan items that share files or a subsystem, so they ship and are reviewed together. Each wave is a project in the Linear team LANG; `docs/plans/MAIN.md` is a generated snapshot of them.
