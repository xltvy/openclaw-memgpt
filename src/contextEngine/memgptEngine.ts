/**
 * §4.4 — MemGPT ContextEngine: consume flush metadata to return a
 * virtually-trimmed message buffer on turns following a :summarize flush.
 *
 * SDK contract (confirmed by reading the installed OpenClaw SDK at
 * /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/context-engine/):
 *
 *   api.registerContextEngine(id, factory)
 *     factory: () => ContextEngine | Promise<ContextEngine>
 *     — receives nothing; constructs and returns a new engine instance
 *     — id is an exclusive slot; only one context engine is active at a time
 *     — registration is via the index-signature slot on OpenClawPluginApi
 *       (the openclaw-plugin-sdk.d.ts stub's `[key: string]: unknown` covers it)
 *
 *   assemble(params: {
 *     sessionId: string;          — the agent/session instance ID (maps to agentId
 *                                   for resolveStorePath — same concept here)
 *     sessionKey?: string;        — session store lookup key (same as hook ctx.sessionKey)
 *     messages: AgentMessage[];   — full OpenClaw message buffer (NOT PyMemGPT v0;
 *                                   no normalisation needed — assemble() receives the
 *                                   buffer as-is and returns a subset of it)
 *     tokenBudget?: number;       — optional capacity hint (not used; kept for interface)
 *     availableTools?, citationsMode?, model?, prompt?
 *   }) → { messages: AgentMessage[]; estimatedTokens: number }
 *
 *   ownsCompaction: false — declared on info: ContextEngineInfo.
 *     OpenClaw will not delegate compaction to this engine. compact() is required
 *     by the interface but unreachable in practice when ownsCompaction is false.
 *     MemGPT's compaction fires via the agent_end flush-pressure hook instead.
 *
 *   estimatedTokens: no SDK token-counting utility is exposed to plugins at the
 *     context-engine registration surface. We use a character-count heuristic
 *     (total chars / 4) as a reasonable approximation for OpenClaw's capacity-
 *     tracking signal. The sidecar uses tiktoken for the authoritative count but
 *     that would require an HTTP round-trip here.
 *
 *   AgentMessage: defined locally as a minimal structural alias. The real type is
 *     `AgentMessage` from `@mariozechner/pi-agent-core` (transitive dep of openclaw);
 *     we do not list it as an explicit dep to avoid version skew. The local alias
 *     is structurally compatible — { role: string; content: unknown; [key]: unknown }
 *     accepts any user/assistant/tool-result message shape.
 *
 *   ingest(): no-op (returns { ingested: false }). The agent_end mirror hook handles
 *     message persistence into the sidecar's recall corpus; a second write from
 *     the context engine would duplicate the mirror.
 *
 *   compact(): returns { ok: false, compacted: false } — ownsCompaction is false,
 *     so this method is unreachable in normal operation. Implemented to satisfy
 *     the ContextEngine interface contract.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ToolDeps } from "../tools/deps.ts";
import {
  hasAlreadyFlushedForCurrentCompaction,
  loadSessionEntry,
} from "../hooks/sessionStore.ts";

// ── Local structural types ───────────────────────────────────────────────────

/**
 * Minimal structural alias for AgentMessage (@mariozechner/pi-agent-core).
 * Covers user / assistant / tool-result messages; index signature passes
 * unknown fields (timestamp, usage, etc.) without type errors.
 */
export interface AgentMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
}

interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
}

interface ContextEngine {
  readonly info: ContextEngineInfo;
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<{ ingested: boolean }>;
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    [key: string]: unknown;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    [key: string]: unknown;
  }): Promise<CompactResult>;
}

export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: sum of message content character lengths divided by 4.
 * No SDK utility is exposed for exact token counting at the plugin surface.
 * Feeds OpenClaw's capacity-tracking signal; not used for compaction gating.
 */
