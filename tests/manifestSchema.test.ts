/**
 * Manifest ↔ parser schema-parity tests.
 *
 * The plugin's config surface is declared in TWO places: `ALLOWED_KEYS` +
 * validators in src/config.ts (what the plugin itself accepts) and
 * `configSchema` in openclaw.plugin.json (what the HOST enforces with
 * additionalProperties:false at config-write time). The wizard suite runs
 * against a fake ConfigIO, so host-side schema rejection is invisible to it —
 * v1.2.0 shipped with the four embedding* fields missing from the manifest,
 * and `openclaw memgpt setup` failed at the final write with
 * "must not have additional properties". These tests pin the two declarations
 * together so they cannot drift again.
 *
 * 1.3.1 hardening: the key-parity check now derives the parser's inventory
 * from the exported `ALLOWED_KEYS` itself, not from a hand-maintained list in
 * this file — v1.3.0 added `flushRatio` to ALLOWED_KEYS but not the manifest,
 * and the hand-maintained list (also missing it) let the drift through: any
 * gateway config that set flushRatio was refused at startup by
 * additionalProperties:false.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_KEYS, parseConfigValue } from "../src/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(here, "..", "openclaw.plugin.json"), "utf8"),
) as {
  version: string;
  configSchema: {
    additionalProperties: boolean;
    properties: Record<string, { enum?: string[] }>;
  };
};

const manifestKeys = Object.keys(manifest.configSchema.properties).sort();

test("manifest configSchema declares exactly the keys parseConfigValue accepts", () => {
  // A valid sample value per key — used to prove every declared key parses.
  const validValueFor: Record<string, unknown> = {
    namespace: "n",
    model: "m",
    persona: "p",
    human: "h",
    sidecarUrl: "http://127.0.0.1:1",
    observability: "off",
    flushRatio: 0.75,
    provider: "openai",
    baseUrl: "http://127.0.0.1:2",
    credential: { source: "file" },
    embeddingProvider: "openai-compatible",
    embeddingModel: "nomic-embed-text",
    embeddingEndpointUrl: "http://127.0.0.1:11434/v1",
    embeddingDim: 768,
  };

  // The authoritative parity check: manifest ↔ the parser's OWN key list.
  assert.deepEqual(
    manifestKeys,
    [...ALLOWED_KEYS].sort(),
    "openclaw.plugin.json configSchema.properties must declare exactly config.ts ALLOWED_KEYS — a key in ALLOWED_KEYS but not the manifest makes the gateway refuse to start when it is set (additionalProperties:false)",
  );

  // …and this file's sample-value table must cover every key.
  assert.deepEqual(
    manifestKeys,
    Object.keys(validValueFor).sort(),
    "add a sample value for the new config key to validValueFor",
  );

  // Every manifest-declared key is accepted by the parser…
  assert.doesNotThrow(() => parseConfigValue(validValueFor));

  // …and the parser rejects keys the manifest doesn't declare (same guard the
  // host applies via additionalProperties:false).
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.throws(
    () => parseConfigValue({ ...validValueFor, notARealKey: "x" }),
    /unknown keys/i,
  );
});

test("manifest embeddingProvider enum matches the parser's accepted ids", () => {
  const manifestEnum = manifest.configSchema.properties.embeddingProvider.enum;
  assert.deepEqual(manifestEnum?.sort(), ["huggingface", "openai-compatible"]);
  for (const id of manifestEnum ?? []) {
    const cfg: Record<string, unknown> = { embeddingProvider: id };
    if (id === "openai-compatible") {
      cfg.embeddingModel = "nomic-embed-text";
      cfg.embeddingDim = 768;
    }
    assert.doesNotThrow(() => parseConfigValue(cfg));
  }
});

test("manifest version matches package.json version", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(here, "..", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(
    manifest.version,
    pkg.version,
    "openclaw.plugin.json version drifted from package.json — bump both at release",
  );
});
