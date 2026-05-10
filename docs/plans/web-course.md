# Web course (full-stack)

Adding a fourth "language" entry — a full-stack web development course — to the lang-tutor app. Unlike the existing Rust/C++/Python entries, this is a multi-file project with a long-lived dev server and an iframe preview, not a single-buffer code blob with stdout.

## Decisions (signed off)

- **Stack**: Vanilla (HTML/CSS/JS) → TS & tooling → React → Hono → SQLite (`better-sqlite3`).
- **Storage**: On-disk under a `projects/` folder at repo root, owned by the dev/prod server. Not in `localStorage`.
- **Project model**: One persistent workspace per "language" (`projects/web/`). Lessons add features on top; reset wipes the whole workspace. Single `node_modules`.
- **File UI**: Sidebar tree on the left, tab strip above the editor. Standard editor UX.
- **Run model**: One long-lived dev server. Vite handles frontend HMR. Backend (Hono) restarts on file save. Iframe stays mounted, no kill-on-rerun.
- **Evaluate**: DOM snapshot + recent server stdout + recent browser console logs. Iframe-injected script serializes the rendered DOM and buffers `console.*` calls; `evaluateCode()` posts a request, gathers the reply, and sends `[FILES] [DOM] [CONSOLE] [SERVER]` blocks to Claude.

## Curriculum

Numbered topics (the `topics: Topic[]` array on the new `web` entry). Phase headers are documentation only — the type doesn't model phases.

### Phase A — Vanilla web (no build step)

- [ ] `html-structure` — HTML structure & semantic elements
- [ ] `css-box` — CSS: selectors, specificity, the box model
- [ ] `css-layout` — CSS: flexbox & grid
- [ ] `css-responsive` — Responsive design & media queries
- [ ] `js-basics` — JS in the browser: variables, functions, control flow
- [ ] `js-dom` — DOM manipulation & events
- [ ] `js-fetch` — `fetch`, async/await, JSON

### Phase B — TypeScript & tooling

- [ ] `ts-basics` — TypeScript: types, interfaces, generics
- [ ] `vite` — Vite, ES modules, npm/pnpm
- [ ] `biome` — Biome lint/format

### Phase C — React

- [ ] `react-jsx` — Components, JSX, props
- [ ] `react-state` — `useState`, `useEffect`, derived state
- [ ] `react-forms` — Forms & controlled inputs
- [ ] `react-compose` — Composition, lifting state, custom hooks
- [ ] `react-router` — Client-side routing

### Phase D — Hono backend

- [ ] `hono-basics` — Hono routes, request/response, middleware
- [ ] `hono-validation` — Zod validation
- [ ] `sqlite` — SQLite via `better-sqlite3` & migrations
- [ ] `crud` — End-to-end CRUD endpoints

### Phase E — Glue

- [ ] `frontend-backend` — Frontend ↔ backend integration patterns
- [ ] `auth` — Sessions, cookies, basic auth
- [ ] `deploy` — Deployment mental model (Node host, env vars, `pnpm build`)

## Architecture

### Discriminated union for `Language`

The current `Language` interface assumes a single buffer with one filename, one fence language, and one starter blob. The web course needs a project tree. Cleanest fit: discriminated union, gated on `kind`.

```ts
// types.ts
export type LanguageId = 'rust' | 'cpp' | 'python' | 'web';

export interface SingleBufferLanguage {
  readonly kind: 'single';
  readonly id: LanguageId;
  readonly name: string;
  readonly fileName: string;
  readonly fenceLang: string;
  readonly starterCode: string;
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}

export interface ProjectLanguage {
  readonly kind: 'project';
  readonly id: LanguageId;
  readonly name: string;
  readonly scaffoldDir: string;          // relative to projects/, e.g. 'web'
  readonly topics: readonly Topic[];
  readonly systemPromptIntro: string;
  readonly firstSessionPrompt: string;
}

export type Language = SingleBufferLanguage | ProjectLanguage;
```

Existing `rust`/`cpp`/`python` entries get `kind: 'single'`. Code paths in `main.ts` that touch `starterCode`/`fileName` get gated on `kind === 'single'`.

### New storage keys

- `lang-tutor:web:openTabs` — array of relative file paths currently open
- `lang-tutor:web:activeTab` — relative file path of the focused tab
- `lang-tutor:web:tree-state` — collapsed/expanded folders (UI state only)

`historyKey('web')` and `progressKey('web')` work unchanged. `codeKey('web')` is unused — files live on disk.

### Server endpoints (new)

All scoped to a single `projects/<scaffoldDir>/` root with strict path-traversal rejection.

- `GET  /fs/tree?lang=web` → `{ tree: FsNode }`
- `GET  /fs/file?lang=web&path=…` → `{ content: string }`
- `PUT  /fs/file` body `{ lang, path, content }` → `{ ok }`
- `POST /fs/rename` body `{ lang, from, to }` → `{ ok }`
- `DELETE /fs/file` body `{ lang, path }` → `{ ok }`
- `POST /fs/mkdir` body `{ lang, path }` → `{ ok }`
- `POST /proj/start` body `{ lang }` → `{ ok, vitePort, honoPort? }`
- `POST /proj/stop`  body `{ lang }` → `{ ok }`
- `GET  /proj/status?lang=web` → `{ running, vitePort?, honoPort?, ready }`
- `GET  /proj/logs?lang=web` (SSE) → streams `{ stream: 'vite'|'hono', line }`

