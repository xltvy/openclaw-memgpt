/**
 * Unit tests for §6.1 LifecycleManager (6c.10b). DI-mocked — no actual
 * subprocess spawned, no network, no real ports listened on except in the
 * pickFreePort test (which uses real net.createServer because mocking it is
 * busier than the test it would replace).
 *
 * Coverage per 6c.10a Q1–Q6:
 *   Q1 — port allocation: pickFreePort returns a positive number; two calls
 *        do not return the same port (probabilistic — kernel picks ephemerals).
 *   Q2 — healthz polling: timeout throws; isDead set; child terminated.
 *   Q3 — env propagation: explicit knobs override; process.env keys flow.
 *   Q4 — crash recovery: child exit flips isDead; stderr captured.
 *   Q5 — resolveBaseUrl precedence (config → env → spawn) + throws on dead /
 *        unstarted.
 *   Q6 — teardown sequence: save → SIGTERM → SIGKILL; skip-if-dead.
 *
 * Plus a baseline registration-shape test that registerService is wired with
 * both start and stop (the 6c.8 bug-fix property: SDK's
 * services-CLs267o9.js:30 calls `await service.start(serviceContext)` with
 * no `?` guard, so a missing start TypErrors and skips the stop wiring).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  findSidecarDir,
  getOrCreateLifecycle,
  LifecycleManager,
  NOT_CONFIGURED_MESSAGE,
  SIDECAR_DEAD_MESSAGE,
  _resetLifecycleRegistry,
} from "../../src/lifecycle/lifecycleManager.ts";
import type { PluginConfig } from "../../src/config.ts";
import type {
  ActivatableEventSink,
  MemoryEvent,
} from "../../src/observability/events.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    namespace: "test",
    model: "test-model",
    persona: "test-persona",
    human: "test-human",
    observability: "default",
    // Configured by default (provider + credential) so spawn/attach tests run;
    // the §6d.6 config gate is exercised by overriding these to undefined.
    provider: "openai",
    credential: { source: "env", var: "OPENAI_API_KEY" },
    ...overrides,
  };
}

interface LoggerStub {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  infos: string[];
  warns: string[];
  errors: string[];
}

function makeLogger(): LoggerStub {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    debug: () => undefined,
    infos,
    warns,
    errors,
  };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout: Readable & { unref?: () => void } = Object.assign(
    new Readable({ read() {} }),
    { unref: () => undefined },
  );
  stderr: Readable & { unref?: () => void } = Object.assign(
    new Readable({ read() {} }),
    { unref: () => undefined },
  );
  killed = false;
  killSignals: NodeJS.Signals[] = [];
  unrefCount = 0;

  /** Indicates whether kill('SIGTERM') causes a synchronous exit. */
  exitOnSigterm = true;

  /** Matches the real ChildProcess.unref() contract (no-op for the stub). */
  unref(): void {
    this.unrefCount += 1;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const sig =
      typeof signal === "number" ? ("SIGTERM" as NodeJS.Signals) : signal;
    this.killSignals.push(sig);
    this.killed = true;
    if (sig === "SIGTERM" && this.exitOnSigterm) {
      // Mimic uvicorn's quick graceful shutdown.
      setImmediate(() => this.emitExit(0, "SIGTERM"));
    } else if (sig === "SIGKILL") {
      setImmediate(() => this.emitExit(137, "SIGKILL"));
    }
    return true;
  }

  emitExit(code: number, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  /** Simulate an async spawn failure (e.g. `spawn uv ENOENT`). */
  emitError(err: Error): void {
    this.emit("error", err);
  }

  emitStderr(line: string): void {
    this.stderr.push(`${line}\n`);
  }
}

interface FakeFetchHandler {
  (url: string): Promise<{ ok: boolean; status: number }>;
}

function fetchReturning(
  responder: FakeFetchHandler,
): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    const out = await responder(url);
    // Cast — we only use .ok / .status on the consumer side.
    return out as unknown as Response;
  }) as typeof fetch;
}

function spawnReturning(child: FakeChild): (...args: unknown[]) => FakeChild {
  return () => child;
}

