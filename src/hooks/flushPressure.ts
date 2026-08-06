/**
 * §4.4 — flush-pressure check, two-trigger form (compaction-anchored):
 *
 *   `before_compaction` (PRIMARY): fires at the moment OpenClaw is about to
 *   discard conversation — the last point the full buffer exists — which is
 *   precisely when MemGPT should flush it into recall storage. No threshold:
 *   the host has already decided the context is over budget, so racing it
 *   with a tuned ratio is pointless (with default settings the host compacts
 *   at budget − reserveTokens, which undercuts 0.75 × budget whenever
 *   budget < 4 × reserve — the 1.3.0 ratio path could never win). The host
 *   awaits this hook, so the `:summarize` round-trip completes before the
 *   buffer is discarded.
 *
 *   `agent_end` (SECONDARY, end of turn N−1): the 1.3.0 threshold path,
 *   kept for sessions that end before ever compacting — without it short
 *   sessions never flush at all. Estimates the buffer's token load locally
 *   (per-message `estimateTokens` summed over `event.messages`), checks
 *   `budget × flushRatio` (absolute 6000 fallback), and flushes on trip.
 *
 *   `ContextEngine.assemble()` (start of turn N): reads the flush metadata
 *   and returns `[packagedMessage, ...messages.slice(cutoff)]`. After a
 *   before_compaction flush the host's own compaction increments
 *   `compactionCount`, which staleness-invalidates the metadata
 *   (`hasAlreadyFlushedForCurrentCompaction` → false) so assemble()
 *   passes through — the host already trimmed the buffer; the virtual trim
 *   only applies if the host compaction failed to land.
 *
 * **Event shapes on `before_compaction`** (read off the installed dist,
 * 1.3.1): the embedded compaction path (`model-context-tokens-*.js` via
 * `compact-*.js`) passes `{messageCount, tokenCount}` — tokenCount locally
 * computed by the host with the same `estimateTokens`, NO `messages`; the
 * harness path (`agent-harness-runtime-*.js`) passes
 * `{messageCount, messages?, sessionFile}` — NO tokenCount. Both are
 * handled: messages come from the event when present, else from the buffer
 * snapshot captured at the previous `agent_end`; tokens come from
 * `event.tokenCount` when present, else the local estimator. When neither
 * message source exists (compaction before the first agent_end of the
 * process), the flush skips with an explicit degraded-mode log — never
 * silently.
 *
 * **Budget source on `agent_end`** (the 1.3.1 Defect-2 fix): OpenClaw does
 * NOT populate `ctx.contextTokenBudget` on agent_end — the ctx built at the
 * agent-end dispatch site (`selection-*.js`, runAgentEndSideEffects) carries
 * only ids/trigger/config. The ratio path therefore reads the budget from
 * `SessionEntry.contextBudgetStatus.contextTokenBudget` (OpenClaw's
 * persisted pre-prompt estimate) when the ctx lacks one, and logs which
 * source supplied it. When both are absent the absolute fallback applies —
 * logged explicitly as degraded, never silently.
 *
 * **Why local estimation, not provider `usage`** (the 6d fix — do not
 * regress): the pre-1.3.0 two-hook form captured `llm_output.event.usage`
 * into a cross-hook Map; against an endpoint that under-reports input tokens
 * (observed: 3 tokens for a ~3,900-token prompt) the threshold was
 * unreachable and `:summarize` never fired — silently. Token load is a
 * decision this plugin makes locally from the buffer it already holds.
 * NB: per-message `estimateTokens`, never `estimateContextTokens` — the
 * latter re-anchors on provider-reported usage and would silently reimport
 * the exact bug this design removed.
 *
 * **Double-fire guard:** a successful before_compaction flush marks the
 * session; the next agent_end for that session consumes the marker and
 * skips its evaluation (the store-side `hasAlreadyFlushedForCurrentCompaction`
 * check alone can't cover this — the host compaction increments
 * `compactionCount` between the two hooks, un-matching the metadata).
 *
 * **Fidelity at algorithm/data-shape level** (byte-identical to CLI):
 *   cutoff algorithm (F1 sidecar-side), summary text, packagedMessage
 *   template, post-flush buffer shape, recall searchability. See §4.4.
 *
 * **Observability** (the anti-silent-death rule): EVERY evaluation logs its
 * numbers — trigger, tokens + their source, budget + its source, threshold,
 * outcome — at debug level, negative outcomes included. The pre-1.3.0 silent
 * early return is precisely why the dead trigger survived 20 long turns
 * undetected.
 *
 * Error policy on `:summarize` (§2.8):
 *   - `BufferTooSmallError` (422): info-level no-op. False-alarm crossing on
 *     a small token-heavy buffer is recoverable.
 *   - other errors: log + emit `emit_failed`, do NOT re-throw. Self-heals on
 *     the next trigger firing.
 *
 * Guards (both triggers, reuse triggers.ts from 6c.5): unconfigured plugin,
 * dead sidecar, non-interactive trigger and subagent session all skip.
 * `agent_end` additionally skips `event.success === false`.
 *
 * Estimator loading: `openclaw/plugin-sdk/agent-core` is a host-provided
 * runtime module, so the import MUST stay dynamic (same rule as the wizard's
 * SDK subpath imports — `node --test` has no `openclaw` to resolve). Under
 * test, or if the host ever fails to expose the subpath, a local
 * visible-chars/4 fallback keeps the trigger alive (slight overestimate —
 * errs toward flushing early, never toward the silent-dead failure mode).
 */

