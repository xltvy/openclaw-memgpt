/**
 * Unit tests for the §4.4 flush-pressure check.
 *
 * Two-trigger form (1.3.1 compaction-anchored fix): `before_compaction` is
 * the PRIMARY trigger — no threshold, fires when the host is about to
 * discard the buffer; messages come from the event (harness path) or the
 * agent_end buffer snapshot (embedded path, whose event carries counts
 * only). `agent_end` stays as the SECONDARY threshold trigger for sessions
 * that never compact. Its budget (1.3.2) resolves through a chain —
 * `ctx.contextTokenBudget` (CLI/Codex harnesses) → the `model_call_started`
 * per-run cache (embedded harness, consumed at agent_end) →
 * `SessionEntry.contextTokens` (tertiary; stale by one turn) — and when the
 * chain resolves nothing, agent_end DECLINES rather than guessing (the old
 * absolute-6000 fallback is documentation-only and decides nothing).
 * Provider-reported `usage` is never consulted.
 *
 * `_resetFlushStateForTests()` clears the cross-trigger module state (buffer
 * snapshots + double-fire markers) that would otherwise leak between tests.
 *
 * Estimator control: `_setTokenEstimatorForTests(fn)` injects a
 * deterministic per-message estimator. Calling it with no argument resets to
 * "not attempted", which under `node --test` (no resolvable `openclaw`
 * package) exercises the real dynamic-import-failure → local-fallback path.
 *
 * api.runtime.agent.session is mocked — a synthetic store keyed by sessionKey
 * lets each test control entry presence + values. The sidecar client is a
 * partial-mock — only methods the hook calls (summarize, getStats,
 * messagesAppend) are stubbed per test.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FLUSH_RATIO,
  MESSAGE_SUMMARY_WARNING_TOKENS,
  fallbackEstimateTokens,
  registerFlushPressureHook,
  _setTokenEstimatorForTests,
  _resetFlushStateForTests,
} from "../../src/hooks/flushPressure.ts";
import {
  hasAlreadyFlushedForCurrentCompaction,
  type SessionEntry,
} from "../../src/hooks/sessionStore.ts";
import { BufferTooSmallError } from "../../src/client/errors.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type {
  MessagesAppendResult,
  StatsResponse,
  SummarizeResult,
} from "../../src/client/types.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── fixtures ────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type LogFn = (msg: string) => void;

interface CapturedLogger {
  info: ReturnType<typeof mock.fn<LogFn>>;
  warn: ReturnType<typeof mock.fn<LogFn>>;
  error: ReturnType<typeof mock.fn<LogFn>>;
  debug: ReturnType<typeof mock.fn<LogFn>>;
}

function makeLogger(): CapturedLogger {
  const noop: LogFn = (_msg: string) => {};
  return {
    info: mock.fn(noop),
    warn: mock.fn(noop),
    error: mock.fn(noop),
    debug: mock.fn(noop),
  };
}

function makeDeps(
  logger: CapturedLogger,
  client: Partial<SidecarClient> = {},
  emitted?: MemoryEvent[],
): ToolDeps {
  return {
    client: client as SidecarClient,
    namespace: "test-ns",
    emit: (e: MemoryEvent) => {
      if (emitted) emitted.push(e);
    },
    logger,
  };
}

/**
 * Build a mock api where api.runtime.agent.session is a controllable store.
 * Captures all registered handlers by hook name.
 *
 * `loadOverride` lets tests return different values on successive calls
 * (e.g. "session vanished between predicate read and write").
 */
function makeMockApi(
  store: Record<string, SessionEntry>,
  opts?: { loadOverride?: ReturnType<typeof mock.fn> },
): {
  api: OpenClawPluginApi;
  resolveStorePath: ReturnType<typeof mock.fn>;
  loadSessionStore: ReturnType<typeof mock.fn>;
  saveSessionStore: ReturnType<typeof mock.fn>;
  capturedAgentEndHandler: () => Handler;
  capturedBeforeCompactionHandler: () => Handler;
  capturedModelCallStartedHandler: () => Handler;
} {
  const resolveStorePath = mock.fn(
    (_store?: string, _opts?: { agentId?: string }) => "/test/store/path",
  );
  const loadSessionStore =
    opts?.loadOverride ?? mock.fn((_path: string) => store);
  const saveSessionStore = mock.fn(
    async (_path: string, _s: Record<string, SessionEntry>) => {},
  );

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
    on: (event: string, handler: Handler) => {
      capturedHandlers[event] = handler;
    },
    registerCli: () => {},
    registerService: () => {},
    runtime: {
      agent: {
        session: { resolveStorePath, loadSessionStore, saveSessionStore },
      },
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    resolveStorePath,
    loadSessionStore,
    saveSessionStore,
    capturedAgentEndHandler: () => {
      const h = capturedHandlers["agent_end"];
      if (!h) throw new Error("agent_end hook not registered");
      return h;
    },
    capturedBeforeCompactionHandler: () => {
      const h = capturedHandlers["before_compaction"];
      if (!h) throw new Error("before_compaction hook not registered");
      return h;
    },
    capturedModelCallStartedHandler: () => {
      const h = capturedHandlers["model_call_started"];
      if (!h) throw new Error("model_call_started hook not registered");
      return h;
    },
  };
}

const INTERACTIVE_CTX = {
  trigger: "user",
  sessionKey: "agent:main:main",
  agentId: "main",
};

/** Standard agent_end event for the happy path (success:true + messages). */
function makeAgentEndEvent(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second" },
      { role: "assistant", content: "second reply" },
    ],
    ...overrides,
  };
}

