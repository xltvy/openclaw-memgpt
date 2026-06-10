/**
 * §6.1 — Spawn/attach lifecycle for the MemGPT sidecar.
 *
 * Decided in 6c.10a; see CLAUDE.md "Lifecycle Management → 6c.10a findings"
 * for the contract this implements against. Six knobs in one place:
 *
 *   Q1 port:     dynamic ephemeral via net.listen(0); no override
 *   Q2 healthz:  spawn-and-block in `start`, 120 s max, 10 s progress logs
 *   Q3 env:      explicit overrides for plugin-managed knobs; inherit rest
 *   Q4 crash:    log + deadFlag + fail-next-turn (no auto-restart in V1)
 *   Q5 resolver: config.sidecarUrl → env → spawn (three-way precedence)
 *   Q6 teardown: save (30 s) → SIGTERM → 10 s wait → SIGKILL fallback
 *
 * The manager owns the spawn-vs-attach decision (in `start`), the child
 * subprocess (if spawned), the deadFlag (consulted by tools/hooks at entry),
 * and `resolveBaseUrl()` (the closure the SidecarClient calls in doInit).
 *
 * **Fixes the latent 6c.8 bug** flagged during 6c.10a: the SDK's service
 * runner calls `await service.start(serviceContext)` with no `?` guard
 * (services-CLs267o9.js:30). Omitting `start` TypErrors out and skips the
 * `running.push` that wires `stop`. By providing both here, `stop` actually
 * fires on shutdown.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer as nodeCreateServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { PluginConfig } from "../config.ts";

// ============================================================================
// Dependency-injection seams (default to Node globals; tests pass fakes)
// ============================================================================

type SpawnFn = typeof nodeSpawn;
type CreateServerFn = typeof nodeCreateServer;
type FetchFn = typeof fetch;

// ============================================================================
// Defaults (6c.10a Q2/Q6 contract)
// ============================================================================

const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 10_000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 10_000;
const DEFAULT_SAVE_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_RING_SIZE = 200;

/**
 * Sidecar directory — resolved from this file's location at module load.
 * src/lifecycle/lifecycleManager.ts → climb two → plugin root → sidecar/.
 */
const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_SIDECAR_DIR = path.join(PLUGIN_ROOT, "sidecar");

// ============================================================================
// Shared dead-sidecar surface (consumed by tools/hooks at entry, 6c.10a Q4)
// ============================================================================

export const SIDECAR_DEAD_MESSAGE =
  "openclaw-memgpt: sidecar process died; restart OpenClaw to recover";

// ============================================================================
// Public API
// ============================================================================

export interface LifecycleManagerOptions {
  spawnTimeoutMs?: number;
  attachTimeoutMs?: number;
  pollIntervalMs?: number;
  progressLogIntervalMs?: number;
  sigtermTimeoutMs?: number;
  saveTimeoutMs?: number;
  stderrRingSize?: number;
  sidecarDir?: string;
  stateDirOverride?: string;
  /** DI for testing. */
  spawn?: SpawnFn;
  createServer?: CreateServerFn;
  fetch?: FetchFn;
}

/**
 * Minimal save-only surface — `LifecycleManager.stop` calls it inside step 2.
 * Stated as a structural type so tests don't need to construct a full client.
 */
export interface SavableClient {
  save(): Promise<unknown>;
}

export class LifecycleManager {
  private _dead = false;
  private readonly config: PluginConfig;
  private readonly logger: OpenClawPluginApi["logger"];
  private readonly opts: Required<
    Omit<LifecycleManagerOptions, "spawn" | "createServer" | "fetch" | "stateDirOverride">
  > & {
    spawn: SpawnFn;
    createServer: CreateServerFn;
    fetch: FetchFn;
    stateDirOverride?: string;
  };

  private child?: ChildProcess;
  private spawnedUrl?: string;
  private attachUrl?: string;
  private stderrRing: string[] = [];
  private started = false;
  /** Set true on `stop` entry so the child `exit` listener doesn't flip deadFlag. */
  private shuttingDown = false;
  /**
   * Singleton in-flight promise for the lazy-init path (see `resolveBaseUrl`).
   * Concurrent first calls await the same promise so `start({})` only fires
   * once even under bursty parallel tool dispatch. Cleared on failure so a
   * subsequent call can retry; left set on success so subsequent calls
   * short-circuit at the `spawnedUrl !== undefined` check above lazy init.
   */
  private lazyStartPromise?: Promise<void>;