/** Capturing emitter — records §6.2 lifecycle events + the activate state dir. */
function makeFakeEmitter(): ActivatableEventSink & {
  events: MemoryEvent[];
  activatedWith: string[];
} {
  const events: MemoryEvent[] = [];
  const activatedWith: string[] = [];
  return {
    events,
    activatedWith,
    emit: (e: MemoryEvent) => events.push(e),
    activate: async (stateDir: string) => {
      activatedWith.push(stateDir);
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

// Q5 lazy-init (methodology-bank #18) — resolveBaseUrl without prior start
// triggers a one-shot start({}) so plugin works under `openclaw agent --local`
// where the SDK skips startPluginServices.
test("resolveBaseUrl lazy-init — fires start({}) when neither URL set, returns URL on success (attach mode)", async () => {
  const fakeFetch = fetchReturning(async () => ({ ok: true, status: 200 }));
  const lc = new LifecycleManager(
    makeConfig({ sidecarUrl: "http://lazy.attach:7777" }),
    makeLogger(),
    {
      attachTimeoutMs: 1_000,
      pollIntervalMs: 10,
      fetch: fakeFetch,
      // Spawn should never be invoked — attach config wins inside start().
      spawn: (() => {
        throw new Error("spawn should not fire in attach lazy-init");
      }) as never,
    },
  );
  // No explicit start() call here — resolveBaseUrl triggers it via the lazy
  // path; the SDK contract is what register() set up, not what we awaited.
  const url = await lc.resolveBaseUrl();
  assert.equal(url, "http://lazy.attach:7777");
  assert.equal(lc.mode, "attach", "must be in attach mode after lazy init");
});

// Q5 — attach via config
test("attach mode (config.sidecarUrl) — pings configured URL, doesn't spawn", async () => {
  const calls: string[] = [];
  const fakeFetch = fetchReturning(async (url) => {
    calls.push(url);
    return { ok: true, status: 200 };
  });
  let spawnCalled = false;
  const lc = new LifecycleManager(
    makeConfig({ sidecarUrl: "http://attach.test:1234" }),
    makeLogger(),
    {
      attachTimeoutMs: 1_000,
      pollIntervalMs: 10,
      fetch: fakeFetch,
      spawn: (() => {
        spawnCalled = true;
        return new FakeChild() as never;
      }) as never,
    },
  );

  await lc.start({});
  assert.equal(spawnCalled, false, "must not spawn in attach mode");
  assert.deepEqual(calls, ["http://attach.test:1234/healthz"]);
  assert.equal(lc.mode, "attach");
  assert.equal(await lc.resolveBaseUrl(), "http://attach.test:1234");
});

// Q5 — attach via env var
test("attach mode (OPENCLAW_MEMGPT_SIDECAR_URL env) — env honoured when config absent", async () => {
  const prev = process.env.OPENCLAW_MEMGPT_SIDECAR_URL;
  process.env.OPENCLAW_MEMGPT_SIDECAR_URL = "http://env.test:9999";
  try {
    const fakeFetch = fetchReturning(async () => ({ ok: true, status: 200 }));
    const lc = new LifecycleManager(makeConfig(), makeLogger(), {
      attachTimeoutMs: 1_000,
      pollIntervalMs: 10,
      fetch: fakeFetch,
      spawn: (() => {
        throw new Error("spawn should not be invoked");
      }) as never,
    });
    await lc.start({});
    assert.equal(await lc.resolveBaseUrl(), "http://env.test:9999");
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_MEMGPT_SIDECAR_URL;
    else process.env.OPENCLAW_MEMGPT_SIDECAR_URL = prev;
  }
});

// Q5 — config takes precedence over env
test("config.sidecarUrl takes precedence over env var", async () => {
  const prev = process.env.OPENCLAW_MEMGPT_SIDECAR_URL;
  process.env.OPENCLAW_MEMGPT_SIDECAR_URL = "http://env.loses:1";
  try {
    const fakeFetch = fetchReturning(async () => ({ ok: true, status: 200 }));
    const lc = new LifecycleManager(
      makeConfig({ sidecarUrl: "http://config.wins:2" }),
      makeLogger(),
      {
        attachTimeoutMs: 1_000,
        pollIntervalMs: 10,
        fetch: fakeFetch,
        spawn: (() => new FakeChild() as never) as never,
      },
    );
    await lc.start({});
    assert.equal(await lc.resolveBaseUrl(), "http://config.wins:2");
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_MEMGPT_SIDECAR_URL;
    else process.env.OPENCLAW_MEMGPT_SIDECAR_URL = prev;
  }
});

// Q1 — port allocation real-net round-trip
test("pickFreePort returns a positive port; different calls yield different ports (probabilistic)", async () => {
  // Real createServer — pickFreePort is private; we drive it indirectly via a
  // spawn-mode start that captures the port from spawn invocation.
  const fakeChild = new FakeChild();
  let lastPort: number | undefined;
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: ((_cmd: string, args: string[]) => {
      const idx = args.indexOf("--port");
      lastPort = Number(args[idx + 1]);
      return fakeChild as never;
    }) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });
  assert.equal(typeof lastPort, "number");
  assert.ok(lastPort! > 0 && lastPort! < 65536, "port in valid range");

  // Second call — different lifecycle instance, fresh port pick.
  const fakeChild2 = new FakeChild();
  let secondPort: number | undefined;
  const lc2 = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: ((_cmd: string, args: string[]) => {
      const idx = args.indexOf("--port");
      secondPort = Number(args[idx + 1]);
      return fakeChild2 as never;
    }) as never,
  });
  await lc2.start({ stateDir: "/tmp/oc-test" });
  assert.notEqual(
    lastPort,
    secondPort,
    "kernel should give different ephemeral ports across rapid calls",
  );
});

