# Build history

What was built and when, sub-task by sub-task. Each entry is a closed milestone:
purpose, the non-obvious decisions made, and the test counts at the time of
closure. Phase 6c.9 (vertical slice) is summarised at the top; its sub-stage
findings are in [docs/methodology-bank.md](methodology-bank.md).

This file is referenced from `CLAUDE.md` (gitignored operating manual) and is
the authoritative historical record. Read it without other context.

---

## Phase summary

- **Phases 1–5 (complete).** pymemgpt fork modernised + runtime-verified.
  Dependency modernisation, llama-index 0.8→0.14 migration, openai SDK v0.28→v2
  port, LLM routing infra, full runtime verification, structured source reading,
  and sidecar API design (the design doc lives in this plugin repo as
  gitignored `API_DESIGN.md`).
- **Phase 6a (released, `sidecar-api-verified`).** Python sidecar wraps the
  Phase-3-verified pymemgpt fork in a FastAPI HTTP surface. 93/93 tests.
- **Phase 6b (released, fork-`main` `0c31f10`).** Proxy shim relocated from
  fork to plugin repo.
- **Phase 6c (released, plugin-`main` `03b393f`, tag `vertical-slice-verified`).**
  TS plugin complete; vertical slice end-to-end through OpenClaw verified.
  162/163 tests pass + 1 integration-skip.

---

## Foundational decisions (locked, still load-bearing)

These predate 6a and remain in force across all phases. Carried forward
verbatim from the CURRENT STATE record.

- **`API_DESIGN.md` stable** — reconciled to all Stage 0 findings + the
  persistence correction + the archival/recall pagination findings + the
  recall observability-parse contract.
- **Task 0 scaffold** — bge-small loads in the sidecar `uv` env (dim=384).
- **Spikes complete:**
  - S0.1 — turn-termination resolves to `reply_dispatch` + `{handled:true}`;
    no native stop.
  - S0.2 — SDK bindings; `registerMemoryCapability` is OpenClaw's corpus
    subsystem, NOT the plugin mechanism. Wiring is events
    (`before_prompt_build`, `agent_end`, `reply_dispatch`) + `registerTool`.
  - S0.3 — `_message_logs` attribute name confirmed for F2.
  - S0.4 — loop-inert Agent confirmed; memory methods callable with no LLM.
- **Single-state-manager decision LOCKED:** `LocalStateManager` +
  `EmbeddingArchivalMemory` on all paths; residency (resident vs evict-and-
  `:load`) is the sole arm variable; embedder is a startup dependency on
  every run.
- **Persistence model LOCKED (declared deviation):** mutations commit
  in-process within the turn; awaited `:save` at `agent_end` flushes all three
  tiers per turn. Strengthens MemGPT's CLI (`/save`-or-`/exit` only), conforms
  to the OpenClaw plugin norm (Mem0 `agent_end` per-turn). Guards mirror Mem0
  (success, interactive, non-subagent). Await vs Mem0's fire-and-forget
  justified by local-pickle vs remote write.

---

## Phase 6a — Python sidecar (closed; released as `sidecar-api-verified`)

- **6a.0 ✅** — FastAPI scaffold, resident registry, `/healthz`,
  embedder-at-startup, `MEMGPT_DIR`-before-import.

- **6a.1 ✅** — `POST /agents` composite; agent resident; config snapshot on
  disk under the configured dir (confirms the `MEMGPT_DIR` patch reaches its
  read sites); loop-inert under `LocalStateManager`; `archival:insert` is
  in-memory not eager-to-disk (spec corrected); duplicate → 409.

- **6a.2 ✅** — `GET /system_prompt_section`; renders from `agent.memory` via
  `construct_system_with_memory` (faithful, unadapted); `static + dynamic ==
  section` exact; persona/human/counts on the dynamic side; static =
  `agent.system` (5433 chars, cacheable); unknown agent → 404.

