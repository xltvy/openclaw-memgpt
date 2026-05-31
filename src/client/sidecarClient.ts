/**
 * Shared, typed sidecar client for the openclaw-memgpt plugin.
 *
 * Per API_DESIGN.md §3.4: one instance is shared across tool handlers, hooks,
 * and lifecycle. Each method maps 1:1 to a §2 endpoint (the memory-behaviour
 * surface). The management/status category (§3.5) is owned by
 * SidecarAdminClient — a separate class — by design, not oversight.
 *
 * 6c.1 — wire layer landed. Every method body issues a real HTTP request via
 * the shared `buildSidecarRequest` helper and surfaces failures through
 * `handleResponse`, which produces the typed errors from `./errors.ts` so
 * downstream tool / hook code can discriminate `CoreMemoryError` and
 * `BufferTooSmallError` without parsing strings.
 */

import type { PluginConfig } from "../config.ts";
import {
  BufferTooSmallError,
  CoreMemoryError,
  SidecarError,
  type CoreMemoryErrorCode,
} from "./errors.ts";
import type {
  ArchivalInsertResult,
  CoreMemoryName,
  CoreMemorySections,
  EnsureAgentResult,
  EnsureOpts,
  HealthzResponse,
  LoadResult,
  MessagesAppendResult,
  PyMemGptMessage,
  RecallSearchDateParams,
  SaveResult,
  SearchResult,
  SummarizeResult,
  SystemPromptSection,
} from "./types.ts";

// ============================================================================
// Contract — what callers depend on (hooks, tools, lifecycle close over this).
// ============================================================================

export interface SidecarClient {
  // — memory-behaviour surface (each method maps to a §2 endpoint) —————————

  /** §3.5 composite: resident → no-op | on-disk → :load | else create. */
  ensure(opts?: EnsureOpts): Promise<EnsureAgentResult>;
  /** §2.3 :save — flushes archival, recall, all_messages to disk. */
  save(): Promise<SaveResult>;
  /** §2.3 :load — cold-start rehydration; 409 if resident (cold-start-only). */
  load(): Promise<LoadResult>;

  /** §2.4 GET /system_prompt_section. */
  getSystemPromptSection(): Promise<SystemPromptSection>;
  /** §2.4 core_memory:append. 409 → CoreMemoryError carrying verbatim message. */
  coreMemoryAppend(name: CoreMemoryName, content: string): Promise<void>;
  /** §2.4 core_memory:replace. 409 → CoreMemoryError carrying verbatim message. */
  coreMemoryReplace(
    name: CoreMemoryName,
    oldContent: string,
    newContent: string,
  ): Promise<void>;
  /** §2.4 GET core_memory — observability / validation. */
  getCoreMemory(): Promise<CoreMemorySections>;

  /** §2.5 archival:insert. */
  archivalInsert(content: string): Promise<ArchivalInsertResult>;
  /** §2.5 archival:search. `total` is page-local (see types.ts note). */
  archivalSearch(query: string, page?: number): Promise<SearchResult>;

  /** §2.6 recall:search. `total` is true grand total (asymmetric to archival). */
  recallSearch(query: string, page?: number): Promise<SearchResult>;
  /** §2.6 recall:search_date. Params confirmed vs gpt_functions schema. */
  recallSearchDate(params: RecallSearchDateParams): Promise<SearchResult>;

  /** §2.7 messages:append — extends recall corpus; leaves active buffer untouched. */
  messagesAppend(messages: PyMemGptMessage[]): Promise<MessagesAppendResult>;

  /** §2.8 :summarize — cutoff + summary + packaged preamble. 422 → BufferTooSmallError. */
  summarize(
    messages: PyMemGptMessage[],
    totalMessageCount: number,
    tokenBudget?: number,
  ): Promise<SummarizeResult>;

  /** §2.2 /healthz — liveness; embedder + resident count. */
  healthz(): Promise<HealthzResponse>;
}

// ============================================================================
// Implementation
// ============================================================================

