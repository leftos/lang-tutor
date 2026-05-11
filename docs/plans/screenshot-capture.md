# Plan: Screenshot capture for Web (iframe) and C# (WPF) project workspaces

## Context

The tutor evaluates project workspaces today by sending text-only payloads to Claude:

- **Web** (`web-vite`): `[FILES]` + `[DOM]` (iframe `outerHTML` via postMessage) + `[CONSOLE]` + `[SERVER]`.
- **C#** (`desktop-process`): `[FILES]` + `[OUTPUT]` (dotnet stdout/stderr). The C# system prompt currently says "if you need to see UI state, ask the student to paste a screenshot" — we want to deliver them automatically.

Closing the gap: include a PNG of the rendered web page or running WPF window in the API request, so Claude can reason about visual layout, focus, error dialogs, and styling — not just DOM structure or stdout text. Manual capture also gets a button for ad-hoc "look at this" attachments outside Evaluate.

## Decisions (already locked)

1. Trigger: **both** auto-attach on Evaluate **and** a manual camera button on the preview header.
2. Web capture: **`html-to-image`** in the iframe, lazy-loaded from a static asset our server hosts (no CDN/internet dep). Reuses the existing postMessage channel.
3. Persistence: **256 px-wide thumbnail only** in localStorage history. Full-res image goes to the API request and is then discarded.
4. WPF capture: **Windows.Graphics.Capture (WGC)** via a small C# helper exe at `tools/wgc-capture/`. Built-on-demand on first capture. Handles `AllowsTransparency` and hardware-accelerated content correctly.

## Implementation

### 1. Type & history shape (`src/types.ts`, `src/api.ts`)

Add discriminated content-block types matching Anthropic's wire format:

```ts
export interface TextBlock { type: 'text'; text: string }
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png'; data: string };
}
export type ContentBlock = TextBlock | ImageBlock;
```

Widen `Message.content` from `string` to `string | ContentBlock[]`. No migration needed — old histories (`{role, content: string}`) remain valid under the union.

`src/api.ts:90 callClaude`:
- Already wraps the **last** message into a block array to attach `cache_control`. Update to: if `content` is already an array, attach `cache_control` to the last **text** block in the array (or, if none, append a 1-char text block — image-only payloads are vanishingly rare here and not worth special-casing). If `content` is a string, keep current behaviour.
- Image blocks in non-final messages pass through untouched.

`src/api.ts:197 fetchProgressExtraction`:
- Currently does `m.content.slice(0, 280)`. Add a tiny helper `messageText(m: Message): string` that extracts text from string or text-block(s), ignoring image blocks (the progress extractor doesn't need images and shouldn't pay tokens for them).

### 2. Web capture path

**Asset shipping.** Add `html-to-image` as a regular `dependency`. Add `scripts/copy-html-to-image.mjs` that copies `node_modules/html-to-image/dist/html-to-image.js` to `public/lang-tutor-assets/html-to-image.js`. Wire as `postinstall` (or `predev` + `prebuild`) in `package.json`. Vite serves `public/` at root automatically; `server.mjs` already serves `dist/`. Same-origin, offline-friendly.

**Bootstrap (`tools/projects.mjs:206-248` `BOOTSTRAP_SCRIPT`).** Add a second message handler for `lang-tutor:screenshot-request`:
- Lazy `import('/lang-tutor-assets/html-to-image.js')` (cache the module promise).
- `htmlToImage.toPng(document.documentElement, { pixelRatio: 1 })` → `dataURL`.
- Resize **inside the iframe** with an offscreen canvas: `fullDataUrl` at max **1568 px** long edge, `thumbDataUrl` at **256 px** wide.
- Reply `lang-tutor:screenshot-reply { requestId, fullDataUrl, thumbDataUrl, error? }`.

Resize in the iframe (not the parent) avoids shipping a multi-MB base64 across postMessage.

