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
import type { SessionEntry } from "../../src/hooks/sessionStore.ts";
import { BufferTooSmallError } from "../../src/client/errors.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type {
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
 * tests can assert whether the store was read.
 */
function makeMockApi(store: Record<string, SessionEntry>): {
  api: OpenClawPluginApi;
  resolveStorePath: ReturnType<typeof mock.fn>;
  loadSessionStore: ReturnType<typeof mock.fn>;
  capturedHandler: () => Handler;
} {
  const resolveStorePath = mock.fn(
    (_store?: string, _opts?: { agentId?: string }) => "/test/store/path",
  );
  const loadSessionStore = mock.fn((_path: string) => store);

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
        session: { resolveStorePath, loadSessionStore },
      },
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    resolveStorePath,
    loadSessionStore,
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
