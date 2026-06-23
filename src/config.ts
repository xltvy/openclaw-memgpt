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
  "provider",
  "baseUrl",
  "credential",
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

  return {
    namespace: stringWithDefault(cfg, "namespace", "default"),
    model: stringWithDefault(cfg, "model", "gpt-4"),
    persona: stringWithDefault(cfg, "persona", "You are a helpful AI assistant."),
    human: stringWithDefault(cfg, "human", "The user."),
    sidecarUrl: optionalString(cfg, "sidecarUrl"),
    observability: resolveObservability(cfg),
    provider: resolveProvider(cfg),
    baseUrl: optionalString(cfg, "baseUrl"),
    credential: resolveCredential(cfg),
  };
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