/** Message count in makeAgentEndEvent — per-message estimators multiply by this. */
const EVENT_MESSAGE_COUNT = 5;

/**
 * Inject a per-message estimator such that the 5-message standard event sums
 * to exactly `total` tokens.
 */
function injectEstimatorTotalling(total: number): void {
  _setTokenEstimatorForTests(() => total / EVENT_MESSAGE_COUNT);
}

/** Build a successful SummarizeResult fixture. */
function makeSummarizeResult(
  overrides: Partial<SummarizeResult> = {},
): SummarizeResult {
  return {
    cutoff: 3,
    summary: "summary text",
    summaryLength: 2,
    hiddenMessageCount: 2,
    totalMessageCount: 5,
    packagedMessage: {
      role: "user",
      content: '{"type":"system_alert","message":"prior messages..."}',
    },
    ...overrides,
  };
}

/**
 * Store entry with no prior flush recorded. `contextTokens: 8000` supplies
 * the tertiary budget source (1.3.2 — agent_end declines without a budget);
 * with the default 0.75 ratio the threshold lands at 6000, preserving the
 * pre-1.3.2 arithmetic every glue test below was written against.
 */
const ABOVE_THRESHOLD_STORE: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 0, contextTokens: 8000 },
};

/** Store with a specific compactionCount for 6c.6.3 write-path tests. */
const STORE_WITH_COMPACTION_COUNT: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 2, contextTokens: 8000 },
};

/** Full happy-path client stub. */
function makeHappyClient() {
  return {
    getStats: mock.fn(
      async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
    ),
    summarize: mock.fn(
      async (): Promise<SummarizeResult> => makeSummarizeResult(),
    ),
    messagesAppend: mock.fn(
      async (): Promise<MessagesAppendResult> => ({ appended: 1 }),
    ),
  };
}

// ── 1. registration ────────────────────────────────────────────────────────

test("registerFlushPressureHook: registers model_call_started (budget feed) + before_compaction (primary) + agent_end (fallback); llm_output stays gone", () => {
  const capturedNames: string[] = [];
  const api = {
    on: (event: string, _h: Handler) => {
      capturedNames.push(event);
    },
  } as unknown as OpenClawPluginApi;
  registerFlushPressureHook(api, makeDeps(makeLogger()));
  assert.deepEqual(capturedNames, [
    "model_call_started",
    "before_compaction",
    "agent_end",
  ]);
  assert.ok(
    !capturedNames.includes("llm_output"),
    "llm_output must never be re-registered — on the embedded harness it dispatches after agent_end and would cache a stale budget",
  );
});

// ── 2. provider-independence (W7 a/b) ──────────────────────────────────────

test("large buffer + NO usage anywhere → fires via local fallback estimator (SDK import unavailable under node --test)", async () => {
  // Reset to "not attempted": the dynamic import of
  // openclaw/plugin-sdk/agent-core fails under node --test, so the hook must
  // fall back to the local chars/4 estimate — and still fire.
  _setTokenEstimatorForTests();
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // 5 messages × 8000 chars ≈ 2000 tokens each ≈ 10000 total ≥ 6000.
  const bigMessages = Array.from({ length: 5 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(8000),
  }));
  await capturedAgentEndHandler()(
    { success: true, messages: bigMessages },
    INTERACTIVE_CTX,
  );

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "summarize must fire from the local estimate with usage entirely absent",
  );
  // The import-failure fallback is announced, not silent.
  assert.ok(
    logger.warn.mock.calls.some((c) =>
      /agent-core unavailable/i.test(String(c.arguments[0])),
    ),
  );
});

test("large buffer + provider under-reports usage.total: 3 → still fires (usage is ignored)", async () => {
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client));

  // The dishonest provider report rides the event; the trigger must not read it.
  await capturedAgentEndHandler()(
    makeAgentEndEvent({ usage: { total: 3 } }),
    INTERACTIVE_CTX,
  );

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "wrong provider usage must not suppress the flush",
  );
});

test("small buffer → does not fire, regardless of what usage claims", async () => {
  injectEstimatorTotalling(500);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client));

  // Even an over-reporting provider can't trip it: local estimate rules.
  await capturedAgentEndHandler()(
    makeAgentEndEvent({ usage: { total: 999_999 } }),
    INTERACTIVE_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 0);
  assert.equal(client.getStats.mock.callCount(), 0);
});

// ── 3. threshold arithmetic (W7 d + proportional) ──────────────────────────

test("ctx budget missing → tertiary SessionEntry.contextTokens budget; floor(8000*0.75)=6000 boundary (>= trips)", async () => {
  // 5999 < 6000: no trip.
  injectEstimatorTotalling(MESSAGE_SUMMARY_WARNING_TOKENS - 1);
  let client = makeHappyClient();
  let fixture = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(fixture.api, makeDeps(makeLogger(), client));
  await fixture.capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(client.summarize.mock.callCount(), 0, "5999 must not trip");

  // exactly 6000: trips (>=, not >).
  injectEstimatorTotalling(MESSAGE_SUMMARY_WARNING_TOKENS);
  client = makeHappyClient();
  fixture = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(fixture.api, makeDeps(makeLogger(), client));
  await fixture.capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(client.summarize.mock.callCount(), 1, "6000 must trip");
});

