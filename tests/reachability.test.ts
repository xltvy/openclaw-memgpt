/**
 * Reachability helper tests (§6d.6). Connection-level semantics: any resolved
 * HTTP response = reachable; a thrown/aborted fetch = unreachable. Plus the
 * localhost classifier used for the "start your local server" hint.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isEndpointReachable, isLocalUrl } from "../src/reachability.ts";

test("isEndpointReachable: any HTTP response (incl. 401/404) → reachable", async () => {
  const ok = await isEndpointReachable("http://x/v1", {
    fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(ok, true);
});

test("isEndpointReachable: connection error (throw) → unreachable", async () => {
  const ok = await isEndpointReachable("http://127.0.0.1:4000/v1", {
    fetch: (async () => {
      throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch,
  });
  assert.equal(ok, false);
});

test("isEndpointReachable: timeout (abort) → unreachable", async () => {
  // fetch that never responds but honours the abort signal
  const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as unknown as typeof fetch;
  const t0 = Date.now();
  const ok = await isEndpointReachable("http://slow/v1", {
    fetch: hangingFetch,
    timeoutMs: 30,
  });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 1000, "must give up at the timeout, not hang");
});

test("isLocalUrl: loopback / .local → true; public → false", () => {
  assert.equal(isLocalUrl("http://127.0.0.1:4000/v1"), true);
  assert.equal(isLocalUrl("http://localhost:8765"), true);
  assert.equal(isLocalUrl("http://[::1]:4000/v1"), true);
  assert.equal(isLocalUrl("http://my-box.local/v1"), true);
  assert.equal(isLocalUrl("https://api.anthropic.com/v1"), false);
  assert.equal(isLocalUrl("https://openrouter.ai/api/v1"), false);
  assert.equal(isLocalUrl("not a url"), false);
});
