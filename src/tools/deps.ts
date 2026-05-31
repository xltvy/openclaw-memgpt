/**
 * ToolDeps bag + builder per §3.6.
 *
 * Every tool handler closes over a ToolDeps instance — uniform dependency
 * surface across the seven tools. The bag exists so the handlers stay
 * pure-of-`api`: they call `deps.client.*`, emit through `deps.emit`, log
 * through `deps.logger`. Test mocking is straightforward because the
 * handler factory takes deps as its only argument.
 *
 * - `client`     — the shared SidecarClient (§3.4). Single instance per
 *                  plugin; the same instance backs hooks and lifecycle.
 * - `namespace`  — value, not resolver, because v1 is single-namespace per
 *                  plugin (§3.1). Resolver-shape is the v2 extension point.
 * - `emit`       — level-aware MemoryEvent emitter (§6.2). At 6c.3 this is
 *                  a no-op; 6d wires the real level-gated emitter.
 * - `logger`     — `api.logger`, the OpenClaw plugin logger. Direct re-export
 *                  rather than wrapping — handlers shouldn't invent a new
 *                  logging shape.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { PluginConfig } from "../config.ts";
import type { SidecarClient } from "../client/sidecarClient.ts";

// ============================================================================
// MemoryEvent — observability surface for §6.2
// ============================================================================

/**
 * Event shape the tool handlers + hooks emit. `kind` is the operation name
 * (e.g. "archival_search", "core_memory_append"). `meta` carries level-
 * appropriate detail; the level-gated emitter (6d) decides what to surface.
 *
 * Kept structurally open here — the §6.2 emitter owns the precise field set
 * per kind, and tool handlers just hand it whatever they have.
 */
export interface MemoryEvent {
  kind: string;
  namespace: string;
  meta?: Record<string, unknown>;
}

// ============================================================================
// ToolHandler — handler shape matching the OpenClaw `.d.ts` execute contract
// ============================================================================

/**
 * Handler signature matches the SDK's `registerTool` `definition.execute`
 * contract: `(toolCallId, params) => Promise<{content}>`. The handler factory
 * pattern is `(deps) => handler`, so each tool's file exports the factory
 * and the registration entrypoint (tools/index.ts) closes it over deps.
 */
export type ToolHandler = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  [key: string]: unknown;
}>;

// ============================================================================
// ToolDeps + builder
// ============================================================================

export type ToolLogger = OpenClawPluginApi["logger"];

export interface ToolDeps {
  client: SidecarClient;
  namespace: string;
  emit: (event: MemoryEvent) => void;
  logger: ToolLogger;
}

/**
 * Build a ToolDeps from the plugin entry's pieces. The `emit` stub is a
 * deliberate no-op until 6d wires the §6.2 level-gated emitter; until then
 * the observability stream is silent rather than emitting unstructured logs
 * the experiment harness can't aggregate.
 */
export function makeToolDeps(
  client: SidecarClient,
  config: PluginConfig,
  api: OpenClawPluginApi,
): ToolDeps {
  return {
    client,
    namespace: config.namespace,
    emit: () => {
      /* 6d wires the level-gated emitter; no-op until then. */
    },
    logger: api.logger,
  };
}
