/**
 * Unit tests for the §4.4 flush-pressure check on before_prompt_build.
 *
 * 6c.6.1 scope (still pinned below): trigger predicate.
 * 6c.6.2 scope: summariser glue behind the same predicate — happy path,
 * BufferTooSmallError (§2.8 422) no-op, generic error → recoverable, the
 * sub-threshold regression guard, and the totalMessageCount source path
 * (client.getStats). Session-store mutation is still 6c.6.3.
 *
 * api.runtime.agent.session is mocked — a synthetic store keyed by
 * sessionKey lets each test control entry presence + token values. The
 * sidecar client is a partial-mock too — only methods this hook calls
 * (summarize, getStats) need to be stubbed per test.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  MESSAGE_SUMMARY_WARNING_TOKENS,
  registerFlushPressureHook,
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

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

type LogFn = (msg: string) => void;

interface CapturedLogger {
  info: ReturnType<typeof mock.fn<LogFn>>;
  warn: ReturnType<typeof mock.fn<LogFn>>;
  error: ReturnType<typeof mock.fn<LogFn>>;
  debug: ReturnType<typeof mock.fn<LogFn>>;
}

function makeLogger(): CapturedLogger {
  // Explicit LogFn typing so the mock is structurally compatible with
  // ToolDeps["logger"] (`(msg: string) => void` per slot).
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
 * Returns both the api (cast to OpenClawPluginApi) and call-count mocks so
 * tests can assert whether the store was read or written.
 *
 * `loadSessionStore` by default returns `store` for every call. Pass a
 * custom mock via `loadOverride` when a test needs to return different values
 * on successive calls (e.g. "session vanished between read and write").
 */
function makeMockApi(
  store: Record<string, SessionEntry>,
  opts?: { loadOverride?: ReturnType<typeof mock.fn> },
): {
  api: OpenClawPluginApi;
  resolveStorePath: ReturnType<typeof mock.fn>;
  loadSessionStore: ReturnType<typeof mock.fn>;
  saveSessionStore: ReturnType<typeof mock.fn>;
  capturedHandler: () => Handler;
} {
  const resolveStorePath = mock.fn(
    (_store?: string, _opts?: { agentId?: string }) => "/test/store/path",
  );
  const loadSessionStore =
    opts?.loadOverride ?? mock.fn((_path: string) => store);
  const saveSessionStore = mock.fn(
    async (_path: string, _s: Record<string, SessionEntry>) => {},
  );

  let captured: Handler | undefined;
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
      if (event === "before_prompt_build") captured = handler;
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
    capturedHandler: () => {
      if (!captured) throw new Error("hook did not register");
      return captured;
    },
  };
}

const INTERACTIVE_CTX = {
  trigger: "user",
  sessionKey: "agent:main:main",
  agentId: "main",
};

// ── 1. registration ────────────────────────────────────────────────────────

test("registerFlushPressureHook: registers a before_prompt_build handler", () => {
  const { api, capturedHandler } = makeMockApi({});
  registerFlushPressureHook(api, makeDeps(makeLogger()));
  assert.doesNotThrow(() => capturedHandler());
});

// ── 2. guards skip BEFORE session-store access ─────────────────────────────