**Parent (`src/projectPreview.ts`).** Add `requestScreenshot(): Promise<{ full: string; thumb: string } | null>` next to `requestSnapshot()` (~line 477). Same `requestId`/`message` listener pattern. Timeout **5000 ms** (longer than snapshot; html-to-image walks the DOM and inlines fonts). Expose on the `ProjectPreview` interface.

### 3. C# (WPF) capture path

**Helper exe `tools/wgc-capture/`.** `dotnet new console`. `Program.cs`:
- Args: `--pid <n> --full <path> --thumb <path>`.
- Find HWND: `EnumWindows`, filter to top-level visible windows whose `GetWindowThreadProcessId` matches `--pid` **or** any direct child PID (a `dotnet run` SDK-style WinExe project usually keeps the same PID, but a child-walk avoids "no window found" right after a real launch).
- `GraphicsCaptureItem.CreateForWindow(hwnd)` → `Direct3D11CaptureFramePool.CreateFreeThreaded` → grab the first frame → encode PNG via `BitmapEncoder` (`Windows.Graphics.Imaging`) → write both `--full` (resized to 1568 px long edge) and `--thumb` (256 px wide).
- Non-zero exit + stderr line on failure. Map known HRESULTs (WGC unavailable, no window) to friendly hints.

`csproj`: `<TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>`, `<UseWPF>false</UseWPF>`, `<UseWindowsForms>false</UseWindowsForms>`. Reference WGC via the Windows SDK projection.

**Build strategy.** Build-on-demand on first capture. Sentinel: existence of `tools/wgc-capture/bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/wgc-capture.exe`. If missing, run `dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true` once, capture stderr, surface SDK-mismatch errors clearly. `WGC_CAPTURE_REBUILD=1` env var forces rebuild for dev iteration.

**Supervisor (`tools/projects.mjs`).** New exported `captureCsharpScreenshot(lang) → { ok, fullDataUrl?, thumbDataUrl?, error? }`:
- Read PID from `procs.get(lang)?.pid`. If null → `{ ok: false, error: 'process not running' }`.
- Ensure the helper exe exists (lazy build).
- Spawn the helper with a 4000 ms timeout, output paths in `os.tmpdir()`.
- Read both PNGs back, base64-encode to data URLs, delete temp files.
- Map known stderr signatures to friendly hints (e.g. WGC unavailable on older Windows builds — add a `wgcCaptureHint` to the `MISSING_CMD_HINTS` table referenced by the supervisor).

**Route `/proj/screenshot` in `tools/project-routes.mjs`.** POST, body `{ lang }`, response `{ ok, fullDataUrl?, thumbDataUrl?, error? }`. Mirrors the existing handler signature (`async (req, res) => { const body = await readJsonBody(req); … sendJson(res, 200, …) }`). Add the case to `handleProj()`.

### 4. Manual capture button (UX)

- New `<button id="projScreenshotBtn">` in `index.html`'s preview header, between `projOpenExternalBtn` and `projEvalBtn`. Camera icon (Tabler `ti-camera` or matching site convention).
- Extend `ProjectPreviewOptions` with `screenshotBtn: HTMLButtonElement` and bind in **both** `createWebVitePreview` and `createDesktopPreview` via the existing `AbortController` (so destroy() cleanly tears it down on language switch — same gotcha as `runBtn` / `reloadBtn`).
- Web click → `projectPreviewInstance.requestScreenshot()`. Desktop click → `fetch('/proj/screenshot', …)`.
- New `<div id="chatAttachment">` slot above `#inputRow` in `index.html` (hidden by default).
- `setChatAttachment(thumb, full)` in `src/main.ts` populates the slot with an `<img>` thumbnail chip + an `×` button. Single-attachment, replace-not-stack. Cleared on send and on Reset.

### 5. Auto-capture on Evaluate (`src/main.ts evaluateProjectCode`, ~line 1163)

After building the text payload but before `sendMessage`:

```
const screenshot = await captureForLang(lang, preview);  // null on fail
```

