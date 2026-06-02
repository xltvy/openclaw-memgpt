/**
 * §4.4 — flush-pressure check on `before_prompt_build`. Second handler on the
 * same event as 6c.4's prompt-section hook (multi-handler dispatch confirmed
 * in the 6c.6.0 SDK read; Mem0 reference also registers `before_prompt_build`
 * twice for separate concerns).
 *
 * **6c.6.2 scope:** threshold check (6c.6.1) + summariser glue. When the
 * threshold trips, call `client.summarize(event.messages, totalMessageCount)`
 * with the §2.8 422 → no-op policy and recoverable-on-next-turn semantics
 * for other failures. **Session-store mutation still deferred to 6c.6.3**
 * (the actual buffer trim + packagedMessage prepend + `memoryFlushAt`
 * write happen there; a code comment in the success branch names this).
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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { BufferTooSmallError } from "../client/errors.ts";
import { normaliseMessages, type OpenClawMessage } from "../normalise.ts";
import type { ToolDeps } from "../tools/deps.ts";
import {
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
        // 6c.6.3 wires the trim-and-prepend here:
        //   - session-store update to replace event.messages with
        //     [messages[0], result.packagedMessage, ...messages[cutoff:]]
        //   - client.messagesAppend([result.packagedMessage]) for recall
        //   - write memoryFlushAt / memoryFlushContextHash on SessionEntry
        //     to suppress OpenClaw's own compaction this round
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