test("contextTokenBudget present → proportional threshold budget*ratio replaces the absolute 6000", async () => {
  // budget 1000 × 0.75 = 750: an 800-token buffer trips even though ≪ 6000.
  injectEstimatorTotalling(800);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client));
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    contextTokenBudget: 1000,
  });
  assert.equal(client.summarize.mock.callCount(), 1, "800 >= 750 must trip");

  // Same buffer against a big budget: 800 < 0.75 × 65536 = 49152 — no trip.
  injectEstimatorTotalling(800);
  const client2 = makeHappyClient();
  const fixture2 = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(fixture2.api, makeDeps(makeLogger(), client2));
  await fixture2.capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    contextTokenBudget: 65_536,
  });
  assert.equal(client2.summarize.mock.callCount(), 0);
});

test("flushRatio config override changes the proportional threshold", async () => {
  // budget 10000 × ratio 0.5 = 5000: a 5200-token buffer trips under the
  // override but would not under the default 0.75 (7500).
  injectEstimatorTotalling(5200);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client), {
    flushRatio: 0.5,
  });
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    contextTokenBudget: 10_000,
  });
  assert.equal(client.summarize.mock.callCount(), 1);
});

test("DEFAULT_FLUSH_RATIO = 0.75 and MESSAGE_SUMMARY_WARNING_TOKENS = 6000 (= int(0.75 * 8000) per fork constants.py)", () => {
  assert.equal(DEFAULT_FLUSH_RATIO, 0.75);
  assert.equal(MESSAGE_SUMMARY_WARNING_TOKENS, 6000);
  // Behavioural-compat pin (acceptance 4): an 8k budget × default ratio
  // reproduces the old absolute threshold exactly.
  assert.equal(Math.floor(8000 * DEFAULT_FLUSH_RATIO), 6000);
});

test("fallbackEstimateTokens: chars/4 over string leaves, both message shapes", () => {
  assert.equal(fallbackEstimateTokens({ role: "user", content: "x".repeat(396) }), 100);
  // Content blocks + tool call arguments are counted too.
  const blocks = fallbackEstimateTokens({
    role: "assistant",
    content: [{ type: "text", text: "y".repeat(100) }],
    tool_calls: [
      { function: { name: "f", arguments: '{"q":"z"}' } },
    ],
  });
  assert.ok(blocks >= 25, `blocks estimate should count nested strings; got ${blocks}`);
});

// ── 4. observability (W6) ──────────────────────────────────────────────────

test("W6: every evaluation logs its numbers at debug — negative outcome included", async () => {
  injectEstimatorTotalling(500);
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    contextTokenBudget: 65_536,
  });

  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /flush evaluation/.test(m));
  assert.ok(evalMsg, `expected a flush-evaluation debug line; got: ${debugMsgs.join(" | ")}`);
  assert.match(evalMsg!, /estTokens=500/);
  assert.match(evalMsg!, /budget=65536/);
  assert.match(evalMsg!, /ratio=0\.75/);
  assert.match(evalMsg!, /threshold=49152/);
  assert.match(evalMsg!, /did not trip/);
  assert.equal(logger.info.mock.callCount(), 0, "negative outcome stays below info");
});

test("W6: positive evaluation logs TRIPPED at debug + 'flush threshold tripped' at info", async () => {
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /flush evaluation.*TRIPPED/.test(m)));
  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));
  assert.ok(infoMsgs.some((m) => /totalTokens=\d+/.test(m)));
});

// ── 5. agent_end guards ────────────────────────────────────────────────────

test("guard: non-interactive trigger (cron) → skips before estimation and session-store read", async () => {
  injectEstimatorTotalling(10_000);
  const { api, loadSessionStore, capturedAgentEndHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    trigger: "cron",
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.info.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0, "guarded turns emit no evaluation log");
});

test("guard: subagent session → skips before estimation and session-store read", async () => {
  injectEstimatorTotalling(10_000);
  const { api, loadSessionStore, capturedAgentEndHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    trigger: "user",
    sessionKey: "agent:main:subagent:abc-123",
    agentId: "main",
  });
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0);
});

test("guard: event.success false → skips flush entirely", async () => {
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const { api, loadSessionStore, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client));

  await capturedAgentEndHandler()(
    makeAgentEndEvent({ success: false }),
    INTERACTIVE_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 0, "failed turn must not trigger flush");
  assert.equal(loadSessionStore.mock.callCount(), 0);
});

test("empty event.messages → estimates 0 tokens; never trips", async () => {
  injectEstimatorTotalling(10_000); // irrelevant: no messages to sum over
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(
    { success: true, messages: [] },
    INTERACTIVE_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 0);
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /estTokens=0/.test(m)));
});

// ── 6. already flushed for current cycle ──────────────────────────────────

test("already flushed for current cycle → debug + skip; no summarize call", async () => {
  injectEstimatorTotalling(10_000);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      compactionCount: 3,
      memoryFlushCompactionCount: 3, // already flushed for cycle 3
      contextTokens: 8000, // budget resolvable — the cycle check must be the skip reason
    },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(client.summarize.mock.callCount(), 0);
  assert.equal(client.getStats.mock.callCount(), 0, "getStats must NOT be called either");
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /already done for current compaction cycle/i.test(m)),
    `expected already-flushed debug log; got: ${debugMsgs.join(" | ")}`,
  );
});

