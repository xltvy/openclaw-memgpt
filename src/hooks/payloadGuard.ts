/**
 * V2.1 — monologue routing guard (the MemGPT "suspenders" analogue).
 *
 * Native MemGPT has no free-text-to-user path: `handle_ai_response` renders
 * assistant `content` via `interface.internal_monologue(...)`; the only route
 * to a user-facing message is the `send_message` function. This hook is the
 * plugin-side analogue at OpenClaw's payload-delivery boundary:
 * `reply_payload_sending` fires per outbound payload on the dispatcher
 * delivery path (gateway/channels), and cancelling a `final`/`block` payload
 * routes that text to the inner-monologue record instead of the user.
 *
 * Cancellation applies to free-text payloads whether or not `send_message`
 * fired this turn — in the native architecture assistant content is always
 * monologue; trailing text after a legitimate `send_message` call is
 * monologue too. The turn flag is recorded as provenance on the
 * observability event, not used as a bypass.
 *
 * ONE exception (Telegram finding, 2026-08-03): a free-text payload whose
 * text is a whitespace-normalised duplicate of a `send_message` text from
 * this turn is passed through, not cancelled. Some models re-emit their
 * send_message content verbatim as the final free text; on channels that
 * stream free text but do not render tool results as messages (send_message
 * is not in the host's CORE_MESSAGING_TOOLS), cancelling that duplicate
 * deletes the only user-visible copy — observed on Telegram as the reply
 * appearing (streamed draft) then vanishing (final delivery cancelled →
 * draft cleanup), leaving the user with nothing. Identical text is by
 * definition not monologue: it IS the message the agent already elected to
 * send. Genuinely different trailing text remains monologue and is still
 * cancelled; the comparison is exact equality after whitespace collapse
 * (fuzzier matching risks reclassifying real monologue as the message).
 * Passed-through duplicates emit `monologue_passthrough`.
 *
 * What is never cancelled (the payload must actually be assistant free text):
 *   - `tool` payloads — `send_message`'s own text rides a tool result;
 *   - error payloads (`isError`) — hiding host failures from the user is
 *     strictly worse than an I/O-discipline blemish;
 *   - status notices (`isStatusNotice`) — host-authored progress UI;
 *   - media-bearing payloads — the memory plugin has no business eating
 *     attachments;
 *   - empty payloads — nothing to route.
 *
 * The suppressed text is emitted as a `monologue_suppressed` event (verbose:
 * with the text; default: metadata only). The JSONL event stream is the
 * plugin's inner-monologue display surface — the analogue of MemGPT's CLI,
 * where monologue is visible to the operator but never to the chat channel.
 *
 * Scope note (INVESTIGATION_REPORT §2): this hook does not fire in `--local`
 * one-shot mode, where terminal payloads are printed directly with no
 * cancellable hook. There, the finalizeGuard's revise-suppression is the only
 * intercept, and a post-retry-budget leak reaches the CLI (the operator/debug
 * surface). The gateway/channel path — the deployment path — gets the hard
 * display guarantee this hook provides.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";
import {
  SEND_MESSAGE_V1_KEY,
  peekSendMessageFired,
  peekSendMessageTexts,
} from "../tools/sendMessage.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/** Cancel reason surfaced in the SDK's hook-decision debug log. */
export const MONOLOGUE_CANCEL_REASON =
  "openclaw-memgpt: assistant free text is inner monologue; send_message is the only user-facing channel";

/** Untyped event shape — OpenClaw SDK exposes `any` on api.on. */
interface PayloadSendingEvent {
  payload?: {
    text?: string;
    isError?: boolean;
    isStatusNotice?: boolean;
    mediaUrl?: string;
    mediaUrls?: unknown[];
    [key: string]: unknown;
  };
  kind?: string;
  sessionKey?: string;
  runId?: string;
  [key: string]: unknown;
}

export function registerPayloadGuardHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on("reply_payload_sending", async (event: PayloadSendingEvent) => {
    // §6d.6 / §6.1 readiness gates — an unconfigured or dead plugin must not
    // interfere with the host's delivery path.
    if (deps.lifecycle?.isConfigured === false) return;
    if (deps.lifecycle?.isDead) return;

    let text: string;
    try {
      // Only assistant free text is monologue; see file header for the
      // exclusion rationale, item by item.
      const kind = event?.kind;
      if (kind !== "final" && kind !== "block") return;
      if (isNonInteractiveTrigger(undefined, event?.sessionKey)) return;
      if (isSubagentSession(event?.sessionKey)) return;
      const payload = event?.payload;
      if (!payload) return;
      if (payload.isError === true) return;
      if (payload.isStatusNotice === true) return;
      if (payload.mediaUrl) return;
      if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0)
        return;
      if (typeof payload.text !== "string" || payload.text.trim() === "")
        return;
      text = payload.text;
    } catch (err) {
      deps.logger.warn(
        `openclaw-memgpt: payloadGuard guards threw: ${stringifyError(err)}`,
      );
      return;
    }

    // Duplicate-of-send_message pass-through — see the header's "ONE
    // exception" paragraph. Checked against every send_message text recorded
    // this turn (models can call the tool more than once per turn).
    if (
      peekSendMessageTexts(SEND_MESSAGE_V1_KEY).some(
        (sent) => normaliseForCompare(sent) === normaliseForCompare(text),
      )
    ) {
      try {
        deps.emit({
          kind: "monologue_passthrough",
          namespace: deps.namespace,
          ts: new Date().toISOString(),
          meta: {
            payloadKind: event.kind as string,
            length: text.length,
            reason: "duplicate_of_send_message",
          },
          content: { text },
        });
      } catch (err) {
        deps.logger.warn(
          `openclaw-memgpt: monologue_passthrough emit failed: ${stringifyError(err)}`,
        );
      }
      return;
    }

    // Best-effort observability — the suppressed text is the monologue record.
    try {
      deps.emit({
        kind: "monologue_suppressed",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: {
          payloadKind: event.kind as string,
          length: text.length,
          hadSendMessage: peekSendMessageFired(SEND_MESSAGE_V1_KEY),
        },
        content: { text },
      });
    } catch (err) {
      deps.logger.warn(
        `openclaw-memgpt: monologue_suppressed emit failed: ${stringifyError(err)}`,
      );
    }

    return { cancel: true, reason: MONOLOGUE_CANCEL_REASON };
  });
}

/** Normalise an unknown error to a string for log + emit payloads. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Whitespace-collapsed equality basis for the duplicate check: channels and
 * models disagree on trailing newlines / spacing around the same content, but
 * anything beyond whitespace is treated as a real difference (= monologue).
 */
function normaliseForCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
