/**
 * Observability event stream — the level-gated event emitter (§6.2).
 *
 * Two channels, kept separate (the failure mode §6.2 avoids is conflating them):
 *
 *   1. Operational log — `api.logger`, always on, not gated here.
 *   2. Observability event stream — this module. A structured JSONL sink plus a
 *      live `EventEmitter` for in-process subscribers.
 *
 * **Level semantics (§6.2 — content-stripping, NOT kind-filtering).** The level
 * gates *content*, not *which kinds fire*:
 *
 *   - `off`     → nothing emitted at all (no JSONL, no EventEmitter, no logger).
 *   - `default` → every kind, **metadata only** (`meta`); `content` and
 *                 `triggeringTurn` stripped. The on-by-default operational view.
 *   - `verbose` → every kind **plus content** (queries, results, appended text,
 *                 the summary). The full-detail setting: it records the content
 *                 written and later read.
 *
 * (The 6d.5 brief's earlier wording described kind-filtering; the spec is
 * authoritative and content-stripping is the spec's model, so this implements
 * it. See API_DESIGN.md §6.2.)
 *
 * **Reading A (§6.3 clarification).** The JSONL sink receives every
 * level-qualified event — it is the complete, authoritative event log.
 * `LIFECYCLE_KINDS` additionally echo to `api.logger.info` for operational
 * visibility (a restart "appears in both"); the logger surface is a subset, not
 * a replacement.
 *
 * **Two-phase init.** The sink path lives under the OpenClaw state dir, which is
 * only on the service `ctx` passed to `start()` — not on `api` at `register()`.
 * So the emitter is constructed with its level at `register()` and its sink is
 * `activate(stateDir)`d when the lifecycle service starts (LifecycleManager owns
 * the call, covering both the gateway and `--local` lazy-init paths). Before
 * activation the EventEmitter + logger surfaces still fire; only the JSONL write
 * is skipped.
 */

