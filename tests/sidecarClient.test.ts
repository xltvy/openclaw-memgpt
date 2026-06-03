/**
 * SidecarClient round-trip tests against a live uvicorn-hosted sidecar.
 *
 * Per §3.4 acceptance: the client is verified against a real running sidecar,
 * not a mock. Behavioural correctness is the sidecar's own 101 tests' job;
 * these tests assert the wire layer — that the client correctly _talks_ to
 * the sidecar (request shape, response parsing, snake_case → camelCase
 * mapping, typed-error throwing).
 *
 * Sidecar lifespan: one per file. Each test uses a fresh client with a
 * unique namespace, so they share the registry without interfering.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { startSidecar, type SidecarHandle } from "./sidecarFixture.ts";
import { SidecarClientImpl } from "../src/client/sidecarClient.ts";
import {
  BufferTooSmallError,
  CoreMemoryError,
  SidecarError,
} from "../src/client/errors.ts";
import type { PluginConfig } from "../src/config.ts";

// ── fixture ─────────────────────────────────────────────────────────────────

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

function uniqNs(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

function makeClient(label: string): SidecarClientImpl {
  const cfg: PluginConfig = {
    namespace: uniqNs(label),
    model: "gpt-4",
    persona: "Test persona.",
    human: "Test human.",
    observability: "off",
  };
  return new SidecarClientImpl(cfg, () => Promise.resolve(sidecar.baseUrl));
}

// ── 1. healthz ──────────────────────────────────────────────────────────────

test("healthz: round-trip (camelCase mapping; embedder ready)", async () => {
  const client = makeClient("hz");
  const h = await client.healthz();
  assert.equal(h.ok, true);
  assert.equal(h.embedder, "ready");
  assert.equal(typeof h.agentsResident, "number");
});

// ── 1b. getStats (6c.6.2) ───────────────────────────────────────────────────

test("getStats: snake_case total_message_count → camelCase totalMessageCount; grows with messagesAppend", async () => {
  // The 6c.6.2 source-of-truth path: GET /agents/{id}/stats lets the flush-
  // pressure hook read total_message_count without tracking it host-side.
  // Wire-mapping test (camelCase) + sanity that append-then-read reflects
  // the grown count.
  const client = makeClient("stats");
  await client.ensure();
  const before = await client.getStats();
  assert.equal(typeof before.totalMessageCount, "number");
  assert.ok(
    before.totalMessageCount >= 4,
    `expected boot baseline >=4; got ${before.totalMessageCount}`,
  );

  await client.messagesAppend([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
  ]);
  const after = await client.getStats();
  assert.equal(after.totalMessageCount, before.totalMessageCount + 2);
});

// ── 2. ensure / save / load ─────────────────────────────────────────────────

test("ensure: first call returns via:'create'; second returns via:'resident'", async () => {
  const client = makeClient("ensure");
  const first = await client.ensure();
  assert.equal(first.via, "create");
  assert.match(first.agentId, /^ensure-/);

  const second = await client.ensure();
  assert.equal(second.via, "resident");
  assert.equal(second.agentId, first.agentId);
});

test("save: returns {saved: true}", async () => {
  const client = makeClient("save");
  await client.ensure();
  const r = await client.save();
  assert.equal(r.saved, true);
});

test("load: 409 SidecarError when namespace is resident", async () => {
  const client = makeClient("load-409");
  await client.ensure();
  await assert.rejects(
    () => client.load(),
    (err: unknown) => {
      assert.ok(err instanceof SidecarError, `expected SidecarError, got ${err}`);
      assert.equal((err as SidecarError).status, 409);
      return true;
    },
  );
});

test("load: 404 SidecarError when no on-disk state", async () => {
  // Fresh client; never ensure'd, never saved → no agent on disk
  const client = makeClient("load-404");
  await assert.rejects(
    () => client.load(),
    (err: unknown) => {
      assert.ok(err instanceof SidecarError, `expected SidecarError, got ${err}`);
      assert.equal((err as SidecarError).status, 404);
      return true;
    },
  );
});

// load() 200 happy-path covered by sidecar/tests/test_save_load.py +
// test_ensure_endpoint.py via the via:"load" branch. Reproducing here
// requires eviction, which is admin-surface (deferred to 6d).

// ── 3. system prompt section ────────────────────────────────────────────────

test("getSystemPromptSection: static + dynamic both present; section concatenates them", async () => {
  const client = makeClient("sps");
  await client.ensure();
  const s = await client.getSystemPromptSection();
  assert.ok(s.section.length > 0);
  assert.ok(s.static.length > 0);
  assert.ok(s.dynamic.length > 0);
  // The §2.4 contract is section = static + dynamic; sidecar's 6a.2 tests
  // verify byte-for-byte parity. Here we just verify the wire mapping.
  assert.equal(s.section, s.static + s.dynamic);
});

// ── 4. core memory ──────────────────────────────────────────────────────────

test("coreMemoryAppend + getCoreMemory: appended text appears in human section", async () => {
  const client = makeClient("cm-append");
  await client.ensure();
  const marker = `CM-APPEND-${randomBytes(4).toString("hex")}`;
  await client.coreMemoryAppend("human", marker);
  const cm = await client.getCoreMemory();
  assert.ok(cm.human.includes(marker), `marker missing from human: ${cm.human}`);
});

test("coreMemoryReplace: replaces a known substring", async () => {
  const client = makeClient("cm-replace");
  await client.ensure();
  // Append a known substring, then replace it
  const seed = `SEED-${randomBytes(4).toString("hex")}`;
  const newer = `NEWER-${randomBytes(4).toString("hex")}`;
  await client.coreMemoryAppend("persona", seed);
  await client.coreMemoryReplace("persona", seed, newer);
  const cm = await client.getCoreMemory();
  assert.ok(!cm.persona.includes(seed), `old seed still present: ${cm.persona}`);
  assert.ok(cm.persona.includes(newer), `new content missing: ${cm.persona}`);
});

test("getCoreMemory: persona + human strings present", async () => {
  const client = makeClient("cm-get");
  await client.ensure();
  const cm = await client.getCoreMemory();
  assert.equal(typeof cm.persona, "string");
  assert.equal(typeof cm.human, "string");
  // Defaults applied per Task B ensure-with-body
  assert.ok(cm.persona.length > 0);
});

// ── 5. archival ─────────────────────────────────────────────────────────────

test("archivalInsert: returns {ok, passages}", async () => {
  const client = makeClient("ar-insert");
  await client.ensure();
  const r = await client.archivalInsert("a passage to insert into archival memory");
  assert.equal(r.ok, true);
  assert.ok(r.passages >= 1, `expected >=1 passage, got ${r.passages}`);
});

test("archivalSearch: snake_case num_pages → camelCase numPages", async () => {
  const client = makeClient("ar-search");
  await client.ensure();
  await client.archivalInsert("the secret token is XENON-OWL");
  const r = await client.archivalSearch("secret token");
  // Verify the wire-mapping: numPages exists (and is the page-local field
  // per §2.5's asymmetry — value is whatever the sidecar returns; we just
  // check the field name is mapped).
  assert.equal(typeof r.numPages, "number");
  assert.equal(typeof r.total, "number");
  assert.equal(typeof r.page, "number");
  assert.equal(typeof r.formatted, "string");
  assert.ok(Array.isArray(r.results));
});

// ── 6. recall ───────────────────────────────────────────────────────────────

test("recallSearch: returns SearchResult shape; boot messages searchable", async () => {
  const client = makeClient("rec-search");
  await client.ensure();
  // The §2.10 "recall corpus non-empty at session start" note: the preset
  // boot sequence is in all_messages from init. "Bootup" is in the
  // assistant boot message (user/assistant roles are searchable;
  // system/function are filtered per DummyRecallMemory.text_search).
  const r = await client.recallSearch("Bootup");
  assert.equal(typeof r.numPages, "number");
  assert.equal(typeof r.total, "number");
  assert.ok(r.formatted.length > 0);
});

test("recallSearchDate: accepts {startDate, endDate, page?}", async () => {
  const client = makeClient("rec-date");
  await client.ensure();
  // Broad date range covering today and tomorrow; should not error.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const r = await client.recallSearchDate({
    startDate: today,
    endDate: tomorrow,
  });
  assert.equal(typeof r.numPages, "number");
  assert.equal(typeof r.total, "number");
});

// ── 7. messages:append ──────────────────────────────────────────────────────

test("messagesAppend: list body; returns {appended}", async () => {
  const client = makeClient("msg-append");
  await client.ensure();
  const r = await client.messagesAppend([
    { role: "assistant", content: "round-trip test message" },
    { role: "user", content: "another one" },
  ]);
  assert.equal(r.appended, 2);
});

// ── 8. summarize ────────────────────────────────────────────────────────────

test("summarize: too-small buffer → BufferTooSmallError (NOT SidecarError)", async () => {
  const client = makeClient("sum-toosmall");
  await client.ensure();
  // Tiny buffer: just system + one — :summarize will 422 because select_cutoff
  // cannot preserve last-N and still summarise.
  const messages = [
    { role: "system" as const, content: "system prompt" },
    { role: "user" as const, content: "hello" },
  ];
  await assert.rejects(
    () => client.summarize(messages, 2),
    (err: unknown) => {
      assert.ok(
        err instanceof BufferTooSmallError,
        `expected BufferTooSmallError (NOT SidecarError) so 6c.6 can catch it specifically; got ${err}`,
      );
      return true;
    },
  );
});

// ── 9. integration: full happy path ─────────────────────────────────────────

test("integration: ensure → coreMemoryAppend → getCoreMemory shows the addition", async () => {
  const client = makeClient("int-happy");
  const e = await client.ensure();
  assert.equal(e.via, "create");

  const marker = `HAPPY-${randomBytes(4).toString("hex")}`;
  await client.coreMemoryAppend("human", marker);

  const cm = await client.getCoreMemory();
  assert.ok(cm.human.includes(marker), `marker missing from human: ${cm.human}`);
});

// ── 10. integration: core-memory overflow round-trip ────────────────────────

test("integration: coreMemoryAppend overflow → CoreMemoryError with verbatim pymemgpt message", async () => {
  const client = makeClient("int-overflow");
  await client.ensure();
  // §2.9: pymemgpt's CoreMemory has a 2000-char limit per section.
  const huge = "X".repeat(2500);
  await assert.rejects(
    () => client.coreMemoryAppend("human", huge),
    (err: unknown) => {
      assert.ok(
        err instanceof CoreMemoryError,
        `expected CoreMemoryError (tool layer surfaces .message verbatim); got ${err}`,
      );
      assert.equal((err as CoreMemoryError).code, "core_memory_overflow");
      // §2.9 verbatim: the LLM is trained against this exact string format
      assert.match(
        (err as CoreMemoryError).message,
        /Exceeds.*character limit/,
        ".message should carry pymemgpt's verbatim overflow text",
      );
      return true;
    },
  );
});

// ── 11. integration: summarize 422 round-trip ───────────────────────────────

test("integration: summarize too-small buffer round-trip — 6c.6 catches BufferTooSmallError as no-op", async () => {
  // Same scenario as the per-method 422 test, framed as the integration
  // pattern 6c.6 will use: handler catches BufferTooSmallError → log + no-op
  // → turn proceeds (per §2.8 "false-alarm threshold crossing... recoverable").
  const client = makeClient("int-422");
  await client.ensure();
  const messages = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hi" },
  ];
  let handled = false;
  try {
    await client.summarize(messages, 2);
  } catch (e) {
    if (e instanceof BufferTooSmallError) {
      // This is the 6c.6 pattern: no-op, let the turn continue.
      handled = true;
    } else {
      throw e;
    }
  }
  assert.equal(handled, true, "BufferTooSmallError was not caught specifically");
});
