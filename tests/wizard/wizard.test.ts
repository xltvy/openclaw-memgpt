/**
 * runWizard orchestration tests (6d.6). Verifies the persistence ordering the
 * operator signed off on:
 *   - paste path: secret file written BEFORE config (a failed write must not
 *     leave config pointing at a missing file);
 *   - file→env switch: old secret file removed AFTER config (env ref becomes
 *     the source of truth first; an orphan file is then harmless);
 *   - env path: no secret file touched;
 *   - cancel/decline: nothing written.
 * Plus notifyIfUnconfigured's detect-and-notify behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfigValue } from "../../src/config.ts";
import type { ConfigIO } from "../../src/wizard/configStore.ts";
import { PLUGIN_ID } from "../../src/wizard/configStore.ts";
import type { SecretFileIO } from "../../src/wizard/credentialStore.ts";
import type { Prompter } from "../../src/wizard/prompts.ts";
import { notifyIfUnconfigured } from "../../src/wizard/detect.ts";
import { runWizard } from "../../src/wizard/wizard.ts";

function harness(initial: Record<string, any> = {}) {
  const order: string[] = [];
  let cfg: Record<string, any> = structuredClone(initial);
  const secrets = new Map<string, string>();

  const configIO: ConfigIO = {
    async load() {
      return structuredClone(cfg);
    },
    async update(mutator) {
      order.push("config:update");
      cfg = mutator(structuredClone(cfg));
      return cfg;
    },
  };
  const secretIO: SecretFileIO = {
    async write(params) {
      order.push("secret:write");
      secrets.set(params.filePath, params.content);
    },
    async read(filePath) {
      return secrets.get(filePath);
    },
    async remove(filePath) {
      order.push("secret:remove");
      secrets.delete(filePath);
    },
  };
  return {
    order,
    configIO,
    secretIO,
    secrets,
    block: () => cfg?.plugins?.entries?.[PLUGIN_ID]?.config ?? {},
  };
}

const CANCEL = Symbol("cancel");
function scripted(queue: unknown[]): Prompter & { notes: string[] } {
  let i = 0;
  const next = () => queue[i++];
  const notes: string[] = [];
  const runValidate = (
    opts: { validate?: (v: string | undefined) => string | undefined },
    v: unknown,
  ) => {
    opts.validate?.(undefined);
    if (typeof v === "string") opts.validate?.(v);
  };
  return {
    notes,
    intro() {},
    outro() {},
    note(m: string) {
      notes.push(m);
    },
    cancel() {},
    isCancel: (v) => v === CANCEL,
    async select() {
      return next() as never;
    },
    async text(opts) {
      const v = next();
      runValidate(opts, v);
      return v as string;
    },
    async password(opts) {
      const v = next();
      runValidate(opts, v);
      return v as string;
    },
    async confirm() {
      return next() as boolean;
    },
  };
}

test("paste path: writes secret file BEFORE config; stores file credential", async () => {
  const h = harness();
  const prompter = scripted([
    "anthropic",
    "paste",
    "sk-ant-secret",
    "claude-sonnet-4-5-20250929",
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
  });
  assert.equal(res.status, "applied");
  assert.deepEqual(h.order, ["secret:write", "config:update"]);
  const block = h.block();
  assert.deepEqual(block.credential, { source: "file" });
  assert.equal(block.provider, "anthropic");
  assert.equal(block.baseUrl, "https://api.anthropic.com/v1"); // preset default stored
  assert.equal(block.model, "claude-sonnet-4-5-20250929");
  assert.equal(block.observability, "off");
  assert.equal("sidecarUrl" in block, false);
});

test("env path: no secret file written; stores env credential", async () => {
  const h = harness();
  const prompter = scripted([
    "openai",
    "env",
    "OPENAI_API_KEY",
    "gpt-4o",
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
  });
  assert.equal(res.status, "applied");
  assert.deepEqual(h.order, ["config:update"]);
  assert.deepEqual(h.block().credential, { source: "env", var: "OPENAI_API_KEY" });
});

test("file→env switch: config written BEFORE secret removal", async () => {
  const h = harness({
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: { provider: "anthropic", credential: { source: "file" } },
        },
      },
    },
  });
  const prompter = scripted([
    "anthropic",
    "switch",
    "NEW_KEY_VAR",
    "claude-x",
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
  });
  assert.equal(res.status, "applied");
  assert.deepEqual(h.order, ["config:update", "secret:remove"]);
  assert.deepEqual(h.block().credential, { source: "env", var: "NEW_KEY_VAR" });
});

test("cancelled wizard writes nothing", async () => {
  const h = harness();
  const prompter = scripted([CANCEL]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
  });
  assert.equal(res.status, "cancelled");
  assert.deepEqual(h.order, []);
});

// ── prerequisite (uv) + cold-start guidance ──────────────────────────────────

const SPAWN_PASTE_FLOW = [
  "anthropic",
  "paste",
  "sk-ant-key",
  "claude-x",
  "off",
  "", // sidecar blank → spawn mode
  true,
];

test("spawn mode + uv missing → warns about uv and notes cold-start", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW]);
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    checkUv: async () => false,
  });
  assert.ok(
    prompter.notes.some((n) => n.includes("uv") && n.includes("install")),
    "missing uv must surface an install instruction",
  );
  assert.ok(
    prompter.notes.some((n) => /60.?90s|embedding model/.test(n)),
    "cold-start heads-up must be shown",
  );
});

test("spawn mode + uv present → no uv warning, still notes cold-start", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW]);
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    checkUv: async () => true,
  });
  assert.ok(!prompter.notes.some((n) => n.includes("install uv") || n.includes("`uv`")));
  assert.ok(prompter.notes.some((n) => /60.?90s|embedding model/.test(n)));
});

test("attach mode (sidecarUrl set) → skips uv check + spawn guidance", async () => {
  const h = harness();
  const prompter = scripted([
    "anthropic",
    "paste",
    "sk-ant-key",
    "claude-x",
    "off",
    "http://127.0.0.1:9000", // sidecar override → attach mode
    true,
  ]);
  let uvChecked = false;
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    checkUv: async () => {
      uvChecked = true;
      return true;
    },
  });
  assert.equal(uvChecked, false, "attach mode must not probe uv (no spawn)");
  // The summary note is always shown; assert no spawn-only guidance is added.
  assert.ok(
    !prompter.notes.some((n) => /uv|60.?90s|embedding model/.test(n)),
    "no uv / cold-start guidance in attach mode",
  );
});

// ── notifyIfUnconfigured ─────────────────────────────────────────────────────

function fakeLogger() {
  const calls: Array<{ level: string; msg: string }> = [];
  return {
    calls,
    info: (msg: string) => calls.push({ level: "info", msg }),
    warn: (msg: string) => calls.push({ level: "warn", msg }),
    error: (msg: string) => calls.push({ level: "error", msg }),
  };
}

test("notifyIfUnconfigured: silent when fully configured", () => {
  const logger = fakeLogger();
  const cfg = parseConfigValue({
    provider: "openai",
    credential: { source: "env", var: "OPENAI_API_KEY" },
  });
  assert.equal(notifyIfUnconfigured(logger, cfg, true), false);
  assert.equal(logger.calls.length, 0);
});

test("notifyIfUnconfigured: warns on interactive TTY when unconfigured", () => {
  const logger = fakeLogger();
  const cfg = parseConfigValue({}); // no provider/credential
  assert.equal(notifyIfUnconfigured(logger, cfg, true), true);
  assert.equal(logger.calls[0].level, "warn");
  assert.match(logger.calls[0].msg, /openclaw memgpt setup/);
});

test("notifyIfUnconfigured: info (not warn) when non-interactive", () => {
  const logger = fakeLogger();
  const cfg = parseConfigValue({});
  assert.equal(notifyIfUnconfigured(logger, cfg, false), true);
  assert.equal(logger.calls[0].level, "info");
});