import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { BufferTooSmallError } from "../client/errors.ts";
import { normaliseMessages, type OpenClawMessage } from "../normalise.ts";
import type { ToolDeps, ToolLogger } from "../tools/deps.ts";
import {
  getRuntimeSession,
  hasAlreadyFlushedForCurrentCompaction,
  loadSessionEntry,
  type AgentContext,
} from "./sessionStore.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/**
 * Absolute fallback threshold, used only when no `contextTokenBudget` is
 * available from ctx or the session entry. MemGPT's flush threshold per
 * `memgpt/constants.py:22`:
 *   MESSAGE_SUMMARY_WARNING_TOKENS = int(0.75 * LLM_MAX_TOKENS)   # LLM_MAX_TOKENS = 8000
 * Verbatim derived value; literal rather than imported so it stays MemGPT-
 * faithful even if a future fork tweak rebases LLM_MAX_TOKENS.
 */
export const MESSAGE_SUMMARY_WARNING_TOKENS = 6000;

/**
 * Default flush ratio — MemGPT's own 0.75 warning fraction, applied to the
 * session's real context budget on the agent_end fallback trigger.
 * Overridable via config `flushRatio`.
 */
export const DEFAULT_FLUSH_RATIO = 0.75;

// ============================================================================
// Token estimation — local, provider-independent
// ============================================================================

export type TokenEstimator = (message: unknown) => number;

/**
 * Cached SDK estimator. `undefined` = import not yet attempted;
 * `null` = import failed (fall back permanently, warn once).
 */
let sdkEstimator: TokenEstimator | null | undefined;

async function resolveEstimator(logger: ToolLogger): Promise<TokenEstimator> {
  if (sdkEstimator === undefined) {
    try {
      const mod = await import("openclaw/plugin-sdk/agent-core");
      sdkEstimator = mod.estimateTokens;
    } catch (err) {
      sdkEstimator = null;
      logger.warn(
        `openclaw-memgpt: openclaw/plugin-sdk/agent-core unavailable (${stringifyError(err)}); using local chars/4 token estimate for flush pressure`,
      );
    }
  }
  return sdkEstimator ?? fallbackEstimateTokens;
}

/**
 * @internal Override the estimator between tests. Call with no argument to
 * reset to "not yet attempted" (the next evaluation re-attempts the dynamic
 * import — which under `node --test` lands on the fallback).
 */