  /** Lifecycle.start sets this; tools/hooks can ask "what URL would I hit?". */
  get mode(): "spawn" | "attach" | "uninitialised" {
    if (!this.started) return "uninitialised";
    return this.spawnedUrl !== undefined ? "spawn" : "attach";
  }

  /** True if `start` succeeded. Tools may inspect to short-circuit cleanly. */
  get isStarted(): boolean {
    return this.started;
  }

  /** True if the child has exited (spawn mode) or start failed. Tools/hooks consult this. */
  get isDead(): boolean {
    return this._dead;
  }

  constructor(
    config: PluginConfig,
    logger: OpenClawPluginApi["logger"],
    options: LifecycleManagerOptions = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.opts = {
      spawnTimeoutMs: options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
      attachTimeoutMs: options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      progressLogIntervalMs:
        options.progressLogIntervalMs ?? DEFAULT_PROGRESS_LOG_INTERVAL_MS,
      sigtermTimeoutMs: options.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS,
      saveTimeoutMs: options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS,
      stderrRingSize: options.stderrRingSize ?? DEFAULT_STDERR_RING_SIZE,
      sidecarDir: options.sidecarDir ?? DEFAULT_SIDECAR_DIR,
      stateDirOverride: options.stateDirOverride,
      spawn: options.spawn ?? nodeSpawn,
      createServer: options.createServer ?? nodeCreateServer,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    };
  }

  // ── start ────────────────────────────────────────────────────────────────

