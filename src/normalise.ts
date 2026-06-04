/**
 * normalise.ts — the §3.7 / §2.10 message-shape boundary.
 *
 * Converts OpenClaw's modern-tools-API message shape (`tool_calls` / `tool`
 * role) into pymemgpt's v0 dict shape (`function_call` / `function` role).
 * This is the single TS-side ingest boundary: every caller that hands messages
 * to the sidecar (the 6c.3 tools, the 6c.5 mirror hook, the 6c.6 flush-pressure
 * handler) normalises first. The SidecarClient itself never calls normalise —
 * it stays pure transport, so the sidecar only ever sees v0-shaped dicts and
 * never re-normalises (§3.7 invariant).
 *
 * Idempotent: `normalise(normalise(x))` is deep-equal to `normalise(x)`.
 * Already-v0 input (role === "function", or assistant with `function_call`
 * already set and no `tool_calls`) is rebuilt into the canonical v0 shape with
 * the same fields, so a second pass is a no-op.
 *
 * Multi-tool_call assistant messages: pymemgpt v0 carries at most one
 * `function_call` per assistant message — there is no array form. If
 * `tool_calls` has length > 1 we keep the first and discard the rest, with a
 * console.warn. MemGPT's prompt regime should not generate multi-call
 * assistant messages in practice, but degrading gracefully is preferable to
 * failing the turn if it ever does happen.
 */

import type { PyMemGptMessage } from "./client/types.ts";

// ============================================================================
// Input shape — OpenClaw's modern tools API
// ============================================================================

/** A single entry in an assistant message's `tool_calls` array. */
export interface OpenClawToolCall {
  /** Provider-assigned id; dropped on normalisation (v0 pairs by adjacency). */
  id?: string;
  /** OpenAI-style; "function" in practice, ignored on normalisation. */
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

/** A single content part in OpenAI's content-blocks format. */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * The OpenClaw-side message shape this boundary accepts. Kept structurally
 * open (`[key: string]: unknown`) so non-load-bearing extra fields pass
 * silently — only the fields named here participate in the transformation.
 *
 * Already-v0 inputs (role: "function", or assistant with `function_call`)
 * are also accepted; the function detects them and returns the v0 shape.
 *
 * `content` accepts both the legacy string form and the modern content-blocks
 * array form (`[{type:"text",text:"..."}]`). `normalise` flattens arrays to
 * strings so the sidecar only ever sees the v0 string form (§3.7 invariant).
 */
export interface OpenClawMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content?: string | ContentPart[] | null;
  name?: string | null;
  /** Modern tools API: array on assistant messages. */
  tool_calls?: OpenClawToolCall[];
  /** Modern tools API: present on tool-result messages; dropped on normalise. */
  tool_call_id?: string;
  /** Already-v0 form on assistant messages. Preserved if present. */
  function_call?: { name: string; arguments: string } | null;
  [key: string]: unknown;
}

/**
 * Flatten OpenAI content-blocks arrays to a plain string for the pymemgpt
 * v0 wire format. v0 requires `content: string | null`; OpenClaw may send
 * `content: [{type:"text",text:"..."}]`.
 *
 * - null / undefined → null
 * - string → string (unchanged)
 * - empty array → null
 * - array with text parts → text parts joined (order preserved)
 * - array with no text parts → null
 */
function flattenContent(content: string | ContentPart[] | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = content
    .filter((p): p is ContentPart & { text: string } =>
      p !== null && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map(p => p.text)
    .join("");
  return text.length > 0 ? text : null;
}

// ============================================================================
// The transformation
// ============================================================================

/**
 * Convert one OpenClaw message to pymemgpt v0 shape. See module docstring for
 * the contract (idempotency, multi-tool_call policy).
 */
export function normalise(message: OpenClawMessage): PyMemGptMessage {
  // tool role → function role; drop tool_call_id (v0 pairs by adjacency).
  if (message.role === "tool") {
    const out: PyMemGptMessage = {
      role: "function",
      content: flattenContent(message.content),
    };
    if (message.name !== undefined && message.name !== null) {
      out.name = message.name;
    }
    return out;
  }

  // assistant with tool_calls → assistant with function_call.
  // Multi-call: keep first, warn, discard rest.
  if (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    if (message.tool_calls.length > 1) {
      console.warn(
        `openclaw-memgpt normalise: assistant message has ${message.tool_calls.length} tool_calls; v0 supports a single function_call — keeping the first, discarding the rest`,
      );
    }
    const first = message.tool_calls[0];
    const out: PyMemGptMessage = {
      role: "assistant",
      content: flattenContent(message.content),
      function_call: {
        name: first.function.name,
        arguments: first.function.arguments,
      },
    };
    if (message.name !== undefined && message.name !== null) {
      out.name = message.name;
    }
    return out;
  }

  // Everything else: system / user / assistant-without-tool_calls /
  // already-v0 function or assistant-with-function_call. We rebuild rather
  // than returning the input object so that any stray `tool_calls` /
  // `tool_call_id` fields are dropped, and so the second pass of
  // normalise(normalise(x)) sees the same canonical shape.
  const out: PyMemGptMessage = {
    role: message.role,
    content: flattenContent(message.content),
  };
  if (message.name !== undefined && message.name !== null) {
    out.name = message.name;
  }
  if (
    message.role === "assistant" &&
    message.function_call !== undefined &&
    message.function_call !== null
  ) {
    out.function_call = message.function_call;
  }
  return out;
}

/**
 * Batch form — convenience wrapper for the common "normalise an array of
 * messages" case at the call sites. Equivalent to `messages.map(normalise)`.
 */
export function normaliseMessages(
  messages: OpenClawMessage[],
): PyMemGptMessage[] {
  return messages.map(normalise);
}
