/**
 * §4.4 — flush-pressure check spanning two hooks:
 *
 *   `llm_output` (within turn N−1): captures `event.usage?.total` per
 *   sessionKey into a module-level Map<string, number>.  This is the only
 *   hook that carries the accurate current-turn token count before
 *   `persistRunSessionUsage` writes it to `SessionEntry`.
 *
 *   `agent_end` (end of turn N−1): reads the captured token, checks the
 *   threshold, and — if tripped and not already flushed for the current
 *   compaction cycle — calls `:summarize`, writes flush metadata to the
 *   session store, and mirrors the packagedMessage to recall.
 *
 *   `ContextEngine.assemble()` (start of turn N): reads the flush metadata
 *   and returns `[messages[0] (system anchor), packagedMessage, ...messages.slice(cutoff)]`.
 *   Faithful to MemGPT's native post-summarise buffer shape. The LLM on
 *   turn N sees the trimmed context.
 *
 * Both `llm_output` and `agent_end` are fire-and-forget (.catch); the race
 * window (metadata write vs turn N's assemble()) is user-interaction-bounded
 * and practically never manifests. Self-healing: if the race fires, the
 * predicate re-trips on the next agent_end.
 *
 * **Why this trigger, not `before_prompt_build`** (§4.4 investigation):
 *   Three SDK constraints block same-hook flush:
 *   1. `assemble()` fires BEFORE `before_prompt_build`; bpb cannot affect
 *      the message buffer (return value is prompt-text only).
 *   2. `llm_output` has `usage.total` but no message buffer; `agent_end`
 *      has the buffer but not the current-turn token count (persistRunSession-
 *      Usage runs AFTER agent_end).
 *   3. No hook fires between assemble() and the LLM call with both buffer
 *      and token count.
 *   `llm_output` + `agent_end` is the closest SDK-permitted approximation.
 *
 * **Fidelity at algorithm/data-shape level** (byte-identical to CLI):
 *   cutoff algorithm (F1 sidecar-side), summary text, packagedMessage
 *   template, post-flush buffer shape, recall searchability. See §4.4.
 *
 * **Declared deviations** (architecturally bounded by hook constraints):
 *   Flush computation runs at end of turn N−1; turn N's user message is
 *   not in the cutoff candidates (negligible — preserve_last_N keeps recent
 *   content intact). Fire-and-forget race: eventual-consistency at one-turn
 *   granularity. See §4.4 for the full characterisation.
 *
 * Error policy on `:summarize` (§2.8):
 *   - `BufferTooSmallError` (422): info-level no-op. False-alarm threshold
 *     crossing on a small token-heavy buffer is recoverable.
 *   - other errors: log + emit `emit_failed`, do NOT re-throw. Self-heals
 *     on the next agent_end (tokens stay above threshold; predicate re-trips).
 *
 * Threshold = `MESSAGE_SUMMARY_WARNING_TOKENS` (§4.4 + fork's
 * `memgpt/constants.py:20-22`). Verbatim derived value: `int(0.75 * 8000)`
 * = `6000`. Literal rather than imported so the threshold stays MemGPT-
 * faithful even if a future fork tweak rebases LLM_MAX_TOKENS.
 *
 * Guards (reuse triggers.ts from 6c.5): non-interactive trigger and subagent
 * session both skip (same telemetry / orphaned-namespace reasoning as the
 * mirror hook). Additionally: `event.success === false` on agent_end skips
 * flush (failed turn) while cleaning up the Map entry.
 */

import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { BufferTooSmallError } from "../client/errors.ts";
import { normaliseMessages, type OpenClawMessage } from "../normalise.ts";
import type { ToolDeps } from "../tools/deps.ts";
import {
  getRuntimeSession,
  hasAlreadyFlushedForCurrentCompaction,
  loadSessionEntry,
  type AgentContext,
} from "./sessionStore.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/**
 * MemGPT's flush threshold per `memgpt/constants.py:22`:
 *   MESSAGE_SUMMARY_WARNING_TOKENS = int(0.75 * LLM_MAX_TOKENS)   # LLM_MAX_TOKENS = 8000
 * Verbatim derived value. See module docstring for why this is a literal
 * here rather than imported.
 */
export const MESSAGE_SUMMARY_WARNING_TOKENS = 6000;

interface LlmOutputEvent {
  usage?: {
    total?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  [key: string]: unknown;
}

interface AgentEndEvent {
  messages?: OpenClawMessage[];
  success?: boolean;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

/**
 * Per-sessionKey token capture: written by the `llm_output` handler,
 * consumed (and deleted) by the `agent_end` handler. Module-level so both
 * handlers share one Map without a closure — the same pattern as
 * sendMessage.ts's suppressionMap.
 */
const capturedTokens = new Map<string, number>();

/** @internal reset captured token state between tests */
export function _resetCapturedTokensForTests(): void {
  capturedTokens.clear();
}

export function registerFlushPressureHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  // ── Handler 1: llm_output — capture current-turn token count ───────────
  api.on("llm_output", (eventRaw: unknown, ctxRaw: unknown) => {
    const ctx = (ctxRaw ?? {}) as AgentContext;
    const event = (eventRaw ?? {}) as LlmOutputEvent;

    if (!ctx.sessionKey) return;
    if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
    if (isSubagentSession(ctx.sessionKey)) return;

    const total = event.usage?.total;
    if (typeof total === "number") {
      capturedTokens.set(ctx.sessionKey, total);
    }
  });

  // ── Handler 2: agent_end — threshold check + :summarize sequence ────────
  api.on(
    "agent_end",
    async (eventRaw: unknown, ctxRaw: unknown) => {
      const ctx = (ctxRaw ?? {}) as AgentContext;
      const event = (eventRaw ?? {}) as AgentEndEvent;

      // Standard guards — same precedent as the mirror hook.
      if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
      if (isSubagentSession(ctx.sessionKey)) return;

      // Read and consume the captured token (always delete to avoid stale
      // state; the next turn's llm_output will repopulate if needed).
      const tokens = ctx.sessionKey
        ? capturedTokens.get(ctx.sessionKey)
        : undefined;
      if (ctx.sessionKey) capturedTokens.delete(ctx.sessionKey);

      // Failed turn: skip flush, Map already cleaned up.
      if (!event.success) return;

      // No captured token (llm_output didn't fire / usage absent) or below threshold.
      if (tokens === undefined || tokens < MESSAGE_SUMMARY_WARNING_TOKENS)
        return;

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
        `openclaw-memgpt: flush threshold tripped (sessionKey=${ctx.sessionKey}, totalTokens=${tokens} >= ${MESSAGE_SUMMARY_WARNING_TOKENS})`,
      );

      if (!event.messages?.length) {
        deps.logger.debug(
          `openclaw-memgpt: summarise skipped — event.messages empty for sessionKey=${ctx.sessionKey}`,
        );
        return;
      }

      // §3.7 normalisation boundary — same as the 6c.5 mirror hook.
      const v0Messages = normaliseMessages(event.messages);

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
