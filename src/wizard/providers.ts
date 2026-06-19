/**
 * Provider presets for the 6d.6 install wizard.
 *
 * Each preset supplies the wizard's per-provider defaults: a default model, a
 * default base URL, the conventional env-var name for the env-var credential
 * path, and an optional API-key prefix used for *format-only* validation (the
 * wizard never tests a key against the live API — §6d.6 brief).
 *
 * Architecture note: regardless of provider, the sidecar consumes the LLM via
 * `OPENAI_API_BASE` + `OPENAI_API_KEY` (pymemgpt's openai_tools). The provider
 * choice therefore determines (a) sensible defaults and (b) key-format hints —
 * the resolved key is always injected as `OPENAI_API_KEY` and the base as
 * `OPENAI_API_BASE` at spawn time (see credentialStore + LifecycleManager).
 * "Anthropic API (direct)" presumes an OpenAI-compatible gateway in front (the
 * bundled proxy shim or LiteLLM); this is documented for the user.
 */

import type { ProviderId } from "../config.ts";

export interface ProviderPreset {
  id: ProviderId;
  /** Human label shown in the provider select prompt. */
  label: string;
  /** Prefilled model default; undefined ⇒ the user must enter one. */
  defaultModel?: string;
  /** Prefilled base URL default; undefined ⇒ the user must enter one. */
  defaultBaseUrl?: string;
  /** Conventional env-var name suggested on the env-var credential path. */
  defaultKeyEnvVar: string;
  /** API-key prefix for format-only validation; undefined ⇒ skip the check. */
  keyPrefix?: string;
  /** Whether a base URL is mandatory (true for the compatible endpoint). */
  requiresBaseUrl: boolean;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic API (direct)",
    defaultModel: "claude-sonnet-4-5-20250929",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultKeyEnvVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    requiresBaseUrl: false,
  },
  openai: {
    id: "openai",
    label: "OpenAI API (direct)",
    defaultModel: "gpt-4o",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultKeyEnvVar: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    requiresBaseUrl: false,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint (LiteLLM, OpenRouter, local LLM, etc.)",
    defaultModel: undefined,
    defaultBaseUrl: undefined,
    defaultKeyEnvVar: "OPENAI_API_KEY",
    keyPrefix: undefined,
    requiresBaseUrl: true,
  },
};

/** Ordered list for the select prompt (anthropic, openai, compatible). */
export const PROVIDER_ORDER: ReadonlyArray<ProviderId> = [
  "anthropic",
  "openai",
  "openai-compatible",
];

/**
 * Format-only key validation. Returns an error string (for the prompt) or
 * undefined when acceptable. Never touches the network. An empty key is
 * always rejected; a prefix mismatch is a *soft* warning encoded as an error
 * the user can override by re-entering — but we keep it strict-ish per brief:
 * reject on clear mismatch so typos surface early.
 */
export function validateKeyFormat(
  key: string | undefined,
  preset: ProviderPreset,
): string | undefined {
  const trimmed = (key ?? "").trim();
  if (trimmed.length === 0) return "API key must not be empty";
  if (preset.keyPrefix && !trimmed.startsWith(preset.keyPrefix)) {
    return `Expected an ${preset.label} key starting with "${preset.keyPrefix}"`;
  }
  return undefined;
}

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Validate an env-var name shape ([A-Z_][A-Z0-9_]*). */
export function validateEnvVarName(name: string | undefined): string | undefined {
  if (!ENV_VAR_NAME_RE.test((name ?? "").trim())) {
    return "Must be a valid environment variable name (A–Z, 0–9, _; not starting with a digit)";
  }
  return undefined;
}

/** Validate an http(s) URL shape for the base-url / sidecar-url prompts. */
export function validateUrl(url: string | undefined): string | undefined {
  const trimmed = (url ?? "").trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "URL must use http or https";
    }
    return undefined;
  } catch {
    return "Not a valid URL";
  }
}
