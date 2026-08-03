/**
 * Interactive prompt flow for the 6d.6 install wizard.
 *
 * Pattern A: required prompts first, optional second, summary + confirm last.
 * UX uses @clack/prompts (OpenClaw's own prompt library — house-consistent
 * intro/outro/note, masked password, cancel handling).
 *
 * `collectAnswers` is written against a `Prompter` interface, not @clack
 * directly, so it can be unit-tested with a scripted fake. `clackPrompter` is
 * the production implementation. Any prompt returning the cancel sentinel
 * aborts the whole flow (returns `null`); the orchestrator writes nothing.
 */

import * as clack from "@clack/prompts";

import type {
  CredentialRef,
  EmbeddingProviderId,
  ObservabilityLevel,
  ProviderId,
} from "../config.ts";
import { probeEmbeddingDim } from "./embedderProbe.ts";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESETS,
  validateEnvVarName,
  validateKeyFormat,
  validateUrl,
} from "./providers.ts";

// ---------------------------------------------------------------------------
// Prompter seam
// ---------------------------------------------------------------------------

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  select<T>(opts: {
    message: string;
    options: SelectOption<T>[];
    initialValue?: T;
  }): Promise<T | symbol>;
  text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
    // @clack passes `undefined` (not "") for an empty field — validators must
    // tolerate it. See `asText` and the validate* helpers in providers.ts.
    validate?: (value: string | undefined) => string | undefined;
  }): Promise<string | symbol>;
  password(opts: {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
  }): Promise<string | symbol>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<
    boolean | symbol
  >;
  isCancel(value: unknown): boolean;
  cancel(message?: string): void;
}

/** Production prompter backed by @clack/prompts. */
export const clackPrompter: Prompter = {
  intro: (m) => clack.intro(m),
  outro: (m) => clack.outro(m),
  note: (m, t) => clack.note(m, t),
  select: (opts) => clack.select(opts as never) as Promise<never>,
  text: (opts) => clack.text(opts as never) as Promise<string | symbol>,
  password: (opts) =>
    clack.password(opts as never) as Promise<string | symbol>,
  confirm: (opts) => clack.confirm(opts) as Promise<boolean | symbol>,
  isCancel: (v) => clack.isCancel(v),
  cancel: (m) => clack.cancel(m),
};

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface WizardAnswers {
  provider: ProviderId;
  /** Entered only for openai-compatible; for direct providers the orchestrator
   *  fills the preset default. */
  baseUrl?: string;
  model: string;
  credential: CredentialRef;
  /** Present when a new key was pasted (fresh / replace / env→file switch). */
  pastedKey?: string;
  /** True when switching file→env: the old secret file should be removed. */
  removeOldSecretFile: boolean;
  /** Embedder for vector memory. The remaining embedding* fields are set only
   *  for `openai-compatible` (built-in bge needs no parameters). */
  embeddingProvider: EmbeddingProviderId;
  embeddingModel?: string;
  embeddingEndpointUrl?: string;
  embeddingDim?: number;
  observability: ObservabilityLevel;
  sidecarUrl?: string;
}

/** Injectable IO for `collectAnswers` (tests script it; production defaults). */
export interface CollectDeps {
  /** Embedding-dimension probe (embedderProbe.ts). Injected in tests. */
  probeDim?: (endpointUrl: string, model: string) => Promise<number | undefined>;
}

const OBSERVABILITY_OPTIONS: SelectOption<ObservabilityLevel>[] = [
  { value: "off", label: "off", hint: "no event capture (default)" },
  {
    value: "default",
    label: "default",
    hint: "metadata-only events to events.jsonl",
  },
  {
    value: "verbose",
    label: "verbose",
    hint: "full content — research / provenance use",
  },
];

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * Run the prompt sequence. `existing` is the current plugin config block (empty
 * on first install) used to prefill defaults on re-entry. Returns the collected
 * answers, or `null` if the user cancelled at any point.
 */