test("guard: non-interactive trigger (cron) → skips before session-store read", async () => {
  // Important: the session-store load is expensive (sync disk + lock).
  // Guards that fail must short-circuit before loadSessionStore fires —
  // otherwise the hook does pointless work on every cron-fired turn.
  const { api, loadSessionStore, capturedHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()(
    {},
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
  const { api, loadSessionStore, capturedHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()(
    {},
    {
      trigger: "user",
      sessionKey: "agent:main:subagent:abc-123",
      agentId: "main",
    },
  );
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.info.mock.callCount(), 0);
});

test("guard: missing sessionKey → skips defensively (loadSessionEntry returns null)", async () => {
  const { api, loadSessionStore, capturedHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, { trigger: "user", agentId: "main" });
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.info.mock.callCount(), 0);
});

test("guard: missing agentId → skips defensively", async () => {
  const { api, loadSessionStore, capturedHandler } = makeMockApi({});
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()(
    {},
    { trigger: "user", sessionKey: "agent:main:main" },
  );
  assert.equal(loadSessionStore.mock.callCount(), 0);
  assert.equal(logger.info.mock.callCount(), 0);
});

// ── 3. no entry for sessionKey (first turn) ────────────────────────────────

test("no entry for sessionKey (first turn) → silent skip", async () => {
  // The session store loaded, but the sessionKey isn't in it yet.
  // No log at any level — quiet steady-state.
  const { api, loadSessionStore, capturedHandler } = makeMockApi({
    "other-session": { totalTokens: 999_999, totalTokensFresh: true },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(
    loadSessionStore.mock.callCount(),
    1,
    "store load should have happened (entry-pluck is the actual check)",
  );
  assert.equal(logger.info.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0);
});

// ── 4. stale snapshot ──────────────────────────────────────────────────────

test("totalTokensFresh === false → debug log + skip (no info log)", async () => {
  // §4.7 stale-snapshot rule: totalTokensFresh:false means the value is
  // from a prior un-rotated context. Acting on it would mis-attribute the
  // trip to the current turn.
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 10_000,
      totalTokensFresh: false,
    },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(
    logger.debug.mock.callCount(),
    1,
    "stale snapshot should log at debug",
  );
  assert.match(
    String(logger.debug.mock.calls[0].arguments[0]),
    /stale snapshot/i,
  );
  assert.equal(
    logger.info.mock.callCount(),
    0,
    "stale snapshot must not info-log a threshold trip",
  );
});

test("totalTokensFresh undefined → treated as stale (default-deny)", async () => {
  // Default-deny pattern: only `=== true` is fresh; unset is stale. Matches
  // OpenClaw's semantic: undefined means "legacy/unknown freshness".
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": { totalTokens: 99_999 /* no totalTokensFresh */ },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(logger.debug.mock.callCount(), 1);
  assert.equal(logger.info.mock.callCount(), 0);
});

// ── 5. below threshold ─────────────────────────────────────────────────────

test("below threshold + fresh → silent skip (no info, no debug)", async () => {
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS - 1,
      totalTokensFresh: true,
    },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(logger.info.mock.callCount(), 0);
  assert.equal(logger.debug.mock.callCount(), 0);
});

test("zero tokens + fresh → silent skip (degenerate-but-fresh)", async () => {
  // Edge case: an explicit zero is fresh and below threshold. Verifies the
  // 0-vs-null distinction in resolveFreshSessionTotalTokens.
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": { totalTokens: 0, totalTokensFresh: true },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(logger.info.mock.callCount(), 0);
});

// ── 6. above threshold (the load-bearing case) ─────────────────────────────

test("above threshold + fresh → info log 'flush threshold tripped'", async () => {
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 1,
      totalTokensFresh: true,
    },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(logger.info.mock.callCount(), 1);
  const msg = String(logger.info.mock.calls[0].arguments[0]);
  assert.match(msg, /flush threshold tripped/i);
  assert.match(msg, /totalTokens=\d+/);
});

test("exactly at threshold + fresh → trips (>=, not >)", async () => {
  // The `<` skip means `>= ` trips. Pin the boundary so a future refactor
  // that flips to `<=` skip doesn't silently change when summarisation fires.
  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS,
      totalTokensFresh: true,
    },
  });
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger));
  await capturedHandler()({}, INTERACTIVE_CTX);
  assert.equal(logger.info.mock.callCount(), 1);
});

// ── 7. constant matches §4.4 / fork ────────────────────────────────────────

test("MESSAGE_SUMMARY_WARNING_TOKENS = 6000 (= int(0.75 * 8000) per fork constants.py)", () => {
  // Pinned so a typo in the literal is caught. The §4.4 design depends on
  // this exact value — it's MemGPT's behavioural contract, not a tunable.
  assert.equal(MESSAGE_SUMMARY_WARNING_TOKENS, 6000);
});

// ── 8. summariser glue (6c.6.2) ────────────────────────────────────────────

/** A canonical above-threshold store + a representative event payload. */
const ABOVE_THRESHOLD_STORE: Record<string, SessionEntry> = {
  "agent:main:main": {
    totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 100,
    totalTokensFresh: true,
  },
};

/**
 * A representative `before_prompt_build` event. The flush hook reads
 * `event.messages` per the module docstring (SessionEntry has no
 * `messages` field; `event.messages` is the SDK-sanctioned source).
 */
