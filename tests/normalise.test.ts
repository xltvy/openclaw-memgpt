/**
 * Unit tests for `normalise()` — the §3.7 / §2.10 message-shape boundary.
 *
 * Sidecar-free: these are pure-function tests of the OpenClaw-modern → v0
 * shape transformation. The end-to-end round-trip through a live sidecar
 * lives in `normaliseIntegration.test.ts` so the sidecar boot cost (~90s)
 * doesn't gate the unit suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalise,
  normaliseMessages,
  type OpenClawMessage,
} from "../src/normalise.ts";

// ── 1. system / user pass-through ───────────────────────────────────────────

test("system message passes through unchanged", () => {
  const input: OpenClawMessage = { role: "system", content: "you are X" };
  assert.deepEqual(normalise(input), {
    role: "system",
    content: "you are X",
  });
});

test("user message passes through unchanged", () => {
  const input: OpenClawMessage = { role: "user", content: "hello" };
  assert.deepEqual(normalise(input), {
    role: "user",
    content: "hello",
  });
});

test("user message with name preserves the name", () => {
  const input: OpenClawMessage = {
    role: "user",
    content: "hi",
    name: "alice",
  };
  assert.deepEqual(normalise(input), {
    role: "user",
    content: "hi",
    name: "alice",
  });
});

// ── 2. assistant text-only ──────────────────────────────────────────────────

test("assistant message with content only passes through unchanged", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: "let me think...",
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: "let me think...",
  });
});

// ── 3. assistant + single tool_call → function_call ─────────────────────────

test("assistant with one tool_call → function_call; id dropped; content preserved", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: "calling tool",
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
  };
  const out = normalise(input);
  assert.deepEqual(out, {
    role: "assistant",
    content: "calling tool",
    function_call: {
      name: "archival_memory_search",
      arguments: '{"query":"x"}',
    },
  });
  // id must not leak
  assert.ok(!("tool_calls" in out), "tool_calls should be dropped");
  assert.ok(!("id" in out), "id should not appear at top level");
});

test("assistant with one tool_call and null content → content stays null", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_x",
        function: { name: "f", arguments: "{}" },
      },
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  });
});

test("assistant with one tool_call and missing content → content becomes null", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    tool_calls: [
      {
        function: { name: "f", arguments: "{}" },
      },
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  });
});

// ── 4. multi tool_calls — documented "warn + keep first" ────────────────────

test("assistant with multiple tool_calls keeps the first and discards the rest", () => {
  // Suppress the console.warn from this case so the test output stays clean;
  // we're asserting the documented structural behaviour, not the log message.
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(msg);

  try {
    const input: OpenClawMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", function: { name: "first", arguments: "{}" } },
        { id: "2", function: { name: "second", arguments: "{}" } },
        { id: "3", function: { name: "third", arguments: "{}" } },
      ],
    };
    const out = normalise(input);
    assert.deepEqual(out, {
      role: "assistant",
      content: null,
      function_call: { name: "first", arguments: "{}" },
    });
    // The warn is part of the documented contract — assert it fired so a
    // future silent removal of the warning is caught.
    assert.equal(warnings.length, 1, "expected exactly one console.warn");
    assert.match(warnings[0], /3 tool_calls/);
  } finally {
    console.warn = originalWarn;
  }
});

// ── 5. tool-result message → function-role message ─────────────────────────

test("tool-role message → function-role; tool_call_id dropped; name preserved", () => {
  const input: OpenClawMessage = {
    role: "tool",
    content: '{"results": ["a"]}',
    tool_call_id: "call_abc123",
    name: "archival_memory_search",
  };
  const out = normalise(input);
  assert.deepEqual(out, {
    role: "function",
    content: '{"results": ["a"]}',
    name: "archival_memory_search",
  });
  assert.ok(!("tool_call_id" in out), "tool_call_id should be dropped");
});

test("tool-role message without name → function-role without name", () => {
  // OpenClaw should provide name, but guard the degraded case: don't fabricate.
  const input: OpenClawMessage = {
    role: "tool",
    content: "result",
    tool_call_id: "call_x",
  };
  assert.deepEqual(normalise(input), {
    role: "function",
    content: "result",
  });
});

// ── 6. already-v0 inputs are idempotent at the per-message level ────────────

test("already-v0 function-role message passes through", () => {
  const input: OpenClawMessage = {
    role: "function",
    content: "result",
    name: "core_memory_append",
  };
  assert.deepEqual(normalise(input), {
    role: "function",
    content: "result",
    name: "core_memory_append",
  });
});

test("already-v0 assistant with function_call passes through", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  });
});

// ── 7. idempotency — normalise(normalise(x)) === normalise(x) ──────────────

test("idempotency: assistant + tool_calls — second pass is no-op", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_x",
        function: { name: "f", arguments: '{"q":"x"}' },
      },
    ],
  };
  const first = normalise(input);
  // Treat the v0 result as another OpenClawMessage input — same schema,
  // already-v0 fields. Second pass must produce a deep-equal result.
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
});

test("idempotency: tool-role — second pass is no-op", () => {
  const input: OpenClawMessage = {
    role: "tool",
    content: "result",
    tool_call_id: "call_x",
    name: "f",
  };
  const first = normalise(input);
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
});

test("idempotency: user/system/assistant text-only — all stable", () => {
  const cases: OpenClawMessage[] = [
    { role: "user", content: "hi" },
    { role: "system", content: "be helpful" },
    { role: "assistant", content: "ok" },
  ];
  for (const c of cases) {
    const first = normalise(c);
    const second = normalise(first as OpenClawMessage);
    assert.deepEqual(second, first);
  }
});

// ── 8. edge cases ───────────────────────────────────────────────────────────

test("empty content string is preserved (not coerced to null)", () => {
  const input: OpenClawMessage = { role: "user", content: "" };
  assert.deepEqual(normalise(input), { role: "user", content: "" });
});

test("missing content on user message becomes null", () => {
  // Degraded input; we don't fabricate a string. v0 allows null content.
  const input = { role: "user" } as OpenClawMessage;
  assert.deepEqual(normalise(input), { role: "user", content: null });
});

test("missing name on tool-result → no name in v0 output (not undefined-as-key)", () => {
  const input: OpenClawMessage = { role: "tool", content: "r" };
  const out = normalise(input);
  assert.deepEqual(out, { role: "function", content: "r" });
  assert.ok(!("name" in out), "name key should be absent, not undefined");
});

test("extra unknown fields on input are dropped (not relayed to v0)", () => {
  // The §3.7 boundary is the place to strip extra OpenClaw-side fields so
  // the sidecar payload stays pymemgpt-shaped.
  const input = {
    role: "user",
    content: "hi",
    openclaw_internal: { trace_id: "abc" },
  } as OpenClawMessage;
  const out = normalise(input);
  assert.deepEqual(out, { role: "user", content: "hi" });
  assert.ok(!("openclaw_internal" in out));
});

// ── 9. content-blocks array flattening (OpenClaw modern API) ────────────────

test("user message with single text content part → flattened to string", () => {
  const input: OpenClawMessage = {
    role: "user",
    content: [{ type: "text", text: "My name is Altay." }],
  };
  assert.deepEqual(normalise(input), {
    role: "user",
    content: "My name is Altay.",
  });
});

test("user message with multiple text parts → joined in order", () => {
  const input: OpenClawMessage = {
    role: "user",
    content: [
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "user",
    content: "Hello world",
  });
});

test("assistant with empty content array → null", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: [],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
  });
});

test("assistant with tool_call and array content → function_call; content flattened", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: [{ type: "text", text: "calling tool" }],
    tool_calls: [
      { id: "c1", function: { name: "core_memory_append", arguments: '{"name":"human","content":"Altay"}' } },
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: "calling tool",
    function_call: { name: "core_memory_append", arguments: '{"name":"human","content":"Altay"}' },
  });
});

test("content array with no text parts → null", () => {
  const input: OpenClawMessage = {
    role: "user",
    content: [{ type: "image_url", url: "https://example.com/img.png" }] as never,
  };
  assert.deepEqual(normalise(input), {
    role: "user",
    content: null,
  });
});

test("content array flattening idempotent: already-string passes through unchanged", () => {
  const input: OpenClawMessage = { role: "user", content: "hello" };
  const first = normalise(input);
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
  assert.equal(second.content, "hello");
});

// ── 9b. pi-ai inline toolCall blocks (the V1.3 / methodology-bank #20 path) ──

test("assistant with inline toolCall block → function_call; arguments stringified", () => {
  // pi-ai canonical shape: `arguments` is an OBJECT, not a JSON string.
  // normalise must stringify it for v0's wire format.
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "I'll update core memory." },
      {
        type: "toolCall",
        id: "toolu_01ABC",
        name: "core_memory_append",
        arguments: { name: "human", content: "Altay is a researcher." },
      } as never,
    ],
  };
  const out = normalise(input);
  assert.deepEqual(out, {
    role: "assistant",
    content: "I'll update core memory.",
    function_call: {
      name: "core_memory_append",
      arguments: '{"name":"human","content":"Altay is a researcher."}',
    },
  });
});

test("assistant with toolCall-only content (no text block) → empty content + function_call", () => {
  // The "assistant decides only to call a tool, no monologue" case observed
  // in real Cell C trials. flattenContent returns null when no text blocks.
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "send_message", arguments: { message: "Hi" } } as never,
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "send_message", arguments: '{"message":"Hi"}' },
  });
});

test("assistant with multiple inline toolCall blocks: keep first, warn", () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const input: OpenClawMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Plan" },
        { type: "toolCall", id: "t1", name: "first_tool", arguments: { a: 1 } } as never,
        { type: "toolCall", id: "t2", name: "second_tool", arguments: { b: 2 } } as never,
      ],
    };
    const out = normalise(input);
    assert.deepEqual(out, {
      role: "assistant",
      content: "Plan",
      function_call: { name: "first_tool", arguments: '{"a":1}' },
    });
    assert.equal(warnings.length, 1, "expected exactly one console.warn");
    assert.match(warnings[0], /2 inline toolCall blocks/);
  } finally {
    console.warn = originalWarn;
  }
});

test("toolCall block with string-form arguments (drift) passes through unchanged", () => {
  // Belt-and-braces: if a future caller hands us a toolCall whose arguments
  // is already a JSON string (off-spec for pi-ai but plausible), don't
  // double-stringify it.
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "f", arguments: '{"already":"stringified"}' } as never,
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: '{"already":"stringified"}' },
  });
});

test("toolCall block with missing arguments → '{}'", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "f" } as never,
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  });
});

test("idempotency: assistant with inline toolCall block — second pass is no-op", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "calling" },
      { type: "toolCall", id: "x", name: "f", arguments: { q: 1 } } as never,
    ],
  };
  const first = normalise(input);
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
});

// ── 9c. pi-ai toolResult role → v0 function role ────────────────────────────

test("toolResult role with toolName + text content → function role with name", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "archival_memory_search",
    content: [{ type: "text", text: "No results found." }],
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "function",
    content: "No results found.",
    name: "archival_memory_search",
  });
});

test("toolResult role with string content → function role with string content", () => {
  // Defensive: pi-ai canonical content is an array, but if a caller drifts
  // to plain string we accept it.
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "archival_memory_insert",
    content: "Got it!",
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "function",
    content: "Got it!",
    name: "archival_memory_insert",
  });
});

test("toolResult role with empty content array → null content", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "core_memory_append",
    content: [],
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "function",
    content: null,
    name: "core_memory_append",
  });
});

test("toolResult role falls back to `name` when `toolName` absent", () => {
  // Drift case — caller used the OpenAI-classic `name` field on a pi-ai
  // role. We accept the fallback so the tool name still surfaces in v0.
  const input: OpenClawMessage = {
    role: "toolResult",
    name: "conversation_search",
    content: [{ type: "text", text: "Showing 0 results." }],
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "function",
    content: "Showing 0 results.",
    name: "conversation_search",
  });
});

test("toolResult role with no name at all → function role without name", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    content: [{ type: "text", text: "result" }],
  } as OpenClawMessage;
  const out = normalise(input);
  assert.deepEqual(out, { role: "function", content: "result" });
  assert.ok(!("name" in out), "name should be absent, not undefined");
});

test("idempotency: toolResult role — second pass is no-op", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "f",
    content: [{ type: "text", text: "r" }],
  } as OpenClawMessage;
  const first = normalise(input);
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
});

// ── 9c-bis. send_message Scenario A carve-out (§2.10 / §4.3) ────────────────
// The send_message tool result carries the verbatim user-facing reply as its
// content; DummyRecallMemory.text_search/date_search filter out role
// "function", so mapping it to v0 function makes the agent's replies
// unreachable from conversation_search. It keeps role "toolResult" instead
// (the 6c.9.4-verified shape). All other tool results keep the
// native-faithful function mapping (asserted by the 9c cases above).

test("send_message toolResult keeps role toolResult (recall-searchable)", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "send_message",
    content: [{ type: "text", text: "The reported energy consumption is 45 kWh." }],
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "toolResult",
    content: "The reported energy consumption is 45 kWh.",
    name: "send_message",
  });
});

test("send_message carve-out applies via `name` fallback too", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    name: "send_message",
    content: [{ type: "text", text: "Hello!" }],
  } as OpenClawMessage;
  assert.deepEqual(normalise(input), {
    role: "toolResult",
    content: "Hello!",
    name: "send_message",
  });
});

test("send_message carve-out applies to legacy tool role", () => {
  const input: OpenClawMessage = {
    role: "tool",
    name: "send_message",
    tool_call_id: "call_1",
    content: "Hello!",
  };
  assert.deepEqual(normalise(input), {
    role: "toolResult",
    content: "Hello!",
    name: "send_message",
  });
});

test("idempotency: send_message carve-out — second pass is no-op", () => {
  const input: OpenClawMessage = {
    role: "toolResult",
    toolName: "send_message",
    content: [{ type: "text", text: "Done." }],
  } as OpenClawMessage;
  const first = normalise(input);
  const second = normalise(first as OpenClawMessage);
  assert.deepEqual(second, first);
});

// ── 9d. mixed-block edge cases (thinking, unknown types) ────────────────────

test("assistant with thinking block alongside text + toolCall → thinking dropped", () => {
  // pi-ai's ThinkingContent has no v0 equivalent; flattenContent silently
  // drops it. Real Sonnet 4.5 traffic via openai-completions doesn't surface
  // thinking, but we guard the case in case future models do.
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal reasoning" } as never,
      { type: "text", text: "let me update core memory" },
      { type: "toolCall", id: "t1", name: "core_memory_append", arguments: { k: "v" } } as never,
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: "let me update core memory",
    function_call: { name: "core_memory_append", arguments: '{"k":"v"}' },
  });
});

test("assistant with only thinking and toolCall (no text) → null content + function_call", () => {
  const input: OpenClawMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "..." } as never,
      { type: "toolCall", id: "t1", name: "f", arguments: {} } as never,
    ],
  };
  assert.deepEqual(normalise(input), {
    role: "assistant",
    content: null,
    function_call: { name: "f", arguments: "{}" },
  });
});

test("real-world V1.3 cell-c trial shape round-trips correctly", () => {
  // Reconstructed from the surviving v1-cell-c-p5-t00-s2.jsonl. Three-step
  // assistant chain: monologue + conversation_search, then bare tool_call
  // (heartbeat continuation), then bare send_message. Validates the V1.4
  // extractor's tool-counting will see real values after the fix.
  const turn: OpenClawMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "I mentioned a project code earlier — what was it?" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I need to search through our conversation history." },
        {
          type: "toolCall",
          id: "toolu_bdrk_01LAfJ",
          name: "conversation_search",
          arguments: { query: "project code", page: 0 },
        } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "conversation_search",
      content: [{ type: "text", text: 'Showing 5 of 10 results: [...]' }],
    } as OpenClawMessage,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "toolu_bdrk_02SMrt",
          name: "send_message",
          arguments: { message: "The project code you mentioned was BLUEBIRD_5402." },
        } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "send_message",
      content: [{ type: "text", text: "The project code you mentioned was BLUEBIRD_5402." }],
    } as OpenClawMessage,
  ];
  const v0 = normaliseMessages(turn);

  // Five entries; the assistant turns now carry function_call; the tool
  // results land as function-role with name set — except the send_message
  // result, which keeps role toolResult (§2.10 Scenario A carve-out) so the
  // reply text stays recall-searchable.
  assert.equal(v0.length, 5);
  assert.equal(v0[0].role, "user");
  assert.equal(v0[1].role, "assistant");
  assert.deepEqual(v0[1].function_call, {
    name: "conversation_search",
    arguments: '{"query":"project code","page":0}',
  });
  assert.equal(v0[2].role, "function");
  assert.equal(v0[2].name, "conversation_search");
  assert.equal(v0[3].role, "assistant");
  assert.equal(v0[3].function_call!.name, "send_message");
  assert.equal(v0[4].role, "toolResult");
  assert.equal(v0[4].name, "send_message");
  assert.equal(v0[4].content, "The project code you mentioned was BLUEBIRD_5402.");
});

// ── 9e. array-level multi-toolCall split (Sonnet 4.5 emission pattern) ─────

test("normaliseMessages: multi-toolCall assistant splits into N (assistant, function) pairs", () => {
  // Real pattern observed during V1.4 smoke: Sonnet 4.5 emits 3 toolCalls
  // in one assistant message. pymemgpt v0 needs one function_call per
  // assistant entry, so we split into 3 pairs interleaved with their
  // matching toolResults by toolCallId.
  const input: OpenClawMessage[] = [
    { role: "user", content: [{ type: "text", text: "do all the things" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll do it." },
        { type: "toolCall", id: "tc_1", name: "core_memory_replace", arguments: { name: "human", old_content: "x", new_content: "y" } } as never,
        { type: "toolCall", id: "tc_2", name: "archival_memory_insert", arguments: { content: "note" } } as never,
        { type: "toolCall", id: "tc_3", name: "send_message", arguments: { message: "Done!" } } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "core_memory_replace",
      toolCallId: "tc_1",
      content: [],
    } as OpenClawMessage,
    {
      role: "toolResult",
      toolName: "archival_memory_insert",
      toolCallId: "tc_2",
      content: [],
    } as OpenClawMessage,
    {
      role: "toolResult",
      toolName: "send_message",
      toolCallId: "tc_3",
      content: [{ type: "text", text: "Got it." }],
    } as OpenClawMessage,
  ];
  const out = normaliseMessages(input);

  // 1 user + 3×(assistant + function) = 7 messages.
  assert.equal(out.length, 7);
  assert.equal(out[0].role, "user");

  // First assistant carries the text monologue.
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].content, "I'll do it.");
  assert.equal(out[1].function_call!.name, "core_memory_replace");
  assert.equal(out[2].role, "function");
  assert.equal(out[2].name, "core_memory_replace");

  // Subsequent assistants carry null content (monologue lives once).
  assert.equal(out[3].role, "assistant");
  assert.equal(out[3].content, null);
  assert.equal(out[3].function_call!.name, "archival_memory_insert");
  assert.equal(out[4].role, "function");
  assert.equal(out[4].name, "archival_memory_insert");

  assert.equal(out[5].role, "assistant");
  assert.equal(out[5].content, null);
  assert.equal(out[5].function_call!.name, "send_message");
  // send_message argument JSON is preserved
  assert.equal(out[5].function_call!.arguments, '{"message":"Done!"}');
  // send_message result keeps role toolResult (§2.10 Scenario A carve-out).
  assert.equal(out[6].role, "toolResult");
  assert.equal(out[6].name, "send_message");
  assert.equal(out[6].content, "Got it.");
});

test("normaliseMessages: multi-toolCall with missing matching toolResult — emit assistant alone", () => {
  // Defensive: if a toolResult is somehow absent (truncated turn,
  // error path), still emit the assistant call so the tier classifier
  // sees the function_call and V1.4's per-step tools-by-step count
  // is correct.
  const input: OpenClawMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_1", name: "a", arguments: {} } as never,
        { type: "toolCall", id: "tc_2", name: "b", arguments: {} } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "a",
      toolCallId: "tc_1",
      content: [],
    } as OpenClawMessage,
    // no toolResult for tc_2
  ];
  const out = normaliseMessages(input);
  // assistant(a) + function(a) + assistant(b) = 3 messages; no function for b.
  assert.equal(out.length, 3);
  assert.equal(out[0].function_call!.name, "a");
  assert.equal(out[1].role, "function");
  assert.equal(out[1].name, "a");
  assert.equal(out[2].function_call!.name, "b");
});

test("normaliseMessages: multi-toolCall toolResult pairing is by toolCallId, not order", () => {
  // Pi-ai's runtime emits results in toolCall order today, but matching
  // by id (not adjacency) guards against future ordering changes.
  const input: OpenClawMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_1", name: "first", arguments: {} } as never,
        { type: "toolCall", id: "tc_2", name: "second", arguments: {} } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "second",
      toolCallId: "tc_2",
      content: [{ type: "text", text: "second result" }],
    } as OpenClawMessage,
    {
      role: "toolResult",
      toolName: "first",
      toolCallId: "tc_1",
      content: [{ type: "text", text: "first result" }],
    } as OpenClawMessage,
  ];
  const out = normaliseMessages(input);
  // Pair by id: first/first, second/second — not by position.
  assert.equal(out[0].function_call!.name, "first");
  assert.equal(out[1].name, "first");
  assert.equal(out[1].content, "first result");
  assert.equal(out[2].function_call!.name, "second");
  assert.equal(out[3].name, "second");
  assert.equal(out[3].content, "second result");
});

test("normaliseMessages: single-toolCall assistant unchanged (delegates to per-message)", () => {
  // Single-call case must keep its existing semantics: per-message
  // normalise builds one v0 assistant with text content + function_call,
  // adjacent toolResult independently translates to function role.
  const input: OpenClawMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "toolCall", id: "tc_x", name: "f", arguments: { q: 1 } } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "f",
      toolCallId: "tc_x",
      content: [{ type: "text", text: "result" }],
    } as OpenClawMessage,
  ];
  const out = normaliseMessages(input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    role: "assistant",
    content: "calling",
    function_call: { name: "f", arguments: '{"q":1}' },
  });
  assert.deepEqual(out[1], {
    role: "function",
    content: "result",
    name: "f",
  });
});

test("normaliseMessages: idempotency on multi-toolCall split output", () => {
  // After splitting, the array contains only single-toolCall assistants;
  // a second pass through normaliseMessages must be a no-op.
  const input: OpenClawMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_1", name: "a", arguments: { x: 1 } } as never,
        { type: "toolCall", id: "tc_2", name: "b", arguments: { y: 2 } } as never,
      ],
    },
    {
      role: "toolResult",
      toolName: "a",
      toolCallId: "tc_1",
      content: [{ type: "text", text: "ar" }],
    } as OpenClawMessage,
    {
      role: "toolResult",
      toolName: "b",
      toolCallId: "tc_2",
      content: [{ type: "text", text: "br" }],
    } as OpenClawMessage,
  ];
  const first = normaliseMessages(input);
  const second = normaliseMessages(first as OpenClawMessage[]);
  assert.deepEqual(second, first);
});

// ── 10. batch wrapper ────────────────────────────────────────────────────────

test("normaliseMessages: applies normalise across an array", () => {
  const input: OpenClawMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", function: { name: "f", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "result", tool_call_id: "1", name: "f" },
  ];
  assert.deepEqual(normaliseMessages(input), [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: null,
      function_call: { name: "f", arguments: "{}" },
    },
    { role: "function", content: "result", name: "f" },
  ]);
});
