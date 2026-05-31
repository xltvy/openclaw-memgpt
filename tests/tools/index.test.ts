/**
 * `registerTools` smoke test — asserts seven api.registerTool calls in the
 * expected order, each carrying the right schema + an `execute` function.
 *
 * Doesn't probe handler behaviour (memoryHandlers.test.ts / sendMessage.test.ts
 * cover that); pins the *wiring*: that all seven schemas land at the SDK
 * boundary and that adding/removing a tool here surfaces in a single place.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { registerTools } from "../../src/tools/index.ts";
import { SCHEMAS } from "../../src/tools/schemas.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { ToolDeps } from "../../src/tools/deps.ts";

function makeApiStub(): { api: OpenClawPluginApi; registerToolMock: ReturnType<typeof mock.fn> } {
  const registerToolMock = mock.fn();
  const api = {
    pluginConfig: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolvePath: (p: string) => p,
    registerTool: registerToolMock,
    on: () => {},
    registerCli: () => {},
    registerService: () => {},
  } as unknown as OpenClawPluginApi;
  return { api, registerToolMock };
}

function makeDeps(): ToolDeps {
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

test("registerTools: invokes api.registerTool exactly seven times", () => {
  const { api, registerToolMock } = makeApiStub();
  registerTools(api, makeDeps());
  assert.equal(registerToolMock.mock.callCount(), 7);
});

test("registerTools: each call carries the right schema (name + description) and an execute function", () => {
  const { api, registerToolMock } = makeApiStub();
  registerTools(api, makeDeps());

  // Registration order is defined in src/tools/index.ts and mirrored in
  // SCHEMAS' insertion order; pinning it here means a reorder is a visible
  // change rather than silent.
  const expectedOrder = [
    "core_memory_append",
    "core_memory_replace",
    "archival_memory_insert",
    "archival_memory_search",
    "conversation_search",
    "conversation_search_date",
    "send_message",
  ];

  for (let i = 0; i < expectedOrder.length; i++) {
    const name = expectedOrder[i];
    const def = registerToolMock.mock.calls[i].arguments[0] as {
      name: string;
      description: string;
      parameters: unknown;
      execute: unknown;
    };
    assert.equal(def.name, name, `call #${i} should be ${name}`);
    assert.equal(
      def.description,
      SCHEMAS[name].description,
      `call #${i} description must match the schema verbatim`,
    );
    assert.equal(
      typeof def.execute,
      "function",
      `call #${i} must carry an execute function`,
    );
  }
});

test("registerTools: registered execute functions match the SDK's (toolCallId, params) shape", async () => {
  // The SDK's execute contract is `(toolCallId: string, params: object) =>
  // Promise<{content: ...}>`. Smoke-test that one registered handler accepts
  // that shape — pins the contract at the SDK boundary.
  const { api, registerToolMock } = makeApiStub();
  registerTools(api, {
    client: {
      archivalSearch: async () => ({
        formatted: "ok",
        results: [],
        total: 0,
        page: 0,
        numPages: 0,
      }),
    } as unknown as SidecarClient,
    namespace: "test-ns",
    emit: () => {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });

  // archival_memory_search is index 3
  const def = registerToolMock.mock.calls[3].arguments[0] as {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  };
  const r = await def.execute("tc-1", { query: "x", page: 0 });
  assert.deepEqual(r, { content: [{ type: "text", text: "ok" }] });
});
