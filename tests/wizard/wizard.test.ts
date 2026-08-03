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
import { runPrewarm, runWizard } from "../../src/wizard/wizard.ts";

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
    entry: () => cfg?.plugins?.entries?.[PLUGIN_ID] ?? {},
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
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true, // stub: don't hit the network in unit tests
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
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true, // stub: don't hit the network in unit tests
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
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true, // stub: don't hit the network in unit tests
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
    reachable: async () => true, // stub: don't hit the network in unit tests
  });
  assert.equal(res.status, "cancelled");
  assert.deepEqual(h.order, []);
});

test("wizard grants conversation access + surfaces the note", async () => {
  const h = harness();
  // full apply, then decline the pre-warm offer (uv present)
  const prompter = scripted([
    "anthropic", "paste", "sk-ant-x", "claude-x", "huggingface", "off", "", true, false,
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => true,
    prewarmEmbedder: async () => true,
  });
  assert.equal(res.status, "applied");
  assert.equal(h.entry().hooks.allowConversationAccess, true, "must grant conversation access");
  assert.ok(
    prompter.notes.some((n) => /conversation access/i.test(n)),
    "must surface the conversation-access note",
  );
});

// ── prerequisite (uv) + cold-start guidance ──────────────────────────────────

const SPAWN_PASTE_FLOW = [
  "anthropic",
  "paste",
  "sk-ant-key",
  "claude-x",
  "huggingface", // embedder
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
    reachable: async () => true, // stub: don't hit the network in unit tests
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

test("spawn mode + uv present → offers pre-warm; declining notes the deferred cold-start", async () => {
  const h = harness();
  // …apply=true, then DECLINE the pre-warm confirm.
  const prompter = scripted([...SPAWN_PASTE_FLOW, false]);
  let prewarmCalled = false;
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true, // stub: don't hit the network in unit tests
    checkUv: async () => true,
    prewarmEmbedder: async () => {
      prewarmCalled = true;
      return true;
    },
  });
  assert.ok(!prompter.notes.some((n) => n.includes("install uv") || n.includes("`uv`")));
  assert.equal(prewarmCalled, false, "declining pre-warm must not run it");
  assert.ok(
    prompter.notes.some((n) => /Skipped pre-warm|embedding model/.test(n)),
    "declining must note the deferred download",
  );
});

test("spawn mode + uv present + accept pre-warm → runs it; notes ready on success", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW, true]); // accept pre-warm
  let prewarmStateDir: string | undefined;
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => true,
    prewarmEmbedder: async (sd) => {
      prewarmStateDir = sd;
      return true;
    },
  });
  assert.equal(prewarmStateDir, "/state", "pre-warm must receive the state dir");
  assert.ok(
    prompter.notes.some((n) => /Embedder cached|first agent turn will be fast/.test(n)),
    "successful pre-warm must note readiness",
  );
});

test("spawn mode + accept pre-warm but it fails → harmless heads-up, wizard still applies", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW, true]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => true,
    prewarmEmbedder: async () => false, // simulate prewarm failure
  });
  assert.equal(res.status, "applied", "a failed pre-warm must not fail the wizard");
  assert.ok(
    prompter.notes.some((n) => /didn't finish|download the embedding model/.test(n)),
    "failed pre-warm must note the harmless fallback",
  );
});

test("spawn mode + uv missing → no pre-warm offered; warns uv + cold-start", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW]);
  let prewarmCalled = false;
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => false,
    prewarmEmbedder: async () => {
      prewarmCalled = true;
      return true;
    },
  });
  assert.equal(prewarmCalled, false, "no pre-warm without uv");
  assert.ok(prompter.notes.some((n) => /60.?90s|embedding model/.test(n)));
});

test("attach mode (sidecarUrl set) → skips uv check + spawn guidance", async () => {
  const h = harness();
  const prompter = scripted([
    "anthropic",
    "paste",
    "sk-ant-key",
    "claude-x",
    "huggingface", // embedder
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
    reachable: async () => true, // stub: don't hit the network in unit tests
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

// ── endpoint reachability ────────────────────────────────────────────────────

test("unreachable LLM endpoint → 'Endpoint not reachable' note", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW]);
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    checkUv: async () => true,
    reachable: async () => false,
  });
  assert.ok(
    prompter.notes.some((n) => /reach/i.test(n)),
    "must warn when the configured LLM endpoint is unreachable",
  );
});

test("reachable LLM endpoint → no reachability warning", async () => {
  const h = harness();
  const prompter = scripted([...SPAWN_PASTE_FLOW]);
  await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    checkUv: async () => true,
    reachable: async () => true,
  });
  assert.ok(!prompter.notes.some((n) => /reach/i.test(n)));
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

// ── runPrewarm (standalone `openclaw memgpt prewarm`) ─────────────────────────

test("runPrewarm: success → returns true, runs prewarm with the state dir, notes ready", async () => {
  const logger = fakeLogger();
  const h = harness();
  let calledWith: string | undefined;
  const ok = await runPrewarm({
    logger,
    stateDir: "/state",
    configIO: h.configIO,
    checkUv: async () => true,
    prewarmEmbedder: async (sd) => {
      calledWith = sd;
      return true;
    },
  });
  assert.equal(ok, true);
  assert.equal(calledWith, "/state", "prewarm must receive the state dir");
  assert.ok(logger.calls.some((c) => /cached|offline-fast/.test(c.msg)));
});

