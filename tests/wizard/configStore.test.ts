/**
 * configStore unit tests (6d.6). Uses a fake ConfigIO so the SDK's real
 * `updateConfig`/`loadConfig` (host-only) are never touched. Verifies the
 * merge semantics: preserve untouched keys, delete keys set to undefined,
 * ensure the plugin entry exists + enabled.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type ConfigIO,
  mergePluginConfig,
  PLUGIN_ID,
  readPluginConfigBlock,
} from "../../src/wizard/configStore.ts";

function fakeIO(initial: Record<string, any> = {}) {
  let cfg: Record<string, any> = structuredClone(initial);
  const io: ConfigIO = {
    async load() {
      return structuredClone(cfg);
    },
    async update(mutator) {
      cfg = mutator(structuredClone(cfg));
      return cfg;
    },
  };
  return { io, get: () => cfg };
}

test("readPluginConfigBlock returns {} when no plugin entry exists", async () => {
  const { io } = fakeIO({});
  assert.deepEqual(await readPluginConfigBlock(io), {});
});

test("readPluginConfigBlock returns the existing config block", async () => {
  const { io } = fakeIO({
    plugins: { entries: { [PLUGIN_ID]: { config: { provider: "openai" } } } },
  });
  assert.deepEqual(await readPluginConfigBlock(io), { provider: "openai" });
});

test("mergePluginConfig creates entry (enabled) and writes config", async () => {
  const { io, get } = fakeIO({});
  await mergePluginConfig({ provider: "anthropic", model: "claude-x" }, io);
  const entry = get().plugins.entries[PLUGIN_ID];
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.config, { provider: "anthropic", model: "claude-x" });
});

test("mergePluginConfig preserves untouched keys (namespace/persona)", async () => {
  const { io, get } = fakeIO({
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: { namespace: "vs-01", persona: "Sam", model: "old" },
        },
      },
    },
  });
  await mergePluginConfig({ provider: "openai", model: "gpt-4o" }, io);
  assert.deepEqual(get().plugins.entries[PLUGIN_ID].config, {
    namespace: "vs-01",
    persona: "Sam",
    model: "gpt-4o",
    provider: "openai",
  });
});

test("mergePluginConfig deletes keys whose value is undefined", async () => {
  const { io, get } = fakeIO({
    plugins: {
      entries: { [PLUGIN_ID]: { config: { provider: "openai", sidecarUrl: "http://x" } } },
    },
  });
  await mergePluginConfig({ sidecarUrl: undefined, baseUrl: undefined }, io);
  const cfg = get().plugins.entries[PLUGIN_ID].config;
  assert.equal("sidecarUrl" in cfg, false);
  assert.equal("baseUrl" in cfg, false);
  assert.equal(cfg.provider, "openai");
});
