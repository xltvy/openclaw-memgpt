/**
 * Unit tests for the V2.1 finalizeGuard hook (the MemGPT "bouncer" analogue).
 *
 * Sidecar-free: the hook never touches the sidecar. Covers V2.1 brief
 * scenarios 1 (free-text-only → revise), 2/3 (send_message fired → no
 * revise, chained or bare), 4 (revise shape: instruction / maxAttempts /
 * idempotencyKey / observability event), 5 (turn-boundary reset — per-turn
 * independence, the inverse of the retired reply_dispatch stale-flag bug),
 * plus guards (non-interactive, subagent, unconfigured, dead, guard
 * exception).
 */

import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  REVISE_IDEMPOTENCY_KEY,
  REVISE_MAX_ATTEMPTS,
  SEND_MESSAGE_REVISE_INSTRUCTION,
  registerFinalizeGuardHook,
} from "../../src/hooks/finalizeGuard.ts";
import {
  SEND_MESSAGE_V1_KEY,
  _resetSendMessageFlagsForTests,
  markSendMessageFired,
  peekSendMessageFired,
} from "../../src/tools/sendMessage.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

beforeEach(() => {
  _resetSendMessageFlagsForTests();
});

// ── helpers ────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makeLogger(): ToolDeps["logger"] & { warned: string[] } {
  const warned: string[] = [];
  return {
    info: () => {},
    debug: () => {},
    warn: (msg: string) => {
      warned.push(msg);
    },
    error: () => {},
    warned,
  } as ToolDeps["logger"] & { warned: string[] };
}

function makeDeps(
  logger: ReturnType<typeof makeLogger>,
  lifecycle?: ToolDeps["lifecycle"],
): ToolDeps & { emitted: MemoryEvent[] } {
  const emitted: MemoryEvent[] = [];
  return {
    client: {} as ToolDeps["client"],
    namespace: "test-ns",
    emit: (e: MemoryEvent) => emitted.push(e),
    logger,
    lifecycle,
    emitted,
  };
}

function captureHandlers(deps: ToolDeps): {
  finalize: Handler;
  promptBuild: Handler;
} {
  let finalize: Handler | undefined;
  let promptBuild: Handler | undefined;
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    registerTool: () => {},
    on: mock.fn((hookName: string, h: Handler) => {
      if (hookName === "before_agent_finalize") finalize = h;
      if (hookName === "before_prompt_build") promptBuild = h;
    }),
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;

  registerFinalizeGuardHook(api, deps);
  if (!finalize) throw new Error("hook did not register before_agent_finalize");
  if (!promptBuild) throw new Error("hook did not register before_prompt_build");
  return { finalize, promptBuild };
}

function makeFinalizeEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    sessionKey: "sess:interactive:abc123",
    lastAssistantMessage: "I'll remember that about you.",
    stopHookActive: false,
    ...overrides,
  };
}

const interactiveCtx = { sessionKey: "sess:interactive:abc123" };

// ── scenario 4 / 1 — free-text-only turn → revise ──────────────────────────

test("no send_message this turn: returns revise with the verbatim instruction, maxAttempts, idempotencyKey", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = (await finalize(makeFinalizeEvent(), interactiveCtx)) as {
    action: string;
    retry: { instruction: string; maxAttempts: number; idempotencyKey: string };
  };

  assert.equal(result?.action, "revise");
  assert.equal(result?.retry?.instruction, SEND_MESSAGE_REVISE_INSTRUCTION);
  assert.equal(result?.retry?.maxAttempts, REVISE_MAX_ATTEMPTS);
  assert.equal(result?.retry?.idempotencyKey, REVISE_IDEMPOTENCY_KEY);
});

test("instruction carries the belt sentence verbatim (memgpt_base.txt:19)", () => {
  assert.ok(
    SEND_MESSAGE_REVISE_INSTRUCTION.includes(
      "'send_message' is the ONLY action that sends a notification to the user, the user does not see anything else you do.",
    ),
    "belt sentence must be reproduced verbatim — the string the model was trained against",
  );
});

test("revise path emits finalize_revision_requested with length meta + verbose text content", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const text = "free text that would have leaked";
  await finalize(makeFinalizeEvent({ lastAssistantMessage: text }), interactiveCtx);

  const evt = deps.emitted.find((e) => e.kind === "finalize_revision_requested");
  assert.ok(evt, "finalize_revision_requested must be emitted");
  assert.equal(evt?.meta?.length, text.length);
  assert.equal(evt?.content?.text, text);
});

