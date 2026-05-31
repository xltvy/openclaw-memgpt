/**
 * Memory tool handlers — six combined, since they share the §3.6 uniform
 * structure (thin SidecarClient wrapper; verbatim formatted on success;
 * verbatim CoreMemoryError.message on 409). One file keeps the comparison
 * across handlers immediate; per-tool files would just repeat the boilerplate.
 *
 * Tests use a partial-mock SidecarClient: only the method each handler
 * actually invokes is stubbed, and the cast to SidecarClient is local. Real
 * client-↔-sidecar round-trips are covered by tests/sidecarClient.test.ts;
 * here we assert the handler-layer contract (right args in, right shape
 * out, verbatim 409 surfaced).
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { archivalInsert } from "../../src/tools/archivalInsert.ts";
import { archivalSearch } from "../../src/tools/archivalSearch.ts";
import { conversationSearch } from "../../src/tools/conversationSearch.ts";
import { conversationSearchDate } from "../../src/tools/conversationSearchDate.ts";
import { coreMemoryAppend } from "../../src/tools/coreMemoryAppend.ts";
import { coreMemoryReplace } from "../../src/tools/coreMemoryReplace.ts";
import { CoreMemoryError } from "../../src/client/errors.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { ToolDeps } from "../../src/tools/deps.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function makeDeps(clientStub: Partial<SidecarClient>): ToolDeps {
  return {
    client: clientStub as SidecarClient,
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

// ============================================================================
// core_memory_append
// ============================================================================

test("coreMemoryAppend: calls client with (name, content); returns empty content on success", async () => {
  const client = {
    coreMemoryAppend: mock.fn(async (_n: "persona" | "human", _c: string) => {}),
  };
  const handler = coreMemoryAppend(makeDeps(client));
  const r = await handler("tc-1", { name: "human", content: "is alice" });
  assert.deepEqual(r, { content: [] });
  assert.equal(client.coreMemoryAppend.mock.callCount(), 1);
  assert.deepEqual(client.coreMemoryAppend.mock.calls[0].arguments, [
    "human",
    "is alice",
  ]);
});

test("coreMemoryAppend: CoreMemoryError → returns verbatim .message as tool-result text", async () => {
  // §2.9: the LLM was trained against pymemgpt's exact 409 strings; reformatting
  // is a fidelity loss. Verbatim assertion guards against silent paraphrase.
  const verbatim =
    "Edit failed: section human: Exceeds 2000 character limit (current = 1900, new = 2500)";
  const client = {
    coreMemoryAppend: mock.fn(async () => {
      throw new CoreMemoryError({
        code: "core_memory_overflow",
        message: verbatim,
      });
    }),
  };
  const handler = coreMemoryAppend(makeDeps(client));
  const r = await handler("tc-1", {
    name: "human",
    content: "X".repeat(2500),
  });
  assert.deepEqual(r, { content: [{ type: "text", text: verbatim }] });
});

test("coreMemoryAppend: non-CoreMemoryError bubbles (transport / unexpected)", async () => {
  const transportErr = new Error("sidecar 503");
  const client = {
    coreMemoryAppend: mock.fn(async () => {
      throw transportErr;
    }),
  };
  const handler = coreMemoryAppend(makeDeps(client));
  await assert.rejects(
    () => handler("tc-1", { name: "human", content: "x" }),
    (err) => err === transportErr,
  );
});

// ============================================================================
// core_memory_replace
// ============================================================================

test("coreMemoryReplace: calls client with (name, old_content, new_content)", async () => {
  const client = {
    coreMemoryReplace: mock.fn(
      async (
        _n: "persona" | "human",
        _o: string,
        _new: string,
      ) => {},
    ),
  };
  const handler = coreMemoryReplace(makeDeps(client));
  const r = await handler("tc-1", {
    name: "persona",
    old_content: "old",
    new_content: "new",
  });
  assert.deepEqual(r, { content: [] });
  assert.deepEqual(client.coreMemoryReplace.mock.calls[0].arguments, [
    "persona",
    "old",
    "new",
  ]);
});

test("coreMemoryReplace: CoreMemoryError(content_not_found) → verbatim .message surfaced", async () => {
  // The not-found case is the more common 409 for replace (old_content didn't
  // match). Same verbatim contract as overflow.
  const verbatim =
    'Edit failed: section persona: Could not find content "missing-substring" in memory.';
  const client = {
    coreMemoryReplace: mock.fn(async () => {
      throw new CoreMemoryError({
        code: "core_memory_content_not_found",
        message: verbatim,
      });
    }),
  };
  const handler = coreMemoryReplace(makeDeps(client));
  const r = await handler("tc-1", {
    name: "persona",
    old_content: "missing-substring",
    new_content: "new",
  });
  assert.deepEqual(r, { content: [{ type: "text", text: verbatim }] });
});

// ============================================================================
// archival_memory_insert
// ============================================================================

test("archivalInsert: calls client with content; returns empty content on success", async () => {
  const client = {
    archivalInsert: mock.fn(async (_c: string) => ({
      ok: true as const,
      passages: 3,
    })),
  };
  const handler = archivalInsert(makeDeps(client));
  const r = await handler("tc-1", { content: "long passage" });
  assert.deepEqual(r, { content: [] });
  assert.deepEqual(client.archivalInsert.mock.calls[0].arguments, [
    "long passage",
  ]);
});

// ============================================================================
// archival_memory_search
// ============================================================================

test("archivalSearch: returns sidecar's formatted verbatim (incl. trailing space)", async () => {
  // §2.5: the formatted string is byte-for-byte from pymemgpt's
  // archival_memory_search; trailing space is part of the trained-against
  // prefix " " between "results (page p/0):" and the JSON array. Verbatim
  // pass-through assertion is the §3.6 "no result formatting" contract.
  const formatted =
    'Showing 2 of 2 results (page 0/0): ["timestamp: ..., memory: passage A", "timestamp: ..., memory: passage B"]';
  const client = {
    archivalSearch: mock.fn(async (_q: string, _p: number) => ({
      formatted,
      results: ["passage A", "passage B"],
      total: 2,
      page: 0,
      numPages: 0,
    })),
  };
  const handler = archivalSearch(makeDeps(client));
  const r = await handler("tc-1", { query: "x", page: 0 });
  assert.deepEqual(r, { content: [{ type: "text", text: formatted }] });
});

test("archivalSearch: missing page defaults to 0; passed through to client", async () => {
  const client = {
    archivalSearch: mock.fn(async (_q: string, _p: number) => ({
      formatted: "No results found.",
      results: [],
      total: 0,
      page: 0,
      numPages: 0,
    })),
  };
  const handler = archivalSearch(makeDeps(client));
  await handler("tc-1", { query: "x" }); // no page
  assert.deepEqual(client.archivalSearch.mock.calls[0].arguments, ["x", 0]);
});

// ============================================================================
// conversation_search (recall:search bridge)
// ============================================================================

test("conversationSearch: LLM-facing name bridges to client.recallSearch (§3.6 name-bridge)", async () => {
  // The handler bridges the LLM-facing name `conversation_search` to the
  // architecture name `recall:search` — this test pins the bridge so a
  // future refactor that wires conversationSearch to a different client
  // method (e.g. archivalSearch by mistake) is caught.
  const formatted =
    'Showing 1 of 1 results (page 0/0): ["timestamp: ..., user - hello"]';
  const client = {
    recallSearch: mock.fn(async (_q: string, _p: number) => ({
      formatted,
      results: ["hello"],
      total: 1,
      page: 0,
      numPages: 0,
    })),
  };
  const handler = conversationSearch(makeDeps(client));
  const r = await handler("tc-1", { query: "hello", page: 0 });
  assert.deepEqual(r, { content: [{ type: "text", text: formatted }] });
  assert.deepEqual(client.recallSearch.mock.calls[0].arguments, ["hello", 0]);
});

// ============================================================================
// conversation_search_date (recall:search_date bridge)
// ============================================================================

test("conversationSearchDate: snake_case params → camelCase client args; bridges to recallSearchDate", async () => {
  // §2.6: the gpt_functions schema uses start_date / end_date (snake_case at
  // the LLM boundary); the client method takes camelCase. The handler is
  // where the conversion happens.
  const formatted = "No results found.";
  const client = {
    recallSearchDate: mock.fn(
      async (_p: {
        startDate: string;
        endDate: string;
        page: number;
      }) => ({
        formatted,
        results: [],
        total: 0,
        page: 0,
        numPages: 0,
      }),
    ),
  };
  const handler = conversationSearchDate(makeDeps(client));
  const r = await handler("tc-1", {
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    page: 0,
  });
  assert.deepEqual(r, { content: [{ type: "text", text: formatted }] });
  assert.deepEqual(client.recallSearchDate.mock.calls[0].arguments, [
    { startDate: "2026-01-01", endDate: "2026-01-31", page: 0 },
  ]);
});
