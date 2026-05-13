/**
 * Preview pane for project-kind languages. Two flavours:
 *
 *  - web-vite: Run boots a Vite dev server; tabs are Preview (iframe) | Server
 *    logs | Build errors. Status pill shows "running on :PORT".
 *  - desktop-process: Run spawns `dotnet run` (or similar) which opens a real
 *    OS window. No iframe — tabs are Output | Build errors. Status pill shows
 *    "running (PID N)" / "exited (code N)" so the student can tell the
 *    process self-exited (closed the WPF window) from a user-clicked Stop.
 *
 * Both flavours share:
 *  - Run/Stop button → /proj/start, /proj/stop
 *  - Logs SSE subscription (subscribeProjectLogs)
 *  - 2 s status reconciliation loop so a process that died externally clears
 *    the running indicator.
 */

import {
  captureProjectScreenshot,
  getStatus,
  type ProjectLogEntry,
  type ProjectStatus,
  startProject,
  stopProject,
  subscribeProjectLogs,
} from './projectApi';
import { runLocalSnippet } from './runners';
import type { ProjectLanguage, WebProjectRuntime } from './types';

const MAX_LOG_LINES = 1000;
const STATUS_POLL_INTERVAL_MS = 2000;

const WEB_ERROR_PATTERNS = [/\bERROR\b/i, /^✘/, /\bFAILED\b/, /Error:/];
// CS = C# compiler, MC = XAML markup compiler, MSB = MSBuild. All three emit
// the same "<path>(<line>,<col>): error <CODE>: …" shape that the linkifier
// below depends on. Keep this set in sync with CSHARP_ERROR_PARSE_RE.
const CSHARP_ERROR_PATTERNS = [/\berror CS\d+:/, /\berror MC\d+:/, /\berror MSB\d+:/];

// Captures: 1=path, 2=line, 3=col, 4=code (e.g. "CS0103"), 5=message (with
// optional trailing "[csproj]" stripped via the non-capturing group at end).
const CSHARP_ERROR_PARSE_RE = /^(.+?\.\w+)\((\d+),(\d+)\):\s*error\s+((?:CS|MC|MSB)\d+):\s*(.+?)(?:\s+\[[^\]]+\])?\s*$/;

interface ParsedCsharpError {
  path: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Parse a single dotnet build-error line. Returns null for shapes we can't linkify (e.g. `MSBUILD : error MSB1009: ...`). */
function parseCsharpErrorLine(line: string): ParsedCsharpError | null {
  const m = line.match(CSHARP_ERROR_PARSE_RE);
  if (m === null) return null;
  const [, path, lineStr, colStr, code, message] = m;
  if (path === undefined || lineStr === undefined || colStr === undefined || code === undefined || message === undefined) return null;
  const lineNum = Number.parseInt(lineStr, 10);
  const colNum = Number.parseInt(colStr, 10);
  if (!Number.isFinite(lineNum) || !Number.isFinite(colNum)) return null;
  return { path, line: lineNum, col: colNum, code, message };
}

/**
 * Strip a host-absolute build-error path down to a project-root-relative path
 * the editor can open. dotnet emits absolute paths like
 * `X:\dev\lang-tutor\projects\csharp\MainWindow.xaml.cs`; we want
 * `MainWindow.xaml.cs` (or `Subdir/Foo.cs`). Match on the `projects/<dir>/`
 * segment so we don't have to ask the supervisor for the absolute root.
 */
function toProjectRelativePath(absPath: string, scaffoldDir: string): string | null {
  // Escape regex specials in scaffoldDir defensively (it's a string literal in
  // PROJECT_CONFIG today, but treat as untrusted input).
  const dirEsc = scaffoldDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`[\\\\/]projects[\\\\/]${dirEsc}[\\\\/](.+)$`);
  const m = absPath.match(re);
  if (m === null || m[1] === undefined) return null;
  return m[1].replace(/\\/g, '/');
}

type WebPreviewTab = 'preview' | 'logs' | 'errors';
type DesktopPreviewTab = 'output' | 'errors';

export interface ProjectPreviewOptions {
  lang: ProjectLanguage;
  tabsHost: HTMLElement;
  bodyHost: HTMLElement;
  statusEl: HTMLElement;
  runBtn: HTMLButtonElement;
  runLabelEl: HTMLElement;
  reloadBtn: HTMLButtonElement;
  externalBtn: HTMLButtonElement;
  screenshotBtn: HTMLButtonElement;
  consoleRunBtn: HTMLButtonElement;
  getConsoleSnippet?: () => { path: string; content: string; dirty: boolean } | null;
  /** Called when the screenshot button captures a fresh image. */
  onScreenshot?: (pair: ScreenshotPair) => void;
  /** Called when a manual screenshot capture fails so the UI can surface a message. */
  onScreenshotError?: (reason: string) => void;
  /**
   * Click handler for parsed `<file>(<line>,<col>):` prefixes in the desktop
   * Build-errors tab. Receives a path *relative to the project root* and the
   * 1-based line/column from the compiler. No-op on the web flavour for now.
   */
  onJumpTo?: (path: string, line: number, col: number) => void;
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  line: string;
  ts: number;
}

