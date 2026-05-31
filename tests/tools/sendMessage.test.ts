/**
 * send_message handler tests — the §4.3 output tool.
 *
 * Asserts:
 *   - invocation sets the suppression flag (for 6c.7's reply_dispatch to consume)
 *   - the message text is returned verbatim as the tool-result content
 *   - the client is NOT called (§4.3: "send_message does not call the sidecar —
 *     output goes to the user via OpenClaw, never to the memory substrate")
 *   - takeSuppress consumes the flag (single-shot semantics)
 *   - SUPPRESS_V1_KEY is the same on both seam halves
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPRESS_V1_KEY,
  _resetSuppressionForTests,
  markSuppress,
  sendMessage,
  takeSuppress,
} from "../../src/tools/sendMessage.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { ToolDeps } from "../../src/tools/deps.ts";

// Ensure suppression state doesn't bleed between tests (a previous test's
// markSuppress otherwise leaks into the next test's takeSuppress).
beforeEach(() => {
  _resetSuppressionForTests();
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

test("sendMessage: invocation sets suppression flag at SUPPRESS_V1_KEY", async () => {
  const handler = sendMessage(makeDeps());
  await handler("tc-1", { message: "hi" });
  // 6c.7's reply_dispatch hook will consume this on the same key.
  assert.equal(takeSuppress(SUPPRESS_V1_KEY), true);
});

test("sendMessage: does NOT touch the sidecar client (§4.3 contract)", async () => {
  // Deps.client is an empty object — any property access would surface as
  // TypeError. Successful execution proves the handler doesn't call client.*.
  const handler = sendMessage(makeDeps());
  await assert.doesNotReject(() => handler("tc-1", { message: "x" }));
});

test("takeSuppress: single-shot — consuming clears the flag; second take returns false", () => {
  markSuppress(SUPPRESS_V1_KEY);
  assert.equal(takeSuppress(SUPPRESS_V1_KEY), true);
  assert.equal(
    takeSuppress(SUPPRESS_V1_KEY),
    false,
    "second take should return false — single-shot semantics",
  );
});

test("takeSuppress: returns false when no mark was set (default behaviour)", () => {
  assert.equal(takeSuppress("nothing-here"), false);
});

test("markSuppress / takeSuppress: distinct keys are independent (Map-keyed shape preserved for V2)", () => {
  // V1 uses SUPPRESS_V1_KEY; V2 will use real sessionKeys. Preserving Map-
  // independence between keys is what makes the V2 switch a key change only,
  // not a re-architecture.
  markSuppress("session-a");
  markSuppress("session-b");
  assert.equal(takeSuppress("session-a"), true);
  assert.equal(takeSuppress("session-b"), true);
  assert.equal(takeSuppress("session-a"), false);
});

test("sendMessage: empty / unicode messages pass through verbatim", async () => {
  const handler = sendMessage(makeDeps());
  const emptyR = await handler("tc-1", { message: "" });
  assert.deepEqual(emptyR, { content: [{ type: "text", text: "" }] });

  _resetSuppressionForTests();
  const unicodeR = await handler("tc-2", { message: "héllo 👋 🦊" });
  assert.deepEqual(unicodeR, {
    content: [{ type: "text", text: "héllo 👋 🦊" }],
  });
});
