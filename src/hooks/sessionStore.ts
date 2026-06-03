/**
 * Session-store access helpers for the flush-pressure hook (§4.4 / 6c.6).
 *
 * The flush handler reads token state off OpenClaw's `SessionEntry`
 * (populated by prior turns' `llm_output.usage`; see API_DESIGN.md §4.7 +
 * the 6c.6.0 SDK read). Token counts aren't on the `before_prompt_build`
 * event itself — they live on `SessionEntry.totalTokens`, gated by
 * `SessionEntry.totalTokensFresh` (a snapshot freshness flag).
 *
 * These helpers exist so the 6c.6.1 hook + the 6c.6.2 summariser glue
 * share one access surface, and so the load-store-and-pluck-entry sequence
 * is mockable in isolation (the hook tests don't have to construct a full
 * OpenClaw runtime shape).
 *
 * The local `SessionEntry` and `RuntimeSessionApi` types are minimal — only
 * the fields the plugin currently reads. OpenClaw's own types are the source
 * of truth; we structurally compatible-match what we need rather than depend
 * on the upstream type names so the local plugin-sdk d.ts stub stays
 * unchanged. Fields are added here as later 6c.6.x sub-tasks need them.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Local shapes — structurally compatible with OpenClaw's SessionEntry +
// PluginRuntimeCore.agent.session (per 6c.6.0 SDK read).
// ============================================================================

/**
 * The subset of `SessionEntry` (from
 * `src/config/sessions/types.d.ts` in the installed SDK) that 6c.6 reads
 * and writes. Optional throughout because OpenClaw's own type marks them
 * optional.
 */
export interface SessionEntry {
  totalTokens?: number;
  totalTokensFresh?: boolean;
  /**
   * OpenClaw's compaction cycle counter — increments after each full context
   * engine compaction run. Used by `hasAlreadyFlushedForCurrentCompaction` to
   * detect whether our MemGPT flush already fired in the current cycle.
   */
  compactionCount?: number;
  /**
   * Set by 6c.6.3 after a successful flush to suppress OpenClaw's own memory
   * flush for the same compaction cycle. Value = `compactionCount` at flush
   * time; `hasAlreadyFlushedForCurrentCompaction` returns true when equal.
   */
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  memoryFlushContextHash?: string;
  /**
   * Cutoff index from the last successful :summarize call. Written alongside
   * memoryFlushAt so ContextEngine.assemble() can slice messages correctly on
   * the next turn (virtual-trim path — see §4.4).
   */
  memoryFlushCutoff?: number;
  /**
   * JSON-serialised packagedMessage from the last successful :summarize call.
   * Written alongside memoryFlushAt; assemble() deserialises and prepends it
   * to messages[memoryFlushCutoff:] to form the virtually-trimmed message set.
   */
  memoryFlushPackagedMessageJson?: string;
}

/**
 * The subset of `api.runtime.agent.session` (from
 * `src/plugins/runtime/types-core.d.ts:54-59`) needed for read + write
 * access. Note: `updateSessionStore` is NOT on `api.runtime.agent.session`
 * (confirmed by SDK read) — only `loadSessionStore` + `saveSessionStore`
 * are exposed at the plugin surface. Use load + mutate + save for writes.
 */
export interface RuntimeSessionApi {
  resolveStorePath(
    store?: string,
    opts?: { agentId?: string; env?: NodeJS.ProcessEnv },
  ): string;
  loadSessionStore(
    storePath: string,
    opts?: unknown,
  ): Record<string, SessionEntry>;
  saveSessionStore(
    storePath: string,
    store: Record<string, SessionEntry>,
    opts?: unknown,
  ): Promise<void>;
}

/** The hook's `ctx` payload — `PluginHookAgentContext` from the SDK. */
export interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  trigger?: string;
  [key: string]: unknown;
}

/**
 * Narrow accessor — drills into `api.runtime?.agent?.session?` so call sites
 * don't repeat the optional-chain and the cast lives in one place.
 *
 * Returns `null` when the runtime isn't available (sub-agent contexts; some
 * test harnesses don't wire `api.runtime`); callers skip the operation.
 */
export function getRuntimeSession(
  api: OpenClawPluginApi,
): RuntimeSessionApi | null {
  const runtime = (
    api as unknown as {
      runtime?: { agent?: { session?: RuntimeSessionApi } };
    }
  ).runtime;
  return runtime?.agent?.session ?? null;
}

// ============================================================================
// Load helper — combines storePath resolution + load + entry pluck.
// ============================================================================

/**
 * Read the `SessionEntry` for this hook invocation, or `null` if the entry
 * doesn't exist yet (first turn) or required ctx fields are missing.
 *
 * The hook layer's standard guard pattern: `const entry = loadSessionEntry(...);
 * if (!entry) return;` — a missing entry means there's no prior turn to read
 * token state from, so there's nothing to gate the flush against.
 */
export function loadSessionEntry(
  api: OpenClawPluginApi,
  ctx: AgentContext,
): SessionEntry | null {
  if (!ctx.sessionKey || !ctx.agentId) return null;
  const session = getRuntimeSession(api);
  if (!session) return null;
  const storePath = session.resolveStorePath(undefined, {
    agentId: ctx.agentId,
  });
  const store = session.loadSessionStore(storePath);
  return store[ctx.sessionKey] ?? null;
}

/**
 * Returns true when our MemGPT flush has already run for the current OpenClaw
 * compaction cycle. Mirrors the SDK's `hasAlreadyFlushedForCurrentCompaction`
 * logic (`auto-reply/reply/memory-flush.d.ts`, confirmed by SDK read):
 *   `memoryFlushCompactionCount === (compactionCount ?? 0)` → already flushed.
 *
 * We set `memoryFlushCompactionCount = compactionCount ?? 0` at flush time,
 * which causes this to return true until OpenClaw's compaction fires and
 * increments `compactionCount`. This prevents re-summarizing the same context
 * on subsequent turns when the transcript hasn't been trimmed yet.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: SessionEntry | null | undefined,
): boolean {
  if (!entry) return false;
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlushCompactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
