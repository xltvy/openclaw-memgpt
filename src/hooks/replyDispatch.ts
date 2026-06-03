/**
 * §4.3 — `reply_dispatch` hook. Reads the V1 suppression flag and, when set,
 * claims the dispatch so OpenClaw doesn't deliver the LLM's trailing natural
 * reply after `send_message` has already put user-facing text in the channel.
 *
 * S0.1 mechanism confirmed: `recordProcessed("skipped")` + `markIdle` + return
 * `{handled:true, …}`. Never call `abort()` — it corrupts the turn record.
 *
 * **Trigger-field finding (verified against SDK types, 6c.7b).**
 * `PluginHookReplyDispatchEvent` exposes `ctx: FinalizedMsgContext` and
 * `sessionKey?: string` at the top level. `FinalizedMsgContext` extends
 * `MsgContext`, which has no `trigger` field. The trigger string is therefore
 * absent from the reply_dispatch event shape entirely. `isNonInteractiveTrigger`
 * is called as `(undefined, event.sessionKey)` — the function's sessionKey-
 * pattern fallback (`:cron:`, `:heartbeat:`) handles non-interactive detection.
 *
 * **`takeSuppress` is always called first — before guards.** Even when a guard
 * short-circuits (non-interactive, subagent), the flag must be cleared so the
 * next turn doesn't inherit a stale suppression. Single-shot semantics: one
 * `markSuppress` consumed by exactly one `takeSuppress`.
 *
 * **Error asymmetry.**
 *   - Guard exceptions → log warn + return pass-through. Don't break the turn
 *     over a transient ctx-shape mismatch.
 *   - `recordProcessed`/`markIdle` exceptions → log error + re-throw. These
 *     are SDK calls; failure is a real host-visible problem.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";
import { SUPPRESS_V1_KEY, takeSuppress } from "../tools/sendMessage.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

// Structural aliases for the reply_dispatch event/context pair.
// OpenClaw SDK exposes `any` on api.on; we define the subset we depend on.
interface ReplyDispatchEvent {
  ctx?: Record<string, unknown>;
  sessionKey?: string;
  [key: string]: unknown;
}

interface ReplyDispatchContext {
  dispatcher: { getQueuedCounts(): Record<string, number>; [key: string]: unknown };
  recordProcessed(outcome: "completed" | "skipped" | "error", opts?: { reason?: string; error?: string }): void;
  markIdle(reason: string): void;
  [key: string]: unknown;
}

export function registerReplyDispatchHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on(
    "reply_dispatch",
    async (event: ReplyDispatchEvent, ctx: ReplyDispatchContext) => {
      // Always clear the suppression flag FIRST — before any guard returns.
      // Guards decide whether to *apply* suppression; both paths must clear it.
      const suppress = takeSuppress(SUPPRESS_V1_KEY);

      // Guards: skip non-interactive and subagent turns.
      try {
        if (isNonInteractiveTrigger(undefined, event?.sessionKey)) return;
        if (isSubagentSession(event?.sessionKey)) return;
      } catch (err) {
        deps.logger.warn(
          `openclaw-memgpt: replyDispatch guards threw: ${stringifyError(err)}`,
        );
        return;
      }

      // No suppression flag → LLM's natural reply flows to user.
      if (!suppress) return;

      // send_message claimed the output channel this turn (§4.3 / S0.1).
      // Record + idle + claim the dispatch. Do NOT call abort().
      try {
        ctx.recordProcessed("skipped", { reason: "send_message handled output" });
        ctx.markIdle("send_message suppression");
      } catch (err) {
        deps.logger.error(
          `openclaw-memgpt: replyDispatch ctx calls threw: ${stringifyError(err)}`,
        );
        throw err;
      }

      return {
        handled: true,
        queuedFinal: false,
        counts: ctx.dispatcher.getQueuedCounts() as Record<
          "tool" | "block" | "final",
          number
        >,
      };
    },
  );
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
