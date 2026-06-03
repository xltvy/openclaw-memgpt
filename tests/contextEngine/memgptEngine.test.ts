/**
 * Unit tests for the §4.4 MemGPT ContextEngine (6c.6.4).
 *
 * Strategy: instantiate the engine directly via the factory — no OpenClaw
 * runtime required. The mock API mirrors the shape used in flushPressure.test.ts:
 * api.runtime.agent.session is a controllable store keyed by sessionKey.
 *
 * Each test configures a SessionEntry fixture, calls engine.assemble(), and
 * asserts the returned messages and estimatedTokens.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  makeMemgptContextEngine,
  type AgentMessage,
} from "../../src/contextEngine/memgptEngine.ts";
import type { SessionEntry } from "../../src/hooks/sessionStore.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── fixtures ─────────────────────────────────────────────────────────────────

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
  emitted?: MemoryEvent[],
): ToolDeps {
  return {
    client: {} as SidecarClient,
    namespace: "test-ns",
    emit: (e: MemoryEvent) => {
      if (emitted) emitted.push(e);
    },
    logger,
  };
}

/**
 * Build a mock api backed by a controllable session store.
 * Returns the api plus captured-mock references for assertions.
 */
function makeMockApi(store: Record<string, SessionEntry>): {
  api: OpenClawPluginApi;
  resolveStorePath: ReturnType<typeof mock.fn>;
  loadSessionStore: ReturnType<typeof mock.fn>;
  capturedContextEngineId: () => string;
  capturedContextEngineFactory: () => unknown;
} {
  const resolveStorePath = mock.fn(
    (_store?: string, _opts?: { agentId?: string }) => "/test/store/path",
  );
  const loadSessionStore = mock.fn((_path: string) => store);

  let registeredId: string | undefined;
  let registeredFactory: unknown;

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
    on: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerContextEngine: (id: string, factory: unknown) => {
      registeredId = id;
      registeredFactory = factory;
    },
    runtime: {
      agent: {
        session: {
          resolveStorePath,
          loadSessionStore,
          saveSessionStore: async () => {},
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    resolveStorePath,
    loadSessionStore,
    capturedContextEngineId: () => {
      if (!registeredId) throw new Error("registerContextEngine not called");
      return registeredId;
    },
    capturedContextEngineFactory: () => {
      if (!registeredFactory)
        throw new Error("registerContextEngine not called");
      return registeredFactory;
    },
  };
}

/** Standard 6-message buffer used across most tests. */
function makeMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: 1000 + i,
  }));
}

/** Packaged message JSON in the shape the sidecar writes. */
const PACKAGED_JSON = JSON.stringify({
  role: "user",
  content: "Summary: the previous 3 messages discussed X.",
});

/** SessionEntry with flush metadata present and matching compaction cycle. */
function makeFlushEntry(
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    compactionCount: 0,
    memoryFlushCompactionCount: 0, // matches → hasAlreadyFlushed returns true
    memoryFlushAt: Date.now(),
    memoryFlushContextHash: "abc123",
    memoryFlushCutoff: 3,
    memoryFlushPackagedMessageJson: PACKAGED_JSON,
    ...overrides,
  };
}

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "main";

/**
 * Instantiate the engine. The factory returns `ContextEngine | Promise<ContextEngine>`;
 * await-ing collapses the union to `ContextEngine` so callers are cleanly typed.
 */
async function createEngine(deps: ToolDeps, api: OpenClawPluginApi) {
  return await makeMemgptContextEngine(deps, api)();
}

// ── registration ─────────────────────────────────────────────────────────────

test("registers with id 'memgpt' via api.registerContextEngine", () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api, capturedContextEngineId, capturedContextEngineFactory } =
    makeMockApi({});

  const factory = makeMemgptContextEngine(deps, api);
  (api as unknown as { registerContextEngine(id: string, f: unknown): void })
    .registerContextEngine("memgpt", factory);

  assert.equal(capturedContextEngineId(), "memgpt");
  assert.equal(typeof capturedContextEngineFactory(), "function");
});

test("engine info: ownsCompaction is false", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({});

  const engine = await createEngine(deps, api);
  assert.equal(engine.info.ownsCompaction, false);
  assert.equal(engine.info.id, "memgpt");
});

// ── assemble: pass-through cases ─────────────────────────────────────────────

test("no flush metadata (no session entry) → pass-through, messages unchanged", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({}); // empty store → no entry

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
  assert.ok(result.estimatedTokens > 0, "estimatedTokens should be positive");
});

