/**
 * probeEmbeddingDim unit tests — fake fetch, no network. The probe measures
 * the vector length from a live /embeddings call and returns undefined on any
 * failure (the wizard then falls back to a manual dim prompt).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { probeEmbeddingDim } from "../../src/wizard/embedderProbe.ts";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Partial<Response>>,
): typeof fetch {
  return (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

test("probe: measures the embedding length from a spec-shaped response", async () => {
  let captured: { url?: string; body?: unknown } = {};
  const dim = await probeEmbeddingDim("http://127.0.0.1:11434/v1/", "nomic-embed-text", {
    fetch: fakeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return {
        ok: true,
        json: async () => ({
          data: [{ index: 0, embedding: new Array(768).fill(0.1) }],
        }),
      } as Partial<Response>;
    }),
  });
  assert.equal(dim, 768);
  // Trailing slash must not double up; payload is the OpenAI embeddings shape.
  assert.equal(captured.url, "http://127.0.0.1:11434/v1/embeddings");
  assert.deepEqual(captured.body, {
    model: "nomic-embed-text",
    input: ["dimension probe"],
  });
});

test("probe: non-OK response → undefined", async () => {
  const dim = await probeEmbeddingDim("http://127.0.0.1:11434/v1", "missing-model", {
    fetch: fakeFetch(async () => ({ ok: false, status: 404 }) as Partial<Response>),
  });
  assert.equal(dim, undefined);
});

test("probe: network error → undefined", async () => {
  const dim = await probeEmbeddingDim("http://127.0.0.1:1/v1", "m", {
    fetch: fakeFetch(async () => {
      throw new Error("ECONNREFUSED");
    }),
  });
  assert.equal(dim, undefined);
});

test("probe: malformed payload (no data[].embedding array) → undefined", async () => {
  const dim = await probeEmbeddingDim("http://127.0.0.1:11434/v1", "m", {
    fetch: fakeFetch(
      async () =>
        ({ ok: true, json: async () => ({ result: "nope" }) }) as Partial<Response>,
    ),
  });
  assert.equal(dim, undefined);
});
