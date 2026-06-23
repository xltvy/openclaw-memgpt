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
 *   Q5 resolver: sidecar base URL — config.sidecarUrl, then env, then a self-managed local port
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
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createServer as nodeCreateServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { isConfigComplete, type PluginConfig } from "../config.ts";
import { isEndpointReachable, isLocalUrl } from "../reachability.ts";
import type {
  ActivatableEventSink,
  MemoryEventKind,
} from "../observability/events.ts";

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
 * Sidecar directory — walk up from this module's location until we find the dir
 * containing `sidecar/main.py`. This must be robust to *entry depth*: from
 * source this module is at `src/lifecycle/…` (plugin root is two up), but from
 * the bundled compiled entry it runs from `dist/index.js` (plugin root is one
 * up). A fixed `../..` is correct for source but overshoots for the bundle —
 * which silently resolved the sidecar dir one level above the plugin, so the
 * spawn failed with `spawn uv ENOENT` (a non-existent `cwd`). Walking up to the
 * `sidecar/main.py` marker handles source, `--link`, and packaged installs.
 */
export function findSidecarDir(
  startDir: string,
  exists: (p: string) => boolean = existsSync,
): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "sidecar");
    if (exists(path.join(candidate, "main.py"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the legacy source-layout heuristic (climb two).
  return path.join(path.resolve(startDir, "..", ".."), "sidecar");
}

const DEFAULT_SIDECAR_DIR = findSidecarDir(
  path.dirname(fileURLToPath(import.meta.url)),
);

// ============================================================================
// Shared dead-sidecar surface (consumed by tools/hooks at entry, 6c.10a Q4)
// ============================================================================

export const SIDECAR_DEAD_MESSAGE =
  "openclaw-memgpt: sidecar process died; restart OpenClaw to recover";

/**
 * Verbatim tool-result / error string when the plugin has no LLM provider +
 * credential configured (§6d.6). Tools surface this to the LLM and
 * `resolveBaseUrl` throws it; `start` skips the sidecar spawn entirely so an
 * unconfigured plugin never pays the embedder cold-start or runs a
 * credential-less sidecar.
 */
export const NOT_CONFIGURED_MESSAGE =
  "openclaw-memgpt: not configured — run `openclaw memgpt setup` to choose an LLM provider and supply an API key.";

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
  /**
   * §6.2 observability sink. When supplied, `start` activates it (resolving the
   * state dir) and the manager emits process-lifecycle events
   * (`sidecar_spawned` / `sidecar_exited` / `health_failed`) through it.
   */
  emitter?: ActivatableEventSink;
  /**
   * §6d.6 — async contributor of LLM credential env vars
   * (`OPENAI_API_KEY` / `OPENAI_API_BASE`) for the spawned sidecar, resolved
   * from the wizard's stored credential reference. Receives the resolved state
   * dir (the secret-file root). Merged over the inherited environment but under
   * the plugin-managed pins. Absent ⇒ the sidecar inherits credentials from the
   * shell env verbatim (pre-6d.6 behaviour).
   */
  credentialEnv?: (stateDir: string) => Promise<Record<string, string>>;
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
    Omit<
      LifecycleManagerOptions,
      | "spawn"
      | "createServer"
      | "fetch"
      | "stateDirOverride"
      | "emitter"
      | "credentialEnv"
    >
  > & {
    spawn: SpawnFn;
    createServer: CreateServerFn;
    fetch: FetchFn;
    stateDirOverride?: string;
    emitter?: ActivatableEventSink;
    credentialEnv?: (stateDir: string) => Promise<Record<string, string>>;
  };

  private child?: ChildProcess;
  private spawnedUrl?: string;
  private attachUrl?: string;
  /**
   * Path to the sidecar's stdout/stderr log file. The child writes here via an
   * inherited file descriptor (NOT a pipe) — see the spawn block for why. Crash
   * diagnostics read the tail of this file (`stderrTail`). Undefined until spawn
   * (and in attach mode, where there is no child to log).
   */
  private logPath?: string;
  private started = false;
  /** Set true on `stop` entry so the child `exit` listener doesn't flip deadFlag. */
  private shuttingDown = false;
  /**
   * In-flight `start` promise, memoised. `register()` fires multiple times in a
   * single process and each call registers a `memgpt-sidecar` service, so the
   * SDK service runner can invoke `start` N times; the lazy-init path
   * (`resolveBaseUrl`) is a further caller. Memoising collapses them all to a
   * single spawn + healthz block. Cleared on failure so a later call retries;
   * left set on success (re-entry then short-circuits via `started`).
   */
  private startPromise?: Promise<void>;
  /**
   * In-flight `stop` promise, memoised. Mirror of `startPromise`: the SDK runs
   * the (N) registered `stop`s in reverse order, so without this the final save
   * + SIGTERM would fire once per registration. Memoising makes teardown
   * happen exactly once.
   */
  private stopPromise?: Promise<void>;

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

  /**
   * True when the plugin has a usable LLM config (provider + credential).
   * Tools/hooks consult this at entry to short-circuit with
   * `NOT_CONFIGURED_MESSAGE` instead of spawning / hitting a credential-less
   * sidecar (§6d.6). `start` and `resolveBaseUrl` gate on the same predicate.
   */
  get isConfigured(): boolean {
    return isConfigComplete(this.config);
  }

  /**
   * The observability sink this (singleton) manager owns and `activate()`s in
   * `start`. Exposed so every per-registration `deps` routes through the SAME
   * activated emitter: the lifecycle is a process-singleton per namespace, but
   * `register()` fires multiple times and constructs an emitter each call —
   * only the first registration's emitter gets its JSONL sink activated. Without
   * sharing this, hooks dispatched on a *later* registration would emit to an
   * un-activated emitter (live EventEmitter only, no JSONL), leaving the
   * "authoritative research record" (§6.2/§6.3) incomplete under gateway/multi-
   * register. Returns the first registration's emitter (the one passed when the
   * singleton was created).
   */
  get emitter(): ActivatableEventSink | undefined {
    return this.opts.emitter;
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
      emitter: options.emitter,
      credentialEnv: options.credentialEnv,
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
    // Collapse concurrent / repeated starts (N service registrations + lazy
    // path) to one spawn. Cleared on failure so the next caller can retry.
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this._doStart(ctx).catch((err) => {
      this.startPromise = undefined;
      throw err;
    });
    return this.startPromise;
  }

  private async _doStart(ctx: Record<string, unknown>): Promise<void> {
    // §6d.6 config gate — without a provider + credential the sidecar has no
    // usable LLM, so skip the spawn entirely (no embedder cold-start, no
    // credential-less process). Leaves `started=false`; `resolveBaseUrl` throws
    // NOT_CONFIGURED and tools short-circuit. Not a throw: the unconfigured
    // state is expected and already surfaced by the register-time notice.
    if (!isConfigComplete(this.config)) {
      this.logger.warn(
        "openclaw-memgpt: not configured — skipping sidecar spawn. Run `openclaw memgpt setup`.",
      );
      return;
    }

    // §6.2 two-phase init: activate the observability sink now that the state
    // dir is resolvable. Covers both the gateway start path and the `--local`
    // lazy-init path (both route through here). Before this, lifecycle/tool
    // emits still hit the EventEmitter + logger; only JSONL is buffered out.
    if (this.opts.emitter !== undefined) {
      await this.opts.emitter
        .activate(this.resolveStateDir(ctx))
        .catch((err) => {
          this.logger.warn(
            `openclaw-memgpt: observability sink activate failed: ${stringifyError(err)}`,
          );
        });
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
        await this.warnIfLlmEndpointUnreachable();
        return;
      } catch (err) {
        this._dead = true;
        this.emitLifecycle("health_failed", {
          mode: "attach",
          timeoutMs: this.opts.attachTimeoutMs,
        });
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
    // uv venv relocated out of the plugin dir (see env block below).
    const venvDir = path.join(stateDir, "memgpt-sidecar-venv");

    this.logger.info(
      `openclaw-memgpt: sidecar spawning on 127.0.0.1:${port} (data_dir=${dataDir}, venv=${venvDir}, sidecarDir=${this.opts.sidecarDir})`,
    );

    // §6d.6 — resolve the wizard's stored credential into LLM env vars. Merged
    // over inherited process.env (the resolved key is authoritative) but under
    // the plugin-managed pins below. Failures are logged, not fatal — the
    // sidecar then falls back to whatever the shell env carries.
    let credEnv: Record<string, string> = {};
    if (this.opts.credentialEnv !== undefined) {
      try {
        credEnv = await this.opts.credentialEnv(stateDir);
      } catch (err) {
        this.logger.warn(
          `openclaw-memgpt: credential resolution failed; sidecar will use shell env: ${stringifyError(err)}`,
        );
      }
    }

    // `UV_PROJECT_ENVIRONMENT` puts `uv run`'s virtualenv at `venvDir` (under
    // the state dir) instead of the default `<sidecarDir>/.venv`. That default
    // pulls in torch/transformers/scipy for the embedder (~6.5k directories);
    // inside the installed plugin it bloats the tree past OpenClaw's 10k-dir
    // install/update safety-scan limit (and bloats a dev `--link` source tree
    // the same way). Relocating keeps the plugin tree small and lets the venv
    // persist across reinstalls (no torch re-download). `uninstall` removes it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...credEnv,
      OPENCLAW_MEMGPT_DATA_DIR: dataDir,
      OPENCLAW_MEMGPT_HOST: "127.0.0.1",
      OPENCLAW_MEMGPT_PORT: String(port),
      UV_PROJECT_ENVIRONMENT: venvDir,
    };

    // Route the child's stdout/stderr to a LOG FILE, not a pipe. A pipe's read
    // end is held by this (parent) process; when the parent exits — as it does
    // immediately after the turn in `--local` one-shot mode — the pipe closes,
    // and uvicorn's graceful-shutdown logging then writes to a broken pipe and
    // dies *mid-save*, truncating the persistence pickle to 0 bytes (proven by
    // a single-variable repro: stdio "pipe" → 0-byte pickle, "ignore"/file →
    // complete pickle). A file fd is independent of the parent's lifecycle, so
    // the SIGTERM-driven lifespan save (sidecar P4) runs to completion after
    // the parent is gone. Crash diagnostics are preserved — and improved — by
    // tailing this file (`stderrTail`) instead of an in-memory ring buffer.
    // No log rotation in v1 (documented limitation); operators can use OS
    // logrotate. On open failure we degrade to discarding output, never block
    // the spawn.
    this.logPath = path.join(stateDir, "memgpt-sidecar.log");
    let logFd: number | undefined;
    try {
      mkdirSync(stateDir, { recursive: true });
      logFd = openSync(this.logPath, "a");
    } catch (err) {
      this.logger.warn(
        `openclaw-memgpt: could not open sidecar log at ${this.logPath}; sidecar output will be discarded: ${stringifyError(err)}`,
      );
      this.logPath = undefined;
    }

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
          // stdin ignored; stdout+stderr → the inherited log fd (or discarded).
          stdio:
            logFd !== undefined
              ? ["ignore", logFd, logFd]
              : ["ignore", "ignore", "ignore"],
        },
      );
    } catch (err) {
      this._dead = true;
      if (logFd !== undefined) closeSync(logFd);
      throw new Error(
        `openclaw-memgpt: failed to spawn sidecar: ${stringifyError(err)}`,
      );
    }
    // The child inherited its own dup of the fd; the parent's copy is no longer
    // needed (and keeping it open would leak a descriptor per spawn).
    if (logFd !== undefined) closeSync(logFd);

    this.wireChildEvents(this.child);
    // Detach the child from the parent's event loop reference count so
    // openclaw's process can exit cleanly post-turn without waiting on the
    // long-running uvicorn child. `unref()` only removes the keep-alive
    // reference; the child still runs until SIGTERMed. We pair this with
    // `installExitHandler` below so the child doesn't leak when the parent
    // exits without going through `LifecycleManager.stop` (the `--local`
    // path). With file-fd stdio (above) there are no child.stdout/stderr
    // pipe streams to unref — that whole class of keep-alive is gone.
    this.child.unref();
    this.installExitHandler();
    this.spawnedUrl = url;

    // Fast-fail: a missing `uv` surfaces as an async `spawn uv ENOENT` *error*
    // event (not a synchronous throw), and a sidecar that boots then crashes
    // emits an early `exit`. Race both against the healthz poll so we abort
    // immediately instead of polling for the full 120 s timeout. `settled`
    // makes the listeners no-ops once the race is decided (so the legitimate
    // teardown `exit` later doesn't reject an unawaited promise).
    const child = this.child;
    let settled = false;
    // Abort the losing race branch: when `startupFailed` wins, `pollHealthz`
    // would otherwise keep looping + logging for the full timeout (Promise.race
    // doesn't cancel the loser) and its un-unref'd sleep timers would keep the
    // process alive. The signal stops it within one poll interval.
    const pollAbort = new AbortController();
    const startupFailed = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `failed to launch sidecar via \`uv run\` — is uv installed and on PATH? (${stringifyError(err)})`,
          ),
        );
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `sidecar exited during startup (code=${code}, signal=${signal ?? "none"})`,
          ),
        );
      });
    });

    try {
      await Promise.race([
        this.pollHealthz(url, this.opts.spawnTimeoutMs, "spawn", pollAbort.signal),
        startupFailed,
      ]);
      settled = true;
    } catch (err) {
      // Spawn error / early exit / healthz timeout — tear the child down so we
      // don't leak the process when the SDK swallows our throw.
      settled = true;
      this._dead = true;
      this.emitLifecycle("health_failed", {
        mode: "spawn",
        port,
        timeoutMs: this.opts.spawnTimeoutMs,
      });
      await this.terminateChild().catch(() => undefined);
      const tail = this.stderrTail();
      throw new Error(
        `openclaw-memgpt: sidecar did not become ready: ${stringifyError(err)}${tail ? `\nLast stderr lines:\n${tail}` : ""}`,
      );
    } finally {
      // Stop the losing pollHealthz (no-op if it already won/finished).
      pollAbort.abort();
    }

    this.started = true;
    this.emitLifecycle("sidecar_spawned", { port });
    this.logger.info(`openclaw-memgpt: sidecar ready on ${url}`);
    await this.warnIfLlmEndpointUnreachable();
  }

  /**
   * §6d.6 — after the sidecar is up, probe the configured LLM endpoint
   * (config.baseUrl). The sidecar boots fine without it (only summarisation
   * calls the LLM), so an unreachable endpoint would otherwise stay silent
   * until an overflow turn. Warn loudly + actionably instead. Non-fatal;
   * connection-level only (any HTTP response = reachable).
   */
  private async warnIfLlmEndpointUnreachable(): Promise<void> {
    const base = this.config.baseUrl;
    if (base === undefined) return;
    const reachable = await isEndpointReachable(base, {
      fetch: this.opts.fetch,
      timeoutMs: 4000,
    });
    if (reachable) return;
    this.logger.warn(
      `openclaw-memgpt: configured LLM endpoint ${base} is not reachable — memory's LLM step (summarisation on context overflow) will fail until it's up.${
        isLocalUrl(base)
          ? " If it's a local server (LiteLLM/Ollama/…), start it; the plugin does not launch it."
          : ""
      }`,
    );
  }

  /** Already-registered exit handler closure (kept for test cleanup). */
  private exitHandler?: () => void;

  /**
   * Register a `process.on('exit', …)` handler that SIGTERMs the spawned
   * child. Belt + braces complement to `LifecycleManager.stop`:
   *
   * - **Gateway mode** — `services.stop` fires before parent exit and
   *   calls `stop()` → `terminateChild()` → SIGTERM/SIGKILL → child exits.
   *   By the time this handler fires, `this.child` is undefined or dead,
   *   and the handler no-ops.
   * - **`--local` mode** — `services.stop` never fires. This handler is
   *   the only path that kills the child, ensuring no zombie uvicorn
   *   processes leak across trials.
   *
   * `process.on('exit')` runs synchronously and only sync work is
   * possible — `child.kill()` is sync, which is what we need. We don't
   * `await terminateChild()` here (which has SIGTERM-then-await-then-
   * SIGKILL semantics); SIGTERM fire-and-forget is the best we can do at
   * exit time.
   */
  private installExitHandler(): void {
    if (this.exitHandler !== undefined) return;
    this.exitHandler = () => {
      if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // Process already gone or unprivileged — nothing to clean up.
        }
      }
    };
    process.on("exit", this.exitHandler);
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
    ctx: Record<string, unknown> = {},
  ): Promise<void> {
    // Memoise: the SDK runs each registration's `stop` (N of them, shared
    // manager), so without this the save + SIGTERM would fire once per
    // registration. Teardown happens exactly once.
    return (this.stopPromise ??= this._doStop(client, ctx));
  }

  private async _doStop(
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
    // De-register the exit handler now that we've cleaned up explicitly —
    // belt + braces no longer needed, and dangling listeners would
    // accumulate across tests that construct many managers.
    if (this.exitHandler !== undefined) {
      process.off("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
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
   * **Lazy-init fallback.** `openclaw agent --local` skips
   * `startPluginServices` entirely — `server.impl-DLF59fRo.js:21287` only
   * fires it inside the gateway startup path — so on the `--local` route
   * `start()` is never called and both URLs are undefined when tools fire.
   * Without the fallback that threw `"lifecycle not started"` and the agent
   * fell through to stock OpenClaw tools.
   *
   * The fallback below detects the "neither url set, not dead" condition,
   * triggers `start({})` once, and awaits it. `resolveStateDir`'s env +
   * homedir fallback chain handles the empty ctx. Concurrent first calls
   * share `lazyStartPromise` so only one start fires. After it resolves,
   * the second branch returns the real URL. The 120 s spawn-mode healthz
   * block therefore moves from gateway-startup to first-turn — a property
   * of attach-style entry, not a regression.
   */
  async resolveBaseUrl(): Promise<string> {
    // §6d.6 config gate — fail fast and clearly rather than triggering the
    // lazy-init spawn of a credential-less sidecar.
    if (!isConfigComplete(this.config)) {
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    if (this._dead) {
      throw new Error(
        "openclaw-memgpt: sidecar process died; restart OpenClaw to recover",
      );
    }
    if (this.spawnedUrl !== undefined) return this.spawnedUrl;
    if (this.attachUrl !== undefined) return this.attachUrl;

    // Lazy-init: SDK service runner never fired (likely --local mode). `start`
    // is memoised, so this shares the single spawn with the SDK service path
    // and with any concurrent first-callers — no separate guard needed here.
    if (this.startPromise === undefined && !this.started) {
      this.logger.info(
        "openclaw-memgpt: lazy lifecycle init triggered (SDK services.start did not fire — likely `openclaw agent --local`)",
      );
    }
    await this.start({});

    if (this.spawnedUrl !== undefined) return this.spawnedUrl;
    if (this.attachUrl !== undefined) return this.attachUrl;
    throw new Error(
      "openclaw-memgpt: lazy lifecycle init completed but no URL was set — internal invariant violated",
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Emit a process-lifecycle event (§6.2) if an emitter is wired. */
  private emitLifecycle(
    kind: MemoryEventKind,
    meta: Record<string, number | string | boolean>,
  ): void {
    this.opts.emitter?.emit({
      kind,
      namespace: this.config.namespace,
      ts: new Date().toISOString(),
      meta,
    });
  }

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
    signal?: AbortSignal,
  ): Promise<void> {
    const url = baseUrl.endsWith("/") ? `${baseUrl}healthz` : `${baseUrl}/healthz`;
    const deadline = Date.now() + timeoutMs;
    const start = Date.now();
    let nextProgressLog = start + this.opts.progressLogIntervalMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      // Aborted because a competing condition (spawn error / early exit) already
      // decided startup — stop quietly so we don't keep polling + logging for
      // the full timeout, and so un-unref'd sleep timers stop holding the loop.
      if (signal?.aborted) return;
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
    // No stderr 'data' listener: the child's stderr goes to the log file via an
    // inherited fd (see spawn), not a pipe. Crash diagnostics read the file
    // tail (`stderrTail`) instead of an in-memory ring.
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
      this.emitLifecycle("sidecar_exited", {
        code: code ?? -1,
        signal: signal ?? "none",
      });
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

  /**
   * Last `stderrRingSize` non-empty lines of the sidecar's log file — the
   * crash-diagnostic context surfaced in the `sidecar process died` /
   * `did not become ready` messages. Best-effort: returns "" if the log is
   * absent or unreadable (e.g. open failed and output was discarded).
   */
  private stderrTail(): string {
    if (this.logPath === undefined) return "";
    try {
      const lines = readFileSync(this.logPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.length > 0);
      return lines.slice(-this.opts.stderrRingSize).join("\n");
    } catch {
      return "";
    }
  }
}

// ============================================================================
// Process-singleton registry (Shape A)
// ============================================================================

/**
 * OpenClaw calls a plugin's `register()` multiple times within one process
 * (discovery / runtime / context-engine contexts — all the same config). Our
 * backend is a *spawned sidecar with in-memory resident agent state*, so a
 * fresh `LifecycleManager` per `register()` spawned a fresh sidecar each time:
 * the `before_prompt_build` hook would `:ensure` the agent into one sidecar
 * while a tool call landed on another, where the agent was never loaded —
 * surfacing as `404 … "Agent '<ns>' is not resident"`.
 *
 * `@openclaw/memory-lancedb` avoids this by being stateless-per-op over a
 * shared on-disk table (every `register()` opens the same `dbPath`). The
 * equivalent for a *process* backend is to share the one process: this registry
 * returns a single `LifecycleManager` per `namespace` (+ attach URL), so every
 * registration resolves to the same sidecar and residency established by the
 * hook is visible to the tools. Per-registration `SidecarClient`s are kept (they
 * are cheap and hold no residency state) — they all close over this shared
 * manager's `resolveBaseUrl`.
 *
 * Keyed by namespace because, within a single OpenClaw process, the state dir
 * (hence data dir) is constant; the namespace is the only discriminator, and a
 * distinct attach URL implies a distinct backend.
 */
const lifecycleRegistry = new Map<string, LifecycleManager>();

function lifecycleKey(config: PluginConfig): string {
  return `${config.namespace} ${config.sidecarUrl ?? ""}`;
}

/**
 * Get-or-create the process-singleton `LifecycleManager` for this config's
 * namespace. The first caller's `logger`/`options` win; later callers reuse the
 * existing manager (their `options` are ignored by design — there is one
 * sidecar, with one observability sink, owned by the first registration).
 */
export function getOrCreateLifecycle(
  config: PluginConfig,
  logger: OpenClawPluginApi["logger"],
  options: LifecycleManagerOptions = {},
): LifecycleManager {
  const key = lifecycleKey(config);
  let manager = lifecycleRegistry.get(key);
  if (manager === undefined) {
    manager = new LifecycleManager(config, logger, options);
    lifecycleRegistry.set(key, manager);
  }
  return manager;
}

/** Test-only: clear the singleton registry between cases. */
export function _resetLifecycleRegistry(): void {
  lifecycleRegistry.clear();
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
