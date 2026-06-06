/**
 * §4.5 — `agent_end` hook. Mirrors the completed turn's messages into the
 * sidecar's recall log + flushes all three tiers to disk.
 *
 * The §4.5 declared deviation: mirroring is **per-turn, not per-message**.
 * Native MemGPT's `append_to_messages` fires per message mid-turn, so
 * within-turn `conversation_search` can find an earlier same-turn message.
 * Here the turn's messages land in `pm.all_messages` atomically at turn end
 * — within-turn recall of same-turn messages is unavailable. Cross-session
 * recall (the property Persival tests) is unaffected because `agent_end`
 * fires well before the next session. The gap is documented in §4.5 as the
 * first suspect if V1 A≈C diverges on the memory-tier-reasoning dimension.
 *
 * Wired via `api.on("agent_end")`, NOT via `MemoryCapabilityConfig.runtime`
 * — the `.d.ts` declares runtime as a plain key/value bag with no declared
 * function-shape, and the reference plugin (Mem0) doesn't use it (§4.5,
 * S0.1 confirmed).
 *
 * **Order is correctness, not aesthetics: mirror FIRST, save SECOND.**
 * Reverse the order and the just-finished turn's messages aren't yet in
 * `pm.all_messages` when the pickle is written (`:save` reads in-memory
 * state), so they'd be missing from the next session's reload. Data
 * integrity, not stylistic preference.
 *
 * **§3.7 normalisation boundary is first consumed here.** OpenClaw-shape
 * messages (`tool_calls` / `tool` role) are converted to pymemgpt v0
 * (`function_call` / `function` role) before they hit the client. The
 * client remains pure transport; if a future implementer is tempted to
 * "consolidate" normalise into the client, the §3.7 contract breaks (the
 * client becomes shape-aware). The hook is the place; don't move it.
 *
 * **Error asymmetry** — both ops can fail, but with different
 * recoverabilities, so they get different propagation:
 *
 *   - Mirror failure → re-throw + emit `emit_failed`. The messages-not-in-
 *     recall state compounds across turns (lost forever from recall);
 *     surfacing the failure forces the caller / operator to address it.
 *
 *   - Save failure → swallow + emit `emit_failed`. The in-memory state has
 *     the messages already (mirror succeeded); next turn's save catches
 *     up, so failing the turn over a transient disk hiccup would be a
 *     worse outcome than a delayed flush.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { normaliseMessages, type OpenClawMessage } from "../normalise.ts";
import type { ToolDeps } from "../tools/deps.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/** Untyped event/ctx shapes — OpenClaw SDK exposes `any` on api.on. */
interface AgentEndEvent {
  success?: boolean;
  messages?: OpenClawMessage[];
  [key: string]: unknown;
}

interface AgentEndCtx {
  trigger?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export function registerAgentEndHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on("agent_end", async (event: AgentEndEvent, ctx: AgentEndCtx) => {
    // §6.1 lifecycle — if the sidecar died, skip mirror+save entirely. The
    // previous turn's save (if any) is the last good on-disk state; trying
    // to mirror to a dead sidecar would only produce a noisy error.
    if (deps.lifecycle?.isDead) {
      deps.logger.warn(
        "openclaw-memgpt: skipping mirror+save — sidecar dead",
      );
      return;
    }

    // ── Guards (§2.3 / §4.5) — skip turns that shouldn't trigger
    // persistence. Wrapped defensively because a ctx shape mismatch
    // shouldn't break the hook; we just skip.
    try {
      if (!event?.success) return;
      if (!event?.messages?.length) return;
      if (isNonInteractiveTrigger(ctx?.trigger, ctx?.sessionKey)) return;
      if (isSubagentSession(ctx?.sessionKey)) return;
    } catch (err) {
      deps.logger.error(
        `openclaw-memgpt: agent_end guards threw: ${stringifyError(err)}`,
      );
      return;
    }

    // ── Step 1 — mirror (correctness; propagates on failure).
    // §3.7 normalisation boundary: OpenClaw modern-tools-API → pymemgpt v0
    // exactly here, exactly once.
    let v0Messages;
    try {
      v0Messages = normaliseMessages(event.messages!);
      await deps.client.messagesAppend(v0Messages);
      deps.emit({
        kind: "messages_mirrored",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: { count: v0Messages.length },
      });
    } catch (err) {
      deps.logger.error(
        `openclaw-memgpt: messagesAppend failed: ${stringifyError(err)}`,
      );
      deps.emit({
        kind: "emit_failed",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: {
          operation: "messagesAppend",
          reason: stringifyError(err),
        },
      });
      throw err;
    }

    // ── Step 2 — save (recoverable; log but don't propagate).
    // Mirror succeeded, so the in-memory state has the messages already.
    // A transient :save failure means the disk is one turn stale — the
    // next turn's save will catch up. Failing the turn over a transient
    // disk hiccup is the worse outcome.
    try {
      await deps.client.save();
      deps.emit({
        kind: "agent_saved",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      deps.logger.error(
        `openclaw-memgpt: save failed: ${stringifyError(err)}`,
      );
      deps.emit({
        kind: "emit_failed",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: { operation: "save", reason: stringifyError(err) },
      });
    }
  });
}

/** Normalise an unknown error to a string for log + emit payloads. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