export interface DomSnapshot {
  dom: string;
  consoleBuffer: ConsoleEntry[];
  url: string;
  title: string;
  /** Text of Vite's HMR error overlay (the red box) when one is showing, else null. */
  hmrOverlay: string | null;
}

export interface ScreenshotPair {
  /** PNG dataURL clamped to 1568 px long edge — sent to Claude. */
  full: string;
  /** PNG dataURL clamped to 256 px long edge — persisted in history. */
  thumb: string;
}

export interface ProjectPreview {
  destroy(): void;
  isRunning(): boolean;
  /** Ask the iframe for its current DOM and recent console output. Returns null if not running or on timeout. */
  requestSnapshot(): Promise<DomSnapshot | null>;
  /**
   * Capture a PNG of the running app:
   *  - web-vite: via postMessage to the iframe (html-to-image rasterisation).
   *  - desktop-process: via POST /proj/screenshot (WGC helper exe).
   * Returns null when not running, on timeout, or on capture failure (caller
   * decides how to surface — auto-Evaluate falls back to text-only).
   */
  requestScreenshot(): Promise<ScreenshotPair | null>;
}

function div(...classes: string[]): HTMLDivElement {
  const d = document.createElement('div');
  if (classes.length) d.className = classes.join(' ');
  return d;
}

function span(text: string, ...classes: string[]): HTMLSpanElement {
  const s = document.createElement('span');
  if (classes.length) s.className = classes.join(' ');
  s.textContent = text;
  return s;
}

function isWebErrorLine(entry: ProjectLogEntry): boolean {
  if (entry.stream === 'stderr') return true;
  return WEB_ERROR_PATTERNS.some((re) => re.test(entry.line));
}

function isCsharpErrorLine(entry: ProjectLogEntry): boolean {
  // Don't auto-promote stderr — `dotnet` writes telemetry hints and NuGet
  // restore noise to stderr that aren't build errors. Match the compiler /
  // MSBuild patterns explicitly.
  return CSHARP_ERROR_PATTERNS.some((re) => re.test(entry.line));
}

export function createProjectPreview(opts: ProjectPreviewOptions): ProjectPreview {
  const runtime = opts.lang.runtime;
  switch (runtime.kind) {
    case 'web-vite':
      return createWebVitePreview(opts, runtime);
    case 'desktop-process':
      return createDesktopPreview(opts);
  }
}

/**
 * Why the dev server isn't running. Drives both the status pill and the
 * placeholder text in the iframe area. Reset to 'none' on every Run click.
 */
type WebFailureKind = 'none' | 'port-in-use' | 'crashed';

// Match both Node's raw error ("EADDRINUSE: address already in use") and
// Vite's friendlier reformatting ("Port 5180 is already in use") since Vite
// catches the underlying error before surfacing it.
const PORT_IN_USE_RE = /(EADDRINUSE|Port\s+\d+\s+is\s+already\s+in\s+use)/i;

