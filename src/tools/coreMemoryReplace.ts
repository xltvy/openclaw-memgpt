/**
 * core_memory_replace handler — §3.6 thin wrapper around SidecarClient.
 *
 * Same shape as coreMemoryAppend (§3.6 uniformity): empty content array on
 * success; CoreMemoryError → verbatim .message; other errors bubble. The 409
 * codes here are typically `core_memory_content_not_found` (old_content
 * didn't match) or `core_memory_overflow`; both surface unmodified.
 */

import { CoreMemoryError } from "../client/errors.ts";
import type { CoreMemoryName } from "../client/types.ts";
import { toolGuard, type ToolDeps, type ToolHandler } from "./deps.ts";

export const coreMemoryReplace =
  (deps: ToolDeps): ToolHandler =>
  async (_toolCallId, params) => {
    const blocked = toolGuard(deps);
    if (blocked) return blocked;
    const name = params.name as CoreMemoryName;
    const oldContent = String(params.old_content ?? "");
    const newContent = String(params.new_content ?? "");
    try {
      await deps.client.coreMemoryReplace(name, oldContent, newContent);
      deps.emit({
        kind: "core_memory_replace",
        namespace: deps.namespace,
        meta: { name },
        content: { text: newContent },
      });
      return { content: [] };
    } catch (err) {
      if (err instanceof CoreMemoryError) {
        return { content: [{ type: "text", text: err.message }] };
      }
      throw err;
    }
  };