export class SidecarClientImpl implements SidecarClient {
  private readonly config: PluginConfig;
  private readonly resolveBaseUrl: () => Promise<string>;

  /** Initialisation guard per §3.4 — shared by all concurrent first-callers. */
  private initPromise?: Promise<void>;
  /** Set by doInit; non-null after first successful ensureReady(). */
  private baseUrl?: string;

  constructor(config: PluginConfig, resolveBaseUrl: () => Promise<string>) {
    this.config = config;
    this.resolveBaseUrl = resolveBaseUrl;
  }

  // ── readiness (§3.4) ──────────────────────────────────────────────────────

  /**
   * Concurrent first-callers share one initPromise. On failure the promise is
   * cleared so a later call retries — never caches the rejection.
   */
  protected ensureReady(): Promise<void> {
    return (this.initPromise ??= this.doInit().catch((e) => {
      this.initPromise = undefined;
      throw e;
    }));
  }

  /**
   * Init steps per §3.4:
   *   1. resolve baseUrl (injected by lifecycle in 6d — config / env / spawned port)
   *   2. poll /healthz until the sidecar's embedder has loaded
   *   3. :ensure the configured namespace (resident | load | create)
   *
   * All HTTP inside doInit uses the private `_*` helpers so it bypasses
   * `ensureReady` — calling it from inside would deadlock on the in-flight
   * initPromise.
   */
  protected async doInit(): Promise<void> {
    this.baseUrl = await this.resolveBaseUrl();
    await this._pollHealthz();
    await this._ensureAgent();
  }

  /** Test/diagnostic — returns the cached baseUrl, or undefined if never inited. */
  protected getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  // ── private helpers (§3.4) ────────────────────────────────────────────────

  /**
   * Centralised request builder. Every method body uses this — no raw fetch.
   * Reads the cached `this.baseUrl` (set during doInit); caller must have
   * already awaited ensureReady, or be inside doInit which sets it.
   */
  private buildSidecarRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Request {
    const base = this.baseUrl;
    if (base === undefined) {
      throw new Error(
        "SidecarClient: buildSidecarRequest called before init (baseUrl not set)",
      );
    }
    const url = new URL(path, base);
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return new Request(url, init);
  }

  /**
   * Returns this client's agent id. Trivial today; the indirection exists so
   * the (out-of-scope-for-v1) multi-namespace work has a single extension
   * point. §3.1 keeps a single namespace per plugin instance.
   */
  private resolveAgentId(): string {
    return this.config.namespace;
  }

  /**
   * Parse a sidecar response and produce the right typed result or error.
   *
   * - 2xx                  → JSON-parse and return as T.
   * - 409 + core-memory    → CoreMemoryError (§2.9) carrying verbatim message.
   * - 422 + :summarize     → BufferTooSmallError (§2.8) for 6c.6 to no-op.
   * - everything else      → SidecarError with status, path, and body.
   */
  private async handleResponse<T>(
    response: Response,
    path: string,
  ): Promise<T> {
    if (response.ok) {
      return (await response.json()) as T;
    }
    const body = await this._readBody(response);

    if (response.status === 409) {
      const cm = this._extractCoreMemoryError(body);
      if (cm !== null) throw new CoreMemoryError(cm);
    }
    if (response.status === 422 && path.includes(":summarize")) {
      const detail = this._extractDetail(body);
      throw new BufferTooSmallError(
        typeof detail === "string" ? detail : JSON.stringify(detail),
      );
    }
    throw new SidecarError({ status: response.status, path, body });
  }