function makeEvent() {
  return {
    prompt: "user question",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second" },
      { role: "assistant", content: "second reply" },
    ],
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

test("above threshold → calls getStats then summarize; emits summarisation_succeeded; logs success", async () => {
  // The happy path. Pins the contract: getStats fires for the
  // totalMessageCount source, then summarize fires with the event messages
  // and the stats count, and the success path emits the
  // summarisation_succeeded event with cutoff + totalTokens meta.
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 42 }),
  );
  const summarize = mock.fn(
    async (
      _messages: unknown[],
      _count: number,
    ): Promise<SummarizeResult> => makeSummarizeResult({ cutoff: 3 }),
  );

  const { api, capturedHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await capturedHandler()(makeEvent(), INTERACTIVE_CTX);

  // getStats called for totalMessageCount source.
  assert.equal(getStats.mock.callCount(), 1);

  // summarize called with the (normalised) event messages + the stats count.
  assert.equal(summarize.mock.callCount(), 1);
  const [passedMessages, passedCount] = summarize.mock.calls[0].arguments as [
    unknown[],
    number,
  ];
  assert.equal(passedMessages.length, 5);
  assert.equal(passedCount, 42);

  // Threshold trip log + success log fire.
  const infoMsgs = logger.info.mock.calls.map((c) =>
    String(c.arguments[0]),
  );
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));
  assert.ok(infoMsgs.some((m) => /summarisation succeeded/i.test(m)));

  // summarisation_succeeded event carries the cutoff + totalTokens meta.
  const success = emitted.find(
    (e) => e.kind === "summarisation_succeeded",
  );
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
  // §2.8: a small token-heavy buffer is recoverable. Treat the 422 as a
  // false-alarm threshold crossing — info log + emit `summarisation_skipped`
  // with `reason:"buffer_too_small"`. Hook returns normally; turn continues.
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async (): Promise<SummarizeResult> => {
    throw new BufferTooSmallError(
      "Summarize error: less than 2 messages... wait for more messages.",
    );
  });

  const { api, capturedHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  // Does NOT throw — the §2.8 422 is a quiet no-op.
  await assert.doesNotReject(() =>
    capturedHandler()(makeEvent(), INTERACTIVE_CTX),
  );

  // summarize was attempted (proving the predicate tripped).
  assert.equal(summarize.mock.callCount(), 1);

  // Info-level log (not error — explicit per §2.8: recoverable).
  const infoMsgs = logger.info.mock.calls.map((c) =>
    String(c.arguments[0]),
  );
  assert.ok(
    infoMsgs.some((m) => /summarisation skipped.*buffer too small/i.test(m)),
    `expected buffer-too-small info log; got: ${infoMsgs.join(" | ")}`,
  );
  assert.equal(logger.error.mock.callCount(), 0, "must NOT log at error");

  // summarisation_skipped event with the right reason.
  const skipped = emitted.find((e) => e.kind === "summarisation_skipped");
  assert.ok(skipped, "summarisation_skipped event should fire");
  assert.equal(skipped!.meta?.reason, "buffer_too_small");
  assert.equal(
    skipped!.meta?.totalTokens,
    MESSAGE_SUMMARY_WARNING_TOKENS + 100,
  );

  // No success event.
  assert.ok(
    !emitted.some((e) => e.kind === "summarisation_succeeded"),
    "summarisation_succeeded must not fire on 422",
  );
});

test("generic summarize error → logs error + emits emit_failed; does NOT re-throw (recoverable next turn)", async () => {
  // Other failures are recoverable on the next turn — tokens stay above
  // threshold; the predicate trips again; retry is natural. Same pattern
  // as 6c.5's save failure.
  const transportErr = new Error("sidecar 500");
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(async () => {
    throw transportErr;
  });

  const { api, capturedHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await assert.doesNotReject(() =>
    capturedHandler()(makeEvent(), INTERACTIVE_CTX),
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
  // The getStats round-trip is a precondition for summarize (we can't pass
  // a totalMessageCount we don't have). If it fails, recoverable-next-turn
  // pattern applies and summarize is not attempted with a wrong count.
  const getStats = mock.fn(async (): Promise<StatsResponse> => {
    throw new Error("stats 503");
  });
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }, emitted),
  );

  await assert.doesNotReject(() =>
    capturedHandler()(makeEvent(), INTERACTIVE_CTX),
  );

  assert.equal(
    summarize.mock.callCount(),
    0,
    "summarize must NOT be called if we couldn't get a totalMessageCount",
  );
  const failed = emitted.find((e) => e.kind === "emit_failed");
  assert.ok(failed);
  assert.equal(failed!.meta?.operation, "getStats");
});