test("6c.6.3: hasAlreadyFlushedForCurrentCompaction helper — boundary cases", () => {
  assert.equal(hasAlreadyFlushedForCurrentCompaction(null), false, "null entry → false");
  assert.equal(hasAlreadyFlushedForCurrentCompaction(undefined), false, "undefined → false");
  assert.equal(hasAlreadyFlushedForCurrentCompaction({}), false, "no flush fields → false");
  assert.equal(
    hasAlreadyFlushedForCurrentCompaction({ compactionCount: 0, memoryFlushCompactionCount: 0 }),
    true,
    "both 0 → already flushed",
  );
  assert.equal(
    hasAlreadyFlushedForCurrentCompaction({ compactionCount: 3, memoryFlushCompactionCount: 3 }),
    true,
    "equal non-zero → already flushed",
  );
  assert.equal(
    hasAlreadyFlushedForCurrentCompaction({ compactionCount: 3, memoryFlushCompactionCount: 2 }),
    false,
    "flush behind compaction → not yet flushed",
  );
  assert.equal(
    hasAlreadyFlushedForCurrentCompaction({ memoryFlushCompactionCount: 0 }),
    true,
    "compactionCount absent (defaults to 0) + memoryFlushCompactionCount=0 → already flushed",
  );
});

// ── 7. summariser glue (6c.6.2) ────────────────────────────────────────────

test("above threshold → calls getStats then summarize; emits summarisation_succeeded with estimated totalTokens", async () => {
  injectEstimatorTotalling(6100);
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 42 }),
  );
  const summarize = mock.fn(
    async (
      _messages: unknown[],
      _count: number,
    ): Promise<SummarizeResult> => makeSummarizeResult({ cutoff: 3 }),
  );
  const messagesAppend = mock.fn(
    async (): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  // getStats called for totalMessageCount source.
  assert.equal(getStats.mock.callCount(), 1);

  // summarize called with the (normalised) event messages + stats count.
  assert.equal(summarize.mock.callCount(), 1);
  const [passedMessages, passedCount] = summarize.mock.calls[0].arguments as [
    unknown[],
    number,
  ];
  assert.equal(passedMessages.length, 5);
  assert.equal(passedCount, 42);

  // Threshold trip log + success log fire.
  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));
  assert.ok(infoMsgs.some((m) => /summarisation succeeded/i.test(m)));

  // summarisation_succeeded event carries cutoff + the LOCAL estimate.
  const success = emitted.find((e) => e.kind === "summarisation_succeeded");
  assert.ok(success, "summarisation_succeeded event should fire");
  assert.equal(success!.meta?.cutoff, 3);
  assert.equal(success!.meta?.totalTokens, 6100);
  assert.equal(success!.meta?.summaryLength, 2);
  assert.equal(typeof success!.ts, "string");
});

test("BufferTooSmallError → info-level no-op + summarisation_skipped event (§2.8 422)", async () => {
  injectEstimatorTotalling(6100);
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async (): Promise<SummarizeResult> => {
    throw new BufferTooSmallError(
      "Summarize error: less than 2 messages... wait for more messages.",
    );
  });

  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.equal(summarize.mock.callCount(), 1);

  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    infoMsgs.some((m) => /summarisation skipped.*buffer too small/i.test(m)),
    `expected buffer-too-small info log; got: ${infoMsgs.join(" | ")}`,
  );
  assert.equal(logger.error.mock.callCount(), 0, "must NOT log at error");

  const skipped = emitted.find((e) => e.kind === "summarisation_skipped");
  assert.ok(skipped, "summarisation_skipped event should fire");
  assert.equal(skipped!.meta?.reason, "buffer_too_small");
  assert.equal(skipped!.meta?.totalTokens, 6100);

  assert.ok(
    !emitted.some((e) => e.kind === "summarisation_succeeded"),
    "summarisation_succeeded must not fire on 422",
  );
});

test("generic summarize error → logs error + emits emit_failed; does NOT re-throw (recoverable next turn)", async () => {
  injectEstimatorTotalling(10_000);
  const transportErr = new Error("sidecar 500");
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async () => {
    throw transportErr;
  });

  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.equal(logger.error.mock.callCount(), 1);
  const errMsg = String(logger.error.mock.calls[0].arguments[0]);
  assert.match(errMsg, /summarise failed/i);
  assert.match(errMsg, /sidecar 500/);

  const failed = emitted.find((e) => e.kind === "emit_failed");
  assert.ok(failed, "emit_failed event should fire");
  assert.equal(failed!.meta?.operation, "summarize");
  assert.match(String(failed!.meta?.reason), /sidecar 500/);

  assert.ok(
    !emitted.some((e) => e.kind === "summarisation_succeeded"),
    "summarisation_succeeded must not fire on generic error",
  );
});

test("getStats failure → logs error + emits emit_failed; does NOT call summarize", async () => {
  injectEstimatorTotalling(10_000);
  const getStats = mock.fn(async (): Promise<StatsResponse> => {
    throw new Error("stats 503");
  });
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedAgentEndHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.equal(
    summarize.mock.callCount(),
    0,
    "summarize must NOT be called if getStats failed",
  );
  const failed = emitted.find((e) => e.kind === "emit_failed");
  assert.ok(failed);
  assert.equal(failed!.meta?.operation, "getStats");
});

// ── 8. 6c.6.3 — metadata write + recall mirror ────────────────────────────

