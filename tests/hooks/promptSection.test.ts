/**
 * Unit tests for the §4.2 before_prompt_build hook.
 *
 * Sidecar-free: partial-mock client, hand-driven handler invocation. The
 * §4.2 contract being asserted:
 *   - ensure called first, then getSystemPromptSection
 *   - return = {prependSystemContext: static, prependContext: dynamic}
 *   - one agent_ensured event per turn, carrying via
 *   - ensure failure propagates (residency call) + emits emit_failed before throwing;
 *     getSystemPromptSection failure propagates too. Only the via *emit* is best-effort.
 *   - persona/human edits move dynamic, leave static unchanged (the load-bearing test)
 *
 * Live-sidecar round-trip lives in promptSectionIntegration.test.ts so this
 * file stays sidecar-free and fast.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { registerPromptSectionHook } from "../../src/hooks/promptSection.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── helpers ────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/**
 * Capture the handler `api.on("before_prompt_build", ...)` registers so the
 * test can invoke it directly. Asserts the registration shape and returns
 * the captured handler + the mock for further assertions.
 */
function captureHookHandler(
  deps: ToolDeps,
): { handler: Handler; onMock: ReturnType<typeof mock.fn> } {
  let captured: Handler | undefined;
  const onMock = mock.fn((event: string, handler: Handler) => {
    if (event === "before_prompt_build") captured = handler;
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
  registerPromptSectionHook(api, deps);
  if (!captured) throw new Error("hook did not register before_prompt_build");
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

function makeDeps(
  clientStub: Partial<SidecarClient>,
): ToolDeps & {
  emitted: MemoryEvent[];
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  const emitted: MemoryEvent[] = [];
  return {
    client: clientStub as SidecarClient,
    namespace: "test-ns",
    emit: (event: MemoryEvent) => emitted.push(event),
    logger,
    emitted,
  };
}

// ── 1. registration shape ──────────────────────────────────────────────────

test("registerPromptSectionHook: calls api.on once with 'before_prompt_build'", () => {
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () => ({
      section: "S+D",
      static: "S",
      dynamic: "D",
    }),
  });
  const { onMock } = captureHookHandler(deps);
  assert.equal(onMock.mock.callCount(), 1);
  assert.equal(onMock.mock.calls[0].arguments[0], "before_prompt_build");
});

// ── 2. order assertion ────────────────────────────────────────────────────

test("hook calls ensure before getSystemPromptSection (per-turn ensure first for via)", async () => {
  const callOrder: string[] = [];
  const deps = makeDeps({
    ensure: async () => {
      callOrder.push("ensure");
      return { agentId: "test-ns", via: "resident" as const };
    },
    getSystemPromptSection: async () => {
      callOrder.push("getSystemPromptSection");
      return { section: "S+D", static: "S", dynamic: "D" };
    },
  });
  const { handler } = captureHookHandler(deps);
  await handler({}, {});
  assert.deepEqual(callOrder, ["ensure", "getSystemPromptSection"]);
});

// ── 3. return shape mapping ────────────────────────────────────────────────

test("hook returns {prependSystemContext: static, prependContext: dynamic}", async () => {
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () => ({
      section: "STATIC + DYNAMIC",
      static: "STATIC",
      dynamic: "DYNAMIC",
    }),
  });
  const { handler } = captureHookHandler(deps);
  const r = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext?: string;
  };
  assert.deepEqual(r, {
    prependSystemContext: "STATIC",
    prependContext: "DYNAMIC",
  });
});

test("hook omits prependContext when dynamic is empty/undefined (clean optional)", async () => {
  // Per §4.2's code: `prependContext: dynamicSection ?? undefined`. If the
  // sidecar ever returns an empty dynamic, the field is absent rather than
  // an empty string — keeps OpenClaw's prompt assembly clean.
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () =>
      ({
        section: "STATIC",
        static: "STATIC",
        dynamic: undefined as unknown as string,
      }),
  });
  const { handler } = captureHookHandler(deps);
  const r = (await handler({}, {})) as Record<string, unknown>;
  assert.equal(r.prependSystemContext, "STATIC");
  assert.ok(
    !("prependContext" in r),
    "prependContext should be absent when dynamic is undefined",
  );
});

// ── 4. emit per invocation ────────────────────────────────────────────────

test("hook emits exactly one agent_ensured event per invocation with via field", async () => {
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () => ({
      section: "S+D",
      static: "S",
      dynamic: "D",
    }),
  });
  const { handler } = captureHookHandler(deps);
  await handler({}, {});
  assert.equal(deps.emitted.length, 1);
  assert.equal(deps.emitted[0].kind, "agent_ensured");
  assert.equal(deps.emitted[0].namespace, "test-ns");
  assert.deepEqual(deps.emitted[0].meta, { via: "resident" });
  assert.equal(typeof deps.emitted[0].ts, "string", "ts should be set per §4.2 pattern");
});

test("hook emits via:'load' / 'create' faithfully — observability discriminates residency", async () => {
  // The point of the per-turn ensure is to surface unexpected residency
  // changes (e.g. sidecar restart eviction shows as via:"load" instead of
  // via:"resident"). Pin that the via value isn't normalised on the way out.
  for (const via of ["resident", "load", "create"] as const) {
    const deps = makeDeps({
      ensure: async () => ({ agentId: "test-ns", via }),
      getSystemPromptSection: async () => ({
        section: "S+D",
        static: "S",
        dynamic: "D",
      }),
    });
    const { handler } = captureHookHandler(deps);
    await handler({}, {});
    assert.equal(deps.emitted[0].meta?.via, via);
  }
});

