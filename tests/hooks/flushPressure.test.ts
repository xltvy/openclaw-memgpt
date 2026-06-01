/**
 * Unit tests for the §4.4 flush-pressure check on before_prompt_build.
 *
 * 6c.6.1 scope: trigger predicate only — no summariser call yet (that's
 * 6c.6.2). Tests assert:
 *   - registration shape (api.on called with "before_prompt_build")
 *   - guards skip before any session-store access (non-interactive, subagent,
 *     missing sessionKey/agentId)
 *   - missing entry (first turn) → silent skip
 *   - stale snapshot → debug log + skip (no info log)
 *   - below threshold + fresh → silent skip
 *   - above threshold + fresh → info log "flush threshold tripped"
 *   - the threshold value matches §4.4 / fork constants (6000)
 *
 * api.runtime.agent.session is mocked — a synthetic store keyed by
 * sessionKey lets each test control entry presence + token values.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  MESSAGE_SUMMARY_WARNING_TOKENS,
  registerFlushPressureHook,
} from "../../src/hooks/flushPressure.ts";
import type { SessionEntry } from "../../src/hooks/sessionStore.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
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

function makeDeps(logger: CapturedLogger): ToolDeps {
  return {
    client: {} as SidecarClient,
    namespace: "test-ns",
    emit: (_e: MemoryEvent) => {},
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