test("6c.6.3: flush metadata written to session store on success (all five fields)", async () => {
  injectEstimatorTotalling(10_000);
  const CUTOFF = 3;
  const PACKAGED = {
    role: "user" as const,
    content: "Summary of N messages.",
  };
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 10 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> =>
      makeSummarizeResult({ cutoff: CUTOFF, packagedMessage: PACKAGED }),
  );
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, saveSessionStore, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT);
  registerFlushPressureHook(
    api,
    makeDeps(makeLogger(), { getStats, summarize, messagesAppend }),
  );

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(saveSessionStore.mock.callCount(), 1, "saveSessionStore should fire once");
  const savedStore = saveSessionStore.mock.calls[0].arguments[1] as Record<string, SessionEntry>;
  const saved = savedStore["agent:main:main"];
  assert.ok(saved, "saved entry must exist");

  assert.equal(typeof saved.memoryFlushAt, "number", "memoryFlushAt must be a ms timestamp");
  assert.ok(saved.memoryFlushAt! > 0);
  assert.equal(
    saved.memoryFlushCompactionCount,
    2,
    "memoryFlushCompactionCount must match compactionCount (= 2)",
  );
  assert.ok(saved.memoryFlushContextHash, "memoryFlushContextHash must be non-empty");
  assert.equal(typeof saved.memoryFlushContextHash, "string");
  assert.equal(saved.memoryFlushContextHash!.length, 16, "hash is 16 hex chars");

  assert.equal(saved.memoryFlushCutoff, CUTOFF, "memoryFlushCutoff must equal result.cutoff");
  assert.equal(typeof saved.memoryFlushPackagedMessageJson, "string");
  assert.deepEqual(
    JSON.parse(saved.memoryFlushPackagedMessageJson!),
    PACKAGED,
    "memoryFlushPackagedMessageJson must round-trip the packagedMessage",
  );
  assert.equal(saved.compactionCount, 2, "compactionCount must be unchanged");
});

test("6c.6.3: recall mirror is called after metadata write; flush_applied event fires", async () => {
  injectEstimatorTotalling(10_000);
  const callOrder: string[] = [];
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult({ cutoff: 3 }),
  );
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => {
      callOrder.push("messagesAppend");
      return { appended: 1 };
    },
  );
  const saveSessionStoreMock = mock.fn(
    async (_path: string, _s: Record<string, SessionEntry>) => {
      callOrder.push("saveSessionStore");
    },
  );
  const loadSessionStoreMock = mock.fn(
    (_path: string) => STORE_WITH_COMPACTION_COUNT,
  );

  const { api, capturedAgentEndHandler } = makeMockApi(
    STORE_WITH_COMPACTION_COUNT,
    { loadOverride: loadSessionStoreMock },
  );
  (api as unknown as { runtime: { agent: { session: { saveSessionStore: unknown } } } })
    .runtime.agent.session.saveSessionStore = saveSessionStoreMock;

  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(makeLogger(), { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  // Metadata write before mirror.
  assert.ok(
    callOrder.indexOf("saveSessionStore") < callOrder.indexOf("messagesAppend"),
    `saveSessionStore (${callOrder.indexOf("saveSessionStore")}) must precede messagesAppend (${callOrder.indexOf("messagesAppend")})`,
  );

  const applied = emitted.find((e) => e.kind === "flush_applied");
  assert.ok(applied, "flush_applied event should fire");
  assert.equal(applied!.meta?.cutoff, 3);
  assert.equal(applied!.meta?.hiddenMessageCount, 2);
  assert.equal(applied!.meta?.summaryLength, 2);
  assert.equal(typeof applied!.ts, "string");
  assert.ok(!emitted.some((e) => e.kind === "emit_failed"), "no emit_failed on happy path");
});

test("6c.6.3: session entry vanished between read and write → skip save; no throw", async () => {
  injectEstimatorTotalling(10_000);
  let callCount = 0;
  const loadSessionStoreMock = mock.fn((_path: string) => {
    callCount++;
    if (callCount === 1) {
      return {
        "agent:main:main": {
          compactionCount: 1,
          contextTokens: 8000,
        } satisfies SessionEntry,
      };
    }
    return {}; // second call: session vanished
  });

  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, saveSessionStore, capturedAgentEndHandler } =
    makeMockApi({}, { loadOverride: loadSessionStoreMock });
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.equal(saveSessionStore.mock.callCount(), 0, "saveSessionStore must not fire when entry vanished");
  assert.equal(messagesAppend.mock.callCount(), 1, "recall mirror should still run");

  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /session entry vanished/i.test(m)),
    `expected vanished-entry debug log; got: ${debugMsgs.join(" | ")}`,
  );
});

test("6c.6.3: recall mirror fails after metadata write → warn + emit_failed; hook does NOT re-throw", async () => {
  injectEstimatorTotalling(10_000);
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );
  const messagesAppend = mock.fn(async (): Promise<MessagesAppendResult> => {
    throw new Error("recall sidecar unavailable");
  });

  const { api, saveSessionStore, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.equal(saveSessionStore.mock.callCount(), 1, "session metadata write should still fire");
  assert.ok(
    logger.warn.mock.calls.some((c) =>
      /flush recall mirror failed/i.test(String(c.arguments[0])),
    ),
  );

  const failed = emitted.find((e) => e.kind === "emit_failed");
  assert.ok(failed, "emit_failed should fire");
  assert.equal(failed!.meta?.operation, "messagesAppend");
  assert.match(String(failed!.meta?.reason), /recall sidecar unavailable/);

  assert.ok(
    !emitted.some((e) => e.kind === "flush_applied"),
    "flush_applied must not fire when mirror fails",
  );
});

