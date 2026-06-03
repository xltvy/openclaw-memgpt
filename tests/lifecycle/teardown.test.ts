/**
 * Unit tests for §6.3 plugin teardown (registerService.stop with final save).
 *
 * Mock-only — registerService.stop is a single SDK callback; no live sidecar
 * needed. End-to-end verification that OpenClaw actually calls stop at shutdown
 * is a 6c.9 / manual-lifecycle property.
 *
 * Asserts:
 *   - registerService is called with an object containing a stop function
 *   - client.save() is called when stop is invoked
 *   - save failure is swallowed (doesn't re-throw) and logger.error is called
 *   - save success logs via logger.info
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { registerTeardown } from "../../src/lifecycle/teardown.ts";
import type { SidecarClient } from "../../src/client/sidecarClient.ts";
import type { ToolDeps } from "../../src/tools/deps.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── helpers ────────────────────────────────────────────────────────────────

function makeLogger(): ToolDeps["logger"] & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  const logger: ToolDeps["logger"] & { infos: string[]; errors: string[] } = {
    info: (msg: string) => { infos.push(msg); },
    debug: () => {},
    warn: () => {},
    error: (msg: string) => { errors.push(msg); },
    infos,
    errors,
  };
  return logger;
}

function makeDeps(
  logger: ReturnType<typeof makeLogger>,
  client: Partial<SidecarClient> = {},
): ToolDeps {
  return {
    client: client as SidecarClient,
    namespace: "test-ns",
    emit: () => {},
    logger,
  };
}

type ServiceRegistration = { id?: string; start?: (ctx: unknown) => Promise<void> | void; stop?: (ctx: unknown) => Promise<void> | void };

function captureService(deps: ToolDeps): {
  service: ServiceRegistration;
  registerServiceCallCount: () => number;
} {
  let captured: ServiceRegistration | undefined;
  let callCount = 0;
  const api = {
    pluginConfig: {},
    logger: deps.logger,
    resolvePath: (p: string) => p,
    registerTool: () => {},
    on: () => {},
    registerCli: () => {},
    registerService: mock.fn((svc: ServiceRegistration) => {
      callCount++;
      captured = svc;
    }),
  } as unknown as OpenClawPluginApi;

  registerTeardown(api, deps);
  if (!captured) throw new Error("registerService was not called");
  return { service: captured, registerServiceCallCount: () => callCount };
}

// ── tests ────────────────────────────────────────────────────────────────

test("registerService is called with an object containing a stop function", () => {
  const logger = makeLogger();
  const deps = makeDeps(logger);
  const { service, registerServiceCallCount } = captureService(deps);

  assert.equal(registerServiceCallCount(), 1, "registerService called once");
  assert.equal(typeof service.stop, "function", "service has a stop callback");
});

test("stop invocation calls client.save()", async () => {
  const logger = makeLogger();
  let saveCalled = false;
  const deps = makeDeps(logger, {
    save: async () => { saveCalled = true; return { saved: true as const }; },
  });
  const { service } = captureService(deps);

  await service.stop?.({});
  assert.equal(saveCalled, true, "client.save must be called");
});

test("save failure is swallowed — stop does not throw", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    save: async (): Promise<never> => { throw new Error("disk full"); },
  });
  const { service } = captureService(deps);

  // stop() returns void | Promise<void>; wrap in a known-async lambda for doesNotReject
  await assert.doesNotReject(async () => { await service.stop?.({}); });
});

test("save failure logs via logger.error", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    save: async (): Promise<never> => { throw new Error("disk full"); },
  });
  const { service } = captureService(deps);

  await service.stop?.({});
  assert.equal(logger.errors.length, 1, "logger.error called once");
  assert.match(logger.errors[0]!, /disk full/);
});

test("save success logs via logger.info", async () => {
  const logger = makeLogger();
  const deps = makeDeps(logger, {
    save: async () => ({ saved: true as const }),
  });
  const { service } = captureService(deps);

  await service.stop?.({});
  assert.equal(logger.infos.length, 1, "logger.info called once");
  assert.match(logger.infos[0]!, /teardown/i);
});
