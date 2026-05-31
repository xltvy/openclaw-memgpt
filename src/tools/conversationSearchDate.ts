/**
 * conversation_search_date handler — §3.6 thin wrapper around SidecarClient.
 *
 * Same name-bridge as conversationSearch: LLM-facing `conversation_search_date`,
 * client method `recallSearchDate`. Params `start_date` / `end_date` are
 * snake_case at the LLM boundary (matches gpt_functions.py schema verbatim)
 * and converted to camelCase here for the client method.
 */

import type { ToolDeps, ToolHandler } from "./deps.ts";

export const conversationSearchDate =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    const startDate = String(params.start_date ?? "");
    const endDate = String(params.end_date ?? "");
    const page = typeof params.page === "number" ? params.page : 0;
    const r = await deps.client.recallSearchDate({ startDate, endDate, page });
    deps.emit({
      kind: "conversation_search_date",
      namespace: deps.namespace,
      meta: { total: r.total, page, numPages: r.numPages },
    });
    return { content: [{ type: "text", text: r.formatted }] };
  };