test("6c.6.3: session store write fails → warn + emit_failed; recall mirror still runs; hook does NOT re-throw", async () => {
  injectEstimatorTotalling(10_000);
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );
  const saveSessionStoreMock = mock.fn(async () => {
    throw new Error("disk write error");
  });
  const loadOverride = mock.fn((_path: string) => STORE_WITH_COMPACTION_COUNT);

  const { api, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT, { loadOverride });
  (api as unknown as { runtime: { agent: { session: { saveSessionStore: unknown } } } })
    .runtime.agent.session.saveSessionStore = saveSessionStoreMock;

  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await assert.doesNotReject(async () =>
    capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX),
  );

  assert.ok(
    logger.warn.mock.calls.some((c) =>
      /flush metadata write failed/i.test(String(c.arguments[0])),
    ),
  );

  const storeFailed = emitted.find(
    (e) => e.kind === "emit_failed" && e.meta?.operation === "sessionStore",
  );
  assert.ok(storeFailed, "emit_failed{operation:sessionStore} should fire");

  assert.equal(messagesAppend.mock.callCount(), 1, "mirror should still run after store failure");
  assert.ok(
    emitted.some((e) => e.kind === "flush_applied"),
    "flush_applied should fire when mirror succeeded",
  );
});

// ── 9. before_compaction — primary trigger (1.3.1) ─────────────────────────

/**
 * The embedded compaction path's ctx: no `trigger` field (confirmed by dist
 * read — runBeforeCompactionHooks passes {sessionId, agentId, sessionKey,
 * workspaceDir, messageProvider} only). The guard must not skip on its absence.
 */
const BEFORE_COMPACTION_CTX = {
  sessionKey: "agent:main:main",
  agentId: "main",
  sessionId: "sess-1",
  workspaceDir: "/tmp/ws",
};

/** Standard harness-path before_compaction event (messages present). */
function makeBeforeCompactionEvent(overrides: Record<string, unknown> = {}) {
  return {
    messageCount: 5,
    messages: makeAgentEndEvent().messages,
    sessionFile: "/tmp/session.jsonl",
    ...overrides,
  };
}

test("before_compaction: fires with NO threshold — a small buffer still flushes; host tokenCount preferred (tokenSource=event.tokenCount)", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(500); // ≪ 6000 — proves no threshold applies
  const client = makeHappyClient();
  const { api, capturedBeforeCompactionHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedBeforeCompactionHandler()(
    makeBeforeCompactionEvent({ tokenCount: 480 }),
    BEFORE_COMPACTION_CTX,
  );

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "before_compaction must flush regardless of any token threshold",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=before_compaction/.test(m));
  assert.ok(evalMsg, `expected before_compaction evaluation line; got: ${debugMsgs.join(" | ")}`);
  assert.match(evalMsg!, /estTokens=480/);
  assert.match(evalMsg!, /tokenSource=event\.tokenCount/);
  assert.match(evalMsg!, /messageSource=event/);
  assert.match(evalMsg!, /outcome=FLUSH/);
  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush triggered by host compaction/i.test(m)));
});

test("before_compaction: tokenCount absent → local estimate over event.messages (tokenSource=local-estimate); provider usage never consulted", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const { api, capturedBeforeCompactionHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedBeforeCompactionHandler()(
    makeBeforeCompactionEvent(), // no tokenCount
    BEFORE_COMPACTION_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 1);
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=before_compaction/.test(m));
  assert.ok(evalMsg);
  assert.match(evalMsg!, /estTokens=10000/);
  assert.match(evalMsg!, /tokenSource=local-estimate/);
});

test("before_compaction: no event.messages (embedded path) → flushes from the agent_end buffer snapshot", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(500); // below the agent_end threshold: no flush there
  const client = makeHappyClient();
  const {
    api,
    capturedAgentEndHandler,
    capturedBeforeCompactionHandler,
  } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // Turn N−1 ends: snapshot captured, threshold not tripped.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(client.summarize.mock.callCount(), 0, "agent_end below threshold must not flush");

  // Embedded-path compaction: counts only, no messages.
  await capturedBeforeCompactionHandler()(
    { messageCount: 5, tokenCount: 45_000 },
    BEFORE_COMPACTION_CTX,
  );

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "snapshot must feed the flush when the event has no messages",
  );
  const [passedMessages] = client.summarize.mock.calls[0]
    .arguments as unknown as [unknown[]];
  assert.equal(passedMessages.length, 5, "all snapshot messages reach :summarize");
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /messageSource=agent_end-snapshot/.test(m)),
    `expected snapshot message source; got: ${debugMsgs.join(" | ")}`,
  );
});

test("before_compaction: no messages anywhere → explicit DEGRADED warn + skip (never silent)", async () => {
  _resetFlushStateForTests();
  const client = makeHappyClient();
  const { api, capturedBeforeCompactionHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedBeforeCompactionHandler()(
    { messageCount: 12, tokenCount: 45_000 }, // embedded shape, no prior agent_end
    BEFORE_COMPACTION_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 0);
  const warnMsgs = logger.warn.mock.calls.map((c) => String(c.arguments[0]));
  const degraded = warnMsgs.find((m) => /DEGRADED/.test(m));
  assert.ok(degraded, `expected DEGRADED warn; got: ${warnMsgs.join(" | ")}`);
  assert.match(degraded!, /no-message-source/);
});

test("before_compaction: already flushed for current compaction cycle → skip (guard preserved)", async () => {
  _resetFlushStateForTests();
  const store: Record<string, SessionEntry> = {
    "agent:main:main": { compactionCount: 3, memoryFlushCompactionCount: 3 },
  };
  const client = makeHappyClient();
  const { api, capturedBeforeCompactionHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedBeforeCompactionHandler()(
    makeBeforeCompactionEvent(),
    BEFORE_COMPACTION_CTX,
  );

  assert.equal(client.summarize.mock.callCount(), 0);
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /already-flushed-for-cycle/.test(m)));
});