function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (msg.content != null) {
      chars += JSON.stringify(msg.content).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Deserialise `memoryFlushPackagedMessageJson` → AgentMessage.
 *
 * The sidecar wrote `JSON.stringify({ role: "user", content: string })` — the
 * packagedMessage preamble from `package_summarize_message`. We add `timestamp`
 * to satisfy the pi-agent-core UserMessage structural shape.
 *
 * Throws on any shape mismatch; callers fall through to pass-through on error.
 */
function parsePackagedMessage(json: string): AgentMessage {
  const raw = JSON.parse(json) as unknown;
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as Record<string, unknown>).role !== "user" ||
    typeof (raw as Record<string, unknown>).content !== "string"
  ) {
    throw new Error(
      `unexpected packagedMessage shape: ${JSON.stringify(raw).slice(0, 80)}`,
    );
  }
  return {
    role: "user",
    content: (raw as Record<string, unknown>).content as string,
    timestamp: Date.now(),
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Factory for the MemGPT ContextEngine.
 * Pass the return value directly to `api.registerContextEngine("memgpt", ...)`.
 *
 * The factory closes over `deps` and `api` so the engine can read the session
 * store and emit log entries without exposing them as constructor arguments.
 */
export function makeMemgptContextEngine(
  deps: ToolDeps,
  api: OpenClawPluginApi,
): ContextEngineFactory {
  return (): ContextEngine => ({
    info: {
      id: "memgpt",
      name: "MemGPT",
      version: "1.0.0",
      ownsCompaction: false,
    },

    async ingest(_params) {
      // Mirror hook (agent_end) owns persistence — no second write here.
      return { ingested: false };
    },

    async assemble(params) {
      const { sessionId, sessionKey, messages } = params;

      // sessionId maps to agentId for resolveStorePath (same agent concept).
      const entry = loadSessionEntry(api, {
        agentId: sessionId,
        sessionKey: sessionKey,
      });

      // No flush metadata, or flush is stale (different compaction cycle) → pass-through.
      if (!hasAlreadyFlushedForCurrentCompaction(entry)) {
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
        };
      }

      // entry is non-null here (hasAlreadyFlushedForCurrentCompaction returns false for null).
      const { memoryFlushCutoff, memoryFlushPackagedMessageJson } = entry!;

      // Incomplete metadata → pass-through (defensive against partial session writes).
      if (
        typeof memoryFlushCutoff !== "number" ||
        !memoryFlushPackagedMessageJson
      ) {
        deps.logger.debug(
          `openclaw-memgpt: flush metadata incomplete for sessionKey=${sessionKey ?? "?"}; using pass-through`,
        );
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
        };
      }

      // Parse the packaged summary message written by the agent_end flush handler.
      let packagedMessage: AgentMessage;
      try {
        packagedMessage = parsePackagedMessage(memoryFlushPackagedMessageJson);
      } catch (err) {
        deps.logger.warn(
          `openclaw-memgpt: malformed memoryFlushPackagedMessageJson for sessionKey=${sessionKey ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          messages,
          estimatedTokens: estimateTokens(messages),
        };
      }

      // Virtual trim: [packagedSummary, ...messages.slice(cutoff)]
      // The LLM on this turn sees the trimmed context instead of the full buffer.
      const trimmed = [packagedMessage, ...messages.slice(memoryFlushCutoff)];
      deps.logger.debug(
        `openclaw-memgpt: virtual trim applied for sessionKey=${sessionKey ?? "?"}: ${messages.length} → ${trimmed.length} messages (cutoff=${memoryFlushCutoff})`,
      );
      return {
        messages: trimmed,
        estimatedTokens: estimateTokens(trimmed),
      };
    },

    async compact(_params) {
      // ownsCompaction: false — MemGPT's compaction fires via the agent_end hook.
      return {
        ok: false,
        compacted: false,
        reason:
          "MemGPT compaction is managed by the agent_end flush-pressure hook",
      };
    },
  });
}
