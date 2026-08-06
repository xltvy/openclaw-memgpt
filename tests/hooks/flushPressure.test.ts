/**
 * Unit tests for the §4.4 flush-pressure check.
 *
 * Trigger refactor (6d provider-independence fix): the two-hook form
 * (`llm_output` usage capture → `agent_end` threshold check) is gone. The
 * trigger now estimates tokens locally by summing a per-message estimator
 * over `event.messages` inside `agent_end`, and compares against
 * `ctx.contextTokenBudget * flushRatio` (fallback: the absolute
 * MESSAGE_SUMMARY_WARNING_TOKENS = 6000 when no budget is supplied).
 * Provider-reported `usage` is never consulted.
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

/** Store entry with no prior flush recorded. */
const ABOVE_THRESHOLD_STORE: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 0 },
};

/** Store with a specific compactionCount for 6c.6.3 write-path tests. */
const STORE_WITH_COMPACTION_COUNT: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 2 },
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

test("registerFlushPressureHook: registers a single agent_end handler (llm_output is gone)", () => {
  const capturedNames: string[] = [];
  const api = {
    on: (event: string, _h: Handler) => {
      capturedNames.push(event);
    },
  } as unknown as OpenClawPluginApi;
  registerFlushPressureHook(api, makeDeps(makeLogger()));
  assert.deepEqual(capturedNames, ["agent_end"]);
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

test("missing contextTokenBudget → absolute fallback threshold 6000 (>= trips, boundary pinned)", async () => {
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
