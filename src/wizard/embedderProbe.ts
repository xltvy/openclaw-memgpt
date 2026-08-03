/**
 * Embedding-endpoint dimension probe for the install wizard.
 *
 * Embeds one short input against the configured OpenAI-compatible endpoint and
 * returns the vector length — the value the sidecar needs as EMBEDDING_DIM. A
 * wrong dim is the sharpest configuration footgun (silent until the vector
 * store misbehaves), so the wizard measures it instead of asking the user to
 * know it; on any failure (endpoint down, model absent, auth-gated, non-spec
 * response) it returns undefined and the wizard falls back to a manual prompt.
 *
 * Keyless by design ("Bearer ollama" placeholder): local servers dominate this
 * path and ignore the header; an auth-gated endpoint (e.g. LiteLLM master key)
 * fails the probe and takes the manual-dim path, which still works.
 */

export interface ProbeDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** POST <endpoint>/embeddings and measure data[0].embedding.length. */
export async function probeEmbeddingDim(
  endpointUrl: string,
  model: string,
  deps: ProbeDeps = {},
): Promise<number | undefined> {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  // Generous default: Ollama loads the model on first use, which can take
  // several seconds on its own.
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const url = `${endpointUrl.replace(/\/+$/, "")}/embeddings`;
  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama",
      },
      body: JSON.stringify({ model, input: ["dimension probe"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const payload = (await resp.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return undefined;
    return embedding.length;
  } catch {
    return undefined;
  }
}