export async function collectAnswers(
  p: Prompter,
  existing: Record<string, unknown> = {},
  deps: CollectDeps = {},
): Promise<WizardAnswers | null> {
  const existingProvider = existing.provider as ProviderId | undefined;
  const existingCred = existing.credential as CredentialRef | undefined;
  const existingModel =
    typeof existing.model === "string" ? existing.model : undefined;
  const existingBaseUrl =
    typeof existing.baseUrl === "string" ? existing.baseUrl : undefined;
  const existingEmbProvider = existing.embeddingProvider as
    | EmbeddingProviderId
    | undefined;
  const existingEmbModel =
    typeof existing.embeddingModel === "string"
      ? existing.embeddingModel
      : undefined;
  const existingEmbEndpoint =
    typeof existing.embeddingEndpointUrl === "string"
      ? existing.embeddingEndpointUrl
      : undefined;
  const existingObs =
    typeof existing.observability === "string"
      ? (existing.observability as ObservabilityLevel)
      : undefined;
  const existingSidecar =
    typeof existing.sidecarUrl === "string" ? existing.sidecarUrl : undefined;

  const reconfigure = existingProvider !== undefined;
  p.intro(
    reconfigure
      ? "openclaw-memgpt — reconfigure"
      : "openclaw-memgpt — first-time setup",
  );

  // ── Required: provider ───────────────────────────────────────────────────
  const provider = await p.select<ProviderId>({
    message: "Which LLM provider should the memory sidecar use?",
    options: PROVIDER_ORDER.map((id) => ({
      value: id,
      label: PROVIDER_PRESETS[id].label,
    })),
    initialValue: existingProvider ?? "anthropic",
  });
  if (p.isCancel(provider)) return cancelled(p);
  const preset = PROVIDER_PRESETS[provider as ProviderId];

  // ── Required: base URL (openai-compatible only) ──────────────────────────
  let baseUrl: string | undefined;
  if (preset.requiresBaseUrl) {
    const entered = await p.text({
      message: "Base URL of the OpenAI-compatible endpoint",
      placeholder: "http://127.0.0.1:4000/v1",
      initialValue: existingBaseUrl,
      validate: (v) => validateUrl(v),
    });
    if (p.isCancel(entered)) return cancelled(p);
    baseUrl = asText(entered).trim();
  }

  // ── Required: credential ─────────────────────────────────────────────────
  const credResult = await collectCredential(p, preset, existingCred);
  if (credResult === null) return cancelled(p);

  // ── Required: model ──────────────────────────────────────────────────────
  const model = await p.text({
    message: "Which model should the sidecar use?",
    placeholder: preset.defaultModel,
    initialValue: existingModel ?? preset.defaultModel,
    validate: (v) =>
      (v ?? "").trim().length === 0 ? "Model name is required" : undefined,
  });
  if (p.isCancel(model)) return cancelled(p);

  // ── Required: embedder ────────────────────────────────────────────────────
  // First-class install-time choice (the sidecar's vector memory). Built-in
  // bge is zero-config; the openai-compatible path needs endpoint + model, and
  // the dim is MEASURED via a live probe where possible — a wrong dim is
  // silent until the vector store misbehaves, so we don't ask users to know it.
  const embeddingProvider = await p.select<EmbeddingProviderId>({
    message: "Which embedding model should memory search use?",
    options: [
      {
        value: "huggingface",
        label: "Built-in (bge-small, runs in-process)",
        hint: "no extra server; ~60–90s one-time download",
      },
      {
        value: "openai-compatible",
        label: "OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, LiteLLM)",
        hint: "no download; the server must host the model",
      },
    ],
    initialValue: existingEmbProvider ?? "huggingface",
  });
  if (p.isCancel(embeddingProvider)) return cancelled(p);

  let embeddingModel: string | undefined;
  let embeddingEndpointUrl: string | undefined;
  let embeddingDim: number | undefined;
  if (embeddingProvider === "openai-compatible") {
    const endpointEntered = await p.text({
      message: "Base URL of the embedding endpoint",
      placeholder: "http://127.0.0.1:11434/v1",
      initialValue: existingEmbEndpoint ?? "http://127.0.0.1:11434/v1",
      validate: (v) => validateUrl(v),
    });
    if (p.isCancel(endpointEntered)) return cancelled(p);
    embeddingEndpointUrl = asText(endpointEntered).trim();

    const embModelEntered = await p.text({
      message: "Embedding model name (as the endpoint knows it)",
      placeholder: "nomic-embed-text",
      initialValue: existingEmbModel,
      validate: (v) =>
        (v ?? "").trim().length === 0
          ? "Embedding model name is required"
          : undefined,
    });
    if (p.isCancel(embModelEntered)) return cancelled(p);
    embeddingModel = asText(embModelEntered).trim();

    const probe = deps.probeDim ?? probeEmbeddingDim;
    p.note(
      `Measuring the embedding dimension against ${embeddingEndpointUrl} …`,
      "Probing endpoint",
    );
    embeddingDim = await probe(embeddingEndpointUrl, embeddingModel);
    if (embeddingDim !== undefined) {
      p.note(
        `${embeddingModel} returns ${embeddingDim}-dimensional vectors.`,
        "Detected",
      );
    } else {
      p.note(
        `Couldn't probe ${embeddingEndpointUrl} (endpoint down, model not hosted, or auth-gated). Enter the dimension manually — it must match the vector length the model returns; the sidecar verifies it at startup.`,
        "Probe failed",
      );
      const dimEntered = await p.text({
        message: `Embedding dimension of ${embeddingModel}`,
        placeholder: "e.g. 768 for nomic-embed-text",
        validate: (v) =>
          /^[1-9][0-9]*$/.test((v ?? "").trim())
            ? undefined
            : "Must be a positive integer (the model's vector length)",
      });
      if (p.isCancel(dimEntered)) return cancelled(p);
      embeddingDim = Number(asText(dimEntered).trim());
    }
  }

  // ── Optional: observability (default off) ────────────────────────────────
  const observability = await p.select<ObservabilityLevel>({
    message: "Observability level (optional)",
    options: OBSERVABILITY_OPTIONS,
    initialValue: existingObs ?? "off",
  });
  if (p.isCancel(observability)) return cancelled(p);

  // ── Optional: sidecar URL override (default: spawn) ──────────────────────
  const sidecarEntered = await p.text({
    message: "Override sidecar URL? (optional — blank lets the plugin spawn it)",
    placeholder: "leave blank to auto-spawn",
    initialValue: existingSidecar,
    validate: (v) => ((v ?? "").trim().length === 0 ? undefined : validateUrl(v)),
  });
  if (p.isCancel(sidecarEntered)) return cancelled(p);
  const sidecarTrimmed = asText(sidecarEntered).trim();
  const sidecarUrl = sidecarTrimmed.length > 0 ? sidecarTrimmed : undefined;

  const answers: WizardAnswers = {
    provider: provider as ProviderId,
    baseUrl,
    model: asText(model).trim(),
    credential: credResult.credential,
    pastedKey: credResult.pastedKey,
    removeOldSecretFile: credResult.removeOldSecretFile,
    embeddingProvider: embeddingProvider as EmbeddingProviderId,
    embeddingModel,
    embeddingEndpointUrl,
    embeddingDim,
    observability: observability as ObservabilityLevel,
    sidecarUrl,
  };

  // ── Summary + confirm ────────────────────────────────────────────────────
  p.note(summarise(answers, preset.defaultBaseUrl), "Configuration summary");
  const apply = await p.confirm({ message: "Apply this configuration?", initialValue: true });
  if (p.isCancel(apply) || apply === false) return cancelled(p);

  return answers;
}

