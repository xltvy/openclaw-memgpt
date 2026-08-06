/**
 * §4.4 — flush-pressure check, single-hook form (provider-independent):
 *
 *   `agent_end` (end of turn N−1): estimates the buffer's token load locally
 *   (per-message `estimateTokens` from `openclaw/plugin-sdk/agent-core`,
 *   summed over `event.messages`), checks the threshold, and — if tripped and
 *   not already flushed for the current compaction cycle — calls `:summarize`,
 *   writes flush metadata to the session store, and mirrors the
 *   packagedMessage to recall.
 *
 *   `ContextEngine.assemble()` (start of turn N): reads the flush metadata
 *   and returns `[packagedMessage, ...messages.slice(cutoff)]`. Faithful to
 *   MemGPT's native post-summarise buffer shape. The LLM on turn N sees the
 *   trimmed context.
 *
 * **Why local estimation, not provider `usage`** (the 6d fix): the previous
 * two-hook form captured `llm_output.event.usage.total` into a cross-hook Map
 * and compared it against the threshold in `agent_end`. That made the
 * plugin's entire memory-LLM path depend on provider honesty: against an
 * endpoint that under-reports input tokens (observed: 3 tokens reported for a
 * ~3,900-token prompt) the threshold was unreachable and `:summarize` never
 * fired — silently, because nothing logged below the threshold. Token load is
 * a decision this plugin can make locally from the buffer it already holds,
 * so it does. The Map, the `llm_output` handler, and the session-keyed
 * cleanup are gone with the constraint that motivated them.
 *
 * NB: per-message `estimateTokens`, never `estimateContextTokens` — the
 * latter anchors on the last assistant message's provider-reported usage and
 * only estimates the tail after it, which would silently reimport the exact
 * bug this design removes.
 *
 * **Threshold** (proportional, configurable): `ctx.contextTokenBudget ×
 * flushRatio` (config `flushRatio`, default 0.75 — MemGPT's own warning
 * fraction, fork `memgpt/constants.py:20-22`). When the SDK doesn't supply a
 * budget, falls back to the absolute `MESSAGE_SUMMARY_WARNING_TOKENS = 6000`
 * (= int(0.75 × 8000), the fork's derived literal) — which also means an
 * 8k-budget session behaves exactly as every release before this one.
 *
 * **Why `agent_end`, not `before_prompt_build`** (deliberate — both carry
 * `event.messages` now):
 *   1. `assemble()` fires BEFORE `before_prompt_build`, so either hook's
 *      flush can only take effect at the NEXT turn's assemble() — firing
 *      earlier within the turn buys nothing.
 *   2. `agent_end` runs after the reply is out: the `:summarize` LLM
 *      round-trip stays off the user-visible critical path, where
 *      `before_prompt_build` would insert it in front of every model call.
 *   3. `agent_end` carries `success`, letting failed turns skip cleanly.
 *   4. It keeps the existing placement, so the §4.4 race characterisation
 *      and the metadata-write/mirror sequence are unchanged.
 *
 * **Fidelity at algorithm/data-shape level** (byte-identical to CLI):
 *   cutoff algorithm (F1 sidecar-side), summary text, packagedMessage
 *   template, post-flush buffer shape, recall searchability. See §4.4.
 *
 * **Declared deviations** (architecturally bounded by hook constraints):
 *   Flush computation runs at end of turn N−1; turn N's user message is
 *   not in the cutoff candidates (negligible — preserve_last_N keeps recent
 *   content intact). Fire-and-forget race: eventual-consistency at one-turn
 *   granularity. Token counts are estimates (chars/4 heuristic — OpenClaw's
 *   own compactor uses the same estimator). See §4.4.
 *
 * **Observability** (the anti-silent-death rule): EVERY evaluation logs its
 * numbers — estimated tokens, budget, ratio, threshold, outcome — at debug
 * level, negative outcomes included. The prior form's silent early return is
 * precisely why the dead trigger survived 20 long turns undetected; a
 * "did not trip: 247/6000" line would have exposed it immediately.
 *
 * Error policy on `:summarize` (§2.8):
 *   - `BufferTooSmallError` (422): info-level no-op. False-alarm threshold
 *     crossing on a small token-heavy buffer is recoverable.
 *   - other errors: log + emit `emit_failed`, do NOT re-throw. Self-heals
 *     on the next agent_end (tokens stay above threshold; predicate re-trips).
 *
 * Guards (reuse triggers.ts from 6c.5): non-interactive trigger and subagent
 * session both skip (same telemetry / orphaned-namespace reasoning as the
 * mirror hook). Additionally: `event.success === false` skips flush.
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
 * Absolute fallback threshold, used only when the SDK supplies no
 * `contextTokenBudget`. MemGPT's flush threshold per `memgpt/constants.py:22`:
 *   MESSAGE_SUMMARY_WARNING_TOKENS = int(0.75 * LLM_MAX_TOKENS)   # LLM_MAX_TOKENS = 8000
 * Verbatim derived value; literal rather than imported so it stays MemGPT-
 * faithful even if a future fork tweak rebases LLM_MAX_TOKENS.
 */
export const MESSAGE_SUMMARY_WARNING_TOKENS = 6000;

