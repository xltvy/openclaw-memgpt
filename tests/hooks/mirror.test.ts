/**
 * Unit tests for the §4.5 agent_end mirror+save hook.
 *
 * Sidecar-free: partial-mock client + captured-handler pattern (same shape
 * as promptSection.test.ts). Asserts:
 *   - registration shape (api.on called once with "agent_end")
 *   - guards skip non-persistable turns in isolation (4 cases)
 *   - happy path: messagesAppend called once with all v0 messages; save
 *     called once after; mirror-then-save order asserted
 *   - §3.7 normalisation boundary first-consumed here: OpenClaw-shape
 *     messages with tool_calls land at the client as v0 function_call
 *   - error asymmetry (mirror re-throws; save swallows)
 *   - observability events (messages_mirrored / agent_saved / emit_failed)
 *
 * Live-sidecar round-trip lives in mirrorIntegration.test.ts.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { registerAgentEndHook } from "../../src/hooks/mirror.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── helpers ────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function captureHookHandler(deps: ToolDeps): {
  handler: Handler;
  onMock: ReturnType<typeof mock.fn>;
} {
  let captured: Handler | undefined;
  const onMock = mock.fn((event: string, handler: Handler) => {
    if (event === "agent_end") captured = handler;
  });
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    resolvePath: (p: string) => p,
    registerTool: () => {},
    on: onMock,
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;
  registerAgentEndHook(api, deps);
  if (!captured) throw new Error("hook did not register agent_end");
  return { handler: captured, onMock };
}

function makeLogger(): ToolDeps["logger"] & {
  warned: string[];
  errored: string[];
} {
  const warned: string[] = [];
  const errored: string[] = [];
  return {
    info: () => {},
    warn: (msg: string) => warned.push(msg),
    error: (msg: string) => errored.push(msg),
    debug: () => {},
    warned,
    errored,
  };
}

function makeDeps(clientStub: Partial<SidecarClient>): ToolDeps & {
  emitted: MemoryEvent[];
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  return {
    client: clientStub as SidecarClient,
    namespace: "test-ns",
    emit: (e: MemoryEvent) => emitted.push(e),
    logger,
    emitted,
  };
}

/** A representative interactive context — passes both guards. */
const INTERACTIVE_CTX = { trigger: "user", sessionKey: "agent:main:main" };

/** A representative happy-path turn (3 messages). */
function makeHappyEvent() {
  return {
    success: true,
    messages: [
      { role: "user", content: "search for X" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "archival_memory_search",
              arguments: '{"query":"X"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "No results found.",
        tool_call_id: "call_1",
        name: "archival_memory_search",
      },
    ],
  };
}

// ── 1. registration shape ──────────────────────────────────────────────────

test("registerAgentEndHook: calls api.on once with 'agent_end'", () => {
  const deps = makeDeps({
    messagesAppend: async () => ({ appended: 0 }),
    save: async () => ({ saved: true as const }),
  });
  const { onMock } = captureHookHandler(deps);
  assert.equal(onMock.mock.callCount(), 1);
  assert.equal(onMock.mock.calls[0].arguments[0], "agent_end");
});

// ── 2. guards (4 cases, each in isolation) ─────────────────────────────────

