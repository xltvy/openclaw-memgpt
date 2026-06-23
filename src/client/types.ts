/**
 * Request / response types for the SidecarClient.
 * Mirror the §2 endpoint schemas one-to-one (the "client surface == API surface"
 * property from §3.4).
 *
 * Wire format is snake_case (FastAPI / pydantic); the client translates to
 * camelCase for the TS API. Translation lives in sidecarClient methods, not
 * here — these types describe the TS-facing shape.
 */

// ============================================================================
// Messages — pymemgpt-v0 shape (§3.7 normalisation boundary)
// ============================================================================

/**
 * pymemgpt-v0-shaped message dict — what messagesAppend / summarize ingest.
 *
 * v0 uses `function_call` / `function` role instead of OpenClaw's modern
 * `tool_calls` / `tool` role. The TS-side normalise.ts (§3.7) does this
 * conversion exactly once at the ingest boundary; the sidecar only ever
 * sees v0-shaped dicts.
 *
 * Kept structurally open here — the normaliser owns the precise field set;
 * the client just relays.
 */
export interface PyMemGptMessage {
  role: "system" | "user" | "assistant" | "function";
  content: string | null;
  name?: string | null;
  function_call?: {
    name: string;
    arguments: string;
  } | null;
  [key: string]: unknown;
}

// ============================================================================
// Lifecycle (§2.3)
// ============================================================================

export type EnsureVia = "resident" | "load" | "create";

export interface EnsureAgentResult {
  /** Echoes the namespace from the URL path; sidecar wire field is `agent_id`. */
  agentId: string;
  via: EnsureVia;
}

/** Per-create-branch options passed to :ensure (path provides the namespace). */
export interface EnsureOpts {
  model?: string;
  persona?: string;
  human?: string;
}

export interface SaveResult {
  saved: true;
}

export interface LoadResult {
  agentId: string;
  loadedFrom: "cold_start";
}

// ============================================================================
// Core memory (§2.4)
// ============================================================================

export interface SystemPromptSection {
  /** Full rendered section (static + dynamic). */
  section: string;
  /** Base system prompt; stable across turns, cacheable. */
  static: string;
  /** Memory metadata + persona/human; changes on core-memory edit. */
  dynamic: string;
}

export interface CoreMemorySections {
  persona: string;
  human: string;
}

export type CoreMemoryName = "persona" | "human";

// ============================================================================
// Archival (§2.5)
// ============================================================================

export interface ArchivalInsertResult {
  ok: true;
  /** Number of chunks created (for verbose observability). */
  passages: number;
}

/**
 * Search result shape — used by archival and recall (§2.5 / §2.6).
 *
 * NOTE on `total` semantics (§2.6 asymmetry, NOT a deviation):
 * - Archival: page-local count (`EmbeddingArchivalMemory` returns paged-slice length).
 * - Recall: true grand total of matches.
 * Observability consumers must not conflate them.
 */
export interface SearchResult {
  /** Verbatim LLM-facing string from the underlying Agent.*_search method. */
  formatted: string;
  /** Structured per-result strings — for verbose observability. */
  results: string[];
  total: number;
  page: number;
  numPages: number;
}

// ============================================================================
// Recall (§2.6)
// ============================================================================

/**
 * Parameter names match the gpt_functions schema for
 * recall_memory_search_date / conversation_search_date (S0.2 confirmed):
 * start_date / end_date in YYYY-MM-DD format.
 */
export interface RecallSearchDateParams {
  startDate: string;
  endDate: string;
  page?: number;
}

// ============================================================================
// Conversation log (§2.7)
// ============================================================================

export interface MessagesAppendResult {
  appended: number;
}

// ============================================================================
// Summariser (§2.8)
// ============================================================================

export interface SummarizeResult {
  /** Index into the active buffer where the summarised prefix ends. */
  cutoff: number;
  /** LLM-generated first-person summary text. */
  summary: string;
  /** Number of messages summarised; appears in the packaged preamble. */
  summaryLength: number;
  /** total_message_count - len(messages[cutoff:]); messages hidden from the LLM. */
  hiddenMessageCount: number;
  /** Passed through from the request; running all-time count. */
  totalMessageCount: number;
  /** {"role": "user", "content": "<package_summarize_message JSON>"}. */
  packagedMessage: { role: "user"; content: string };
}

// ============================================================================
// Health (§2.2 — liveness probe, owned by SidecarClient)
// ============================================================================

export interface HealthzResponse {
  ok: boolean;
  /** "ready" once the embedder model has loaded; "not_loaded" otherwise. */
  embedder: "ready" | "not_loaded" | string;
  /** Number of agents currently resident in the sidecar registry. */
  agentsResident: number;
}

// ============================================================================
// Stats (§2.2 — sidecar-tracked counts; 6c.6.2)
// ============================================================================

/**
 * Sidecar-tracked stats — currently just `totalMessageCount`. The 6c.6.2
 * flush-pressure hook reads this for the `total_message_count` it must
 * pass on :summarize requests (SessionEntry doesn't expose an all-time
 * counter — only `compactionCount`).
 *
 * Typed object rather than a bare number so future stats can extend the
 * response without a new endpoint per metric.
 */
export interface StatsResponse {
  /** `len(pm.all_messages)` on the sidecar — the running all-time count. */
  totalMessageCount: number;
}

// ============================================================================
// Management / status (§3.5 — operational, owned by SidecarAdminClient)
// ============================================================================

export interface SidecarStatus {
  /** Health probe result. */
  ok: boolean;
  /** Embedder model id (e.g. "BAAI/bge-small-en-v1.5") and its embedding dim. */
  embedder?: { model: string; dim: number };
  /** Namespaces currently resident in the sidecar. */
  agentsResident?: string[];
  /** Lifecycle metadata (PID, port, last-restart). Populated by §6 lifecycle. */
  process?: {
    pid?: number;
    port?: number;
    lastRestart?: string;
  };
}

// ============================================================================
// Error wire shape (§2.9)
// ============================================================================

export interface SidecarErrorBody {
  error: string;
  message: string;
}