// Q3 — env propagation contract: explicit knobs + process.env passthrough
test("spawn-mode env: explicit OPENCLAW_MEMGPT_* set; process.env keys flow through", async () => {
  const fakeChild = new FakeChild();
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedCwd: string | undefined;
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    sidecarDir: "/tmp/fake-sidecar",
    stateDirOverride: "/tmp/oc-state",
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      capturedEnv = opts.env;
      capturedCwd = opts.cwd;
      return fakeChild as never;
    }) as never,
  });

  const sentinelKey = "OPENCLAW_TEST_SENTINEL";
  const prev = process.env[sentinelKey];
  process.env[sentinelKey] = "sentinel-value";
  try {
    await lc.start({});
  } finally {
    if (prev === undefined) delete process.env[sentinelKey];
    else process.env[sentinelKey] = prev;
  }

  assert.equal(capturedCwd, "/tmp/fake-sidecar");
  assert.equal(
    capturedEnv?.OPENCLAW_MEMGPT_DATA_DIR,
    "/tmp/oc-state/memgpt-data",
  );
  assert.equal(capturedEnv?.OPENCLAW_MEMGPT_HOST, "127.0.0.1");
  assert.equal(typeof capturedEnv?.OPENCLAW_MEMGPT_PORT, "string");
  assert.equal(
    capturedEnv?.[sentinelKey],
    "sentinel-value",
    "process.env keys must flow through the spread",
  );
});

// Q2 — healthz timeout
test("spawn-mode healthz timeout — start throws; isDead set; child terminated", async () => {
  const fakeChild = new FakeChild();
  fakeChild.exitOnSigterm = true; // accept SIGTERM cleanly for teardown
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 100,
    pollIntervalMs: 20,
    sigtermTimeoutMs: 50,
    fetch: fetchReturning(async () => ({ ok: false, status: 503 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await assert.rejects(
    lc.start({ stateDir: "/tmp/oc-test" }),
    /did not become ready/,
  );
  assert.equal(lc.isDead, true);
  assert.ok(
    fakeChild.killSignals.includes("SIGTERM"),
    "child must be SIGTERMed when healthz times out",
  );
});

// Q4 — crash during run flips isDead
test("child exit after start — isDead set; stderr tail (from log file) surfaces in error log", async () => {
  // b1: the sidecar's stderr goes to <stateDir>/memgpt-sidecar.log via an
  // inherited fd, not a pipe; the crash log reads that file's tail. Simulate
  // the sidecar having written a traceback to the log before it exits.
  const fakeChild = new FakeChild();
  const logger = makeLogger();
  const stateDir = mkdtempSync(path.join(tmpdir(), "oc-stderr-"));
  const lc = new LifecycleManager(makeConfig(), logger, {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    stateDirOverride: stateDir,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({});
  assert.equal(lc.isDead, false);

  appendFileSync(
    path.join(stateDir, "memgpt-sidecar.log"),
    "Traceback (most recent call last):\nRuntimeError: synthetic crash\n",
  );
  fakeChild.emitExit(1, null);

  assert.equal(lc.isDead, true);
  assert.equal(
    logger.errors.some((m) => m.includes("synthetic crash")),
    true,
    "crash log must include the log-file tail",
  );
});

// b1 — sidecar stdout/stderr must be wired to a LOG FILE fd, not pipes. Pipes'
// read ends are held by the parent; when the parent exits in `--local` they
// close, and uvicorn's shutdown logging dies on the broken pipe mid-save
// (truncated pickle). A file fd is independent of the parent's lifecycle.
test("spawn-mode: sidecar stdio goes to a log-file fd, not pipes (b1)", async () => {
  let capturedStdio: unknown;
  const fakeChild = new FakeChild();
  const stateDir = mkdtempSync(path.join(tmpdir(), "oc-logfd-"));
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 500,
    pollIntervalMs: 10,
    stateDirOverride: stateDir,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: ((_cmd: string, _args: string[], opts: { stdio?: unknown }) => {
      capturedStdio = opts?.stdio;
      return fakeChild;
    }) as never,
  });
  await lc.start({});
  assert.ok(Array.isArray(capturedStdio), "stdio must be an array");
  const stdio = capturedStdio as unknown[];
  assert.equal(stdio[0], "ignore", "stdin ignored");
  assert.equal(typeof stdio[1], "number", "stdout must be a file fd (number), not 'pipe'");
  assert.equal(typeof stdio[2], "number", "stderr must be a file fd (number), not 'pipe'");
  assert.ok(
    existsSync(path.join(stateDir, "memgpt-sidecar.log")),
    "the sidecar log file must be created",
  );
});

// Q5 — resolveBaseUrl rejects when dead
test("resolveBaseUrl rejects when isDead", async () => {
  const fakeChild = new FakeChild();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });
  fakeChild.emitExit(1, null);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    async () => await lc.resolveBaseUrl(),
    /sidecar process died/,
  );
});