  /**
   * Read a response body as JSON when possible, falling back to text — so
   * SidecarError carries useful diagnostics regardless of content type.
   */
  private async _readBody(response: Response): Promise<unknown> {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        return await response.json();
      } catch {
        // fall through to text
      }
    }
    return await response.text();
  }

  /**
   * FastAPI wraps HTTPException(detail=...) in `{"detail": ...}`. The sidecar's
   * `_core_memory_409` helper raises HTTPException(409, detail={error, message}),
   * so the wire body is `{"detail": {"error": code, "message": "<verbatim>"}}`.
   * Return the shaped envelope, or null if the body isn't a core-memory 409.
   */
  private _extractCoreMemoryError(
    body: unknown,
  ): { code: CoreMemoryErrorCode; message: string } | null {
    const detail = this._extractDetail(body);
    if (
      typeof detail === "object" &&
      detail !== null &&
      "error" in detail &&
      "message" in detail
    ) {
      const obj = detail as { error: unknown; message: unknown };
      const KNOWN: ReadonlyArray<CoreMemoryErrorCode> = [
        "core_memory_overflow",
        "core_memory_content_not_found",
        "core_memory_edit_failed",
      ];
      if (
        typeof obj.error === "string" &&
        typeof obj.message === "string" &&
        (KNOWN as ReadonlyArray<string>).includes(obj.error)
      ) {
        return {
          code: obj.error as CoreMemoryErrorCode,
          message: obj.message,
        };
      }
    }
    return null;
  }

  private _extractDetail(body: unknown): unknown {
    if (typeof body === "object" && body !== null && "detail" in body) {
      return (body as { detail: unknown }).detail;
    }
    return body;
  }

  // ── private init-time HTTP (bypass ensureReady to avoid deadlock) ─────────

  private async _pollHealthz(timeoutMs = 10_000): Promise<void> {
    const path = "/healthz";
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(this.buildSidecarRequest("GET", path));
        if (resp.ok) return;
        lastError = `HTTP ${resp.status}`;
      } catch (e) {
        lastError = e;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `Sidecar /healthz did not respond within ${timeoutMs}ms: ${String(lastError)}`,
    );
  }

  private async _ensureAgent(opts?: EnsureOpts): Promise<EnsureAgentResult> {
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}:ensure`;
    // doInit case: opts undefined → use config defaults so resident-no-op
    // shortcuts even on the first turn; create-branch fall-through gets the
    // configured model/persona/human.
    const source = opts ?? {
      model: this.config.model,
      persona: this.config.persona,
      human: this.config.human,
    };
    const body: Record<string, string> = {};
    if (source.model !== undefined) body.model = source.model;
    if (source.persona !== undefined) body.persona = source.persona;
    if (source.human !== undefined) body.human = source.human;

    const resp = await fetch(this.buildSidecarRequest("POST", path, body));
    const raw = await this.handleResponse<{
      agent_id: string;
      via: "resident" | "load" | "create";
    }>(resp, path);
    return { agentId: raw.agent_id, via: raw.via };
  }

  // ── public methods ────────────────────────────────────────────────────────

  async ensure(opts?: EnsureOpts): Promise<EnsureAgentResult> {
    await this.ensureReady();
    return this._ensureAgent(opts);
  }

  async save(): Promise<SaveResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}:save`;
    const resp = await fetch(this.buildSidecarRequest("POST", path, {}));
    return await this.handleResponse<SaveResult>(resp, path);
  }

  async load(): Promise<LoadResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}:load`;
    const resp = await fetch(this.buildSidecarRequest("POST", path, {}));
    const raw = await this.handleResponse<{
      agent_id: string;
      loaded_from: "cold_start";
    }>(resp, path);
    return { agentId: raw.agent_id, loadedFrom: raw.loaded_from };
  }

  async getSystemPromptSection(): Promise<SystemPromptSection> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/system_prompt_section`;
    const resp = await fetch(this.buildSidecarRequest("GET", path));
    return await this.handleResponse<SystemPromptSection>(resp, path);
  }

  async coreMemoryAppend(
    name: CoreMemoryName,
    content: string,
  ): Promise<void> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/core_memory:append`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, { name, content }),
    );
    await this.handleResponse<{ ok: true }>(resp, path);
  }

  async coreMemoryReplace(
    name: CoreMemoryName,
    oldContent: string,
    newContent: string,
  ): Promise<void> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/core_memory:replace`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, {
        name,
        old_content: oldContent,
        new_content: newContent,
      }),
    );
    await this.handleResponse<{ ok: true }>(resp, path);
  }

  async getCoreMemory(): Promise<CoreMemorySections> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/core_memory`;
    const resp = await fetch(this.buildSidecarRequest("GET", path));
    return await this.handleResponse<CoreMemorySections>(resp, path);
  }

  async archivalInsert(content: string): Promise<ArchivalInsertResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/archival:insert`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, { content }),
    );
    return await this.handleResponse<ArchivalInsertResult>(resp, path);
  }

  async archivalSearch(query: string, page = 0): Promise<SearchResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/archival:search`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, { query, page }),
    );
    const raw = await this.handleResponse<{
      formatted: string;
      results: string[];
      total: number;
      page: number;
      num_pages: number;
    }>(resp, path);
    return {
      formatted: raw.formatted,
      results: raw.results,
      total: raw.total,
      page: raw.page,
      numPages: raw.num_pages,
    };
  }

  async recallSearch(query: string, page = 0): Promise<SearchResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/recall:search`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, { query, page }),
    );
    const raw = await this.handleResponse<{
      formatted: string;
      results: string[];
      total: number;
      page: number;
      num_pages: number;
    }>(resp, path);
    return {
      formatted: raw.formatted,
      results: raw.results,
      total: raw.total,
      page: raw.page,
      numPages: raw.num_pages,
    };
  }

  async recallSearchDate(
    params: RecallSearchDateParams,
  ): Promise<SearchResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/recall:search_date`;
    const body: Record<string, unknown> = {
      start_date: params.startDate,
      end_date: params.endDate,
      page: params.page ?? 0,
    };
    const resp = await fetch(this.buildSidecarRequest("POST", path, body));
    const raw = await this.handleResponse<{
      formatted: string;
      results: string[];
      total: number;
      page: number;
      num_pages: number;
    }>(resp, path);
    return {
      formatted: raw.formatted,
      results: raw.results,
      total: raw.total,
      page: raw.page,
      numPages: raw.num_pages,
    };
  }

  async messagesAppend(
    messages: PyMemGptMessage[],
  ): Promise<MessagesAppendResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}/messages:append`;
    const resp = await fetch(
      this.buildSidecarRequest("POST", path, { messages }),
    );
    return await this.handleResponse<MessagesAppendResult>(resp, path);
  }

  async summarize(
    messages: PyMemGptMessage[],
    totalMessageCount: number,
    tokenBudget?: number,
  ): Promise<SummarizeResult> {
    await this.ensureReady();
    const agentId = this.resolveAgentId();
    const path = `/agents/${encodeURIComponent(agentId)}:summarize`;
    const body: Record<string, unknown> = {
      messages,
      total_message_count: totalMessageCount,
    };
    if (tokenBudget !== undefined) body.token_budget = tokenBudget;
    const resp = await fetch(this.buildSidecarRequest("POST", path, body));
    const raw = await this.handleResponse<{
      cutoff: number;
      summary: string;
      summary_length: number;
      hidden_message_count: number;
      total_message_count: number;
      packaged_message: { role: "user"; content: string };
    }>(resp, path);
    return {
      cutoff: raw.cutoff,
      summary: raw.summary,
      summaryLength: raw.summary_length,
      hiddenMessageCount: raw.hidden_message_count,
      totalMessageCount: raw.total_message_count,
      packagedMessage: raw.packaged_message,
    };
  }

  async healthz(): Promise<HealthzResponse> {
    await this.ensureReady();
    const path = "/healthz";
    const resp = await fetch(this.buildSidecarRequest("GET", path));
    const raw = await this.handleResponse<{
      ok: boolean;
      embedder: string;
      agents_resident: number;
    }>(resp, path);
    return {
      ok: raw.ok,
      embedder: raw.embedder,
      agentsResident: raw.agents_resident,
    };
  }
}
