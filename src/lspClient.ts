/**
 * Hand-rolled LSP client over WebSocket. Multi-server-per-language: a single
 * `LspClient` may wrap several `ServerSession` instances (one per spawned LSP
 * process). For single-server languages (cpp / rust / python / csharp) the
 * bundle has one entry; for `web` the bundle fans out across
 * typescript-language-server (primary) + HTML / CSS / Biome.
 *
 * Lifecycle:
 *   connectLsp(lang) → POST /lsp/spawn → bundle of {serverKey, sessionId, acceptsLanguageIds}
 *                    → open one WS per server, run initialize on each
 *   client.didOpen(text) once after connect; client.didChange(text) on every CodeMirror update
 *   client.hover/completion/signatureHelp/inlayHint/documentSymbol/formatting on demand
 *   client.dispose() on language switch / page unload (closes every server)
 *
 * Per-file dispatch (multi-file langs):
 *   didOpenUri(uri, languageId, text) records the URI's languageId and forwards
 *   the open to every server whose `acceptsLanguageIds` set covers it. Single-server
 *   languages don't carry an `acceptsLanguageIds` set — they are universal for
 *   their lang and accept any open call.
 *
 * Diagnostics arrive per-server via textDocument/publishDiagnostics; the bundle
 * merges them into a per-URI union map for `getDiagnostics()` /
 * `getDiagnosticsByUri()` and notifies listeners with the merged list each
 * time any server publishes.
 */

import { appUrl, appWsUrl } from './appUrls';
import { canUseHostedTooling } from './authClient';
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

/** LSP SymbolKind subset (DocumentSymbol uses the full set; we mostly care about the names). */
export type LspSymbolKind = number;

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: LspSymbolKind;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/** LSP InlayHintKind: 1 = Type, 2 = Parameter. */
export type LspInlayHintKind = 1 | 2;

export interface LspInlayHintLabelPart {
  value: string;
  tooltip?: string | { kind: string; value: string };
}

export interface LspInlayHint {
  position: LspPosition;
  label: string | LspInlayHintLabelPart[];
  kind?: LspInlayHintKind;
  tooltip?: string | { kind: string; value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** LSP CodeAction (server returns either a Command or a CodeAction; we treat them uniformly). */
export interface LspCodeAction {
  title: string;
  /** quickfix | refactor | refactor.extract | source.organizeImports | etc. */
  kind?: string;
  /** Diagnostics this action addresses. */
  diagnostics?: LspDiagnostic[];
  /** Inline edit to apply. Either edit OR command may be present (or both). */
  edit?: LspWorkspaceEdit;
  /** Server-side command to execute (post-resolve). */
  command?: { title: string; command: string; arguments?: unknown[] };
  /** Opaque token the server expects back on codeAction/resolve. */
  data?: unknown;
  /** True when the server wants the user's preferred fix highlighted. */
  isPreferred?: boolean;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument: { uri: string; version?: number | null };
    edits: LspTextEdit[];
  }>;
}

export interface LspServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  hoverProvider?: boolean | object;
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  documentFormattingProvider?: boolean | object;
  inlayHintProvider?: boolean | { resolveProvider?: boolean };
  documentSymbolProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
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
  rootUri: string;
  /** Present only when the bundle's primary server is fresh-mode (single-buffer). */
  mainFileUri?: string;
  servers: ReadonlyArray<{
    serverKey: string;
    sessionId: string;
    acceptsLanguageIds: readonly string[];
  }>;
  unavailable: ReadonlyArray<{ serverKey: string; error: string }>;
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
  /** Capabilities of the primary (first) server in the bundle. Use for trigger-char filtering on single-buffer extensions. */
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
  signatureHelpUri(uri: string, line: number, character: number): Promise<LspSignatureHelp | null>;
  inlayHint(range: LspRange): Promise<LspInlayHint[] | null>;
  inlayHintUri(uri: string, range: LspRange): Promise<LspInlayHint[] | null>;
  documentSymbol(): Promise<LspDocumentSymbol[] | null>;
  documentSymbolUri(uri: string): Promise<LspDocumentSymbol[] | null>;
  formattingUri(uri: string): Promise<LspTextEdit[] | null>;
  codeAction(range: LspRange, diagnostics: readonly LspDiagnostic[]): Promise<LspCodeAction[] | null>;
  codeActionUri(uri: string, range: LspRange, diagnostics: readonly LspDiagnostic[]): Promise<LspCodeAction[] | null>;
  resolveCodeAction(action: LspCodeAction): Promise<LspCodeAction | null>;
  /** Broadcast a workspace/didChangeWatchedFiles notification to every server in the bundle. */
  notifyWatchedFilesChanged(uris: readonly string[], type?: 1 | 2 | 3): void;
  getDiagnosticsByUri(): ReadonlyMap<string, LspDiagnostic[]>;
  onAnyDiagnostics(cb: AnyDiagnosticsListener): () => void;

