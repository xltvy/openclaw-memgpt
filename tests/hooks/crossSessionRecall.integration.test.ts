/**
 * V2.1 regression — cross-session recall across a real sidecar restart
 * (brief scenario 7; V1.4 p5's load-bearing property, canonical marker
 * CARDINAL_3987).
 *
 * The V1 protocol defines the session boundary as *sidecar process restart*
 * (the path carrying the F2 recall reference-repair), not session-key
 * rotation. The pre-existing mirrorIntegration save/load test verifies
 * persistence within one sidecar process; this test closes the actual
 * boundary: mirror + save under sidecar #1 → SIGTERM → boot sidecar #2 on
 * the same data dir → `ensure()` rehydrates via `:load` → `recallSearch`
 * still surfaces the marker.
 *
 * Guards against the V2.1 enforcement work regressing the memory
 * architecture: the new hooks (finalizeGuard / payloadGuard) sit on the I/O
 * path and must leave this pipeline untouched.
 *
 * In its own file so the unit suite stays sidecar-free; pays two sidecar
 * boots (the restart is the point).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { registerAgentEndHook } from "../../src/hooks/mirror.ts";
import { SidecarClientImpl } from "../../src/client/sidecarClient.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { PluginConfig } from "../../src/config.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { startSidecar } from "../sidecarFixture.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const CANONICAL_MARKER = `CARDINAL_3987-${randomBytes(4).toString("hex")}`;

function buildFixture(
  namespace: string,
  baseUrl: string,
): { handler: Handler; client: SidecarClientImpl; emitted: MemoryEvent[] } {
  const config: PluginConfig = {
    namespace,
    model: "gpt-4",
    persona: "Test persona.",
    human: "Test human.",
    observability: "off",
  };
  const client = new SidecarClientImpl(config, () => Promise.resolve(baseUrl));

  const emitted: MemoryEvent[] = [];
  const deps: ToolDeps = {
    client,
    namespace,
    emit: (e: MemoryEvent) => emitted.push(e),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  let captured: Handler | undefined;
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    registerTool: () => {},
    on: (event: string, h: Handler) => {
      if (event === "agent_end") captured = h;
    },
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;
  registerAgentEndHook(api, deps);
  if (!captured) throw new Error("hook did not register");
  return { handler: captured, client, emitted };
}

test(
  "cross-session recall: marker mirrored+saved under sidecar #1 is recall-searchable after restart (:load path)",
  { timeout: 300_000 },
  async () => {
    const namespace = `xsession-${randomBytes(4).toString("hex")}`;

    // ── Session 1: mirror the marker turn, save, shut down.
    const sidecar1 = await startSidecar({ keepDataDirOnStop: true });
    const dataDir = sidecar1.dataDir;
    try {
      const s1 = buildFixture(namespace, sidecar1.baseUrl);
      await s1.client.ensure();

      await s1.handler(
        {
          success: true,
          messages: [
            { role: "user", content: `The canonical marker is ${CANONICAL_MARKER}.` },
          ],
        },
        { trigger: "user", sessionKey: "agent:main:main" },
      );
      const kinds = s1.emitted.map((e) => e.kind);
      assert.ok(kinds.includes("messages_mirrored"), `mirror must fire: ${kinds}`);
      assert.ok(kinds.includes("agent_saved"), `save must fire: ${kinds}`);
    } finally {
      await sidecar1.stop(); // keeps dataDir
    }

    // ── Session 2: fresh sidecar process, same on-disk state.
    const sidecar2 = await startSidecar({ dataDir });
    try {
      const s2 = buildFixture(namespace, sidecar2.baseUrl);

      // The rehydration call — must take the cold-start :load path (the
      // agent cannot be resident in a fresh process).
      const ensured = await s2.client.ensure();
      assert.equal(
        ensured.via,
        "load",
        `expected cold-start :load in a fresh sidecar process; got via=${ensured.via}`,
      );

      // The load-bearing property: recall search still surfaces the marker.
      const recall = await s2.client.recallSearch(CANONICAL_MARKER);
      assert.ok(
        recall.formatted.includes(CANONICAL_MARKER),
        `expected recall to surface ${CANONICAL_MARKER} after restart; got: ${recall.formatted}`,
      );
      assert.ok(recall.total >= 1, `expected total >= 1; got ${recall.total}`);
    } finally {
      await sidecar2.stop(); // final owner — cleans up dataDir
    }
  },
);