// Q5 lazy-init — concurrent first calls share one in-flight start; spawn is
// invoked exactly once. The singleton promise in `resolveBaseUrl` is the
// race guard; if it broke we'd see two spawn calls and two healthz polls.
test("resolveBaseUrl lazy-init — concurrent first calls share one start (no double-spawn)", async () => {
  let spawnCount = 0;
  let healthzCount = 0;
  const fakeFetch = fetchReturning(async () => {
    healthzCount += 1;
    return { ok: true, status: 200 };
  });
  const fakeChild = new FakeChild();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    stateDirOverride: "/tmp/oc-test-lazy-concurrent",
    fetch: fakeFetch,
    spawn: ((cmd: string, args: unknown, opts: unknown) => {
      void cmd;
      void args;
      void opts;
      spawnCount += 1;
      return fakeChild as never;
    }) as never,
  });

  // Fire three concurrent resolveBaseUrl calls before any can settle. The
  // first triggers lazy init; the next two await the same promise.
  const [a, b, c] = await Promise.all([
    lc.resolveBaseUrl(),
    lc.resolveBaseUrl(),
    lc.resolveBaseUrl(),
  ]);

  assert.equal(spawnCount, 1, "spawn must fire exactly once across concurrent first calls");
  assert.equal(healthzCount, 1, "healthz polling must fire exactly once");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /^http:\/\/127\.0\.0\.1:\d+$/);
});

// Spawn-mode detach (post-V1.3) — `child.unref()` is called so Node.js
// doesn't keep the parent's event loop alive waiting for the long-running
// uvicorn child to exit. Without this, `--local` mode hangs post-turn
// because services.stop never fires to SIGTERM the child.
test("spawn-mode start — child.unref() called; process.exit handler registered", async () => {
  const fakeChild = new FakeChild();
  const exitListenerCountBefore = process.listenerCount("exit");
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    stateDirOverride: "/tmp/oc-test-unref",
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });

  await lc.start({});
  assert.equal(fakeChild.unrefCount, 1, "child.unref() must fire once after spawn");
  assert.equal(
    process.listenerCount("exit"),
    exitListenerCountBefore + 1,
    "spawn-mode start must register a process.on('exit') handler",
  );

  // Teardown via stop() must remove the exit listener so test isolation
  // doesn't accumulate listeners (Node warns at 10+).
  await lc.stop(undefined, {});
  assert.equal(
    process.listenerCount("exit"),
    exitListenerCountBefore,
    "stop() must remove the exit handler it registered",
  );
});

// Q5 lazy-init — explicit start() (e.g. SDK gateway path firing
// startPluginServices) suppresses the lazy path on subsequent calls. This is
// the "we still work in non-local mode too" guarantee.
test("resolveBaseUrl lazy-init — explicit start() short-circuits subsequent lazy path", async () => {
  let spawnCount = 0;
  const fakeFetch = fetchReturning(async () => ({ ok: true, status: 200 }));
  const fakeChild = new FakeChild();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    stateDirOverride: "/tmp/oc-test-explicit-start",
    fetch: fakeFetch,
    spawn: (() => {
      spawnCount += 1;
      return fakeChild as never;
    }) as never,
  });

  await lc.start({}); // gateway path
  assert.equal(spawnCount, 1);

  // Two subsequent calls — neither should trigger another start.
  await lc.resolveBaseUrl();
  await lc.resolveBaseUrl();
  assert.equal(spawnCount, 1, "explicit-start path must suppress lazy re-start");
});

