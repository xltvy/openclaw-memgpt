/**
 * openclaw-memgpt — MemGPT three-tier memory architecture for OpenClaw
 * via a pymemgpt FastAPI sidecar (Shape B; API_DESIGN.md §1, §3.8).
 *
 * 6c.6.4 wiring: parse config → construct sidecar client → build ToolDeps →
 * register the seven tools → register the `before_prompt_build` prompt-
 * section hook → register the `before_prompt_build` flush-pressure hook
 * (predicate + :summarize + flush metadata write) → register the
 * `agent_end` hook (mirror + save) → register ContextEngine (virtual-trim
 * path consuming flush metadata on the next turn). 6c.7 reply_dispatch +
 * lifecycle (6c.8 / 6d) still deferred.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { parseConfig } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import { SidecarClientImpl } from "./client/sidecarClient.ts";
import { makeMemgptContextEngine } from "./contextEngine/memgptEngine.ts";
import { registerFlushPressureHook } from "./hooks/flushPressure.ts";
import { registerAgentEndHook } from "./hooks/mirror.ts";
import { registerPromptSectionHook } from "./hooks/promptSection.ts";
import { makeToolDeps } from "./tools/deps.ts";
import { registerTools } from "./tools/index.ts";

/** Sidecar default — matches sidecar/settings.py (OPENCLAW_MEMGPT_PORT default 8765). */
const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";

/**
 * 6c.0 stub. The real resolver — env override, spawn-via-uv, port allocation —
 * lands in 6d with the lifecycle layer (§6.1). Keeping the injection point in
 * place now so the client surface doesn't change when lifecycle wires in.
 */
function stubResolveBaseUrl(config: PluginConfig): () => Promise<string> {
  return async () =>
    config.sidecarUrl ??
    process.env.OPENCLAW_MEMGPT_SIDECAR_URL ??
    DEFAULT_SIDECAR_URL;
}

const memgptPlugin = definePluginEntry({
  id: "openclaw-memgpt",
  name: "Memory (MemGPT)",
  description:
    "MemGPT three-tier memory architecture for OpenClaw — core, archival, and recall memory via a pymemgpt sidecar.",

  register(api: OpenClawPluginApi): void {
    const config = parseConfig(api);
    const client = new SidecarClientImpl(config, stubResolveBaseUrl(config));
    const deps = makeToolDeps(client, config, api);

    registerTools(api, deps);
    registerPromptSectionHook(api, deps);
    registerFlushPressureHook(api, deps);
    registerAgentEndHook(api, deps);

    // Register the ContextEngine — exclusive slot; only one active at a time.
    // api.registerContextEngine is on OpenClawPluginApi via the index-signature
    // slot (confirmed from the installed SDK types.d.ts).
    (api as unknown as { registerContextEngine(id: string, factory: unknown): void })
      .registerContextEngine("memgpt", makeMemgptContextEngine(deps, api));

    api.logger.info(
      `openclaw-memgpt: 7 tools + before_prompt_build (prompt-section + flush-pressure) + agent_end hooks + ContextEngine registered (namespace: ${config.namespace}, observability: ${config.observability})`,
    );
  },
});

export default memgptPlugin;