test("emit failure does not block the revision (best-effort observability)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  deps.emit = () => {
    throw new Error("emitter down");
  };
  const { finalize } = captureHandlers(deps);

  const result = (await finalize(makeFinalizeEvent(), interactiveCtx)) as {
    action: string;
  };
  assert.equal(result?.action, "revise", "revise must still be returned");
  assert.equal(logger.warned.length, 1);
  assert.match(logger.warned[0]!, /emit failed/);
});

// ── scenarios 2 + 3 — send_message fired (chained or bare) → no revise ─────

test("send_message fired this turn (bare): passes through — no revise", async () => {
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(makeFinalizeEvent(), interactiveCtx);
  assert.equal(result, undefined, "must pass through when discipline is satisfied");
  assert.equal(deps.emitted.length, 0, "no revision event on a clean turn");
});

test("send_message fired after a chained memory op: still passes through (scenario 2)", async () => {
  // The chained shape (core_memory_append → send_message) reaches this hook
  // identically: the flag is set by the send_message handler regardless of
  // what preceded it. The memory op's own recording is the tool tests' job.
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(
    makeFinalizeEvent({ lastAssistantMessage: "trailing text after send_message" }),
    interactiveCtx,
  );
  assert.equal(result, undefined);
});

test("peek is non-consuming: two finalize passes in one turn both see the flag", async () => {
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  assert.equal(await finalize(makeFinalizeEvent(), interactiveCtx), undefined);
  assert.equal(await finalize(makeFinalizeEvent(), interactiveCtx), undefined);
  assert.equal(peekSendMessageFired(SEND_MESSAGE_V1_KEY), true);
});

// ── scenario 5 — turn-boundary reset (per-turn independence) ───────────────

test("before_prompt_build clears the flag: turn N's send_message does not shield turn N+1", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize, promptBuild } = captureHandlers(deps);

  // Turn N: send_message fired → finalize passes through.
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  assert.equal(await finalize(makeFinalizeEvent(), interactiveCtx), undefined);

  // Turn N+1 starts: prompt build resets the flag.
  await promptBuild({}, {});
  assert.equal(peekSendMessageFired(SEND_MESSAGE_V1_KEY), false);

  // Turn N+1: free text without send_message → revise. (The inverse of the
  // retired reply_dispatch bug, where turn N's flag leaked into turn N+1.)
  const result = (await finalize(makeFinalizeEvent(), interactiveCtx)) as {
    action: string;
  };
  assert.equal(result?.action, "revise");
});

test("before_prompt_build reset contributes nothing to the prompt (returns undefined)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { promptBuild } = captureHandlers(deps);
  assert.equal(await promptBuild({}, {}), undefined);
});

// ── guards ─────────────────────────────────────────────────────────────────

test("non-interactive trigger (ctx.trigger=cron): passes through, no revise", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(makeFinalizeEvent(), {
    trigger: "cron",
    sessionKey: "sess:interactive:abc123",
  });
  assert.equal(result, undefined);
});

test("non-interactive session key (:heartbeat:): passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(
    makeFinalizeEvent({ sessionKey: "sess:heartbeat:tick" }),
    {},
  );
  assert.equal(result, undefined);
});

test("subagent session: passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(
    makeFinalizeEvent({ sessionKey: "sess:subagent:child42" }),
    {},
  );
  assert.equal(result, undefined);
});

test("unconfigured plugin: passes through (must not interfere with host reply path)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    isConfigured: false,
  } as unknown as ToolDeps["lifecycle"]);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(makeFinalizeEvent(), interactiveCtx);
  assert.equal(result, undefined);
});

test("dead sidecar: passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    isConfigured: true,
    isDead: true,
  } as unknown as ToolDeps["lifecycle"]);
  const { finalize } = captureHandlers(deps);

  const result = await finalize(makeFinalizeEvent(), interactiveCtx);
  assert.equal(result, undefined);
});

test("guard exception: logs warn, passes through, host finalize not broken", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { finalize } = captureHandlers(deps);

  const badEvent = new Proxy(
    { lastAssistantMessage: "text" },
    {
      get(target, prop) {
        if (prop === "sessionKey") throw new TypeError("bad shape");
        return (target as Record<string | symbol, unknown>)[prop as string];
      },
    },
  );

  const result = await finalize(badEvent, {});
  assert.equal(result, undefined, "must pass through when guards throw");
  assert.equal(logger.warned.length, 1);
  assert.match(logger.warned[0]!, /guards threw/);
});
