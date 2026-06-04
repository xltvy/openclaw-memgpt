/**
 * Tool schemas — verbatim from memgpt-service/memgpt/prompts/gpt_functions.py
 * with the §3.6 adjustments:
 *
 *   1. `request_heartbeat` parameter dropped from every schema (OpenClaw chains
 *      by default; the per-call chain-vs-yield distinction is recovered at the
 *      tool-identity level per §4.3 — memory tools chain, send_message yields).
 *   2. The `recall_memory_search` / `conversation_search` duplicate pair is
 *      collapsed to one: the LLM-facing name is `conversation_search` per
 *      §3.6 ("tool name `conversation_search`, endpoint name `recall:search`,
 *      handler bridges"). Same for `recall_memory_search_date` /
 *      `conversation_search_date`.
 *   3. File / HTTP / chatgpt / pause_heartbeats tools dropped — outside the
 *      seven the plugin surfaces.
 *
 * Tool **descriptions** are reproduced byte-for-byte: in MemGPT the description
 * carries behavioural instruction (e.g. archival_memory_insert's "phrase the
 * memory contents such that it can be easily queried later"), not just calling
 * convention. The LLM was trained against these strings.
 *
 * The fork-source file is the authority — if it changes, tests/tools/
 * schemas.test.ts catches the drift via the verbatim assertions.
 */

/** JSON-schema-ish object for tool parameters — kept loose to mirror the source. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description: string }
    >;
    required: string[];
  };
}

// ── 1. core_memory_append ───────────────────────────────────────────────────

export const CORE_MEMORY_APPEND_SCHEMA: ToolSchema = {
  name: "core_memory_append",
  description: "Append to the contents of core memory.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Section of the memory to be edited (persona or human).",
      },
      content: {
        type: "string",
        description:
          "Content to write to the memory. All unicode (including emojis) are supported.",
      },
    },
    required: ["name", "content"],
  },
};

// ── 2. core_memory_replace ──────────────────────────────────────────────────

export const CORE_MEMORY_REPLACE_SCHEMA: ToolSchema = {
  name: "core_memory_replace",
  description:
    "Replace to the contents of core memory. To delete memories, use an empty string for new_content.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Section of the memory to be edited (persona or human).",
      },
      old_content: {
        type: "string",
        description: "String to replace. Must be an exact match.",
      },
      new_content: {
        type: "string",
        description:
          "Content to write to the memory. All unicode (including emojis) are supported.",
      },
    },
    required: ["name", "old_content", "new_content"],
  },
};

// ── 3. archival_memory_insert ───────────────────────────────────────────────

export const ARCHIVAL_MEMORY_INSERT_SCHEMA: ToolSchema = {
  name: "archival_memory_insert",
  description:
    "Add to archival memory. Make sure to phrase the memory contents such that it can be easily queried later.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "Content to write to the memory. All unicode (including emojis) are supported.",
      },
    },
    required: ["content"],
  },
};

// ── 4. archival_memory_search ───────────────────────────────────────────────

export const ARCHIVAL_MEMORY_SEARCH_SCHEMA: ToolSchema = {
  name: "archival_memory_search",
  description: "Search archival memory using semantic (embedding-based) search.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "String to search for.",
      },
      page: {
        type: "integer",
        description:
          "Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).",
      },
    },
    required: ["query", "page"],
  },
};

// ── 5. conversation_search ──────────────────────────────────────────────────

export const CONVERSATION_SEARCH_SCHEMA: ToolSchema = {
  name: "conversation_search",
  description:
    "Search prior conversation history using case-insensitive string matching.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "String to search for.",
      },
      page: {
        type: "integer",
        description:
          "Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).",
      },
    },
    required: ["query", "page"],
  },
};

// ── 6. conversation_search_date ─────────────────────────────────────────────

export const CONVERSATION_SEARCH_DATE_SCHEMA: ToolSchema = {
  name: "conversation_search_date",
  description: "Search prior conversation history using a date range.",
  parameters: {
    type: "object",
    properties: {
      start_date: {
        type: "string",
        description:
          "The start of the date range to search, in the format 'YYYY-MM-DD'.",
      },
      end_date: {
        type: "string",
        description:
          "The end of the date range to search, in the format 'YYYY-MM-DD'.",
      },
      page: {
        type: "integer",
        description:
          "Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).",
      },
    },
    required: ["start_date", "end_date", "page"],
  },
};

// ── 7. send_message ─────────────────────────────────────────────────────────

export const SEND_MESSAGE_SCHEMA: ToolSchema = {
  name: "send_message",
  description: "Sends a message to the human user",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "Message contents. All unicode (including emojis) are supported.",
      },
    },
    required: ["message"],
  },
};

// ── Combined index for the registration loop ───────────────────────────────

/** All seven schemas, in stable registration order. */
export const SCHEMAS: Record<string, ToolSchema> = {
  core_memory_append: CORE_MEMORY_APPEND_SCHEMA,
  core_memory_replace: CORE_MEMORY_REPLACE_SCHEMA,
  archival_memory_insert: ARCHIVAL_MEMORY_INSERT_SCHEMA,
  archival_memory_search: ARCHIVAL_MEMORY_SEARCH_SCHEMA,
  conversation_search: CONVERSATION_SEARCH_SCHEMA,
  conversation_search_date: CONVERSATION_SEARCH_DATE_SCHEMA,
  send_message: SEND_MESSAGE_SCHEMA,
};
