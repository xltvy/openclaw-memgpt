/**
 * normalise.ts — the §3.7 / §2.10 message-shape boundary.
 *
 * Converts OpenClaw's runtime message shape into pymemgpt's v0 dict shape
 * (`function_call` / `function` role). This is the single TS-side ingest
 * boundary: every caller that hands messages to the sidecar (the 6c.3 tools,
 * the 6c.5 mirror hook, the 6c.6 flush-pressure handler) normalises first.
 * The SidecarClient itself never calls normalise — it stays pure transport,
 * so the sidecar only ever sees v0-shaped dicts and never re-normalises
 * (§3.7 invariant).
 *
 * Two OpenClaw input shapes are accepted:
 *
 *   (a) The pi-ai canonical shape, which OpenClaw's runtime actually emits
 *       to `api.on("agent_end")`: assistant messages carry inline `toolCall`
 *       content blocks (`content: [{type:"text"}, {type:"toolCall", name, arguments}]`)
 *       and tool results use `role:"toolResult"` with a `toolName` field.
 *       This is the load-bearing path for the 6c.5 mirror.
 *   (b) The classic OpenAI-tools-API shape: assistant with `tool_calls[]`
 *       array + `role:"tool"` results. Retained for backward compatibility
 *       and because the integration tests / external callers may still use it.
 *
 * Both paths land on the same v0 output: assistant with `function_call:{name,
 * arguments}` (arguments is a JSON STRING per v0 contract, even when the
 * pi-ai input had an object) and `role:"function"` tool results.
 *
 * Idempotent: `normalise(normalise(x))` is deep-equal to `normalise(x)`.
 * Already-v0 input (role === "function", or assistant with `function_call`
 * already set and no `tool_calls`) is rebuilt into the canonical v0 shape with
 * the same fields, so a second pass is a no-op.
 *
 * Multi-toolCall assistant messages: pymemgpt v0 carries at most one
 * `function_call` per assistant message — there is no array form. If multiple
 * toolCalls are present (whether as inline blocks or as `tool_calls[]`) we
 * keep the first and discard the rest, with a console.warn. MemGPT's prompt
 * regime should not generate multi-call assistant messages in practice, but
 * degrading gracefully is preferable to failing the turn if it ever does happen.
 *
 * History: shape (a) support was added after the V1.3 slate surfaced that
 * the prior normalise — written for shape (b) only — silently dropped all
 * toolCall structure from the persisted pickle on Cell C trials. See
 * methodology-bank #20 for the full root-cause record.
 */

import type { PyMemGptMessage } from "./client/types.ts";

// ============================================================================
// Input shape — OpenClaw's modern tools API
// ============================================================================

/** A single entry in an assistant message's `tool_calls` array (legacy
 *  OpenAI-style shape (b); see module docstring). */
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

/**
 * A single content part in OpenClaw's content-blocks format.
 *
 * The pi-ai canonical types declare three block variants we care about:
 *
 *   - `{type:"text", text:string}` — assistant or user text
 *   - `{type:"toolCall", id, name, arguments: Record<string,any>}` — inline
 *     tool invocation; `arguments` is an OBJECT in pi-ai, NOT a JSON string.
 *     normalise() stringifies it for the v0 wire format.
 *   - `{type:"thinking", thinking:string}` — extended-thinking content;
 *     dropped on normalise (v0 has no equivalent).
 *
 * Kept structurally open (`[key: string]: unknown`) so extra provider-specific
 * block types pass through without crashing — only the fields named here
 * participate in the transformation.
 */
export interface ContentPart {
  type: string;
  text?: string;
  /** Present on `{type:"toolCall"}` blocks (pi-ai shape). */
  name?: string;
  /** Present on `{type:"toolCall"}` blocks (pi-ai shape); object form. */
  arguments?: Record<string, unknown>;
  /** Present on `{type:"toolCall"}` blocks (pi-ai shape). */
  id?: string;
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
 *
 * Role union: pi-ai's `toolResult` is included alongside the OpenAI-classic
 * `tool`; both translate to v0 `function`.
 */
export interface OpenClawMessage {
  role: "system" | "user" | "assistant" | "tool" | "toolResult" | "function";
  content?: string | ContentPart[] | null;
  name?: string | null;
  /** pi-ai `ToolResultMessage.toolName`. Falls back to `name` on the rare
   *  drift where a caller used the OpenAI-classic `name` field instead. */
  toolName?: string | null;
  /** Legacy OpenAI tools API: array on assistant messages. */
  tool_calls?: OpenClawToolCall[];
  /** Legacy OpenAI tools API: present on tool-result messages; dropped on normalise. */
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
 * Stringify a `toolCall` block's `arguments` field for v0's wire format.
 * pi-ai uses `Record<string, any>` (object); v0's `function_call.arguments`
 * is a JSON STRING. If the input is already a string (rare drift), pass it
 * through unchanged so idempotency holds.
 */
function stringifyToolCallArguments(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || args === undefined) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    // Should not happen for plain JSON objects; defensive fallback so a
    // turn doesn't crash on a freak unserialisable input.
    return "{}";
  }
}

/**
 * Convert one OpenClaw message to pymemgpt v0 shape. See module docstring for
 * the contract (idempotency, multi-toolCall policy).
 */
