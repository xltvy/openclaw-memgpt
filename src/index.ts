/**
 * openclaw-memgpt — MemGPT three-tier memory architecture for OpenClaw
 * via a pymemgpt FastAPI sidecar (Shape B; API_DESIGN.md §1, §3.8).
 *
 * 6c.4 wiring: parse config → construct sidecar client → build ToolDeps →
 * register the seven tools → register the `before_prompt_build` hook.
 * Remaining hooks (6c.5–6c.7) and lifecycle (6c.8 / 6d) still deferred.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { parseConfig } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import { SidecarClientImpl } from "./client/sidecarClient.ts";
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

    api.logger.info(
      `openclaw-memgpt: 7 tools + before_prompt_build hook registered (namespace: ${config.namespace}, observability: ${config.observability})`,
    );
  },
});

export default memgptPlugin;
