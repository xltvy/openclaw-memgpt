/**
 * openclaw-memgpt — MemGPT three-tier memory architecture for OpenClaw
 * via a pymemgpt FastAPI sidecar (Shape B; API_DESIGN.md §1, §3.8).
 *
 * 6c.10 wiring: parse config → construct LifecycleManager (Q5 spawn-vs-attach
 * resolver) → construct sidecar client closing over the manager's resolver →
 * build ToolDeps (carrying lifecycle so tools/hooks can short-circuit on
 * deadFlag) → register tools + hooks + ContextEngine → register the
 * `registerService({ start, stop })` pair that drives the spawn lifecycle
 * (start spawns + healthz-blocks; stop saves + SIGTERMs + SIGKILL-fallbacks).
 *
 * The previous 6c.8 teardown used a stop-only `registerService` — the SDK's
 * service runner TypErrors on the missing `start`, which silently skips the
 * stop wiring. Providing both here fixes the latent bug surfaced in 6c.10a.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { parseConfig } from "./config.ts";
import { SidecarClientImpl } from "./client/sidecarClient.ts";
import { makeMemgptContextEngine } from "./contextEngine/memgptEngine.ts";
import { registerFlushPressureHook } from "./hooks/flushPressure.ts";
import { registerAgentEndHook } from "./hooks/mirror.ts";
import { registerPromptSectionHook } from "./hooks/promptSection.ts";
import { registerReplyDispatchHook } from "./hooks/replyDispatch.ts";
import { getOrCreateLifecycle } from "./lifecycle/lifecycleManager.ts";
import { ObservabilityEmitter } from "./observability/events.ts";
import { makeToolDeps } from "./tools/deps.ts";
import { registerTools } from "./tools/index.ts";
import { resolveCredentialKey } from "./wizard/credentialStore.ts";
import { registerWizardCli } from "./wizard/cli.ts";
import { notifyIfUnconfigured } from "./wizard/detect.ts";

/**
 * Live observability bus (§6.2). Consumers attach listeners without holding the
 * plugin instance:
 *
 * ```ts
 * import { memoryEvents, MEMORY_EVENT_CHANNEL } from "openclaw-memgpt";
 * memoryEvents.on(MEMORY_EVENT_CHANNEL, (e) => …);   // every event
 * memoryEvents.on("archival_search", (e) => …);      // one kind
 * ```
 *
 * Events are already level-qualified before they reach the bus. The JSONL sink
 * under the OpenClaw state dir is the authoritative event log.
 */
export {
  memoryEvents,
  MEMORY_EVENT_CHANNEL,
  type MemoryEvent,
  type MemoryEventKind,
} from "./observability/events.ts";

const memgptPlugin = definePluginEntry({
  id: "openclaw-memgpt",
  name: "Memory (MemGPT)",
  description:
    "MemGPT three-tier memory architecture for OpenClaw — core, archival, and recall memory via a pymemgpt sidecar.",

  register(api: OpenClawPluginApi): void {
    const config = parseConfig(api);

    // §6.2 observability emitter — constructed with the level now; its JSONL
    // sink is activate()d by LifecycleManager.start once the state dir is known
    // (two-phase init). Shared by tools/hooks (via deps.emit) and lifecycle.
    const emitter = new ObservabilityEmitter(config.observability, api.logger);

    // §6d.6 — resolve the wizard-stored credential into the sidecar's LLM env
    // (OPENAI_API_KEY / OPENAI_API_BASE) at spawn time. Closes over the
    // resolved state dir supplied by LifecycleManager.start. Absent credential
    // ⇒ no contributor ⇒ sidecar inherits the shell env (pre-6d.6 behaviour).
    const credential = config.credential;
    const baseUrl = config.baseUrl;
    const credentialEnv =
      credential === undefined
        ? undefined
        : async (stateDir: string): Promise<Record<string, string>> => {
            const env: Record<string, string> = {};
            const key = await resolveCredentialKey(credential, stateDir);
            if (key !== undefined) env.OPENAI_API_KEY = key;
            if (baseUrl !== undefined) env.OPENAI_API_BASE = baseUrl;
            return env;
          };

    // Process-singleton per namespace: OpenClaw calls register() several times
    // in one process, and our backend is a spawned sidecar holding in-memory
    // resident agent state. A fresh manager per call spawned a fresh sidecar,
    // so the hook's `:ensure` and a tool call could land on different sidecars
    // → "Agent not resident". Sharing one manager (hence one sidecar) per
    // namespace fixes it; see getOrCreateLifecycle. (Clients stay per-call.)
    const lifecycle = getOrCreateLifecycle(config, api.logger, {
      emitter,
      credentialEnv,
    });

    // §6d.6 — register the `openclaw memgpt setup` wizard command and surface a
    // one-time pointer to it when the plugin is unconfigured (auto-detection;
    // see notifyIfUnconfigured for why this notifies rather than auto-launches).
    registerWizardCli(api);
    notifyIfUnconfigured(api.logger, config);

    // Resolver closure: SidecarClient calls this once in doInit (at first
    // tool/hook fire — well after registerService.start has resolved the URL).
    const client = new SidecarClientImpl(config, async () =>
      lifecycle.resolveBaseUrl(),
    );
    const deps = makeToolDeps(client, config, api, lifecycle, emitter);

    registerTools(api, deps);
    registerPromptSectionHook(api, deps);
    registerFlushPressureHook(api, deps);
    registerAgentEndHook(api, deps);
    registerReplyDispatchHook(api, deps);

    // Register the ContextEngine — exclusive slot; only one active at a time.
    // api.registerContextEngine is on OpenClawPluginApi via the index-signature
    // slot (confirmed from the installed SDK types.d.ts).
    (api as unknown as { registerContextEngine(id: string, factory: unknown): void })
      .registerContextEngine("memgpt", makeMemgptContextEngine(deps, api));

    // §6.1 lifecycle service — both start and stop wired so the SDK's
    // service runner (services-CLs267o9.js) registers our stop into `running`.
    api.registerService({
      id: "memgpt-sidecar",
      start: (ctx) => lifecycle.start(ctx),
      stop: (ctx) => lifecycle.stop(client, ctx),
    });

    api.logger.info(
      `openclaw-memgpt: 7 tools + before_prompt_build (prompt-section + flush-pressure) + agent_end + reply_dispatch hooks + ContextEngine + lifecycle service registered (namespace: ${config.namespace}, observability: ${config.observability})`,
    );
  },
});

export default memgptPlugin;
