/**
 * §6.3 — Plugin teardown via `registerService.stop`.
 *
 * `registerService.stop` is the only shutdown hook in the OpenClaw SDK
 * (`onShutdown` does not exist — confirmed by 6c.8a SDK read). The callback
 * fires once, awaited, on OpenClaw server shutdown. Callbacks fire in reverse
 * registration order; this is registered last so it fires first.
 *
 * **Why a final save when `agent_end` already saves per turn?**
 * `agent_end` saves at turn end (§4.5). A narrow window remains: if OpenClaw
 * exits between turns — for example during a restart cycle or OS-level shutdown
 * — the in-memory state from any turn that completed since the last save would
 * be lost. One final `client.save()` here closes that window.
 *
 * **Error handling.** The SDK warns and swallows on stop failure (6c.8a Q2,
 * `services-CLs267o9.js`). We mirror that: log the error, don't re-throw.
 * We're shutting down anyway; a failed save during shutdown is best-effort.
 *
 * **`start` is omitted.** Per-turn ensure in `before_prompt_build` handles
 * agent readiness (6c.8a Q1 — `assemble()` fires before `before_prompt_build`
 * but makes no sidecar calls; no event earlier than `before_prompt_build`
 * needs the agent to be resident).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";

export function registerTeardown(api: OpenClawPluginApi, deps: ToolDeps): void {
  api.registerService({
    id: "memgpt-sidecar",
    stop: async (_ctx) => {
      try {
        await deps.client.save();
        deps.logger.info("openclaw-memgpt: plugin teardown — final save complete");
      } catch (err) {
        deps.logger.error(
          `openclaw-memgpt: plugin teardown — final save failed: ${stringifyError(err)}`,
        );
      }
    },
  });
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