function createWebVitePreview(opts: ProjectPreviewOptions, runtime: WebProjectRuntime): ProjectPreview {
  const langId = opts.lang.id;
  // The Run/Reload/External buttons are shared DOM nodes across language
  // switches. Bind every listener through this controller so destroy() removes
  // them in one shot — otherwise zombie handlers from a prior preview fire on
  // the next click and trample the new preview's tabs / state.
  const ctrl = new AbortController();
  let activeTab: WebPreviewTab = 'preview';
  let running = false;
  let starting = false;
  let vitePort = runtime.port;
  let statusPoll: number | null = null;
  // Tracks why the dev server stopped — drives friendly pill / placeholder
  // text. 'port-in-use' is set via log scan (Vite logs EADDRINUSE on stderr
  // before exiting); 'crashed' is inferred from the status poll seeing
  // running flip to false unexpectedly (no user-stop).
  let failureKind: WebFailureKind = 'none';

  opts.consoleRunBtn.style.display = 'none';

  // Tab body containers — created once, swapped via display: none.
  const iframe = document.createElement('iframe');
  iframe.className = 'proj-preview-iframe';
  iframe.title = 'Project preview';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

  const logsPane = div('proj-preview-logs');
  const errorsPane = div('proj-preview-errors');
  const errorsEmpty = span('No build errors.', 'muted');
  errorsPane.appendChild(errorsEmpty);

  const previewEmpty = div('proj-preview-empty');
  const previewEmptyMsg = span('Click Run to start the dev server and see the page here.', 'muted');
  previewEmpty.appendChild(previewEmptyMsg);

  function setPreviewEmptyMessage(): void {
    if (failureKind === 'port-in-use') {
      previewEmptyMsg.textContent = `Port ${vitePort} is in use. Free the port (close whatever else is bound to it) and click Restart, or change the port in projects/${opts.lang.scaffoldDir}/package.json.`;
      previewEmptyMsg.classList.remove('muted');
      previewEmptyMsg.classList.add('proj-preview-error-msg');
    } else if (failureKind === 'crashed') {
      previewEmptyMsg.textContent = 'The dev server stopped unexpectedly. Check Server logs for the error, then click Restart.';
      previewEmptyMsg.classList.remove('muted');
      previewEmptyMsg.classList.add('proj-preview-error-msg');
    } else {
      previewEmptyMsg.textContent = 'Click Run to start the dev server and see the page here.';
      previewEmptyMsg.classList.add('muted');
      previewEmptyMsg.classList.remove('proj-preview-error-msg');
    }
  }

  opts.bodyHost.appendChild(previewEmpty);
  opts.bodyHost.appendChild(iframe);
  opts.bodyHost.appendChild(logsPane);
  opts.bodyHost.appendChild(errorsPane);

  function syncBodyVisibility(): void {
    const showIframe = activeTab === 'preview' && running;
    iframe.style.display = showIframe ? 'block' : 'none';
    previewEmpty.style.display = activeTab === 'preview' && !running ? 'flex' : 'none';
    logsPane.style.display = activeTab === 'logs' ? 'block' : 'none';
    errorsPane.style.display = activeTab === 'errors' ? 'block' : 'none';
  }

  function renderTabs(): void {
    opts.tabsHost.textContent = '';
    const errorCount = errorsPane.querySelectorAll('.proj-preview-error-line').length;
    const tabs: Array<{ id: WebPreviewTab; label: string }> = [
      { id: 'preview', label: 'Preview' },
      { id: 'logs', label: 'Server logs' },
      { id: 'errors', label: errorCount > 0 ? `Build errors · ${errorCount}` : 'Build errors' },
    ];
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `proj-preview-tab${activeTab === t.id ? ' is-active' : ''}`;
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        activeTab = t.id;
        renderTabs();
        syncBodyVisibility();
      });
      opts.tabsHost.appendChild(btn);
    }
  }

  function setStatusPill(text: string, kind: 'stopped' | 'starting' | 'running' | 'error'): void {
    opts.statusEl.textContent = text;
    opts.statusEl.dataset.state = kind;
  }

  function setRunButton(label: string, mode: 'run' | 'stop' | 'busy'): void {
    opts.runLabelEl.textContent = label;
    opts.runBtn.dataset.mode = mode;
    opts.runBtn.disabled = mode === 'busy';
    const icon = opts.runBtn.querySelector('i');
    if (icon !== null) {
      icon.className = mode === 'stop' ? 'ti ti-player-stop-filled' : 'ti ti-player-play-filled';
    }
  }

  function urlForPort(): string {
    // Use the hostname the user is browsing from so this works over LAN
    // (laptop hitting desktop's IP) as well as locally.
    const host = window.location.hostname || '127.0.0.1';
    return `http://${host}:${vitePort}/`;
  }

  function setRunningState(isRunning: boolean): void {
    running = isRunning;
    if (isRunning) {
      // Coming back up: clear any stale failure state.
      failureKind = 'none';
      iframe.src = urlForPort();
      setStatusPill(`running on :${vitePort}`, 'running');
      setRunButton('Stop', 'stop');
      opts.reloadBtn.disabled = false;
      opts.externalBtn.disabled = false;
      opts.screenshotBtn.disabled = false;
    } else {
      // About:blank rather than empty src so the previous page doesn't linger.
      iframe.src = 'about:blank';
      if (failureKind === 'port-in-use') {
        setStatusPill(`port :${vitePort} in use`, 'error');
        setRunButton('Restart', 'run');
      } else if (failureKind === 'crashed') {
        setStatusPill('crashed', 'error');
        setRunButton('Restart', 'run');
      } else {
        setStatusPill('stopped', 'stopped');
        setRunButton('Run', 'run');
      }
      opts.reloadBtn.disabled = true;
      opts.externalBtn.disabled = true;
      opts.screenshotBtn.disabled = true;
    }
    setPreviewEmptyMessage();
    syncBodyVisibility();
  }

  function appendLog(entry: ProjectLogEntry): void {
    const line = div('proj-preview-log-line');
    if (entry.stream === 'stderr') line.classList.add('is-stderr');
    if (entry.stream === 'system') line.classList.add('is-system');
    line.textContent = entry.line === '' ? ' ' : entry.line;
    logsPane.appendChild(line);
    while (logsPane.children.length > MAX_LOG_LINES) {
      logsPane.firstChild?.remove();
    }
    if (activeTab === 'logs') logsPane.scrollTop = logsPane.scrollHeight;

    // EADDRINUSE → port-in-use. Latched until the next Run click clears it
    // (via setRunningState(true)), so the pill stays informative even after
    // Vite exits and the log scrolls past the original error line.
    if (entry.stream !== 'system' && PORT_IN_USE_RE.test(entry.line)) {
      failureKind = 'port-in-use';
    }

    if (isWebErrorLine(entry)) {
      if (errorsPane.contains(errorsEmpty)) errorsPane.textContent = '';
      const e = div('proj-preview-error-line');
      e.textContent = entry.line;
      errorsPane.appendChild(e);
      renderTabs(); // updates the count badge
    }
  }

  function clearLogs(): void {
    logsPane.textContent = '';
    errorsPane.textContent = '';
    errorsPane.appendChild(errorsEmpty);
    renderTabs();
  }

  async function pollUntilReady(): Promise<void> {
    // The /proj/start endpoint already waits up to 30s for the port to come
    // up. After it returns we still poll once or twice to confirm and to
    // catch cases where Vite was warm-started but ready=false slipped in.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        const status = await getStatus(langId);
        if (status.ready) {
          vitePort = status.vitePort ?? runtime.port;
          setRunningState(true);
          return;
        }
        if (!status.running) {
          // Vite exited during startup (typically EADDRINUSE under
          // --strictPort, or a syntax error in vite.config). The log SSE may
          // have already latched 'port-in-use'; if not, mark as crashed so
          // setRunningState renders the right pill / Restart label.
          if (status.phase === 'exited' && failureKind === 'none') {
            failureKind = 'crashed';
          }
          setRunningState(false);
          return;
        }
      } catch {
        // keep trying
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setStatusPill('start timed out', 'error');
    setRunButton('Run', 'run');
  }

  async function handleRun(): Promise<void> {
    if (running) {
      setRunButton('Stopping…', 'busy');
      setStatusPill('stopping', 'stopped');
      try {
        await stopProject(langId);
      } finally {
        setRunningState(false);
      }
      return;
    }
    if (starting) return;
    starting = true;
    // Reset failure state so a retry doesn't keep showing "port :5180 in use"
    // mid-spin-up. EADDRINUSE will re-set it from the next log line if it
    // happens again; the placeholder text is also reverted via syncBodyVisibility.
    failureKind = 'none';
    setPreviewEmptyMessage();
    setRunButton('Starting…', 'busy');
    setStatusPill('starting', 'starting');
    clearLogs();
    activeTab = 'logs';
    renderTabs();
    syncBodyVisibility();
    try {
      const result = await startProject(langId);
      if (!result.ok) {
        setStatusPill(`error: ${result.error ?? 'start failed'}`, 'error');
        setRunButton('Run', 'run');
        return;
      }
      if (result.vitePort) vitePort = result.vitePort;
      if (result.ready) {
        setRunningState(true);
        activeTab = 'preview';
        renderTabs();
        syncBodyVisibility();
      } else {
        await pollUntilReady();
        if (running) {
          activeTab = 'preview';
          renderTabs();
          syncBodyVisibility();
        }
      }
    } catch (e) {
      setStatusPill(`error: ${(e as Error).message}`, 'error');
      setRunButton('Run', 'run');
    } finally {
      starting = false;
    }
  }

  opts.runBtn.addEventListener('click', () => void handleRun(), { signal: ctrl.signal });
  opts.reloadBtn.addEventListener(
    'click',
    () => {
      if (running) iframe.src = urlForPort();
    },
    { signal: ctrl.signal }
  );
  opts.externalBtn.addEventListener(
    'click',
    () => {
      if (running) window.open(urlForPort(), '_blank', 'noopener');
    },
    { signal: ctrl.signal }
  );
  opts.screenshotBtn.addEventListener(
    'click',
    async () => {
      if (!running) return;
      opts.screenshotBtn.disabled = true;
      try {
        const shot = await requestScreenshot();
        if (shot !== null) {
          opts.onScreenshot?.(shot);
        } else {
          opts.onScreenshotError?.('Screenshot capture failed or timed out.');
        }
      } finally {
        opts.screenshotBtn.disabled = !running;
      }
    },
    { signal: ctrl.signal }
  );

  // Subscribe to logs immediately — backend buffers recent lines so we don't
  // miss anything even when a previous run already started.
  const unsubLogs = subscribeProjectLogs(langId, appendLog);

  // Hydrate from current backend status — handles refresh-while-running.
  void (async (): Promise<void> => {
    try {
      const status = await getStatus(langId);
      if (status.running && status.ready) {
        vitePort = status.vitePort ?? runtime.port;
        setRunningState(true);
      } else if (status.running) {
        setStatusPill('starting', 'starting');
        setRunButton('Starting…', 'busy');
        await pollUntilReady();
      }
    } catch {
      // server unreachable — stay in stopped state
    }
  })();

  // Periodically reconcile UI with server state so a process that died
  // unexpectedly clears the running indicator. When the supervisor reports
  // phase='exited' (proc closed without stopProject being called), promote
  // failureKind to 'crashed' so the pill says "crashed" and Run becomes
  // Restart — unless EADDRINUSE already latched 'port-in-use' (preserve the
  // more specific reason).
  statusPoll = window.setInterval(async () => {
    if (!running) return;
    try {
      const status = await getStatus(langId);
      if (!status.running) {
        if (status.phase === 'exited' && failureKind === 'none') {
          failureKind = 'crashed';
        }
        setRunningState(false);
      }
    } catch {
      // ignore transient errors
    }
  }, STATUS_POLL_INTERVAL_MS);

  // Initial render.
  renderTabs();
  syncBodyVisibility();
  setStatusPill('stopped', 'stopped');
  setRunButton('Run', 'run');

  function requestSnapshot(): Promise<DomSnapshot | null> {
    if (!running || iframe.contentWindow === null) return Promise.resolve(null);
    const requestId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolveSnap) => {
      let settled = false;
      const onMessage = (event: MessageEvent): void => {
        const data = event.data as { type?: string; requestId?: string } & DomSnapshot;
        if (data?.type !== 'lang-tutor:snapshot-reply') return;
        if (data.requestId !== requestId) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolveSnap({
          dom: data.dom,
          consoleBuffer: data.consoleBuffer,
          url: data.url,
          title: data.title,
          hmrOverlay: data.hmrOverlay ?? null,
        });
      };
      window.addEventListener('message', onMessage);
      try {
        iframe.contentWindow?.postMessage({ type: 'lang-tutor:snapshot-request', requestId }, '*');
      } catch {
        // postMessage shouldn't throw, but fall through to timeout
      }
      window.setTimeout(() => {
        if (!settled) {
          window.removeEventListener('message', onMessage);
          resolveSnap(null);
        }
      }, 1500);
    });
  }

  function requestScreenshot(): Promise<ScreenshotPair | null> {
    if (!running || iframe.contentWindow === null) return Promise.resolve(null);
    const requestId = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolveShot) => {
      let settled = false;
      const onMessage = (event: MessageEvent): void => {
        const data = event.data as {
          type?: string;
          requestId?: string;
          fullDataUrl?: string;
          thumbDataUrl?: string;
          error?: string;
        };
        if (data?.type !== 'lang-tutor:screenshot-reply') return;
        if (data.requestId !== requestId) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        if (typeof data.fullDataUrl === 'string' && typeof data.thumbDataUrl === 'string') {
          resolveShot({ full: data.fullDataUrl, thumb: data.thumbDataUrl });
        } else {
          if (data.error !== undefined) console.warn('[screenshot] iframe reported:', data.error);
          resolveShot(null);
        }
      };
      window.addEventListener('message', onMessage);
      try {
        iframe.contentWindow?.postMessage({ type: 'lang-tutor:screenshot-request', requestId }, '*');
      } catch {
        // fall through to timeout
      }
      // html-to-image walks the DOM and inlines fonts/images — give it more
      // headroom than the DOM snapshot (1500 ms).
      window.setTimeout(() => {
        if (!settled) {
          window.removeEventListener('message', onMessage);
          resolveShot(null);
        }
      }, 5000);
    });
  }

  return {
    destroy(): void {
      ctrl.abort();
      unsubLogs();
      if (statusPoll !== null) window.clearInterval(statusPoll);
    },
    isRunning(): boolean {
      return running;
    },
    requestSnapshot,
    requestScreenshot,
  };
}

