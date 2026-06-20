/**
 * Uninstall tests (6d.6). Covers the pure config mutation (matches what
 * `plugins uninstall` writes), artifact-path computation, and runUninstall
 * orchestration (artifact removal, de-register, --keep-data, --dry-run,
 * confirm/force) with injected fakes — no real fs, no SDK, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ID, type ConfigIO } from "../../src/wizard/configStore.ts";
import type { Prompter } from "../../src/wizard/prompts.ts";
import {
  applyUninstallMutation,
  artifactPaths,
  runUninstall,
  type UninstallFs,
} from "../../src/wizard/uninstall.ts";

const CANCEL = Symbol("cancel");

function fullConfig(): Record<string, any> {
  return {
    plugins: {
      entries: {
        [PLUGIN_ID]: { enabled: true, config: { provider: "anthropic" } },
        "memory-core": { enabled: false },
        "other-plugin": { enabled: true },
      },
      installs: {
        [PLUGIN_ID]: { source: "path", sourcePath: "/repo/openclaw-memgpt" },
      },
      load: { paths: ["/repo/openclaw-memgpt", "/some/other/plugin"] },
      slots: { memory: PLUGIN_ID },
    },
    otherTopLevel: { keep: true },
  };
}

test("applyUninstallMutation: removes our entry/install/path/slot, keeps others", () => {
  const next = applyUninstallMutation(fullConfig());
  const p = next.plugins;
  assert.equal(p.entries[PLUGIN_ID], undefined, "our entry removed");
  assert.equal(p.entries["memory-core"].enabled, false, "other entries kept");
  assert.equal(p.entries["other-plugin"].enabled, true);
  assert.equal(p.installs[PLUGIN_ID], undefined, "our install record removed");
  assert.deepEqual(p.load.paths, ["/some/other/plugin"], "only our load path dropped");
  assert.equal(p.slots.memory, "memory-core", "slot reset to memory-core");
  assert.deepEqual(next.otherTopLevel, { keep: true }, "unrelated config untouched");
});

test("applyUninstallMutation: drops load.paths key entirely when ours was the only one", () => {
  const cfg = fullConfig();
  cfg.plugins.load.paths = ["/repo/openclaw-memgpt"];
  const next = applyUninstallMutation(cfg);
  assert.equal("paths" in next.plugins.load, false, "empty paths key removed");
});

test("applyUninstallMutation: leaves a foreign memory slot alone", () => {
  const cfg = fullConfig();
  cfg.plugins.slots.memory = "memory-lancedb";
  const next = applyUninstallMutation(cfg);
  assert.equal(next.plugins.slots.memory, "memory-lancedb");
});

test("artifactPaths: includes data dir by default, excludes with keepData", () => {
  const all = artifactPaths("/state");
  assert.ok(all.some((p) => p.endsWith("/plugins/openclaw-memgpt")));
  assert.ok(all.some((p) => p.endsWith("/memgpt-observability.jsonl")));
  assert.ok(all.some((p) => p.endsWith("/memgpt-data")));

  const kept = artifactPaths("/state", { keepData: true });
  assert.ok(!kept.some((p) => p.endsWith("/memgpt-data")), "data dir kept");
  assert.equal(kept.length, all.length - 1);
});

function fakeFs() {
  const removed: string[] = [];
  const written: Array<{ path: string; value: unknown }> = [];
  const fs: UninstallFs = {
    async remove(target) {
      removed.push(target);
    },
    async atomicWriteJson(target, value) {
      written.push({ path: target, value });
    },
  };
  return { fs, removed, written };
}

function fakeConfigIO(initial: Record<string, any>, opts: { failUpdate?: boolean } = {}) {
  let cfg = structuredClone(initial);
  const io: ConfigIO = {
    async load() {
      return structuredClone(cfg);
    },
    async update(mutator) {
      if (opts.failUpdate) throw new Error("size-drop");
      cfg = mutator(structuredClone(cfg));
      return cfg;
    },
  };
  return { io, get: () => cfg };
}

const forcePrompter: Prompter = {
  intro() {},
  outro() {},
  note() {},
  cancel() {},
  isCancel: (v) => v === CANCEL,
  async select() {
    return undefined as never;
  },
  async text() {
    return "";
  },
  async password() {
    return "";
  },
  async confirm() {
    return true;
  },
};

test("runUninstall --force: removes artifacts and de-registers via SDK update", async () => {
  const { fs, removed } = fakeFs();
  const { io, get } = fakeConfigIO(fullConfig());
  const res = await runUninstall({
    force: true,
    prompter: forcePrompter,
    configIO: io,
    fs,
    stateDir: "/state",
  });
  assert.equal(res.status, "removed");
  assert.equal(removed.length, 3, "secret dir + observability + data dir");
  assert.equal(get().plugins.entries[PLUGIN_ID], undefined, "de-registered via update");
});

test("runUninstall --keep-data: does not remove the data dir", async () => {
  const { fs, removed } = fakeFs();
  const { io } = fakeConfigIO(fullConfig());
  await runUninstall({
    force: true,
    keepData: true,
    prompter: forcePrompter,
    configIO: io,
    fs,
    stateDir: "/state",
  });
  assert.equal(removed.length, 2);
  assert.ok(!removed.some((p) => p.endsWith("/memgpt-data")));
});

test("runUninstall: falls back to direct atomic write when SDK update is rejected", async () => {
  const { fs, written } = fakeFs();
  const { io } = fakeConfigIO(fullConfig(), { failUpdate: true });
  await runUninstall({
    force: true,
    prompter: forcePrompter,
    configIO: io,
    fs,
    stateDir: "/state",
    configPath: "/state/openclaw.json",
  });
  assert.equal(written.length, 1, "direct write fallback used");
  assert.equal(written[0].path, "/state/openclaw.json");
  assert.equal((written[0].value as any).plugins.entries[PLUGIN_ID], undefined);
});

test("runUninstall --dry-run: changes nothing", async () => {
  const { fs, removed, written } = fakeFs();
  const { io, get } = fakeConfigIO(fullConfig());
  const res = await runUninstall({
    dryRun: true,
    prompter: forcePrompter,
    configIO: io,
    fs,
    stateDir: "/state",
  });
  assert.equal(res.status, "dry-run");
  assert.equal(removed.length, 0);
  assert.equal(written.length, 0);
  assert.ok(get().plugins.entries[PLUGIN_ID], "entry still present after dry-run");
});

test("runUninstall: declining the confirm removes nothing", async () => {
  const { fs, removed } = fakeFs();
  const { io, get } = fakeConfigIO(fullConfig());
  const decliner: Prompter = { ...forcePrompter, async confirm() { return false; } };
  const res = await runUninstall({
    prompter: decliner,
    configIO: io,
    fs,
    stateDir: "/state",
    isInteractive: true,
  });
  assert.equal(res.status, "cancelled");
  assert.equal(removed.length, 0);
  assert.ok(get().plugins.entries[PLUGIN_ID]);
});

test("runUninstall: non-interactive without --force throws", async () => {
  const { fs } = fakeFs();
  const { io } = fakeConfigIO(fullConfig());
  await assert.rejects(
    () =>
      runUninstall({
        prompter: forcePrompter,
        configIO: io,
        fs,
        stateDir: "/state",
        isInteractive: false,
      }),
    /--force/,
  );
});
