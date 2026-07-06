/**
 * Unit tests for the V2.1 payloadGuard hook (the MemGPT "suspenders" analogue).
 *
 * Sidecar-free: the hook never touches the sidecar. Covers V2.1 brief
 * scenarios 1 (free-text final → cancelled + monologue_suppressed event),
 * 2/3 (send_message's own text rides a `tool` payload — never cancelled),
 * 6 (stock-tool coexistence: tool payloads, error payloads, status notices
 * and media payloads all pass untouched), plus the unconditional-cancel
 * semantics (trailing text after send_message is monologue too) and guards.
 */

import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  MONOLOGUE_CANCEL_REASON,
  registerPayloadGuardHook,
} from "../../src/hooks/payloadGuard.ts";
import {
  SEND_MESSAGE_V1_KEY,
  _resetSendMessageFlagsForTests,
  markSendMessageFired,
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

function captureHandler(deps: ToolDeps): Handler {
  let captured: Handler | undefined;
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    registerTool: () => {},
    on: mock.fn((hookName: string, h: Handler) => {
      if (hookName === "reply_payload_sending") captured = h;
    }),
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;

  registerPayloadGuardHook(api, deps);
  if (!captured) throw new Error("hook did not register reply_payload_sending");
  return captured;
}

function makeEvent(
  kind: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    payload,
    kind,
    sessionKey: "sess:interactive:abc123",
    runId: "run-1",
    ...overrides,
  };
}

// ── scenario 1 — free-text final/block → cancelled as monologue ────────────

test("free-text final payload: cancelled with the monologue reason", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = (await handler(
    makeEvent("final", { text: "I'll remember that about you." }),
    {},
  )) as { cancel: boolean; reason: string };

  assert.equal(result?.cancel, true);
  assert.equal(result?.reason, MONOLOGUE_CANCEL_REASON);
});

test("free-text block payload: cancelled (mid-turn streamed text is monologue too)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = (await handler(
    makeEvent("block", { text: "thinking out loud between tool calls" }),
    {},
  )) as { cancel: boolean };
  assert.equal(result?.cancel, true);
});

test("cancelled payload emits monologue_suppressed with kind/length/hadSendMessage meta + verbose text", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const text = "suppressed free text";
  await handler(makeEvent("final", { text }), {});

  const evt = deps.emitted.find((e) => e.kind === "monologue_suppressed");
  assert.ok(evt, "monologue_suppressed must be emitted");
  assert.equal(evt?.meta?.payloadKind, "final");
  assert.equal(evt?.meta?.length, text.length);
  assert.equal(evt?.meta?.hadSendMessage, false);
  assert.equal(evt?.content?.text, text);
});

test("trailing free text after send_message: still cancelled, hadSendMessage=true provenance", async () => {
  // Native fidelity: assistant content is ALWAYS monologue — a legitimate
  // send_message earlier in the turn doesn't make trailing text user-facing.
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = (await handler(
    makeEvent("final", { text: "trailing commentary" }),
    {},
  )) as { cancel: boolean };
  assert.equal(result?.cancel, true);

  const evt = deps.emitted.find((e) => e.kind === "monologue_suppressed");
  assert.equal(evt?.meta?.hadSendMessage, true);
});

test("emit failure does not block the cancel (best-effort observability)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  deps.emit = () => {
    throw new Error("emitter down");
  };
  const handler = captureHandler(deps);

  const result = (await handler(
    makeEvent("final", { text: "free text" }),
    {},
  )) as { cancel: boolean };
  assert.equal(result?.cancel, true, "cancel must still be returned");
  assert.equal(logger.warned.length, 1);
  assert.match(logger.warned[0]!, /emit failed/);
});

// ── scenarios 2/3/6 — what must never be cancelled ─────────────────────────

test("tool payload: passes through untouched (send_message's text rides a tool result)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent("tool", { text: "hello user — via send_message" }),
    {},
  );
  assert.equal(result, undefined);
  assert.equal(deps.emitted.length, 0);
});

test("tool payload passes through even with the send_message flag set (scenario 2/3 delivery path)", async () => {
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent("tool", { text: "hello user — via send_message" }),
    {},
  );
  assert.equal(result, undefined);
});

test("error payload: passes through (host failures must reach the user)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent("final", { text: "Agent failed: boom", isError: true }),
    {},
  );
  assert.equal(result, undefined);
});

test("status notice: passes through (host-authored progress UI)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent("final", { text: "1. step one", isStatusNotice: true }),
    {},
  );
  assert.equal(result, undefined);
});

test("media payloads: pass through (mediaUrl and mediaUrls variants)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  assert.equal(
    await handler(
      makeEvent("final", { text: "caption", mediaUrl: "https://x/y.png" }),
      {},
    ),
    undefined,
  );
  assert.equal(
    await handler(
      makeEvent("final", { text: "caption", mediaUrls: ["https://x/y.png"] }),
      {},
    ),
    undefined,
  );
});

test("empty / whitespace-only text: passes through (nothing to route)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  assert.equal(await handler(makeEvent("final", { text: "" }), {}), undefined);
  assert.equal(
    await handler(makeEvent("final", { text: "   " }), {}),
    undefined,
  );
  assert.equal(await handler(makeEvent("final", {}), {}), undefined);
});

// ── guards ─────────────────────────────────────────────────────────────────

test("non-interactive session key (:cron:): passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent("final", { text: "cron output" }, { sessionKey: "sess:cron:tick" }),
    {},
  );
  assert.equal(result, undefined);
});

test("subagent session: passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const result = await handler(
    makeEvent(
      "final",
      { text: "subagent output" },
      { sessionKey: "sess:subagent:child42" },
    ),
    {},
  );
  assert.equal(result, undefined);
});

test("unconfigured plugin: passes through (must not interfere with host delivery)", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    isConfigured: false,
  } as unknown as ToolDeps["lifecycle"]);
  const handler = captureHandler(deps);

  const result = await handler(makeEvent("final", { text: "free text" }), {});
  assert.equal(result, undefined);
});

test("dead sidecar: passes through", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    isConfigured: true,
    isDead: true,
  } as unknown as ToolDeps["lifecycle"]);
  const handler = captureHandler(deps);

  const result = await handler(makeEvent("final", { text: "free text" }), {});
  assert.equal(result, undefined);
});

test("guard exception: logs warn, passes through, delivery not broken", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const handler = captureHandler(deps);

  const badEvent = new Proxy(
    { kind: "final" },
    {
      get(target, prop) {
        if (prop === "sessionKey") throw new TypeError("bad shape");
        return (target as Record<string | symbol, unknown>)[prop as string];
      },
    },
  );

  const result = await handler(badEvent, {});
  assert.equal(result, undefined, "must pass through when guards throw");
  assert.equal(logger.warned.length, 1);
  assert.match(logger.warned[0]!, /guards threw/);
});