// Q6 — teardown sequence: save → SIGTERM → child exits cleanly
test("teardown — save called first, then SIGTERM; clean child exits within window", async () => {
  const fakeChild = new FakeChild();
  fakeChild.exitOnSigterm = true;
  let saveCallCount = 0;
  let saveCalledAt: number | undefined;
  let sigtermAt: number | undefined;

  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    saveTimeoutMs: 1_000,
    sigtermTimeoutMs: 100,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });

  const originalKill = fakeChild.kill.bind(fakeChild);
  fakeChild.kill = (sig: NodeJS.Signals | number = "SIGTERM") => {
    if (sig === "SIGTERM") sigtermAt = Date.now();
    return originalKill(sig);
  };

  await lc.stop(
    {
      save: async () => {
        saveCallCount++;
        saveCalledAt = Date.now();
        return { saved: true };
      },
    },
    {},
  );

  assert.equal(saveCallCount, 1, "save called exactly once");
  assert.ok(
    saveCalledAt !== undefined && sigtermAt !== undefined,
    "both timestamps captured",
  );
  assert.ok(
    saveCalledAt! <= sigtermAt!,
    "save must precede SIGTERM",
  );
  assert.ok(fakeChild.killSignals.includes("SIGTERM"));
  assert.equal(
    fakeChild.killSignals.includes("SIGKILL"),
    false,
    "SIGKILL not needed when child exits cleanly",
  );
});

// Q6 — teardown SIGKILL fallback
test("teardown SIGKILL fallback when child ignores SIGTERM", async () => {
  const fakeChild = new FakeChild();
  fakeChild.exitOnSigterm = false; // child won't honour SIGTERM
  const logger = makeLogger();
  const lc = new LifecycleManager(makeConfig(), logger, {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    saveTimeoutMs: 1_000,
    sigtermTimeoutMs: 50,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });
  await lc.stop(undefined, {});

  assert.ok(fakeChild.killSignals.includes("SIGTERM"));
  assert.ok(
    fakeChild.killSignals.includes("SIGKILL"),
    "SIGKILL must fire when SIGTERM-then-wait times out",
  );
  assert.equal(
    logger.warns.some((m) => /SIGKILL/.test(m)),
    true,
    "SIGKILL escalation warns",
  );
});

// Q6 — teardown skip-if-dead
test("teardown skip-if-dead — save not called, no SIGTERM", async () => {
  const fakeChild = new FakeChild();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });
  fakeChild.emitExit(1, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(lc.isDead, true);

  let saveCalls = 0;
  await lc.stop(
    {
      save: async () => {
        saveCalls++;
        return { saved: true };
      },
    },
    {},
  );

  assert.equal(saveCalls, 0, "save not attempted when dead");
  // No additional kill signal after the natural exit.
  assert.equal(
    fakeChild.killSignals.length,
    0,
    "no SIGTERM/SIGKILL after natural exit",
  );
});

// Bug-fix: attach-mode stop is a no-op kill-wise (we don't own that process)
test("attach mode teardown — save called; no SIGTERM (we didn't spawn)", async () => {
  let saveCalls = 0;
  const fakeFetch = fetchReturning(async () => ({ ok: true, status: 200 }));
  const lc = new LifecycleManager(
    makeConfig({ sidecarUrl: "http://attach.test:1234" }),
    makeLogger(),
    {
      attachTimeoutMs: 1_000,
      pollIntervalMs: 10,
      fetch: fakeFetch,
      spawn: (() => {
        throw new Error("must not spawn");
      }) as never,
    },
  );
  await lc.start({});
  await lc.stop(
    {
      save: async () => {
        saveCalls++;
        return { saved: true };
      },
    },
    {},
  );
  assert.equal(saveCalls, 1, "save called exactly once in attach teardown");
});

// Shared-message contract for tools/hooks
test("SIDECAR_DEAD_MESSAGE matches the canonical 6c.10a Q4 string", () => {
  assert.equal(
    SIDECAR_DEAD_MESSAGE,
    "openclaw-memgpt: sidecar process died; restart OpenClaw to recover",
  );
});

