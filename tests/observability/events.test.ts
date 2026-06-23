/**
 * Unit tests for the §6.2 level-gated observability emitter.
 *
 * Disk-free: a fresh EventEmitter bus per case + an injected `appendFn` that
 * captures JSONL lines into an array + a no-op `mkdirFn`. Asserts the four
 * behaviours the emitter contract turns on:
 *   - level gating (off / default / verbose) over both sink channels
 *   - content-stripping at `default` (content + triggeringTurn dropped; meta kept)
 *   - LIFECYCLE_KINDS echo to logger.info; non-lifecycle kinds do not
 *   - subscriber detachment + high-frequency no-leak
 *
 * The emitter is the §6.2 research instrument; these are its per-layer oracle
 * (the emitter alone, no tools/hooks/OpenClaw above it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  ObservabilityEmitter,
  MEMORY_EVENT_CHANNEL,
  SINK_FILENAME,
  LIFECYCLE_KINDS,
  stripContent,
  type MemoryEvent,
} from "../../src/observability/events.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  const info: Array<{ msg: string; meta: unknown }> = [];
  const warn: Array<{ msg: string; meta: unknown }> = [];
  return {
    info: (msg: string, meta?: unknown) => info.push({ msg, meta }),
    warn: (msg: string, meta?: unknown) => warn.push({ msg, meta }),
    _info: info,
    _warn: warn,
  };
}

interface Harness {
  emitter: ObservabilityEmitter;
  bus: EventEmitter;
  lines: string[];
  logger: ReturnType<typeof makeLogger>;
}

async function makeHarness(
  level: "off" | "default" | "verbose",
  activate = true,
): Promise<Harness> {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const lines: string[] = [];
  const logger = makeLogger();
  const emitter = new ObservabilityEmitter(level, logger, {
    bus,
    appendFn: async (_file, data) => {
      lines.push(data);
    },
    mkdirFn: async () => {},
  });
  if (activate) await emitter.activate("/tmp/openclaw-memgpt-test-state");
  return { emitter, bus, lines, logger };
}

const SEARCH_EVENT: MemoryEvent = {
  kind: "archival_search",
  namespace: "ns-1",
  ts: "2026-06-19T00:00:00.000Z",
  triggeringTurn: "turn-7",
  meta: { total: 3, page: 0, numPages: 0 },
  content: { query: "secret", results: ["passage a", "passage b"] },
};

// ── off ──────────────────────────────────────────────────────────────────────

test("off: no event reaches the bus, the sink, or the logger", async () => {
  const h = await makeHarness("off");
  let received = 0;
  h.bus.on(MEMORY_EVENT_CHANNEL, () => received++);
  h.emitter.emit(SEARCH_EVENT);
  h.emitter.emit({ kind: "sidecar_spawned", namespace: "ns-1", meta: { port: 1 } });
  await h.emitter.flush();
  assert.equal(received, 0);
  assert.equal(h.lines.length, 0);
  assert.equal(h.logger._info.length, 0); // activate() is a no-op at off
});

// ── default: content-stripping ───────────────────────────────────────────────

test("default: content + triggeringTurn stripped; meta kept; both channels", async () => {
  const h = await makeHarness("default");
  const channelEvents: MemoryEvent[] = [];
  const kindEvents: MemoryEvent[] = [];
  h.bus.on(MEMORY_EVENT_CHANNEL, (e: MemoryEvent) => channelEvents.push(e));
  h.bus.on("archival_search", (e: MemoryEvent) => kindEvents.push(e));

  h.emitter.emit(SEARCH_EVENT);
  await h.emitter.flush();

  // Live bus — both the all-events channel and the per-kind channel.
  assert.equal(channelEvents.length, 1);
  assert.equal(kindEvents.length, 1);
  assert.equal(channelEvents[0].content, undefined);
  assert.equal(channelEvents[0].triggeringTurn, undefined);
  assert.deepEqual(channelEvents[0].meta, { total: 3, page: 0, numPages: 0 });

  // JSONL sink — same stripping, valid newline-terminated JSON.
  assert.equal(h.lines.length, 1);
  assert.ok(h.lines[0].endsWith("\n"));
  const parsed = JSON.parse(h.lines[0]) as MemoryEvent;
  assert.equal(parsed.content, undefined);
  assert.equal(parsed.triggeringTurn, undefined);
  assert.equal(parsed.kind, "archival_search");
  assert.deepEqual(parsed.meta, { total: 3, page: 0, numPages: 0 });

  // Original event not mutated by stripping.
  assert.ok(SEARCH_EVENT.content);
});

// ── verbose: content preserved ───────────────────────────────────────────────

test("verbose: content + triggeringTurn preserved on both channels", async () => {
  const h = await makeHarness("verbose");
  const got: MemoryEvent[] = [];
  h.bus.on(MEMORY_EVENT_CHANNEL, (e: MemoryEvent) => got.push(e));

  h.emitter.emit(SEARCH_EVENT);
  await h.emitter.flush();

  assert.deepEqual(got[0].content, {
    query: "secret",
    results: ["passage a", "passage b"],
  });
  assert.equal(got[0].triggeringTurn, "turn-7");

  const parsed = JSON.parse(h.lines[0]) as MemoryEvent;
  assert.deepEqual(parsed.content, {
    query: "secret",
    results: ["passage a", "passage b"],
  });
});

// ── lifecycle logger echo (Reading A) ────────────────────────────────────────

test("LIFECYCLE_KINDS echo to logger.info; memory kinds do not", async () => {
  const h = await makeHarness("default");
  const infoBefore = h.logger._info.length; // activate() logged once

  h.emitter.emit({ kind: "archival_search", namespace: "ns", meta: { total: 0 } });
  assert.equal(h.logger._info.length, infoBefore, "memory kind must not log.info");

  h.emitter.emit({ kind: "sidecar_spawned", namespace: "ns", meta: { port: 8765 } });
  assert.equal(h.logger._info.length, infoBefore + 1, "lifecycle kind must log.info");
  const last = h.logger._info[h.logger._info.length - 1];
  assert.match(last.msg, /sidecar_spawned/);
  assert.deepEqual(last.meta, { port: 8765 });
});

test("LIFECYCLE_KINDS is exactly the process-lifecycle set", () => {
  assert.deepEqual(
    [...LIFECYCLE_KINDS].sort(),
    ["health_failed", "sidecar_exited", "sidecar_restarted", "sidecar_spawned"],
  );
});

// ── subscriber detachment + no-leak ──────────────────────────────────────────

test("subscriber detachment: a removed listener stops receiving", async () => {
  const h = await makeHarness("verbose");
  let count = 0;
  const listener = () => count++;
  h.bus.on(MEMORY_EVENT_CHANNEL, listener);
  h.emitter.emit(SEARCH_EVENT);
  assert.equal(count, 1);
  h.bus.off(MEMORY_EVENT_CHANNEL, listener);
  h.emitter.emit(SEARCH_EVENT);
  assert.equal(count, 1, "detached listener must not receive further events");
});

test("high-frequency: 5000 emits keep listener count stable and all delivered", async () => {
  const h = await makeHarness("verbose");
  let count = 0;
  h.bus.on(MEMORY_EVENT_CHANNEL, () => count++);
  for (let i = 0; i < 5000; i++) {
    h.emitter.emit({ kind: "send_message", namespace: "ns", meta: { length: i } });
  }
  await h.emitter.flush();
  assert.equal(count, 5000);
  assert.equal(h.lines.length, 5000);
  // No listener accumulation — the emitter never attaches listeners of its own.
  assert.equal(h.bus.listenerCount(MEMORY_EVENT_CHANNEL), 1);
});

// ── activation ───────────────────────────────────────────────────────────────

test("activate computes the sink path under the state dir", async () => {
  const h = await makeHarness("default", false);
  // Pre-activation: writes are buffered out (no sink path).
  h.emitter.emit(SEARCH_EVENT);
  await h.emitter.flush();
  assert.equal(h.lines.length, 0, "no JSONL before activate");

  await h.emitter.activate("/var/state/openclaw");
  h.emitter.emit(SEARCH_EVENT);
  await h.emitter.flush();
  assert.equal(h.lines.length, 1, "JSONL flows after activate");
  const activateLog = h.logger._info.find((l) => l.msg.includes(SINK_FILENAME));
  assert.ok(activateLog, "activate logs the sink path");
  assert.match(activateLog!.msg, /\/var\/state\/openclaw\//);
});

// ── stripContent purity ──────────────────────────────────────────────────────

test("stripContent returns input unchanged when nothing to strip", () => {
  const e: MemoryEvent = { kind: "agent_saved", namespace: "ns" };
  assert.equal(stripContent(e), e);
});

test("stripContent drops content + triggeringTurn without mutating input", () => {
  const e: MemoryEvent = {
    kind: "send_message",
    namespace: "ns",
    triggeringTurn: "t",
    meta: { length: 4 },
    content: { text: "data" },
  };
  const out = stripContent(e);
  assert.equal(out.content, undefined);
  assert.equal(out.triggeringTurn, undefined);
  assert.deepEqual(out.meta, { length: 4 });
  assert.ok(e.content, "input not mutated");
});