/**
 * Frontend build-phase derived from dotnet's --verbosity minimal output.
 *  - starting: process spawned but no dotnet output yet
 *  - restoring: NuGet restore in progress (cold cache → 30+ s)
 *  - building: restore finished, MSBuild compiling
 *  - ready: build emitted the assembly; the WPF window is launching / up
 *
 * Independent of the supervisor's process-alive readiness, which fires after
 * 500 ms regardless of build state. This phase is what the student actually
 * cares about — "is my window about to appear or are we still compiling?"
 */
type DesktopBuildPhase = 'starting' | 'restoring' | 'building' | 'ready';

const RESTORE_START_RE = /Determining projects to restore/i;
const BUILD_START_RE = /(All projects are up-to-date for restore|^\s*Restored\b)/i;
const BUILD_DONE_RE = /^\s+\S.* -> .+\.dll/i;

function createDesktopPreview(opts: ProjectPreviewOptions): ProjectPreview {
  const langId = opts.lang.id;
  const scaffoldDir = opts.lang.scaffoldDir;
  // See createWebVitePreview — every shared-DOM listener registration goes
  // through this controller so destroy() can yank them all in one shot.
  const ctrl = new AbortController();
  let activeTab: DesktopPreviewTab = 'output';
  let running = false;
  let starting = false;
  let buildPhase: DesktopBuildPhase = 'starting';
  let pid: number | null = null;
  let lastExitCode: number | null = null;
  let phase: ProjectStatus['phase'] = 'stopped';
  let consoleRunning = false;
  // Dedupe key per Run cycle: dotnet emits each error twice (once during
  // compile, once in the "Build FAILED" summary). Cleared in clearLogs().
  const seenErrors = new Set<string>();

  // Output pane: scrolling log stream. Build errors pane: filtered subset.
  // Both use the same .proj-preview-logs / .proj-preview-error-line styles
  // shipped for the web flavour — only the *contents* differ.
  const outputPane = div('proj-preview-logs');
  const outputPlaceholder = span('Click Run to launch the project. Build output and runtime logs will appear here.', 'muted');
  outputPane.appendChild(outputPlaceholder);

  const errorsPane = div('proj-preview-errors');
  const errorsEmpty = span('No build errors.', 'muted');
  errorsPane.appendChild(errorsEmpty);

  opts.bodyHost.appendChild(outputPane);
  opts.bodyHost.appendChild(errorsPane);

  // Reload + open-in-new-tab don't apply — there is no URL. Hide rather than
  // grey out so the header doesn't look like the user can fix anything.
  opts.reloadBtn.style.display = 'none';
  opts.externalBtn.style.display = 'none';
  opts.consoleRunBtn.style.display = '';
  opts.consoleRunBtn.disabled = false;

  function syncBodyVisibility(): void {
    outputPane.style.display = activeTab === 'output' ? 'block' : 'none';
    errorsPane.style.display = activeTab === 'errors' ? 'block' : 'none';
  }

  function renderTabs(): void {
    opts.tabsHost.textContent = '';
    const errorCount = errorsPane.querySelectorAll('.proj-preview-error-line').length;
    const tabs: Array<{ id: DesktopPreviewTab; label: string }> = [
      { id: 'output', label: 'Output' },
      { id: 'errors', label: errorCount > 0 ? `Build errors · ${errorCount}` : 'Build errors' },
    ];
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `proj-preview-tab${activeTab === t.id ? ' is-active' : ''}`;
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        activeTab = t.id;
        renderTabs();
        syncBodyVisibility();
      });
      opts.tabsHost.appendChild(btn);
    }
  }

  function setStatusPill(text: string, kind: 'stopped' | 'starting' | 'running' | 'error'): void {
    opts.statusEl.textContent = text;
    opts.statusEl.dataset.state = kind;
  }

  function setRunButton(label: string, mode: 'run' | 'stop' | 'busy'): void {
    opts.runLabelEl.textContent = label;
    opts.runBtn.dataset.mode = mode;
    opts.runBtn.disabled = mode === 'busy';
    const icon = opts.runBtn.querySelector('i');
    if (icon !== null) {
      icon.className = mode === 'stop' ? 'ti ti-player-stop-filled' : 'ti ti-player-play-filled';
    }
  }

  function refreshStatusPill(): void {
    // Always reconcile the screenshot button so it tracks build phase changes
    // without requiring callers to remember to do it.
    opts.screenshotBtn.disabled = !running || buildPhase !== 'ready';
    if (starting) {
      setStatusPill('starting', 'starting');
      return;
    }
    if (running) {
      // process-alive says "ready (PID …)" within 500 ms, but for csharp the
      // WPF window doesn't appear until the build phase finishes (5–15 s
      // cold). Surface the build phase explicitly so the student doesn't
      // keep clicking Run thinking nothing happened.
      const pidSuffix = pid !== null ? ` (PID ${pid})` : '';
      if (buildPhase === 'starting') {
        // Process spawned but dotnet hasn't emitted its first line yet.
        // Showing "running" here is misleading — nothing's actually running.
        setStatusPill(`spawning…${pidSuffix}`, 'starting');
        return;
      }
      if (buildPhase === 'restoring') {
        setStatusPill(`restoring NuGet…${pidSuffix}`, 'starting');
        return;
      }
      if (buildPhase === 'building') {
        setStatusPill(`building…${pidSuffix}`, 'starting');
        return;
      }
      setStatusPill(`running${pidSuffix}`, 'running');
      return;
    }
    if (phase === 'exited') {
      setStatusPill(`exited (code ${lastExitCode ?? '?'})`, 'error');
      return;
    }
    if (phase === 'error') {
      setStatusPill('error', 'error');
      return;
    }
    setStatusPill('stopped', 'stopped');
  }

  function setRunningState(isRunning: boolean): void {
    running = isRunning;
    if (isRunning) {
      setRunButton('Stop', 'stop');
    } else {
      setRunButton('Run', 'run');
      pid = null;
    }
    // Screenshot is only meaningful once the WPF window is on screen — gate it
    // on the build phase reaching 'running' to avoid capturing an empty desktop
    // while NuGet restores. The status-pill refresh keeps this in sync.
    opts.screenshotBtn.disabled = !isRunning || buildPhase !== 'ready';
    refreshStatusPill();
  }

  function updateBuildPhaseFromLine(line: string): void {
    // Phase only ever advances forward within a single Run cycle; never roll
    // back to an earlier phase if a stray older line arrives.
    if (BUILD_DONE_RE.test(line)) {
      buildPhase = 'ready';
      refreshStatusPill();
      return;
    }
    if (BUILD_START_RE.test(line) && buildPhase !== 'ready') {
      buildPhase = 'building';
      refreshStatusPill();
      return;
    }
    if (RESTORE_START_RE.test(line) && buildPhase === 'starting') {
      buildPhase = 'restoring';
      refreshStatusPill();
    }
  }

  function appendLog(entry: ProjectLogEntry): void {
    if (outputPane.contains(outputPlaceholder)) outputPane.removeChild(outputPlaceholder);
    const line = div('proj-preview-log-line');
    if (entry.stream === 'stderr') line.classList.add('is-stderr');
    if (entry.stream === 'system') line.classList.add('is-system');
    line.textContent = entry.line === '' ? ' ' : entry.line;
    outputPane.appendChild(line);
    while (outputPane.children.length > MAX_LOG_LINES) {
      outputPane.firstChild?.remove();
    }
    if (activeTab === 'output') outputPane.scrollTop = outputPane.scrollHeight;

    // Skip system lines (our own pushLog markers) so a literal "Restored" in
    // the supervisor banner can't accidentally flip phases.
    if (entry.stream !== 'system') {
      updateBuildPhaseFromLine(entry.line);
    }

    if (isCsharpErrorLine(entry)) appendErrorLine(entry.line);
  }

  function appendLocalLine(stream: ProjectLogEntry['stream'], line: string): void {
    appendLog({ stream, line, ts: Date.now() });
  }

  function appendRunOutput(output: string, ok: boolean): void {
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      appendLocalLine(ok ? 'stdout' : 'stderr', line);
    }
  }

  function appendErrorLine(rawLine: string): void {
    const parsed = parseCsharpErrorLine(rawLine);
    // Dedupe by path:line:col:code (or whole-line text for unparsed shapes).
    const dedupeKey = parsed === null ? `raw:${rawLine}` : `${parsed.path}:${parsed.line}:${parsed.col}:${parsed.code}`;
    if (seenErrors.has(dedupeKey)) return;
    seenErrors.add(dedupeKey);

    if (errorsPane.contains(errorsEmpty)) errorsPane.textContent = '';
    const row = div('proj-preview-error-line');
    if (parsed === null) {
      // Shapes we can't linkify (e.g. `MSBUILD : error MSB1009: ...` with no
      // file:line:col prefix) — render as plain text.
      row.textContent = rawLine;
    } else {
      const relPath = opts.onJumpTo === undefined ? null : toProjectRelativePath(parsed.path, scaffoldDir);
      const displayPath = relPath ?? parsed.path;
      const prefixText = `${displayPath}(${parsed.line},${parsed.col}):`;
      if (relPath !== null && opts.onJumpTo !== undefined) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'proj-preview-error-link';
        link.textContent = prefixText;
        link.title = `Jump to ${relPath} line ${parsed.line}, column ${parsed.col}`;
        link.addEventListener(
          'click',
          () => {
            opts.onJumpTo?.(relPath, parsed.line, parsed.col);
          },
          { signal: ctrl.signal }
        );
        row.appendChild(link);
      } else {
        // Path doesn't live under projects/<scaffoldDir>/ — possible if dotnet
        // surfaces an error from an SDK-imported file. Show as plain text so
        // the student still sees the message.
        row.appendChild(span(prefixText, 'proj-preview-error-prefix'));
      }
      row.appendChild(span(` error ${parsed.code}: ${parsed.message}`, 'proj-preview-error-msg'));
    }
    errorsPane.appendChild(row);
    renderTabs();
  }

  function clearLogs(): void {
    outputPane.textContent = '';
    errorsPane.textContent = '';
    errorsPane.appendChild(errorsEmpty);
    buildPhase = 'starting';
    seenErrors.clear();
    renderTabs();
  }

  async function handleRun(): Promise<void> {
    if (running) {
      setRunButton('Stopping…', 'busy');
      try {
        await stopProject(langId);
      } finally {
        setRunningState(false);
      }
      return;
    }
    if (starting) return;
    starting = true;
    setRunButton('Starting…', 'busy');
    refreshStatusPill();
    clearLogs();
    activeTab = 'output';
    renderTabs();
    syncBodyVisibility();
    try {
      const result = await startProject(langId);
      if (!result.ok) {
        phase = 'error';
        starting = false;
        setStatusPill(`error: ${result.error ?? 'start failed'}`, 'error');
        setRunButton('Run', 'run');
        return;
      }
      // process-alive readiness resolves inside /proj/start (~500 ms), so the
      // backend usually replies with ready=true immediately. Re-poll status to
      // pick up the assigned PID for the pill.
      try {
        const status = await getStatus(langId);
        pid = status.pid;
        phase = status.phase;
      } catch {
        // If the status round-trip fails, fall back to running-without-PID.
      }
      starting = false;
      if (result.ready === true || phase === 'ready' || phase === 'starting') {
        setRunningState(true);
      } else {
        setRunningState(false);
      }
    } catch (e) {
      starting = false;
      phase = 'error';
      setStatusPill(`error: ${(e as Error).message}`, 'error');
      setRunButton('Run', 'run');
    }
  }

  async function handleConsoleRun(): Promise<void> {
    if (consoleRunning) return;
    const snippet = opts.getConsoleSnippet?.() ?? null;
    activeTab = 'output';
    renderTabs();
    syncBodyVisibility();
    if (snippet === null) {
      appendLocalLine('system', '[console] Open a .cs file, then run it as a console snippet.');
      return;
    }
    if (!snippet.path.toLowerCase().endsWith('.cs')) {
      appendLocalLine('system', `[console] ${snippet.path} is not a .cs file.`);
      return;
    }

    consoleRunning = true;
    opts.consoleRunBtn.disabled = true;
    appendLocalLine('system', `[console] Running ${snippet.path} in local C# sandbox...`);
    try {
      const result = await runLocalSnippet('csharp', snippet.content);
      appendRunOutput(result.output, result.ok);
      appendLocalLine('system', result.ok ? '[console] Finished.' : '[console] Failed.');
    } catch (e) {
      appendLocalLine('stderr', `[console] ${(e as Error).message}`);
    } finally {
      consoleRunning = false;
      opts.consoleRunBtn.disabled = false;
    }
  }

  async function doRequestScreenshot(): Promise<ScreenshotPair | null> {
    if (!running) return null;
    try {
      const res = await captureProjectScreenshot(opts.lang.id);
      if (res.ok && res.fullDataUrl !== undefined && res.thumbDataUrl !== undefined) {
        return { full: res.fullDataUrl, thumb: res.thumbDataUrl };
      }
      if (res.error !== undefined) console.warn('[screenshot] supervisor reported:', res.error);
      return null;
    } catch (err) {
      console.warn('[screenshot] /proj/screenshot failed:', err);
      return null;
    }
  }

  opts.runBtn.addEventListener('click', () => void handleRun(), { signal: ctrl.signal });
  opts.consoleRunBtn.addEventListener('click', () => void handleConsoleRun(), { signal: ctrl.signal });
  opts.screenshotBtn.addEventListener(
    'click',
    async () => {
      if (!running || buildPhase !== 'ready') return;
      opts.screenshotBtn.disabled = true;
      try {
        const shot = await doRequestScreenshot();
        if (shot !== null) {
          opts.onScreenshot?.(shot);
        } else {
          opts.onScreenshotError?.('Screenshot capture failed — see console for details.');
        }
      } finally {
        refreshStatusPill();
      }
    },
    { signal: ctrl.signal }
  );

  const unsubLogs = subscribeProjectLogs(langId, appendLog);

  // Hydrate from current backend status (handles refresh-while-running).
  void (async (): Promise<void> => {
    try {
      const status = await getStatus(langId);
      pid = status.pid;
      phase = status.phase;
      lastExitCode = status.lastExitCode;
      if (status.running) setRunningState(true);
      else refreshStatusPill();
    } catch {
      // server unreachable — stay in stopped state
    }
  })();

  // Reconcile with backend every 2 s. Catches the WPF window being closed by
  // the user (process self-exits → backend phase flips to 'exited' → pill
  // shows "exited (code N)").
  const statusPoll = window.setInterval(async () => {
    try {
      const status = await getStatus(langId);
      const wasRunning = running;
      pid = status.pid;
      phase = status.phase;
      lastExitCode = status.lastExitCode;
      if (wasRunning && !status.running) {
        setRunningState(false);
      } else if (!wasRunning && status.running) {
        setRunningState(true);
      } else {
        refreshStatusPill();
      }
    } catch {
      // ignore transient errors
    }
  }, STATUS_POLL_INTERVAL_MS);

  // Initial render.
  renderTabs();
  syncBodyVisibility();
  setRunButton('Run', 'run');
  refreshStatusPill();

  return {
    destroy(): void {
      ctrl.abort();
      unsubLogs();
      window.clearInterval(statusPoll);
      // Restore reload/external buttons in case a future ensureProjectUI swaps
      // back to a web-vite project — they share the same DOM nodes.
      opts.reloadBtn.style.display = '';
      opts.externalBtn.style.display = '';
      opts.consoleRunBtn.style.display = 'none';
      opts.consoleRunBtn.disabled = true;
    },
    isRunning(): boolean {
      return running;
    },
    requestSnapshot(): Promise<null> {
      return Promise.resolve(null);
    },
    requestScreenshot: doRequestScreenshot,
  };
}
