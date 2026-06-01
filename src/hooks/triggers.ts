/**
 * Trigger / session guards — adapted verbatim-in-shape from the @mem0/openclaw-mem0
 * reference (`mem0/openclaw/isolation.ts`, the two guard helpers; the
 * per-agent userId-routing helpers there are not adapted — single namespace
 * per plugin per §3.1).
 *
 * Used by the `agent_end` hook (6c.5) to skip turns that shouldn't trigger
 * persistence:
 *
 *   - Non-interactive triggers (cron / heartbeat / automation): the prompts
 *     are system-initiated; mirroring them would pollute the recall corpus
 *     with content the user never saw.
 *
 *   - Subagent sessions: subagents' ephemeral UUIDs create orphaned
 *     namespaces that are never read again; the parent agent's `agent_end`
 *     captures the consolidated result including subagent output, so per-
 *     subagent mirroring is wasted I/O on data that won't be queried.
 *
 * The OpenClaw SDK currently exposes `ctx.trigger` and `ctx.sessionKey` as
 * untyped (`any` on `api.on`); these helpers treat both as optional strings
 * and degrade safely on undefined.
 */

/**
 * Triggers that should NOT run the mirror/save persistence hook. Lower-case
 * comparison so a host that capitalises differently doesn't slip through.
 */
const SKIP_TRIGGERS = new Set([
  "cron",
  "heartbeat",
  "automation",
  "schedule",
]);

/**
 * Returns true if the session trigger is non-interactive and the agent_end
 * hook should skip persistence.
 *
 * Trigger-field check first; sessionKey-pattern fallback for hosts that
 * don't populate the trigger field but encode the same intent in the key.
 */
export function isNonInteractiveTrigger(
  trigger: string | undefined,
  sessionKey: string | undefined,
): boolean {
  if (trigger && SKIP_TRIGGERS.has(trigger.toLowerCase())) return true;

  if (sessionKey) {
    if (/:cron:/i.test(sessionKey)) return true;
    if (/:heartbeat:/i.test(sessionKey)) return true;
  }

  return false;
}

/**
 * Returns true if the session key indicates a subagent session
 * (OpenClaw subagent keys carry `:subagent:` in their path).
 */
export function isSubagentSession(
  sessionKey: string | undefined,
): boolean {
  if (!sessionKey) return false;
  return /:subagent:/i.test(sessionKey);
}
