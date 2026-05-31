/**
 * Round-trip integration test for the before_prompt_build hook through a
 * live sidecar.
 *
 * Closes the loop the unit tests can't: the contribution shape returned by
 * the hook must contain real MemGPT content (not stub strings), and the
 * static/dynamic split must reflect what the sidecar actually computes.
 * Per §4.2, "the fetch is localhost and cheap" — this asserts that fact
 * holds and that real persona text lands in `prependContext` while the
 * adapted base prompt lands in `prependSystemContext`.
 *
 * In its own file so the unit suite stays sidecar-free; this file pays the
 * ~90s boot once, in parallel with the other live-sidecar suites.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { registerPromptSectionHook } from "../../src/hooks/promptSection.ts";
import { SidecarClientImpl } from "../../src/client/sidecarClient.ts";
import type { MemoryEvent, ToolDeps } from "../../src/tools/deps.ts";
import type { PluginConfig } from "../../src/config.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { startSidecar, type SidecarHandle } from "../sidecarFixture.ts";

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

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makeNamespace(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

function buildDepsAndHandler(label: string): {
  deps: ToolDeps & { emitted: MemoryEvent[] };
  handler: Handler;
  client: SidecarClientImpl;
} {
  const config: PluginConfig = {
    namespace: makeNamespace(label),
    model: "gpt-4",
    persona: "Test persona for integration.",
    human: "Test human for integration.",
    observability: "off",
  };
  const client = new SidecarClientImpl(config, () =>
    Promise.resolve(sidecar.baseUrl),
  );

  const emitted: MemoryEvent[] = [];
  const deps = {
    client,
    namespace: config.namespace,
    emit: (e: MemoryEvent) => emitted.push(e),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    emitted,
  };

  let captured: Handler | undefined;
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    resolvePath: (p: string) => p,
    registerTool: () => {},
    on: (event: string, h: Handler) => {
      if (event === "before_prompt_build") captured = h;
    },
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;
  registerPromptSectionHook(api, deps);
  if (!captured) throw new Error("hook did not register");
  return { deps, handler: captured, client };
}

test("live round-trip: hook returns real MemGPT content in static + dynamic", async () => {
  const { deps, handler } = buildDepsAndHandler("ps-live");
  const r = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext?: string;
  };

  // Sidecar-real content checks — these would fail if the hook accidentally
  // wired stubs or swapped static/dynamic.
  assert.ok(
    r.prependSystemContext.length > 1000,
    `static (prependSystemContext) should be the adapted base prompt (~5KB); got ${r.prependSystemContext.length} chars`,
  );
  assert.ok(
    typeof r.prependContext === "string" && r.prependContext.length > 0,
    `dynamic (prependContext) should be present and non-empty; got ${typeof r.prependContext}`,
  );

  // The configured persona lands on the dynamic side per §2.4.
  assert.ok(
    r.prependContext!.includes("Test persona for integration."),
    `configured persona should appear in prependContext; got: ${r.prependContext}`,
  );

  // Telemetry event surfaced with a real via value.
  assert.equal(deps.emitted.length, 1);
  assert.equal(deps.emitted[0].kind, "agent_ensured");
  assert.ok(
    ["resident", "load", "create"].includes(
      String(deps.emitted[0].meta?.via),
    ),
    `via should be one of the EnsureVia values; got ${String(deps.emitted[0].meta?.via)}`,
  );
});

test("live round-trip: persona edit lands in prependContext; prependSystemContext unchanged", async () => {
  // The static/dynamic split asserted against the real sidecar — proves the
  // unit-test contract (mocks) matches what the sidecar actually returns.
  const { handler, client, deps } = buildDepsAndHandler("ps-edit");

  // Turn 1 — baseline.
  const turn1 = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext: string;
  };

  // Edit core memory: append a unique marker to persona.
  const marker = `LIVE-EDIT-${randomBytes(4).toString("hex")}`;
  await client.coreMemoryAppend("persona", marker);

  // Turn 2 — after edit.
  const turn2 = (await handler({}, {})) as {
    prependSystemContext: string;
    prependContext: string;
  };

  // Both halves of the §2.4 split asserted against real content:
  assert.ok(
    turn2.prependContext.includes(marker),
    `appended marker should appear in prependContext; got: ${turn2.prependContext}`,
  );
  assert.notEqual(
    turn1.prependContext,
    turn2.prependContext,
    "prependContext (dynamic) must reflect the persona edit",
  );
  assert.equal(
    turn1.prependSystemContext,
    turn2.prependSystemContext,
    "prependSystemContext (static) must be unchanged across the edit — adapted base prompt is preset-driven, not edit-driven",
  );

  // Two ensure calls → two agent_ensured events.
  assert.equal(deps.emitted.length, 2);
  assert.ok(
    deps.emitted.every((e) => e.kind === "agent_ensured"),
    "both events should be agent_ensured",
  );
});
