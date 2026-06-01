/**
 * §4.4 — flush-pressure check on `before_prompt_build`. Second handler on the
 * same event as 6c.4's prompt-section hook (multi-handler dispatch confirmed
 * in the 6c.6.0 SDK read; Mem0 reference also registers `before_prompt_build`
 * twice for separate concerns).
 *
 * **6c.6.1 scope:** trigger predicate only. Reads `SessionEntry.totalTokens`
 * (populated by prior turns' `llm_output.usage`; see API_DESIGN.md §4.7) +
 * `SessionEntry.totalTokensFresh` as the stale-snapshot guard, and logs
 * threshold trips at INFO. **No summariser call yet** — 6c.6.2 wires
 * `client.summarize` + the §4.4 trim sequence behind the same predicate.
 *
 * Why session-entry tokens, not event tokens: `PluginHookBeforePromptBuildEvent`
 * is `{prompt, messages}` — no token field. OpenClaw stores cumulative context
 * tokens on `SessionEntry` from each `llm_output.usage`; that's the canonical
 * place to read them.
 *
 * Threshold = `MESSAGE_SUMMARY_WARNING_TOKENS` (§4.4 + fork's
 * `memgpt/constants.py:20-22`). The fork derives it as
 * `int(0.75 * LLM_MAX_TOKENS)` with `LLM_MAX_TOKENS = 8000`, so the
 * load-bearing value is `6000`. Reproduced as a literal here rather than
 * imported so the plugin's threshold stays MemGPT-faithful even if a future
 * fork tweak rebases `LLM_MAX_TOKENS` for a different model class — the
 * threshold is part of MemGPT's behavioural contract (when to summarise),
 * not a runtime-configurable budget.
 *
 * Guards (reuse triggers.ts from 6c.5): non-interactive trigger and subagent
 * session both skip — same telemetry / orphaned-namespace reasoning as the
 * mirror hook. Plus: missing `ctx.sessionKey` / `ctx.agentId` skip (can't
 * address the session entry without them), and missing-entry skip (first
 * turn — no prior usage to read).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { ToolDeps } from "../tools/deps.ts";
import {
  loadSessionEntry,
  resolveFreshSessionTotalTokens,
  type AgentContext,
} from "./sessionStore.ts";
import { isNonInteractiveTrigger, isSubagentSession } from "./triggers.ts";

/**
 * MemGPT's flush threshold per `memgpt/constants.py:22`:
 *   MESSAGE_SUMMARY_WARNING_TOKENS = int(0.75 * LLM_MAX_TOKENS)   # LLM_MAX_TOKENS = 8000
 * Verbatim derived value. See module docstring for why this is a literal
 * here rather than imported.
 */
export const MESSAGE_SUMMARY_WARNING_TOKENS = 6000;

export function registerFlushPressureHook(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.on("before_prompt_build", async (_event: unknown, ctxRaw: unknown) => {
    const ctx = (ctxRaw ?? {}) as AgentContext;

    // Standard guards — same precedent as the agent_end mirror hook.
    if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return;
    if (isSubagentSession(ctx.sessionKey)) return;

    // Read the session entry — encapsulates the session-store load +
    // ctx.sessionKey / ctx.agentId presence checks + missing-entry case.
    const entry = loadSessionEntry(api, ctx);
    if (!entry) return;

    // Stale-snapshot guard — totalTokensFresh === false means the value
    // is from a prior un-rotated context. Acting on it would mis-attribute
    // a threshold trip to the current turn.
    const tokens = resolveFreshSessionTotalTokens(entry);
    if (tokens === null) {
      deps.logger.debug(
        `openclaw-memgpt: flush check skipped (stale snapshot) for sessionKey=${ctx.sessionKey}`,
      );
      return;
    }

    if (tokens < MESSAGE_SUMMARY_WARNING_TOKENS) return;

    // Above threshold + fresh + guarded. 6c.6.2 will summarise here.
    deps.logger.info(
      `openclaw-memgpt: flush threshold tripped (sessionKey=${ctx.sessionKey}, totalTokens=${tokens} >= ${MESSAGE_SUMMARY_WARNING_TOKENS})`,
    );
  });
}