test("sub-threshold + fresh → summarize is NOT called (regression guard)", async () => {
  // Existing 6c.6.1 silent-skip path; pin that 6c.6.2 didn't accidentally
  // start calling summarize unconditionally.
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedHandler } = makeMockApi({
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS - 1,
      totalTokensFresh: true,
    },
  });
  const logger = makeLogger();
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }),
  );

  await capturedHandler()(makeEvent(), INTERACTIVE_CTX);

  assert.equal(summarize.mock.callCount(), 0);
  assert.equal(
    getStats.mock.callCount(),
    0,
    "below threshold should not even fetch stats — predicate short-circuits first",
  );
});

test("empty event.messages above threshold → predicate trips but summarise skipped (defensive)", async () => {
  // The threshold-trip log still fires (predicate-only contract from
  // 6c.6.1 stays intact), but the summarise call is guarded against an
  // empty messages array. Without this guard, summarize would be called
  // with an empty array and the sidecar would 422 unnecessarily.
  const getStats = mock.fn(
    async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }),
  );
  const summarize = mock.fn(
    async (): Promise<SummarizeResult> => makeSummarizeResult(),
  );

  const { api, capturedHandler } = makeMockApi(ABOVE_THRESHOLD_STORE);
  const logger = makeLogger();
  registerFlushPressureHook(
    api,
    makeDeps(logger, { getStats, summarize }),
  );

  await capturedHandler()({ messages: [] }, INTERACTIVE_CTX);

  // Predicate tripped (threshold log fired).
  const infoMsgs = logger.info.mock.calls.map((c) =>
    String(c.arguments[0]),
  );
  assert.ok(infoMsgs.some((m) => /flush threshold tripped/i.test(m)));

  // But summarise is NOT called.
  assert.equal(summarize.mock.callCount(), 0);
  // Defensive-skip log.
  const debugMsgs = logger.debug.mock.calls.map((c) =>
    String(c.arguments[0]),
  );
  assert.ok(debugMsgs.some((m) => /event\.messages empty/i.test(m)));
});

// ── 9. 6c.6.3 — metadata write + recall mirror ────────────────────────────

/** Store with a compactionCount to verify memoryFlushCompactionCount matches. */
const STORE_WITH_COMPACTION_COUNT: Record<string, SessionEntry> = {
  "agent:main:main": {
    totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 100,
    totalTokensFresh: true,
    compactionCount: 2,
  },
};

test("6c.6.3: already flushed for current cycle → debug + skip; no summarize call", async () => {
  // hasAlreadyFlushedForCurrentCompaction: memoryFlushCompactionCount === compactionCount → skip.
  // This prevents re-summarising the same context when the transcript wasn't trimmed.
  const store: Record<string, SessionEntry> = {
    "agent:main:main": {
      totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 200,
      totalTokensFresh: true,
      compactionCount: 3,
      memoryFlushCompactionCount: 3, // already flushed for cycle 3
    },
  };
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());

  const { api, capturedHandler } = makeMockApi(store);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize }));

  await capturedHandler()(makeEvent(), INTERACTIVE_CTX);

  assert.equal(summarize.mock.callCount(), 0, "summarize must NOT be called if already flushed for cycle");
  assert.equal(getStats.mock.callCount(), 0, "getStats must NOT be called either");
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /already done for current compaction cycle/i.test(m)),
    `expected already-flushed debug log; got: ${debugMsgs.join(" | ")}`,
  );
});

test("6c.6.3: hasAlreadyFlushedForCurrentCompaction helper — boundary cases", () => {
  // Direct unit tests of the helper (memoryFlushCompactionCount === compactionCount → true).
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
    hasAlreadyFlushedForCurrentCompaction({ memoryFlushCompactionCount: 0 /* no compactionCount */ }),
    true,
    "compactionCount absent (defaults to 0) + memoryFlushCompactionCount=0 → already flushed",
  );
});