- **6a.3 ✅** — core memory `:append`/`:replace` + `GET core_memory`; verbatim
  409 strings byte-for-byte vs Phase 3; `name` constrained to
  `Literal["persona","human"]` (bad name → 422, not a masked `KeyError`);
  `_core_memory_409` assigns distinct codes (`core_memory_overflow` /
  `core_memory_content_not_found` / `core_memory_edit_failed` fallback) by
  message-sniff while keeping the message verbatim; edit-then-render confirmed
  (dynamic changes, static doesn't).

- **6a.4 ✅** — archival `:insert`/`:search`; single-search handler (collapsed
  from an initial two-search version — derives `formatted` + structured fields
  from one Agent-method call); `formatted` byte-for-byte incl. trailing space;
  empty-index `EmptyIndex` AttributeError caught → "No results found.";
  multi-page paging test added. **Fidelity finding (investigated, faithful, NOT
  patched):** `EmbeddingArchivalMemory.search` returns paged-slice length as
  `total` (always "N of N (page p/0)", `num_pages` always 0) — native MemGPT
  at baseline `f46cc3b:memory.py:726`, not a migration regression. Recall
  (substring backend) paginates correctly by contrast. Experiment implication:
  archival injections reachable only if they rank into top-`count` (page 0)
  for the agent's queries — documented in §2.5; `count`/`top_k` is now a
  deliberate experimental parameter.

- **6a.5 ✅** — recall `:search`/`:search_date`; single-call discipline (one
  `Agent.recall_memory_search*` per request; structured fields parsed from the
  single formatted string via `_parse_recall_formatted`); `search_date` params
  (`start_date`/`end_date`) confirmed against `gpt_functions` schema; misses
  return "No results found." natively (no empty-index catch); seeded-on-baseline
  check (XZEBRA token absent from boot messages, present in returned results);
  multi-page recall test confirms real grand total (M = SEED_COUNT, `num_pages
  > 0`) — empirically proving the §2.6 archival/recall paging asymmetry.
  **Robust observability parse:** `_parse_recall_formatted` splits prefix
  (anchored regex, content-independent M/P extraction) from array (`json.loads`
  on the JSON-serialised array — Agent method uses `json.dumps`, escaping
  embedded `"`); array decode wrapped defensively (degrades to counts-only on
  any future non-JSON array). Verified against adversarial content (embedded
  `"`, `[`, `]`, prefix-mimicking substrings) + unit-level malformed-array
  degradation tests (15/15 pass). §2.6 documents the "faithfully reconstructed"
  contract and the archival/recall `total` semantic asymmetry (recall = true
  grand total; archival = page-local) so the 6d.3 detection-rate metric
  doesn't conflate them.

- **6a.6 ✅** — `messages:append` → `persistence_manager.append_to_messages`
  (NOT the Agent wrapper); sidecar timestamps via `get_local_time()` inside
  `LocalStateManager.append_to_messages`; body is a _list_ of pymemgpt-v0-shaped
  dicts (per-turn batch, matching `agent_end`'s shape, §3.7/§2.10). Layer-cut
  held: `agent._messages` (Agent's own buffer, set at `__init__`) untouched
  by the pm-level write — asserted via length-before/after. Adversarial-content
  round-trip via the real write path (no fixture shortcut): seeded
  delimiter-heavy content survives `messages:append` → `pm.all_messages` →
  `recall:search` → `_parse_recall_formatted` verbatim. Closes the loop the
  6a.5 fixture bypassed. 9/9 tests pass.

- **F1 ✅** — cutoff-selection factoring (fork commit `e2c8c93` on
  `feat/cutoff-factoring`, merged to fork `dev`). `select_cutoff(messages,
  model, preserve_last_N_messages)` at module level in `memgpt/agent.py`;
  both `Agent.summarize_messages_inplace` and
  `AgentAsync.summarize_messages_inplace` reduced to call it. Pre-factoring
  diff vs `f46cc3b` empty → equivalence-to-current is equivalence-to-upstream.
  5/5 equivalence tests pass. (b)-class adapter-layer port.

- **6a.7 ✅** — `POST /agents/{id}:summarize` consuming F1's `select_cutoff`
  via the editable install (fork on `dev`). Orchestrates F1 +
  `summarize_messages` + `package_summarize_message` in order, mirroring the
  inline `summarize_messages_inplace` body minus the host-owned
  trim/prepend/`messages_total` mutations. Request carries
  `total_message_count` (host-tracked — sidecar can't derive it from buffer
  length after prior summarisations); `model` resolved from the resident
  agent's config (`agent.model`, §5.5 "summariser = agent model" default).
  Buffer isolation asserted on all three message lists (§2.1 buffer map) —
  `agent._messages` / `pm.messages` / `pm.all_messages` length-unchanged
  before/after. Cutoff equivalence inherited from F1's test (by construction;
  the endpoint adds packaging, not algorithm). **Two spec corrections from
  impl:** (a) `summary_length` is a _message count_ (`= cutoff - 1`,
  templated into `package_summarize_message` as "the following is a summary
  of the previous N messages") — §2.8 example value updated from `87` →
  `23` with a one-line semantics note; (b) too-small-buffer → **422** added
  to §2.8 with the host-side "treat as no-op" policy for 6c.6's later
  consumer. 15/15 tests pass.

- **F2 ✅** — recall reference-repair at load (fork commit `109817c` on
  `feat/recall-reference-repair`, merged to fork `dev`). One line in
  `LocalStateManager.load`: `manager.recall_memory._message_logs =
  manager.all_messages` after the unpickle, restoring the in-memory-path
  reference-sharing (`persistence_manager.py:157`). **Finding:** the
  happy-path save/load preserves the reference incidentally (pickle preserves
  object identity within one dump call); the repair makes the invariant
  load-path-guaranteed regardless of pickle behaviour, so any
  divergence-before-save can't silently corrupt recall search. Baseline diff
  vs `f46cc3b` substantively empty (`memory.py` line-ending-only). 3/3 tests
  pass incl. the toggle-the-line test proving the repair causes the fix.
  (b)-class adapter-layer port, behaviour-restoring.

- **6a.8 ✅** — `:save` (all three tiers to disk, awaited, agent stays
  resident; 404 if not resident) + `:load` (cold-start-only via
  `Agent.load_agent`, F2 repair fires inside `LocalStateManager.load`; 409
  if already resident — cold-start-only _enforced_, not conventional; 404
  if no on-disk state). 10 tests / 56 total pass. The load-bearing assertion
  (`TestF2RepairThroughSurface`) uses a _post-load_ append — exercising the
  F2 repair, not pre-save survival which the happy-path pickle preserves
  regardless. Residency-is-default proven (assertion 4 ties to §2.10
  sole-arm-variable).

- **6a.9 ✅ [MILESTONE]** — sidecar acceptance pass. Drove the full memory
  surface over HTTP and diffed vs an in-process oracle agent (`Agent` +
  `LocalStateManager` + `EmbeddingArchivalMemory`, constructed the way
  `POST /agents` does, fork on `dev` carrying F1+F2). **Parity proven on:**
  static system prompt (byte-for-byte), core memory contents + 409 message
  +code verbatim (§2.9), archival formatted strings (timestamp-normalised,
  content + ranking + page-local `total` all matching), recall formatted
  strings (timestamp-normalised, content matching), summariser `cutoff` (F1
  equivalence through HTTP), derived counts (`summary_length` = `cutoff - 1`,
  `hidden_message_count`, `total_message_count`), preamble verbatim template,
  and persisted disk state via the cold-start round-trip. **F2 through the
  surface confirmed** (`test_post_load_recall_matches` — _post-load_ append
  findable). **Adversarial end-to-end** (`'buy "Adidas", not [Nike] — see
  results (page 1)'`) round-trips verbatim through
  create→insert→append→save→load→search on both recall and archival, tying
  6a.5 (parse robustness) + 6a.6 (write path) + 6a.8 (save/load) into one
  system assertion. **Four declared deviations named in the spec and
  excluded from the diff** (not failures): [D1] dynamic-section render-time
  timestamp; [D2] archival per-result search-time timestamp; [D3]
  LLM-generated summary text (non-deterministic; cutoff + derived counts +
  preamble compared deterministically); **[D4] new from 6a.9** — recall
  per-result `pm.all_messages` wrapper timestamp (`get_local_time()` at
  append time; oracle and sidecar append at slightly different moments).
  Archival page-local total is _not_ a deviation — both arms exhibit the
  §2.5 faithful behaviour, asserted explicitly (5/2 split for 7-passage
  corpus). 37/37 acceptance tests / 93/93 full suite. Tag candidate
  `sidecar-api-verified` — applied at the coordinated release per the
  branching model. **This is 6a "done."**

---

## Phase 6b — Proxy shim relocate (closed; released as fork-`main` `0c31f10`)

- **6b ✅** — proxy shim relocated from `memgpt-service/sidecar/` to
  `openclaw-memgpt/sidecar/proxy_shim.py` per §5.1. Move not rewrite;
  provider-neutral; no institutional values in committed code. (c)-class on
  the plugin side (file landing in its destination repo), (d)-class on the
  fork side (`sidecar/` package removed, `litellm_config.yaml` gitignore
  entries dropped) and (d)-class across docs (three-terminals recipe + "what
  it normalises" content moved to plugin CLAUDE.md; fork CLAUDE.md tombstoned
  to point here for the deployment recipe). Lives on plugin branch
  `feat/proxy-shim-relocate` and fork branch `feat/proxy-shim-relocate`.
  Done-criterion met: zero stale `memgpt-service/sidecar` /
  `memgpt-service.*proxy_shim` hits across either repo's `*.md`. Recipe
  corrected on the move: `uv run uvicorn proxy_shim:app` (sibling files, not
  a package), not `poetry run uvicorn sidecar.proxy_shim:app`.

---

## Phase 6c — TS plugin (closed; released as plugin-`main` `03b393f`, `vertical-slice-verified`)

### 6c.0–6c.8 — Plugin scaffolding through lifecycle teardown

- **6c.0 ✅** — TS plugin scaffold per §3.2/§3.3/§3.4/§3.8. `config.ts` parses
  `api.pluginConfig` (Mem0-pattern manual type guards + allowed-keys check +
  `observability` default `"default"`; `parseConfigValue` exported separately
  so tests don't need a full api stub). `client/types.ts` +
  `client/sidecarClient.ts` skeleton: `SidecarClientImpl` ctor takes
  `(config, resolveBaseUrl)` so 6d lifecycle injects the URL without touching
  the client surface; `initPromise` guard per §3.4 (concurrent first-callers
  share one promise; failure clears it so later callers retry rather than
  caching the rejection); empty stubs for every §2 endpoint, each awaiting
  `ensureReady()` first. `src/index.ts` `register(api)` parses config +
  constructs the client + one registration log; no tools/hooks/lifecycle yet
  (those are 6c.3–6c.8). Directory rename `capability/` → `hooks/` per S0.2
  (the §4 wiring is events, NOT `registerMemoryCapability` — that's the
  corpus subsystem per §4.8). 6 parseConfig tests (3 required + 3 adjacent
  guards: unknown-key, non-object, invalid-observability-value-in-message).
  `npm test` script via `node:test` + native TS exec. Env-var typo
  (`OPENCLAW_MEMGMT_*` → `OPENCLAW_MEMGPT_*`) caught pre-merge during
  scaffold review. (b)+(d)-class.

- **6c.1 ✅** — `SidecarClient` wire layer + management/status split, against
  a live uvicorn-hosted sidecar (not a mock). `client/errors.ts`: three typed
  errors chosen for specific discrimination at the hook/tool layer —
  `CoreMemoryError` carries `.message` verbatim from pymemgpt's 409 body
  (§2.9; LLM was trained against these exact strings) + `.code` so
  observability classifies without re-parsing; `BufferTooSmallError` is the
  §2.8 422 the 6c.6 flush handler will catch as no-op (false-alarm threshold
  crossing is recoverable; failing the turn over it is not); `SidecarError`
  is the catch-all carrying status/path/body. `client/sidecarClient.ts`: 14
  method bodies wired through centralised `buildSidecarRequest` +
  `handleResponse` that discriminates the typed errors so downstream
  hook/tool code never parses strings; snake_case ↔ camelCase mapping at the
  method layer. **Signature/design correction (impl revealed):** dropped
  `_ensureAgent` from `doInit` — §3.4's example would have made `ensure().via`
  always `"resident"` on first call (because `doInit` had already created
  the agent one HTTP turn earlier), hiding the create/load/resident
  discrimination at the call site (in the 6c.1 tests and in the 6d
  observability `sidecar_ensured` event). `client/sidecarAdminClient.ts`:
  separate class for the §3.5 management/status surface — the
  no-invented-endpoint rule governs the memory-behaviour client; operational
  plumbing (residency, PID, port, future restart-self) has no pymemgpt anchor
  and is exempt by design. Structural separation, not conventional, so 6d
  can develop this surface without enlarging the memory-surface contract.
  `tests/sidecarFixture.ts`: spawns `uv run uvicorn main:app` on a free
  ephemeral port, isolated `OPENCLAW_MEMGPT_DATA_DIR` per session, polls
  `/healthz` until `embedder=ready` (~90s budget), SIGTERMs on stop with
  grace period. 18 round-trip tests (per-method wire shape + integration:
  ensure → core-memory round-trip, overflow → `CoreMemoryError` with verbatim
  pymemgpt text, 422 → `BufferTooSmallError` NOT `SidecarError` so 6c.6 can
  pattern-match). 24/24 tests pass.

- **6c.2 ✅** — `src/normalise.ts`, the single §3.7 / §2.10 ingest-boundary
  normaliser. Converts OpenClaw's modern tools-API shape (`tool_calls` /
  `tool` role) → pymemgpt v0 shape (`function_call` / `function` role):
  `tool` → `function`; first `tool_calls[0]` → `function_call` with
  `console.warn` + discard rest if length > 1 (v0 supports a single
  function_call per assistant; degrade gracefully rather than fail the turn
  — MemGPT's prompt regime should not produce multi-call assistants in
  practice); `tool_call_id` dropped (v0 pairs by adjacency, not id); `content`
  + `name` preserved; system/user pass through. Idempotent by rebuild —
  already-v0 input is re-emitted in the canonical shape so
  `normalise(normalise(x))` is deep-equal to `normalise(x)`, and stray
  `tool_calls` / `tool_call_id` keys are dropped on the rebuild (which is
  what makes the second pass a no-op rather than relying on input-object
  identity). `SidecarClient` unchanged — the §3.7 invariant ("client is pure
  transport; the handler layer normalises before calling `messagesAppend` /
  `summarize`") is preserved; 6c.3 / 6c.5 / 6c.6 are the three
  non-overlapping call sites that will consume it (so no message is
  normalised twice). 20 unit tests (every transformation case + idempotency
  at the per-message level + edge cases — extra unknown fields stripped at
  the boundary, empty content preserved (not coerced to null),
  missing-content → null, missing-name → key absent (not `undefined`-as-key))
  + 1 round-trip via live sidecar (user → assistant-with-tool_call →
  tool-result → `normaliseMessages` → `messagesAppend` (3 appended) →
  `recallSearch` surfaces the user-message marker). Round-trip pinned to
  the user-message marker per §2.10: `DummyRecallMemory.text_search` filters
  out `system`/`function` roles and matches on `d["message"]["content"]`,
  so `function_call.arguments` on the assistant message is not the safe
  target. 45/45 tests pass.

- **6c.3 ✅** — seven tools + `ToolDeps` bag per §3.6. `tools/schemas.ts`:
  schemas reproduced byte-for-byte from
  `memgpt-service/memgpt/prompts/gpt_functions.py` (the LLM was trained
  against the name/description/params triple, and the description carries
  behavioural instruction — e.g. archival_memory_insert's "phrase the memory
  contents such that it can be easily queried later") with the §3.6
  adjustments — `request_heartbeat` dropped from every schema (OpenClaw
  chains by default; the chain-vs-yield distinction is recovered at the
  tool-identity level per §4.3: memory tools chain, send_message yields);
  `recall_memory_search` / `conversation_search` duplicate collapsed to
  LLM-facing `conversation_search` (architecture name `recall:search` stays
  on the sidecar endpoint; handler bridges); file/HTTP/`message_chatgpt`/
  `pause_heartbeats` dropped. `tools/deps.ts`: `ToolDeps` (client/namespace/
  emit/logger) + `ToolHandler` signature matching the SDK's `(toolCallId,
  params) => Promise<{content}>` execute contract + `makeToolDeps` builder;
  `emit` is a no-op stub until 6d wires the §6.2 level-gated emitter
  (better to stay silent than produce unstructured logs the experiment
  harness can't aggregate). **Six memory handlers** (one file each) —
  uniform §3.6 shape: thin SidecarClient wrappers; return `r.formatted`
  verbatim on search; `CoreMemoryError` → tool-result text = `.message`
  verbatim per §2.9; other errors bubble. Name-bridge at handler layer
  (`conversation_search` → `client.recallSearch`; `conversation_search_date`
  → `client.recallSearchDate` with `start_date`/`end_date` →
  `{startDate, endDate}` snake-to-camel conversion). **Decision on
  void-return ops** (core_memory_append/replace, archival_memory_insert):
  return `{content: []}` (empty content array). §3.6 "no TS-side
  reformatting" + pymemgpt's underlying `Agent.*` methods return `None`,
  so fabricating a synthetic success string would invent a wrapper at the
  wrong layer — OpenClaw's envelope already wraps the tool result. The
  pymemgpt `package_function_response` JSON wrapper is at the wrong
  architectural level for Shape B (it's pymemgpt's loop's job; OpenClaw is
  now the loop). **`tools/sendMessage.ts`** — the §4.3 output tool (only
  tool reaching the user, only tool with no sidecar endpoint); handler marks
  a turn-termination suppression flag and returns `params.message` verbatim.
  **Suppression-key design correction (impl revealed):** §4.3's pseudocode
  references `ctx.sessionKey` from `execute`, but the current SDK `.d.ts`
  exposes only `(toolCallId, params)` — no `ctx`. Since §4.3 explicitly
  scopes V1 to single-session, used a `SUPPRESS_V1_KEY` module-level
  sentinel on both halves of the seam (this file marks; 6c.7's
  `reply_dispatch` hook will take). Map-keyed `markSuppress` / `takeSuppress`
  shape preserved so the V2 switch to real sessionKeys is a key change, not
  a re-architecture. `tools/index.ts`: seven `api.registerTool` calls each
  combining `{...schema, execute: handler(deps)}` — single source of truth
  for registration order; surfaces add/remove of a tool in one place.
  **`src/index.ts` wiring**: `register(api)` parses config → constructs
  `SidecarClientImpl` → builds `ToolDeps` → calls `registerTools(api, deps)`
  and returns; no `api.on(...)` listeners yet (hooks are 6c.4–6c.7). 29 new
  tests under `tests/tools/`. **Side finding (d-class fix landed separately
  as `7c0c25f`):** `npm test`'s `tests/**/*.test.ts` glob worked under zsh
  (recursive globstar) but bash (which npm scripts use) treats `**` as `*`,
  so when `tests/tools/` landed the flat `tests/*.test.ts` files (45 tests)
  silently dropped from the run. Fixed to two explicit depths
  `tests/*.test.ts tests/*/*.test.ts`. 74/74 tests pass.

- **6c.4 ✅** — `before_prompt_build` hook per §4.2, the first event hook the
  plugin wires + the consumer for the 6c.1 per-turn-`via` deviation.
  `src/hooks/promptSection.ts` registers `api.on("before_prompt_build", ...)`.
  Two steps per turn, in order: (1) `ensure` — surfaces unexpected residency
  changes (e.g. sidecar restart eviction → `via:"load"` instead of expected
  `via:"resident"`) so the §6.2 detection-rate metric can discriminate; (2)
  `getSystemPromptSection` — the correctness path. Returns
  `{prependSystemContext: section.static, prependContext: section.dynamic}`.
  Static = adapted base prompt (~5KB, cacheable across turns; preset-driven).
  Dynamic = persona/human/counts/timestamp. **Error asymmetry — task-vs-spec
  resolved against §4.2:** `ensure` failure → `logger.warn` + emit
  `emit_failed` event + SWALLOW; `getSystemPromptSection` failure →
  `logger.error` + RE-THROW. Telemetry-vs-correctness split. 12 new tests
  under `tests/hooks/`. 86/86 tests pass.

- **6c.5 ✅** — `agent_end` hook per §4.5 + the awaited per-turn `:save` per
  §2.3. Two new files. `src/hooks/triggers.ts`: `isNonInteractiveTrigger` +
  `isSubagentSession` shape-verbatim from `@mem0/openclaw-mem0`'s
  `mem0/openclaw/isolation.ts`. `src/hooks/mirror.ts`:
  `registerAgentEndHook` wires `api.on("agent_end", ...)`. Four guards
  (Mem0 capture-handler precedent + §4.5 prose): `event.success`,
  `event.messages?.length`, `isNonInteractiveTrigger`, `isSubagentSession`.
  **Per-turn, not per-message — the §4.5 declared deviation.** Native MemGPT's
  `append_to_messages` fires per message mid-turn; here the turn's messages
  land in `pm.all_messages` atomically at turn end. Within-turn recall of
  same-turn messages is unavailable in the composition; cross-session
  recall (the property the dissertation tests) is unaffected.
  **Mirror-then-save order is correctness, not aesthetics.** `:save` reads
  in-memory state; reverse the order and the just-finished turn's messages
  aren't yet in `pm.all_messages` when the pickle is written. **§3.7
  normalisation boundary first consumed here** (the 6c.2 invariant becomes
  load-bearing). **Error asymmetry:** mirror failure → RE-THROW; save
  failure → SWALLOW. 13 new tests under `tests/hooks/`. 99/99 tests pass.

- **6c.6.0–6c.6.4 ✅** — flush mechanism. **6c.6.0**: design-question closure
  reading installed OpenClaw v2026.4.21 plugin-SDK typings; resolved token
  source (`SessionEntry.totalTokens` not the hook event), session-store API
  (`api.runtime.agent.session.{load,save}SessionStore`), multi-handler
  dispatch (priority-sorted; Mem0 registers `before_prompt_build` twice).
  **Surprise:** `SessionEntry` pre-bakes plugin-coordination fields —
  `memoryFlushAt`, `memoryFlushCompactionCount`, `memoryFlushContextHash` —
  for plugins like ours. **6c.6.1**: flush-pressure trigger predicate.
  `src/hooks/sessionStore.ts`: access helpers. `src/hooks/flushPressure.ts`:
  `registerFlushPressureHook` (initially `before_prompt_build`, later
  refactored). 112/112 tests. **6c.6.2**: `:summarize` glue + `getStats()`
  round-trip. **6c.6.3**: 5-field flush-metadata write
  (memoryFlushAt, memoryFlushCompactionCount, memoryFlushContextHash,
  memoryFlushCutoff, memoryFlushPackagedMessageJson) + recall mirror of
  packagedMessage. 126/126 tests. **6c.6.3b**: trigger refactor (`8e2634e`):
  moved flush from `before_prompt_build` to `llm_output` (token capture into
  module-level Map) + `agent_end` (threshold check + :summarize + metadata
  write). API_DESIGN.md §4.4 updated; same test count. **6c.6.4**:
  `src/contextEngine/memgptEngine.ts` — ContextEngine registered
  (`ownsCompaction: false`). `assemble()` reads flush metadata; if
  `hasAlreadyFlushedForCurrentCompaction(entry)` + both `memoryFlushCutoff`
  + `memoryFlushPackagedMessageJson` present → returns
  `[parsePackagedMessage(json), ...messages.slice(cutoff)]`. 14 new tests /
  141/141 total.

- **6c.7 ✅** — `reply_dispatch` hook per §4.3 / S0.1 mechanism. Reads V1
  suppression flag; on hit, calls `ctx.recordProcessed("skipped")` +
  `ctx.markIdle(...)` and returns `{handled:true, queuedFinal:false,
  counts:...}` to swallow the LLM's trailing natural reply. **Always clear
  flag FIRST — before any guard returns.** Single-shot semantics: one
  `markSuppress` consumed by exactly one `takeSuppress`. Event/ctx shape
  confirmed against `hook-types.d.ts:110/125`.

- **6c.8 ✅** — lifecycle teardown per §6.3. `registerService` registration
  in `src/lifecycle/teardown.ts`: `start` is a no-op (no spawn in attach
  mode); `stop` awaits a final `client.save()` on shutdown. Bound after
  reading `services-CLs267o9.js` for the exact contract: `stop?` is
  optional, awaited in OpenClaw shutdown only, fires in reverse registration
  order, failures swallowed (logged as warnings, not re-thrown). V1
  topology is attach-only; spawn moves to 6c.10.

### 6c.9 — Vertical slice (the milestone)

- **6c.9.0 ✅** — OpenClaw setup + plugin loading on `feat/vertical-slice`.
  Plugin discovered via `package.json` → `openclaw.extensions` array;
  loaded via built-in jiti runner (no compilation needed). Install requires
  `--dangerously-force-unsafe-install` (child_process in test files triggers
  safety scanner). All four string config fields defaulted so the plugin
  installs without a config block. `package.json` gained `"build": "tsc
  --noEmit"` script. `config.ts` hardened (null/undefined → empty config;
  `requireString` → `stringWithDefault` with defaults for all four fields).
  `openclaw.plugin.json` `configSchema` had `"required": ["namespace"]`
  removed + `"default": "default"` added. 157/157 tests pass (1 skipped).

- **6c.9.1 ✅** — Single-turn smoke test. **Three fixes required (all
  committed):** (1) `proxy_shim.py`: added Anthropic SSE streaming
  synthesis — shim previously ignored `stream:true` and returned
  non-streaming JSON; LiteLLM discarded the content when it expected SSE;
  shim now strips `stream:true`, calls upstream non-streaming, synthesises
  correct Anthropic SSE event sequence from the complete response. (2)
  `models.json` (non-repo): added explicit `gpt-5.4` entry under `openai`
  provider with `api: "openai-completions"` — without this, OpenClaw's
  `resolveOpenAIGpt54ForwardCompatModel` auto-discovers it as
  `openai-responses` (hitting `/v1/responses` which LiteLLM doesn't serve);
  `openai-completions` hits `/v1/chat/completions`. (3) `models.json`:
  added `request.allowPrivateNetwork: true` to `openai` provider + changed
  baseUrl from `localhost` to `127.0.0.1`. **Smoke test result:** plugin
  log line confirms registration; `finalPromptText` contains full MemGPT
  memory section (persona/human/recall/archival counts); `toolSummary`
  shows `send_message` called with 0 failures; `agent_end` mirror+save
  confirmed (recall count 39→59, pickle written at turn end). Commit
  `1fbff3c` on `feat/vertical-slice`.

- **6c.9.2 ✅** — Multi-turn single-session: normalise.ts flattenContent
  + promptSection's repairTrailingEmptyAssistant. See methodology-bank.md
  for full finding.

- **6c.9.3 ✅** — Cross-session recall verified across sidecar restart.
  Three orthogonal properties confirmed (rehydration, index integrity, agent
  reasoning). See methodology-bank.md for full finding.

- **6c.9.4 ✅** — `send_message` text recall-searchability resolved as
  Scenario A: user-facing text lands in `toolResult`-role `message.content`,
  not in `function_call.arguments`, and is recall-searchable. V1 attack
  model reaches injections delivered via `send_message` payloads. See
  methodology-bank.md for full finding and API_DESIGN.md §2.10/§4.3 for
  the canonical spec statement.

---

## Release log

- **`vertical-slice-verified`** (plugin-`main`, `03b393f`) — 6c complete;
  162/163 tests pass + 1 integration-skip; cross-session recall verified
  (§4.5 load-bearing property); send_message Scenario A confirmed
  (§2.10/§4.3); 6b + 6c.0–9 landed (58-commit advance); seven V2 follow-ups
  banked (see [docs/v2-followups.md](v2-followups.md)).

- **6b release on fork-`main`** (`0c31f10`) — proxy-shim relocate completion
  (`sidecar/` package removed; litellm gitignore tidy). No source-level
  memgpt/** changes.

- **`sidecar-api-verified`** (plugin-`main`, merge commit recorded at the
  6a release) — 6a complete; 93/93 tests; both fork touchpoints consumed;
  D1–D4 declared deviations documented in API_DESIGN.md §2.3/§2.5/§2.6/§2.8.

- **`cutoff-factoring-verified`** (fork-`main`, `e2c8c93`) — F1:
  cutoff-selection factoring, 5/5 equivalence tests, baseline diff vs
  `f46cc3b` empty.

- **`recall-reference-repair-verified`** (fork-`main`, `109817c`) — F2:
  recall reference-repair at `LocalStateManager.load`, 3/3 tests incl.
  toggle-the-line, baseline diff vs `f46cc3b` substantively empty.