export function normalise(message: OpenClawMessage): PyMemGptMessage {
  // pi-ai toolResult role → v0 function role. Prefer `toolName` (canonical
  // pi-ai field); fall back to `name` (legacy / drift). Content blocks are
  // flattened to a string per the v0 contract.
  if (message.role === "toolResult") {
    const out: PyMemGptMessage = {
      role: "function",
      content: flattenContent(message.content),
    };
    const nm = message.toolName ?? message.name;
    if (nm !== undefined && nm !== null) {
      out.name = nm;
    }
    return out;
  }

  // Legacy OpenAI-tools-API tool role → v0 function role; drop tool_call_id
  // (v0 pairs by adjacency).
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

  // pi-ai shape: assistant with inline `toolCall` blocks in content array.
  // `flattenContent` already drops non-text blocks, so the assistant's text
  // monologue survives as content; we extract the first toolCall block for
  // function_call and stringify its object-form arguments.
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const toolCallBlocks = message.content.filter(
      (b): b is ContentPart & { name: string } =>
        b !== null &&
        typeof b === "object" &&
        b.type === "toolCall" &&
        typeof b.name === "string",
    );
    if (toolCallBlocks.length > 0) {
      if (toolCallBlocks.length > 1) {
        console.warn(
          `openclaw-memgpt normalise: assistant message has ${toolCallBlocks.length} inline toolCall blocks; v0 supports a single function_call — keeping the first, discarding the rest`,
        );
      }
      const first = toolCallBlocks[0];
      const out: PyMemGptMessage = {
        role: "assistant",
        content: flattenContent(message.content),
        function_call: {
          name: first.name,
          arguments: stringifyToolCallArguments(first.arguments),
        },
      };
      if (message.name !== undefined && message.name !== null) {
        out.name = message.name;
      }
      return out;
    }
  }

  // Legacy: assistant with `tool_calls[]` → assistant with function_call.
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

/** Type guard: a content part is a pi-ai `toolCall` block. */
function isToolCallBlock(
  block: unknown,
): block is ContentPart & { type: "toolCall"; name: string; id?: string } {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "toolCall" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

/**
 * Batch form — array-aware normalisation that handles the pi-ai
 * multi-toolCall pattern (Sonnet 4.5 emits 2–3 toolCalls in a single
 * assistant message; pymemgpt v0 carries at most one `function_call` per
 * assistant entry).
 *
 * Algorithm: walk the array; for each assistant message with N>1 inline
 * toolCall blocks, split into N v0 (assistant, function) pairs in order,
 * matching the following toolResults by `toolCallId`. Text content lives on
 * the first split entry only; the remaining N-1 carry `content: null`.
 * ToolResult messages consumed by a split are removed from the output
 * stream (they're emitted in-band as the function-role half of each pair).
 *
 * For single-toolCall and non-assistant messages, delegates to the
 * per-message `normalise()`. Idempotency at array level: a second pass
 * over the split output produces an identical result (each entry is
 * already single-call).
 *
 * Discovered during V1.4 rig fix (methodology-bank #20); see the new
 * normalise.test.ts cases under "9e. multi-toolCall split".
 */
export function normaliseMessages(
  messages: OpenClawMessage[],
): PyMemGptMessage[] {
  const out: PyMemGptMessage[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const m = messages[i];

    // Detect multi-toolCall assistant (pi-ai inline blocks). The single-call
    // case stays on the per-message path so the existing semantics + tests
    // are untouched.
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const toolCallBlocks = m.content.filter(isToolCallBlock);
      if (toolCallBlocks.length > 1) {
        const textContent = flattenContent(m.content);
        for (let j = 0; j < toolCallBlocks.length; j++) {
          const tc = toolCallBlocks[j];
          const assistantOut: PyMemGptMessage = {
            role: "assistant",
            content: j === 0 ? textContent : null,
            function_call: {
              name: tc.name,
              arguments: stringifyToolCallArguments(tc.arguments),
            },
          };
          if (m.name !== undefined && m.name !== null) {
            assistantOut.name = m.name;
          }
          out.push(assistantOut);

          // Find the matching toolResult by toolCallId; consume it.
          // If id is missing or no match found, emit the assistant alone —
          // pymemgpt v0 tolerates a function call with no immediately
          // following function-role response (the LLM sees it on the next
          // turn). Better to emit the call than silently drop it.
          if (tc.id) {
            const trIdx = findToolResultIndex(messages, i + 1, tc.id, consumed);
            if (trIdx !== -1) {
              out.push(normalise(messages[trIdx]));
              consumed.add(trIdx);
            }
          }
        }
        continue;
      }
    }

    out.push(normalise(m));
  }
  return out;
}

/**
 * Find the index of the next unconsumed toolResult matching a given
 * `toolCallId`. Returns -1 if none found.
 *
 * Searches forward from `start` so toolResults paired with an earlier
 * toolCall in the same fan-out can't be claimed by a later one. The pi-ai
 * runtime emits toolResults in toolCall order so this matches the natural
 * pairing; the `toolCallId` check guards against any future ordering
 * change.
 */
function findToolResultIndex(
  messages: OpenClawMessage[],
  start: number,
  toolCallId: string,
  consumed: Set<number>,
): number {
  for (let k = start; k < messages.length; k++) {
    if (consumed.has(k)) continue;
    const m = messages[k];
    if (m.role === "toolResult" && (m as { toolCallId?: unknown }).toolCallId === toolCallId) {
      return k;
    }
    // Stop at the next assistant message — toolResults for that one are not
    // ours, and our toolResult should appear before any non-toolResult
    // message under pi-ai's emission rules.
    if (m.role === "assistant") {
      return -1;
    }
  }
  return -1;
}