test("6c.6.3: flush metadata written to session store on success (memoryFlushAt, memoryFlushCompactionCount, memoryFlushContextHash)", async () => {
  // Pins the metadata write: after a successful summarize, the entry gains
  // memoryFlushAt (number), memoryFlushCompactionCount (= compactionCount),
  // and memoryFlushContextHash (non-empty string).
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 10 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult({ cutoff: 3 }));
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, saveSessionStore, capturedHandler } = makeMockApi(STORE_WITH_COMPACTION_COUNT);
  const logger = makeLogger();
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize, messagesAppend }));

  await capturedHandler()(makeEvent(), INTERACTIVE_CTX);

  // saveSessionStore must have been called with the updated entry.
  assert.equal(saveSessionStore.mock.callCount(), 1, "saveSessionStore should fire once");
  const savedStore = saveSessionStore.mock.calls[0].arguments[1] as Record<string, SessionEntry>;
  const saved = savedStore["agent:main:main"];
  assert.ok(saved, "saved entry must exist");
  assert.equal(typeof saved.memoryFlushAt, "number", "memoryFlushAt must be a number (ms timestamp)");
  assert.ok(saved.memoryFlushAt! > 0, "memoryFlushAt must be a positive timestamp");
  assert.equal(
    saved.memoryFlushCompactionCount,
    2,
    "memoryFlushCompactionCount must match compactionCount (= 2)",
  );
  assert.ok(saved.memoryFlushContextHash, "memoryFlushContextHash must be non-empty");
  assert.equal(typeof saved.memoryFlushContextHash, "string");
  assert.equal(saved.memoryFlushContextHash!.length, 16, "hash is 16 hex chars");
  // Verify other fields preserved.
  assert.equal(saved.compactionCount, 2, "compactionCount must be unchanged");
  assert.equal(saved.totalTokensFresh, true);
});

test("6c.6.3: recall mirror is called after metadata write; flush_applied event fires", async () => {
  // Order matters: session metadata (coordination) before recall mirror
  // (searchability). flush_applied emits only when both succeed.
  const callOrder: string[] = [];
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult({ cutoff: 3 }));
  const messagesAppend = mock.fn(async (_msgs: unknown[]): Promise<MessagesAppendResult> => {
    callOrder.push("messagesAppend");
    return { appended: 1 };
  });
  // Capture save call order via the mock.
  const saveSessionStoreMock = mock.fn(
    async (_path: string, _s: Record<string, SessionEntry>) => {
      callOrder.push("saveSessionStore");
    },
  );
  const loadSessionStoreMock = mock.fn(
    (_path: string) => STORE_WITH_COMPACTION_COUNT,
  );

  const { api, capturedHandler } = makeMockApi(STORE_WITH_COMPACTION_COUNT, {
    loadOverride: loadSessionStoreMock,
  });
  // Override the saveSessionStore on the api's session object to use our mock.
  (api as unknown as { runtime: { agent: { session: { saveSessionStore: unknown } } } })
    .runtime.agent.session.saveSessionStore = saveSessionStoreMock;

  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize, messagesAppend }, emitted));

  await capturedHandler()(makeEvent(), INTERACTIVE_CTX);

  // Metadata write before mirror.
  assert.ok(callOrder.indexOf("saveSessionStore") < callOrder.indexOf("messagesAppend"),
    `saveSessionStore (${callOrder.indexOf("saveSessionStore")}) must come before messagesAppend (${callOrder.indexOf("messagesAppend")})`);

  // flush_applied event fires with the right shape.
  const applied = emitted.find((e) => e.kind === "flush_applied");
  assert.ok(applied, "flush_applied event should fire");
  assert.equal(applied!.meta?.cutoff, 3);
  assert.equal(applied!.meta?.hiddenMessageCount, 2, "hiddenMessageCount from SummarizeResult");
  assert.equal(applied!.meta?.summaryLength, 2);
  assert.equal(typeof applied!.ts, "string");
  // No emit_failed.
  assert.ok(!emitted.some((e) => e.kind === "emit_failed"), "no emit_failed on happy path");
});