`captureForLang` dispatches: web → `requestScreenshot()`; desktop → `POST /proj/screenshot`. Hard 6000 ms ceiling.

- On success: build a `ContentBlock[]` with `[textBlock, imageBlock(full)]`. Persist `[textBlock, imageBlock(thumb)]` to history.
- On failure: append `\n\n[SCREENSHOT]\n(capture failed: <reason>)` to the text payload and continue with text-only. Don't block evaluate behind capture failures — the existing "what we have" rule beats nothing.

`sendMessage` is widened to accept an optional `attachment: { fullDataUrl, thumbDataUrl }` and constructs both shapes (persisted vs sent) in one place.

### 6. Render path for messages with images (`src/main.ts appendMsg`)

Widen `appendMsg(role, content: string | ContentBlock[])`. When given an array:
- Text blocks → existing `renderPlainWithFences` / `renderMarkdown`.
- Image blocks → `document.createElement('img')`, `.src = 'data:image/png;base64,' + data`, `.className = 'msg-attachment'`, `.alt = 'screenshot'`. Wrap in `<a target="_blank">` so click opens at full thumbnail size in a new tab (no lightbox v1).

DOM safety stays compliant: data URLs as `.src` are not an XSS vector (no `innerHTML` with dynamic strings).

Add `.msg-attachment { display:block; border-radius:6px; margin-top:6px; max-width:256px; }` to `src/style.css`.

### 7. System prompt updates (`src/constants.ts`)

- **WEB.systemPromptIntro**: append after the [SERVER] description: *"[SCREENSHOT] = a PNG of the iframe's rendered page captured at the moment of Send (when the dev server is running and capture succeeded). Use it together with [DOM]: [DOM] is the structure, [SCREENSHOT] is what they see. The screenshot is a best-effort DOM-to-PNG rasterisation; complex CSS like `backdrop-filter`, custom shaders, video frames, and `<canvas>` content may render incorrectly or blank — when in doubt trust the [DOM]."*
- **CSHARP.systemPromptIntro**: replace the existing "ask the student to paste a screenshot" line with: *"A PNG of the running window is automatically attached to Send-to-tutor messages when the process is running and capture succeeds. If it's missing — process stopped, capture helper unavailable, first run before the helper has built — you'll see a `[SCREENSHOT] (capture failed: …)` note in the text; in that case ask the student to share screenshots manually."*

## Critical files to modify

- `src/types.ts` — add `TextBlock` / `ImageBlock` / `ContentBlock`; widen `Message.content`.
- `src/api.ts` — handle array `content` in `callClaude` cache_control wiring; add `messageText` helper for `fetchProgressExtraction`.
- `src/main.ts` — `evaluateProjectCode` auto-capture, `sendMessage` attachment param, `appendMsg` render path, manual button wiring, attachment chip.
- `src/projectPreview.ts` — `requestScreenshot()`, screenshot-button binding via `AbortController`, ProjectPreview interface.
- `tools/projects.mjs` — bootstrap script extension (web), `captureCsharpScreenshot` (desktop), helper-exe build sentinel.
- `tools/project-routes.mjs` — `/proj/screenshot` route.
- `tools/wgc-capture/` — new C# console project (Program.cs + csproj).
- `package.json` + `scripts/copy-html-to-image.mjs` — copy `html-to-image` UMD bundle into `public/`.
- `index.html` — `projScreenshotBtn`, `chatAttachment` slot.
- `src/style.css` — `.msg-attachment`.
- `src/constants.ts` — system prompt updates for `web` and `csharp`.

## Risks & corrections noted from review

