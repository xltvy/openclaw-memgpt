/**
 * Shared, typed sidecar client for the openclaw-memgpt plugin.
 *
 * Per API_DESIGN.md §3.4: one instance is shared across tool handlers, hooks,
 * and lifecycle. Each method maps 1:1 to a §2 endpoint (the memory-behaviour
 * surface) plus a small management/status category (§3.5) that is operational
 * rather than pymemgpt-anchored.
 *
 * 6c.0 — skeleton only. Constructor, ensureReady() initPromise guard, and
 * every method signature; method bodies throw `not yet implemented` and are
 * wired to real HTTP calls in 6c.1.
 */

import type { PluginConfig } from "../config.ts";
import type {
  ArchivalInsertResult,
  CoreMemoryName,
  CoreMemorySections,
  EnsureAgentResult,
  MessagesAppendResult,
  PyMemGptMessage,
  RecallSearchDateParams,
  SaveResult,
  SearchResult,
  SidecarStatus,
  SummarizeResult,
  SystemPromptSection,
} from "./types.ts";

// ============================================================================
// Contract — what callers depend on (hooks, tools, lifecycle close over this).
// ============================================================================

export interface SidecarClient {
  // — memory-behaviour surface (each method maps to a §2 endpoint) —————————

  /** §2.3 composite: resident → no-op | on-disk → :load | else create. */
  ensureAgent(): Promise<EnsureAgentResult>;
  /** §2.3 :save — flushes archival, recall, all_messages to disk. */
  save(): Promise<SaveResult>;

  /** §2.4 GET /system_prompt_section. */
  getSystemPromptSection(): Promise<SystemPromptSection>;
  /** §2.4 core_memory:append. 409 → pymemgpt error string surfaced verbatim. */
  coreMemoryAppend(name: CoreMemoryName, content: string): Promise<void>;
  /** §2.4 core_memory:replace. 409 → pymemgpt error string surfaced verbatim. */
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

  /** §2.8 :summarize — cutoff + summary + packaged preamble. 422 if buffer too small. */
  summarize(
    messages: PyMemGptMessage[],
    totalMessageCount: number,
    tokenBudget?: number,
  ): Promise<SummarizeResult>;

  // — management / status (operational; §3.5) ————————————————————————————

  /** Health + residency + lifecycle metadata. Not anchored to a pymemgpt method. */
  status(): Promise<SidecarStatus>;
}

// ============================================================================
// Implementation — initPromise guard + per-endpoint method stubs.
// ============================================================================

const NOT_IMPLEMENTED = (op: string): Error =>
  new Error(`SidecarClient.${op}: not yet implemented (wired in 6c.1)`);

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

  // — readiness guard (§3.4) ——————————————————————————————————————————————

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
   * 6c.0 — minimal: resolve baseUrl and store it.
   * 6c.1 will add pollHealth() and ensureAgent() per §3.4.
   */
  protected async doInit(): Promise<void> {
    this.baseUrl = await this.resolveBaseUrl();
  }

  /** Test/diagnostic access — returns the cached baseUrl, or undefined if never inited. */
  protected getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  // — memory-behaviour stubs ——————————————————————————————————————————————

  async ensureAgent(): Promise<EnsureAgentResult> {
    await this.ensureReady();
    void this.config;
    throw NOT_IMPLEMENTED("ensureAgent");
  }

  async save(): Promise<SaveResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("save");
  }

  async getSystemPromptSection(): Promise<SystemPromptSection> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("getSystemPromptSection");
  }

  async coreMemoryAppend(_name: CoreMemoryName, _content: string): Promise<void> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("coreMemoryAppend");
  }

  async coreMemoryReplace(
    _name: CoreMemoryName,
    _oldContent: string,
    _newContent: string,
  ): Promise<void> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("coreMemoryReplace");
  }

  async getCoreMemory(): Promise<CoreMemorySections> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("getCoreMemory");
  }

  async archivalInsert(_content: string): Promise<ArchivalInsertResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("archivalInsert");
  }

  async archivalSearch(_query: string, _page?: number): Promise<SearchResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("archivalSearch");
  }

  async recallSearch(_query: string, _page?: number): Promise<SearchResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("recallSearch");
  }

  async recallSearchDate(_params: RecallSearchDateParams): Promise<SearchResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("recallSearchDate");
  }

  async messagesAppend(
    _messages: PyMemGptMessage[],
  ): Promise<MessagesAppendResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("messagesAppend");
  }

  async summarize(
    _messages: PyMemGptMessage[],
    _totalMessageCount: number,
    _tokenBudget?: number,
  ): Promise<SummarizeResult> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("summarize");
  }

  // — management / status stub ——————————————————————————————————————————

  async status(): Promise<SidecarStatus> {
    await this.ensureReady();
    throw NOT_IMPLEMENTED("status");
  }
}
