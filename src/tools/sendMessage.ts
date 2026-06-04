/**
 * send_message — the §4.3 output tool.
 *
 * Distinct from the six memory tools: this is the *only* tool that reaches
 * the user, and the *only* tool with no sidecar endpoint. Output goes to
 * the user via OpenClaw, never to the memory substrate. The handler:
 *
 *   1. Marks a turn-termination suppression flag (read in 6c.7's
 *      `reply_dispatch` hook, which swallows OpenClaw's trailing
 *      no-tool-call dispatch and ends the turn cleanly — the S0.1-confirmed
 *      mechanism since there is no native stop in `AgentToolResult`).
 *   2. Returns `params.message` verbatim as the tool-result text — that is
 *      what reaches the user inline in CLI mode (§4.3 CLI vs channel note);
 *      channels will dispatch explicitly in 6c.7 wiring.
 *
 * **Suppression-key choice (V1).** §4.3 specifies session-keyed suppression
 * for multi-session safety. The current OpenClaw SDK's `execute` signature
 * is `(toolCallId, params)` — no `ctx.sessionKey`. V1 is single-session per
 * §4.3 ("Single-session validation (V1) wouldn't expose it; the multi-agent
 * experiment topology would"), so 6c.3 uses the SUPPRESS_V1_KEY sentinel
 * on both halves of the seam (this file marks; 6c.7's `reply_dispatch`
 * hook takes). When the multi-session V2 topology or an expanded SDK
 * `execute` contract surfaces `sessionKey`, both sides switch to the real
 * key together — the `markSuppress` / `takeSuppress` exports stay as the
 * seam. The Map-keyed shape is preserved here for that V2 extension.
 *
 * The export of `markSuppress` / `takeSuppress` co-locates the two halves
 * of the suppression mechanism (write side: this handler; read side:
 * 6c.7's `reply_dispatch` hook) and makes the seam testable in isolation.
 */

import type { ToolDeps, ToolHandler } from "./deps.ts";

// ── suppression registry ────────────────────────────────────────────────────

/**
 * Sentinel key for V1's single-session topology. Both halves of the
 * suppression seam use this key; revisit when V2 multi-session lands or the
 * SDK exposes session context to `execute`.
 */
export const SUPPRESS_V1_KEY = "__v1_single_session__";

const suppressionFlags = new Map<string, boolean>();

/** Write side — sendMessage handler calls this on every invocation. */
export function markSuppress(sessionKey: string): void {
  suppressionFlags.set(sessionKey, true);
}

/**
 * Read side — 6c.7's `reply_dispatch` hook calls this. Returns true if a
 * suppression was pending for this key and clears it; false otherwise.
 * Single-shot semantics: a `markSuppress` is consumed by exactly one
 * `takeSuppress`.
 */
export function takeSuppress(sessionKey: string): boolean {
  const v = suppressionFlags.get(sessionKey) ?? false;
  if (v) suppressionFlags.delete(sessionKey);
  return v;
}

/** Test-only — reset the registry between cases so they don't bleed state. */
export function _resetSuppressionForTests(): void {
  suppressionFlags.clear();
}

// ── handler ────────────────────────────────────────────────────────────────

export const sendMessage =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    const message = String(params.message ?? "");
    markSuppress(SUPPRESS_V1_KEY);
    deps.emit({
      kind: "send_message",
      namespace: deps.namespace,
      meta: { length: message.length },
    });
    return { content: [{ type: "text", text: message }] };
  };