test("runPrewarm: uv missing → returns false, does not run prewarm", async () => {
  const logger = fakeLogger();
  const h = harness();
  let ran = false;
  const ok = await runPrewarm({
    logger,
    stateDir: "/state",
    configIO: h.configIO,
    checkUv: async () => false,
    prewarmEmbedder: async () => {
      ran = true;
      return true;
    },
  });
  assert.equal(ok, false);
  assert.equal(ran, false, "no prewarm without uv");
  assert.ok(logger.calls.some((c) => c.level === "error" && /uv/.test(c.msg)));
});

test("runPrewarm: prewarm fails → returns false, notes harmless fallback", async () => {
  const logger = fakeLogger();
  const h = harness();
  const ok = await runPrewarm({
    logger,
    stateDir: "/state",
    configIO: h.configIO,
    checkUv: async () => true,
    prewarmEmbedder: async () => false,
  });
  assert.equal(ok, false);
  assert.ok(logger.calls.some((c) => c.level === "error" && /download the model/.test(c.msg)));
});

test("runPrewarm: remote embedder configured → no-op success, no uv check, no prewarm", async () => {
  const logger = fakeLogger();
  const h = harness({
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            embeddingProvider: "openai-compatible",
            embeddingModel: "nomic-embed-text",
            embeddingEndpointUrl: "http://127.0.0.1:11434/v1",
            embeddingDim: 768,
          },
        },
      },
    },
  });
  let uvChecked = false;
  let ran = false;
  const ok = await runPrewarm({
    logger,
    stateDir: "/state",
    configIO: h.configIO,
    checkUv: async () => {
      uvChecked = true;
      return true;
    },
    prewarmEmbedder: async () => {
      ran = true;
      return true;
    },
  });
  assert.equal(ok, true, "remote embedder → nothing to pre-warm counts as success");
  assert.equal(uvChecked, false);
  assert.equal(ran, false);
  assert.ok(logger.calls.some((c) => /nothing to pre-warm/.test(c.msg)));
});

test("runPrewarm: custom huggingface model → embedder env pins passed to the subprocess", async () => {
  const logger = fakeLogger();
  const h = harness({
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            embeddingProvider: "huggingface",
            embeddingModel: "BAAI/bge-large-en-v1.5",
            embeddingDim: 1024,
          },
        },
      },
    },
  });
  let capturedEnv: Record<string, string> | undefined;
  const ok = await runPrewarm({
    logger,
    stateDir: "/state",
    configIO: h.configIO,
    checkUv: async () => true,
    prewarmEmbedder: async (_sd, extraEnv) => {
      capturedEnv = extraEnv;
      return true;
    },
  });
  assert.equal(ok, true);
  assert.equal(
    capturedEnv?.OPENCLAW_MEMGPT_EMBEDDING_MODEL,
    "BAAI/bge-large-en-v1.5",
    "prewarm must warm the CONFIGURED model's cache, not the default's",
  );
  assert.equal(capturedEnv?.OPENCLAW_MEMGPT_EMBEDDING_DIM, "1024");
});

// ── embedder persistence + remote-embedder wizard guidance ──────────────────

const COMPAT_EMBEDDER_FLOW = [
  "anthropic",
  "paste",
  "sk-ant-key",
  "claude-x",
  "openai-compatible", // embedder
  "http://127.0.0.1:11434/v1", // embedding endpoint
  "nomic-embed-text", // embedding model
  // dim supplied by the probe stub
  "off",
  "", // sidecar blank → spawn mode
  true,
];

test("openai-compatible embedder: fields persisted; prewarm not offered; endpoint note shown", async () => {
  const h = harness();
  const prompter = scripted([...COMPAT_EMBEDDER_FLOW]);
  let prewarmCalled = false;
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => true,
    probeDim: async () => 768,
    prewarmEmbedder: async () => {
      prewarmCalled = true;
      return true;
    },
  });
  assert.equal(res.status, "applied");
  const block = h.block();
  assert.equal(block.embeddingProvider, "openai-compatible");
  assert.equal(block.embeddingModel, "nomic-embed-text");
  assert.equal(block.embeddingEndpointUrl, "http://127.0.0.1:11434/v1");
  assert.equal(block.embeddingDim, 768);
  assert.equal(prewarmCalled, false, "nothing to pre-warm for a remote embedder");
  assert.ok(
    prompter.notes.some((n) => /No embedding model download needed/.test(n)),
    "remote-embedder note must replace the prewarm offer",
  );
});

test("switching back to the built-in embedder clears the stale embedding fields", async () => {
  const h = harness({
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: {
            provider: "anthropic",
            credential: { source: "env", var: "K" },
            embeddingProvider: "openai-compatible",
            embeddingModel: "nomic-embed-text",
            embeddingEndpointUrl: "http://127.0.0.1:11434/v1",
            embeddingDim: 768,
          },
        },
      },
    },
  });
  const prompter = scripted([
    "anthropic",
    "keep", // keep env credential
    "claude-x",
    "huggingface", // switch embedder back to built-in
    "off",
    "",
    true,
    false, // decline prewarm
  ]);
  const res = await runWizard({
    prompter,
    configIO: h.configIO,
    secretIO: h.secretIO,
    stateDir: "/state",
    reachable: async () => true,
    checkUv: async () => true,
    prewarmEmbedder: async () => true,
  });
  assert.equal(res.status, "applied");
  const block = h.block();
  assert.equal(block.embeddingProvider, "huggingface");
  assert.equal("embeddingModel" in block, false, "stale model must be deleted");
  assert.equal("embeddingEndpointUrl" in block, false, "stale endpoint must be deleted");
  assert.equal("embeddingDim" in block, false, "stale dim must be deleted");
});
