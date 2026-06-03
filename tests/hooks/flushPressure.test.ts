/**
 * Unit tests for the §4.4 flush-pressure check.
 *
 * Trigger refactor (6c.6.3b): flush logic moved from `before_prompt_build`
 * to `llm_output` (token capture) + `agent_end` (threshold check + :summarize).
 * Each test that drives the happy path invokes both handlers in sequence:
 *   1. llm_output handler — sets capturedTokens[sessionKey]
 *   2. agent_end handler  — reads + consumes the token, runs flush logic
 *
 * Tests that exercise early exits (no token, below threshold, guards) invoke
 * only agent_end without a preceding llm_output call, leaving the Map empty.
 *
 * api.runtime.agent.session is mocked — a synthetic store keyed by sessionKey
 * lets each test control entry presence + values. The sidecar client is a
 * partial-mock — only methods the hook calls (summarize, getStats,
 * messagesAppend) are stubbed per test.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  MESSAGE_SUMMARY_WARNING_TOKENS,
  registerFlushPressureHook,
  _resetCapturedTokensForTests,
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
  capturedLlmOutputHandler: () => Handler;
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
    capturedLlmOutputHandler: () => {
      const h = capturedHandlers["llm_output"];
      if (!h) throw new Error("llm_output hook not registered");
      return h;
    },
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
function makeAgentEndEvent(tokenCount?: number) {
  return {
    success: true,
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second" },
      { role: "assistant", content: "second reply" },
    ],
    durationMs: tokenCount,
  };
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

/** Store entry that sits above threshold once the Map token is set. */
const ABOVE_THRESHOLD_STORE: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 0 },
};

/** Store with a specific compactionCount for 6c.6.3 write-path tests. */
const STORE_WITH_COMPACTION_COUNT: Record<string, SessionEntry> = {
  "agent:main:main": { compactionCount: 2 },
};

// ── 1. registration ────────────────────────────────────────────────────────

test("registerFlushPressureHook: registers llm_output AND agent_end handlers", () => {
  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi({});
  registerFlushPressureHook(api, makeDeps(makeLogger()));
  assert.doesNotThrow(() => capturedLlmOutputHandler());
  assert.doesNotThrow(() => capturedAgentEndHandler());
});

// ── 2. llm_output token capture ────────────────────────────────────────────

test("llm_output: captures usage.total for sessionKey; agent_end sees above-threshold token", async () => {
  _resetCapturedTokensForTests();
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );
  const messagesAppend = mock.fn(
    async (): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(
    api,
    makeDeps(makeLogger(), { getStats, summarize, messagesAppend }),
  );

  // llm_output fires first with above-threshold token count.
  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 50 } },
    INTERACTIVE_CTX,
  );
  // agent_end fires — should see the captured token and trip.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    summarize.mock.callCount(),
    1,
    "summarize should fire when token captured from llm_output",
  );
});

test("llm_output: missing usage → no Map entry; agent_end skips (no token)", async () => {
  _resetCapturedTokensForTests();
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), { summarize }));

  // llm_output fires but carries no usage.
  await capturedLlmOutputHandler()({}, INTERACTIVE_CTX);
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(summarize.mock.callCount(), 0, "no token → no summarize");
});

test("llm_output: non-interactive trigger → no Map entry written", async () => {
  _resetCapturedTokensForTests();
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), { summarize }));

  // llm_output fires on a cron trigger — guard should prevent Map write.
  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    { trigger: "cron", sessionKey: "agent:main:main", agentId: "main" },
  );
  // agent_end fires interactively — Map is still empty.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    summarize.mock.callCount(),
    0,
    "cron llm_output guard must block Map write",
  );
});

test("llm_output: subagent session → no Map entry written", async () => {
  _resetCapturedTokensForTests();
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), { summarize }));

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    {
      trigger: "user",
      sessionKey: "agent:main:subagent:abc-123",
      agentId: "main",
    },
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(summarize.mock.callCount(), 0, "subagent llm_output guard must block Map write");
});

// ── 3. agent_end guards ────────────────────────────────────────────────────

