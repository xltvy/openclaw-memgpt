import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default definePluginEntry({
  id: "openclaw-memgpt",
  name: "Memory (MemGPT)",
  description:
    "MemGPT three-tier memory architecture for OpenClaw — core, archival, and recall memory via a pymemgpt sidecar.",

  register(api: OpenClawPluginApi): void {
    // Phase 6 implementation wired here.
    // Stubs for 6a sidecar, 6b shim, 6c plugin, 6d packaging follow in build order.
    api.logger.info("[openclaw-memgpt] plugin registered (skeleton)");
  },
});
