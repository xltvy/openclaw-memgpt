/**
 * Credential storage + resolution for the 6d.6 wizard.
 *
 * Two credential paths (see `CredentialRef` in config.ts):
 *   - "file" — the API key is written to a private mode-0600 file under the
 *     state dir using the SDK's hardened `writePrivateSecretFileAtomic`
 *     (atomic temp-then-rename, symlink rejection, path-within-root assertion).
 *   - "env"  — only the env-var *name* is stored in config; the key is read
 *     from `process.env[name]` at sidecar-spawn time.
 *
 * The actual filesystem/SDK calls go through a `SecretFileIO` seam. The default
 * implementation `dynamic import()`s the SDK module (the host `openclaw` package
 * is resolvable only at runtime, never under `node --test`); unit tests inject
 * an in-memory or tmpdir-backed fake. This is the same DI discipline the
 * LifecycleManager uses for spawn/fetch/net.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import type { CredentialRef } from "../config.ts";

/** Relative location of the API-key secret file under the state dir. */
export const SECRET_FILE_REL = path.join(
  "plugins",
  "openclaw-memgpt",
  "api-key",
);

/** Human-readable label passed to the SDK reader for its error messages. */
const SECRET_LABEL = "openclaw-memgpt API key";

/** Absolute path of the API-key secret file for a given state dir. */
export function secretFilePath(stateDir: string): string {
  return path.join(stateDir, SECRET_FILE_REL);
}

/**
 * IO seam over the SDK secret-file primitives. `write` is async (the SDK writer
 * is async); `read` is async too so the default impl can dynamic-import the
 * (sync) SDK reader without forcing a top-level runtime import of `openclaw`.
 */
export interface SecretFileIO {
  write(params: {
    rootDir: string;
    filePath: string;
    content: string;
  }): Promise<void>;
  read(filePath: string): Promise<string | undefined>;
  remove(filePath: string): Promise<void>;
}

/**
 * Production IO: defers to the host SDK at call time. Reached only inside the
 * wizard / sidecar-spawn paths, both of which run under the OpenClaw process
 * where `openclaw/plugin-sdk/*` resolves.
 */
export const sdkSecretFileIO: SecretFileIO = {
  async write(params) {
    const mod = await import("openclaw/plugin-sdk/secret-file-runtime");
    await mod.writePrivateSecretFileAtomic(params);
  },
  async read(filePath) {
    const mod = await import("openclaw/plugin-sdk/secret-file-runtime");
    return mod.tryReadSecretFileSync(filePath, SECRET_LABEL);
  },
  async remove(filePath) {
    await rm(filePath, { force: true });
  },
};

/**
 * Write the pasted API key to the private secret file. The SDK writer creates
 * the `plugins/openclaw-memgpt/` parent dir (mode 0700) and writes the file
 * mode 0600, atomically.
 */
export async function writeApiKeyFile(
  stateDir: string,
  key: string,
  io: SecretFileIO = sdkSecretFileIO,
): Promise<void> {
  await io.write({
    rootDir: stateDir,
    filePath: secretFilePath(stateDir),
    content: key,
  });
}

/**
 * Delete the secret file. Used when switching the paste path → env-var path.
 * Idempotent (force); a failure here is non-fatal (caller logs) because the
 * new env-var config no longer references the file — an orphan is harmless.
 */
export async function removeApiKeyFile(
  stateDir: string,
  io: SecretFileIO = sdkSecretFileIO,
): Promise<void> {
  await io.remove(secretFilePath(stateDir));
}

/**
 * Resolve a credential reference to its plaintext key, or undefined if it is
 * unavailable (missing env var, missing/unreadable file). Never logs the key.
 */
export async function resolveCredentialKey(
  cred: CredentialRef,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  io: SecretFileIO = sdkSecretFileIO,
): Promise<string | undefined> {
  if (cred.source === "env") {
    const raw = env[cred.var];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  }
  // source === "file"
  const value = await io.read(secretFilePath(stateDir));
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}