export function _setTokenEstimatorForTests(fn?: TokenEstimator): void {
  sdkEstimator = fn;
}

/**
 * Local stand-in for the SDK's `estimateTokens` chars/4 heuristic: sums every
 * string leaf in the message (content strings, block text, tool-call
 * arguments) and divides by 4. Slightly overestimates relative to the SDK
 * (role/name strings are counted too) — the safe direction: flushing a little
 * early is recoverable, a dead trigger is not.
 */
export function fallbackEstimateTokens(message: unknown): number {
  let chars = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      chars += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(message);
  return Math.ceil(chars / 4);
}

// ============================================================================
// Cross-trigger session state (module-level, per-process)
// ============================================================================

/**
 * Last full buffer seen at agent_end, per sessionKey. Feeds the
 * before_compaction trigger on the embedded compaction path, whose event
 * carries counts only — no `messages`. At most one turn stale (the same
 * end-of-turn-N−1 granularity as the agent_end trigger itself, §4.4 declared
 * deviation). Bounded FIFO so a long-lived gateway doesn't accumulate
 * buffers for every session it ever saw.
 */
const bufferSnapshots = new Map<string, unknown[]>();
const BUFFER_SNAPSHOT_MAX_SESSIONS = 64;

/**
 * Sessions whose current turn already flushed via before_compaction. The
 * next agent_end for the session consumes the marker and skips — acceptance
 * criterion 5 (no double-flush when both triggers fire in the same turn).
 */
const flushedViaCompaction = new Set<string>();

/** One-time agent_end ctx dump gate (Defect-2 empirical record). */
let agentEndCtxLogged = false;

/** @internal Reset all cross-trigger module state between tests. */
export function _resetFlushStateForTests(): void {
  bufferSnapshots.clear();
  flushedViaCompaction.clear();
  agentEndCtxLogged = false;
}

function captureBufferSnapshot(
  sessionKey: string | undefined,
  messages: unknown[],
): void {
  if (!sessionKey || !messages.length) return;
  bufferSnapshots.delete(sessionKey); // re-insert to refresh FIFO position
  bufferSnapshots.set(sessionKey, messages);
  if (bufferSnapshots.size > BUFFER_SNAPSHOT_MAX_SESSIONS) {
    const oldest = bufferSnapshots.keys().next().value;
    if (oldest !== undefined) bufferSnapshots.delete(oldest);
  }
}

// ============================================================================
// Hook events
// ============================================================================

