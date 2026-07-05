/**
 * send_message handler tests — the §4.3 output tool + V2.1 turn-flag seam.
 *
 * Asserts:
 *   - invocation sets the turn-scoped fired-flag (peeked by finalizeGuard /
 *     payloadGuard, cleared at turn start)
 *   - the message text is returned verbatim as the tool-result content
 *   - the client is NOT called (§4.3: "send_message does not call the sidecar —
 *     output goes to the user via OpenClaw, never to the memory substrate")
 *   - peek is non-consuming (both V2.1 hooks may read the same turn's flag)
 *   - clear resets the flag (the turn-boundary semantics)
 *   - SEND_MESSAGE_V1_KEY is the same on all seam halves
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  SEND_MESSAGE_V1_KEY,
  _resetSendMessageFlagsForTests,
  clearSendMessageFired,
  markSendMessageFired,
  peekSendMessageFired,
  sendMessage,
} from "../../src/tools/sendMessage.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { ToolDeps } from "../../src/tools/deps.ts";

// Ensure flag state doesn't bleed between tests (a previous test's
// markSendMessageFired otherwise leaks into the next test's peek).
beforeEach(() => {
  _resetSendMessageFlagsForTests();
});

function makeDeps(): ToolDeps {
  // Empty stub — any method call would explode, which is the point: the test
  // asserts no client call happens.
  return {
    client: {} as SidecarClient,
    namespace: "test-ns",
    emit: () => {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

test("sendMessage: returns the message text verbatim as the tool-result content", async () => {
  const handler = sendMessage(makeDeps());
  const r = await handler("tc-1", { message: "hello user" });
  assert.deepEqual(r, { content: [{ type: "text", text: "hello user" }] });
});

test("sendMessage: invocation sets the fired-flag at SEND_MESSAGE_V1_KEY", async () => {
  const handler = sendMessage(makeDeps());
  await handler("tc-1", { message: "hi" });
  // finalizeGuard / payloadGuard peek this on the same key.
  assert.equal(peekSendMessageFired(SEND_MESSAGE_V1_KEY), true);
});

test("sendMessage: does NOT touch the sidecar client (§4.3 contract)", async () => {
  // Deps.client is an empty object — any property access would surface as
  // TypeError. Successful execution proves the handler doesn't call client.*.
  const handler = sendMessage(makeDeps());
  await assert.doesNotReject(() => handler("tc-1", { message: "x" }));
});

test("peekSendMessageFired: non-consuming — repeated peeks all see the flag", () => {
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  assert.equal(peekSendMessageFired(SEND_MESSAGE_V1_KEY), true);
  assert.equal(
    peekSendMessageFired(SEND_MESSAGE_V1_KEY),
    true,
    "second peek must still see the flag — both V2.1 hooks read the same turn state",
  );
});

test("clearSendMessageFired: resets the flag (turn-boundary semantics)", () => {
  markSendMessageFired(SEND_MESSAGE_V1_KEY);
  clearSendMessageFired(SEND_MESSAGE_V1_KEY);
  assert.equal(peekSendMessageFired(SEND_MESSAGE_V1_KEY), false);
});

test("peekSendMessageFired: returns false when no mark was set (default behaviour)", () => {
  assert.equal(peekSendMessageFired("nothing-here"), false);
});

test("mark / peek / clear: distinct keys are independent (Map-keyed shape preserved for multi-session V2)", () => {
  // V1 uses SEND_MESSAGE_V1_KEY; the multi-session topology will use real
  // sessionKeys. Preserving Map-independence between keys is what makes that
  // switch a key change only, not a re-architecture.
  markSendMessageFired("session-a");
  markSendMessageFired("session-b");
  clearSendMessageFired("session-a");
  assert.equal(peekSendMessageFired("session-a"), false);
  assert.equal(peekSendMessageFired("session-b"), true);
});

test("sendMessage: empty / unicode messages pass through verbatim", async () => {
  const handler = sendMessage(makeDeps());
  const emptyR = await handler("tc-1", { message: "" });
  assert.deepEqual(emptyR, { content: [{ type: "text", text: "" }] });

  _resetSendMessageFlagsForTests();
  const unicodeR = await handler("tc-2", { message: "héllo 👋 🦊" });
  assert.deepEqual(unicodeR, {
    content: [{ type: "text", text: "héllo 👋 🦊" }],
  });
});
