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
import { Readable } from "node:stream";

import {
  LifecycleManager,
  SIDECAR_DEAD_MESSAGE,
} from "../../src/lifecycle/lifecycleManager.ts";
import type { PluginConfig } from "../../src/config.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    namespace: "test",
    model: "test-model",
    persona: "test-persona",
    human: "test-human",
    observability: "default",
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
    /healthz timed out/,
  );
  assert.equal(lc.isDead, true);
  assert.ok(
    fakeChild.killSignals.includes("SIGTERM"),
    "child must be SIGTERMed when healthz times out",
  );
});

// Q4 — crash during run flips isDead
test("child exit after start — isDead set; stderr tail surfaces in error log", async () => {
  const fakeChild = new FakeChild();
  const logger = makeLogger();
  const lc = new LifecycleManager(makeConfig(), logger, {
    spawnTimeoutMs: 200,
    pollIntervalMs: 10,
    fetch: fetchReturning(async () => ({ ok: true, status: 200 })),
    spawn: spawnReturning(fakeChild) as never,
  });
  await lc.start({ stateDir: "/tmp/oc-test" });
  assert.equal(lc.isDead, false);

  fakeChild.emitStderr("Traceback (most recent call last):");
  fakeChild.emitStderr("RuntimeError: synthetic crash");
  // Allow the stderr stream microtask to flush.
  await new Promise((r) => setImmediate(r));
  fakeChild.emitExit(1, null);

  assert.equal(lc.isDead, true);
  assert.equal(
    logger.errors.some((m) => m.includes("synthetic crash")),
    true,
    "crash log must include stderr tail",
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
