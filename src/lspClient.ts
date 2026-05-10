/**
 * Hand-rolled LSP client over WebSocket.
 *
 * Lifecycle:
 *   connectLsp(lang) → POST /lsp/spawn → open WS → initialize/initialized handshake
 *   client.didOpen(text) once after connect; client.didChange(text) on every CodeMirror update
 *   client.hover/completion/signatureHelp/formatting on demand
 *   client.dispose() on language switch / page unload
 *
 * Diagnostics are pushed by the server via textDocument/publishDiagnostics; we cache
 * the latest list keyed by URI and emit to subscribers. Use getDiagnostics() to read
 * synchronously (e.g., when building the [LSP] block for evaluateCode).
 */

import type { LanguageId } from './types';

// ── LSP wire types (minimal subset) ─────────────────────────────────────────

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** 1=Error, 2=Warning, 3=Information, 4=Hint */
export type LspSeverity = 1 | 2 | 3 | 4;

export interface LspDiagnostic {
  range: LspRange;
  severity?: LspSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspHover {
  contents: string | { kind: string; value: string } | Array<string | { language?: string; value: string }>;
  range?: LspRange;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  filterText?: string;
  sortText?: string;
  textEdit?: LspTextEdit;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspParameterInformation {
  label: string | [number, number];
  documentation?: string | { kind: string; value: string };
}

export interface LspSignatureInformation {
  label: string;
  documentation?: string | { kind: string; value: string };
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  hoverProvider?: boolean | object;
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  documentFormattingProvider?: boolean | object;
  [key: string]: unknown;
}

// ── JSON-RPC framing types ──────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ── Spawn endpoint response shape ───────────────────────────────────────────

interface SpawnSuccess {
  ok: true;
  sessionId: string;
  /** Present only for fresh-mode (single-buffer) workspaces. */
  mainFileUri?: string;
  rootUri: string;
}

interface SpawnFailure {
  ok: false;
  error: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

export type DiagnosticsListener = (diagnostics: LspDiagnostic[]) => void;
export type AnyDiagnosticsListener = (uri: string, diagnostics: LspDiagnostic[]) => void;

export interface LspClient {
  /** Convenience URI for single-buffer workspaces; null for project workspaces. */
  readonly mainFileUri: string | null;
  readonly rootUri: string;
  readonly languageId: string;
  readonly capabilities: LspServerCapabilities;

  // ── Single-buffer convenience (uses mainFileUri) ──
  didOpen(text: string): void;
  didChange(text: string): void;
  hover(line: number, character: number): Promise<LspHover | null>;
  completion(line: number, character: number, triggerCharacter?: string): Promise<LspCompletionList | null>;
  signatureHelp(line: number, character: number): Promise<LspSignatureHelp | null>;
  formatting(): Promise<LspTextEdit[] | null>;
  getDiagnostics(): LspDiagnostic[];
  onDiagnostics(cb: DiagnosticsListener): () => void;

  // ── Multi-file (project workspaces) ──
  didOpenUri(uri: string, languageId: string, text: string): void;
  didChangeUri(uri: string, text: string): void;
  didCloseUri(uri: string): void;
  hoverUri(uri: string, line: number, character: number): Promise<LspHover | null>;
  completionUri(uri: string, line: number, character: number, triggerCharacter?: string): Promise<LspCompletionList | null>;
  formattingUri(uri: string): Promise<LspTextEdit[] | null>;
  getDiagnosticsByUri(): ReadonlyMap<string, LspDiagnostic[]>;
  onAnyDiagnostics(cb: AnyDiagnosticsListener): () => void;

  isOpen(): boolean;
  dispose(): Promise<void>;
}

/**
 * The LSP `languageId` value for a given lang — the standard token clangd /
 * rust-analyzer / pyright / etc. expect.
 */
const LSP_LANGUAGE_IDS: Partial<Record<LanguageId, string>> = {
  cpp: 'cpp',
  rust: 'rust',
  python: 'python',
  csharp: 'csharp',
  // web is multi-language at the file level; per-tab dispatch in projectEditor.ts
};

/** Languages that operate on the project workspace (multi-file editor). */
const PROJECT_LANGS: ReadonlySet<LanguageId> = new Set<LanguageId>(['csharp', 'web']);

/**
 * Open an LSP session for the given language. Returns null if the toolchain
 * isn't available or the spawn / handshake fails — the caller should silently
 * fall back to the existing /check + /format path.
 */
export async function connectLsp(lang: LanguageId): Promise<LspClient | null> {
  const languageId = LSP_LANGUAGE_IDS[lang];
  if (languageId === undefined) return null;

  // 1. Spawn the server-side child.
  let spawnRes: Response;
  try {
    spawnRes = await fetch('/lsp/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang }),
    });
  } catch {
    return null;
  }
  if (!spawnRes.ok) {
    // 503 = unavailable; let the caller fall back silently.
    return null;
  }
  const spawnBody = (await spawnRes.json()) as SpawnSuccess | SpawnFailure;
  if (!spawnBody.ok) return null;
  const { sessionId, rootUri } = spawnBody;
  const mainFileUri = spawnBody.mainFileUri ?? null;
  // Single-buffer languages must have a mainFileUri (the convenience APIs
  // depend on it). Project-mode languages legitimately omit it.
  if (mainFileUri === null && !PROJECT_LANGS.has(lang)) {
    void disposeRemoteSession(sessionId);
    return null;
  }

  // 2. Open the WebSocket and run the initialize/initialized handshake.
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProto}//${window.location.host}/lsp?session=${encodeURIComponent(sessionId)}`);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  }).catch(() => null);
  if (ws.readyState !== WebSocket.OPEN) {
    void disposeRemoteSession(sessionId);
    return null;
  }

  const client = new LspClientImpl(ws, sessionId, mainFileUri, languageId, rootUri);
  try {
    await client.initialize();
  } catch (e) {
    console.warn(`[lsp:${lang}] initialize failed:`, e);
    await client.dispose();
    return null;
  }
  return client;
}

async function disposeRemoteSession(sessionId: string): Promise<void> {
  try {
    await fetch('/lsp/dispose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // ignore — best effort
  }
}

// ── Implementation ──────────────────────────────────────────────────────────

const INITIALIZE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;

class LspClientImpl implements LspClient {
  readonly mainFileUri: string | null;
  readonly languageId: string;
  readonly rootUri: string;
  capabilities: LspServerCapabilities = {};

  private readonly ws: WebSocket;
  private readonly sessionId: string;
  private nextId = 1;
  private opened = false;
  private disposed = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>();
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  // Per-URI document versions for textDocument/didChange — LSP requires
  // monotonically increasing version numbers per URI.
  private readonly versions = new Map<string, number>();
  // Set of URIs we have called textDocument/didOpen for (and not yet closed).
  private readonly openUris = new Set<string>();
  private readonly diagnosticsListeners = new Set<DiagnosticsListener>();
  private readonly anyDiagnosticsListeners = new Set<AnyDiagnosticsListener>();

  constructor(ws: WebSocket, sessionId: string, mainFileUri: string | null, languageId: string, rootUri: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.mainFileUri = mainFileUri;
    this.languageId = languageId;
    this.rootUri = rootUri;

    ws.addEventListener('message', (ev) => this.onMessage(ev.data as string));
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => this.handleClose());
  }

  isOpen(): boolean {
    return !this.disposed && this.ws.readyState === WebSocket.OPEN;
  }

  async initialize(): Promise<void> {
    const result = (await this.request(
      'initialize',
      {
        processId: null,
        clientInfo: { name: 'lang-tutor' },
        rootUri: this.rootUri,
        capabilities: clientCapabilities(),
        trace: 'off',
        workspaceFolders: [{ uri: this.rootUri, name: 'lesson' }],
      },
      INITIALIZE_TIMEOUT_MS
    )) as { capabilities?: LspServerCapabilities };
    this.capabilities = result?.capabilities ?? {};
    this.notify('initialized', {});
  }

  // ── Single-buffer convenience (delegates to the multi-file methods) ──

  didOpen(text: string): void {
    if (this.mainFileUri === null) return;
    this.didOpenUri(this.mainFileUri, this.languageId, text);
    this.opened = true;
  }

  didChange(text: string): void {
    if (this.mainFileUri === null) return;
    if (!this.opened) {
      this.didOpen(text);
      return;
    }
    this.didChangeUri(this.mainFileUri, text);
  }

  hover(line: number, character: number): Promise<LspHover | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.hoverUri(this.mainFileUri, line, character);
  }

