# Lang tutor

A single-page, multi-language programming tutor. You chat with Claude (via the Anthropic API), write code in an inline editor with full IDE features (syntax highlighting, autocomplete, multi-cursor, alt+up/down line moves, Ctrl+F search, Ctrl+S format-on-save, live error checking via local toolchains), run it through a language-appropriate runtime, and submit code+output for evaluation. Lesson progress is extracted by a second LLM call into structured JSON and persisted in `localStorage`, **independently per language**.

Switch language at any time from the topbar — each language has its own conversation history, lesson progress, and saved editor content.

## Quick start (Windows)

One-shot setup that installs all runtimes via winget, fetches dependencies, and opens the app in your browser:

```powershell
.\scripts\setup.ps1
```

It's idempotent — checks each tool first and only installs what's missing. First run takes 5–10 minutes (downloads); subsequent runs are seconds. After it finishes installing it'll prompt you for `ANTHROPIC_API_KEY` if `.env` isn't set, then start the dev server and open `http://localhost:5173`.

## Languages

| Language | Lesson focus | Run target | Live errors | Format on save |
|----------|--------------|------------|-------------|----------------|
| **Rust** | Beginner-to-intermediate fundamentals | [Rust Playground](https://play.rust-lang.org) | local `rustc` | local `rustfmt` |
| **C++** | STL-first then modern features (C++20/23) for someone coming from a custom no-STL C++ derivative | [Wandbox](https://wandbox.org) (`gcc-head`, `c++23`) | local `clang -fsyntax-only` | local `clang-format` |
| **Python** | Intermediate-to-advanced for C++/C# devs (idioms, generators, decorators, async, GIL) | [Pyodide](https://pyodide.org) — in-browser WebAssembly | local `python ast.parse` | local `black` |

Live error checking and format-on-save are optional — if a toolchain isn't installed, those features silently fall back. The `scripts/setup.ps1` quickstart installs everything for you.

The lesson plan for each language is in `src/constants.ts`. Edit it freely.

## Stack

- **TypeScript** (strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- **CodeMirror 6** for the editor (syntax highlighting, autocomplete, search, lint, fold gutter, multi-cursor)
- **Vite 7** for dev server, HMR, and production builds
- **Tailwind CSS 4** via the `@tailwindcss/vite` plugin (config-in-CSS)
- **Pyodide** for in-browser Python (lazy-loaded from CDN on first run)
- **Biome** for linting and formatting
- **pnpm** for package management
- **Node 20+** runtime for the production proxy (`server.mjs`) and for the `/check` + `/format` toolchain endpoints

Optional local toolchains (auto-detected; gracefully disabled if missing):
`rustc`, `rustfmt`, `clang`, `clang-format`, `python`, `black`.

## Prerequisites

- **Node 20.6+** (uses `--env-file` flag)
- **pnpm** — install with `npm install -g pnpm` if you don't have it
- An **Anthropic API key**

## Setup

```powershell
# 1. Install dependencies
pnpm install

# 2. Create your .env from the example, then fill in your key
copy .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

## Development

The Vite dev server proxies `/v1/messages` to `https://api.anthropic.com`, injecting your API key from `.env` so it never reaches the browser. HMR is on for `.ts` and `.css` changes.

```powershell
pnpm dev
```

Open the URL Vite prints (default `http://localhost:5173`).

**Windows Ctrl+C tip:** `pnpm dev` is invoked through a `.cmd` wrapper, so Ctrl+C triggers the *"Terminate batch job (Y/N)?"* prompt. Use `.\dev.ps1` instead — it runs Vite via Node directly so Ctrl+C kills it cleanly. Same idea for the production server: use `.\serve.ps1` instead of `pnpm serve`.

## Production

Build the static bundle, then run the Node proxy server which serves `dist/` and proxies API calls.

```powershell
pnpm build      # type-checks, then builds to dist/
pnpm serve      # node --env-file=.env server.mjs
```

Open `http://localhost:3000` (override with `$env:PORT = "8080"; pnpm serve`).

## Other commands

```powershell
pnpm typecheck  # tsc --noEmit
pnpm lint       # biome check --write . (lint + format)
pnpm preview    # vite preview (preview the production build via Vite)
```

## Project structure

```
.
├── src/
│   ├── main.ts        Entry: state, session control, language switching, event wiring
│   ├── editor.ts      CodeMirror 6 setup (theme, syntax highlight, lint, format-on-save)
│   ├── lint.ts        Frontend client for /check + /format
│   ├── api.ts         Claude API calls (chat + progress extraction, streaming)
│   ├── runners.ts     Code execution dispatch (Rust Playground / Wandbox / Pyodide)
│   ├── render.ts      Markdown rendering, message DOM construction
│   ├── storage.ts     localStorage wrapper
│   ├── constants.ts   LANGUAGES record (topics, prompts, starter code), storage-key helpers
│   ├── types.ts       TypeScript interfaces
│   └── style.css      Tailwind import + design tokens + component classes
├── tools/
│   └── checker.mjs    Backend: spawns rustc/clang/python/rustfmt/clang-format/black
├── scripts/
│   └── setup.ps1      One-shot Windows setup (installs runtimes, opens browser)
├── index.html         Vite entry HTML
├── vite.config.ts     Dev server proxy + Tailwind plugin + /check + /format middleware
├── tsconfig.json      Strict TypeScript config
├── biome.json         Lint + format config
├── server.mjs         Production server (serves dist/ + /v1/messages + /check + /format)
├── dev.ps1            Run the dev server bypassing pnpm.cmd (clean Ctrl+C)
├── serve.ps1          Run the production server bypassing pnpm.cmd
└── .env               ANTHROPIC_API_KEY (gitignored)
```

## How it works

### Per-language state

Each language has its own `localStorage` namespace:

- `lang-tutor:active` — currently selected language (`rust` | `cpp` | `python`)
- `lang-tutor:{lang}:history` — last 30 messages
- `lang-tutor:{lang}:progress` — structured progress blob (topic statuses, strengths, struggles, notes)
- `lang-tutor:{lang}:code` — saved editor content

Switching language saves the current editor content, then loads everything for the new language. Conversations are non-destructive — switching back restores exactly where you were.

### Two LLM call sites

Both POST to the local `/v1/messages` proxy:

1. `callClaude()` — the tutoring conversation. Uses a system prompt built from the active language's `systemPromptIntro`, lesson plan, strengths, struggles, and resume context.
2. `fetchProgressExtraction()` — fires after each `evaluateCode()`. Sends the last 14 messages with a strict JSON-output prompt; the result is merged with prior progress and persisted under the active language's key.

### Code execution

- **Rust** → direct browser `fetch` to `https://play.rust-lang.org/execute`
- **C++** → direct browser `fetch` to `https://wandbox.org/api/compile.json` (gcc-head, `-std=c++23`)
- **Python** → Pyodide. Lazy-loaded on first Run click (~15 MB initial download from CDN, cached aggressively after). Subsequent runs are fast.

### Evaluate flow

`evaluateCode()` formats the editor contents and last output as a `[CODE]…[OUTPUT]…` user message in a code fence appropriate to the active language (`rust` / `cpp` / `python`), sends it through the normal chat path, then triggers progress extraction.

## Notes

- The `.env` file is gitignored. Never commit a real key.
- The Anthropic model ID is in `src/constants.ts` as `CLAUDE_MODEL`.
- Resetting progress only affects the **active** language. Switch first if you want to reset a different one.
- Pyodide auto-loads any standard-library packages it detects in your import statements (`numpy`, `pandas`, etc.) on first use.
- C++ compiles run on Wandbox's shared infrastructure — expect 1–3 s per run.
- The XSS-safe DOM construction means you can paste arbitrary content from the AI without risk.