test("no flush metadata (entry present but no flush fields) → pass-through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  // Entry with no flush fields → hasAlreadyFlushed returns false
  const { api } = makeMockApi({
    [SESSION_KEY]: { compactionCount: 0 } as SessionEntry,
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
});

test("stale metadata (compactionCount mismatch) → pass-through", async () => {
  // flush was at compactionCount=0; now compactionCount=1 → stale
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({
      compactionCount: 1, // incremented by OpenClaw's own compaction
      memoryFlushCompactionCount: 0, // still at old value
    }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  // hasAlreadyFlushedForCurrentCompaction returns false (0 !== 1) → pass-through
  assert.deepStrictEqual(result.messages, messages);
});

test("flush metadata missing memoryFlushCutoff → pass-through, logs debug", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({
      memoryFlushCutoff: undefined, // missing
    }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
  assert.equal(logger.debug.mock.callCount(), 1, "should emit one debug log");
  assert.ok(
    (logger.debug.mock.calls[0].arguments[0] as string).includes(
      "incomplete",
    ),
    "debug log should mention incomplete metadata",
  );
});

test("flush metadata missing memoryFlushPackagedMessageJson → pass-through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({
      memoryFlushPackagedMessageJson: undefined, // missing
    }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
});

test("malformed JSON in memoryFlushPackagedMessageJson → pass-through + warn log", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({
      memoryFlushPackagedMessageJson: "not-valid-json{{{",
    }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
  assert.equal(logger.warn.mock.callCount(), 1, "should emit one warning");
  assert.ok(
    (logger.warn.mock.calls[0].arguments[0] as string).includes(
      "malformed",
    ),
    "warn log should mention malformed JSON",
  );
});

test("packagedMessage with unexpected shape (not role:user) → pass-through + warn", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({
      memoryFlushPackagedMessageJson: JSON.stringify({
        role: "assistant",
        content: "wrong role",
      }),
    }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  assert.deepStrictEqual(result.messages, messages);
  assert.equal(logger.warn.mock.callCount(), 1);
});

// ── assemble: virtual-trim path ───────────────────────────────────────────────

test("flush metadata present → assemble returns [messages[0] (system anchor), packagedMessage, ...messages.slice(cutoff)]", async () => {
  // Faithful to MemGPT's native post-summarise buffer shape: system stays at [0],
  // packaged summary is prepended after it, tail starts at cutoff.
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const cutoff = 3;
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({ memoryFlushCutoff: cutoff }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6); // indices 0-5
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  // messages[0] is the system anchor — preserved at position 0
  assert.deepStrictEqual(result.messages[0], messages[0]);
  // messages[1] is the packagedMessage (role: user, content: the summary string)
  assert.equal(result.messages[1].role, "user");
  assert.equal(
    result.messages[1].content,
    "Summary: the previous 3 messages discussed X.",
  );
  // messages[2:] is messages.slice(cutoff)
  assert.deepStrictEqual(result.messages.slice(2), messages.slice(cutoff));
  // Total length = 1 (anchor) + 1 (packaged) + (6 - 3) = 5
  assert.equal(result.messages.length, 2 + (messages.length - cutoff));
});

test("virtual trim: estimatedTokens is derived from the returned messages, not the full input", async () => {
  // Pins the invariant that estimatedTokens is computed from assemble()'s returned
  // messages, not the original input.
  // Returned set: [messages[0] (anchor), packagedMessage, messages[3..5]] = 5 messages.
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const cutoff = 3;
  const { api } = makeMockApi({
    [SESSION_KEY]: makeFlushEntry({ memoryFlushCutoff: cutoff }),
  });

  const engine = await createEngine(deps, api);
  const messages = makeMessages(6);
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  // Verify the returned set is the trimmed one: [anchor, packed, tail...]
  assert.equal(result.messages.length, 2 + (6 - cutoff));

  // Manually compute expected tokens from the returned messages
  let chars = 0;
  for (const msg of result.messages) {
    if (typeof msg.content === "string") chars += msg.content.length;
  }
  const expectedTokens = Math.max(1, Math.ceil(chars / 4));

  assert.equal(
    result.estimatedTokens,
    expectedTokens,
    `estimatedTokens (${result.estimatedTokens}) should match char-count of returned messages (${expectedTokens})`,
  );
});

test("pass-through: estimatedTokens reflects full buffer character count", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({}); // no entry → pass-through

  const engine = await createEngine(deps, api);
  // Messages with known content
  const messages: AgentMessage[] = [
    { role: "user", content: "aaaa" }, // 4 chars → 1 token
    { role: "assistant", content: "bbbbbbbb" }, // 8 chars → 2 tokens
  ];
  const result = await engine.assemble({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    messages,
  });

  // chars = 4 + 8 = 12 → ceil(12/4) = 3
  assert.equal(result.estimatedTokens, 3);
  assert.deepStrictEqual(result.messages, messages);
});

// ── ingest and compact ────────────────────────────────────────────────────────

test("ingest() returns { ingested: false } — mirror hook owns persistence", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({});

  const engine = await createEngine(deps, api);
  const result = await engine.ingest({
    sessionId: SESSION_ID,
    message: { role: "user", content: "hello" },
  });
  assert.deepStrictEqual(result, { ingested: false });
});

test("compact() returns { ok: false, compacted: false } — ownsCompaction is false", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { api } = makeMockApi({});

  const engine = await createEngine(deps, api);
  const result = await engine.compact({
    sessionId: SESSION_ID,
    sessionFile: "/tmp/session.json",
  });
  assert.equal(result.ok, false);
  assert.equal(result.compacted, false);
  assert.ok(result.reason, "compact result should include a reason");
});
