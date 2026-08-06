/**
 * Plugin configuration parsing for openclaw-memgpt.
 *
 * Per API_DESIGN.md §3.3. Validation pattern follows the @mem0/openclaw-mem0
 * reference (manual type guards, allowed-keys check, defaults) rather than zod —
 * keeps the dependency surface tight.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

export type ObservabilityLevel = "off" | "default" | "verbose";

/** LLM provider the sidecar talks to. Set by the 6d.6 install wizard. */
export type ProviderId = "anthropic" | "openai" | "openai-compatible";

/**
 * Embedding provider for the sidecar's vector memory (archival/recall).
 *
 * - `huggingface` — the built-in in-process bge-small load (the default; no
 *   extra server, ~60–90s first-run download).
 * - `openai-compatible` — any OpenAI-protocol `/embeddings` endpoint (Ollama,
 *   vLLM, LM Studio, LiteLLM). No HuggingFace download, no cold start; the
 *   embedding server must be running and hosting the model.
 */
export type EmbeddingProviderId = "huggingface" | "openai-compatible";

/**
 * Credential reference stored in config — never the secret itself (6d.6).
 *
 * - `{ source: "file" }`  — the API key lives in the SDK-written mode-0600
 *   secret file (paste path); resolved at runtime via `readSecretFileSync`.
 * - `{ source: "env", var }` — the API key is read from `process.env[var]`
 *   at sidecar-spawn time (env-var path).
 *
 * This is a deliberately small plugin-local descriptor rather than the SDK's
 * full secret-ref object (`{source,provider,id}`): the SDK secret-ref requires
 * the provider-alias / secret-gateway registry to resolve, which is far more
 * coupling than a sidecar needing one key in its spawn env. We still use the
 * SDK's hardened file primitives (`writePrivateSecretFileAtomic` /
 * `readSecretFileSync`) for the file path.
 */
export type CredentialRef =
  | { source: "file" }
  | { source: "env"; var: string };

export interface PluginConfig {
  /** Memory namespace; maps to pymemgpt's agent_config.name in the sidecar. */
  namespace: string;
  /** Model id sent to :ensure for the create branch. Ignored on resident/load. */
  model: string;
  /** Persona block; create-branch only. */
  persona: string;
  /** Human block; create-branch only. */
  human: string;
  /**
   * Escape hatch: explicit sidecar base URL.
   * When absent the plugin spawns + manages the sidecar (deferred to 6d).
   * Also resolvable from env OPENCLAW_MEMGPT_SIDECAR_URL by the lifecycle layer.
   */
  sidecarUrl?: string;
  /** Observability emit level. Defaults to "off". (§6) */
  observability: ObservabilityLevel;
  /**
   * Flush-pressure trigger ratio (§4.4): summarisation fires when the
   * locally-estimated buffer token count reaches
   * `contextTokenBudget * flushRatio`. Defaults to 0.75 (MemGPT's own warning
   * fraction). When the SDK supplies no budget, the absolute fallback
   * threshold (6000 tokens) applies and this ratio is unused.
   */
  flushRatio?: number;
  /**
   * LLM provider for the sidecar (6d.6 wizard). Optional so the plugin still
   * loads pre-configuration; `isConfigComplete` treats its absence as
   * "needs setup". Determines key-env-var + base-url defaults.
   */
  provider?: ProviderId;
  /**
   * Sidecar LLM base URL (→ sidecar `OPENAI_API_BASE`). Required for the
   * `openai-compatible` provider; optional override for the others.
   */
  baseUrl?: string;
  /** Credential reference (6d.6). Absent ⇒ not yet configured. */
  credential?: CredentialRef;
  /**
   * Embedder selection. All four fields absent ⇒ the sidecar's built-in
   * defaults (huggingface / bge-small / 384) — behaviour identical to
   * pre-configurability releases, and the sidecar then never reconciles an
   * existing profile's ini. When set, the values are pinned into the spawned
   * sidecar's env as OPENCLAW_MEMGPT_EMBEDDING_* (attach-mode users set that
   * env on their manually-run sidecar instead).
   */
  embeddingProvider?: EmbeddingProviderId;
  /** Embedding model id (e.g. "nomic-embed-text"). Required for openai-compatible. */
  embeddingModel?: string;
  /**
   * OpenAI-protocol base URL for embeddings (e.g. "http://127.0.0.1:11434/v1").
   * Independent of the LLM `baseUrl` — a chat proxy may not expose /embeddings
   * and vice versa. Defaults to Ollama's URL when omitted.
   */
  embeddingEndpointUrl?: string;
  /**
   * Vector length the embedding model returns (e.g. 768 for nomic-embed-text).
   * Required whenever a non-default model is chosen: existing stores reject —
   * or worse, silently mis-search — mismatched vectors, so the sidecar verifies
   * this against a live probe at startup.
   */
  embeddingDim?: number;
}