test("guard: non-interactive trigger (cron) → skips before session-store read", async () => {
  // Guards fire before Map read, before loadSessionStore.
  _resetCapturedTokensForTests();
  const { api, loadSessionStore, capturedAgentEndHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedAgentEndHandler()(
    { success: true, messages: [] },
    { trigger: "cron", sessionKey: "agent:main:main", agentId: "main" },
  );
  assert.equal(
    loadSessionStore.mock.callCount(),
    0,
    "non-interactive trigger must skip before loading session store",
  );
  assert.equal(logger.info.mock.callCount(), 0);
});

test("guard: subagent session → skips before session-store read", async () => {
  _resetCapturedTokensForTests();
  const { api, loadSessionStore, capturedAgentEndHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedAgentEndHandler()(
    { success: true, messages: [] },
    {
      trigger: "user",
      sessionKey: "agent:main:subagent:abc-123",
      agentId: "main",
    },
  );
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.info.mock.callCount(), 0);
});

test("guard: event.success false → clears Map entry; skips flush", async () => {
  // A failed turn should not trigger flush; the captured token is cleaned up
  // so the next turn's agent_end doesn't inherit a stale value.
  _resetCapturedTokensForTests();
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, loadSessionStore, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(api, makeDeps(makeLogger(), { summarize }));

  // Set token via llm_output.
  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
  );
  // agent_end fires with success:false.
  await capturedAgentEndHandler()(
    { success: false, messages: [] },
    INTERACTIVE_CTX,
  );

  assert.equal(summarize.mock.callCount(), 0, "failed turn must not trigger flush");
  assert.equal(loadSessionStore.mock.callCount(), 0, "must not load session store on failure");
});

// ── 4. threshold check (no prior llm_output → no captured token) ──────────

test("no captured token (llm_output not fired) → silent skip (no info, no debug)", async () => {
  _resetCapturedTokensForTests();
  const { api, loadSessionStore, capturedAgentEndHandler } = makeMockApi(
    ABOVE_THRESHOLD_STORE,
  );
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  // Call agent_end directly without a preceding llm_output call.
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    loadSessionStore.mock.callCount(),
    0,
    "no token → skips before session store load",
  );
  assert.equal(logger.info.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0);
});

test("captured token below threshold → silent skip", async () => {
  _resetCapturedTokensForTests();
  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS - 1 } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(logger.info.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0);
});

test("captured token zero → silent skip (degenerate-but-valid)", async () => {
  _resetCapturedTokensForTests();
  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));

  await capturedLlmOutputHandler()({ usage: { total: 0 } }, INTERACTIVE_CTX);
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(logger.info.mock.callCount(), 0);
});

test("above threshold + session entry → info log 'flush threshold tripped'", async () => {
  _resetCapturedTokensForTests();
  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  // Provide enough stubs so the handler can proceed past getStats.
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());
  const messagesAppend = mock.fn(async (): Promise<MessagesAppendResult> => ({ appended: 1 }));
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 1 } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(logger.info.mock.callCount() >= 1, true);
  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));
  assert.ok(infoMsgs.some((m) => /totalTokens=\d+/.test(m)));
});

test("exactly at threshold → trips (>=, not >)", async () => {
  // Pin the boundary: `<` skip means `>=` trips. If a future refactor flips
  // to `<=` skip, this test catches the shift.
  _resetCapturedTokensForTests();
  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());
  const messagesAppend = mock.fn(async (): Promise<MessagesAppendResult> => ({ appended: 1 }));
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));
});

// ── 5. constant ────────────────────────────────────────────────────────────

test("MESSAGE_SUMMARY_WARNING_TOKENS = 6000 (= int(0.75 * 8000) per fork constants.py)", () => {
  assert.equal(MESSAGE_SUMMARY_WARNING_TOKENS, 6000);
});

// ── 6. already flushed for current cycle ──────────────────────────────────

test("already flushed for current cycle → debug + skip; no summarize call", async () => {
  _resetCapturedTokensForTests();
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      compactionCount: 3,
      memoryFlushCompactionCount: 3, // already flushed for cycle 3
    },
  };
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize }));

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 200 } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(
    summarize.mock.callCount(),
    0,
    "summarize must NOT be called if already flushed for cycle",
  );
  assert.equal(getStats.mock.callCount(), 0, "getStats must NOT be called either");
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

