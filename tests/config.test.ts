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

import { parseConfigValue, isConfigComplete } from "../src/config.ts";

const VALID = {
  namespace: "test-agent",
  model: "gpt-4",
  persona: "I am Sam.",
  human: "User unknown.",
} as const;

test("parseConfig: happy path returns typed PluginConfig with default observability", () => {
  const cfg = parseConfigValue(VALID);
  assert.equal(cfg.namespace, "test-agent");
  assert.equal(cfg.model, "gpt-4");
  assert.equal(cfg.persona, "I am Sam.");
  assert.equal(cfg.human, "User unknown.");
  assert.equal(cfg.sidecarUrl, undefined);
  assert.equal(cfg.observability, "default");
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
