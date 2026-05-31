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

// ── 9. batch wrapper ────────────────────────────────────────────────────────

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