Path safety: every `path` is `path.resolve(projectRoot, p)` then checked `startsWith(projectRoot + sep)` before any FS call.

### Process supervision

A new `tools/projects.mjs` module (parallel to `tools/checker.mjs`) handles:

- Lazy `pnpm install` on first start (streamed to logs)
- `spawn('pnpm', ['vite'], { cwd })` for the frontend, fixed port (e.g. 5180)
- Once Hono lands in the curriculum: `spawn('pnpm', ['tsx', 'watch', 'server.ts'], { cwd })` on a fixed port (5181), with Vite proxying `/api` to it
- Stream stdout/stderr to in-memory ring buffers per stream + push to active SSE clients
- On process exit, mark `running: false`. On user-triggered stop, send SIGTERM then SIGKILL after a grace period.
- Single supervisor instance per `LanguageId` — start while running is a no-op.

### Initial scaffold

Phase A is vanilla — no build step. The scaffold under `projects/web/` for a fresh start is just:

```
projects/web/
  index.html
  style.css
  app.js
  package.json   # for `pnpm vite` to serve with HMR
  README.md      # what each file does
```

`package.json` has `vite` as the only dep, root pointing at the project folder. `pnpm vite` serves it on the fixed port.

When the curriculum hits Phase B (TypeScript & tooling), the lesson walks the student through migrating to a TS+Vite proper setup. The migration is part of the lesson, not a magical re-scaffold. When Phase D hits Hono, same pattern — student adds Hono themselves under Claude's guidance, supervisor adapts via the same `package.json` script names.

This keeps the supervisor dumb: it always runs `pnpm dev`. Whatever `pnpm dev` does is up to the project files.

### Iframe & evaluate flow

`projects/web/index.html` includes a small bootstrap script (template-managed, kept across resets) that:

1. Buffers the most recent N `console.*` calls into a ring buffer.
2. Listens for `window.message` of type `lang-tutor:snapshot-request`.
3. Replies with `postMessage({ type: 'lang-tutor:snapshot-reply', requestId, dom: document.documentElement.outerHTML, console: [...buffer] })` to the parent.

Parent code (`main.ts` evaluate path for `kind === 'project'`):

1. Generate a `requestId`, `iframe.contentWindow.postMessage(...)`.
2. Race on a `MessageEvent` listener with a 1500 ms timeout.
3. Read open files via tab state.
4. Read recent server stdout (last 200 lines) via a new `GET /proj/logs/recent` endpoint.
5. Format:
   ```
   [FILES]
   --- index.html ---
   ...
   --- app.js ---
   ...

   [DOM]
   ...

   [CONSOLE]
   ...

   [SERVER]
   ...
   ```
6. Send through normal chat path. Progress extraction uses the web entry's topics array.

The bootstrap script is appended to `index.html` on every project start (idempotent — checks for a marker comment first), so even if the student deletes it accidentally it comes back.

## Milestones

### M1 — Server-side workspace & process supervision

Foundation. Nothing user-visible yet beyond the new dropdown option showing a "scaffolding…" placeholder.

- [x] Add `projects/` to `.gitignore`
- [x] Create `tools/projects.mjs` with: scaffold, fs CRUD (tree/read/write/rename/delete/mkdir), path-safety helper
- [x] Bake the Phase A vanilla scaffold into `tools/projects.mjs` as a constant template (HTML/CSS/JS + `package.json` + `README.md`)
- [x] Process supervision: lazy `pnpm install`, spawn `pnpm dev`, log ring buffer, port readiness probe (poll `http://localhost:5180/` until 200), graceful stop
- [x] Wire fs + project endpoints into `vite.config.ts` (dev middleware) and `server.mjs` (production)
- [x] Manual test: `curl` each endpoint end-to-end (scaffold + tree + read/write roundtrip + path-traversal rejection)
- [x] Refactor `Language` to discriminated union; add `web` `ProjectLanguage` entry to `LANGUAGES` and `LANGUAGE_IDS`.
- [x] Add `<button data-lang="web">` to `index.html`. Selecting it hides the single-buffer editor chrome and shows a project-mode placeholder; chat + start screen remain functional.

### M2 — Frontend project type plumbing

- [x] Refactor `Language` to discriminated union (`kind: 'single' | 'project'`). Update `types.ts`, `constants.ts`. *(landed in M1 — needed for compilation.)*
- [x] Gate every site that touches `.starterCode`/`.fileName`/`.fenceLang` in `main.ts` on `kind === 'single'`. *(landed in M1.)*
- [x] `loadLanguageState` branches: for `project`, fetch tree + restore open tabs from storage, hydrate state, render placeholder stats.
- [x] Storage helpers: `openTabsKey(lang)`, `activeTabKey(lang)`, `treeStateKey(lang)`.
- [x] Frontend FS client: `src/projectApi.ts` (`fetchTree`, `fetchFile`, `writeFile`, `renameFile`, `deleteFile`, `mkdir`, `startProject`, `stopProject`, `getStatus`, `flattenFiles`).
- [x] `migrateOldStorage` is unchanged (already only handles `rust-*` legacy keys).