- **html-to-image fidelity.** Cannot capture `<canvas>` contents (renders blank), and stumbles on `backdrop-filter`, embedded video, cross-origin images. Fine for early DOM/CSS lessons; flagged in the system prompt.
- **WGC capture border on Win 10.** `GraphicsCaptureItem.CreateForWindow` shows a yellow capture-frame border on Windows 10. Suppressible on Windows 11 via `IsBorderRequired = false`. Accept the visual artifact on Win 10; mention it in the install hint if user complains.
- **WGC requires Windows 10 19041+ (May 2020).** On older Windows the helper exits with an unavailable HRESULT; surface a hint and gracefully fall back to text-only with the `[SCREENSHOT] (capture failed: …)` line.
- **Token cost.** Anthropic charges ~1.6k tokens per image. Auto-attaching on every Evaluate is real spend. Not blocking v1, but a future "auto-screenshot on Evaluate" toggle in the chat header would be cheap to add.
- **localStorage budget.** A 256 px PNG thumbnail is ~10–30 KB; 30 messages × 30 KB = under 1 MB. Comfortable.
- **postMessage payload size.** Always resize **before** posting parent-ward (specified in §2).
- **Future fallback.** If WGC turns out flaky on a student's box, a Win32 PrintWindow + `PW_RENDERFULLCONTENT` helper is ~80 lines and a sane backup. Not in v1.

## Tasks

### Type & API shape
- [ ] `src/types.ts` — add `TextBlock`, `ImageBlock`, `ContentBlock`; widen `Message.content` to `string | ContentBlock[]`.
- [ ] `src/api.ts` `callClaude` — handle array `content` in the cache_control wrapper (attach to last text block; image blocks pass through).
- [ ] `src/api.ts` `fetchProgressExtraction` — add `messageText(m)` helper, use it in the snippet builder so image blocks don't break the slice.

### Web capture path
- [ ] Add `html-to-image` as a regular `dependency` in `package.json`.
- [ ] `scripts/copy-html-to-image.mjs` — copy UMD bundle from `node_modules/html-to-image/dist/` to `public/lang-tutor-assets/`.
- [ ] Wire copy script as `postinstall` (and `predev` / `prebuild`) in `package.json`.
- [ ] `tools/projects.mjs` `BOOTSTRAP_SCRIPT` — add `lang-tutor:screenshot-request` handler: lazy-load html-to-image, capture, resize to 1568px full + 256px thumb via offscreen canvas, reply with both dataURLs.
- [ ] `src/projectPreview.ts` — add `requestScreenshot()` (5000 ms timeout) mirroring `requestSnapshot()`; expose on `ProjectPreview` interface.

### C# (WPF) capture path
- [ ] `tools/wgc-capture/` — `dotnet new console`, target `net8.0-windows10.0.19041.0`, `<UseWPF>false</UseWPF>`, `<UseWindowsForms>false</UseWindowsForms>`.
- [ ] `tools/wgc-capture/Program.cs` — parse `--pid / --full / --thumb`, find HWND via `EnumWindows` (match PID or child PIDs), capture via `GraphicsCaptureItem.CreateForWindow` + `Direct3D11CaptureFramePool.CreateFreeThreaded`, encode PNGs at 1568px / 256px, write to both paths.
- [ ] Map known HRESULTs (WGC unavailable, no window) to friendly stderr hints; non-zero exit on failure.
- [ ] `tools/projects.mjs` — add `captureCsharpScreenshot(lang)`: read PID from `procs`, lazy-build helper exe via `dotnet publish` (sentinel: exe existence; `WGC_CAPTURE_REBUILD=1` forces), spawn with 4000 ms timeout, read PNGs back as data URLs, cleanup temp files.
- [ ] Add `wgcCaptureHint` to `MISSING_CMD_HINTS` table.
- [ ] `tools/project-routes.mjs` — add `/proj/screenshot` POST handler; register in `handleProj()`.