// ── 5. persona/human in dynamic, not static (load-bearing) ─────────────────

test("persona/human edits surface in prependContext; prependSystemContext unchanged", async () => {
  // The §2.4 / §4.2 invariant: static = adapted base prompt (cacheable);
  // dynamic = persona/human/counts (rotates on core-memory edits). If a
  // core_memory_append landed in the static side, OpenClaw would invalidate
  // its prompt cache every edit; if it landed nowhere, the LLM wouldn't see
  // the new content. Both halves of the split must hold simultaneously —
  // hence two assertions per turn.
  const dynamicByCall = [
    "persona: helpful\nhuman: name=alice",
    "persona: helpful\nhuman: name=alice\nNEW-NOTE",
  ];
  let call = 0;
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () => ({
      section: `STATIC\n${dynamicByCall[call]}`,
      static: "STATIC",
      dynamic: dynamicByCall[call++],
    }),
  });
  const { handler } = captureHookHandler(deps);

  const turn1 = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext?: string;
  };
  const turn2 = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext?: string;
  };

  // Both halves of the split:
  assert.notEqual(
    turn1.prependContext,
    turn2.prependContext,
    "prependContext (dynamic) must reflect the core-memory edit",
  );
  assert.ok(
    turn2.prependContext?.includes("NEW-NOTE"),
    "appended content must appear in prependContext",
  );
  assert.equal(
    turn1.prependSystemContext,
    turn2.prependSystemContext,
    "prependSystemContext (static) must be unchanged across the edit — caching invariant",
  );
});

// ── 6. error asymmetry per §4.2 ────────────────────────────────────────────

test("ensure failure → propagates; logger.error + emit_failed event; turn fails", async () => {
  // ensure is the residency call: a failed ensure means the agent is NOT
  // resident, so swallowing it would only defer the failure to a misleading
  // "not resident" 404 in step 2 / the tools (the masking that hid the
  // multi-sidecar bug). Behaviour: log error, emit emit_failed, re-throw the
  // original. Step 2 must never run.
  const ensureErr = new Error("sidecar 503");
  let step2Called = false;
  const deps = makeDeps({
    ensure: async () => {
      throw ensureErr;
    },
    getSystemPromptSection: async () => {
      step2Called = true;
      return { section: "S+D", static: "S", dynamic: "D" };
    },
  });
  const { handler } = captureHookHandler(deps);
  await assert.rejects(
    () => handler({}, {}),
    (err) => err === ensureErr,
  );
  // Step 2 short-circuited — an un-resident agent isn't asked for its prompt.
  assert.equal(step2Called, false);
  // Error logged with the real cause (not a misleading "emit failed").
  assert.equal(deps.logger.errored.length, 1);
  assert.match(deps.logger.errored[0], /agent ensure failed/);
  assert.match(deps.logger.errored[0], /sidecar 503/);
  // Telemetry event still emitted with the operation + reason before the throw.
  assert.equal(deps.emitted.length, 1);
  assert.equal(deps.emitted[0].kind, "emit_failed");
  assert.equal(deps.emitted[0].meta?.operation, "ensure");
  assert.match(String(deps.emitted[0].meta?.reason), /sidecar 503/);
});

test("getSystemPromptSection failure → propagates; logger.error called first", async () => {
  // §4.2 correctness path: the prompt section is load-bearing. Silently
  // degrading would leave the agent with a corrupted prompt, which is worse
  // than a failed turn. Behaviour: log error, then re-throw the original.
  const transportErr = new Error("getSystemPromptSection 500");
  const deps = makeDeps({
    ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
    getSystemPromptSection: async () => {
      throw transportErr;
    },
  });
  const { handler } = captureHookHandler(deps);
  await assert.rejects(
    () => handler({}, {}),
    (err) => err === transportErr,
  );
  assert.equal(deps.logger.errored.length, 1);
  assert.match(deps.logger.errored[0], /getSystemPromptSection failed/);
  assert.match(deps.logger.errored[0], /getSystemPromptSection 500/);
});

test("via emit is best-effort — a throwing emit does not fail an otherwise-good turn", async () => {
  // The residency call is load-bearing, but *recording* its `via` telemetry is
  // not. If the emitter throws on the success-path agent_ensured event, the
  // turn must still return the prompt contribution (ensure already succeeded).
  const logger = makeLogger();
  let emitCalls = 0;
  const deps: ToolDeps & { logger: ReturnType<typeof makeLogger> } = {
    client: {
      ensure: async () => ({ agentId: "test-ns", via: "resident" as const }),
      getSystemPromptSection: async () => ({
        section: "S+D",
        static: "STATIC",
        dynamic: "DYNAMIC",
      }),
    } as unknown as SidecarClient,
    namespace: "test-ns",
    emit: () => {
      emitCalls++;
      throw new Error("emitter down");
    },
    logger,
  };
  const { handler } = captureHookHandler(deps);
  const r = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext?: string;
  };
  assert.deepEqual(r, {
    prependSystemContext: "STATIC",
    prependContext: "DYNAMIC",
  });
  assert.equal(emitCalls, 1, "the success-path via emit was attempted");
});
