/**
 * Preview pane for project-kind languages.
 *
 * Owns:
 *  - Run/Stop button → /proj/start, /proj/stop
 *  - Status pill ("stopped", "starting", "running on :5180")
 *  - Tabbed body: Preview (iframe) | Server logs | Build errors
 *  - Logs SSE subscription (subscribeProjectLogs)
 *  - Log line classification: stderr lines or lines matching error patterns
 *    populate the Build errors tab.
 *
 * The iframe's `src` is set to `http://127.0.0.1:<vitePort>/` once the dev
 * server reports ready. Reload re-sets the src; Stop clears it.
 */

import { getStatus, type ProjectLogEntry, startProject, stopProject, subscribeProjectLogs } from './projectApi';
import type { ProjectLanguage, WebProjectRuntime } from './types';

const MAX_LOG_LINES = 1000;
const STATUS_POLL_INTERVAL_MS = 2000;

const ERROR_PATTERNS = [/\bERROR\b/i, /^✘/, /\bFAILED\b/, /Error:/];

type PreviewTab = 'preview' | 'logs' | 'errors';

export interface ProjectPreviewOptions {
  lang: ProjectLanguage;
  tabsHost: HTMLElement;
  bodyHost: HTMLElement;
  statusEl: HTMLElement;
  runBtn: HTMLButtonElement;
  runLabelEl: HTMLElement;
  reloadBtn: HTMLButtonElement;
  externalBtn: HTMLButtonElement;
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
}

export interface ProjectPreview {
  destroy(): void;
  isRunning(): boolean;
  /** Ask the iframe for its current DOM and recent console output. Returns null if not running or on timeout. */
  requestSnapshot(): Promise<DomSnapshot | null>;
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

function isErrorLine(entry: ProjectLogEntry): boolean {
  if (entry.stream === 'stderr') return true;
  return ERROR_PATTERNS.some((re) => re.test(entry.line));
}

export function createProjectPreview(opts: ProjectPreviewOptions): ProjectPreview {
  const runtime = opts.lang.runtime;
  switch (runtime.kind) {
    case 'web-vite':
      return createWebVitePreview(opts, runtime);
    case 'desktop-process':
      throw new Error('desktop-process preview not implemented yet (planned for M3)');
  }
}

function createWebVitePreview(opts: ProjectPreviewOptions, runtime: WebProjectRuntime): ProjectPreview {
  const langId = opts.lang.id;
  let activeTab: PreviewTab = 'preview';
  let running = false;
  let starting = false;
  let vitePort = runtime.port;
  let statusPoll: number | null = null;

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
  previewEmpty.appendChild(span('Click Run to start the dev server and see the page here.', 'muted'));

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
    const tabs: Array<{ id: PreviewTab; label: string }> = [
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
    return `http://127.0.0.1:${vitePort}/`;
  }

  function setRunningState(isRunning: boolean): void {
    running = isRunning;
    if (isRunning) {
      iframe.src = urlForPort();
      setStatusPill(`running on :${vitePort}`, 'running');
      setRunButton('Stop', 'stop');
      opts.reloadBtn.disabled = false;
      opts.externalBtn.disabled = false;
    } else {
      // About:blank rather than empty src so the previous page doesn't linger.
      iframe.src = 'about:blank';
      setStatusPill('stopped', 'stopped');
      setRunButton('Run', 'run');
      opts.reloadBtn.disabled = true;
      opts.externalBtn.disabled = true;
    }
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

    if (isErrorLine(entry)) {
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
          vitePort = status.vitePort;
          setRunningState(true);
          return;
        }
        if (!status.running) {
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

  opts.runBtn.addEventListener('click', () => void handleRun());
  opts.reloadBtn.addEventListener('click', () => {
    if (running) iframe.src = urlForPort();
  });
  opts.externalBtn.addEventListener('click', () => {
    if (running) window.open(urlForPort(), '_blank', 'noopener');
  });

  // Subscribe to logs immediately — backend buffers recent lines so we don't
  // miss anything even when a previous run already started.
  const unsubLogs = subscribeProjectLogs(langId, appendLog);

  // Hydrate from current backend status — handles refresh-while-running.
  void (async (): Promise<void> => {
    try {
      const status = await getStatus(langId);
      if (status.running && status.ready) {
        vitePort = status.vitePort;
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
  // unexpectedly clears the running indicator.
  statusPoll = window.setInterval(async () => {
    if (!running) return;
    try {
      const status = await getStatus(langId);
      if (!status.running) setRunningState(false);
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

  return {
    destroy(): void {
      unsubLogs();
      if (statusPoll !== null) window.clearInterval(statusPoll);
    },
    isRunning(): boolean {
      return running;
    },
    requestSnapshot,
  };
}
