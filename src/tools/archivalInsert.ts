/**
 * archival_memory_insert handler — §3.6 thin wrapper around SidecarClient.
 *
 * Returns empty content on success (pymemgpt's Agent.archival_memory_insert
 * returns None — no LLM-facing string). archivalInsert does NOT raise 409s
 * in pymemgpt (no overflow / not-found conditions), so the CoreMemoryError
 * branch isn't applicable; unexpected errors bubble.
 *
 * The emitted MemoryEvent carries `passages` (chunks created) at the verbose
 * level — important for the detection-rate metric (§6.2 / 6d.3), since one
 * `content` insert may produce multiple passage entries.
 */

import { SIDECAR_DEAD_MESSAGE } from "../lifecycle/lifecycleManager.ts";
import type { ToolDeps, ToolHandler } from "./deps.ts";

export const archivalInsert =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    if (deps.lifecycle?.isDead) {
      return { content: [{ type: "text", text: SIDECAR_DEAD_MESSAGE }] };
    }
    const content = String(params.content ?? "");
    const r = await deps.client.archivalInsert(content);
    deps.emit({
      kind: "archival_insert",
      namespace: deps.namespace,
      meta: { passages: r.passages },
    });
    return { content: [] };
  };
