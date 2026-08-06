/**
 * End-to-end integration test for the §4.4 flush pipeline (6c.6.5).
 *
 * Exercises the full pipeline against a live sidecar:
 *
 *   1. agent_end handler estimates the buffer's tokens locally (injected
 *      per-message estimator — provider usage is never consulted), trips the
 *      threshold, calls :summarize against the live sidecar, writes flush
 *      metadata to the in-memory session store, and mirrors the packaged
 *      summary to recall (messagesAppend).
 *   2. ContextEngine.assemble() reads the metadata and returns the virtually-
 *      trimmed system-less buffer: [packagedMessage, ...messages.slice(cutoff - 1)].
 *   3. Recall search finds the packaged summary text.
 *
 * Requirements:
 *   - The sidecar must be running (started by before() below).
 *   - An LLM must be accessible via OPENAI_API_BASE (default: localhost:4000)
 *     and OPENAI_API_KEY — :summarize calls the LLM to generate the summary.
 *     Requires LiteLLM proxy at localhost:4000 and the institutional Bedrock
 *     proxy at $SHIM_UPSTREAM_URL. See CLAUDE.md 'RUNNING THE STACK' for
 *     the three-terminal recipe.
 *     Without LLM access the test is SKIPPED (not failed) so the signal
 *     stays clean. Run the full stack to exercise this path.
 *
 * The test uses an in-memory session store (same pattern as flushPressure.test.ts)
 * so the hook's metadata writes are immediately readable by assemble().
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  registerFlushPressureHook,
  MESSAGE_SUMMARY_WARNING_TOKENS,
  _setTokenEstimatorForTests,
} from "../../src/hooks/flushPressure.ts";
import {
  hasAlreadyFlushedForCurrentCompaction,
  type SessionEntry,
} from "../../src/hooks/sessionStore.ts";
import {
  makeMemgptContextEngine,
  type AgentMessage,
} from "../../src/contextEngine/memgptEngine.ts";
import { SidecarClientImpl } from "../../src/client/sidecarClient.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { PluginConfig } from "../../src/config.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { startSidecar, type SidecarHandle } from "../sidecarFixture.ts";

let sidecar: SidecarHandle;

before(
  async () => {
    sidecar = await startSidecar();
  },
  { timeout: 120_000 },
);

after(
  async () => {
    if (sidecar) await sidecar.stop();
  },
  { timeout: 30_000 },
);

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/**
 * Build a minimal mock API backed by an in-memory session store.
 * Captures both handlers registered via api.on().
 */