  completion(line: number, character: number, triggerCharacter?: string): Promise<LspCompletionList | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.completionUri(this.mainFileUri, line, character, triggerCharacter);
  }

  async signatureHelp(line: number, character: number): Promise<LspSignatureHelp | null> {
    if (this.mainFileUri === null) return null;
    if (!this.isOpen() || this.capabilities.signatureHelpProvider === undefined) return null;
    try {
      return (await this.request('textDocument/signatureHelp', {
        textDocument: { uri: this.mainFileUri },
        position: { line, character },
      })) as LspSignatureHelp | null;
    } catch {
      return null;
    }
  }

  formatting(): Promise<LspTextEdit[] | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.formattingUri(this.mainFileUri);
  }

  getDiagnostics(): LspDiagnostic[] {
    if (this.mainFileUri === null) return [];
    return this.diagnosticsByUri.get(this.mainFileUri) ?? [];
  }

  onDiagnostics(cb: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(cb);
    return () => this.diagnosticsListeners.delete(cb);
  }

  // ── Multi-file (project workspaces) ──

  didOpenUri(uri: string, languageId: string, text: string): void {
    if (!this.isOpen()) return;
    if (this.openUris.has(uri)) {
      // Already open — update content via didChange to stay protocol-correct.
      this.didChangeUri(uri, text);
      return;
    }
    this.openUris.add(uri);
    this.versions.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChangeUri(uri: string, text: string): void {
    if (!this.isOpen()) return;
    if (!this.openUris.has(uri)) {
      // The server hasn't seen this URI yet — open it instead of dropping.
      this.didOpenUri(uri, this.languageId, text);
      return;
    }
    const next = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: next },
      contentChanges: [{ text }],
    });
  }

  didCloseUri(uri: string): void {
    if (!this.isOpen()) return;
    if (!this.openUris.has(uri)) return;
    this.openUris.delete(uri);
    this.versions.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async hoverUri(uri: string, line: number, character: number): Promise<LspHover | null> {
    if (!this.isOpen() || this.capabilities.hoverProvider === undefined || this.capabilities.hoverProvider === false) {
      return null;
    }
    try {
      return (await this.request('textDocument/hover', {
        textDocument: { uri },
        position: { line, character },
      })) as LspHover | null;
    } catch {
      return null;
    }
  }

  async completionUri(uri: string, line: number, character: number, triggerCharacter?: string): Promise<LspCompletionList | null> {
    if (!this.isOpen() || this.capabilities.completionProvider === undefined) return null;
    try {
      const result = (await this.request('textDocument/completion', {
        textDocument: { uri },
        position: { line, character },
        context: triggerCharacter !== undefined ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 },
      })) as LspCompletionList | LspCompletionItem[] | null;
      if (result === null) return null;
      if (Array.isArray(result)) return { isIncomplete: false, items: result };
      return result;
    } catch {
      return null;
    }
  }

  async formattingUri(uri: string): Promise<LspTextEdit[] | null> {
    if (!this.isOpen() || this.capabilities.documentFormattingProvider === undefined || this.capabilities.documentFormattingProvider === false) {
      return null;
    }
    try {
      return (await this.request('textDocument/formatting', {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, insertFinalNewline: true },
      })) as LspTextEdit[] | null;
    } catch {
      return null;
    }
  }

  getDiagnosticsByUri(): ReadonlyMap<string, LspDiagnostic[]> {
    return this.diagnosticsByUri;
  }

  onAnyDiagnostics(cb: AnyDiagnosticsListener): () => void {
    this.anyDiagnosticsListeners.add(cb);
    return () => this.anyDiagnosticsListeners.delete(cb);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('client disposed'));
    }
    this.pending.clear();
    this.diagnosticsListeners.clear();
    this.anyDiagnosticsListeners.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    await disposeRemoteSession(this.sessionId);
  }

  // ── private wire helpers ──

  private send(message: JsonRpcMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.isOpen()) return Promise.reject(new Error('client not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`lsp request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      console.warn('[lsp] non-JSON message:', raw.slice(0, 120));
      return;
    }

    // Response to one of our requests.
    if ('id' in msg && msg.id !== null && !('method' in msg)) {
      const id = msg.id;
      const entry = this.pending.get(id);
      if (entry === undefined) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.error !== undefined) {
        entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        return;
      }
      entry.resolve(msg.result);
      return;
    }

    // Server-initiated request (rare — clangd uses a few; respond with empty
    // result to keep the protocol unblocked).
    if ('method' in msg && 'id' in msg && msg.id !== null) {
      this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }

    // Notification.
    if ('method' in msg) {
      this.handleNotification(msg.method, (msg as JsonRpcNotification).params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      const p = params as { uri: string; diagnostics: LspDiagnostic[] } | undefined;
      if (p === undefined) return;
      this.diagnosticsByUri.set(p.uri, p.diagnostics);
      if (p.uri === this.mainFileUri) {
        for (const cb of this.diagnosticsListeners) {
          try {
            cb(p.diagnostics);
          } catch (e) {
            console.warn('[lsp] diagnostics listener threw:', e);
          }
        }
      }
      for (const cb of this.anyDiagnosticsListeners) {
        try {
          cb(p.uri, p.diagnostics);
        } catch (e) {
          console.warn('[lsp] anyDiagnostics listener threw:', e);
        }
      }
      return;
    }
    // window/logMessage, window/showMessage, $/progress, etc. — ignore.
  }

  private handleClose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('lsp connection closed'));
    }
    this.pending.clear();
    this.diagnosticsListeners.clear();
    this.anyDiagnosticsListeners.clear();
  }
}

function clientCapabilities() {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
      publishDiagnostics: { relatedInformation: true, codeDescriptionSupport: true, dataSupport: false },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      completion: {
        completionItem: {
          snippetSupport: false,
          documentationFormat: ['markdown', 'plaintext'],
          insertReplaceSupport: false,
        },
        contextSupport: true,
      },
      signatureHelp: {
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: { labelOffsetSupport: true },
        },
      },
      formatting: { dynamicRegistration: false },
    },
    workspace: { workspaceFolders: true },
    general: { positionEncodings: ['utf-16'] },
  };
}
