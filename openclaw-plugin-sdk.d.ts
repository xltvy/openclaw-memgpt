declare module "openclaw/plugin-sdk" {
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
    on(event: string, handler: (event: any, ctx: any) => any): void;
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
    registerMemoryCapability?(config: MemoryCapabilityConfig): void;
    [key: string]: unknown;
  }
}

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
// SDK subpaths consumed by the 6d.6 install wizard. These are real exported
// subpaths of the installed `openclaw` package (verified against
// node_modules/openclaw/package.json `exports`), but `openclaw` is not a
// dependency of this plugin — it is resolved at runtime by the OpenClaw host
// process. They are therefore only ever reached via `await import(...)` inside
// wizard code paths (never during `node --test`, where the host is absent).
// The signatures below are minimal hand-written ambients matching the bundle.
// ---------------------------------------------------------------------------

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
