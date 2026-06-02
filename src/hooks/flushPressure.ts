/**
 * §4.4 — flush-pressure check on `before_prompt_build`. Second handler on the
 * same event as 6c.4's prompt-section hook (multi-handler dispatch confirmed
 * in the 6c.6.0 SDK read; Mem0 reference also registers `before_prompt_build`
 * twice for separate concerns).
 *
 * **6c.6.2–6c.6.3 scope:** threshold check (6c.6.1) + summariser glue
 * (6c.6.2) + session-store metadata write + recall mirror (6c.6.3). When
 * the threshold trips, calls `client.summarize(event.messages, totalMessageCount)`
 * with the §2.8 422 → no-op policy and recoverable-on-next-turn semantics
 * for other failures. On success: writes flush metadata to `SessionEntry`
 * (including `memoryFlushCutoff` + `memoryFlushPackagedMessageJson` for the
 * ContextEngine assemble() virtual-trim path — §4.4) and mirrors the
 * packagedMessage to recall via `messagesAppend`.
 *
 * Why session-entry tokens, not event tokens: `PluginHookBeforePromptBuildEvent`
 * is `{prompt, messages}` — no token field. OpenClaw stores cumulative context
 * tokens on `SessionEntry` from each `llm_output.usage`; that's the canonical
 * place to read them.
 *
 * Why `event.messages`, not `entry.messages`: `SessionEntry` has no
 * `messages` field (the message buffer lives in `entry.sessionFile` —
 * transcript JSONL — and on `event.messages` for the current turn).
 * `event.messages` is the SDK-sanctioned source for the current turn's
 * buffer; reading the transcript file would be expensive sync I/O on
 * every threshold-trip turn for no extra fidelity.
 *
 * Why `client.getStats()` for `totalMessageCount`: the §2.8 preamble
 * template "Note: prior messages (N of TOTAL total messages) have been
 * hidden" needs the all-time count. `SessionEntry` exposes `compactionCount`
 * but no all-time message counter; computing it host-side would require
 * a per-namespace counter persisted across restarts. The sidecar already
 * IS the source of truth (pm.all_messages); 6c.6.2 added GET
 * /agents/{id}/stats so the hook can read it directly. One round-trip
 * per threshold-trip — only fires when the predicate already passed, so
 * the cost is bounded.
 *
 * Threshold = `MESSAGE_SUMMARY_WARNING_TOKENS` (§4.4 + fork's
 * `memgpt/constants.py:20-22`). The fork derives it as
 * `int(0.75 * LLM_MAX_TOKENS)` with `LLM_MAX_TOKENS = 8000`, so the
 * load-bearing value is `6000`. Reproduced as a literal here rather than
 * imported so the plugin's threshold stays MemGPT-faithful even if a future
 * fork tweak rebases `LLM_MAX_TOKENS` for a different model class — the
 * threshold is part of MemGPT's behavioural contract (when to summarise),
 * not a runtime-configurable budget.
 *
 * Guards (reuse triggers.ts from 6c.5): non-interactive trigger and subagent
 * session both skip — same telemetry / orphaned-namespace reasoning as the
 * mirror hook. Plus: missing `ctx.sessionKey` / `ctx.agentId` skip (can't
 * address the session entry without them), and missing-entry skip (first
 * turn — no prior usage to read).
 *
 * Error policy on `:summarize` (§2.8):
 *   - `BufferTooSmallError` (422): info-level no-op. False-alarm threshold
 *     crossing on a small token-heavy buffer is recoverable; failing the
 *     turn over it is not.
 *   - other errors: log + emit `emit_failed`, do NOT re-throw. Flush is
 *     recoverable on the next turn (tokens will still be over threshold;
 *     the predicate will trip again and retry the summarise naturally).
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
  resolveFreshSessionTotalTokens,
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

interface BeforePromptBuildEvent {
  prompt?: string;
  messages?: OpenClawMessage[];
  [key: string]: unknown;
}

export function registerFlushPressureHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on(
    "before_prompt_build",
    async (eventRaw: unknown, ctxRaw: unknown) => {
      const ctx = (ctxRaw ?? {}) as AgentContext;
      const event = (eventRaw ?? {}) as BeforePromptBuildEvent;

      // Standard guards — same precedent as the agent_end mirror hook.
      if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
      if (isSubagentSession(ctx.sessionKey)) return;

      // Read the session entry — encapsulates the session-store load +
      // ctx.sessionKey / ctx.agentId presence checks + missing-entry case.
      const entry = loadSessionEntry(api, ctx);
      if (!entry) return;

      // Stale-snapshot guard — totalTokensFresh === false means the value
      // is from a prior un-rotated context. Acting on it would mis-attribute
      // a threshold trip to the current turn.
      const tokens = resolveFreshSessionTotalTokens(entry);
      if (tokens === null) {
        deps.logger.debug(
          `openclaw-memgpt: flush check skipped (stale snapshot) for sessionKey=${ctx.sessionKey}`,
        );
        return;
      }

      if (tokens < MESSAGE_SUMMARY_WARNING_TOKENS) return;

      // Already flushed for the current OpenClaw compaction cycle — skip to
      // avoid re-summarising the same context. This fires when
      // `memoryFlushCompactionCount === compactionCount`, which we write at the
      // end of a successful flush (6c.6.3). It unblocks naturally when
      // OpenClaw's compaction fires and increments `compactionCount`.
      if (hasAlreadyFlushedForCurrentCompaction(entry)) {
        deps.logger.debug(
          `openclaw-memgpt: flush already done for current compaction cycle, skipping (sessionKey=${ctx.sessionKey})`,
        );
        return;
      }

      // Threshold tripped + fresh + guarded. Log here (the 6c.6.1 contract);
      // then call :summarize. Without the messages we can't summarise — the
      // event should always carry them, but guard defensively.
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

      // total_message_count source: GET /agents/{id}/stats. See module
      // docstring for why this is sidecar-tracked rather than host-tracked.
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
        return; // recoverable on next turn
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
        // ── 6c.6.3: metadata write + recall mirror ─────────────────────────
        //
        // What we write (§4.4 — 6c.6.3a investigation outcome):
        //   memoryFlushAt                — ms timestamp of this flush
        //   memoryFlushCompactionCount   — = compactionCount; causes
        //     hasAlreadyFlushedForCurrentCompaction to return true until
        //     OpenClaw's next compaction cycle (prevents re-summary)
        //   memoryFlushContextHash       — SHA-256(messages)[0:16] for dedup
        //   memoryFlushCutoff            — cutoff index for assemble() to slice
        //   memoryFlushPackagedMessageJson — packagedMessage JSON for assemble()
        //     to prepend; together these two fields let ContextEngine.assemble()
        //     return the virtually-trimmed message set on the next turn (§4.4).
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
              // Spread to avoid mutating the loaded store object in-place;
              // saveSessionStore receives a new snapshot with the updated entry.
              await session.saveSessionStore(storePath, {
                ...store,
                [ctx.sessionKey]: {
                  ...currentEntry,
                  memoryFlushAt: Date.now(),
                  memoryFlushCompactionCount: currentEntry.compactionCount ?? 0,
                  memoryFlushContextHash: contextHash,
                  // Written for ContextEngine.assemble() on the next turn:
                  // assemble() slices messages at cutoff and prepends the
                  // packagedMessage to form the virtually-trimmed set (§4.4).
                  memoryFlushCutoff: result.cutoff,
                  memoryFlushPackagedMessageJson: JSON.stringify(
                    result.packagedMessage,
                  ),
                },
              });
            } else {
              // Session entry vanished between predicate read and write —
              // recoverable: skip the metadata write silently.
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

        // Mirror the packaged summary to recall so it remains searchable
        // after the flush. packagedMessage is already in PyMemGPT v0 format
        // (returned by the sidecar); no normalisation needed.
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
          // agent_end hook mirrors all turn messages anyway, so the summary
          // will reach recall on the following turn.
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
        // Other errors: flush is recoverable on next turn (tokens stay above
        // threshold; predicate trips again; retry happens naturally). Log,
        // emit, don't re-throw — same recoverable-error pattern as 6c.5's
        // save failure.
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
 * chars. Matches the SDK's `computeContextHash` algorithm pattern
 * (`auto-reply/reply/memory-flush.d.ts`) for coordination compatibility.
 * The SDK function is not re-exported from `openclaw/plugin-sdk`, so we
 * implement it locally using the same algorithm type (SHA-256 / 16 chars).
 */
function computeContextHash(messages: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 16);
}