test("guard: !event.success → no mirror, no save", async () => {
  const append = mock.fn(async () => ({ appended: 0 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({ messagesAppend: append, save });
  const { handler } = captureHookHandler(deps);
  await handler(
    { success: false, messages: [{ role: "user", content: "hi" }] },
    INTERACTIVE_CTX,
  );
  assert.equal(append.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(deps.emitted.length, 0);
});

test("config gate: unconfigured → no mirror, no save, no log (silent)", async () => {
  const append = mock.fn(async () => ({ appended: 0 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = {
    ...makeDeps({ messagesAppend: append, save }),
    lifecycle: { isConfigured: false } as unknown as ToolDeps["lifecycle"],
  };
  const { handler } = captureHookHandler(deps);
  await handler(makeHappyEvent(), INTERACTIVE_CTX);
  assert.equal(append.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(deps.emitted.length, 0);
  assert.equal(deps.logger.warned.length, 0, "unconfigured skip must be silent");
});

test("guard: empty event.messages → no mirror, no save", async () => {
  const append = mock.fn(async () => ({ appended: 0 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({ messagesAppend: append, save });
  const { handler } = captureHookHandler(deps);
  await handler({ success: true, messages: [] }, INTERACTIVE_CTX);
  assert.equal(append.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

test("guard: non-interactive trigger (cron) → no mirror, no save", async () => {
  // SKIP_TRIGGERS lower-cases trigger; cron-fired turns shouldn't pollute
  // the recall corpus with system-initiated content the user never saw.
  const append = mock.fn(async () => ({ appended: 0 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({ messagesAppend: append, save });
  const { handler } = captureHookHandler(deps);
  await handler(makeHappyEvent(), {
    trigger: "cron",
    sessionKey: "agent:main:main",
  });
  assert.equal(append.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

test("guard: subagent session → no mirror, no save", async () => {
  // Subagent UUIDs create orphaned namespaces that are never read; the
  // parent agent's agent_end captures the consolidated result including
  // subagent output (Mem0 isolation.ts precedent).
  const append = mock.fn(async () => ({ appended: 0 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({ messagesAppend: append, save });
  const { handler } = captureHookHandler(deps);
  await handler(makeHappyEvent(), {
    trigger: "user",
    sessionKey: "agent:main:subagent:abc-123",
  });
  assert.equal(append.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

// ── 3. happy path: per-turn (not per-message) mirroring + ordered save ─────

test("happy path: messagesAppend called exactly once with all 3 messages (per-turn, not per-message)", async () => {
  // §4.5 declared deviation: per-turn mirroring. A 3-message turn produces
  // ONE messagesAppend call with all three messages, NOT three separate
  // calls. Without this, the mirror would behave like native MemGPT's
  // append_to_messages (per-message mid-turn) and the deviation wouldn't
  // actually be exercised.
  //
  // The `_msgs: unknown[]` param on mock.fn is purely for node:test's
  // tuple-typing of `.arguments` (so [0] is well-typed); the body ignores it.
  const append = mock.fn(async (_msgs: unknown[]) => ({ appended: 3 }));
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({ messagesAppend: append, save });
  const { handler } = captureHookHandler(deps);

  await handler(makeHappyEvent(), INTERACTIVE_CTX);

  assert.equal(append.mock.callCount(), 1, "exactly one messagesAppend call");
  const appendedMsgs = append.mock.calls[0].arguments[0];
  assert.equal(appendedMsgs.length, 3, "all 3 messages in one batch");
});

test("happy path: save called exactly once after messagesAppend (mirror-then-save order)", async () => {
  // Order is correctness, not aesthetics: save reads in-memory state, so
  // if save fired first the just-finished turn's messages wouldn't be in
  // pm.all_messages yet and would be missing from the pickle.
  const callOrder: string[] = [];
  const deps = makeDeps({
    messagesAppend: async () => {
      callOrder.push("messagesAppend");
      return { appended: 3 };
    },
    save: async () => {
      callOrder.push("save");
      return { saved: true as const };
    },
  });
  const { handler } = captureHookHandler(deps);

  await handler(makeHappyEvent(), INTERACTIVE_CTX);
  assert.deepEqual(callOrder, ["messagesAppend", "save"]);
});

// ── 4. §3.7 normalisation boundary first-consumed here ─────────────────────

test("normalise: OpenClaw-shape messages → client receives v0 (function_call, no tool_call_id)", async () => {
  // §3.7 first consumer. The hook's job: ingest OpenClaw modern-tools-API
  // messages (tool_calls array, tool role), pass v0 shapes to the client.
  // Without the boundary here, pymemgpt's text_search would match over the
  // wrong field and DummyRecallMemory's role filter would drop messages.
  const append = mock.fn(
    async (_msgs: Array<Record<string, unknown>>) => ({ appended: 3 }),
  );
  const deps = makeDeps({
    messagesAppend: append,
    save: async () => ({ saved: true as const }),
  });
  const { handler } = captureHookHandler(deps);

  await handler(makeHappyEvent(), INTERACTIVE_CTX);

  const msgs = append.mock.calls[0].arguments[0];
  // Message 0: user — passes through.
  assert.equal(msgs[0].role, "user");
  // Message 1: assistant with tool_calls → function_call.
  assert.equal(msgs[1].role, "assistant");
  assert.deepEqual(msgs[1].function_call, {
    name: "archival_memory_search",
    arguments: '{"query":"X"}',
  });
  assert.ok(!("tool_calls" in msgs[1]), "tool_calls must be dropped");
  // Message 2: tool → function.
  assert.equal(msgs[2].role, "function");
  assert.equal(msgs[2].name, "archival_memory_search");
  assert.ok(!("tool_call_id" in msgs[2]), "tool_call_id must be dropped");
});

// ── 5. error asymmetry ────────────────────────────────────────────────────

test("error: messagesAppend fails → hook re-throws, save NOT called, emit_failed emitted", async () => {
  // Mirror failure compounds across turns (messages lost from recall
  // forever), so the hook re-throws to surface it.
  const mirrorErr = new Error("messagesAppend 500");
  const save = mock.fn(async () => ({ saved: true as const }));
  const deps = makeDeps({
    messagesAppend: async () => {
      throw mirrorErr;
    },
    save,
  });
  const { handler } = captureHookHandler(deps);

  await assert.rejects(
    () => handler(makeHappyEvent(), INTERACTIVE_CTX),
    (err) => err === mirrorErr,
  );
  assert.equal(save.mock.callCount(), 0, "save must NOT be called after mirror failure");
  assert.equal(deps.logger.errored.length, 1);
  assert.match(deps.logger.errored[0], /messagesAppend failed/);
  // emit_failed event with operation=messagesAppend
  const emitFailed = deps.emitted.find((e) => e.kind === "emit_failed");
  assert.ok(emitFailed, "emit_failed event should fire");
  assert.equal(emitFailed!.meta?.operation, "messagesAppend");
  assert.match(String(emitFailed!.meta?.reason), /messagesAppend 500/);
});

test("error: save fails → hook does NOT re-throw, mirror was called, emit_failed emitted", async () => {
  // Save failure is recoverable: mirror succeeded so the in-memory state
  // has the messages; next turn's save catches up. Failing the turn over
  // a transient disk hiccup is the worse outcome.
  const append = mock.fn(async () => ({ appended: 3 }));
  const saveErr = new Error("save EBUSY");
  const deps = makeDeps({
    messagesAppend: append,
    save: async () => {
      throw saveErr;
    },
  });
  const { handler } = captureHookHandler(deps);

  // Does NOT throw:
  await assert.doesNotReject(() =>
    handler(makeHappyEvent(), INTERACTIVE_CTX),
  );
  assert.equal(append.mock.callCount(), 1, "mirror was called");
  assert.equal(deps.logger.errored.length, 1);
  assert.match(deps.logger.errored[0], /save failed/);
  const emitFailed = deps.emitted.find((e) => e.kind === "emit_failed");
  assert.ok(emitFailed, "emit_failed event should fire");
  assert.equal(emitFailed!.meta?.operation, "save");
  // messages_mirrored should still have fired (mirror succeeded before save failed)
  assert.ok(
    deps.emitted.some((e) => e.kind === "messages_mirrored"),
    "messages_mirrored should fire even if save subsequently fails",
  );
});

// ── 6. observability events ───────────────────────────────────────────────

test("observability: messages_mirrored has meta.count = message count; agent_saved fires once", async () => {
  const deps = makeDeps({
    messagesAppend: async () => ({ appended: 3 }),
    save: async () => ({ saved: true as const }),
  });
  const { handler } = captureHookHandler(deps);

  await handler(makeHappyEvent(), INTERACTIVE_CTX);

  const mirrored = deps.emitted.filter((e) => e.kind === "messages_mirrored");
  const saved = deps.emitted.filter((e) => e.kind === "agent_saved");
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].meta?.count, 3, "count should match turn message count");
  assert.equal(typeof mirrored[0].ts, "string");
  assert.equal(saved.length, 1);
  assert.equal(typeof saved[0].ts, "string");
});
