/**
 * collectAnswers flow tests (6d.6) using a scripted Prompter fake — no @clack,
 * no IO. Verifies Pattern-A sequencing, defaults, credential paths, re-entry
 * semantics, and cancel/decline aborts. Plus the validator helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectAnswers,
  type Prompter,
} from "../../src/wizard/prompts.ts";
import {
  validateEnvVarName,
  validateKeyFormat,
  validateUrl,
  PROVIDER_PRESETS,
} from "../../src/wizard/providers.ts";

const CANCEL = Symbol("cancel");

/** Returns queued values in prompt-invocation order across all prompt types. */
function scripted(queue: unknown[]): { p: Prompter; notes: string[] } {
  let i = 0;
  const notes: string[] = [];
  const next = () => queue[i++];
  // Mimic @clack: validate is invoked with `undefined` (empty field) and with
  // the entered value on keypress. Exercising it here reproduces the empty-field
  // crash class that the original scripted fake (which never called validate)
  // missed — a validator that throws on undefined fails the test naturally.
  const runValidate = (
    opts: { validate?: (v: string | undefined) => string | undefined },
    v: unknown,
  ) => {
    opts.validate?.(undefined);
    if (typeof v === "string") opts.validate?.(v);
  };
  const p: Prompter = {
    intro() {},
    outro() {},
    note(m) {
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
  return { p, notes };
}

test("fresh anthropic + paste → file credential with pasted key", async () => {
  const { p, notes } = scripted([
    "anthropic", // provider
    "paste", // credential method
    "sk-ant-key123", // pasted key
    "claude-sonnet-4-5-20250929", // model
    "huggingface", // embedder (built-in)
    "off", // observability
    "", // sidecar (blank)
    true, // apply
  ]);
  const a = await collectAnswers(p);
  assert.ok(a);
  assert.equal(a!.provider, "anthropic");
  assert.deepEqual(a!.credential, { source: "file" });
  assert.equal(a!.pastedKey, "sk-ant-key123");
  assert.equal(a!.removeOldSecretFile, false);
  assert.equal(a!.model, "claude-sonnet-4-5-20250929");
  assert.equal(a!.observability, "off");
  assert.equal(a!.sidecarUrl, undefined);
  assert.equal(a!.baseUrl, undefined); // direct provider: no base prompt
  assert.ok(notes.some((n) => n.includes("Provider:")), "summary note shown");
});

test("fresh openai + env → env credential, no pasted key", async () => {
  const { p } = scripted([
    "openai",
    "env",
    "MY_OPENAI_KEY",
    "gpt-4o",
    "huggingface", // embedder
    "default",
    "",
    true,
  ]);
  const a = await collectAnswers(p);
  assert.ok(a);
  assert.deepEqual(a!.credential, { source: "env", var: "MY_OPENAI_KEY" });
  assert.equal(a!.pastedKey, undefined);
  assert.equal(a!.observability, "default");
});

test("openai-compatible requires + captures a base URL", async () => {
  const { p } = scripted([
    "openai-compatible",
    "http://127.0.0.1:4000/v1", // base url
    "paste",
    "sk-local",
    "my-local-model",
    "huggingface", // embedder
    "off",
    "http://127.0.0.1:9000", // sidecar override
    true,
  ]);
  const a = await collectAnswers(p);
  assert.ok(a);
  assert.equal(a!.baseUrl, "http://127.0.0.1:4000/v1");
  assert.equal(a!.model, "my-local-model");
  assert.equal(a!.sidecarUrl, "http://127.0.0.1:9000");
});

test("cancel at the first prompt aborts (returns null)", async () => {
  const { p, notes } = scripted([CANCEL]);
  const a = await collectAnswers(p);
  assert.equal(a, null);
  assert.equal(notes.length, 0, "no summary on early cancel");
});

test("declining the summary confirm aborts", async () => {
  const { p } = scripted([
    "anthropic",
    "paste",
    "sk-ant-k",
    "claude-x",
    "huggingface", // embedder
    "off",
    "",
    false, // decline apply
  ]);
  assert.equal(await collectAnswers(p), null);
});

test("re-entry: existing file credential, keep → no new key", async () => {
  const { p } = scripted([
    "anthropic", // provider (prefilled)
    "keep", // credential choice
    "claude-x",
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const a = await collectAnswers(p, {
    provider: "anthropic",
    credential: { source: "file" },
    model: "claude-x",
  });
  assert.ok(a);
  assert.deepEqual(a!.credential, { source: "file" });
  assert.equal(a!.pastedKey, undefined);
  assert.equal(a!.removeOldSecretFile, false);
});

test("re-entry: existing file credential, switch → env + remove flag", async () => {
  const { p } = scripted([
    "anthropic",
    "switch", // file → env
    "NEW_ENV_VAR", // env var name
    "claude-x",
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const a = await collectAnswers(p, {
    provider: "anthropic",
    credential: { source: "file" },
  });
  assert.ok(a);
  assert.deepEqual(a!.credential, { source: "env", var: "NEW_ENV_VAR" });
  assert.equal(a!.removeOldSecretFile, true);
  assert.equal(a!.pastedKey, undefined);
});

test("re-entry: existing env credential, switch → paste a key", async () => {
  const { p } = scripted([
    "openai",
    "switch", // env → paste
    "sk-new-pasted",
    "gpt-4o",
    "huggingface", // embedder
    "off",
    "",
    true,
  ]);
  const a = await collectAnswers(p, {
    provider: "openai",
    credential: { source: "env", var: "OLD" },
  });
  assert.ok(a);
  assert.deepEqual(a!.credential, { source: "file" });
  assert.equal(a!.pastedKey, "sk-new-pasted");
  assert.equal(a!.removeOldSecretFile, false);
});

// ── validators ─────────────────────────────────────────────────────────────

test("validateKeyFormat: rejects empty + wrong prefix, accepts good", () => {
  const anthropic = PROVIDER_PRESETS.anthropic;
  assert.match(validateKeyFormat("", anthropic)!, /empty/i);
  assert.match(validateKeyFormat("sk-wrong", anthropic)!, /sk-ant-/);
  assert.equal(validateKeyFormat("sk-ant-good", anthropic), undefined);
  // compatible has no prefix → only empty rejected
  assert.equal(
    validateKeyFormat("anything", PROVIDER_PRESETS["openai-compatible"]),
    undefined,
  );
});

test("validateEnvVarName: enforces [A-Z_][A-Z0-9_]*", () => {
  assert.equal(validateEnvVarName("ANTHROPIC_API_KEY"), undefined);
  assert.ok(validateEnvVarName("9bad"));
  assert.ok(validateEnvVarName("lower"));
});

test("validateUrl: accepts http(s), rejects junk", () => {
  assert.equal(validateUrl("http://127.0.0.1:4000/v1"), undefined);
  assert.equal(validateUrl("https://api.openai.com/v1"), undefined);
  assert.ok(validateUrl("not a url"));
  assert.ok(validateUrl("ftp://x"));
});

test("validators tolerate undefined (@clack empty-field contract)", () => {
  // @clack calls validate(undefined) for an empty field — these must not throw.
  assert.doesNotThrow(() => validateUrl(undefined));
  assert.doesNotThrow(() => validateEnvVarName(undefined));
  assert.doesNotThrow(() =>
    validateKeyFormat(undefined, PROVIDER_PRESETS.anthropic),
  );
  // and each treats "empty" as invalid (returns an error string)
  assert.ok(validateUrl(undefined));
  assert.ok(validateEnvVarName(undefined));
  assert.ok(validateKeyFormat(undefined, PROVIDER_PRESETS.anthropic));
});

test("blank optional sidecar returned as undefined → sidecarUrl undefined (no throw)", async () => {
  // The TTY crash: an empty optional text field resolves to `undefined`, and
  // the post-prompt `.trim()` must not throw. Script `undefined` for sidecar.
  const { p } = scripted([
    "anthropic",
    "paste",
    "sk-ant-key",
    "claude-x",
    "off",
    undefined, // sidecar: empty field → @clack returns undefined
    true,
  ]);
  const a = await collectAnswers(p);
  assert.ok(a);
  assert.equal(a!.sidecarUrl, undefined);
});

// ── embedder flow (openai-compatible + dim probe) ───────────────────────────

test("openai-compatible embedder: probe success → dim measured, no manual prompt", async () => {
  const { p, notes } = scripted([
    "anthropic",
    "paste",
    "sk-ant-key123",
    "claude-x",
    "openai-compatible", // embedder
    "http://127.0.0.1:11434/v1", // embedding endpoint
    "nomic-embed-text", // embedding model
    // NO dim entry — the probe supplies it
    "off",
    "",
    true,
  ]);
  const probed: Array<[string, string]> = [];
  const a = await collectAnswers(p, {}, {
    probeDim: async (endpoint, model) => {
      probed.push([endpoint, model]);
      return 768;
    },
  });
  assert.ok(a);
  assert.equal(a!.embeddingProvider, "openai-compatible");
  assert.equal(a!.embeddingModel, "nomic-embed-text");
  assert.equal(a!.embeddingEndpointUrl, "http://127.0.0.1:11434/v1");
  assert.equal(a!.embeddingDim, 768);
  assert.deepEqual(probed, [["http://127.0.0.1:11434/v1", "nomic-embed-text"]]);
  assert.ok(
    notes.some((n) => n.includes("768-dimensional")),
    "detected-dim note shown",
  );
  assert.ok(
    notes.some((n) => n.includes("nomic-embed-text @ http://127.0.0.1:11434/v1 (768-dim)")),
    "summary shows the embedder line",
  );
});

test("openai-compatible embedder: probe failure → manual dim prompt", async () => {
  const { p, notes } = scripted([
    "anthropic",
    "paste",
    "sk-ant-key123",
    "claude-x",
    "openai-compatible",
    "http://127.0.0.1:11434/v1",
    "nomic-embed-text",
    "768", // manual dim (probe failed)
    "off",
    "",
    true,
  ]);
  const a = await collectAnswers(p, {}, { probeDim: async () => undefined });
  assert.ok(a);
  assert.equal(a!.embeddingDim, 768);
  assert.ok(
    notes.some((n) => n.includes("Couldn't probe")),
    "probe-failure note shown",
  );
});

test("built-in embedder leaves the embedding fields unset", async () => {
  const { p } = scripted([
    "anthropic",
    "paste",
    "sk-ant-key123",
    "claude-x",
    "huggingface",
    "off",
    "",
    true,
  ]);
  const a = await collectAnswers(p);
  assert.ok(a);
  assert.equal(a!.embeddingProvider, "huggingface");
  assert.equal(a!.embeddingModel, undefined);
  assert.equal(a!.embeddingEndpointUrl, undefined);
  assert.equal(a!.embeddingDim, undefined);
});