test("6c.6.3: session entry vanished between read and write → skip save; no throw", async () => {
  // The predicate reads the store (call 1 → entry present, threshold fires).
  // The success branch reads it again for the write path (call 2 → entry gone).
  // Guard: if store[sessionKey] is absent at write time, skip saveSessionStore.
  let callCount = 0;
  const loadSessionStoreMock = mock.fn((_path: string) => {
    callCount++;
    if (callCount === 1) {
      return {
        "agent:main:main": {
          totalTokens: MESSAGE_SUMMARY_WARNING_TOKENS + 100,
          totalTokensFresh: true,
          compactionCount: 1,
        } satisfies SessionEntry,
      };
    }
    return {}; // second call: session vanished
  });

  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );

  const { api, saveSessionStore, capturedHandler } = makeMockApi({}, { loadOverride: loadSessionStoreMock });
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize, messagesAppend }, emitted));

  // Must not throw.
  await assert.doesNotReject(() => capturedHandler()(makeEvent(), INTERACTIVE_CTX));

  // saveSessionStore must NOT be called (entry vanished).
  assert.equal(saveSessionStore.mock.callCount(), 0, "saveSessionStore must not fire when entry vanished");

  // Mirror still runs (mirror is independent of the session store write).
  assert.equal(messagesAppend.mock.callCount(), 1, "recall mirror should still run");

  // Debug log for vanished entry.
  const debugMsgs = logger.debug.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    debugMsgs.some((m) => /session entry vanished/i.test(m)),
    `expected vanished-entry debug log; got: ${debugMsgs.join(" | ")}`,
  );
});

test("6c.6.3: recall mirror fails after metadata write → warn + emit_failed; hook does NOT re-throw", async () => {
  // The metadata write succeeded; the mirror failed. Next agent_end will catch up.
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());
  const messagesAppend = mock.fn(async (): Promise<MessagesAppendResult> => {
    throw new Error("recall sidecar unavailable");
  });

  const { api, saveSessionStore, capturedHandler } = makeMockApi(STORE_WITH_COMPACTION_COUNT);
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize, messagesAppend }, emitted));

  await assert.doesNotReject(() => capturedHandler()(makeEvent(), INTERACTIVE_CTX));

  // Metadata write still happened.
  assert.equal(saveSessionStore.mock.callCount(), 1, "session metadata write should still fire");

  // warn log.
  assert.ok(
    logger.warn.mock.calls.some((c) => /flush recall mirror failed/i.test(String(c.arguments[0]))),
    "warn log should mention mirror failure",
  );

  // emit_failed with operation=messagesAppend.
  const failed = emitted.find((e) => e.kind === "emit_failed");
  assert.ok(failed, "emit_failed should fire");
  assert.equal(failed!.meta?.operation, "messagesAppend");
  assert.match(String(failed!.meta?.reason), /recall sidecar unavailable/);

  // flush_applied must NOT fire (mirror didn't succeed).
  assert.ok(!emitted.some((e) => e.kind === "flush_applied"), "flush_applied must not fire when mirror fails");
});

test("6c.6.3: session store write fails → warn + emit_failed; recall mirror still runs; hook does NOT re-throw", async () => {
  // Store save failure is recoverable; the flush metadata coordination misses
  // this cycle but the recall mirror can still run.
  const getStats = mock.fn(async (): Promise<StatsResponse> => ({ totalMessageCount: 5 }));
  const summarize = mock.fn(async (): Promise<SummarizeResult> => makeSummarizeResult());
  const messagesAppend = mock.fn(
    async (_msgs: unknown[]): Promise<MessagesAppendResult> => ({ appended: 1 }),
  );
  const saveSessionStoreMock = mock.fn(async () => {
    throw new Error("disk write error");
  });
  const loadOverride = mock.fn((_path: string) => STORE_WITH_COMPACTION_COUNT);

  const { api, capturedHandler } = makeMockApi(STORE_WITH_COMPACTION_COUNT, { loadOverride });
  (api as unknown as { runtime: { agent: { session: { saveSessionStore: unknown } } } })
    .runtime.agent.session.saveSessionStore = saveSessionStoreMock;

  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  registerFlushPressureHook(api, makeDeps(logger, { getStats, summarize, messagesAppend }, emitted));

  await assert.doesNotReject(() => capturedHandler()(makeEvent(), INTERACTIVE_CTX));

  // Warn log for store failure.
  assert.ok(
    logger.warn.mock.calls.some((c) => /flush metadata write failed/i.test(String(c.arguments[0]))),
    "warn log should mention metadata write failure",
  );

  // emit_failed for sessionStore.
  const storeFailed = emitted.find((e) => e.kind === "emit_failed" && e.meta?.operation === "sessionStore");
  assert.ok(storeFailed, "emit_failed{operation:sessionStore} should fire");

  // recall mirror still ran.
  assert.equal(messagesAppend.mock.callCount(), 1, "mirror should still run after store failure");

  // flush_applied fires (mirror succeeded).
  assert.ok(emitted.some((e) => e.kind === "flush_applied"), "flush_applied should fire when mirror succeeded");
});