interface AgentEndEvent {
  messages?: unknown[];
  success?: boolean;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

interface BeforeCompactionEvent {
  messageCount?: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
  [key: string]: unknown;
}

type FlushTrigger = "before_compaction" | "agent_end";

export function registerFlushPressureHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
  opts?: { flushRatio?: number },
): void {
  const flushRatio = opts?.flushRatio ?? DEFAULT_FLUSH_RATIO;

  /** Shared entry guards — identical for both triggers. */
  const guardsPass = (ctx: AgentContext): boolean => {
    // §6d.6 config gate — skip flush (silently) when unconfigured.
    if (deps.lifecycle?.isConfigured === false) return false;
    // §6.1 lifecycle — skip silently if the sidecar died (no point
    // attempting :summarize against an unreachable endpoint).
    if (deps.lifecycle?.isDead) return false;
    // Standard guards — same precedent as the mirror hook. NB: the embedded
    // before_compaction ctx carries no `trigger` field; the sessionKey
    // pattern fallback inside isNonInteractiveTrigger still applies.
    if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return false;
    if (isSubagentSession(ctx.sessionKey)) return false;
    return true;
  };

  // ── PRIMARY: before_compaction — flush before the host discards the buffer
  api.on(
    "before_compaction",
    async (eventRaw: unknown, ctxRaw: unknown) => {
      const ctx = (ctxRaw ?? {}) as AgentContext;
      const event = (eventRaw ?? {}) as BeforeCompactionEvent;

      if (!guardsPass(ctx)) return;

      const entry = loadSessionEntry(api, ctx);

      // Already flushed for the current OpenClaw compaction cycle (e.g. the
      // agent_end fallback tripped last turn and compaction fires now) —
      // re-summarising near-identical context would diverge from MemGPT's
      // one-flush-per-overflow behaviour.
      if (hasAlreadyFlushedForCurrentCompaction(entry)) {
        deps.logger.debug(
          `openclaw-memgpt: flush evaluation: trigger=before_compaction outcome=skipped reason=already-flushed-for-cycle (sessionKey=${ctx.sessionKey})`,
        );
        return;
      }

      // A session that reaches compaction always has a store entry; a missing
      // one means we can't write flush metadata — skip, visibly.
      if (!entry) {
        deps.logger.debug(
          `openclaw-memgpt: flush evaluation: trigger=before_compaction outcome=skipped reason=no-session-entry (sessionKey=${ctx.sessionKey})`,
        );
        return;
      }

      // Message source: the harness path puts `messages` on the event; the
      // embedded path sends counts only — fall back to the buffer snapshot
      // captured at the previous agent_end.
      let messages: unknown[];
      let messageSource: "event" | "agent_end-snapshot";
      const snapshot = ctx.sessionKey
        ? bufferSnapshots.get(ctx.sessionKey)
        : undefined;
      if (Array.isArray(event.messages) && event.messages.length > 0) {
        messages = event.messages;
        messageSource = "event";
      } else if (snapshot && snapshot.length > 0) {
        messages = snapshot;
        messageSource = "agent_end-snapshot";
      } else {
        // Degraded mode: compaction is about to discard a buffer we never
        // saw. Do not pretend this is fine — log it loudly.
        deps.logger.warn(
          `openclaw-memgpt: flush evaluation: trigger=before_compaction outcome=skipped(DEGRADED) reason=no-message-source — event carried no messages and no agent_end snapshot exists yet; the host is compacting a buffer MemGPT cannot flush (sessionKey=${ctx.sessionKey}, event.messageCount=${event.messageCount ?? "unset"})`,
        );
        return;
      }

      // Token count is observability-only here — there is no threshold to
      // beat: the host has already decided to compact. Prefer the host's own
      // locally-computed event.tokenCount; else estimate.
      let tokens: number;
      let tokenSource: "event.tokenCount" | "local-estimate";
      if (typeof event.tokenCount === "number" && event.tokenCount >= 0) {
        tokens = event.tokenCount;
        tokenSource = "event.tokenCount";
      } else {
        const estimate = await resolveEstimator(deps.logger);
        tokens = messages.reduce<number>((sum, m) => sum + estimate(m), 0);
        tokenSource = "local-estimate";
      }

      deps.logger.debug(
        `openclaw-memgpt: flush evaluation: trigger=before_compaction estTokens=${tokens} tokenSource=${tokenSource} messageSource=${messageSource} messageCount=${messages.length} outcome=FLUSH (no threshold — host compaction imminent) (sessionKey=${ctx.sessionKey})`,
      );
      deps.logger.info(
        `openclaw-memgpt: flush triggered by host compaction (sessionKey=${ctx.sessionKey}, estTokens=${tokens}, messageSource=${messageSource})`,
      );

      const flushed = await executeFlush({
        api,
        deps,
        ctx,
        messages,
        tokens,
        trigger: "before_compaction",
      });
      if (flushed && ctx.sessionKey) {
        flushedViaCompaction.add(ctx.sessionKey);
      }
    },
  );

  // ── SECONDARY: agent_end — threshold fallback for sessions that never
  //    reach compaction (without it, short sessions never flush at all).
  api.on(
    "agent_end",
    async (eventRaw: unknown, ctxRaw: unknown) => {
      const ctx = (ctxRaw ?? {}) as AgentContext & {
        contextTokenBudget?: number;
      };
      const event = (eventRaw ?? {}) as AgentEndEvent;

      if (!guardsPass(ctx)) return;

      // Feed the before_compaction trigger's snapshot on every interactive
      // turn — including failed ones; the buffer content is real either way.
      const messages = event.messages ?? [];
      captureBufferSnapshot(ctx.sessionKey, messages);

      // Double-fire guard (acceptance 5): before_compaction already flushed
      // during this turn. Consume the marker so the NEXT turn evaluates
      // normally. The store-side cycle check can't cover this — the host
      // compaction incremented compactionCount between the two hooks.
      if (ctx.sessionKey && flushedViaCompaction.has(ctx.sessionKey)) {
        flushedViaCompaction.delete(ctx.sessionKey);
        deps.logger.debug(
          `openclaw-memgpt: flush evaluation: trigger=agent_end outcome=skipped reason=before_compaction-already-flushed-this-turn (sessionKey=${ctx.sessionKey})`,
        );
        return;
      }

      // Failed turn: skip flush.
      if (!event.success) return;

      // ── Local token estimate (never provider usage) ─────────────────────
      const estimate = await resolveEstimator(deps.logger);
      const tokens = messages.reduce<number>(
        (sum, m) => sum + estimate(m),
        0,
      );

      // Loaded before the threshold because it is also the budget source.
      const entry = loadSessionEntry(api, ctx);

      // Defect-2 empirical record: log the ctx once so the budget-presence
      // question stays answerable from any debug log, not just a dist read.
      if (!agentEndCtxLogged) {
        agentEndCtxLogged = true;
        deps.logger.debug(
          `openclaw-memgpt: agent_end ctx survey (once): keys=[${Object.keys(ctx).join(",")}] contextTokenBudget=${ctx.contextTokenBudget ?? "unset"} entry.contextBudgetStatus.contextTokenBudget=${entry?.contextBudgetStatus?.contextTokenBudget ?? "unset"}`,
        );
      }

      // ── Budget source resolution (Defect 2) ─────────────────────────────
      let budget: number | undefined;
      let budgetSource: "ctx" | "sessionEntry" | "absent";
      if (
        typeof ctx.contextTokenBudget === "number" &&
        ctx.contextTokenBudget > 0
      ) {
        budget = ctx.contextTokenBudget;
        budgetSource = "ctx";
      } else if (
        typeof entry?.contextBudgetStatus?.contextTokenBudget === "number" &&
        entry.contextBudgetStatus.contextTokenBudget > 0
      ) {
        budget = entry.contextBudgetStatus.contextTokenBudget;
        budgetSource = "sessionEntry";
      } else {
        budget = undefined;
        budgetSource = "absent";
      }

      const threshold =
        budget !== undefined
          ? Math.floor(budget * flushRatio)
          : MESSAGE_SUMMARY_WARNING_TOKENS;
      const tripped = tokens >= threshold;

      // Every evaluation is observable, negative outcomes included — a
      // silent early return here is how the provider-usage defect survived
      // undetected. A missing budget is a DEGRADED mode, stated as such.
      deps.logger.debug(
        `openclaw-memgpt: flush evaluation: trigger=agent_end estTokens=${tokens} budget=${budget ?? "unset"} budgetSource=${budgetSource}${budgetSource === "absent" ? " (DEGRADED: no contextTokenBudget on ctx or session entry; absolute fallback threshold in effect)" : ""} ratio=${flushRatio} threshold=${threshold} ${tripped ? "TRIPPED" : "did not trip"} (sessionKey=${ctx.sessionKey})`,
      );
      if (!tripped) return;

      // Missing entry (first turn) — nothing to gate against or write to.
      if (!entry) return;

      // Already flushed for the current OpenClaw compaction cycle — skip to
      // avoid re-summarising the same context.
      if (hasAlreadyFlushedForCurrentCompaction(entry)) {
        deps.logger.debug(
          `openclaw-memgpt: flush already done for current compaction cycle, skipping (sessionKey=${ctx.sessionKey})`,
        );
        return;
      }

      // Threshold tripped + guarded. Log + proceed to :summarize.
      deps.logger.info(
        `openclaw-memgpt: flush threshold tripped (sessionKey=${ctx.sessionKey}, trigger=agent_end, totalTokens=${tokens} >= ${threshold}${budget !== undefined ? ` = ${budget} * ${flushRatio} [budgetSource=${budgetSource}]` : " [absolute fallback]"})`,
      );

      if (!messages.length) {
        deps.logger.debug(
          `openclaw-memgpt: summarise skipped — event.messages empty for sessionKey=${ctx.sessionKey}`,
        );
        return;
      }

      await executeFlush({
        api,
        deps,
        ctx,
        messages,
        tokens,
        trigger: "agent_end",
      });
    },
  );
}