interface CredentialResult {
  credential: CredentialRef;
  pastedKey?: string;
  removeOldSecretFile: boolean;
}

/**
 * Credential sub-flow with re-entry semantics. Never re-displays a stored key:
 * on re-entry it offers Keep / Replace / Switch-method instead.
 */
async function collectCredential(
  p: Prompter,
  preset: (typeof PROVIDER_PRESETS)[ProviderId],
  existingCred: CredentialRef | undefined,
): Promise<CredentialResult | null> {
  // Re-entry: key currently in the secret file.
  if (existingCred?.source === "file") {
    const choice = await p.select<"keep" | "replace" | "switch">({
      message: "API key (currently stored in a private file)",
      options: [
        { value: "keep", label: "Keep current key" },
        { value: "replace", label: "Replace it (paste a new key)" },
        { value: "switch", label: "Switch to an environment variable" },
      ],
      initialValue: "keep",
    });
    if (p.isCancel(choice)) return null;
    if (choice === "keep") {
      return { credential: { source: "file" }, removeOldSecretFile: false };
    }
    if (choice === "replace") {
      const key = await promptPastedKey(p, preset);
      if (key === null) return null;
      return {
        credential: { source: "file" },
        pastedKey: key,
        removeOldSecretFile: false,
      };
    }
    // switch → env var; old file removed by the orchestrator after config write.
    const cred = await promptEnvVar(p, preset, undefined);
    if (cred === null) return null;
    return { credential: cred, removeOldSecretFile: true };
  }

  // Re-entry: key currently from an env var.
  if (existingCred?.source === "env") {
    const choice = await p.select<"keep" | "change" | "switch">({
      message: `API key (currently from env var ${existingCred.var})`,
      options: [
        { value: "keep", label: `Keep current (${existingCred.var})` },
        { value: "change", label: "Use a different environment variable" },
        { value: "switch", label: "Switch to pasting a key" },
      ],
      initialValue: "keep",
    });
    if (p.isCancel(choice)) return null;
    if (choice === "keep") {
      return { credential: existingCred, removeOldSecretFile: false };
    }
    if (choice === "change") {
      const cred = await promptEnvVar(p, preset, existingCred.var);
      if (cred === null) return null;
      return { credential: cred, removeOldSecretFile: false };
    }
    const key = await promptPastedKey(p, preset);
    if (key === null) return null;
    return {
      credential: { source: "file" },
      pastedKey: key,
      removeOldSecretFile: false,
    };
  }

  // Fresh install: choose a method (paste is the default).
  const method = await p.select<"paste" | "env">({
    message: "How would you like to provide your API key?",
    options: [
      { value: "paste", label: "Paste it here (stored in a private mode-600 file)" },
      { value: "env", label: "Provide it via an environment variable" },
    ],
    initialValue: "paste",
  });
  if (p.isCancel(method)) return null;
  if (method === "paste") {
    const key = await promptPastedKey(p, preset);
    if (key === null) return null;
    return {
      credential: { source: "file" },
      pastedKey: key,
      removeOldSecretFile: false,
    };
  }
  const cred = await promptEnvVar(p, preset, undefined);
  if (cred === null) return null;
  return { credential: cred, removeOldSecretFile: false };
}