test("before_compaction: subagent session guard applies (ctx without trigger field does NOT skip interactive sessions)", async () => {
  _resetFlushStateForTests();
  const client = makeHappyClient();
  const { api, loadSessionStore, capturedBeforeCompactionHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), client));

  await capturedBeforeCompactionHandler()(makeBeforeCompactionEvent(), {
    ...BEFORE_COMPACTION_CTX,
    sessionKey: "agent:main:subagent:abc-123",
  });

  assert.equal(client.summarize.mock.callCount(), 0);
  assert.equal(loadSessionStore.mock.callCount(), 0, "guarded before session-store read");
});

// ── 10. double-fire guard (acceptance 5) ───────────────────────────────────

test("double-fire guard: before_compaction flush → same-turn agent_end skips once; next turn evaluates normally", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(10_000); // agent_end would trip on its own
  const client = makeHappyClient();
  const {
    api,
    capturedAgentEndHandler,
    capturedBeforeCompactionHandler,
  } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // Turn N: host compaction fires mid-turn → primary trigger flushes.
  await capturedBeforeCompactionHandler()(
    makeBeforeCompactionEvent(),
    BEFORE_COMPACTION_CTX,
  );
  assert.equal(client.summarize.mock.callCount(), 1);

  // End of turn N: agent_end must NOT flush again (the mock store is not
  // mutated by save, so without the marker the cycle check would re-fire).
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "agent_end in the same turn must not double-flush",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /before_compaction-already-flushed-this-turn/.test(m)),
    `expected double-fire skip log; got: ${debugMsgs.join(" | ")}`,
  );

  // Turn N+1: the marker was consumed — agent_end evaluates and fires again.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(
    client.summarize.mock.callCount(),
    2,
    "the marker must be consumed by exactly one agent_end",
  );
});

test("double-fire guard: failed before_compaction flush sets no marker — agent_end retries normally", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(10_000);
  const summarize = mock.fn(async (): Promise<SummarizeResult> => {
    throw new Error("sidecar 500");
  });
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const {
    api,
    capturedAgentEndHandler,
    capturedBeforeCompactionHandler,
  } = makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), { getStats, summarize }));

  await capturedBeforeCompactionHandler()(
    makeBeforeCompactionEvent(),
    BEFORE_COMPACTION_CTX,
  );
  assert.equal(summarize.mock.callCount(), 1);

  // agent_end must still evaluate (and re-attempt) — self-heal path.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(
    summarize.mock.callCount(),
    2,
    "a failed compaction flush must not suppress the agent_end retry",
  );
});

// ── 11. agent_end budget resolution chain (1.3.2) ──────────────────────────

test("agent_end: budget from the model_call_started cache when ctx has none (embedded harness shape)", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(800);
  // No contextTokens on the entry: the cache must be the ONLY source.
  const store: Record<string, SessionEntry> = {
    "agent:main:main": { compactionCount: 0 },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler, capturedModelCallStartedHandler } =
    makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // model_call_started fires mid-turn with the resolved budget on the event.
  await capturedModelCallStartedHandler()(
    { runId: "run-1", callId: "c1", contextTokenBudget: 1000 },
    { ...INTERACTIVE_CTX, runId: "run-1" },
  );
  // agent_end: the embedded-harness shape — runId present, no budget on ctx.
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-1",
  });

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "800 >= floor(1000 * 0.75) must trip via the model_call_started cache",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=agent_end.*TRIPPED/.test(m));
  assert.ok(evalMsg, `expected TRIPPED eval; got: ${debugMsgs.join(" | ")}`);
  assert.match(evalMsg!, /budget=1000/);
  assert.match(evalMsg!, /budgetSource=model_call_started/);
  assert.match(evalMsg!, /threshold=750/);
});

test("agent_end: budget from SessionEntry.contextTokens (tertiary); contextBudgetStatus is never consulted", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(800);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      compactionCount: 0,
      contextTokens: 1000,
      // A pre-prompt estimate that would NOT trip (0.75 × 999999 ≫ 800) —
      // proving it is ignored in favour of contextTokens.
      contextBudgetStatus: { contextTokenBudget: 999_999 },
    },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // ctx carries NO budget and no cache entry exists.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "800 >= floor(1000 * 0.75) must trip via SessionEntry.contextTokens",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=agent_end.*TRIPPED/.test(m));
  assert.ok(evalMsg, `expected TRIPPED eval; got: ${debugMsgs.join(" | ")}`);
  assert.match(evalMsg!, /budget=1000/);
  assert.match(evalMsg!, /budgetSource=sessionEntry\.contextTokens/);
  assert.match(evalMsg!, /threshold=750/);
});

test("agent_end: contextBudgetStatus.contextTokenBudget alone resolves NOTHING → declines", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(10_000);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      compactionCount: 0,
      contextBudgetStatus: { contextTokenBudget: 1000 },
    },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    client.summarize.mock.callCount(),
    0,
    "the 1.3.1 pre-prompt-estimate source must be gone — decline, don't trip",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /outcome=DECLINED/.test(m)));
});