// ============================================================================
// Validation
// ============================================================================

const ALLOWED_KEYS = [
  "namespace",
  "model",
  "persona",
  "human",
  "sidecarUrl",
  "observability",
  "flushRatio",
  "provider",
  "baseUrl",
  "credential",
  "embeddingProvider",
  "embeddingModel",
  "embeddingEndpointUrl",
  "embeddingDim",
] as const;

const OBSERVABILITY_LEVELS: ReadonlyArray<ObservabilityLevel> = [
  "off",
  "default",
  "verbose",
];

const PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  "anthropic",
  "openai",
  "openai-compatible",
];

function assertAllowedKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter(
    (k) => !ALLOWED_KEYS.includes(k as (typeof ALLOWED_KEYS)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(
      `openclaw-memgpt config has unknown keys: ${unknown.join(", ")}`,
    );
  }
}

function stringWithDefault(
  value: Record<string, unknown>,
  key: string,
  defaultValue: string,
): string {
  const raw = value[key];
  if (raw === undefined) return defaultValue;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `openclaw-memgpt config: '${key}' must be a non-empty string when set`,
    );
  }
  return raw;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `openclaw-memgpt config: '${key}' must be a non-empty string when set`,
    );
  }
  return raw;
}

function resolveObservability(
  value: Record<string, unknown>,
): ObservabilityLevel {
  const raw = value.observability;
  if (raw === undefined) return "off";
  if (
    typeof raw !== "string" ||
    !OBSERVABILITY_LEVELS.includes(raw as ObservabilityLevel)
  ) {
    throw new Error(
      `openclaw-memgpt config: 'observability' must be one of ${OBSERVABILITY_LEVELS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as ObservabilityLevel;
}

function resolveProvider(
  value: Record<string, unknown>,
): ProviderId | undefined {
  const raw = value.provider;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !PROVIDER_IDS.includes(raw as ProviderId)) {
    throw new Error(
      `openclaw-memgpt config: 'provider' must be one of ${PROVIDER_IDS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as ProviderId;
}

const EMBEDDING_PROVIDER_IDS: ReadonlyArray<EmbeddingProviderId> = [
  "huggingface",
  "openai-compatible",
];

function resolveEmbeddingProvider(
  value: Record<string, unknown>,
): EmbeddingProviderId | undefined {
  const raw = value.embeddingProvider;
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "string" ||
    !EMBEDDING_PROVIDER_IDS.includes(raw as EmbeddingProviderId)
  ) {
    throw new Error(
      `openclaw-memgpt config: 'embeddingProvider' must be one of ${EMBEDDING_PROVIDER_IDS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as EmbeddingProviderId;
}

/** A number in (0, 1] — the flush-pressure trigger fraction. */
function optionalRatio(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw <= 0 ||
    raw > 1
  ) {
    throw new Error(
      `openclaw-memgpt config: '${key}' must be a number in (0, 1] when set (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `openclaw-memgpt config: '${key}' must be a positive integer when set (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/**
 * Cross-field embedding validation. A partial embedder config fails at plugin
 * load with an actionable message, rather than at sidecar startup (or —
 * pre-configurability — as a bogus HuggingFace Hub download attempt).
 */
function validateEmbeddingFields(cfg: {
  embeddingProvider?: EmbeddingProviderId;
  embeddingModel?: string;
  embeddingDim?: number;
}): void {
  if (cfg.embeddingProvider === "openai-compatible") {
    if (cfg.embeddingModel === undefined) {
      throw new Error(
        "openclaw-memgpt config: 'embeddingModel' is required when embeddingProvider is 'openai-compatible' (e.g. \"nomic-embed-text\")",
      );
    }
    if (cfg.embeddingDim === undefined) {
      throw new Error(
        "openclaw-memgpt config: 'embeddingDim' is required when embeddingProvider is 'openai-compatible' — the vector length the model returns (e.g. 768 for nomic-embed-text)",
      );
    }
    return;
  }
  // huggingface (explicit or default): a custom model needs its dim too.
  if (
    cfg.embeddingModel !== undefined &&
    cfg.embeddingModel !== "BAAI/bge-small-en-v1.5" &&
    cfg.embeddingDim === undefined
  ) {
    throw new Error(
      `openclaw-memgpt config: 'embeddingDim' is required for non-default embedding model ${JSON.stringify(cfg.embeddingModel)}`,
    );
  }
}

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolveCredential(
  value: Record<string, unknown>,
): CredentialRef | undefined {
  const raw = value.credential;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("openclaw-memgpt config: 'credential' must be an object");
  }
  const cred = raw as Record<string, unknown>;
  if (cred.source === "file") {
    return { source: "file" };
  }
  if (cred.source === "env") {
    const name = cred.var;
    if (typeof name !== "string" || !ENV_VAR_NAME_RE.test(name)) {
      throw new Error(
        "openclaw-memgpt config: credential.var must be a valid environment variable name ([A-Z_][A-Z0-9_]*)",
      );
    }
    return { source: "env", var: name };
  }
  throw new Error(
    `openclaw-memgpt config: credential.source must be 'file' or 'env' (got ${JSON.stringify(cred.source)})`,
  );
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Parse and validate the plugin's config off `api.pluginConfig`.
 * Throws on missing required fields or invalid types.
 */
export function parseConfig(api: OpenClawPluginApi): PluginConfig {
  return parseConfigValue(api.pluginConfig);
}

/**
 * Direct value parser — exported for tests that don't have a full api stub.
 */
export function parseConfigValue(value: unknown): PluginConfig {
  if (value === undefined || value === null) {
    value = {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("openclaw-memgpt config must be an object");
  }
  const cfg = value as Record<string, unknown>;
  assertAllowedKeys(cfg);

  const parsed: PluginConfig = {
    namespace: stringWithDefault(cfg, "namespace", "default"),
    model: stringWithDefault(cfg, "model", "gpt-4"),
    persona: stringWithDefault(cfg, "persona", "You are a helpful AI assistant."),
    human: stringWithDefault(cfg, "human", "The user."),
    sidecarUrl: optionalString(cfg, "sidecarUrl"),
    observability: resolveObservability(cfg),
    flushRatio: optionalRatio(cfg, "flushRatio"),
    provider: resolveProvider(cfg),
    baseUrl: optionalString(cfg, "baseUrl"),
    credential: resolveCredential(cfg),
    embeddingProvider: resolveEmbeddingProvider(cfg),
    embeddingModel: optionalString(cfg, "embeddingModel"),
    embeddingEndpointUrl: optionalString(cfg, "embeddingEndpointUrl"),
    embeddingDim: optionalPositiveInteger(cfg, "embeddingDim"),
  };
  validateEmbeddingFields(parsed);
  return parsed;
}

/**
 * OPENCLAW_MEMGPT_EMBEDDING_* env pins for a sidecar process the plugin runs
 * (spawn mode and the wizard's prewarm subprocess). Only set for configured
 * fields: an empty object leaves the sidecar on its built-in defaults AND
 * keeps its EMBEDDING_EXPLICIT=false semantics (an existing profile's ini is
 * then never reconciled). The provider id is translated to the sidecar's
 * underscore form.
 */
export function embeddingEnv(
  cfg: Pick<
    PluginConfig,
    | "embeddingProvider"
    | "embeddingModel"
    | "embeddingEndpointUrl"
    | "embeddingDim"
  >,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.embeddingProvider !== undefined) {
    env.OPENCLAW_MEMGPT_EMBEDDING_PROVIDER =
      cfg.embeddingProvider === "openai-compatible"
        ? "openai_compatible"
        : cfg.embeddingProvider;
  }
  if (cfg.embeddingModel !== undefined) {
    env.OPENCLAW_MEMGPT_EMBEDDING_MODEL = cfg.embeddingModel;
  }
  if (cfg.embeddingEndpointUrl !== undefined) {
    env.OPENCLAW_MEMGPT_EMBEDDING_ENDPOINT_URL = cfg.embeddingEndpointUrl;
  }
  if (cfg.embeddingDim !== undefined) {
    env.OPENCLAW_MEMGPT_EMBEDDING_DIM = String(cfg.embeddingDim);
  }
  return env;
}

/**
 * True when the wizard-collected fields needed for a working memory session
 * are all present (6d.6). Drives first-run auto-detection: absence of any of
 * provider / credential ⇒ the wizard should run. `model` defaults to a
 * non-empty string in `parseConfigValue`, so it is implicitly satisfied; we
 * still require `provider` + `credential` because those have no usable default.
 */
export function isConfigComplete(cfg: PluginConfig): boolean {
  return cfg.provider !== undefined && cfg.credential !== undefined;
}