### Manual capture button (UX)
- [ ] `index.html` — add `<button id="projScreenshotBtn">` (camera icon) in the preview header between `projOpenExternalBtn` and `projEvalBtn`.
- [ ] `index.html` — add `<div id="chatAttachment">` above `#inputRow` (hidden by default).
- [ ] `src/projectPreview.ts` — extend `ProjectPreviewOptions` with `screenshotBtn`; bind click in both `createWebVitePreview` and `createDesktopPreview` via the existing `AbortController`.
- [ ] `src/main.ts` — `setChatAttachment(thumb, full)` renders chip with `<img>` + `×` button; single-attachment, replace-not-stack; cleared on send and Reset.
- [ ] Wire web click → `requestScreenshot()`; desktop click → `POST /proj/screenshot`.

### Auto-capture on Evaluate
- [ ] `src/main.ts` `evaluateProjectCode` — add `captureForLang(lang, preview)` dispatch with 6000 ms ceiling.
- [ ] On success: build `[textBlock, imageBlock(full)]` for API, persist `[textBlock, imageBlock(thumb)]` to history.
- [ ] On failure: append `\n\n[SCREENSHOT]\n(capture failed: <reason>)` to text payload; never block evaluate.
- [ ] Widen `sendMessage` to accept optional `attachment: { fullDataUrl, thumbDataUrl }`; centralize the persisted-vs-sent shape construction here.

### Render path for messages with images
- [ ] `src/main.ts` `appendMsg` — widen to `string | ContentBlock[]`; iterate blocks: text → existing renderers, image → `<a target="_blank"><img class="msg-attachment" src="data:image/png;base64,…" alt="screenshot"></a>`.
- [ ] `src/style.css` — add `.msg-attachment { display:block; border-radius:6px; margin-top:6px; max-width:256px; }`.

### System prompt updates
- [ ] `src/constants.ts` WEB.systemPromptIntro — append `[SCREENSHOT]` description + html-to-image rasterisation caveat (canvas / video / backdrop-filter limitations).
- [ ] `src/constants.ts` CSHARP.systemPromptIntro — replace "ask the student to paste a screenshot" line with the new auto-attached description + graceful-failure note.

### Verification
- [ ] Manual web walkthrough: Run web project → Send to tutor → thumbnail in transcript → reload survives → `/lang-tutor-assets/html-to-image.js` loads same-origin.
- [ ] Manual C# walkthrough: Run csharp → first capture triggers `dotnet publish` build → subsequent captures fast → occluded-window test → stopped-process error path.
- [ ] `pnpm typecheck` clean (watch `noUncheckedIndexedAccess` on new `ContentBlock[]` reads).
- [ ] `pnpm lint` clean.
- [ ] Confirm `[api] cache: HIT` still appears on the turn after an evaluate-with-image.

## Verification

**Manual web (`pnpm dev`):**
1. Switch to Web, click Run, wait for the iframe to load.
2. Click "Send to tutor" → assistant reply should reference visual layout (not just DOM). Confirm the message in the transcript shows a thumbnail.
3. Click the camera button → chip appears above the input row → type a follow-up question → Send → message in transcript shows the same thumbnail.
4. Refresh page → history loads, thumbnails intact, no localStorage quota errors.
5. Open DevTools network tab on first capture → `/lang-tutor-assets/html-to-image.js` loads from same-origin.

**Manual C# (`pnpm dev`, `dotnet --version` ≥ 8):**
1. Switch to C#, click Run, wait for the WPF window to open on the desktop.
2. First capture: expect a one-time `dotnet publish` build (~10–20 s) of the helper, then the screenshot arrives.
3. Subsequent captures: ~500 ms.
4. Move another window to partially cover the WPF window → click camera → screenshot still shows the WPF window correctly (WGC handles occlusion).
5. Click Stop → click camera → friendly "process not running" toast in the chip slot.

**Lints/typechecks:**
- `pnpm typecheck` (watch for `noUncheckedIndexedAccess` on the new `ContentBlock[]` reads).
- `pnpm lint`.
- Smoke-test the API payload by sending an evaluate and confirming `[api] cache: HIT` still appears on the next turn (the prefix up to the prior turn should still cache; only the new image-bearing turn is fresh).
