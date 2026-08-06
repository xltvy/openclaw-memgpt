#!/usr/bin/env node
/**
 * Regenerate `openclaw-plugin-sdk.d.ts` from the installed OpenClaw bundle.
 *
 * Why generated: the previous hand-written ambient stub typed
 * `on(event: string, handler: (event: any, ctx: any) => any)`, which erased
 * every typed hook field the SDK actually ships (39 hooks in
 * `dist/plugin-sdk/hook-types-*.d.ts`). That erasure is how the flush-pressure
 * hook ended up depending on provider-reported `usage.total` instead of the
 * SDK-visible `ctx.contextTokenBudget` + `event.messages` — none of it was
 * discoverable from the stub. Generating the hook layer from the installed
 * SDK keeps the ambient types honest and re-generable on SDK upgrades:
 *
 *   node scripts/generate-sdk-types.mjs [path-to-openclaw-package]
 *
 * Default source: /opt/homebrew/lib/node_modules/openclaw (override with the
 * first CLI arg or $OPENCLAW_PACKAGE_DIR).
 *
 * Transformation of hook-types-*.d.ts:
 *   - `import { X as Y } from "./chunk.js"` lines are dropped; each imported
 *     name becomes an opaque local alias (structural where our code relies on
 *     the shape, `{ [key: string]: unknown }` otherwise) so the file stays
 *     self-contained — this repo cannot resolve openclaw chunk files because
 *     `openclaw` is a host-provided runtime dependency, not an npm dependency.
 *   - the trailing mangled `export { A as b, ... }` re-export line is dropped;
 *     instead every top-level `type` / `declare const` is exported directly.
 *   - everything is wrapped in `declare module "openclaw/plugin-sdk"` together
 *     with the (hand-maintained, template below) plugin-API surface, whose
 *     `on` is now the SDK's real typed signature.
 *
 * The wizard-subpath ambients (config-runtime, secret-file-runtime,
 * state-paths) and the agent-core ambient are hand-maintained templates in
 * this script, verified against the same installed bundle.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir =
  process.argv[2] ??
  process.env.OPENCLAW_PACKAGE_DIR ??
  "/opt/homebrew/lib/node_modules/openclaw";
const sdkDir = join(packageDir, "dist", "plugin-sdk");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(repoRoot, "openclaw-plugin-sdk.d.ts");

const version = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
).version;

const hookFileName = readdirSync(sdkDir).find((f) =>
  /^hook-types-[\w-]+\.d\.ts$/.test(f),
);
if (!hookFileName) {
  console.error(`no hook-types-*.d.ts found in ${sdkDir}`);
  process.exit(1);
}
const hookSource = readFileSync(join(sdkDir, hookFileName), "utf8");

// ── Transform the hook-types file ───────────────────────────────────────────

/**
 * External chunk types referenced by hook-types. Names not listed here fall
 * back to `{ [key: string]: unknown }` (opaque object). Scalars must be listed
 * explicitly — they are string unions in the SDK.
 */
const EXTERNAL_OVERRIDES = {
  // AgentMessage: structural minimum our code (and estimateTokens) relies on.
  AgentMessage: `{ role: string; content?: unknown; [key: string]: unknown }`,
  // String-union scalars.
  ChatType: "string",
  TtsAutoMode: "string",
  SourceReplyDeliveryMode: "string",
};

const importedNames = [];
const bodyLines = [];
for (const line of hookSource.split("\n")) {
  if (line.startsWith("import ")) {
    for (const m of line.matchAll(/\w+ as (\w+)/g)) importedNames.push(m[1]);
    continue;
  }
  if (line.startsWith("export {")) continue; // trailing mangled re-export line
  bodyLines.push(
    line
      .replace(/^type /, "export type ")
      .replace(/^declare const /, "export const "),
  );
}

const aliasLines = importedNames.map(
  (name) =>
    `type ${name} = ${EXTERNAL_OVERRIDES[name] ?? "{ [key: string]: unknown }"};`,
);

const indent = (text) =>
  text
    .split("\n")
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join("\n");

const hookBlock = indent(
  [
    "// ── Hook types (generated from " + hookFileName + ") ──",
    "",
    "// Opaque aliases for chunk-internal types the hook payloads reference.",
    ...aliasLines,
    "",
    ...bodyLines,
  ].join("\n"),
);

// ── Hand-maintained plugin-API surface + subpath modules ────────────────────

