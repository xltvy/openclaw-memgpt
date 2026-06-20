/**
 * §4.2 — `before_prompt_build` hook. The first event hook the plugin wires.
 *
 * Each turn, the plugin contributes MemGPT's prompt section (adapted base
 * prompt + persona/human/counts/timestamp from the sidecar's
 * `GET /agents/{id}/system_prompt_section`) **additively** — it prepends to
 * OpenClaw's prompt, never replacing the host's own system prompt or the
 * message list. Wired via `api.on("before_prompt_build", ...)`, NOT via the
 * `MemoryCapabilityConfig.promptBuilder` slot (which belongs to OpenClaw's
 * corpus subsystem per §4.8 — different mechanism, confirmed in S0.2).
 *
 * Two steps per turn, in order:
 *
 *   1. `ensure` — per-turn invocation for the `via` observability signal.
 *      This is NOT a correctness call (the client's doInit already
 *      guaranteed the agent exists at plugin init); the per-turn ensure
 *      surfaces unexpected residency changes — e.g. a sidecar restart
 *      between turns shows as `via:"load"` instead of the expected
 *      `via:"resident"`, which observability consumers (§6.2) care
 *      about. **Failures are telemetry-lossy by design** — logged + emitted
 *      as `emit_failed`, then swallowed so a sidecar restart doesn't fail
 *      the user's turn. (§4.2: "Telemetry can be lossy, so failures here
 *      are logged + emitted as `emit_failed` events but do not block the
 *      turn.")
 *
 *   2. `getSystemPromptSection` — the correctness path. **Failures
 *      propagate** because the prompt section is load-bearing (persona /
 *      human / counts) and silently degrading would leave the agent with
 *      a corrupted prompt that's worse than a failed turn.
 *
 * Return shape — `{prependSystemContext, prependContext}`:
 *
 *   - `prependSystemContext`: the static block (the adapted base system
 *     prompt). It changes only when the preset or pymemgpt version changes,
 *     so OpenClaw can cache it across turns. We fetch each turn anyway
 *     because the fetch is localhost and cheap (§4.2), and caching
 *     invalidation is complexity without measurable gain at this layer.
 *
 *   - `prependContext`: the dynamic block (persona / human / counts /
 *     timestamp). Changes on core-memory edits and per-turn for the
 *     timestamp. This is NOT the Mem0-style "auto-recalled memories"
 *     use of `prependContext` (§4.2 contrast) — MemGPT's retrieval is
 *     agent-driven via tool calls, not host-injected. Here we're using
 *     `prependContext` for MemGPT's standard dynamic prompt section.
 */

import fs from "node:fs/promises";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";
import { loadSessionEntry, type AgentContext } from "./sessionStore.ts";

interface PromptSectionContribution {
  prependSystemContext: string;
  prependContext?: string;
}

/**
 * Remove the trailing synthetic empty assistant message that OpenClaw writes
 * after `reply_dispatch` claims the turn (§4.3 mechanism). This message has
 * `content: []` and zero token usage — it's a session-close record, not a
 * real LLM response. Its presence at the end of the JSONL causes the next
 * turn to record as "abandoned" even when the tool (send_message) delivered
 * the response correctly. Removing it before each turn avoids that false
 * positive and keeps the session in a clean state for context-building.
 *
 * Operates on the JSONL at `before_prompt_build` time — after the previous
 * turn is fully written and before the new session manager opens the file.
 */
async function repairTrailingEmptyAssistant(
  sessionFile: string,
  logger: ToolDeps["logger"],
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf-8");
  } catch {
    return; // file not yet created (first turn)
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;

  let last: Record<string, unknown>;
  try {
    last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  } catch {
    return;
  }

  // Identify the synthetic empty-content, zero-usage, stopReason=stop assistant message.
  const msg = last?.message as Record<string, unknown> | undefined;
  if (
    last?.type !== "message" ||
    msg?.role !== "assistant" ||
    !Array.isArray(msg?.content) ||
    (msg.content as unknown[]).length !== 0 ||
    msg?.stopReason !== "stop"
  ) {
    return;
  }

  // Verify it's genuinely zero-usage (not just a fast model with tiny output).
  const usage = msg?.usage as Record<string, number> | undefined;
  const totalUsage =
    (usage?.input ?? 0) +
    (usage?.output ?? 0) +
    (usage?.cacheRead ?? 0) +
    (usage?.cacheWrite ?? 0);
  if (totalUsage !== 0) return;

  // Remove the last line.
  await fs.writeFile(
    sessionFile,
    lines.slice(0, -1).join("\n") + "\n",
    "utf-8",
  );
  logger.debug(
    `openclaw-memgpt: repaired trailing synthetic assistant in ${sessionFile}`,
  );
}

export function registerPromptSectionHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on("before_prompt_build", async (_event, ctx) => {
    // §6d.6 config gate — contribute nothing (silently) when unconfigured. The
    // register-time notice already told the user to run setup; no per-turn log.
    if (deps.lifecycle?.isConfigured === false) {
      return { prependSystemContext: "" };
    }
    // §6.1 lifecycle — if the sidecar died, return an empty contribution and
    // log once per turn. Letting the turn proceed without a MemGPT prompt
    // section is the lesser harm vs throwing here (which would block every
    // turn until restart).
    if (deps.lifecycle?.isDead) {
      deps.logger.warn(
        "openclaw-memgpt: skipping prompt section — sidecar dead",
      );
      return { prependSystemContext: "" };
    }

    // Repair trailing synthetic empty assistant left by reply_dispatch §4.3.
    const entry = loadSessionEntry(api, ctx as AgentContext);
    if (entry?.sessionFile) {
      await repairTrailingEmptyAssistant(entry.sessionFile, deps.logger).catch(
        (err: unknown) =>
          deps.logger.warn(
            `openclaw-memgpt: session repair failed: ${stringifyError(err)}`,
          ),
      );
    }

    // Step 1 — per-turn ensure for `via` observability. Failures are
    // telemetry-lossy: logged + emitted but swallowed (§4.2).
    try {
      const ensured = await deps.client.ensure();
      deps.emit({
        kind: "agent_ensured",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: { via: ensured.via },
      });
    } catch (err) {
      deps.logger.warn(
        `openclaw-memgpt: agent_ensured emit failed: ${stringifyError(err)}`,
      );
      deps.emit({
        kind: "emit_failed",
        namespace: deps.namespace,
        ts: new Date().toISOString(),
        meta: { operation: "ensure", reason: stringifyError(err) },
      });
    }

    // Step 2 — fetch the system prompt section. Correctness path: failures
    // propagate so OpenClaw sees them rather than the user getting a turn
    // with a corrupted (or missing) MemGPT prompt section.
    let section;
    try {
      section = await deps.client.getSystemPromptSection();
    } catch (err) {
      deps.logger.error(
        `openclaw-memgpt: getSystemPromptSection failed: ${stringifyError(err)}`,
      );
      throw err;
    }

    const contribution: PromptSectionContribution = {
      prependSystemContext: section.static,
    };
    if (section.dynamic !== undefined && section.dynamic !== null) {
      contribution.prependContext = section.dynamic;
    }
    return contribution;
  });
}

/** Normalise an unknown error to a string for log + emit payloads. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