// §6.2 — lifecycle event emission + sink activation
test("spawn success: activates the sink (state dir) and emits sidecar_spawned", async () => {
  const fakeChild = new FakeChild();
  const emitter = makeFakeEmitter();
  const lc = new LifecycleManager(makeConfig({ namespace: "ns-life" }), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    sidecarDir: "/tmp/fake-sidecar",
    stateDirOverride: "/tmp/oc-state",
    emitter,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });

  await lc.start({});

  assert.deepEqual(emitter.activatedWith, ["/tmp/oc-state"]);
  const spawned = emitter.events.find((e) => e.kind === "sidecar_spawned");
  assert.ok(spawned, "sidecar_spawned must be emitted on successful spawn");
  assert.equal(spawned!.namespace, "ns-life");
  assert.equal(typeof spawned!.meta?.port, "number");
});

test("crash after start: child exit emits sidecar_exited with code/signal", async () => {
  const fakeChild = new FakeChild();
  const emitter = makeFakeEmitter();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    sidecarDir: "/tmp/fake-sidecar",
    stateDirOverride: "/tmp/oc-state",
    emitter,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });

  await lc.start({});
  // Simulate an unexpected crash (not a teardown SIGTERM).
  fakeChild.emitExit(1, null);

  assert.equal(lc.isDead, true);
  const exited = emitter.events.find((e) => e.kind === "sidecar_exited");
  assert.ok(exited, "sidecar_exited must be emitted on unexpected child exit");
  assert.equal(exited!.meta?.code, 1);
  assert.equal(exited!.meta?.signal, "none");
});

test("spawn healthz timeout emits health_failed", async () => {
  const fakeChild = new FakeChild();
  fakeChild.exitOnSigterm = true;
  const emitter = makeFakeEmitter();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 60,
    pollIntervalMs: 10,
    sidecarDir: "/tmp/fake-sidecar",
    stateDirOverride: "/tmp/oc-state",
    emitter,
    fetch: fetchReturning(async () => ({ ok: false, status: 503 })),
    spawn: spawnReturning(fakeChild) as never,
  });

  await assert.rejects(() => lc.start({}), /did not become ready/);
  const failed = emitter.events.find((e) => e.kind === "health_failed");
  assert.ok(failed, "health_failed must be emitted on spawn healthz timeout");
  assert.equal(failed!.meta?.mode, "spawn");
});

test("spawn error (uv ENOENT) fails fast — does not wait the healthz timeout", async () => {
  const fakeChild = new FakeChild();
  const emitter = makeFakeEmitter();
  let fetchCalls = 0;
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 30_000, // large: a regression (waiting it out) makes this test slow + fail the timing assert
    pollIntervalMs: 20,
    sidecarDir: "/tmp/fake-sidecar",
    stateDirOverride: "/tmp/oc-state",
    emitter,
    // healthz never succeeds, so without fast-fail start() would poll for 30s
    fetch: fetchReturning(async () => {
      fetchCalls += 1;
      throw new Error("ECONNREFUSED");
    }),
    spawn: spawnReturning(fakeChild) as never,
  });

  const t0 = Date.now();
  const startP = lc.start({});
  // emit the async ENOENT spawn error just after start begins polling
  setImmediate(() =>
    fakeChild.emitError(
      Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }),
    ),
  );
  await assert.rejects(startP, /uv installed and on PATH/);
  assert.ok(
    Date.now() - t0 < 3_000,
    "must fail fast on ENOENT, not wait the 30s healthz timeout",
  );
  assert.equal(lc.isDead, true);
  assert.ok(
    emitter.events.some((e) => e.kind === "health_failed"),
    "health_failed emitted on spawn error",
  );

  // The losing pollHealthz must be aborted: no further healthz fetches after
  // start() rejects (otherwise it keeps polling + logging for the full timeout).
  const callsAtFailure = fetchCalls;
  await new Promise((r) => setTimeout(r, 100)); // several poll intervals
  assert.equal(
    fetchCalls,
    callsAtFailure,
    "pollHealthz must stop after fast-fail (race loser aborted)",
  );
});

// ── §6d.6 config gate ────────────────────────────────────────────────────────

test("config gate: isConfigured reflects provider + credential presence", () => {
  const configured = new LifecycleManager(makeConfig(), makeLogger());
  assert.equal(configured.isConfigured, true);
  const noProvider = new LifecycleManager(
    makeConfig({ provider: undefined }),
    makeLogger(),
  );
  assert.equal(noProvider.isConfigured, false);
  const noCred = new LifecycleManager(
    makeConfig({ credential: undefined }),
    makeLogger(),
  );
  assert.equal(noCred.isConfigured, false);
});