### M3 — Editor UI: tree + tabs

- [x] Sidebar tree component built with `document.createElement` (no innerHTML). Click to open file in a new tab; if already open, focus that tab.
- [ ] Context menu (or simple +/− buttons) for new file, new folder, rename, delete. *(Deferred — folded into M4 polish.)*
- [x] Tab strip above editor: shows file name (with dirty dot), close button, click to focus.
- [x] CodeMirror language detection by file extension (`.html`, `.css`, `.js`/`.jsx`/`.ts`/`.tsx`, `.json`, `.md`). Added the corresponding `@codemirror/lang-*` deps.
- [x] Save flow: 600 ms debounced PUT per dirty buffer. Ctrl+S flushes all dirty buffers immediately.
- [x] Per-file `EditorState` cached in `tabs: Map<path, TabState>` — switching tabs preserves cursor, scroll, undo history. Update listener threaded through every per-file state since `view.setState()` replaces extensions wholesale.

### M4 — Preview pane & dev loop

- [x] Tabbed preview pane below the editor: **Preview** | **Server logs** | **Build errors** (count badge when populated). Single-buffer `<pre id="outputPre">` stays for `kind === 'single'`.
- [x] Preview tab: sandboxed `<iframe>` loaded with `http://127.0.0.1:5180/`. Reload + open-in-new-tab buttons.
- [x] Server logs tab: SSE-driven append-only console. stderr → red, system → italic muted.
- [x] Build errors tab: stderr lines + lines matching `/\bERROR\b/i`, `/^✘/`, `/\bFAILED\b/`, `/Error:/` (lightweight pattern-based heuristic).
- [x] Run/Stop button calls `/proj/start` / `/proj/stop`. Status pill shows "running on :5180" / "starting" / "stopped" / error. Auto-reconciles via `getStatus` poll if the dev server dies on its own.
- [x] Resizable preview height (drag bar between editor and preview, double-click to reset). Persisted in localStorage.
- [x] Windows fix: `spawn(.cmd, …)` requires `shell: true` since Node 20 (CVE-2024-27980). Args are hardcoded constants so no injection risk.

### M5 — Evaluate flow for projects

- [ ] Inject the snapshot bootstrap script into `projects/web/index.html` on every `/proj/start` (idempotent via marker comment).
- [ ] In `main.ts`, branch `evaluateCode()` on `kind`. For `project`: gather files (open tabs), DOM snapshot via `postMessage`, recent console buffer (in the snapshot reply), recent server stdout via `/proj/logs/recent?lang=web&n=200`.
- [ ] System prompt for `web` mentions the `[FILES] [DOM] [CONSOLE] [SERVER]` block format and tells the model to evaluate all four.
- [ ] Progress extraction unchanged — reads `topics` from the active language entry.
- [ ] Late-arrival guard: capture `langWhenStarted` at the start, drop the result if user switched away.

### M6 — Polish

- [ ] First-start UX: scaffolding shows a friendly "creating workspace at projects/web…" → "installing dependencies (one-time, ~30s)…" → "ready" sequence in the Server logs tab.
- [ ] Reset button for `web` confirms ("This will delete projects/web/ and re-scaffold. Your chat history and progress are kept unless you reset those too. Continue?"), stops the process, deletes the folder, re-scaffolds, restarts.
- [ ] Friendly error states: pnpm not found, port 5180 in use, vite crashed (with a "Restart" button).
- [ ] Update `CLAUDE.md` and `README.md` with the new architecture section.

## Out of scope (deferred)

- Multi-project support (more than one `projects/web/` instance in parallel).
- WebContainers / in-browser Node — we already have a real Node host, no need.
- Headless screenshot via Playwright as a heavier evaluate option (the DOM-snapshot path covers ~95% of teaching needs).
- Auth/sessions for the dev server itself (it's localhost-only by intent).
- Production-build/deploy automation. The `deploy` lesson explains the mental model; actual deploy stays manual.

## Risks / open questions

- **Stable port 5180/5181** — fine for a hobby tool. If they're taken, `/proj/start` returns an error with a clear message; we don't auto-pick because then iframe URL changes break bookmarks/history.
- **Vite restart cost on backend changes** — once Hono lands, restarting `tsx watch` on every save is fine for a dev loop but kills in-memory SQLite state. Use a file-backed SQLite from day one to sidestep.
- **DOM snapshot fidelity** — `outerHTML` doesn't capture canvas pixel content or post-layout computed styles. Acceptable for a teaching tool; a Playwright path remains a fallback for later.
- **`pnpm install` time on first start** — ~30s with cold cache, fine but worth surfacing in the UI.
- **Curriculum cross-cutting concerns** — accessibility, security, testing, deployment thread through everything. The plan's topic list keeps them as standalone topics where possible (e.g. `auth`, `deploy`); finer-grained weaving happens in the system prompt and Claude's discretion, not in the topic schema.