  isOpen(): boolean;
  dispose(): Promise<void>;
}

/**
 * The LSP `languageId` value used as the default for single-buffer langs in
 * didOpen calls AND as the fallback for project-mode files that have not yet
 * had didOpenUri called with an explicit langId. Project langs primarily
 * route per-file via projectEditor.ts's lspLanguageIdForPath; the fallback
 * here just steers the routing to the bundle's primary server when an
 * unmapped URI is queried.
 */
const LSP_LANGUAGE_IDS: Partial<Record<LanguageId, string>> = {
  cpp: 'cpp',
  dasm: 'cpp',
  rust: 'rust',
  python: 'python',
  csharp: 'csharp',
  // For web, the primary server (typescript-language-server) handles the
  // typescript / javascript family. HTML / CSS / JSON files come in via
  // didOpenUri with their own explicit langIds, so the fallback only kicks
  // in for typescript-shaped queries.
  web: 'typescript',
};

/** Languages that operate on the project workspace (multi-file editor). */
const PROJECT_LANGS: ReadonlySet<LanguageId> = new Set<LanguageId>(['csharp', 'web']);

/**
 * Different language servers canonicalize file URIs differently — most notably
 * the colon after a Windows drive letter: clangd / rust-analyzer keep it
 * literal (`file:///x:/...`) while basedpyright / tsserver percent-encode it
 * (`file:///x%3A/...`). Normalize both forms back to literal `:` so the same
 * URI key works regardless of who emitted it.
 */
function normalizeUri(uri: string): string {
  return uri.replaceAll('%3A', ':').replaceAll('%3a', ':');
}

/**
 * Open an LSP session bundle for the given language. Returns null if the
 * bundle endpoint says no server is available, or if every server's WS /
 * initialize handshake fails. Caller should silently fall back.
 */
export async function connectLsp(lang: LanguageId): Promise<LspClient | null> {
  if (!canUseHostedTooling()) return null;
  const languageId = LSP_LANGUAGE_IDS[lang];
  if (languageId === undefined) return null;

  // 1. Spawn the bundle (one or more LSP children sharing a workspace).
  let spawnRes: Response;
  try {
    spawnRes = await fetch(appUrl('/lsp/spawn'), {
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
  const { rootUri, servers } = spawnBody;
  const mainFileUri = spawnBody.mainFileUri ?? null;

  // Single-buffer languages must have a mainFileUri (the convenience APIs
  // depend on it). Project-mode languages legitimately omit it.
  if (mainFileUri === null && !PROJECT_LANGS.has(lang)) {
    for (const s of servers) void disposeRemoteSession(s.sessionId);
    return null;
  }

  if (spawnBody.unavailable.length > 0) {
    for (const u of spawnBody.unavailable) console.info(`[lsp:${lang}] ${u.serverKey} unavailable: ${u.error}`);
  }

  // 2. Open one WebSocket per server and run initialize on each.
  const sessions: ServerSession[] = [];
  for (const meta of servers) {
    const ws = new WebSocket(appWsUrl(`/lsp?session=${encodeURIComponent(meta.sessionId)}`));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    }).catch(() => null);
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn(`[lsp:${lang}] ${meta.serverKey}: ws failed to open, skipping`);
      void disposeRemoteSession(meta.sessionId);
      continue;
    }
    const session = new ServerSession(ws, meta.sessionId, meta.serverKey, rootUri, [...meta.acceptsLanguageIds]);
    try {
      await session.initialize();
    } catch (e) {
      console.warn(`[lsp:${lang}] ${meta.serverKey} initialize failed:`, e);
      await session.dispose();
      continue;
    }
    sessions.push(session);
  }

  if (sessions.length === 0) return null;

  return new LspClientImpl(sessions, mainFileUri, languageId, rootUri);
}