test("config gate: start() skips spawn entirely when unconfigured", async () => {
  let spawnCalls = 0;
  const lc = new LifecycleManager(
    makeConfig({ provider: undefined, credential: undefined }),
    makeLogger(),
    {
      spawn: ((..._args: unknown[]) => {
        spawnCalls += 1;
        return new FakeChild();
      }) as never,
      createServer: (() => {
        throw new Error("pickFreePort must not run when unconfigured");
      }) as never,
    },
  );
  await lc.start({}); // must resolve without throwing and without spawning
  assert.equal(spawnCalls, 0, "spawn must not be called when unconfigured");
  assert.equal(lc.isStarted, false, "start() leaves started=false when unconfigured");
});

test("config gate: resolveBaseUrl throws NOT_CONFIGURED when unconfigured", async () => {
  const lc = new LifecycleManager(
    makeConfig({ provider: undefined, credential: undefined }),
    makeLogger(),
    {
      spawn: (() => {
        throw new Error("must not spawn");
      }) as never,
    },
  );
  await assert.rejects(
    () => lc.resolveBaseUrl(),
    new RegExp(NOT_CONFIGURED_MESSAGE.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")),
  );
});

// §6d.6 — sidecar venv relocated out of the plugin dir (install-scan bloat fix)

test("spawn env: UV_PROJECT_ENVIRONMENT points under the state dir, not the plugin dir", async () => {
  const fakeChild = new FakeChild();
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 500,
    pollIntervalMs: 10,
    sidecarDir: "/plugin/sidecar",
    stateDirOverride: "/state",
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts?.env;
      return fakeChild;
    }) as never,
  });

  await lc.start({});
  assert.equal(capturedEnv?.UV_PROJECT_ENVIRONMENT, "/state/memgpt-sidecar-venv");
  assert.ok(
    !capturedEnv?.UV_PROJECT_ENVIRONMENT?.includes("/plugin/sidecar"),
    "venv must not live under the plugin/sidecar dir",
  );
});

// §6d.7 — sidecar dir must resolve from ANY entry depth (regression: the bundled
// `dist/index.js` entry overshot the old fixed `../..`, yielding a non-existent
// cwd → `spawn uv ENOENT`).

test("findSidecarDir: resolves the plugin's sidecar from source, bundled, and root entries", () => {
  const root = "/plugins/openclaw-memgpt";
  const exists = (p: string) => p === `${root}/sidecar/main.py`;
  // bundled compiled entry → dist/ (the case that broke with a fixed ../..)
  assert.equal(findSidecarDir(`${root}/dist`, exists), `${root}/sidecar`);
  // source entry → src/lifecycle/
  assert.equal(findSidecarDir(`${root}/src/lifecycle`, exists), `${root}/sidecar`);
  // packaged install root entry
  assert.equal(findSidecarDir(root, exists), `${root}/sidecar`);
});

test("findSidecarDir: falls back to climb-two when no marker is found", () => {
  assert.equal(findSidecarDir("/a/b/src/lifecycle", () => false), "/a/b/sidecar");
});

// ── Shape A: idempotent start/stop + process-singleton registry ──────────────
//
// OpenClaw calls register() multiple times in one process; each call registers
// a memgpt-sidecar service, so the SDK service runner can invoke start (and
// stop) N times. With a fresh LifecycleManager per register() this spawned N
// sidecars and the before_prompt_build hook's :ensure landed on a different
// sidecar than the tool call → "Agent not resident". These tests pin the fix:
// start/stop are idempotent, and getOrCreateLifecycle shares ONE manager (hence
// one sidecar) per namespace so every per-registration client resolves to it.

test("start() is idempotent — N explicit starts spawn once (service-runner calls collapse)", async () => {
  let spawnCount = 0;
  let healthzCount = 0;
  const fakeChild = new FakeChild();
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    stateDirOverride: "/tmp/oc-test-idempotent-start",
    fetch: fetchReturning(async () => {
      healthzCount += 1;
      return { ok: true, status: 200 };
    }),
    spawn: (() => {
      spawnCount += 1;
      return fakeChild as never;
    }) as never,
  });

  // Sequential repeats (SDK awaits each service.start in turn) …
  await lc.start({});
  await lc.start({});
  // … and concurrent repeats (defensive — interleaved registrations).
  await Promise.all([lc.start({}), lc.start({})]);

  assert.equal(spawnCount, 1, "spawn must fire exactly once across N starts");
  assert.equal(healthzCount, 1, "healthz must poll exactly once across N starts");
  await lc.stop(undefined, {});
});

