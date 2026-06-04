/**
 * Schemas verbatim from memgpt-service/memgpt/prompts/gpt_functions.py with
 * the §3.6 adjustments (request_heartbeat dropped, recall/conversation
 * duplicate collapsed to `conversation_search`, file/HTTP tools dropped).
 *
 * Verbatim assertions are the LLM-training-fidelity contract: the
 * description carries behavioural instruction (e.g. archival_memory_insert's
 * "phrase the memory contents such that it can be easily queried later"),
 * so any silent drift in the fork must surface here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVAL_MEMORY_INSERT_SCHEMA,
  ARCHIVAL_MEMORY_SEARCH_SCHEMA,
  CONVERSATION_SEARCH_DATE_SCHEMA,
  CONVERSATION_SEARCH_SCHEMA,
  CORE_MEMORY_APPEND_SCHEMA,
  CORE_MEMORY_REPLACE_SCHEMA,
  SCHEMAS,
  SEND_MESSAGE_SCHEMA,
} from "../../src/tools/schemas.ts";

// ── 1. SCHEMAS index has all seven keys, in the right registration order ───

test("SCHEMAS index contains exactly the seven tool names", () => {
  assert.deepEqual(Object.keys(SCHEMAS), [
    "core_memory_append",
    "core_memory_replace",
    "archival_memory_insert",
    "archival_memory_search",
    "conversation_search",
    "conversation_search_date",
    "send_message",
  ]);
});

// ── 2. core_memory_append — verbatim ───────────────────────────────────────

test("core_memory_append: name + description verbatim from gpt_functions.py", () => {
  assert.equal(CORE_MEMORY_APPEND_SCHEMA.name, "core_memory_append");
  assert.equal(
    CORE_MEMORY_APPEND_SCHEMA.description,
    "Append to the contents of core memory.",
  );
  assert.deepEqual(CORE_MEMORY_APPEND_SCHEMA.parameters.required, [
    "name",
    "content",
  ]);
  assert.ok(
    !("request_heartbeat" in CORE_MEMORY_APPEND_SCHEMA.parameters.properties),
    "request_heartbeat must be dropped per §3.6 adjustment 1",
  );
  assert.equal(
    CORE_MEMORY_APPEND_SCHEMA.parameters.properties.name.description,
    "Section of the memory to be edited (persona or human).",
  );
  assert.equal(
    CORE_MEMORY_APPEND_SCHEMA.parameters.properties.content.description,
    "Content to write to the memory. All unicode (including emojis) are supported.",
  );
});

// ── 3. core_memory_replace — verbatim ──────────────────────────────────────

test("core_memory_replace: name + description verbatim", () => {
  assert.equal(CORE_MEMORY_REPLACE_SCHEMA.name, "core_memory_replace");
  assert.equal(
    CORE_MEMORY_REPLACE_SCHEMA.description,
    "Replace to the contents of core memory. To delete memories, use an empty string for new_content.",
  );
  assert.deepEqual(CORE_MEMORY_REPLACE_SCHEMA.parameters.required, [
    "name",
    "old_content",
    "new_content",
  ]);
  assert.ok(
    !(
      "request_heartbeat" in CORE_MEMORY_REPLACE_SCHEMA.parameters.properties
    ),
    "request_heartbeat must be dropped",
  );
  assert.equal(
    CORE_MEMORY_REPLACE_SCHEMA.parameters.properties.old_content.description,
    "String to replace. Must be an exact match.",
  );
});

// ── 4. archival_memory_insert — verbatim ───────────────────────────────────

test("archival_memory_insert: behavioural-instruction description verbatim", () => {
  // The description carries a *behavioural* instruction ("phrase the memory
  // contents such that it can be easily queried later") — silent drift here
  // changes how the LLM frames archival inserts, hence the explicit check.
  assert.equal(ARCHIVAL_MEMORY_INSERT_SCHEMA.name, "archival_memory_insert");
  assert.equal(
    ARCHIVAL_MEMORY_INSERT_SCHEMA.description,
    "Add to archival memory. Make sure to phrase the memory contents such that it can be easily queried later.",
  );
  assert.deepEqual(ARCHIVAL_MEMORY_INSERT_SCHEMA.parameters.required, [
    "content",
  ]);
  assert.ok(
    !(
      "request_heartbeat" in ARCHIVAL_MEMORY_INSERT_SCHEMA.parameters.properties
    ),
    "request_heartbeat must be dropped",
  );
});

// ── 5. archival_memory_search — verbatim ───────────────────────────────────

test("archival_memory_search: name + description verbatim", () => {
  assert.equal(ARCHIVAL_MEMORY_SEARCH_SCHEMA.name, "archival_memory_search");
  assert.equal(
    ARCHIVAL_MEMORY_SEARCH_SCHEMA.description,
    "Search archival memory using semantic (embedding-based) search.",
  );
  assert.deepEqual(ARCHIVAL_MEMORY_SEARCH_SCHEMA.parameters.required, [
    "query",
    "page",
  ]);
  assert.equal(
    ARCHIVAL_MEMORY_SEARCH_SCHEMA.parameters.properties.page.description,
    "Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).",
  );
});

// ── 6. conversation_search — name-collapse verbatim ────────────────────────

test("conversation_search: §3.6 name-collapse — LLM-facing name is `conversation_search`", () => {
  // The duplicate recall_memory_search / conversation_search pair is collapsed
  // to one schema with the LLM-facing name `conversation_search` per §3.6;
  // the sidecar endpoint stays `recall:search` and the handler bridges. The
  // description is the conversation_search one ("case-insensitive string
  // matching"), not the recall_memory_search one ("using a string").
  assert.equal(CONVERSATION_SEARCH_SCHEMA.name, "conversation_search");
  assert.equal(
    CONVERSATION_SEARCH_SCHEMA.description,
    "Search prior conversation history using case-insensitive string matching.",
  );
});

// ── 7. conversation_search_date — name-collapse verbatim ───────────────────

test("conversation_search_date: name-collapse + YYYY-MM-DD param verbatim", () => {
  assert.equal(
    CONVERSATION_SEARCH_DATE_SCHEMA.name,
    "conversation_search_date",
  );
  assert.equal(
    CONVERSATION_SEARCH_DATE_SCHEMA.description,
    "Search prior conversation history using a date range.",
  );
  assert.deepEqual(CONVERSATION_SEARCH_DATE_SCHEMA.parameters.required, [
    "start_date",
    "end_date",
    "page",
  ]);
  assert.equal(
    CONVERSATION_SEARCH_DATE_SCHEMA.parameters.properties.start_date
      .description,
    "The start of the date range to search, in the format 'YYYY-MM-DD'.",
  );
});

// ── 8. send_message — verbatim ─────────────────────────────────────────────

test("send_message: name + description verbatim", () => {
  assert.equal(SEND_MESSAGE_SCHEMA.name, "send_message");
  // Note the verbatim string has no trailing period — matches gpt_functions.py
  // exactly. The intent-carrying brevity is what the LLM was trained against.
  assert.equal(
    SEND_MESSAGE_SCHEMA.description,
    "Sends a message to the human user",
  );
  assert.deepEqual(SEND_MESSAGE_SCHEMA.parameters.required, ["message"]);
});

// ── 9. negative — no excluded tools leak into SCHEMAS ──────────────────────

test("SCHEMAS excludes file / HTTP / chatgpt / pause_heartbeats tools per §3.6 adjustment 3", () => {
  const excluded = [
    "read_from_text_file",
    "append_to_text_file",
    "http_request",
    "message_chatgpt",
    "pause_heartbeats",
    // the un-collapsed duplicates also stay out of the index
    "recall_memory_search",
    "recall_memory_search_date",
  ];
  for (const name of excluded) {
    assert.ok(
      !(name in SCHEMAS),
      `${name} must not appear in SCHEMAS — file/HTTP/duplicate exclusion (§3.6)`,
    );
  }
});
