/**
 * Tool registration entrypoint — wires the seven tool schemas to their
 * handlers via `api.registerTool`. Called from `src/index.ts`'s plugin
 * `register(api)` after the ToolDeps bag is constructed.
 *
 * The combination `{...schema, execute}` happens here so the schemas file
 * stays a pure data export and the handler files stay focussed on the
 * tool-call wire. The Mem0 reference uses the same per-tool pattern; the
 * uniformity matters because the descriptions are verbatim from
 * gpt_functions.py and the LLM is trained against the name/description/
 * params triple as a unit.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { archivalInsert } from "./archivalInsert.ts";
import { archivalSearch } from "./archivalSearch.ts";
import { conversationSearch } from "./conversationSearch.ts";
import { conversationSearchDate } from "./conversationSearchDate.ts";
import { coreMemoryAppend } from "./coreMemoryAppend.ts";
import { coreMemoryReplace } from "./coreMemoryReplace.ts";
import { sendMessage } from "./sendMessage.ts";
import {
  ARCHIVAL_MEMORY_INSERT_SCHEMA,
  ARCHIVAL_MEMORY_SEARCH_SCHEMA,
  CONVERSATION_SEARCH_DATE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CORE_MEMORY_APPEND_SCHEMA,
  CORE_MEMORY_REPLACE_SCHEMA,
  SEND_MESSAGE_SCHEMA,
} from "./schemas.ts";
import type { ToolDeps } from "./deps.ts";

export function registerTools(
  api: OpenClawPluginApi,
  deps: ToolDeps,
): void {
  api.registerTool({
    ...CORE_MEMORY_APPEND_SCHEMA,
    execute: coreMemoryAppend(deps),
  });
  api.registerTool({
    ...CORE_MEMORY_REPLACE_SCHEMA,
    execute: coreMemoryReplace(deps),
  });
  api.registerTool({
    ...ARCHIVAL_MEMORY_INSERT_SCHEMA,
    execute: archivalInsert(deps),
  });
  api.registerTool({
    ...ARCHIVAL_MEMORY_SEARCH_SCHEMA,
    execute: archivalSearch(deps),
  });
  api.registerTool({
    ...CONVERSATION_SEARCH_SCHEMA,
    execute: conversationSearch(deps),
  });
  api.registerTool({
    ...CONVERSATION_SEARCH_DATE_SCHEMA,
    execute: conversationSearchDate(deps),
  });
  api.registerTool({
    ...SEND_MESSAGE_SCHEMA,
    execute: sendMessage(deps),
  });
}