test("stop() is idempotent — N stops save + SIGTERM exactly once", async () => {
  const fakeChild = new FakeChild();
  fakeChild.exitOnSigterm = true;
  let saveCount = 0;
  const client = {
    save: async () => {
      saveCount += 1;
    },
  };
  const lc = new LifecycleManager(makeConfig(), makeLogger(), {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    sigtermTimeoutMs: 100,
    saveTimeoutMs: 1_000,
    stateDirOverride: "/tmp/oc-test-idempotent-stop",
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });

  await lc.start({});
  // Three stops (reverse-order service teardown, one per registration).
  await Promise.all([
    lc.stop(client, {}),
    lc.stop(client, {}),
    lc.stop(client, {}),
  ]);

  assert.equal(saveCount, 1, "final save must run exactly once");
  assert.equal(
    fakeChild.killSignals.filter((s) => s === "SIGTERM").length,
    1,
    "SIGTERM must be sent exactly once",
  );
});

test("getOrCreateLifecycle: same namespace → same instance; different namespace → distinct", () => {
  _resetLifecycleRegistry();
  const logger = makeLogger();
  const a1 = getOrCreateLifecycle(makeConfig({ namespace: "alpha" }), logger);
  const a2 = getOrCreateLifecycle(makeConfig({ namespace: "alpha" }), logger);
  const b1 = getOrCreateLifecycle(makeConfig({ namespace: "beta" }), logger);
  assert.equal(a1, a2, "same namespace must return the same manager");
  assert.notEqual(a1, b1, "different namespace must return a distinct manager");
  _resetLifecycleRegistry();
});

// Fix 2 — the singleton's emitter is the FIRST registration's (the one whose
// JSONL sink gets activated in start). Later registrations construct their own
// emitter, but `lifecycle.emitter` (which index.ts routes all deps through)
// stays the first — so every hook's events reach the one activated sink, and
// the JSONL record is complete under multi-register.
test("getOrCreateLifecycle: emitter is shared (first registration's), not per-call", () => {
  _resetLifecycleRegistry();
  const e1 = makeFakeEmitter();
  const e2 = makeFakeEmitter();
  const lc1 = getOrCreateLifecycle(makeConfig({ namespace: "shared" }), makeLogger(), { emitter: e1 });
  const lc2 = getOrCreateLifecycle(makeConfig({ namespace: "shared" }), makeLogger(), { emitter: e2 });
  assert.equal(lc1, lc2, "same manager");
  assert.equal(lc1.emitter, e1, "shared manager keeps the first emitter");
  assert.equal(
    lc2.emitter, e1,
    "a later registration must see the first (activated) emitter, not its own e2",
  );
  _resetLifecycleRegistry();
});

test("multi-register: two registrations share one sidecar — agent resident for both", async () => {
  // Models the real failure: register() fires twice, each builds its own client
  // but both go through getOrCreateLifecycle. With the singleton, both clients
  // resolve to the SAME spawned sidecar URL and only one sidecar is spawned, so
  // an :ensure on one client makes the agent resident for the other's tool call.
  _resetLifecycleRegistry();
  let spawnCount = 0;
  const fakeChild = new FakeChild();
  const sharedOpts = {
    spawnTimeoutMs: 1_000,
    pollIntervalMs: 10,
    stateDirOverride: "/tmp/oc-test-multi-register",
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: (() => {
      spawnCount += 1;
      return fakeChild as never;
    }) as never,
  };

  // register() call #1 and #2 — same namespace, same process.
  const lcHook = getOrCreateLifecycle(makeConfig(), makeLogger(), sharedOpts);
  const lcTool = getOrCreateLifecycle(makeConfig(), makeLogger(), sharedOpts);
  assert.equal(lcHook, lcTool, "both registrations must share one manager");

  // Per-registration clients close over their registration's resolver. They
  // must agree on the URL (so residency is shared) — this is what was broken.
  const hookUrl = await lcHook.resolveBaseUrl();
  const toolUrl = await lcTool.resolveBaseUrl();
  assert.equal(hookUrl, toolUrl, "hook and tool must resolve to the same sidecar");
  assert.equal(spawnCount, 1, "exactly one sidecar spawned across both registrations");

  await lcHook.stop(undefined, {});
  _resetLifecycleRegistry();
});
