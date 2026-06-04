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
  /** Observability emit level. Defaults to "default". (§6) */
  observability: ObservabilityLevel;
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
] as const;

const OBSERVABILITY_LEVELS: ReadonlyArray<ObservabilityLevel> = [
  "off",
  "default",
  "verbose",
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
  if (raw === undefined) return "default";
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
  };
}