// ============================================================================
// Shared flush execution — normalise → getStats → :summarize → metadata →
// recall mirror. Identical for both triggers; log/emit payloads carry which
// trigger fired.
// ============================================================================

async function executeFlush(params: {
  api: OpenClawPluginApi;
  deps: ToolDeps;
  ctx: AgentContext;
  messages: unknown[];
  tokens: number;
  trigger: FlushTrigger;
}): Promise<boolean> {
  const { api, deps, ctx, messages, tokens, trigger } = params;

  // §3.7 normalisation boundary — same as the 6c.5 mirror hook.
  const v0Messages = normaliseMessages(messages as OpenClawMessage[]);

  // total_message_count source: GET /agents/{id}/stats. Sidecar is the
  // source of truth; round-trip only fires when the trigger has already fired.
  let totalMessageCount: number;
  try {
    const stats = await deps.client.getStats();
    totalMessageCount = stats.totalMessageCount;
  } catch (err) {
    deps.logger.error(
      `openclaw-memgpt: getStats failed before summarise (trigger=${trigger}): ${stringifyError(err)}`,
    );
    deps.emit({
      kind: "emit_failed",
      namespace: deps.namespace,
      ts: new Date().toISOString(),
      meta: {
        operation: "getStats",
        trigger,
        reason: stringifyError(err),
      },
    });
    return false; // recoverable on the next trigger firing
  }

  try {
    const result = await deps.client.summarize(v0Messages, totalMessageCount);
    deps.logger.info(
      `openclaw-memgpt: summarisation succeeded (sessionKey=${ctx.sessionKey}, trigger=${trigger}, cutoff=${result.cutoff}, summaryLength=${result.summaryLength})`,
    );
    deps.emit({
      kind: "summarisation_succeeded",
      namespace: deps.namespace,
      ts: new Date().toISOString(),
      meta: {
        cutoff: result.cutoff,
        totalTokens: tokens,
        trigger,
        summaryLength: result.summaryLength,
        hiddenMessageCount: result.hiddenMessageCount,
      },
      content: {
        summary: result.summary,
        summarised: v0Messages.slice(0, result.cutoff),
      },
    });

    // ── Flush metadata write (§4.4 — 6c.6.3) ────────────────────────
    //
    //   memoryFlushAt                — ms timestamp of this flush
    //   memoryFlushCompactionCount   — prevents re-flush in same cycle
    //   memoryFlushContextHash       — SHA-256(messages)[0:16] for dedup
    //   memoryFlushCutoff            — cutoff index for assemble() slice
    //   memoryFlushPackagedMessageJson — packagedMessage JSON for assemble()
    //     to prepend; together these two let ContextEngine.assemble()
    //     return the virtually-trimmed message set on the next turn.
    //
    //   On the before_compaction trigger the host compaction that follows
    //   increments compactionCount, staleness-invalidating this metadata —
    //   assemble() then passes through (the host already trimmed). It stays
    //   live only if the host compaction fails, where the virtual trim is
    //   the graceful fallback.
    const contextHash = computeContextHash(v0Messages);

    const session = getRuntimeSession(api);
    if (session && ctx.agentId && ctx.sessionKey) {
      try {
        const storePath = session.resolveStorePath(undefined, {
          agentId: ctx.agentId,
        });
        const store = session.loadSessionStore(storePath);
        const currentEntry = store[ctx.sessionKey];
        if (currentEntry) {
          await session.saveSessionStore(storePath, {
            ...store,
            [ctx.sessionKey]: {
              ...currentEntry,
              memoryFlushAt: Date.now(),
              memoryFlushCompactionCount: currentEntry.compactionCount ?? 0,
              memoryFlushContextHash: contextHash,
              memoryFlushCutoff: result.cutoff,
              memoryFlushPackagedMessageJson: JSON.stringify(
                result.packagedMessage,
              ),
            },
          });
        } else {
          deps.logger.debug(
            `openclaw-memgpt: session entry vanished before flush metadata write; skipping (sessionKey=${ctx.sessionKey})`,
          );
        }
      } catch (storeErr) {
        deps.logger.warn(
          `openclaw-memgpt: flush metadata write failed for sessionKey=${ctx.sessionKey}: ${stringifyError(storeErr)}`,
        );
        deps.emit({
          kind: "emit_failed",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: {
            operation: "sessionStore",
            trigger,
            reason: stringifyError(storeErr),
          },
        });
      }
    }

    // Mirror the packaged summary to recall so it remains searchable.
    // packagedMessage is already in PyMemGPT v0 format; no normalisation needed.
    try {
      await deps.client.messagesAppend([result.packagedMessage]);
      deps.emit({
        kind: "flush_applied",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: {
          cutoff: result.cutoff,
          trigger,
          summaryLength: result.summaryLength,
          hiddenMessageCount: result.hiddenMessageCount,
        },
        content: { summary: result.packagedMessage.content },
      });
    } catch (mirrorErr) {
      // Mirror failure: session metadata is already written. The next
      // agent_end hook mirrors all turn messages anyway.
      deps.logger.warn(
        `openclaw-memgpt: flush recall mirror failed; next agent_end will retry (sessionKey=${ctx.sessionKey}): ${stringifyError(mirrorErr)}`,
      );
      deps.emit({
        kind: "emit_failed",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: {
          operation: "messagesAppend",
          trigger,
          reason: stringifyError(mirrorErr),
        },
      });
    }
    // The summarise itself landed — metadata/mirror hiccups don't un-flush it.
    return true;
  } catch (err) {
    if (err instanceof BufferTooSmallError) {
      // §2.8: a small token-heavy buffer is recoverable — false-alarm
      // trigger firing. Treat as no-op rather than failing the turn.
      deps.logger.info(
        `openclaw-memgpt: summarisation skipped (buffer too small) for sessionKey=${ctx.sessionKey}, trigger=${trigger}, totalTokens=${tokens}`,
      );
      deps.emit({
        kind: "summarisation_skipped",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: {
          reason: "buffer_too_small",
          trigger,
          totalTokens: tokens,
        },
      });
      return false;
    }
    // Other errors: self-heals on the next trigger firing.
    deps.logger.error(
      `openclaw-memgpt: summarise failed for sessionKey=${ctx.sessionKey} (trigger=${trigger}): ${stringifyError(err)}`,
    );
    deps.emit({
      kind: "emit_failed",
      namespace: deps.namespace,
      ts: new Date().toISOString(),
      meta: {
        operation: "summarize",
        trigger,
        reason: stringifyError(err),
      },
    });
    return false;
  }
}

/** Normalise an unknown error to a string for log + emit payloads. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * SHA-256 of the full message array (JSON-serialised), truncated to 16 hex
 * chars. Matches the SDK's `computeContextHash` algorithm pattern for
 * coordination compatibility. Implemented locally because the SDK function
 * is not re-exported from `openclaw/plugin-sdk`.
 */
function computeContextHash(messages: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 16);
}