test("above threshold → calls getStats then summarize; emits summarisation_succeeded; logs success", async () => {
  _resetCapturedTokensForTests();
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

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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

  // summarisation_succeeded event carries cutoff + totalTokens meta.
  const success = emitted.find((e) => e.kind === "summarisation_succeeded");
  assert.ok(success, "summarisation_succeeded event should fire");
  assert.equal(success!.meta?.cutoff, 3);
  assert.equal(
    success!.meta?.totalTokens,
    MESSAGE_SUMMARY_WARNING_TOKENS + 100,
  );
  assert.equal(success!.meta?.summaryLength, 2);
  assert.equal(typeof success!.ts, "string");
});

test("BufferTooSmallError → info-level no-op + summarisation_skipped event (§2.8 422)", async () => {
  _resetCapturedTokensForTests();
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async (): Promise<SummarizeResult> => {
    throw new BufferTooSmallError(
      "Summarize error: less than 2 messages... wait for more messages.",
    );
  });

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  assert.equal(
    skipped!.meta?.totalTokens,
    MESSAGE_SUMMARY_WARNING_TOKENS + 100,
  );

  assert.ok(
    !emitted.some((e) => e.kind === "summarisation_succeeded"),
    "summarisation_succeeded must not fire on 422",
  );
});

test("generic summarize error → logs error + emits emit_failed; does NOT re-throw (recoverable next turn)", async () => {
  _resetCapturedTokensForTests();
  const transportErr = new Error("sidecar 500");
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async () => {
    throw transportErr;
  });

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  _resetCapturedTokensForTests();
  const getStats = mock.fn(async (): Promise<StatsResponse> => {
    throw new Error("stats 503");
  });
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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

test("sub-threshold token → summarize is NOT called (regression guard)", async () => {
  _resetCapturedTokensForTests();
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  registerFlushPressureHook(
    api,
    makeDeps(makeLogger(), { getStats, summarize }),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS - 1 } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(makeAgentEndEvent(), INTERACTIVE_CTX);

  assert.equal(summarize.mock.callCount(), 0);
  assert.equal(
    getStats.mock.callCount(),
    0,
    "below threshold must not even fetch stats",
  );
});

test("empty event.messages above threshold → predicate trips but summarise skipped (defensive)", async () => {
  _resetCapturedTokensForTests();
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
  );
  await capturedAgentEndHandler()(
    { success: true, messages: [] },
    INTERACTIVE_CTX,
  );

  // Predicate tripped (threshold log fired).
  const infoMsgs = logger.info.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));

  // But summarise is NOT called.
  assert.equal(summarize.mock.callCount(), 0);
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(debugMsgs.some((m) => /event\.messages empty/i.test(m)));
});

// ── 8. 6c.6.3 — metadata write + recall mirror ────────────────────────────

test("6c.6.3: flush metadata written to session store on success (all five fields)", async () => {
  _resetCapturedTokensForTests();
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

  const { api, saveSessionStore, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT);
  registerFlushPressureHook(
    api,
    makeDeps(makeLogger(), { getStats, summarize, messagesAppend }),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  _resetCapturedTokensForTests();
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

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } = makeMockApi(
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

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  _resetCapturedTokensForTests();
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

  const { api, saveSessionStore, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi({}, { loadOverride: loadSessionStoreMock });
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  _resetCapturedTokensForTests();
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );
  const messagesAppend = mock.fn(async (): Promise<MessagesAppendResult> => {
    throw new Error("recall sidecar unavailable");
  });

  const { api, saveSessionStore, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
  _resetCapturedTokensForTests();
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

  const { api, capturedLlmOutputHandler, capturedAgentEndHandler } =
    makeMockApi(STORE_WITH_COMPACTION_COUNT, { loadOverride });
  (api as unknown as { runtime: { agent: { session: { saveSessionStore: unknown } } } })
    .runtime.agent.session.saveSessionStore = saveSessionStoreMock;

  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize, messagesAppend }, emitted),
  );

  await capturedLlmOutputHandler()(
    { usage: { total: MESSAGE_SUMMARY_WARNING_TOKENS + 100 } },
    INTERACTIVE_CTX,
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