  /**
   * SDK contract: awaited inside startPluginServices (services-CLs267o9.js).
   * Throwing here means the inner try/catch logs + skips `running.push`, so
   * `stop` is never registered — but plugin tools/hooks remain wired, so
   * first-turn calls return clean "sidecar unavailable" errors via deadFlag.
   *
   * Also called via the lazy-init path in `resolveBaseUrl` when the SDK
   * service runner doesn't fire (e.g. `openclaw agent --local` skips
   * `startPluginServices` per server.impl-DLF59fRo.js:21287). Idempotent on
   * the success path (`started=true`) and on the failure path (`_dead=true`
   * + thrown error); a second concurrent call on the lazy path is
   * race-protected by `resolveBaseUrl`'s singleton promise.
   */
  async start(ctx: Record<string, unknown>): Promise<void> {
    // Idempotency: prior successful start. Second call is a no-op so SDK and
    // lazy paths can't double-register sidecar state.
    if (this.started) return;
    if (this._dead) {
      throw new Error(
        "openclaw-memgpt: start() called after prior failure marked lifecycle dead",
      );
    }

    // 6c.10a Q5 precedence — config field > env var > spawn.
    this.attachUrl =
      this.config.sidecarUrl ??
      process.env.OPENCLAW_MEMGPT_SIDECAR_URL ??
      undefined;

    if (this.attachUrl !== undefined) {
      this.logger.info(
        `openclaw-memgpt: attach mode → ${this.attachUrl} (healthz timeout ${this.opts.attachTimeoutMs}ms)`,
      );
      try {
        await this.pollHealthz(
          this.attachUrl,
          this.opts.attachTimeoutMs,
          "attach",
        );
        this.started = true;
        this.logger.info("openclaw-memgpt: attach mode ready");
        return;
      } catch (err) {
        this._dead = true;
        throw new Error(
          `openclaw-memgpt: attach-mode healthz failed for ${this.attachUrl}: ${stringifyError(err)}`,
        );
      }
    }

    // Spawn mode — Q1 port + Q2 healthz block.
    const port = await this.pickFreePort();
    const url = `http://127.0.0.1:${port}`;
    const stateDir = this.resolveStateDir(ctx);
    const dataDir = path.join(stateDir, "memgpt-data");

    this.logger.info(
      `openclaw-memgpt: sidecar spawning on 127.0.0.1:${port} (data_dir=${dataDir}, sidecarDir=${this.opts.sidecarDir})`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_MEMGPT_DATA_DIR: dataDir,
      OPENCLAW_MEMGPT_HOST: "127.0.0.1",
      OPENCLAW_MEMGPT_PORT: String(port),
    };

    try {
      this.child = this.opts.spawn(
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
          cwd: this.opts.sidecarDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      this._dead = true;
      throw new Error(
        `openclaw-memgpt: failed to spawn sidecar: ${stringifyError(err)}`,
      );
    }

    this.wireChildEvents(this.child);
    this.spawnedUrl = url;

    try {
      await this.pollHealthz(url, this.opts.spawnTimeoutMs, "spawn");
    } catch (err) {
      // start failed; child is alive but unresponsive. Tear it down so we
      // don't leak the process when the SDK swallows our throw.
      this._dead = true;
      await this.terminateChild().catch(() => undefined);
      throw new Error(
        `openclaw-memgpt: sidecar healthz timed out after ${this.opts.spawnTimeoutMs}ms — last stderr lines:\n${this.stderrTail()}\nCause: ${stringifyError(err)}`,
      );
    }

    this.started = true;
    this.logger.info(`openclaw-memgpt: sidecar ready on ${url}`);
  }

  // ── stop ─────────────────────────────────────────────────────────────────

  /**
   * Q6 sequence: skip-if-dead → save (30 s) → SIGTERM → 10 s wait → SIGKILL.
   * Attach mode skips SIGTERM/SIGKILL (we don't own that process).
   *
   * Accepts a SavableClient because the client is constructed in index.ts and
   * not held by the manager — keeps the dependency direction clean.
   */
  async stop(
    client: SavableClient | undefined,
    _ctx: Record<string, unknown> = {},
  ): Promise<void> {
    this.shuttingDown = true;

    if (this._dead) {
      this.logger.info(
        "openclaw-memgpt: teardown — sidecar already dead, skipping save and SIGTERM",
      );
      return;
    }

    if (client !== undefined) {
      try {
        await withTimeout(
          client.save(),
          this.opts.saveTimeoutMs,
          `client.save did not complete within ${this.opts.saveTimeoutMs}ms`,
        );
        this.logger.info("openclaw-memgpt: teardown — final save complete");
      } catch (err) {
        this.logger.error(
          `openclaw-memgpt: teardown — final save failed: ${stringifyError(err)}`,
        );
      }
    }

    if (this.child === undefined) {
      this.logger.info("openclaw-memgpt: teardown — attach mode, nothing to terminate");
      return;
    }

    await this.terminateChild();
    this.logger.info(
      "openclaw-memgpt: teardown — save+shutdown complete (or timed out)",
    );
  }

  // ── resolver ─────────────────────────────────────────────────────────────

  /**
   * Q5 — closure body for SidecarClient's `resolveBaseUrl`. Called inside
   * client.doInit at first hook/tool fire. In the gateway path the SDK has
   * already awaited `start()` by the time this fires, so the happy path is
   * a synchronous URL return through the `spawnedUrl`/`attachUrl` branches.
   *
   * **Lazy-init fallback (post-V1.3).** `openclaw agent --local` skips
   * `startPluginServices` entirely — `server.impl-DLF59fRo.js:21287` only
   * fires it inside the gateway startup path — so on the `--local` route
   * `start()` is never called and both URLs are undefined when tools fire.
   * Before V1.3 that threw `"lifecycle not started"` and the trial was a
   * silent no-op (the agent fell through to stock OpenClaw tools).
   *
   * The fallback below detects the "neither url set, not dead" condition,
   * triggers `start({})` once, and awaits it. `resolveStateDir`'s env +
   * homedir fallback chain handles the empty ctx. Concurrent first calls
   * share `lazyStartPromise` so only one start fires. After it resolves,
   * the second branch returns the real URL. The 120 s spawn-mode healthz
   * block therefore moves from gateway-startup to first-turn — a property
   * of attach-style entry, not a regression.
   *
   * See `docs/methodology-bank.md` #18 for the bug write-up.
   */
  async resolveBaseUrl(): Promise<string> {
    if (this._dead) {
      throw new Error(
        "openclaw-memgpt: sidecar process died; restart OpenClaw to recover",
      );
    }
    if (this.spawnedUrl !== undefined) return this.spawnedUrl;
    if (this.attachUrl !== undefined) return this.attachUrl;

    // Lazy-init: SDK service runner never fired (likely --local mode).
    if (this.lazyStartPromise === undefined) {
      this.logger.info(
        "openclaw-memgpt: lazy lifecycle init triggered (SDK services.start did not fire — likely `openclaw agent --local`; see methodology-bank #18)",
      );
      this.lazyStartPromise = this.start({}).catch((err) => {
        // Clear so a later call can retry if the operator fixes the cause
        // mid-process (rare; the cleared state is what stops a permanently
        // failed promise from livelocking subsequent tool calls).
        this.lazyStartPromise = undefined;
        throw err;
      });
    }
    await this.lazyStartPromise;

    if (this.spawnedUrl !== undefined) return this.spawnedUrl;
    if (this.attachUrl !== undefined) return this.attachUrl;
    throw new Error(
      "openclaw-memgpt: lazy lifecycle init completed but no URL was set — internal invariant violated",
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  private resolveStateDir(ctx: Record<string, unknown>): string {
    if (this.opts.stateDirOverride !== undefined) {
      return this.opts.stateDirOverride;
    }
    const fromCtx = ctx.stateDir;
    if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
    // Fallback to env (also set by OpenClaw outside the SDK context).
    const fromEnv = process.env.OPENCLAW_STATE_DIR;
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    // Last resort — match the documented dev profile.
    return path.join(
      process.env.HOME ?? process.cwd(),
      ".openclaw-dev",
    );
  }

  private async pickFreePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = this.opts.createServer();
      server.once("error", (err) => {
        reject(
          new Error(
            `openclaw-memgpt: pickFreePort failed: ${stringifyError(err)}`,
          ),
        );
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          server.close();
          reject(
            new Error(
              "openclaw-memgpt: pickFreePort got non-AddressInfo from listen()",
            ),
          );
          return;
        }
        const port = addr.port;
        server.close(() => resolve(port));
      });
    });
  }

  private async pollHealthz(
    baseUrl: string,
    timeoutMs: number,
    modeLabel: "spawn" | "attach",
  ): Promise<void> {
    const url = baseUrl.endsWith("/") ? `${baseUrl}healthz` : `${baseUrl}/healthz`;
    const deadline = Date.now() + timeoutMs;
    const start = Date.now();
    let nextProgressLog = start + this.opts.progressLogIntervalMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const resp = await this.opts.fetch(url);
        if (resp.ok) return;
        lastError = `HTTP ${resp.status}`;
      } catch (err) {
        lastError = err;
      }

      const now = Date.now();
      if (modeLabel === "spawn" && now >= nextProgressLog) {
        const elapsedS = Math.round((now - start) / 1000);
        this.logger.info(
          `openclaw-memgpt: still waiting for sidecar healthz (${elapsedS}s elapsed; embedder cold-start takes ~60–90s on first run)`,
        );
        nextProgressLog = now + this.opts.progressLogIntervalMs;
      }

      await sleep(this.opts.pollIntervalMs);
    }

    throw new Error(
      `healthz did not respond within ${timeoutMs}ms (last error: ${stringifyError(lastError)})`,
    );
  }

  private wireChildEvents(child: ChildProcess): void {
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > this.opts.stderrRingSize) {
          this.stderrRing.shift();
        }
      }
    });

    child.on("error", (err) => {
      // Errors during spawn (binary not found, EPERM, etc.). We only flip
      // deadFlag here if we're already past start — pre-start errors are
      // surfaced as start() throws via the outer try/catch in start().
      if (!this.shuttingDown) {
        this.logger.error(
          `openclaw-memgpt: sidecar child error: ${stringifyError(err)}`,
        );
      }
    });

    child.on("exit", (code, signal) => {
      if (this.shuttingDown) {
        this.logger.info(
          `openclaw-memgpt: sidecar exited cleanly during teardown (code=${code}, signal=${signal ?? "none"})`,
        );
        return;
      }
      this._dead = true;
      this.logger.error(
        `openclaw-memgpt: sidecar process died (code=${code}, signal=${signal ?? "none"}). Last stderr lines:\n${this.stderrTail()}`,
      );
    });
  }

  /** SIGTERM → wait up to sigtermTimeoutMs → SIGKILL. Idempotent. */
  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    try {
      child.kill("SIGTERM");
    } catch (err) {
      this.logger.warn(
        `openclaw-memgpt: SIGTERM threw: ${stringifyError(err)}`,
      );
    }

    const winner = await Promise.race([
      exited.then(() => "exited" as const),
      sleep(this.opts.sigtermTimeoutMs).then(() => "timeout" as const),
    ]);

    if (winner === "exited") return;

    this.logger.warn(
      `openclaw-memgpt: sidecar did not exit within ${this.opts.sigtermTimeoutMs}ms of SIGTERM — sending SIGKILL`,
    );
    try {
      child.kill("SIGKILL");
    } catch (err) {
      this.logger.warn(
        `openclaw-memgpt: SIGKILL threw: ${stringifyError(err)}`,
      );
    }
  }

  private stderrTail(): string {
    return this.stderrRing.join("\n");
  }
}

// ============================================================================
// helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
