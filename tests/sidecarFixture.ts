/**
 * Test fixture for spawning a real uvicorn-hosted sidecar so the TS client
 * tests verify the actual wire layer, not a mock (per §3.4 acceptance criterion).
 *
 * Picks a free ephemeral port; spawns `uv run uvicorn main:app` inside the
 * sidecar/ directory; sets OPENCLAW_MEMGPT_DATA_DIR to a fresh tmp dir so
 * each test session is isolated; polls /healthz with `embedder: "ready"`
 * before returning; SIGTERMs the child on stop().
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo path to the sidecar root (sibling of `tests/`). */
const SIDECAR_DIR = resolve(__dirname, "..", "sidecar");

/** How long to wait for the sidecar's embedder to load before giving up. */
const READY_TIMEOUT_MS = 90_000;
/** How often to poll /healthz while waiting. */
const POLL_INTERVAL_MS = 500;
/** SIGTERM grace period before SIGKILL on stop(). */
const SHUTDOWN_GRACE_MS = 5_000;

export interface SidecarHandle {
  baseUrl: string;
  dataDir: string;
  /** SIGTERM the child, clean up the tmp data dir. Safe to call multiple times. */
  stop: () => Promise<void>;
}

/** Bind to port 0, read the assigned port, release, return it. */
export async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : -1;
      srv.close(() => (port > 0 ? res(port) : rej(new Error("no free port"))));
    });
  });
}

/**
 * Spawn the sidecar and wait until /healthz reports the embedder ready.
 * Throws if the child exits before ready, or if ready isn't reached in
 * READY_TIMEOUT_MS.
 */
export interface StartSidecarOptions {
  /**
   * Reuse an existing data dir instead of creating a fresh one — the
   * cross-session tests restart the sidecar against the same on-disk state
   * (the V1-protocol session boundary: sidecar restart, not key rotation).
   */
  dataDir?: string;
  /**
   * Leave the data dir in place on stop() so a follow-up
   * startSidecar({dataDir}) can rehydrate from it. The last owner cleans up.
   */
  keepDataDirOnStop?: boolean;
}

export async function startSidecar(
  options: StartSidecarOptions = {},
): Promise<SidecarHandle> {
  const port = await findFreePort();
  const ownsDataDir = options.dataDir === undefined;
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "openclaw-memgpt-test-")));
  const keepDataDir = options.keepDataDirOnStop === true;
  // Never delete a caller-provided dir on failure paths either — the caller
  // may want post-mortem access to the state that broke the restart.
  const removeOnFailure = ownsDataDir && !keepDataDir;

  const proc = spawn(
    "uv",
    [
      "run",
      "uvicorn",
      "main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: SIDECAR_DIR,
      env: { ...process.env, OPENCLAW_MEMGPT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Buffer stderr for diagnostics on failure; drain stdout so the pipe
  // doesn't backpressure uvicorn.
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  proc.stdout?.on("data", () => {
    /* drain */
  });

  // Ensure the child doesn't outlive the Node process even if a test crashes.
  const killOnExit = () => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
  };
  process.on("exit", killOnExit);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown = "no attempt yet";

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      process.off("exit", killOnExit);
      if (removeOnFailure) await rm(dataDir, { recursive: true, force: true });
      throw new Error(
        `sidecar exited before ready (code=${proc.exitCode}); stderr:\n${stderr}`,
      );
    }
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) {
        const j = (await r.json()) as { ok: boolean; embedder: string };
        if (j.ok && j.embedder === "ready") {
          return {
            baseUrl,
            dataDir,
            stop: async () => {
              process.off("exit", killOnExit);
              await stopSidecar(proc, dataDir, keepDataDir);
            },
          };
        }
        lastErr = `embedder=${j.embedder}`;
      } else {
        lastErr = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Timed out — kill and clean up
  process.off("exit", killOnExit);
  proc.kill("SIGTERM");
  if (removeOnFailure) await rm(dataDir, { recursive: true, force: true });
  throw new Error(
    `sidecar not ready within ${READY_TIMEOUT_MS}ms (last: ${String(lastErr)}); stderr:\n${stderr}`,
  );
}

async function stopSidecar(
  proc: ChildProcess,
  dataDir: string,
  keepDataDir = false,
): Promise<void> {
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await new Promise<void>((res) => {
      const onExit = () => res();
      proc.once("exit", onExit);
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        proc.off("exit", onExit);
        res();
      }, SHUTDOWN_GRACE_MS);
    });
  }
  if (!keepDataDir) await rm(dataDir, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
