/**
 * conversation_search handler — §3.6 thin wrapper around SidecarClient.
 *
 * §3.6 name-bridge: the LLM-facing tool name is `conversation_search`; the
 * sidecar endpoint and client method are `recall:search` / `recallSearch`.
 * The handler is the bridge — same operation, different name on each side
 * (architecture name vs LLM-facing name).
 *
 * `total` here is the *true grand total* per §2.6 (recall paginates correctly,
 * unlike archival which returns page-local). Emitted under meta so the
 * detection-rate metric doesn't conflate the two semantics.
 */

import { SIDECAR_DEAD_MESSAGE } from "../lifecycle/lifecycleManager.ts";
import type { ToolDeps, ToolHandler } from "./deps.ts";

export const conversationSearch =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    if (deps.lifecycle?.isDead) {
      return { content: [{ type: "text", text: SIDECAR_DEAD_MESSAGE }] };
    }
    const query = String(params.query ?? "");
    const page = typeof params.page === "number" ? params.page : 0;
    const r = await deps.client.recallSearch(query, page);
    deps.emit({
      kind: "conversation_search",
      namespace: deps.namespace,
      meta: { total: r.total, page, numPages: r.numPages },
    });
    return { content: [{ type: "text", text: r.formatted }] };
  };
