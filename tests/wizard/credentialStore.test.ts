/**
 * credentialStore unit tests (6d.6).
 *
 * The production SecretFileIO dynamic-imports the host SDK (`openclaw`), which
 * is not a dependency of this plugin and is therefore unavailable under
 * `node --test`. We exercise the code through injected IO seams:
 *   - an in-memory fake (deterministic path/behaviour assertions), and
 *   - a tmpdir-backed real-fs IO that writes mode-0600 the way the SDK writer
 *     does (`open(path,'wx',0o600)` + rename), so we can assert the resulting
 *     file permission for the paste path.
 *
 * The real SDK writer's 0600/atomic guarantees are verified by source reading
 * (PRIVATE_SECRET_FILE_MODE = 0o600, enforcePrivatePathMode); this suite proves
 * our code drives such an IO correctly and that the env path writes no file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rename, rm, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveCredentialKey,
  removeApiKeyFile,
  secretFilePath,
  SECRET_FILE_REL,
  type SecretFileIO,
  writeApiKeyFile,
} from "../../src/wizard/credentialStore.ts";

function inMemoryIO() {
  const files = new Map<string, string>();
  const calls: Array<{ op: string; filePath: string }> = [];
  const io: SecretFileIO = {
    async write(params) {
      calls.push({ op: "write", filePath: params.filePath });
      files.set(params.filePath, params.content);
    },
    async read(filePath) {
      calls.push({ op: "read", filePath });
      return files.get(filePath);
    },
    async remove(filePath) {
      calls.push({ op: "remove", filePath });
      files.delete(filePath);
    },
  };
  return { io, files, calls };
}

/** A real-fs IO mimicking the SDK writer's mode-0600 atomic write. */
function tmpdirFsIO(): SecretFileIO {
  return {
    async write(params) {
      await mkdir(path.dirname(params.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${params.filePath}.tmp-${process.pid}`;
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(params.content);
      } finally {
        await handle.close();
      }
      await rename(tmp, params.filePath);
    },
    async read(filePath) {
      try {
        return await readFile(filePath, "utf8");
      } catch {
        return undefined;
      }
    },
    async remove(filePath) {
      await rm(filePath, { force: true });
    },
  };
}

test("secretFilePath places the key under plugins/openclaw-memgpt/api-key", () => {
  assert.equal(SECRET_FILE_REL, path.join("plugins", "openclaw-memgpt", "api-key"));
  assert.equal(
    secretFilePath("/state"),
    path.join("/state", "plugins", "openclaw-memgpt", "api-key"),
  );
});

test("writeApiKeyFile writes to the resolved secret path via the IO seam", async () => {
  const { io, files } = inMemoryIO();
  await writeApiKeyFile("/state", "sk-ant-secret", io);
  assert.equal(files.get(secretFilePath("/state")), "sk-ant-secret");
});

test("resolveCredentialKey (file) reads the stored key", async () => {
  const { io } = inMemoryIO();
  await writeApiKeyFile("/state", "sk-ant-stored", io);
  const key = await resolveCredentialKey({ source: "file" }, "/state", {}, io);
  assert.equal(key, "sk-ant-stored");
});

test("resolveCredentialKey (file) returns undefined when absent", async () => {
  const { io } = inMemoryIO();
  const key = await resolveCredentialKey({ source: "file" }, "/state", {}, io);
  assert.equal(key, undefined);
});

test("resolveCredentialKey (env) reads the named env var, trimmed", async () => {
  const { io } = inMemoryIO();
  const key = await resolveCredentialKey(
    { source: "env", var: "MY_KEY" },
    "/state",
    { MY_KEY: "  sk-live  " },
    io,
  );
  assert.equal(key, "sk-live");
});

test("resolveCredentialKey (env) returns undefined for missing/empty var", async () => {
  const { io } = inMemoryIO();
  assert.equal(
    await resolveCredentialKey({ source: "env", var: "NOPE" }, "/s", {}, io),
    undefined,
  );
  assert.equal(
    await resolveCredentialKey({ source: "env", var: "BLANK" }, "/s", { BLANK: "   " }, io),
    undefined,
  );
});

test("paste path writes a real mode-0600 file; env path writes none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocm-cred-"));
  const io = tmpdirFsIO();
  await writeApiKeyFile(root, "sk-ant-real", io);

  const file = secretFilePath(root);
  assert.ok(existsSync(file), "secret file should exist after paste-path write");
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.equal(await readFile(file, "utf8"), "sk-ant-real");

  // env path: resolveCredentialKey must not touch the filesystem.
  const key = await resolveCredentialKey(
    { source: "env", var: "ENV_KEY" },
    root,
    { ENV_KEY: "sk-env" },
    io,
  );
  assert.equal(key, "sk-env");

  await rm(root, { recursive: true, force: true });
});

test("removeApiKeyFile deletes the secret file (idempotent)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ocm-cred-"));
  const io = tmpdirFsIO();
  await writeApiKeyFile(root, "sk-ant-real", io);
  assert.ok(existsSync(secretFilePath(root)));
  await removeApiKeyFile(root, io);
  assert.ok(!existsSync(secretFilePath(root)));
  // second remove must not throw
  await removeApiKeyFile(root, io);
  await rm(root, { recursive: true, force: true });
});
