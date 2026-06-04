/**
 * Round-trip integration test for `normalise()` through a live sidecar.
 *
 * Closes the loop the unit tests can't: the normalised v0 output must be
 * what the sidecar's `messages:append` path actually accepts and stores,
 * and the resulting recall corpus must surface the appended content.
 *
 * Lives in its own file so the unit suite stays sidecar-free; this file
 * pays the ~90s sidecar boot once, in parallel with sidecarClient.test.ts.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { startSidecar, type SidecarHandle } from "./sidecarFixture.ts";
import { SidecarClientImpl } from "../src/client/sidecarClient.ts";
import { normaliseMessages, type OpenClawMessage } from "../src/normalise.ts";
import type { PluginConfig } from "../src/config.ts";

let sidecar: SidecarHandle;

before(
  async () => {
    sidecar = await startSidecar();
  },
  { timeout: 120_000 },
);

after(
  async () => {
    if (sidecar) await sidecar.stop();
  },
  { timeout: 30_000 },
);

function makeClient(label: string): SidecarClientImpl {
  const cfg: PluginConfig = {
    namespace: `${label}-${randomBytes(4).toString("hex")}`,
    model: "gpt-4",
    persona: "Test persona.",
    human: "Test human.",
    observability: "off",
  };
  return new SidecarClientImpl(cfg, () => Promise.resolve(sidecar.baseUrl));
}

test("round-trip: normalise → messagesAppend → recallSearch finds the content", async () => {
  const client = makeClient("normint");
  await client.ensure();

  // Unique marker the recall search will look for. Pinned to the *user*
  // message because §2.10 notes DummyRecallMemory.text_search filters out
  // system/function roles and matches on `d["message"]["content"]` —
  // function_call.arguments on the assistant message may not surface,
  // but the user message and its content reliably will.
  const marker = `NORM-RT-${randomBytes(6).toString("hex")}`;

  // Representative modern-tools-API conversation: user → assistant-with-
  // tool_call → tool-result. The exact §3.7 shape the handler layer will
  // hand to normaliseMessages before calling messagesAppend.
  const openClawMessages: OpenClawMessage[] = [
    {
      role: "user",
      content: `user marker: ${marker}`,
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: {
            name: "archival_memory_search",
            arguments: '{"query":"x"}',
          },
        },
      ],
    },
    {
      role: "tool",
      content: "No results found.",
      tool_call_id: "call_abc123",
      name: "archival_memory_search",
    },
  ];

  const v0 = normaliseMessages(openClawMessages);

  // Sanity: the shape the sidecar will receive is v0. If this drifts we
  // want to know before the recall round-trip blames the wrong layer.
  assert.equal(v0[0].role, "user");
  assert.equal(v0[1].role, "assistant");
  assert.deepEqual(v0[1].function_call, {
    name: "archival_memory_search",
    arguments: '{"query":"x"}',
  });
  assert.equal(v0[2].role, "function");
  assert.equal(v0[2].name, "archival_memory_search");

  // Wire ingest — proves the v0 output is accepted by /messages:append.
  const appendResult = await client.messagesAppend(v0);
  assert.equal(appendResult.appended, 3);

  // Recall the marker — proves it landed in the recall corpus and is
  // searchable end-to-end through the real text_search backend.
  const recall = await client.recallSearch(marker);
  assert.ok(
    recall.formatted.includes(marker),
    `expected recall to surface marker ${marker}; got: ${recall.formatted}`,
  );
  assert.ok(
    recall.total >= 1,
    `expected total >= 1 grand-total matches; got ${recall.total}`,
  );
});
