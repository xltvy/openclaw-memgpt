/**
 * archival_memory_search handler — §3.6 representative.
 *
 * Returns the sidecar's `formatted` verbatim (the §2.5 LLM-facing string,
 * "Showing N of M results (page p/0): [...]" or "No results found."). The
 * §2.5 page-local `total` semantic is faithful — emitted under `meta.total`
 * so the detection-rate metric can interpret it correctly per §2.6's
 * archival/recall asymmetry note.
 *
 * No CoreMemoryError branch — archival search doesn't produce 409s; transport
 * failures bubble.
 */

import { SIDECAR_DEAD_MESSAGE } from "../lifecycle/lifecycleManager.ts";
import type { ToolDeps, ToolHandler } from "./deps.ts";

export const archivalSearch =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    if (deps.lifecycle?.isDead) {
      return { content: [{ type: "text", text: SIDECAR_DEAD_MESSAGE }] };
    }
    const query = String(params.query ?? "");
    const page = typeof params.page === "number" ? params.page : 0;
    const r = await deps.client.archivalSearch(query, page);
    deps.emit({
      kind: "archival_search",
      namespace: deps.namespace,
      meta: { total: r.total, page, numPages: r.numPages },
      content: { query, results: r.results },
    });
    return { content: [{ type: "text", text: r.formatted }] };
  };