/**
 * Default flush ratio — MemGPT's own 0.75 warning fraction, now applied to
 * the session's real context budget instead of the fork's hardcoded 8k.
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

interface AgentEndEvent {
  messages?: unknown[];
  success?: boolean;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export function registerFlushPressureHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
  opts?: { flushRatio?: number },
): void {
  const flushRatio = opts?.flushRatio ?? DEFAULT_FLUSH_RATIO;

  api.on(
    "agent_end",
    async (eventRaw: unknown, ctxRaw: unknown) => {
      const ctx = (ctxRaw ?? {}) as AgentContext & {
        contextTokenBudget?: number;
      };
      const event = (eventRaw ?? {}) as AgentEndEvent;

      // §6d.6 config gate — skip flush (silently) when unconfigured.
      if (deps.lifecycle?.isConfigured === false) return;
      // §6.1 lifecycle — skip silently if the sidecar died (no point
      // attempting :summarize against an unreachable endpoint; the mirror
      // hook's same-turn skip means there's nothing to summarise into
      // anyway).
      if (deps.lifecycle?.isDead) return;

      // Standard guards — same precedent as the mirror hook.
      if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
      if (isSubagentSession(ctx.sessionKey)) return;

      // Failed turn: skip flush.
      if (!event.success) return;

      // ── Local token estimate (never provider usage) ─────────────────────
      const estimate = await resolveEstimator(deps.logger);
      const messages = event.messages ?? [];
      const tokens = messages.reduce<number>(
        (sum, m) => sum + estimate(m),
        0,
      );

      const budget =
        typeof ctx.contextTokenBudget === "number" &&
        ctx.contextTokenBudget > 0
          ? ctx.contextTokenBudget
          : undefined;
      const threshold =
        budget !== undefined
          ? Math.floor(budget * flushRatio)
          : MESSAGE_SUMMARY_WARNING_TOKENS;
      const tripped = tokens >= threshold;

      // Every evaluation is observable, negative outcomes included — a
      // silent early return here is how the provider-usage defect survived
      // undetected.
      deps.logger.debug(
        `openclaw-memgpt: flush evaluation: estTokens=${tokens} budget=${budget ?? "unset"} ratio=${flushRatio} threshold=${threshold} ${tripped ? "TRIPPED" : "did not trip"} (sessionKey=${ctx.sessionKey})`,
      );
      if (!tripped) return;

      // Read the session entry — encapsulates sessionKey / agentId presence
      // checks + missing-entry (first turn) case.
      const entry = loadSessionEntry(api, ctx);
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
        `openclaw-memgpt: flush threshold tripped (sessionKey=${ctx.sessionKey}, totalTokens=${tokens} >= ${threshold}${budget !== undefined ? ` = ${budget} * ${flushRatio}` : " [absolute fallback]"})`,
      );

      if (!messages.length) {
        deps.logger.debug(
          `openclaw-memgpt: summarise skipped — event.messages empty for sessionKey=${ctx.sessionKey}`,
        );
        return;
      }

      // §3.7 normalisation boundary — same as the 6c.5 mirror hook.
      const v0Messages = normaliseMessages(messages as OpenClawMessage[]);

      // total_message_count source: GET /agents/{id}/stats. Sidecar is the
      // source of truth; round-trip only fires when predicate has already passed.
      let totalMessageCount: number;
      try {
        const stats = await deps.client.getStats();
        totalMessageCount = stats.totalMessageCount;
      } catch (err) {
        deps.logger.error(
          `openclaw-memgpt: getStats failed before summarise: ${stringifyError(err)}`,
        );
        deps.emit({
          kind: "emit_failed",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: {
            operation: "getStats",
            reason: stringifyError(err),
          },
        });
        return; // recoverable on next agent_end
      }

      try {
        const result = await deps.client.summarize(
          v0Messages,
          totalMessageCount,
        );
        deps.logger.info(
          `openclaw-memgpt: summarisation succeeded (sessionKey=${ctx.sessionKey}, cutoff=${result.cutoff}, summaryLength=${result.summaryLength})`,
        );
        deps.emit({
          kind: "summarisation_succeeded",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: {
            cutoff: result.cutoff,
            totalTokens: tokens,
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
              reason: stringifyError(mirrorErr),
            },
          });
        }
      } catch (err) {
        if (err instanceof BufferTooSmallError) {
          // §2.8: a small token-heavy buffer is recoverable — false-alarm
          // threshold crossing. Treat as no-op rather than failing the turn.
          deps.logger.info(
            `openclaw-memgpt: summarisation skipped (buffer too small) for sessionKey=${ctx.sessionKey}, totalTokens=${tokens}`,
          );
          deps.emit({
            kind: "summarisation_skipped",
            namespace: deps.namespace,
            ts: new Date().toISOString(),
            meta: {
              reason: "buffer_too_small",
              totalTokens: tokens,
            },
          });
          return;
        }
        // Other errors: self-heals on next agent_end.
        deps.logger.error(
          `openclaw-memgpt: summarise failed for sessionKey=${ctx.sessionKey}: ${stringifyError(err)}`,
        );
        deps.emit({
          kind: "emit_failed",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: {
            operation: "summarize",
            reason: stringifyError(err),
          },
        });
      }
    },
  );
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