const apiSurface = indent(`
// ── Plugin API surface (hand-maintained template in the generator) ──

export interface MemoryArtifact {
  id: string;
  type: "memory" | "dream" | "digest" | "entity";
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublicArtifactsProvider {
  listArtifacts(options?: {
    userId?: string;
    types?: string[];
    limit?: number;
  }): Promise<MemoryArtifact[]>;
}

export interface MemoryCapabilityConfig {
  promptBuilder?: (ctx: any) => Promise<string | null>;
  flushPlanResolver?: (ctx: any) => Promise<any>;
  runtime?: Record<string, unknown>;
  publicArtifacts?: PublicArtifactsProvider;
}

export interface OpenClawPluginApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  resolvePath(p: string): string;
  registerTool(
    definition: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; [key: string]: unknown }>;
      [key: string]: unknown;
    },
    metadata?: { optional?: boolean; [key: string]: unknown },
  ): void;
  /**
   * Typed hook registration — the SDK's real signature (types-*.d.ts
   * \`OpenClawPluginApi.on\`). Handlers get the per-hook event/context types
   * from PluginHookHandlerMap instead of \`any\`.
   */
  on<K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number; timeoutMs?: number },
  ): void;
  registerCli(
    handler: (context: { program: any }) => void,
    options?: Record<string, unknown>,
  ): void;
  registerCommand?(definition: Record<string, unknown>): void;
  registerService(service: {
    id: string;
    start?: (ctx: Record<string, unknown>) => void | Promise<void>;
    stop?: (ctx: Record<string, unknown>) => void | Promise<void>;
  }): void;
  registerContextEngine?(id: string, factory: unknown): void;
  registerMemoryCapability?(config: MemoryCapabilityConfig): void;
  [key: string]: unknown;
}
`);

const staticModules = `
declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

  export interface PluginEntry {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry<T extends PluginEntry>(entry: T): T;
}

declare module "openclaw/plugin-sdk/core" {
  export * from "openclaw/plugin-sdk";
}

// ---------------------------------------------------------------------------
// SDK subpaths consumed at runtime via \`await import(...)\` — \`openclaw\` is
// resolved by the OpenClaw host process, never by \`node --test\` (where the
// host is absent), so every value import of these subpaths must stay dynamic.
// Signatures verified against the installed bundle.
// ---------------------------------------------------------------------------

declare module "openclaw/plugin-sdk/agent-core" {
  /**
   * OpenClaw's own provider-independent per-message token estimator (a
   * conservative visible-content chars/4 heuristic; \`proxy-*.js
   * estimateTokens\`). Sum it over a message buffer for a context estimate
   * that owes nothing to provider-reported \`usage\`.
   *
   * Do NOT reach for \`estimateContextTokens\` when provider independence
   * matters: it anchors on the last assistant message's provider usage and
   * only estimates the tail after it.
   */
  export function estimateTokens(message: unknown): number;
  /** Anchors on provider-reported usage; see estimateTokens caveat. */
  export function estimateContextTokens(messages: unknown[]): {
    tokens: number;
    [key: string]: unknown;
  };
}

declare module "openclaw/plugin-sdk/config-runtime" {
  /** Read config snapshot, apply mutator to a clone, write back with hash-based
   *  conflict detection. Resolves the config path from env internally. */
  export function updateConfig(
    mutator: (cfg: Record<string, any>) => Record<string, any>,
  ): Promise<Record<string, any>>;
  /** Load the current resolved config object. */
  export function loadConfig(): Promise<Record<string, any>> | Record<string, any>;
}

declare module "openclaw/plugin-sdk/secret-file-runtime" {
  /** Atomic, mode-0600, symlink-rejecting private secret file writer. */
  export function writePrivateSecretFileAtomic(params: {
    rootDir: string;
    filePath: string;
    content: string;
  }): Promise<void>;
  /** Read a secret file's contents (throws on failure). */
  export function readSecretFileSync(
    filePath: string,
    label: string,
    options?: Record<string, unknown>,
  ): string;
  /** Read a secret file's contents, returning undefined on any failure. */
  export function tryReadSecretFileSync(
    filePath: string,
    label: string,
    options?: Record<string, unknown>,
  ): string | undefined;
  export const PRIVATE_SECRET_FILE_MODE: number;
  export const PRIVATE_SECRET_DIR_MODE: number;
}

declare module "openclaw/plugin-sdk/state-paths" {
  /** Resolve the OpenClaw state dir (config-file parent). Honours
   *  OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH; defaults to ~/.openclaw. */
  export function resolveStateDir(env?: NodeJS.ProcessEnv): string;
  export const STATE_DIR: string;
}
`;

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:  node scripts/generate-sdk-types.mjs
 * Source: openclaw@${version} (dist/plugin-sdk/${hookFileName})
 *
 * Ambient types for the host-provided \`openclaw\` package. The hook layer is
 * generated from the installed SDK so every hook's event/context payload is
 * fully typed (ctx.contextTokenBudget, event.messages, usage, ...); the plugin
 * API surface and wizard subpath modules are hand-maintained templates inside
 * the generator script, verified against the same bundle.
 */
`;

const output = `${header}
declare module "openclaw/plugin-sdk" {
${apiSurface}
${hookBlock}
}
${staticModules}`;

writeFileSync(outPath, output);
console.log(
  `wrote ${outPath} from openclaw@${version} (${hookFileName}, ${output.split("\n").length} lines)`,
);
