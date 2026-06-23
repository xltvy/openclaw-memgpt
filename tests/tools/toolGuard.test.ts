/**
 * toolGuard / config-gate tests (§6d.6). Verifies the six sidecar-backed tools
 * short-circuit cleanly when the plugin is unconfigured (NOT_CONFIGURED, which
 * takes priority) or the sidecar is dead (SIDECAR_DEAD) — and never reach the
 * client in those states. Tools with no lifecycle wired (hand-built deps) pass
 * through unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { coreMemoryAppend } from "../../src/tools/coreMemoryAppend.ts";
import { toolGuard, type ToolDeps } from "../../src/tools/deps.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { LifecycleManager } from "../../src/lifecycle/lifecycleManager.ts";
import {
  NOT_CONFIGURED_MESSAGE,
  SIDECAR_DEAD_MESSAGE,
} from "../../src/lifecycle/lifecycleManager.ts";

function deps(lifecycle?: Partial<LifecycleManager>): ToolDeps {
  return {
    client: {
      coreMemoryAppend: async () => {
        throw new Error("client must not be called when the gate blocks");
      },
    } as unknown as SidecarClient,
    namespace: "ns",
    emit: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    lifecycle: lifecycle as unknown as LifecycleManager | undefined,
  };
}

test("toolGuard: null (proceed) when no lifecycle is wired", () => {
  assert.equal(toolGuard(deps()), null);
});

test("toolGuard: NOT_CONFIGURED takes priority over a dead sidecar", () => {
  const r = toolGuard(deps({ isConfigured: false, isDead: true }));
  assert.equal(r?.content[0]?.text, NOT_CONFIGURED_MESSAGE);
});

test("toolGuard: SIDECAR_DEAD when configured but dead", () => {
  const r = toolGuard(deps({ isConfigured: true, isDead: true }));
  assert.equal(r?.content[0]?.text, SIDECAR_DEAD_MESSAGE);
});

test("toolGuard: null when configured and alive", () => {
  assert.equal(toolGuard(deps({ isConfigured: true, isDead: false })), null);
});

test("a sidecar-backed tool returns NOT_CONFIGURED and never calls the client", async () => {
  const handler = coreMemoryAppend(deps({ isConfigured: false, isDead: false }));
  const res = await handler("call-1", { name: "human", content: "x" });
  assert.equal(res.content[0]?.text, NOT_CONFIGURED_MESSAGE);
});