test("agent_end: precedence — ctx beats cache, cache beats SessionEntry.contextTokens", async () => {
  _resetFlushStateForTests();
  // Cache 1000 (threshold 750) vs entry 65536 (threshold 49152): an
  // 800-token buffer trips only if the cache wins over the entry.
  injectEstimatorTotalling(800);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": { compactionCount: 0, contextTokens: 65_536 },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler, capturedModelCallStartedHandler } =
    makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedModelCallStartedHandler()(
    { runId: "run-1", contextTokenBudget: 1000 },
    { ...INTERACTIVE_CTX, runId: "run-1" },
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-1",
  });
  assert.equal(client.summarize.mock.callCount(), 1, "cache must beat the session entry");
  let debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /budgetSource=model_call_started/.test(m)));

  // ctx beats cache: re-cache 1000, but ctx carries 65536 → no trip.
  await capturedModelCallStartedHandler()(
    { runId: "run-2", contextTokenBudget: 1000 },
    { ...INTERACTIVE_CTX, runId: "run-2" },
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-2",
    contextTokenBudget: 65_536,
  });
  assert.equal(client.summarize.mock.callCount(), 1, "ctx budget (65536) must beat the cached 1000 — no second trip");
  debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /budgetSource=ctx.*did not trip/.test(m)));
});

test("agent_end: cache entry is consumed at agent_end — a later turn of the same run declines (map cleared)", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(800);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": { compactionCount: 0 },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler, capturedModelCallStartedHandler } =
    makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedModelCallStartedHandler()(
    { runId: "run-1", contextTokenBudget: 1000 },
    { ...INTERACTIVE_CTX, runId: "run-1" },
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-1",
  });
  assert.equal(client.summarize.mock.callCount(), 1, "first agent_end flushes from the cache");

  // Same runId again, no fresh model_call_started: the entry was consumed.
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-1",
  });
  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "consumed cache entry must not supply a budget twice",
  );
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /outcome=DECLINED/.test(m)));
});

test("agent_end: guarded turns still clear their cache entry (consume-before-guards)", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(800);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler, capturedModelCallStartedHandler } =
    makeMockApi({ "agent:main:main": { compactionCount: 0 } });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedModelCallStartedHandler()(
    { runId: "run-1", contextTokenBudget: 1000 },
    { ...INTERACTIVE_CTX, runId: "run-1" },
  );
  // A guarded (cron) agent_end for the same run consumes the entry silently.
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    trigger: "cron",
    sessionKey: "agent:main:main",
    agentId: "main",
    runId: "run-1",
  });
  // An interactive agent_end for the same runId now has no budget → declines.
  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    runId: "run-1",
  });
  assert.equal(client.summarize.mock.callCount(), 0);
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /outcome=DECLINED/.test(m)));
});

test("agent_end: ctx budget wins over the session-entry budget when both exist (CLI-shaped ctx)", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(800);
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      compactionCount: 0,
      contextTokens: 1000,
    },
  };
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(makeAgentEndEvent(), {
    ...INTERACTIVE_CTX,
    contextTokenBudget: 65_536,
  });

  assert.equal(client.summarize.mock.callCount(), 0, "800 < 49152 — no trip under ctx budget");
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=agent_end/.test(m));
  assert.match(evalMsg!, /budgetSource=ctx/);
  assert.match(evalMsg!, /budget=65536/);
});

test("agent_end: no budget anywhere → DECLINES (no absolute fallback) + once-per-session DEGRADED warn; ctx survey logged once", async () => {
  _resetFlushStateForTests();
  // 10,000 tokens would have tripped the old absolute-6000 fallback — the
  // load-bearing 1.3.2 assertion is that it now does NOT flush.
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const { api, capturedAgentEndHandler } = makeMockApi({
    "agent:main:main": { compactionCount: 0 }, // no contextTokens
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    client.summarize.mock.callCount(),
    0,
    "an unresolvable budget must DECLINE, never guess a threshold",
  );

  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  const evalMsg = debugMsgs.find((m) => /trigger=agent_end/.test(m));
  assert.ok(evalMsg);
  assert.match(evalMsg!, /budget=unresolvable/);
  assert.match(evalMsg!, /budgetSource=none/);
  assert.match(evalMsg!, /outcome=DECLINED/);
  assert.match(evalMsg!, /estTokens=10000/);

  const warns = logger.warn.mock.calls
    .map((c) => String(c.arguments[0]))
    .filter((m) => /DEGRADED/.test(m));
  assert.equal(warns.length, 1, "degraded warn fires once per session, not per turn");
  assert.match(warns[0], /before_compaction trigger covers it/);

  const surveys = debugMsgs.filter((m) => /agent_end ctx survey/.test(m));
  assert.equal(surveys.length, 1, "ctx survey must log exactly once per process");
  assert.match(surveys[0], /contextTokenBudget=unset/);
});

test("acceptance 2: no budget → agent_end declines AND before_compaction still flushes from the snapshot", async () => {
  _resetFlushStateForTests();
  injectEstimatorTotalling(10_000);
  const client = makeHappyClient();
  const {
    api,
    capturedAgentEndHandler,
    capturedBeforeCompactionHandler,
  } = makeMockApi({ "agent:main:main": { compactionCount: 0 } });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, client));

  // agent_end declines (no budget) but still captures the buffer snapshot.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);
  assert.equal(client.summarize.mock.callCount(), 0, "agent_end must decline");

  // Embedded-path compaction event (counts only): the snapshot carries it.
  await capturedBeforeCompactionHandler()(
    { messageCount: 5, tokenCount: 45_000 },
    BEFORE_COMPACTION_CTX,
  );
  assert.equal(
    client.summarize.mock.callCount(),
    1,
    "before_compaction is the flush path when the budget is unresolvable",
  );
});
