/**
 * core_memory_append handler — §3.6 thin wrapper around SidecarClient.
 *
 * - Calls coreMemoryAppend(name, content); returns empty content array on
 *   success (sidecar's underlying pymemgpt method returns None — no LLM-
 *   facing string, so the handler does not fabricate one).
 * - CoreMemoryError (§2.9) → returns the pymemgpt verbatim .message as the
 *   tool-result text so the LLM sees the exact training string ("Edit failed:
 *   ... Exceeds 2000 character limit ...").
 * - Other errors bubble (transport failure, malformed param) — the harness
 *   surfaces them as tool execution failures rather than silently masking.
 */

import { CoreMemoryError } from "../client/errors.ts";
import type { CoreMemoryName } from "../client/types.ts";
import { toolGuard, type ToolDeps, type ToolHandler } from "./deps.ts";

export const coreMemoryAppend =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    const blocked = toolGuard(deps);
    if (blocked) return blocked;
    const name = params.name as CoreMemoryName;
    const content = String(params.content ?? "");
    try {
      await deps.client.coreMemoryAppend(name, content);
      deps.emit({
        kind: "core_memory_append",
        namespace: deps.namespace,
        meta: { name },
        content: { text: content },
      });
      return { content: [] };
    } catch (err) {
      if (err instanceof CoreMemoryError) {
        return { content: [{ type: "text", text: err.message }] };
      }
      throw err;
    }
  };