async function promptPastedKey(
  p: Prompter,
  preset: (typeof PROVIDER_PRESETS)[ProviderId],
): Promise<string | null> {
  const key = await p.password({
    message: `${preset.label} API key`,
    validate: (v) => validateKeyFormat(v, preset),
  });
  if (p.isCancel(key)) return null;
  return asText(key).trim();
}

async function promptEnvVar(
  p: Prompter,
  preset: (typeof PROVIDER_PRESETS)[ProviderId],
  current: string | undefined,
): Promise<CredentialRef | null> {
  const name = await p.text({
    message: "Which environment variable holds your API key?",
    placeholder: preset.defaultKeyEnvVar,
    initialValue: current ?? preset.defaultKeyEnvVar,
    validate: (v) => validateEnvVarName(v),
  });
  if (p.isCancel(name)) return null;
  return { source: "env", var: asText(name).trim() };
}

/**
 * Coerce a non-cancelled prompt result to a string. @clack's `text`/`password`
 * resolve to `undefined` (not `""`) for an empty field, so every post-prompt
 * read must guard against it; this centralises that. (Symbols are filtered by
 * the preceding `isCancel` checks, but coercing them too keeps this total.)
 */
function asText(value: string | symbol | undefined): string {
  return typeof value === "string" ? value : "";
}

function cancelled(p: Prompter): null {
  p.cancel("Setup cancelled — no changes were made.");
  return null;
}

function summarise(answers: WizardAnswers, defaultBaseUrl?: string): string {
  const cred =
    answers.credential.source === "file"
      ? answers.pastedKey
        ? "pasted key → private mode-600 file"
        : "stored key (private mode-600 file)"
      : `environment variable ${answers.credential.var}`;
  const base = answers.baseUrl ?? defaultBaseUrl ?? "(provider default)";
  const sidecar = answers.sidecarUrl ?? "spawned (default)";
  const embedder =
    answers.embeddingProvider === "openai-compatible"
      ? `${answers.embeddingModel} @ ${answers.embeddingEndpointUrl} (${answers.embeddingDim}-dim)`
      : "built-in (HuggingFace bge-small)";
  return [
    `Provider:       ${PROVIDER_PRESETS[answers.provider].label}`,
    `Base URL:       ${base}`,
    `Model:          ${answers.model}`,
    `Credential:     ${cred}`,
    `Embedder:       ${embedder}`,
    `Observability:  ${answers.observability}`,
    `Sidecar:        ${sidecar}`,
  ].join("\n");
}
