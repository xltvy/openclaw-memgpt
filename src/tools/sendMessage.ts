/**
 * send_message — the §4.3 output tool.
 *
 * Distinct from the six memory tools: this is the *only* tool that reaches
 * the user, and the *only* tool with no sidecar endpoint. Output goes to
 * the user via OpenClaw, never to the memory substrate. The handler:
 *
 *   1. Marks the turn-scoped "send_message fired" flag (read by the V2.1
 *      discipline hooks: `finalizeGuard` peeks it to decide whether to
 *      request a revision pass, `payloadGuard` records it as provenance on
 *      suppressed-monologue events).
 *   2. Returns `params.message` verbatim as the tool-result text — that is
 *      what reaches the user inline in CLI mode (§4.3 CLI vs channel note).
 *
 * **Seam history (V1 → V2.1).** V1 shipped a `markSuppress`/`takeSuppress`
 * suppression registry consumed by a `reply_dispatch` hook, on the S0.1-era
 * premise that `reply_dispatch` fires after the model pass and can swallow
 * the trailing free-text reply. The V2.1 investigation (INVESTIGATION_REPORT
 * §2) showed that under the current SDK `reply_dispatch` fires *before* the
 * model runs — the V1 hook was retired, and the seam became this turn-flag:
 * write side here, non-consuming reads in the two V2.1 hooks, cleared at
 * turn start (`before_prompt_build` in finalizeGuard.ts).
 *
 * **Key choice (V1 topology, unchanged).** §4.3 specifies session-keyed state
 * for multi-session safety, but the SDK's tool `execute` signature is
 * `(toolCallId, params)` — no session context reaches the write side. V1 is
 * single-session per §4.3, so both halves of the seam use the
 * SEND_MESSAGE_V1_KEY sentinel. The Map-keyed shape is preserved so the
 * multi-session V2 topology is a key change, not a re-architecture.
 */

import type { ToolDeps, ToolHandler } from "./deps.ts";

// ── turn-flag registry ──────────────────────────────────────────────────────

/**
 * Sentinel key for V1's single-session topology. All seam participants use
 * this key; revisit when the multi-session topology lands or the SDK exposes
 * session context to `execute`.
 */
export const SEND_MESSAGE_V1_KEY = "__v1_single_session__";

const firedFlags = new Map<string, boolean>();

/** Write side — the sendMessage handler calls this on every invocation. */
export function markSendMessageFired(sessionKey: string): void {
  firedFlags.set(sessionKey, true);
}

/**
 * Read side — non-consuming. `finalizeGuard` (bouncer) and `payloadGuard`
 * (suspenders) both peek; neither may clear, because they can fire multiple
 * times per turn (one finalize check per model pass, one payload check per
 * outbound payload) and each needs the true turn state.
 */
export function peekSendMessageFired(sessionKey: string): boolean {
  return firedFlags.get(sessionKey) ?? false;
}

/**
 * Turn-boundary reset — called from the `before_prompt_build` registration in
 * finalizeGuard.ts so the flag cannot leak across turns in a long-lived
 * gateway process. (Exactly that leak, consumed pre-model-pass, was the V1
 * reply_dispatch latent bug.)
 */
export function clearSendMessageFired(sessionKey: string): void {
  firedFlags.delete(sessionKey);
}

/** Test-only — reset the registry between cases so they don't bleed state. */
export function _resetSendMessageFlagsForTests(): void {
  firedFlags.clear();
}

// ── handler ────────────────────────────────────────────────────────────────

export const sendMessage =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    const message = String(params.message ?? "");
    markSendMessageFired(SEND_MESSAGE_V1_KEY);
    deps.emit({
      kind: "send_message",
      namespace: deps.namespace,
      meta: { length: message.length },
      content: { text: message },
    });
    return { content: [{ type: "text", text: message }] };
  };
