/**
 * Connection-level reachability check for the configured LLM endpoint (§6d.6).
 *
 * Used by the wizard (warn at setup) and by LifecycleManager (warn at sidecar
 * startup) so an unreachable endpoint — a local server like LiteLLM/Ollama not
 * started, or a typo'd URL — is surfaced with an actionable hint rather than
 * only failing later when the sidecar makes its first LLM call (summarisation).
 *
 * "Reachable" = the URL returns ANY HTTP response (including 401/404 — the
 * endpoint is up, just unauthenticated or has no route at that path). Only a
 * connection-level failure (refused / timeout / DNS) counts as unreachable.
 * This cleanly separates "endpoint not running" from "endpoint up but needs a
 * key", so we never false-warn on a healthy authenticated endpoint.
 */

export interface ReachabilityOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Resolves true if `url` returns any HTTP response; false on a network-level
 *  failure or timeout. Never throws. */
export async function isEndpointReachable(
  url: string,
  opts: ReachabilityOptions = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Any resolved response (even 4xx/5xx) means the host answered → reachable.
    await doFetch(url, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    // Thrown = connection refused / DNS / TLS / abort(timeout) → unreachable.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** True for loopback / *.local hosts, so callers can give a "start your local
 *  server" hint rather than a generic "check the URL". */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}