async function disposeRemoteSession(sessionId: string): Promise<void> {
  try {
    await fetch(appUrl('/lsp/dispose'), {
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

/**
 * One LSP server inside a bundle. Owns its WebSocket, the JSON-RPC pending
 * map, capability snapshot, per-URI version + open-set, and a cache of the
 * latest publishDiagnostics for each URI it has seen.
 *
 * `acceptsLanguageIds` is empty for single-server languages (universal accept);
 * non-empty for fan-out servers (e.g. web-html accepts only `html`).
 */
class ServerSession {
  capabilities: LspServerCapabilities = {};

  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>();
  private readonly _diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private readonly versions = new Map<string, number>();
  private readonly openUris = new Set<string>();
  private readonly diagnosticsListeners = new Set<(uri: string, diagnostics: LspDiagnostic[]) => void>();

  constructor(
    private readonly ws: WebSocket,
    readonly sessionId: string,
    readonly serverKey: string,
    readonly rootUri: string,
    readonly acceptsLanguageIds: readonly string[]
  ) {
    ws.addEventListener('message', (ev) => this.onMessage(ev.data as string));
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => this.handleClose());
  }

  /** True iff this server accepts the given LSP languageId (universal when its accept-set is empty). */
  accepts(languageId: string): boolean {
    if (this.acceptsLanguageIds.length === 0) return true;
    return this.acceptsLanguageIds.includes(languageId);
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

  didOpen(uri: string, languageId: string, text: string): void {
    if (!this.isOpen()) return;
    if (this.openUris.has(uri)) {
      this.didChange(uri, text);
      return;
    }
    this.openUris.add(uri);
    this.versions.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChange(uri: string, text: string): void {
    if (!this.isOpen()) return;
    if (!this.openUris.has(uri)) return; // upstream caller hasn't opened this URI on this server (lang mismatch)
    const next = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: next },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    if (!this.isOpen()) return;
    if (!this.openUris.has(uri)) return;
    this.openUris.delete(uri);
    this.versions.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  isOpenUri(uri: string): boolean {
    return this.openUris.has(uri);
  }

  diagnosticsForUri(uri: string): LspDiagnostic[] {
    return this._diagnosticsByUri.get(uri) ?? [];
  }

  diagnosticsByUri(): ReadonlyMap<string, LspDiagnostic[]> {
    return this._diagnosticsByUri;
  }

  onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): () => void {
    this.diagnosticsListeners.add(cb);
    return () => this.diagnosticsListeners.delete(cb);
  }

  // Generic LSP request. Caller checks capabilities before invoking.
  async sendRequest<T>(method: string, params: unknown): Promise<T | null> {
    if (!this.isOpen()) return null;
    try {
      return (await this.request(method, params)) as T | null;
    } catch {
      return null;
    }
  }

  /** Generic LSP notification (fire-and-forget; no response). */
  sendNotification(method: string, params: unknown): void {
    if (!this.isOpen()) return;
    this.notify(method, params);
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
      const normUri = normalizeUri(p.uri);
      this._diagnosticsByUri.set(normUri, p.diagnostics);
      for (const cb of this.diagnosticsListeners) {
        try {
          cb(normUri, p.diagnostics);
        } catch (e) {
          console.warn('[lsp] diagnostics listener threw:', e);
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
  }
}

class LspClientImpl implements LspClient {
  readonly mainFileUri: string | null;
  readonly languageId: string;
  readonly rootUri: string;

  /**
   * Per-URI languageId, populated by didOpenUri. Used by the request
   * dispatchers to pick the right server for a file.
   */
  private readonly uriLangIds = new Map<string, string>();

  /**
   * Whether the single-buffer mainFileUri has been opened on the primary.
   * For project mode this stays false; per-URI tracking is on each ServerSession.
   */
  private mainFileOpened = false;

  private readonly diagnosticsListeners = new Set<DiagnosticsListener>();
  private readonly anyDiagnosticsListeners = new Set<AnyDiagnosticsListener>();

  /**
   * Cleanup callbacks for the per-server diagnostic subscriptions; invoked on
   * dispose so we don't leak listeners.
   */
  private readonly serverUnsubs: Array<() => void> = [];

  constructor(
    private readonly servers: ServerSession[],
    mainFileUri: string | null,
    languageId: string,
    rootUri: string
  ) {
    this.mainFileUri = mainFileUri;
    this.languageId = languageId;
    this.rootUri = rootUri;

    // Subscribe to every server's diagnostics. When any server publishes for
    // a URI, fire both the main-file listener (for single-buffer langs) and
    // the any-URI listeners with the *merged* per-URI list across all servers.
    for (const s of this.servers) {
      const off = s.onDiagnostics((uri, _diags) => {
        const merged = this.collectDiagnosticsForUri(uri);
        if (this.mainFileUri !== null && uri === normalizeUri(this.mainFileUri)) {
          for (const cb of this.diagnosticsListeners) {
            try {
              cb(merged);
            } catch (e) {
              console.warn('[lsp] diagnostics listener threw:', e);
            }
          }
        }
        for (const cb of this.anyDiagnosticsListeners) {
          try {
            cb(uri, merged);
          } catch (e) {
            console.warn('[lsp] anyDiagnostics listener threw:', e);
          }
        }
      });
      this.serverUnsubs.push(off);
    }
  }

  get capabilities(): LspServerCapabilities {
    // The first server is the "primary" (typescript-language-server for web,
    // the only server for everything else). Trigger-character / completion
    // routing in single-buffer extensions reads from this snapshot.
    return this.servers[0]?.capabilities ?? {};
  }

  isOpen(): boolean {
    return this.servers.some((s) => s.isOpen());
  }

  // ── Single-buffer convenience (only one server for these languages) ─────

  didOpen(text: string): void {
    if (this.mainFileUri === null) return;
    this.didOpenUri(this.mainFileUri, this.languageId, text);
    this.mainFileOpened = true;
  }

  didChange(text: string): void {
    if (this.mainFileUri === null) return;
    if (!this.mainFileOpened) {
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

  signatureHelp(line: number, character: number): Promise<LspSignatureHelp | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.signatureHelpUri(this.mainFileUri, line, character);
  }

  inlayHint(range: LspRange): Promise<LspInlayHint[] | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.inlayHintUri(this.mainFileUri, range);
  }

  documentSymbol(): Promise<LspDocumentSymbol[] | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.documentSymbolUri(this.mainFileUri);
  }

  formatting(): Promise<LspTextEdit[] | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.formattingUri(this.mainFileUri);
  }

  getDiagnostics(): LspDiagnostic[] {
    if (this.mainFileUri === null) return [];
    return this.collectDiagnosticsForUri(normalizeUri(this.mainFileUri));
  }

  onDiagnostics(cb: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(cb);
    return () => this.diagnosticsListeners.delete(cb);
  }

  // ── Multi-file (project workspaces) ─────────────────────────────────────

  didOpenUri(uri: string, languageId: string, text: string): void {
    this.uriLangIds.set(normalizeUri(uri), languageId);
    for (const s of this.servers) {
      if (!s.accepts(languageId)) continue;
      s.didOpen(uri, languageId, text);
    }
  }

  didChangeUri(uri: string, text: string): void {
    const langId = this.uriLangIds.get(normalizeUri(uri)) ?? this.languageId;
    for (const s of this.servers) {
      if (!s.accepts(langId)) continue;
      if (!s.isOpenUri(uri)) {
        // The server hasn't seen this URI yet (e.g., rapid switch); open it now.
        s.didOpen(uri, langId, text);
        continue;
      }
      s.didChange(uri, text);
    }
  }

  didCloseUri(uri: string): void {
    for (const s of this.servers) s.didClose(uri);
    this.uriLangIds.delete(normalizeUri(uri));
  }

  /**
   * Broadcast a `workspace/didChangeWatchedFiles` notification to every
   * server in the bundle. Used after initial tab hydration to nudge servers
   * with sluggish workspace indexers (OmniSharp's first-load) into picking
   * up the seeded files. Notification-only — fire-and-forget.
   *
   * @param uris  the file URIs that changed
   * @param type  1 = Created, 2 = Changed (default), 3 = Deleted
   */
  notifyWatchedFilesChanged(uris: readonly string[], type: 1 | 2 | 3 = 2): void {
    if (uris.length === 0) return;
    const changes = uris.map((uri) => ({ uri, type }));
    for (const s of this.servers) {
      s.sendNotification('workspace/didChangeWatchedFiles', { changes });
    }
  }

  hoverUri(uri: string, line: number, character: number): Promise<LspHover | null> {
    const target = this.pickFirst(uri, (cap) => cap.hoverProvider !== undefined && cap.hoverProvider !== false);
    if (target === null) return Promise.resolve(null);
    return target.sendRequest<LspHover>('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async completionUri(uri: string, line: number, character: number, triggerCharacter?: string): Promise<LspCompletionList | null> {
    const target = this.pickFirst(uri, (cap) => cap.completionProvider !== undefined);
    if (target === null) return null;
    const result = await target.sendRequest<LspCompletionList | LspCompletionItem[]>('textDocument/completion', {
      textDocument: { uri },
      position: { line, character },
      context: triggerCharacter !== undefined ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 },
    });
    if (result === null) return null;
    if (Array.isArray(result)) return { isIncomplete: false, items: result };
    return result;
  }

  signatureHelpUri(uri: string, line: number, character: number): Promise<LspSignatureHelp | null> {
    const target = this.pickFirst(uri, (cap) => cap.signatureHelpProvider !== undefined);
    if (target === null) return Promise.resolve(null);
    return target.sendRequest<LspSignatureHelp>('textDocument/signatureHelp', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  inlayHintUri(uri: string, range: LspRange): Promise<LspInlayHint[] | null> {
    const target = this.pickFirst(uri, (cap) => cap.inlayHintProvider !== undefined && cap.inlayHintProvider !== false);
    if (target === null) return Promise.resolve(null);
    return target.sendRequest<LspInlayHint[]>('textDocument/inlayHint', {
      textDocument: { uri },
      range,
    });
  }

  async documentSymbolUri(uri: string): Promise<LspDocumentSymbol[] | null> {
    const target = this.pickFirst(uri, (cap) => cap.documentSymbolProvider !== undefined && cap.documentSymbolProvider !== false);
    if (target === null) return null;
    const result = await target.sendRequest<LspDocumentSymbol[] | Array<{ name: string; kind: number; location: { range: LspRange } }>>(
      'textDocument/documentSymbol',
      { textDocument: { uri } }
    );
    if (result === null) return null;
    const first = result[0];
    if (first !== undefined && 'location' in first) {
      return (result as Array<{ name: string; kind: number; location: { range: LspRange } }>).map((s) => ({
        name: s.name,
        kind: s.kind,
        range: s.location.range,
        selectionRange: s.location.range,
      }));
    }
    return result as LspDocumentSymbol[];
  }

  formattingUri(uri: string): Promise<LspTextEdit[] | null> {
    const target = this.pickFirst(uri, (cap) => cap.documentFormattingProvider !== undefined && cap.documentFormattingProvider !== false);
    if (target === null) return Promise.resolve(null);
    return target.sendRequest<LspTextEdit[]>('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, insertFinalNewline: true },
    });
  }

  codeAction(range: LspRange, diagnostics: readonly LspDiagnostic[]): Promise<LspCodeAction[] | null> {
    if (this.mainFileUri === null) return Promise.resolve(null);
    return this.codeActionUri(this.mainFileUri, range, diagnostics);
  }

  /**
   * Fetch code actions for the given range. The bundle queries every server
   * whose `acceptsLanguageIds` covers the URI's tracked langId AND whose
   * capabilities advertise `codeActionProvider`. Results are concatenated so
   * actions from tsserver + biome (overlapping for `.ts`) both surface.
   *
   * Returned actions may be unresolved (have `data` but no `edit`); callers
   * pass them to `resolveCodeAction` before applying.
   */
  async codeActionUri(uri: string, range: LspRange, diagnostics: readonly LspDiagnostic[]): Promise<LspCodeAction[] | null> {
    const langId = this.uriLangIds.get(normalizeUri(uri)) ?? this.languageId;
    const targets = this.servers.filter(
      (s) => s.isOpen() && s.accepts(langId) && s.capabilities.codeActionProvider !== undefined && s.capabilities.codeActionProvider !== false
    );
    if (targets.length === 0) return null;

    const params = {
      textDocument: { uri },
      range,
      context: { diagnostics: [...diagnostics], triggerKind: 1 /* Invoked */ },
    };
    const all: LspCodeAction[] = [];
    for (const t of targets) {
      const result = await t.sendRequest<Array<LspCodeAction | { title: string; command: string; arguments?: unknown[] }>>(
        'textDocument/codeAction',
        params
      );
      if (result === null) continue;
      for (const item of result) {
        if (item === null || typeof item !== 'object') continue;
        // Server may send either CodeAction or Command; normalize Command into a CodeAction with no edit.
        if ('command' in item && typeof (item as { command: unknown }).command === 'string') {
          const cmd = item as { title: string; command: string; arguments?: unknown[] };
          const wrapped: LspCodeAction = {
            title: cmd.title,
            command:
              cmd.arguments !== undefined
                ? { title: cmd.title, command: cmd.command, arguments: cmd.arguments }
                : { title: cmd.title, command: cmd.command },
          };
          all.push(wrapped);
          continue;
        }
        all.push(item as LspCodeAction);
      }
    }
    return all;
  }

  /**
   * Resolve a code action whose `edit`/`command` was lazily deferred. Servers
   * that advertise `codeActionProvider.resolveProvider: true` ship just the
   * title + data initially and fill in the edit on resolve. Returns the
   * fully-populated action, or the original if no resolve was needed.
   */
  async resolveCodeAction(action: LspCodeAction): Promise<LspCodeAction | null> {
    // Already resolved or simple Command — nothing to do.
    if (action.edit !== undefined || (action.command !== undefined && action.data === undefined)) return action;
    // Find any server that advertises resolveProvider; we don't know which
    // server produced the action, so fan out — first non-null wins.
    for (const s of this.servers) {
      if (!s.isOpen()) continue;
      const cap = s.capabilities.codeActionProvider;
      if (cap === undefined || cap === false || cap === true) continue;
      if (cap.resolveProvider !== true) continue;
      const resolved = await s.sendRequest<LspCodeAction>('codeAction/resolve', action);
      if (resolved !== null) return resolved;
    }
    return action;
  }

  getDiagnosticsByUri(): ReadonlyMap<string, LspDiagnostic[]> {
    // Build a fresh merged map per call. Cheap (only invoked when assembling
    // [LSP] block at evaluate time + on tab switch).
    const merged = new Map<string, LspDiagnostic[]>();
    for (const s of this.servers) {
      for (const [uri, diags] of s.diagnosticsByUri()) {
        if (diags.length === 0) continue;
        const existing = merged.get(uri);
        if (existing === undefined) merged.set(uri, [...diags]);
        else merged.set(uri, [...existing, ...diags]);
      }
    }
    return merged;
  }

  onAnyDiagnostics(cb: AnyDiagnosticsListener): () => void {
    this.anyDiagnosticsListeners.add(cb);
    return () => this.anyDiagnosticsListeners.delete(cb);
  }

  async dispose(): Promise<void> {
    this.diagnosticsListeners.clear();
    this.anyDiagnosticsListeners.clear();
    for (const off of this.serverUnsubs) off();
    this.serverUnsubs.length = 0;
    await Promise.all(this.servers.map((s) => s.dispose()));
  }

  // ── private helpers ──

  private collectDiagnosticsForUri(normUri: string): LspDiagnostic[] {
    const out: LspDiagnostic[] = [];
    for (const s of this.servers) out.push(...s.diagnosticsForUri(normUri));
    return out;
  }

  /**
   * Pick the first server in `servers` order that (a) accepts the URI's
   * tracked languageId (or universal-accept when no langId is recorded) and
   * (b) reports the requested capability. Returns null if no server matches.
   */
  private pickFirst(uri: string, capabilityCheck: (cap: LspServerCapabilities) => boolean): ServerSession | null {
    const langId = this.uriLangIds.get(normalizeUri(uri)) ?? this.languageId;
    for (const s of this.servers) {
      if (!s.isOpen()) continue;
      if (!s.accepts(langId)) continue;
      if (!capabilityCheck(s.capabilities)) continue;
      return s;
    }
    return null;
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
      inlayHint: { dynamicRegistration: false, resolveSupport: { properties: [] } },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'],
          },
        },
        isPreferredSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ['edit', 'command'] },
      },
    },
    workspace: { workspaceFolders: true },
    general: { positionEncodings: ['utf-16'] },
  };
}
