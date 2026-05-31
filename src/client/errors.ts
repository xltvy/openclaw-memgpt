/**
 * Typed errors the SidecarClient surfaces to its callers.
 *
 * The discrimination matters at the hook/tool layer:
 *
 *   - CoreMemoryError      → tool handler re-surfaces .message verbatim as the
 *                            LLM-facing tool-result string (§2.9; the LLM is
 *                            trained against pymemgpt's exact strings, so
 *                            reformatting is a fidelity loss).
 *   - BufferTooSmallError  → 6c.6 flush-pressure handler catches this
 *                            specifically and treats as no-op per §2.8 (a
 *                            false-alarm threshold crossing on a small
 *                            token-heavy buffer is recoverable; failing the
 *                            user's turn over it is not).
 *   - SidecarError         → generic fallback for everything else (HTTP 4xx/5xx
 *                            that isn't one of the above, plus network /
 *                            JSON-parse failures).
 */

// ============================================================================
// Generic
// ============================================================================

/**
 * Catch-all for sidecar HTTP failures the client cannot specifically type.
 * Carries the HTTP status, the endpoint path, and whatever body the sidecar
 * returned (parsed if JSON, else the raw text).
 */
export class SidecarError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(opts: {
    status: number;
    path: string;
    body: unknown;
    message?: string;
  }) {
    super(
      opts.message ??
        `Sidecar ${opts.status} from ${opts.path}: ${
          typeof opts.body === "string"
            ? opts.body
            : JSON.stringify(opts.body)
        }`,
    );
    this.name = "SidecarError";
    this.status = opts.status;
    this.path = opts.path;
    this.body = opts.body;
  }
}

// ============================================================================
// Core memory (§2.9 — 409 with verbatim pymemgpt strings)
// ============================================================================

/** §2.9 error codes the sidecar's _core_memory_409 helper emits. */
export type CoreMemoryErrorCode =
  | "core_memory_overflow"
  | "core_memory_content_not_found"
  | "core_memory_edit_failed";

/**
 * 409 from a core_memory edit. `.message` is the pymemgpt string verbatim —
 * the tool handler returns it as the tool-result error string the LLM sees,
 * unmodified.
 */
export class CoreMemoryError extends Error {
  readonly code: CoreMemoryErrorCode;

  constructor(opts: { code: CoreMemoryErrorCode; message: string }) {
    super(opts.message);
    this.name = "CoreMemoryError";
    this.code = opts.code;
  }
}

// ============================================================================
// Summariser (§2.8 — 422 "buffer too small")
// ============================================================================

/**
 * 422 from :summarize: the buffer is too small to summarise (fewer than
 * MESSAGE_SUMMARY_TRUNC_KEEP_N_LAST + 1 non-system messages — `select_cutoff`
 * raises). Per §2.8 the host-side flush-pressure handler (6c.6) treats this as
 * a no-op rather than failing the user's turn: a false-alarm threshold
 * crossing on a small token-heavy buffer is recoverable.
 */
export class BufferTooSmallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BufferTooSmallError";
  }
}