function buildMockApi(mockStore: Record<string, SessionEntry>): {
  api: OpenClawPluginApi;
  capturedHandlers: Record<string, Handler>;
} {
  const capturedHandlers: Record<string, Handler> = {};

  const api = {
    pluginConfig: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolvePath: (p: string) => p,
    registerTool: () => {},
    on: (event: string, h: Handler) => {
      capturedHandlers[event] = h;
    },
    registerCli: () => {},
    registerService: () => {},
    registerContextEngine: () => {},
    runtime: {
      agent: {
        session: {
          resolveStorePath: (_store?: string, _opts?: { agentId?: string }) =>
            "/mock/store/path",
          loadSessionStore: (_path: string) => mockStore,
          saveSessionStore: async (
            _path: string,
            newStore: Record<string, SessionEntry>,
          ) => {
            // Merge updates into the shared in-memory store.
            Object.assign(mockStore, newStore);
          },
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  return { api, capturedHandlers };
}

test(
  "flush pipeline end-to-end: agent_end estimates locally + summarises + writes metadata → assemble() returns trimmed buffer → recall finds summary",
  { timeout: 180_000 }, // generous timeout: sidecar startup + LLM call can take 2-3 min combined
  async (t) => {
    // ── LLM preflight: skip if the model can't actually complete ────────────
    //
    // The sidecar's :summarize route calls the LLM, so an unusable LLM turns
    // this into a misleading failure rather than an environmental skip. A
    // connection-level check (e.g. GET /health) is too weak: a proxy can answer
    // /health 200 while the model's upstream is down (observed: LiteLLM :4000 up
    // but gpt-5.4's :4100 shim refusing connections → :summarize emit_failed).
    // So we do a REAL minimal completion with the same model and skip unless it
    // returns 200 — verify the LLM works, don't optimistically assume it from a
    // reachable port (same "surface honestly, don't silently degrade" discipline
    // as the Shape A un-swallow fix). t.skip() keeps the CI signal clean.

    const apiBase =
      process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
    const apiKey = process.env.OPENAI_API_KEY ?? "sk-local-dev-only";
    let llmUsable = false;
    let preflightDetail = "";
    try {
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5.4", // same model :summarize uses (see config below)
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      llmUsable = res.ok;
      if (!res.ok) {
        preflightDetail = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      }
    } catch (err) {
      preflightDetail = err instanceof Error ? err.message : String(err);
    }
    if (!llmUsable) {
      t.skip(
        `summarisation LLM can't complete (model gpt-5.4) — ${preflightDetail}. ` +
          `See CLAUDE.md 'RUNNING THE STACK' (LiteLLM :4000 + the proxy shim :4100 ` +
          `must both be up, sourcing ~/.secrets).`,
      );
      return;
    }

    // ── Setup ───────────────────────────────────────────────────────────────

    const namespace = `flush-e2e-${randomBytes(4).toString("hex")}`;
    const SESSION_KEY = "agent:main:main";

    const config: PluginConfig = {
      namespace,
      model: "gpt-5.4", // model name as registered in litellm_config.yaml
      persona: "You are a helpful AI assistant with MemGPT memory.",
      human: "A test user interacting with the assistant.",
      observability: "off",
    };
    const client = new SidecarClientImpl(config, () =>
      Promise.resolve(sidecar.baseUrl),
    );

    // In-memory session store — shared between the mock API and assertions.
    const mockStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: { compactionCount: 0 },
    };

    const emitted: MemoryEvent[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const deps: ToolDeps = {
      client,
      namespace,
      emit: (e: MemoryEvent) => emitted.push(e),
      logger,
    };

    const { api, capturedHandlers } = buildMockApi(mockStore);

    // Inject a deterministic per-message estimator that puts the 7-message
    // buffer above the absolute fallback threshold (no contextTokenBudget in
    // ctx below → threshold = MESSAGE_SUMMARY_WARNING_TOKENS). The real
    // messages here are short; production reaches this via the SDK's
    // estimateTokens over a genuinely large buffer.
    _setTokenEstimatorForTests(
      () => Math.ceil(MESSAGE_SUMMARY_WARNING_TOKENS / 7) + 100,
    );
    registerFlushPressureHook(api, deps);

    const agentEndHandler = capturedHandlers["agent_end"];
    assert.ok(agentEndHandler, "agent_end handler should be registered");

    // ── 1. Ensure agent in sidecar ───────────────────────────────────────────

    const ensureResult = await client.ensure();
    assert.equal(ensureResult.via, "create");

    // ── 2. Pre-populate sidecar to build up pm.all_messages ─────────────────
    //
    // getStats() inside agent_end returns len(pm.all_messages). Pre-seeding
    // gives the summariser a realistic total_message_count so the preamble
    // template shows sensible numbers.

    const seedMessages = [
      { role: "user" as const, content: "Tell me about the Eiffel Tower." },
      {
        role: "assistant" as const,
        content: "The Eiffel Tower is a landmark in Paris, France.",
      },
      { role: "user" as const, content: "How tall is it?" },
      {
        role: "assistant" as const,
        content: "The Eiffel Tower is approximately 330 meters tall.",
      },
    ];
    await client.messagesAppend(seedMessages);

    // ── 3. Build event.messages (OpenClaw modern format) ────────────────────
    //
    // Must have ≥ 5 messages so select_cutoff produces a valid cutoff (smaller
    // buffers cause a 422 → BufferTooSmallError, treated as no-op per §2.8).
    // Including a system message at [0] mirrors the real OpenClaw buffer shape.

    // System-less — the production shape OpenClaw passes (it injects the system prompt
    // separately via promptBuilder; the session buffer begins with the first user
    // message). The sidecar prepends agent.system internally for select_cutoff (1.0.1).
    const eventMessages = [
      { role: "user", content: "Tell me about the Eiffel Tower." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc1",
            type: "function",
            function: {
              name: "archival_memory_search",
              arguments: '{"query":"Eiffel Tower"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "No results found.",
        tool_call_id: "tc1",
        name: "archival_memory_search",
      },
      {
        role: "assistant",
        content:
          "I searched my archival memory but found no specific records about the Eiffel Tower. It is a famous landmark in Paris, France.",
      },
      { role: "user", content: "How tall is it exactly?" },
      {
        role: "assistant",
        content:
          "The Eiffel Tower is approximately 330 meters (1083 feet) tall.",
      },
      {
        role: "user",
        content: "Please store that height in your memory for future reference.",
      },
    ];

    // ── 4. Fire agent_end — local estimate trips → summarise + metadata write
    //      + recall mirror. No usage anywhere on the event: the trigger is
    //      provider-independent.

    await agentEndHandler(
      { success: true, messages: eventMessages },
      { trigger: "user", sessionKey: SESSION_KEY, agentId: namespace },
    );

    // ── 5. Assert pipeline completed: events + session store metadata ─────────

    const emittedKinds = emitted.map((e) => e.kind);
    assert.ok(
      emittedKinds.includes("summarisation_succeeded"),
      `pipeline requires LLM access; expected summarisation_succeeded event but got: ${JSON.stringify(emittedKinds)}. ` +
        `Check that OPENAI_API_KEY / OPENAI_API_BASE are set in the environment.`,
    );
    assert.ok(
      emittedKinds.includes("flush_applied"),
      `expected flush_applied event (recall mirror step); got: ${JSON.stringify(emittedKinds)}`,
    );

    const entry = mockStore[SESSION_KEY];
    assert.ok(
      typeof entry.memoryFlushAt === "number",
      "memoryFlushAt should be a number timestamp",
    );
    assert.ok(
      typeof entry.memoryFlushCutoff === "number",
      `memoryFlushCutoff should be set; entry keys: ${Object.keys(entry).join(", ")}`,
    );
    assert.ok(
      entry.memoryFlushPackagedMessageJson,
      "memoryFlushPackagedMessageJson should be set",
    );
    assert.ok(
      hasAlreadyFlushedForCurrentCompaction(entry),
      "hasAlreadyFlushedForCurrentCompaction should return true after flush",
    );

    const cutoff = entry.memoryFlushCutoff!;

    // ── 6. assemble() returns the virtually-trimmed buffer ───────────────────

    const engine = await makeMemgptContextEngine(deps, api)();
    const result = await engine.assemble({
      sessionId: namespace,
      sessionKey: SESSION_KEY,
      messages: eventMessages as AgentMessage[],
    });

    // Shape (1.0.1 system-less): [packagedMessage, ...messages.slice(cutoff - 1)]
    // cutoff is native-space (sidecar prepended a system message before select_cutoff),
    // so the tail starts at cutoff - 1 on this system-less buffer. No system anchor —
    // OpenClaw injects the system prompt separately.
    // Total length: 1 (packed) + (eventMessages.length - (cutoff - 1))
    assert.equal(
      result.messages.length,
      1 + (eventMessages.length - (cutoff - 1)),
      `expected ${1 + (eventMessages.length - (cutoff - 1))} messages (1 packed + ${eventMessages.length - (cutoff - 1)} tail); got ${result.messages.length}`,
    );

    // messages[0]: packagedMessage (role: user, content: the preamble + summary). No anchor.
    assert.equal(
      result.messages[0].role,
      "user",
      "messages[0] should be the packagedMessage (role: user) — no system anchor",
    );
    assert.ok(
      typeof result.messages[0].content === "string" &&
        (result.messages[0].content as string).length > 0,
      "packagedMessage content should be a non-empty string",
    );

    // messages[1:]: post-cutoff tail from the original buffer (native-space cutoff → cutoff-1)
    assert.deepStrictEqual(
      result.messages.slice(1),
      (eventMessages as AgentMessage[]).slice(cutoff - 1),
      "tail should be messages.slice(cutoff - 1) verbatim",
    );

    // estimatedTokens reflects the trimmed buffer (char-count / 4 heuristic)
    assert.ok(
      result.estimatedTokens > 0,
      "estimatedTokens should be positive",
    );

    // ── 7. Recall search finds the packaged summary ──────────────────────────
    //
    // The agent_end handler called messagesAppend([packagedMessage]) which put
    // the summary text into pm.all_messages with role="user". text_search
    // searches user/assistant content, so the summary is findable.
    //
    // Search for "summary" which is part of MemGPT's verbatim preamble template
    // ("the following is a summary of the previous N messages").

    const recall = await client.recallSearch("summary");
    assert.ok(
      recall.total >= 1,
      `expected recall to find the packaged summary via 'summary' substring search; got total=${recall.total}`,
    );
  },
);