import { EventEmitter } from "node:events";
import { appendFile as fsAppendFile, mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";

import type { ObservabilityLevel } from "../config.ts";

// ============================================================================
// Event schema (§6.2)
// ============================================================================

/**
 * The closed set of event kinds the plugin emits. Reconciled to the actual
 * call sites (§6.2's original union predated the implementation):
 *
 *   - search kinds are `conversation_search[_date]` (the LLM-facing tool names),
 *     not the spec's earlier `recall_search[_date]`;
 *   - the summariser splits into `summarisation_succeeded` (page-out computed) +
 *     `flush_applied` (packaged summary mirrored to recall), not a single
 *     `summariser_fired`, plus `summarisation_skipped` for the §2.8 buffer-too-
 *     small no-op;
 *   - `agent_ensured` / `messages_mirrored` / `agent_saved` are the per-turn
 *     capability-layer operations; `emit_failed` is the structured error event.
 *
 * Process-lifecycle kinds (`sidecar_*`, `health_failed`) are in LIFECYCLE_KINDS
 * and additionally echo to the operational log.
 */
export type MemoryEventKind =
  // agent-driven memory tools (§2.4–2.6)
  | "core_memory_append"
  | "core_memory_replace"
  | "archival_insert"
  | "archival_search"
  | "conversation_search"
  | "conversation_search_date"
  | "send_message"
  // capability layer (§4.4 summariser / §4.5 mirror+save / §4.2 ensure)
  | "agent_ensured"
  | "messages_mirrored"
  | "agent_saved"
  | "summarisation_succeeded"
  | "summarisation_skipped"
  | "flush_applied"
  | "emit_failed"
  // V2.1 send_message discipline (finalizeGuard bouncer / payloadGuard suspenders)
  | "finalize_revision_requested"
  | "monologue_suppressed"
  // process lifecycle (§6.1)
  | "sidecar_spawned"
  | "sidecar_restarted"
  | "sidecar_exited"
  | "health_failed";

/**
 * Content payload — present only at `verbose`, stripped at `default`. Carries
 * the read/write detail (§6.2): which content was written and which surfaced in
 * a read.
 */
export interface MemoryEventContent {
  query?: string;
  results?: string[];
  text?: string;
  summary?: string;
  summarised?: unknown[];
}

/**
 * The emitted event. `meta` is operation-shape (count, page, overflow flag,
 * cutoff) and present at `default`+; `content` and `triggeringTurn` are verbose-
 * only provenance. Kept primitive-valued in `meta` (§6.2) so the JSONL stays a
 * flat, machine-aggregable record.
 */
export interface MemoryEvent {
  kind: MemoryEventKind;
  namespace: string;
  /** ISO-8601, stamped at the call site so concurrent events keep their order. */
  ts?: string;
  /** Provenance link to the turn that caused it (verbose; where OpenClaw exposes it). */
  triggeringTurn?: string;
  meta?: Record<string, number | string | boolean>;
  content?: MemoryEventContent;
}

/**
 * Process-lifecycle kinds that also echo to `api.logger.info` (§6.2 Reading A).
 * A restart is a cold start that changes the residency condition (§6.1), so it
 * must be visible operationally as well as in the research stream. The per-turn
 * memory kinds are deliberately *not* here — routing them to the operational log
 * would drown it, and `emit_failed` is already logged at each call site.
 */
export const LIFECYCLE_KINDS: ReadonlySet<MemoryEventKind> = new Set([
  "sidecar_spawned",
  "sidecar_restarted",
  "sidecar_exited",
  "health_failed",
]);

/** Channel name the EventEmitter fires every qualified event on (in addition to its `kind`). */
export const MEMORY_EVENT_CHANNEL = "memory_event";

/** Sink filename under the state dir. */
export const SINK_FILENAME = "memgpt-observability.jsonl";

// ============================================================================
// Public live-subscription bus
// ============================================================================

/**
 * Module-level event bus for in-process subscribers. Re-exported from the
 * plugin root so consumers attach listeners without holding the plugin
 * instance:
 *
 * ```ts
 * import { memoryEvents, MEMORY_EVENT_CHANNEL } from "openclaw-memgpt";
 * memoryEvents.on(MEMORY_EVENT_CHANNEL, (e) => { ... });   // all events
 * memoryEvents.on("archival_search", (e) => { ... });       // one kind
 * ```
 *
 * Events are already level-qualified (content stripped at `default`, nothing at
 * `off`) before they reach this bus, so a subscriber sees exactly what the JSONL
 * sink records. Single bus across plugin instances (V1 is single-instance; the
 * `namespace` field disambiguates if that changes).
 */
export const memoryEvents = new EventEmitter();
// Research/observability consumers may attach many listeners; lift the warn cap.
memoryEvents.setMaxListeners(0);

// ============================================================================
// Minimal sink interface consumed by LifecycleManager (avoids a class coupling)
// ============================================================================

export interface EventSink {
  emit(event: MemoryEvent): void;
}

/**
 * The richer surface `LifecycleManager` needs: it emits process-lifecycle
 * events *and* owns the `activate(stateDir)` call (the state dir is resolved
 * inside `start`, covering both the gateway and `--local` lazy-init paths).
 */
export interface ActivatableEventSink extends EventSink {
  activate(stateDir: string): Promise<void>;
}

// ============================================================================
// Emitter
// ============================================================================

type AppendFn = (file: string, data: string) => Promise<void>;
type MkdirFn = (dir: string) => Promise<void>;

export interface ObservabilityEmitterOptions {
  /** Live bus to forward qualified events to. Defaults to the module `memoryEvents`. */
  bus?: EventEmitter;
  /** DI seam for the JSONL append (tests capture lines without disk). */
  appendFn?: AppendFn;
  /** DI seam for ensuring the sink dir exists. */
  mkdirFn?: MkdirFn;
  /** Explicit sink path, bypassing `activate()`'s state-dir computation (tests). */
  sinkPath?: string;
}

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

/**
 * Level-gated emitter. One per plugin instance; wired into `ToolDeps.emit` and
 * passed to `LifecycleManager` so lifecycle events share the same sink.
 */
export class ObservabilityEmitter implements EventSink {
  readonly events: EventEmitter;
  private readonly level: ObservabilityLevel;
  private readonly logger: Logger;
  private readonly appendFn: AppendFn;
  private readonly mkdirFn: MkdirFn;
  private sinkPath?: string;
  /** Serialises JSONL appends so concurrent emits don't interleave lines. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    level: ObservabilityLevel,
    logger: Logger,
    options: ObservabilityEmitterOptions = {},
  ) {
    this.level = level;
    this.logger = logger;
    this.events = options.bus ?? memoryEvents;
    this.appendFn =
      options.appendFn ?? ((file, data) => fsAppendFile(file, data, "utf8"));
    this.mkdirFn =
      options.mkdirFn ??
      (async (dir) => {
        await fsMkdir(dir, { recursive: true });
      });
    this.sinkPath = options.sinkPath;
  }

  /**
   * Phase-2 init: point the JSONL sink at `<stateDir>/memgpt-observability.jsonl`.
   * Idempotent and a no-op at `off`. Called by `LifecycleManager.start` once the
   * state dir is known. If a `sinkPath` was given at construction it wins (test
   * override) and this only ensures the directory exists.
   */
  async activate(stateDir: string): Promise<void> {
    if (this.level === "off") return;
    if (this.sinkPath === undefined) {
      this.sinkPath = path.join(stateDir, SINK_FILENAME);
    }
    try {
      await this.mkdirFn(path.dirname(this.sinkPath));
      this.logger.info(
        `openclaw-memgpt: observability sink active (level=${this.level}) → ${this.sinkPath}`,
      );
    } catch (err) {
      this.logger.warn(
        `openclaw-memgpt: observability sink dir create failed (${this.sinkPath}); JSONL writes may fail: ${String(err)}`,
      );
    }
  }

  /**
   * Emit one event, gated by level. Synchronous return (`ToolDeps.emit` is sync);
   * the JSONL write is fire-and-forget on a serialised chain.
   */
  emit(event: MemoryEvent): void {
    if (this.level === "off") return;
    const qualified =
      this.level === "default" ? stripContent(event) : event;

    // Live subscribers: all-events channel + per-kind channel.
    this.events.emit(MEMORY_EVENT_CHANNEL, qualified);
    this.events.emit(qualified.kind, qualified);

    // Authoritative event log (Reading A — complete JSONL).
    this.appendJsonl(qualified);

    // Operational echo for process-lifecycle kinds (Reading A — additive subset).
    if (LIFECYCLE_KINDS.has(qualified.kind)) {
      this.logger.info(`openclaw-memgpt: ${qualified.kind}`, qualified.meta);
    }
  }

  private appendJsonl(event: MemoryEvent): void {
    if (this.sinkPath === undefined) return; // pre-activation (e.g. before start)
    const line = `${JSON.stringify(event)}\n`;
    const sinkPath = this.sinkPath;
    this.writeChain = this.writeChain
      .then(() => this.appendFn(sinkPath, line))
      .catch((err) => {
        this.logger.warn(
          `openclaw-memgpt: observability sink write failed: ${String(err)}`,
        );
      });
  }

  /** Test/teardown helper — await any in-flight JSONL writes. */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

/**
 * Drop the verbose-only fields, leaving metadata. Returns the input unchanged
 * when there's nothing to strip (no allocation on the common no-content path).
 */
export function stripContent(event: MemoryEvent): MemoryEvent {
  if (event.content === undefined && event.triggeringTurn === undefined) {
    return event;
  }
  const { content: _content, triggeringTurn: _triggeringTurn, ...rest } = event;
  return rest;
}
