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
import type { LifecycleManager } from "../lifecycle/lifecycleManager.ts";
import type { EventSink, MemoryEvent } from "../observability/events.ts";

// ============================================================================
// MemoryEvent — observability surface for §6.2
// ============================================================================

/**
 * Re-export of the §6.2 event shape, whose canonical definition lives in
 * `observability/events.ts` (the spec names that file the schema owner). Tool
 * handlers + hooks import `MemoryEvent` from here for proximity to `deps.emit`;
 * the type is the same. The §6.2 level-gated emitter (6d.5) owns which fields
 * surface at which level (metadata always; `content` at verbose).
 */
export type { MemoryEvent } from "../observability/events.ts";

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
  /**
   * §6.1 lifecycle — tools and hooks consult `lifecycle.isDead` at entry to
   * short-circuit cleanly when the sidecar has crashed (6c.10a Q4). Optional
   * at this seam so existing tests that build a deps bag by hand keep working
   * without constructing a full LifecycleManager; the entry point always
   * supplies a real one.
   */
  lifecycle?: LifecycleManager;
}

/**
 * Build a ToolDeps from the plugin entry's pieces. `emit` is bound to the
 * §6.2 level-gated emitter (6d.5) when an `emitter` is supplied; absent one
 * (hand-built test deps) it falls back to a no-op so the observability stream
 * stays silent rather than emitting unstructured noise. Tool/hook call sites
 * are unchanged — they hand the emitter whatever they have and the emitter
 * decides what surfaces at the configured level.
 */
export function makeToolDeps(
  client: SidecarClient,
  config: PluginConfig,
  api: OpenClawPluginApi,
  lifecycle?: LifecycleManager,
  emitter?: EventSink,
): ToolDeps {
  return {
    client,
    namespace: config.namespace,
    emit: emitter ? (event) => emitter.emit(event) : () => {},
    logger: api.logger,
    lifecycle,
  };
}
