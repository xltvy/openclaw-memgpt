/**
 * V2.1 — send_message discipline guard (the MemGPT "bouncer" analogue).
 *
 * Native MemGPT enforces send_message discipline architecturally:
 * `verify_first_message_correctness(require_send_message=True)`
 * (memgpt/agent.py:526) silently re-samples the first message up to
 * FIRST_MESSAGE_ATTEMPTS=10 times until it is a `send_message` call. Later
 * turns need no bouncer because `handle_ai_response` renders assistant
 * content as inner monologue — free text is structurally harmless.
 *
 * OpenClaw renders assistant content as the user-facing reply, so the plugin
 * analogue generalises the bouncer to *every* turn: when the agent is about
 * to finalize with visible free text and no `send_message` fired this turn,
 * return `{action:"revise"}` from `before_agent_finalize`. The runtime then
 * suppresses the pending terminal delivery and runs one more model pass with
 * the corrective instruction (INVESTIGATION_REPORT §2, §4).
 *
 * Declared deviations from native semantics (all forced by SDK shape;
 * methodology-bank V2.1 entry):
 *   - instruction-bearing re-prompt, not silent re-sample (the SDK revise
 *     path requires a non-empty instruction and prepends its own prefix);
 *   - per-turn, not first-turn-only (no structural monologue rendering on
 *     later turns here — and no "first turn of a resumed session" mapping
 *     problem, because there is no first-turn bookkeeping at all);
 *   - bounded by maxAttempts=3 (runtime hard cap MAX_BEFORE_AGENT_FINALIZE_
 *     REVISIONS=3/run) with graceful finalize on exhaustion, vs native's 10
 *     attempts then raise.
 *
 * Known SDK limit (characterised, not fixable plugin-side; version-
 * dependent): the embedded runtime refuses revision when the run had
 * "potential side effects". On OpenClaw ≤2026.6.8 that means a *mutating*
 * tool call (memory tools don't qualify — `isMutatingToolCall` returns false
 * for their names), so a memory-op-then-free-text turn IS re-promptable
 * there. From 2026.6.10 the rule tightened to "any non-replay-safe tool
 * executed", and plugin tools are never replay-safe on the embedded harness
 * — the chained turn cannot be re-prompted. Where refused, the gateway-path
 * payloadGuard still suppresses the leak; in `--local` it reaches the CLI
 * (the operator/debug surface, the analogue of MemGPT's own monologue-
 * displaying CLI). See INVESTIGATION_REPORT §4.1/§5 + the 2026.6.8 addendum.
 *
 * This file also owns the turn-boundary reset of the send_message flag:
 * `before_prompt_build` is the earliest per-turn hook the plugin already
 * participates in, and clearing there scopes the flag to the turn. The reset
 * and the check are the two halves of one lifecycle, so they live together.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";
import {
  SEND_MESSAGE_V1_KEY,
  clearSendMessageFired,
  peekSendMessageFired,
} from "../tools/sendMessage.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/**
 * The corrective instruction. First sentence is the "belt" sentence verbatim
 * from the fork's base prompt (memgpt/prompts/system/memgpt_base.txt:19 —
 * the string the model was trained against); second sentence is the one
 * imperative the SDK's revise mechanism needs.
 */
export const SEND_MESSAGE_REVISE_INSTRUCTION =
  "'send_message' is the ONLY action that sends a notification to the user, the user does not see anything else you do. " +
  "Call the send_message function now with the message you want the user to receive.";

/**
 * Matches the runtime's own per-run cap (MAX_BEFORE_AGENT_FINALIZE_REVISIONS
 * = 3); a higher value would silently truncate to 3 anyway.
 */
export const REVISE_MAX_ATTEMPTS = 3;

/**
 * Retry-budget key. The SDK's budget is already scoped per run, so a stable
 * plugin-scoped key is sufficient and keeps repeated firings within one run
 * counted against one budget.
 */
export const REVISE_IDEMPOTENCY_KEY = "openclaw-memgpt:send-message-discipline";

/** Untyped event/ctx shapes — OpenClaw SDK exposes `any` on api.on. */
interface FinalizeEvent {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
}

interface FinalizeCtx {
  trigger?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export function registerFinalizeGuardHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  // Turn-start reset — see file header. Fires alongside the promptSection and
  // flushPressure registrations on the same hook; contributes nothing to the
  // prompt.
  api.on("before_prompt_build", async () => {
    clearSendMessageFired(SEND_MESSAGE_V1_KEY);
  });

  api.on(
    "before_agent_finalize",
    async (event: FinalizeEvent, ctx: FinalizeCtx) => {
      // §6d.6 / §6.1 readiness gates — an unconfigured or dead plugin must not
      // interfere with the host's reply path.
      if (deps.lifecycle?.isConfigured === false) return;
      if (deps.lifecycle?.isDead) return;

      // Guards wrapped defensively: a ctx-shape mismatch must not break the
      // host's finalize path — pass through instead.
      try {
        const sessionKey = event?.sessionKey ?? ctx?.sessionKey;
        if (isNonInteractiveTrigger(ctx?.trigger, sessionKey)) return;
        if (isSubagentSession(sessionKey)) return;
        // Discipline satisfied — send_message fired this turn. Any trailing
        // free text is monologue; payloadGuard handles its display fate.
        if (peekSendMessageFired(SEND_MESSAGE_V1_KEY)) return;
      } catch (err) {
        deps.logger.warn(
          `openclaw-memgpt: finalizeGuard guards threw: ${stringifyError(err)}`,
        );
        return;
      }

      // The would-be user-facing free text (runtime only fires this hook when
      // visible assistant text exists). Best-effort observability before the
      // revise request; the emit must never block the revision.
      const text =
        typeof event?.lastAssistantMessage === "string"
          ? event.lastAssistantMessage
          : "";
      try {
        deps.emit({
          kind: "finalize_revision_requested",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: { length: text.length, maxAttempts: REVISE_MAX_ATTEMPTS },
          content: { text },
        });
      } catch (err) {
        deps.logger.warn(
          `openclaw-memgpt: finalize_revision_requested emit failed: ${stringifyError(err)}`,
        );
      }

      return {
        action: "revise",
        retry: {
          instruction: SEND_MESSAGE_REVISE_INSTRUCTION,
          maxAttempts: REVISE_MAX_ATTEMPTS,
          idempotencyKey: REVISE_IDEMPOTENCY_KEY,
        },
      };
    },
  );
}

/** Normalise an unknown error to a string for log + emit payloads. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
