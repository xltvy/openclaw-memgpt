/**
 * parseConfig unit tests (6c.0).
 *
 * Three cases per the task spec — happy path, missing required field,
 * invalid enum — plus a fourth covering the unknown-key guard, which is
 * implicit in the parser but worth pinning so refactors don't silently
 * drop it. Uses node:test (built-in, no test-runner dep).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { embeddingEnv, parseConfigValue, isConfigComplete } from "../src/config.ts";

const VALID = {
  namespace: "test-agent",
  model: "gpt-4",
  persona: "I am Sam.",
  human: "User unknown.",
} as const;

test("parseConfig: happy path returns typed PluginConfig; observability defaults to off", () => {
  const cfg = parseConfigValue(VALID);
  assert.equal(cfg.namespace, "test-agent");
  assert.equal(cfg.model, "gpt-4");
  assert.equal(cfg.persona, "I am Sam.");
  assert.equal(cfg.human, "User unknown.");
  assert.equal(cfg.sidecarUrl, undefined);
  // Unset observability defaults to "off" (matches the wizard default; §6).
  assert.equal(cfg.observability, "off");
});

test("parseConfig: happy path with all optional fields set", () => {
  const cfg = parseConfigValue({
    ...VALID,
    sidecarUrl: "http://127.0.0.1:9999",
    observability: "verbose",
  });
  assert.equal(cfg.sidecarUrl, "http://127.0.0.1:9999");
  assert.equal(cfg.observability, "verbose");
});

test("parseConfig: missing namespace defaults to 'default'", () => {
  const { namespace: _, ...withoutNamespace } = VALID;
  const cfg = parseConfigValue(withoutNamespace);
  assert.equal(cfg.namespace, "default");
});

test("parseConfig: invalid observability throws with the rejected value in the message", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, observability: "loud" }),
    /observability.*off.*default.*verbose.*loud/i,
  );
});

test("parseConfig: unknown key throws (guard against typos / spec drift)", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, mispelled: "oops" }),
    /unknown keys.*mispelled/i,
  );
});

test("parseConfig: null/undefined treated as empty config (all defaults apply)", () => {
  const cfg = parseConfigValue(null);
  assert.equal(cfg.namespace, "default");
  const cfg2 = parseConfigValue(undefined);
  assert.equal(cfg2.namespace, "default");
});

test("parseConfig: non-object input throws", () => {
  assert.throws(() => parseConfigValue("string"), /object/i);
  assert.throws(() => parseConfigValue([]), /object/i);
});

// ── 6d.6 wizard fields ───────────────────────────────────────────────────────

test("parseConfig: provider/baseUrl/credential parse when set", () => {
  const cfg = parseConfigValue({
    ...VALID,
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:4000/v1",
    credential: { source: "env", var: "OPENAI_API_KEY" },
  });
  assert.equal(cfg.provider, "openai-compatible");
  assert.equal(cfg.baseUrl, "http://127.0.0.1:4000/v1");
  assert.deepEqual(cfg.credential, { source: "env", var: "OPENAI_API_KEY" });
});

test("parseConfig: provider/baseUrl/credential default to undefined", () => {
  const cfg = parseConfigValue(VALID);
  assert.equal(cfg.provider, undefined);
  assert.equal(cfg.baseUrl, undefined);
  assert.equal(cfg.credential, undefined);
});

test("parseConfig: file credential needs only source", () => {
  const cfg = parseConfigValue({ ...VALID, credential: { source: "file" } });
  assert.deepEqual(cfg.credential, { source: "file" });
});

test("parseConfig: invalid provider throws", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, provider: "gemini" }),
    /provider.*anthropic.*openai/i,
  );
});

test("parseConfig: credential with bad source throws", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, credential: { source: "keychain" } }),
    /credential\.source/i,
  );
});

test("parseConfig: env credential with malformed var name throws", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, credential: { source: "env", var: "9bad" } }),
    /environment variable name/i,
  );
});

test("isConfigComplete: requires provider AND credential", () => {
  assert.equal(isConfigComplete(parseConfigValue(VALID)), false);
  assert.equal(
    isConfigComplete(parseConfigValue({ ...VALID, provider: "openai" })),
    false,
  );
  assert.equal(
    isConfigComplete(
      parseConfigValue({
        ...VALID,
        provider: "openai",
        credential: { source: "file" },
      }),
    ),
    true,
  );
});

// ── embedder configuration (embeddingProvider / Model / EndpointUrl / Dim) ──

test("parseConfig: embedding fields absent — all undefined (built-in defaults)", () => {
  const cfg = parseConfigValue(VALID);
  assert.equal(cfg.embeddingProvider, undefined);
  assert.equal(cfg.embeddingModel, undefined);
  assert.equal(cfg.embeddingEndpointUrl, undefined);
  assert.equal(cfg.embeddingDim, undefined);
});

test("parseConfig: openai-compatible embedder happy path", () => {
  const cfg = parseConfigValue({
    ...VALID,
    embeddingProvider: "openai-compatible",
    embeddingModel: "nomic-embed-text",
    embeddingEndpointUrl: "http://127.0.0.1:11434/v1",
    embeddingDim: 768,
  });
  assert.equal(cfg.embeddingProvider, "openai-compatible");
  assert.equal(cfg.embeddingModel, "nomic-embed-text");
  assert.equal(cfg.embeddingEndpointUrl, "http://127.0.0.1:11434/v1");
  assert.equal(cfg.embeddingDim, 768);
});

test("parseConfig: invalid embeddingProvider throws with allowed values", () => {
  assert.throws(
    () => parseConfigValue({ ...VALID, embeddingProvider: "ollama" }),
    /embeddingProvider.*huggingface.*openai-compatible.*ollama/i,
  );
});

test("parseConfig: openai-compatible embedder without model throws", () => {
  assert.throws(
    () =>
      parseConfigValue({
        ...VALID,
        embeddingProvider: "openai-compatible",
        embeddingDim: 768,
      }),
    /embeddingModel.*required/i,
  );
});

test("parseConfig: openai-compatible embedder without dim throws", () => {
  assert.throws(
    () =>
      parseConfigValue({
        ...VALID,
        embeddingProvider: "openai-compatible",
        embeddingModel: "nomic-embed-text",
      }),
    /embeddingDim.*required/i,
  );
});

test("parseConfig: custom huggingface model without dim throws; default model ok", () => {
  assert.throws(
    () =>
      parseConfigValue({ ...VALID, embeddingModel: "BAAI/bge-large-en-v1.5" }),
    /embeddingDim.*required/i,
  );
  // The default bge-small model needs no dim (the sidecar knows it's 384).
  const cfg = parseConfigValue({
    ...VALID,
    embeddingProvider: "huggingface",
    embeddingModel: "BAAI/bge-small-en-v1.5",
  });
  assert.equal(cfg.embeddingDim, undefined);
});

test("parseConfig: embeddingDim must be a positive integer", () => {
  for (const bad of [0, -5, 3.14, "768"]) {
    assert.throws(
      () =>
        parseConfigValue({
          ...VALID,
          embeddingProvider: "openai-compatible",
          embeddingModel: "nomic-embed-text",
          embeddingDim: bad,
        }),
      /embeddingDim.*positive integer/i,
    );
  }
});

test("embeddingEnv: maps config to OPENCLAW_MEMGPT_EMBEDDING_* with underscore provider", () => {
  const env = embeddingEnv(
    parseConfigValue({
      ...VALID,
      embeddingProvider: "openai-compatible",
      embeddingModel: "nomic-embed-text",
      embeddingEndpointUrl: "http://127.0.0.1:11434/v1",
      embeddingDim: 768,
    }),
  );
  assert.deepEqual(env, {
    OPENCLAW_MEMGPT_EMBEDDING_PROVIDER: "openai_compatible",
    OPENCLAW_MEMGPT_EMBEDDING_MODEL: "nomic-embed-text",
    OPENCLAW_MEMGPT_EMBEDDING_ENDPOINT_URL: "http://127.0.0.1:11434/v1",
    OPENCLAW_MEMGPT_EMBEDDING_DIM: "768",
  });
});

test("embeddingEnv: unconfigured embedder yields an empty object (sidecar defaults + no ini reconcile)", () => {
  assert.deepEqual(embeddingEnv(parseConfigValue(VALID)), {});
});
