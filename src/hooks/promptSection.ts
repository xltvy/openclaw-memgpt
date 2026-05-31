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
 *      `via:"resident"`, which the detection-rate metric (§6.2) cares
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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";

interface PromptSectionContribution {
  prependSystemContext: string;
  prependContext?: string;
}

export function registerPromptSectionHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on("before_prompt_build", async (_event, _ctx) => {
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
