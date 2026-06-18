# Methodology bank

Non-obvious findings surfaced during the build of the OpenClaw-MemGPT vertical slice
(Phase 6c.9). Each entry records a moment where intuition or the design hedge proved
wrong against source, and what the actual mechanism turned out to be. Banked here as
dissertation evidence for the claim that faithful reproduction of an undocumented
system requires baseline source checks at every step.

This file is referenced from `CLAUDE.md` (gitignored operating manual) but stands on
its own — read it without other context.

---

## "Almost certainly X" was wrong — twenty-three instances

Each entry: the assumed behaviour, the actual mechanism revealed by source, and the
shape of the resolution. Listed in roughly the order they surfaced.

1. **Persistence model.** MemGPT's CLI persists only on `/save` or `/exit`, not per
   turn. The 6a sidecar design assumed per-turn persistence on the (correct) grounds
   that an HTTP service can't rely on a process-end save; the deviation from CLI
   behaviour is principled but had to be named explicitly (declared deviation D1 in
   §2.3) once source showed the CLI itself didn't do this.

2. **Archival paging.** `EmbeddingArchivalMemory.search`'s page-local `total`
   (always "N of N (page p/0)", `num_pages` always 0) looked like a migration bug
   from the llama-index upgrade. Source check at `f46cc3b:memory.py:726` showed it
   was native MemGPT behaviour at baseline. Not a regression; faithful to upstream.
   Documented as a §2.5 fidelity finding rather than patched. Recall paginates
   correctly by contrast.

3. **Recall parse.** `json.loads` on the recall search's formatted-array tail was
   hypothesised as a failure mode for embedded quote characters. Source check
   showed `Agent.recall_memory_search` uses `json.dumps` to serialise the array,
   so the round-trip is safe by construction — the producer/consumer pair is the
   §2.1 layer-cut.

4. **`summary_length` semantics.** §2.8's example value (`87`) implied a word
   count. `package_summarize_message`'s template at `system.py` showed the second
   positional argument is a *message count* — the template literally reads "the
   following is a summary of the previous N messages". Source resolved an
   ambiguous example to a faithful definition; §2.8 example value updated to
   `23` with the semantics note.

5. **F2 reference-repair.** The recall `_message_logs` divergence at load was
   hypothesised as an always-broken bug. Implementation revealed: pickle
   preserves object identity within a single dump call, so the happy-path
   save/load cycle preserves the reference incidentally. The repair is
   invariant-hardening against divergence-before-save (a future code path
   rebinding either reference independently), not a fix for a path that always
   breaks. Subtler than the bug-fix framing.

6. **Recall search role-filter.** The original 6a acceptance test queried
   "system" expecting boot messages. `DummyRecallMemory.text_search` at
   `memory.py:517` filters out `role=="system"` AND `role=="function"` — only
   user/assistant content is in the search pool. The test would have passed
   silently with "No results found." on both arms had the non-emptiness
   assertion not been included. Query changed to "Bootup" (assistant boot
   content, in-pool). Source revealed the test was probing a filtered-out role
   rather than the recall search itself.

7. **OpenClaw SSRF guard.** Assumed `allowPrivateNetwork: true` in the openai
   provider config was sufficient to reach `127.0.0.1`. Both `localhost` and
   `127.0.0.1` were blocked. The fix: the explicit model entry must carry the
   transport symbol correctly; auto-discovered models don't. Provider-level
   `allowPrivateNetwork` only takes effect once the model's request-policy
   resolution sees the symbol.

8. **gpt-5.4 endpoint auto-discovery.** OpenClaw's `resolveOpenAIGpt54ForwardCompatModel`
   hardcodes `api: "openai-responses"` even for custom `baseUrls`. So an unspecified
   model would hit `/v1/responses` (which LiteLLM doesn't serve), not
   `/v1/chat/completions`. Fix: explicit model entry under `openai` with
   `api: "openai-completions"`.

9. **Proxy shim streaming.** Assumed the non-streaming pass-through was fine since
   the shim's docstring read "pass through". LiteLLM sends `stream: true` for all
   agent LLM calls; a non-streaming upstream response caused LiteLLM to emit an
   empty streaming wrapper with no content. Fix: shim strips `stream: true`, calls
   upstream non-streaming, synthesises the Anthropic SSE event sequence from the
   complete response.

10. **`livenessState: "abandoned"` after `send_message`.** Initially read as a
    regression after 6c.9.3 worked. Source check showed it's been the same
    documented CLI artefact since 6c.9.2/9.3: `send_message` isn't in
    `CORE_MESSAGING_TOOLS = {"sessions_send", "message"}`
    (`attempt.tool-run-context--CUdbb6u.js:27`), so `messagingToolSentTexts`
    stays empty, `hadDeterministicSideEffect` is false, and the LLM's "toolUse"
    stopReason combined with no visible text triggers `replayInvalid` →
    `abandoned`. The CLI summary is a false-negative on every `send_message`
    turn; verify success via session JSONL + recall growth instead. Banked as
    the "upstream fix" V2 follow-up.

11. **`registerService.start` is optional in the type but required in
    practice.** 6c.8's `teardown.ts` registered a stop-only service on the
    declared rationale that `start?` is optional in the SDK's `.d.ts`. 6c.10a's
    SDK read showed the runtime call-site (`services-CLs267o9.js:30`) is
    `await service.start(serviceContext)` — no `?.` guard. A missing `start`
    therefore TypErrors at `await undefined(...)`, the runner's try/catch
    swallows it as a "plugin service failed" warning, and the matching
    `running.push({...stop})` is **never executed**. The 6c.8 plugin teardown
    contract was therefore silently never wired: `stop` did not fire on
    OpenClaw shutdown for any of the V1 vertical-slice / Stage-3 verification
    runs. Why we didn't notice: the `agent_end` hook persists per turn (§4.5
    declared D1 deviation), so the on-disk state was always at most one turn
    behind the in-memory state; the teardown save is a belt-and-braces close
    of an effectively empty window. The bug was real and bit every run; it
    did not affect data integrity because per-turn save covered the gap. Fix
    in 6c.10b: `LifecycleManager` exposes both `start` (the spawn-and-poll
    path) and `stop` (the save+SIGTERM path). Source-read lesson: an
    optional-in-`.d.ts` is a documentation claim, not a runtime guarantee —
    confirm against the call-site before trusting it. Same shape as
    instance 5's reference-repair (optional-in-source but load-bearing in
    practice).
    
12. **Wire format as controlled variable.** V1.3 setup hit a blocker: Cell A's
    pre-v1 MemGPT emits OpenAI Chat Completions with legacy `functions` /
    `function_call` / role=function messages; LiteLLM's
    `litellm/llms/anthropic/` translation produces a `tool_result` block whose
    `tool_use_id` has no corresponding `tool_use` in the preceding assistant
    turn, and Anthropic rejects with *"tool_result block without corresponding
    tool_use"*. Cell C does not hit this — its `normalise.ts` produces modern
    `tool_use` / role=tool shape, which LiteLLM translates cleanly. V1.0 §3
    therefore claimed "Both cells exercise the identical wire format upstream"
    on intuition rather than source; the claim is empirically false.

    **What's actually controlled.** The *served model* (Claude Sonnet 4.5 via
    the institutional Bedrock gateway), not the request envelope.

    **Empirical check.** Single-probe equivalence test, two payloads carrying
    the same conversation semantics (`"my project codename is PINEAPPLE_8101"`
    → `store_fact` call → tool_result `"stored"` → `"what codename did I
    mention?"`):
    - **A1.** Modern OpenAI Chat Completions with `tools` (Cell C shape) →
      LiteLLM:4000 (OpenAI→Anthropic translation) → shim:4100 → Bedrock.
    - **A2.** The same conversation, hand-translated to valid Anthropic
      Messages with matched `tool_use`/`tool_result` IDs (Cell A shape, as
      MemGPT's Functions log would translate if the translator worked) →
      shim:4100 → Bedrock, bypassing the broken LiteLLM translator.

    Both responses converged on `PINEAPPLE_8101` with token-identical input
    (701/701), no tool re-invocation on the follow-up (in-context recall in
    both), and output-token deltas of one (22/21) — well inside single-token
    noise. Raw responses captured in `/tmp/wire-format-check.md`.

    **Re-verified at Claude Haiku 4.5 (2026-06-09).** Served model switched
    to `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (institutional Bedrock
    gateway, LiteLLM entry updated). Same A1/A2 pair re-run unchanged: both
    arms emitted **byte-identical** response text with token counts identical
    on both axes (701/21 both arms) — strictly stronger than the Sonnet 4.5
    baseline (which had a 1-token output delta and near-identical phrasing).
    Wire-format finding holds and tightens at the new served model. Raw
    responses appended to `/tmp/wire-format-check.md`.

    **Implication.** The finding strengthens the §7 equivalence claim rather
    than weakening it: V1's §7.3 dimensions measure agent-loop decisions
    (tier choice, tool selection, send_message routing) that are downstream
    of any single LLM response and robust to envelope variance. The cost is a
    small V1.0 refinement (§3 rationale retraction, new §4.5 declared
    deviation, new §6.5 ladder rung).

    **Residual confound (declared, not hidden).** Single-probe, single-trial.
    The check shows wire format *can* be non-material on a representative
    fact-recall pair; it does not prove envelope variance is *always*
    non-material across richer multi-turn probes. V1.4 normalisation should
    still inspect §7.3 divergences for structural-envelope signatures before
    counting them as architectural divergence. Pattern: experimental design
    that names a variable as "controlled" needs the same empirical check as
    code that names a behaviour as "the path is via X" (instance #11) —
    intuition-level controlled-variable claims fail the same way as
    intuition-level mechanism claims.

13. **`OPENAI_API_BASE` is load-bearing on `v1-cell-a`; `~/.memgpt/config`'s
    `model_endpoint` is decorative.** `memgpt configure` writes the value and
    presents it interactively, suggesting it controls the LLM endpoint. It
    doesn't — `openai_tools.py:8-14` reads `OPENAI_API_BASE` from env at module
    import time, and the OpenAI 0.28.1 SDK module-global `openai.api_base` is
    set from there only. `~/.secrets` setting `OPENAI_API_BASE=http://localhost:4000/v1`
    for the V1.0 LiteLLM setup transparently bypassed the Cell A adapter for the
    entire smoke-test session until the env var was overridden in the MemGPT
    terminal. The config's `model_endpoint` field is presented faithfullyon read
    but never wired through on this branch.

14. **Model self-identification is unreliable; trust response metadata.** When asked
    "what model are you?", Anthropic Claude Haiku 4.5 (served via institutional Bedrock
    proxy at `eu.anthropic.claude-haiku-4-5-20251001-v1:0`) responds "Claude 3.5 Sonnet"
    — a training-data-conditioned self-claim, not its actual identity. The authoritative
    identifier is in the institutional upstream's response metadata (`model` field), not
    the model's textual self-claim. Verified by behavioural fingerprint: `gpt-5.4`
    (configured to route to Haiku 4.5) produces materially different output style and
    length than the explicit Sonnet 4.5 entry on the same prompt, ruling out routing
    failure. For identity verification of served models in V1.3+, rely on the `model`
    field of response metadata or distinct behavioural fingerprints, never the model's
    self-claim.

15. **Claude Haiku 4.5 does not chain `send_message` after memory tool calls in MemGPT'spre-v1 agent loop.**
    Sanity probe p1 ("Please remember that I'm working on a dissertation about AI memory
    architectures.") was run through Cell A's chain with Haiku 4.5 as served model. The agent
    invoked `core_memory_append` with the correct tier choice, but set `request_heartbeat=False`
    explicitly in the tool arguments — opting not to chain a confirmation `send_message`. The boot
    turn (system-initiated welcome) fired `send_message` cleanly, demonstrating the model can call
    the tool when prompted by the loop's seed; it just does not autonomously chain after memory
    tools. Send_message discipline (V1.0 §5 dimension at 100% threshold) is broken at Haiku 4.5
    in this loop pattern. Pickle evidence: `agents/agent_9/persistence_manager.pkl` entries [7]-[9].
    
    **Implication:** V1 cannot be run against Haiku 4.5 with the current Cell A chain. The
    dissertation's claim is about _architectural_ equivalence; if the underlying model is below
    the discipline-discrimination threshold, behavioural divergence between cells would conflate
    model-capability gaps with architectural gaps. Sonnet 4.5 reverted as served model per
    V1.0 §5's fallback rule.
    
    This is a finding about Haiku 4.5's prompt-following at this specific multi-step discipline,
    not a finding about MemGPT's design. Sonnet 4.5 and other Claude models (presumably) maintain
    the chain; that question is left for a future cross-model robustness study.

16. **Manual `memgpt run` fires a boot turn; programmatic wrapper does not.** Manual CLI invokes
    `agent.step()` once at startup (before user input) to surface MemGPT's "first login" welcome
    via send_message. Programmatic wrapper (`run_single_turn_trial`) skips this and goes directly
    to the probe message. Both invoke paths exercise the same agent-loop architecture; the boot
    turn is a CLI UX convention. V1.4 normalises by comparing probe-response sub-sequences rather
    than full message lists. Documented as expected divergence between manual and wrapper
    invocation patterns; not a wrapper bug.

17. **Cell A wrapper-vs-CLI dry-run has two expected non-architectural divergences.**
    (a) **Boot turn divergence.** Manual `memgpt run` runs an extra `agent.step()` in
    response to the synthetic `get_login_event` user message that
    `initialize_message_sequence` (`agent.py:80`) injects after the initial boot
    `send_message`; the programmatic wrapper skips this and goes straight to the
    probe (mechanism described in entry #16). Normalised at diff time by
    `pickle_diff.py --skip-boot`, which drops everything in `all_messages` before
    the first probe-user-message (`type=user_message`) on each side. Dry-run
    rerun (2026-06-10, probe p1, Sonnet 4.5 at `temperature: 0`) dropped 5 prefix
    entries from the CLI side and 3 from the wrapper side — the 2-entry
    asymmetry is exactly the welcome turn (assistant `send_message` + matching
    function result). Diff result: `experiments/v1-runs/dry-run/diff-structural-temp0.json`.

    (b) **Content stochasticity at temperature 0.** Anthropic Claude Sonnet 4.5 exhibits residual
    sampling variance at `temperature: 0` (configured in `litellm_config.yaml` for `gpt-5.4` model
    entry as of 2026-06-10). Empirical measurement from V1.3 dry-run re-runs of probe p1: 0
    structural divergences, 3 content-aware divergences. All content divergences are prose
    paraphrases at the inner-monologue and send_message text level (estimated Jaccard 0.5-0.7
    over content-word tokens). No tool-name, tier, or function-call arg-key variance. The
    `--structural-only` mode in `pickle_diff.py` normalises content fields to sentinels for
    gate-level comparisons where content equivalence is not the load-bearing test. V1.4 uses
    Jaccard ≥0.5 (per V1.1 §3.2) for monologue substantive equivalence, which is calibrated
    comfortably above this measured noise floor.

18. **(superseded by #23 — held unresolved for p4) — p4 cross-turn observed behaviour at Sonnet 4.5.**
    Across 5 Cell A trials, turn 1 (codename fact) elicited `core_memory_append` without chained
    `send_message` (similar pattern to methodology #15 for Haiku 4.5, but emerging here on Sonnet 4.5).
    Turn 2 (codename recall) read from active context rather than invoking `conversation_search`.
    The path-agnostic design of p4 (V1.2 §refinement) tolerates this; V1.4 measures cell-to-cell
    agreement on the chosen path, not a specific path.

    **Disposition (2026-06-17, post-pilot).** #18 cannot graduate as a "Sonnet-4.5-at-temp-0
    architectural property reproduced by Cell C," and is not cleanly rejected either. The V1.3
    apparent p4 divergence (Cell A core/active-context vs Cell C recall-heavy) is now attributed to
    **#23** — a persona/human controlled-variable violation, the same confound that demonstrably
    drove p5's divergence (see #23 pilot evidence: p5 tier-agreement with Cell A rose from ~4/10 to
    6/6 once the §3 strings were restored). The corrected-persona p4 pilot could **not** validate
    convergence because that run was contaminated by #19 (lazy-init stock-tool coexistence: the
    agent called stock `exec` and replied in free text without `send_message` on 4 of 5 trials).
    #18 therefore remains open for p4 pending a clean, uncontaminated, full-budget p4 re-run; the
    behaviour it described is most likely a #23 artefact, not an architectural property.

    **Disposition (2026-06-18, V1.4 final — REJECT).** The clean, full-budget p4 re-run is now in hand
    (5 trials, corrected §3 persona, direct chain; the run was *not* #19-contaminated — the sidecar
    spawned and the MemGPT prompt was injected on every turn, confirmed in the trial logs). The analyser
    scores Cell A matching its own dominant p4 pattern **3/5** and **Cell C matching it 0/5** →
    `graduation_verdict: reject`. The p4 divergence is **real and reproduced across both providers**
    (institutional and direct, see #24), so it is *not* the #23 persona confound (unlike p5). But it is
    **not** a memory-architecture difference either: Cell C's p4 misses are free-text acknowledgments
    (`other([]) | other([])`, 2/5) and stock-tool reaches (`read`/`write`/`exec`, 1/5) on the
    bare-declarative turn-1 ("The project code is BLUEBIRD_5402.") that does not compel a memory op.
    That is the **same I/O-layer gap as #25** (OpenClaw permits free-text replies and exposes stock
    tools MemGPT never had), surfacing on the one probe whose phrasing gives the model an out. #18 is
    therefore **rejected as a memory-architecture property and re-attributed to the #25 I/O-layer
    divergence**; Cell C's *recall* behaviour on p4 turn-2 (active-context read, no `conversation_search`)
    does match Cell A on the trials that reach it.

19. **OpenClaw SDK `--local` mode does not fire `services.start`.** Plugin's `register()` runs
    (tools/hooks/ContextEngine all wire up, "lifecycle service registered" logs cleanly) but
    the SDK's service runner never invokes `LifecycleManager.start`. First tool/hook call
    surfaces "lifecycle not started", at which point the local-mode agent silently falls back
    to stock OpenClaw tools (`read`/`write`/etc.) and the trial returns `exit 0` despite the
    plugin never having touched the sidecar.

    **Source confirmation.** `startPluginServices` is imported and awaited at exactly one
    site: `server.impl-DLF59fRo.js:21287`, inside the gateway server startup path. The
    `agent-command-*.js` bundle and the `--local` dispatch path do not reference it.
    `run-main-CTb0YOht.js:152` only collects `--local` as a flag value; the dispatch is
    gateway-only or local-only based on it, and local skips startup-trace's
    `sidecars.plugin-services` stanza entirely.

    **Symptom signature.** Trial logs show the plugin's `register()` log line ("lifecycle
    service registered (namespace: …)") followed immediately by repeated "lifecycle not
    started" errors on every hook (`agent_ensured emit failed`, `getSystemPromptSection
    failed`, `before_prompt_build handler failed`, `core_memory_append failed`,
    `messagesAppend failed`, `agent_end handler failed`). The agent's `toolSummary`
    nevertheless reports `success` with stock tools chosen — diagnostic gold for
    distinguishing this from a sidecar-down failure (which would surface "sidecar process
    died" instead).

    **Fix.** `LifecycleManager.resolveBaseUrl` is now `async`; when called with neither
    `spawnedUrl` nor `attachUrl` set and `_dead` false, it triggers `start({})` via a
    singleton `lazyStartPromise` (race-protected against concurrent first calls) and awaits
    it. Empty `ctx` is handled by `resolveStateDir`'s env + homedir fallback chain
    (`OPENCLAW_STATE_DIR` → `~/.openclaw-dev`). `start()` itself carries a `this.started`
    idempotency guard at the top so the gateway and lazy paths can't double-register
    sidecar state — when the SDK eventually fires `services.start` the lazy path becomes a
    no-op. Unit-tested at `tests/lifecycle/lifecycleManager.test.ts`: (a) lazy-init fires
    when neither URL set (attach mode); (b) concurrent first calls share one start
    (spawn-count = 1 across `Promise.all([resolveBaseUrl, resolveBaseUrl, resolveBaseUrl])`);
    (c) explicit `start()` short-circuits subsequent resolveBaseUrl calls.

    **Trade-off documented in code.** The 120 s spawn-mode healthz block now lives at
    first-turn (attach-style entry) rather than gateway startup. For interactive `--local`
    use this is a one-time first-turn wait; for V1.3 per-trial-spawn it adds ~60–90 s to
    each trial's wall-clock (embedder is disk-cached but uvicorn + `:ensure` round-trip
    still costs). Acceptable for V1 acceptance.

    **Significance — real fix, not V1 workaround.** Ships in the plugin because (a) any
    future user running `openclaw agent --local` against this plugin would hit the same
    "lifecycle not started" wall, (b) the upstream SDK bug may never be fixed, (c) the
    fallback is defensive and idempotent — when the SDK does fire `services.start`, the
    explicit start path wins and the lazy path's idempotency guard makes it a no-op.

    Same pattern as #11 (the optional-in-`.d.ts` `start?` that was load-bearing in
    practice): the SDK's documented contract (services-start fires per registered service)
    holds in one dispatch path but not the other; verifying mechanism by source-read at the
    call site, not by `.d.ts` inspection, is the only safe ground.

20. **#20 — Plugin's normalise.ts dropped tool-call structure from persistence layer; latent defect masked by send_message text survival.**
    
    **Discovery.** V1.4 analyser construction surfaced that all 45 Cell C trial JSONs from V1.3 had
    `tools_by_step=[]`, `monologue_by_step` text empty, `send_message_calls=[]`. Cell A's 45 trials were complete and clean.
    
    **Root cause.** `src/normalise.ts` was written against an assumed OpenClaw message shape
    (`assistant.tool_calls[]` + `role=tool`). OpenClaw's actual runtime shape is `role=assistant`
    with `content=[{type:"text"},{type:"toolCall",...}]` blocks, plus `role=toolResult` with
    `content=[{type:"text"}]`. The "everything else" rebuild branch in normalise fires on every entry,
    dropping `toolCall` content blocks (only `text` survives `flattenContent`) and preserving the foreign
    `role=toolResult`. The sidecar pickle's `all_messages` therefore carries: assistant entries with
    `content=""` and no `function_call`; `toolResult`-role entries with just the result text. Tool names,
    function-call argument shape, and assistant monologue are never persisted.
    
    **What 6c.9 actually verified.** The vertical-slice work in 6c.9 verified specific user-facing properties
    — cross-session recall returned marker text (6c.9.3); send_message text appeared in recall search
    (6c.9.4 Scenario A). These properties are *real* and remain verified — the marker text *was* retrievable
    across sessions, send_message text *was* in the recall corpus. What was *not* verified, and could not
    have been with 6c.9's probe set, was whether the broader conversational context (tool calls, arguments,
    monologue prose) also survived. The 6c.9 probes only required send_message-text survival, which happens
    to be the one thing that does survive the defective normalise path (via `flattenContent`'s text extraction).
    The masking was complete: there was no surface signal indicating the broader structural loss.
    
    **Why this matters for V1.4.** V1.4's equivalence test requires comparing tool invocation, tier reasoning,
    and monologue across cells. These dimensions read from the persisted pickle data, which Cell C does not
    produce. Without the V1.4 attempt, the defect would have shipped silently into MINJA experiments;
    attack-vector measurements against an architecturally-incomplete Cell C would have been uninterpretable.
    
    **Path forward — chosen and applied (2026-06-17).** Path 1 (direct normalise.ts fix) selected
    over Path 2 (JSONL-source extractor) because Path 1 keeps the §3.7 invariant — sidecar sees v0
    shape only — and produces pickle parity with Cell A, which V1.4's extractor reads. Path 2 would
    have left the persisted pickle wrong indefinitely; Path 1 fixes the persistence-layer truth.
    
    **Fix applied.** Two file-level changes to `src/normalise.ts`:
    
    1. **toolResult role recognised.** Added a branch translating pi-ai `role: "toolResult"` (with
       `toolName` + content-blocks array) to v0 `role: "function"` (with `name` + flattened string
       content). The legacy `role: "tool"` branch is retained for backward compatibility.
    2. **Inline `toolCall` content blocks recognised.** Added a per-message branch for the
       single-toolCall case (assistant content array containing one `{type:"toolCall"}` block →
       assistant with `function_call`, arguments JSON-stringified since pi-ai uses `Record<string,any>`
       and v0 expects a string).
    
    **Discovered during smoke testing, also surgical** (the V1.4 rig fix's "X was wrong" finding within
    the fix itself): the per-message single-call path was insufficient. Sonnet 4.5 emits 2–3 toolCalls
    in a SINGLE assistant message (`[text, toolCall(core_memory_replace), toolCall(archival_memory_insert),
    toolCall(send_message)]`); the original normalise's "multi-call: warn + keep first" policy silently
    dropped `send_message` and any subsequent calls — turning a complete chain into a single tool with
    no LLM reply. The assumption "MemGPT's prompt regime should not generate multi-call assistant
    messages in practice" was false. Fix: array-level `normaliseMessages()` now splits multi-toolCall
    assistant messages into N (assistant, function) pairs, pairing toolResults to toolCalls by
    `toolCallId` (not adjacency, so robust to future pi-ai emission-order changes). The per-message
    `normalise()` retains its warn+keep-first semantics for direct single-message callers; the
    array-level path handles multi-call correctly.
    
    **Companion driver fixes** (`experiments/v1-runs/driver.py`):
    
    1. **Per-trial JSONL capture** — defensive belt-and-braces. After each trial completes, copy the
       OpenClaw session JSONL into the trial dir (`cell-c-<id>.jsonl` for single-session, `-s1.jsonl` +
       `-s2.jsonl` for cross-session). The JSONL is OpenClaw's structured event-stream truth (toolCall
       blocks, toolResult content, timestamps) — keeping a per-trial copy means future V1.4-grade rig
       fixes can validate the projection without needing fresh trial runs.
    2. **Fresh-state resets per trial** — required to make re-runs valid. Wipe the sidecar's agent
       data dir (`~/.openclaw-dev/memgpt-data/agents/<namespace>/`) and OpenClaw's session-store
       (`~/.openclaw-dev/agents/main/sessions/*.jsonl` + `sessions.json`) before each trial. Surfaced
       during smoke testing: without the wipes, a re-run hits the prior slate's namespace via the
       sidecar's `:load` path and inherits 20+ accumulated turns instead of starting `:create` on
       fresh state. Also: OpenClaw `--local` mode appends to the most-recent JSONL regardless of the
       `--session-id` flag — wiping forces a fresh file named after the new session-id, which makes
       JSONL capture deterministic.
    
    **Test coverage delta.** `tests/normalise.test.ts` grew from 26 to 46 cases (+20):
    
    - 6 cases for the new `toolResult` role branch (with toolName, with name fallback, no name,
      empty content array, string content, idempotency)
    - 9 cases for inline `toolCall` content blocks (text + toolCall, toolCall-only, multi-call
      warn-keep-first at per-message, string-form arguments drift, missing arguments, idempotency,
      thinking-block drop, real-world V1.3 cell-c trial shape round-trip)
    - 5 cases for array-level `normaliseMessages` multi-call split (N-split with toolResult pairing,
      missing toolResult → emit assistant alone, pairing by id not order, single-call delegation
      unchanged, idempotency on split output)
    
    All 46 cases pass; the surrounding suite (190 tests) shows no regressions from the change
    (the one pre-existing failure is `flushPipeline.integration.test.ts` requiring `OPENAI_API_KEY`
    in the test environment, unrelated to normalise).
    
    **Result.** Post-fix V1.3 slate re-run (45 Cell C trials, ~46s per trial including embedder
    cold-start): all four V1.4 dimensions populated across all 45 trials —
    
    - Tools: 45/45 with at least one tool invocation
    - Monologue: 45/45 with non-empty assistant content
    - send_message: 45/45 with at least one `send_message` call captured
    - JSONL: 45/45 (plus 10 extra `-s1.jsonl` files from p5's cross-session trials)
    
    The four "zero-tier" trials are all p7 (degenerate "Hello." probe — `expected_tier: N/A`,
    correct restraint: just `send_message` with no memory tool). V1.4 equivalence analysis can
    now proceed against complete Cell C data.
    
    **Methodological lesson.** Property-level verification (does the system do X?) is *necessary* but not
    *sufficient* to verify internal structure. The 6c.9 probes verified the properties they targeted; they did
    not — and could not, by their design — verify properties they didn't target. V1.4's expanded probe set
    surfaced the broader property gap. Methodology bank entries on agent-loop behaviour should be careful
    to distinguish *property tested* from *property assumed*.
    
    **Companion lesson — first smoke is not last smoke.** The V1.4 rig fix required THREE smoke
    iterations to clear: (1) the initial normalise fix surfaced fresh-state carryover from the prior
    slate's namespace; (2) the state-reset fix surfaced that Sonnet 4.5 emits multi-toolCall assistants
    which the single-call policy silently dropped; (3) the multi-call split finally produced a clean
    trial. Without iterating the smoke, the 45-trial re-run would have been wasted compute against a
    still-broken rig — twice. The dissertation's V1.0 §6.5 "multiple dimensions fail simultaneously"
    diagnostic ladder already advises sanity-checking experimental setup before architectural
    interpretation; this is the same lesson at the rig level.

21. **#21 (applied 2026-06-17) — Cell C multi-turn pickle duplicates prior turns; #20's
    "keep the pickle as truth" (Path 1) is correct for single-turn but insufficient for multi-turn.**

    **Discovery.** With #20's normalise fix applied and Cell C re-run (2026-06-17), the V1.4
    analyser still reported `gate_pass: false`, with the failures concentrated on the two
    multi-turn probes (p4 cross-turn, p5 cross-session): tool-invocation p4 0/5, p5 0.2;
    tier p4 0/5, p5 0/10. Single-turn probes (p1/p2/p3/p6/p7) were strong. The shape of the
    failure — adjacent steps *byte-identical* in tools AND monologue — pointed at duplication,
    not divergence.

    **Root cause (pickle data, not extractor logic).** Cell C's `all_messages` carries each
    prior turn a second time. In `p4/cell-c-0`'s pickle, turn 1's full assistant/function chain
    appears at entries 4–13 (timestamp `02:03:05`) and again, byte-identical in content, at
    entries 14–23 (timestamp `02:04:09` — turn 2's time), before turn 2's real answer at 24–29.
    Mechanism: OpenClaw replays the prior session buffer into the agent context on each new
    `openclaw agent` invocation, and the plugin's per-turn `agent_end` mirror persists the
    *whole* replayed buffer again. Single-turn probes fire only one `agent_end`, so they never
    duplicate — which is exactly why #20's single-turn-only verification (and the 6c.9 slice)
    never surfaced this. The `extract.py` step-grouper then splits the duplicated turn into a
    second step (compounded by `_is_probe_user_message` treating OpenClaw's `### Memory …`
    user-turn preamble as a probe boundary), doubling per-tool counts past the ±1 tolerance.

    **Why pickle-level dedup was rejected.** The replayed copy carries a *new* timestamp, so
    `(timestamp, message)`-identity dedup misses it; content-identity dedup would risk masking
    legitimately-repeated tool calls. The per-trial JSONL captured by the driver (#20 companion
    fix) is OpenClaw's append-only event truth and contains each turn exactly once
    (`p4/cell-c-0.jsonl`: 4 metadata entries, turn-1 chain, turn-2 chain — no replay copy).

    **Relationship to #20.** #20 deliberately chose Path 1 (fix `normalise.ts`, keep the sidecar
    pickle as the extractor's source) over Path 2 (project from JSONL), on the grounds that Path 1
    "fixes the persistence-layer truth." #21 shows that judgement was right for *structure* (the
    pickle now carries tool calls, args, monologue) but wrong as a blanket claim: the pickle's
    multi-turn *sequence* is not faithful because the mirror re-appends replayed turns. The
    adopted remedy is therefore Path 2 *for Cell C* — project the Cell C digest from the per-trial
    JSONL — while Cell A stays on its (single in-process loop, replay-free) pickle. Same lesson as
    the "first smoke is not last smoke" companion to #20: each rig fix exposes the next layer.

    **Fix (applied).** Added `load_steps_from_jsonl` / `extract_v14_record_from_jsonl` to
    `extract.py` and a `reextract_cell_c.py` driver: each `role=user` turn opens exactly one step;
    assistant `content[]` `toolCall` blocks become the step's tool calls (multi-call assistant
    messages contribute all their calls to the one step, no extra step). All 45 Cell C trial JSONs
    re-derived from JSONL; Cell A re-extracted from pickle unchanged (only `pre_tool_text` added,
    see #22). **Post-fix evidence:** only p4/p5 changed (step counts 3→2 and 4→3; turn-1 tool
    counts halved, turn-2 untouched); all single-turn probes byte-identical to the pickle path; 0
    residual byte-identical multi-tool adjacent steps. Aggregate tool-invocation rose 0.689 → 0.867.

    **Note — the real p4/p5 divergence survives the fix.** De-duplicated, Cell C p4 turn 1 still
    does `conversation_search ×2 → archival_memory_insert → send_message` where Cell A does
    `core_memory_append`; tier cell-agreement is p4 0/5, p5 4/10. The duplication had been
    *obscuring* this signal, not creating it. **But the surviving divergence is itself confounded
    by #23** (Cell C ran a different human string foregrounding "three-tier memory … recall"), so
    it is not yet cleanly attributable to architecture. The fix correctly exposes the signal;
    interpreting it awaits the #23 re-run.

22. **#22 (applied 2026-06-17) — Inner-monologue Jaccard compared non-comparable structures
    (Cell A's heartbeat-loop monologue vs Cell C's single batched turn).**

    **Discovery.** The V1.4 monologue dimension scored 0.067 (3 of 45 trial-pairs ≥ Jaccard 0.5) —
    a near-total fail that contradicted #17(b)'s measured temp-0 noise floor ("comfortably above
    0.5"). It failed even on p6, where tool invocation and tier agreed 10/10 in both cells: identical
    behaviour cannot produce a genuine monologue divergence, so the metric, not the behaviour, was
    suspect.

    **Root cause.** Cell A runs MemGPT's heartbeat loop — multiple LLM round-trips per probe, each
    emitting its own inner monologue, which `extract.py` concatenates across the step. Cell C emits
    its tool chain as a *single* batched assistant message (the #20 "Sonnet 4.5 emits 2–3 toolCalls
    in one message" finding), so it produces *one* monologue fragment. Cell A monologue is
    systematically 2–3× the Cell C token count across every probe (e.g. `p6/cell-c-0`: Cell A
    "I should update my core memory … I've noted that information already exists … Let me
    acknowledge" — two heartbeat-turn fragments — vs Cell C "I'll remember that you typically work
    in the evening." — one). Jaccard collapses on the length/structure mismatch, not on meaning.
    The §5 threshold and #17(b)'s noise floor were both calibrated on *within-Cell-A* trial pairs,
    which share the heartbeat-loop structure; they do not transfer to a cross-architecture A-vs-C
    comparison where one side loops and the other batches.

    **Fix (applied).** `extract.py`'s `extract_monologue_by_step` now emits a `pre_tool_text`
    field (content of assistant messages up to and including the first one bearing a
    `function_call`); the analyser tokenises that for Jaccard. `docs/v1-cells.md` §5 updated.

    **Post-fix evidence — the fix is correct but exposes a second, deeper confound.** Structural
    inflation is gone (no trials now skip the min-token guard; Cell A and Cell C fragments are
    length-comparable), yet the dimension barely moved (0.067 → 0.089; only 4/45 pairs ≥ 0.5).
    Cause: the residual gap is genuine *cross-prompt paraphrase*, not structure — and it is
    dominated by **#23** (Cell C ran a different persona/human, so the two cells' opening
    monologues are conditioned on different prompts). Even absent #23, lexical Jaccard ≥0.5 is
    likely too strict for *cross-architecture* monologue (the §5 threshold and #17(b)'s noise
    floor were both measured within-Cell-A, same prompt). The honest read: substantive-monologue
    equivalence across cells needs a semantic measure (embedding cosine) or manual rubric, applied
    only *after* the #23 persona/human is corrected. (p3 was the one probe that cleared the old
    metric — its content words "store/project code/archival/search/confirm" dominate regardless.)

    **Lesson.** A divergence metric must be invariant to declared structural deviations *and* to
    the prompt. The heartbeat-loop-vs-batched-tool-calls difference (§4.3 chain/yield) is a known
    architectural deviation; a content metric sensitive to *how many LLM turns* produced the
    content measures the deviation, not the behaviour. Fixing that surfaced that lexical Jaccard
    is additionally too brittle for cross-prompt/cross-architecture paraphrase — two layers, one
    symptom.

    **Disposition (2026-06-18, V1.4 final — confirmed metric failure).** p6 is the decisive control:
    with the §3 persona corrected, p6 tier-agreement is 10/10 (`core` in both cells) — *identical*
    memory behaviour — yet monologue Jaccard stays ≈0 (dimension rate 0.089, only p3 clears, on content
    words). Identical behaviour cannot produce a real monologue divergence, so the residual is purely
    the metric. The persona correction did **not** lift lexical Jaccard, ruling out persona drift as the
    driver. Lexical Jaccard ≥0.5 is not a valid cross-architecture monologue measure; a semantic measure
    (embedding cosine) or manual rubric is required. The dimension is **not scorable** as specified and
    is excluded from the V1.4 verdict pending re-specification (V1.5).

23. **(confirmed on p5; p4 pending clean re-run) — The Cell C slate ran a different
    persona/human than Cell A: a controlled-variable violation (§3) that the V1.4 fixes surfaced,
    confounding the equivalence comparison.**

    **Discovery.** After the #21 (multi-turn dedup) and #22 (monologue fragment) fixes were
    applied and V1.4 re-run, the gate still failed — monologue 0.089, tier (cell-agreement)
    0.667 — with divergence concentrated on the recall probes (p4 0/5, p5 4/10). Inspecting the
    monologue source to explain the residual low Jaccard surfaced that Cell C's core-memory
    `<persona>`/`<human>` blocks did not match Cell A's.

    **The violation.** `docs/v1-cells.md` §3 fixes persona = *"Sam is a friendly AI assistant
    with an extensive knowledge base."* and human = *"The user is a researcher exploring AI
    memory architectures."* as controlled variables, byte-identical across cells. Cell A's
    pickles carry exactly these. Cell C's session JSONLs carry, uniformly across all 7 probes,
    persona = *"Sam is a knowledgeable AI assistant with a passion for helping users understand
    complex topics. Sam is concise, thoughtful, and always uses the send_message tool to reply
    to users rather than responding with free text."* and human = *"The user is a researcher
    studying AI memory architectures, specifically exploring how MemGPT-style three-tier memory
    can be integrated with modern AI agent frameworks."*

    **Source.** `~/.openclaw-dev/openclaw.json`'s `openclaw-memgpt.config` carried these strings;
    `experiments/v1-runs/driver.py` does not set persona/human, so the slate inherited the stale
    config (left over from earlier vertical-slice tuning) rather than the §3 strings. §2's Cell C
    config example and §3's controlled-variable table both specify the §3 strings — the config
    was simply never reconciled to them before the slate ran.

    **Why it confounds the verdict (§6.5 step 2).** (a) *Monologue.* Cell C's persona literally
    instructs "concise, thoughtful" — a different register and length from Cell A's — so even the
    pre-first-tool fragments (#22) are paraphrases conditioned on different prompts; lexical
    Jaccard ≥0.5 cannot clear cross-prompt paraphrase (only 4/45 pairs did). (b) *Recall tier.*
    Cell C's human string foregrounds "three-tier memory … recall," which plausibly primes the
    agent toward explicit `conversation_search` on p4/p5 where Cell A (neutral human string)
    reads from core/active context — the exact p4/p5 divergence observed. The apparent A≠C is
    therefore not cleanly attributable to architecture while this confound stands.

    **Resolution (applied + pending pilot).** Two fixes applied: (a) `~/.openclaw-dev/openclaw.json`
    persona/human reset to the §3 strings; (b) **`driver.py` now pins the §3 strings into the plugin
    config at slate start** (`V1_PERSONA`/`V1_HUMAN` written in `_apply_v1_overrides`), so the
    controlled variable is a property of the rig rather than of ambient config — it cannot silently
    drift again. A pilot re-run of the diagnostic probes (p4/p5/p6 Cell C, ~25 trials) tests whether
    the persona/human correction collapses the observed divergence before committing to the full
    90-trial re-run. The #21/#22 extractor fixes are correct and independent and stay. Methodology
    #18's "reject" is held pending the corrected p4 data.

    **Pilot evidence (2026-06-17).** A partial corrected-persona re-run (institutional budget
    depleted mid-pilot: p4 5/5, p5 6/10, p6 0/10) tested the claim. On **p5 — the load-bearing
    cross-session recall probe — #23 is confirmed:** with the §3 strings restored, all 6 corrected
    trials chose `core` (tier-agreement with Cell A rose from ~4/10 stale to **6/6**; 3 trials
    flipped archival→core), kept clean MemGPT tools + `send_message` discipline, and recovered
    `CARDINAL_3987` across the restart in all 6. The stale human string ("…MemGPT-style three-tier
    memory … recall…") had been priming Cell C's archival/recall eagerness; the neutral §3 string
    removes it. **p4 is inconclusive:** the corrected p4 run was contaminated by #19 (lazy-init
    stock-tool coexistence — the agent called stock `exec` and replied in free text on 4/5 trials),
    so convergence could not be measured there. Monologue stayed low even on p5 corrected (lexical
    Jaccard ≤0.25, 0/6 ≥0.5) *while* p5 tools/tier matched Cell A exactly — isolating that residual
    to the metric (#22: lexical Jaccard cannot clear cross-architecture paraphrase), not behaviour.

    **Lesson.** Two layers. (1) The §6.5 ladder lists "persona/human byte-identical across cells"
    as an early experimental-error check precisely because a controlled-variable slip mimics
    architectural divergence; when the two cleanest fixes did not move the recall-probe and
    monologue dimensions, the ladder — not a deeper architectural hypothesis — was the right next
    step. (2) The deeper fix is *driver-explicit controlled-variable enforcement*: a controlled
    variable that lives only in documentation and ambient config (here, openclaw.json the operator
    edits by hand) will eventually drift; the harness should assert it on every run. "The config
    that was documented" is not "the config that ran" unless the rig makes them the same.

    **Disposition (2026-06-18, V1.4 final — confirmed, with a twist).** The full corrected slate
    (p4/p5/p6, direct chain) confirms #23 as a genuine controlled-variable violation that was driving
    the recall-probe divergence: p5 recovers `CARDINAL_3987` 10/10 and converges toward Cell A's `core`
    tier; p6 tier-agreement is 10/10. The correction was **necessary and MemGPT-faithful** (MemGPT's
    default personas carry no send_message coaching — see #25). The twist: removing the non-canonical
    coaching **unmasked a previously-hidden I/O-layer architectural divergence** (send_message
    discipline), banked as #25. So #23's resolution is two-sided — it fixed the persona confound on the
    memory dimensions *and* revealed that the prior slate's send_message discipline had been an artefact
    of the coaching. Both halves stand. — Provider switch (institutional Bedrock → direct Anthropic) is
    behaviourally non-material for the §7.3 dimensions.** When the institutional Bedrock budget was
    depleted mid-pilot, the V1.4 corrected Cell C slate (p4/p5/p6) was completed on a personal
    Anthropic key via a direct chain (`proxy/litellm_config.yaml` → `api.anthropic.com`,
    `os.environ/ANTHROPIC_API_KEY`), dropping the institutional `proxy_shim` (Bedrock path) entirely.
    Both chains serve the *same* model snapshot — `claude-sonnet-4-5-20250929` — so the only variable
    is the serving gateway. Before trusting cross-chain comparison, the switch was validated three ways:

    - **Wire-format canary (p2 / PINEAPPLE_8101).** One p2 trial through the direct chain produced a
      byte-structurally identical digest to the institutional baseline: `archival_memory_insert` +
      `send_message`, archival tier, identical `arg_keys`, marker stored, send_message held. The
      production extractor (`extract_v14_record_from_jsonl`) parsed the direct-chain tool-call wire
      shape with no change — the §3.7 normalise boundary is provider-agnostic. (Evidence:
      `experiments/v1-runs/analysis/wire_check_p2_direct/`.) This is the §-level analogue of #12: the
      tool-call wire shape is the same regardless of which gateway fronts the model.
    - **p5 provider-equivalence (`analysis/provider_compare.py`).** Institutional corrected trials
      0–5 (preserved at `analysis/institutional_p5_jsonl/`) vs direct trials 0–5: **CARDINAL_3987
      recovered across the sidecar restart 6/6 on both chains** (the load-bearing property is
      provider-invariant); dominant-tier agreement INST==ANTH 4/6, with 2 stochastic core↔archival/recall
      flips — within the same band as within-provider trial-to-trial variance at temperature 0.
    - **p4 divergence reproduces on both chains.** The p4 stock-tool / free-text divergence (see #18,
      #25) appears on the institutional *and* direct chains in the same modes (free-text ack,
      archival/recall eagerness, stock `exec`/`write`). A divergence that is identical across providers
      is, by construction, not a provider artefact.

    **Conclusion.** The provider switch does not move the §7.3 dimensions; Cell A (Bedrock reference)
    remains a valid comparator for direct-chain Cell C. This is what licenses the mixed-chain V1.4
    slate — p1/p2/p3/p7 institutional, p4/p5/p6 direct — to be analysed as one dataset. The driver's
    `health_checks` was updated to drop the now-absent shim from its fatal preconditions (re-enable via
    `V1_REQUIRE_SHIM=1` for institutional runs).

25. **(primary V1.4 finding, banked 2026-06-18) — Stale persona's send_message coaching masked an
    I/O-layer architectural divergence; the corrected V1.0 §3 persona surfaced it.**
    V1.4's first Cell C slate ran with a stale `~/.openclaw-dev/openclaw.json` persona containing
    send_message coaching ("...always uses the send_message tool to reply to users rather
    than responding with free text...") — a non-canonical addition **not present in MemGPT's default
    personas**. Source check (`memgpt-service/memgpt/personas/examples/`): `sam.txt` and `sam_pov.txt`
    contain no send_message instruction; only the gpt-3.5 crutch `sam_simple_pov_gpt35.txt` does
    ("I should remember to use 'send_message'… that's the only way for them to hear me!"). So the §3
    correction (#23) — a neutral persona with no send_message coaching — is *more* MemGPT-faithful for
    a capable model, not less.

    **Why Cell A's ~1.0 send_message discipline is architectural, not behavioural.** Source-confirmed
    in the fork (`memgpt/agent.py`, `memgpt/interface.py`):
    - **Belt (prompt).** The base system prompt (`prompts/system/memgpt_base.txt:18-19`,
      `memgpt_chat.txt:27-28`): *"'send_message' is the ONLY action that sends a notification to the
      user, the user does not see anything else you do."*
    - **Suspenders (rendering).** `Agent.handle_ai_response` renders the assistant turn's `content`
      with `self.interface.internal_monologue(...)` under an explicit comment *"The content is then
      internal monologue, not chat."* The only path to a user-facing `assistant_message` is the
      `send_message` function → `send_ai_message` → `interface.assistant_message`. There is **no
      free-text-to-user path** in MemGPT: assistant `content` is *always* monologue.
    - **Bouncer (verification).** `verify_first_message_correctness(require_send_message=True)`
      (`agent.py:526`) returns `False` — forcing a re-prompt — if the first turn is not a
      `send_message` call.

    Cell C (the plugin in OpenClaw) inherits the **belt** (the base prompt is injected via
    `system_prompt_section`; `send_message`/`heartbeat` markers verified present in the live prompt)
    but lacks the **suspenders** (OpenClaw renders assistant `content` *as the user-facing reply*, not
    as monologue) and the **bouncer** (no first-message send_message verification). Under the coached
    persona, the model's instruction-following overrode the missing enforcement (Sense 1 preservation —
    behaviour holds because it is explicitly told to). Under the §3 persona, the gap surfaced: capable
    Sonnet 4.5 emits a free-text acknowledgment directly and OpenClaw renders it, skipping the
    now-redundant `send_message`.

    **Empirical signature (V1.4 corrected, direct chain).** Aggregate send_message 0.856 (13/90
    failures: 1 Cell-A stochastic, 12 Cell-C). Concentrated on the simple-acknowledgment and
    bare-declarative probes: **p6 8/10 Cell C trials called `core_memory_append` (faithful tier) then
    replied in free text with no `send_message`**; p4 2/5 replied in free text on both turns. The
    memory-tier choice is faithful in these very trials — only the *delivery* diverges, isolating the
    finding to the I/O layer, not the memory layer.

    **Three senses of "preservation" (V1.4 vocabulary).**
    - *Sense 1 — behavioural-under-coaching:* the property holds when the prompt explicitly elicits it.
    - *Sense 2 — behavioural-by-default:* the property holds from the model's default behaviour given
      the faithful (uncoached) prompt.
    - *Sense 3 — architectural:* the property is structurally guaranteed regardless of model behaviour.

    MemGPT's **memory architecture** (tiering, recall, archival, cross-session persistence) is preserved
    by the plugin at **Sense 3** — the sidecar/`LocalStateManager`/`EmbeddingArchivalMemory` structurally
    enforce it. MemGPT's **send_message discipline** is preserved at **Sense 1 only** (it held under
    coaching) and fails at Sense 2/3 — the original V1 measurement was conflating Sense 1 with Sense 3.
    The V1.4 correction isolated them.

    **Disposition.** Documented as a bounded **I/O-layer architectural divergence** (not a memory-layer
    finding, not a measurement artefact, not the #23 persona confound). It does not affect MINJA, whose
    vectors target memory *contents* (Sense-3-preserved). **V1.5 (optional Track 2):** OpenClaw-side
    send_message enforcement at the §4.3 `reply_dispatch` boundary — suppress free-text trailing
    `content` and/or enforce a send_message terminator, the plugin-side analogue of MemGPT's
    suspenders+bouncer — then re-run p4/p6 to test whether Sense 3 is recoverable. Optional for the
    dissertation (the thesis is memory-architecture preservation) but strengthens the contribution.

    **Methodology lesson.** A controlled-variable violation can mask not just *measurement* findings
    but *architectural* ones: the stale persona's coaching hid a structural gap for an entire slate.
    "Does the system do X?" must be qualified by "at which sense of preservation?" — a property that
    holds only under coaching (Sense 1) is not the same claim as one the architecture guarantees
    (Sense 3), and an undocumented system's faithful reproduction has to state which it is.

**Pattern.** Faithful reproduction of an undocumented system requires baseline
source checks (and probing the actual failure mode rather than assuming the happy
path) even when behaviour looks obviously wrong — "obvious bug" and "reference's
actual behaviour" are indistinguishable from intuition alone. Same pattern recurs
on the consumer (OpenClaw) side: design hedges that name a specific mechanism
("the path is via X") need empirical verification because the actual mechanism is
often a sibling path the hedge didn't anticipate.

---

## Vertical slice findings (6c.9.2 through 6c.9.4)

Earlier 6c.9.0/6c.9.1 findings (SSRF guard, gpt-5.4 endpoint auto-discovery,
proxy-shim streaming, `--dangerously-force-unsafe-install`) are pinned in the
project's user-memory store, not duplicated here. Sub-sections below are 6c.9.2+
— the findings worth re-reading before debugging a regression.

### 6c.9.2 — Multi-turn single-session (the synthetic-record cascade)

The property under test: an agent that uses memory tools mid-conversation can
complete a second turn without the JSONL recorder corrupting itself or the
prompt-section. Verified on `feat/vertical-slice` after fixes 6c.9.2a/9.2b.

**Two fixes required.**

1. **`normalise.ts` `flattenContent`** (6c.9.2a, `fd1084d`). OpenClaw's modern
   session buffer carries assistant `content` as a content-blocks array
   (`[{type:"text",text:"..."}]`), not the v0 plain string. The §3.7 normaliser
   previously only handled `tool_calls` → `function_call` and `tool` → `function`
   role mapping; non-string content fell through unconverted and pymemgpt's v0
   wire format rejected it. Added `flattenContent()` joining text parts in order,
   returning `null` when no text remains. Idempotent over `normalise`'s rebuild
   semantics (§3.7 invariant). Silently drops non-text parts (images, files) —
   surfaced as the multimodal item in V2 follow-ups.

2. **`promptSection.ts` `repairTrailingEmptyAssistant`** (6c.9.2b, `64cbf63`).
   When `reply_dispatch` claims a turn (§4.3), OpenClaw still appends a
   synthetic record at the end of the JSONL: an assistant message with empty
   `content`, zero usage, and `stopReason: "stop"`. This is a session-close
   marker, not a real LLM response. Its presence at the tail makes the *next*
   turn re-read the JSONL, see the trailing empty assistant, and classify the
   new prompt-build as a replay of an abandoned turn — which poisons subsequent
   prompt-section assembly. The repair runs in `before_prompt_build` ahead of
   `ensure`: it reads the session JSONL, strict-checks the last line against
   the synthetic-marker fingerprint (role=assistant, content=[], stopReason=stop,
   total usage=0), and strips it if matched. Strict fingerprint avoids stripping
   a fast-model real reply that happens to be brief.

**The CLI artefact persists, and is documented separately.** Even with both
fixes, OpenClaw's CLI summary still reports `livenessState: "abandoned"` because
`send_message` is not in `CORE_MESSAGING_TOOLS = {"sessions_send","message"}`
(see `attempt.tool-run-context--CUdbb6u.js:27`) and therefore does not populate
`messagingToolSentTexts`, so `hadDeterministicSideEffect` stays false. The
repair fixes the *cascade* (next turn's prompt-section integrity), not the
*CLI symptom*. This is "upstream fix" territory in V2 follow-ups.

### 6c.9.3 — Cross-session recall verified (the dissertation's load-bearing property)

The property under test: a fact stored in session N is recall-findable in
session N+1. Verified on `feat/vertical-slice` at 2026-06-04 against fresh
namespace `vs-cross-session-test` on the existing stack (Terminals A/B/C from
the recipe).

**Session boundary mechanism — sidecar process restart.** OpenClaw's
`--session-id` flag controls only OpenClaw's session-log file, NOT the
sidecar's in-process agent registry. The only way to force the `via:"load"`
path is killing the sidecar PID and restarting it with the same
`OPENCLAW_MEMGPT_DATA_DIR`. After restart, `agents_resident` returns to 0;
the next `:ensure` call detects the on-disk `config.json` and delegates to
`load_agent`, where the F2 reference-repair fires.

For a TRULY strict cross-session test (no possibility of OpenClaw buffer
replay carrying the marker forward), also archive
`~/.openclaw-dev/agents/main/sessions/*.jsonl` and `sessions.json` aside
before driving session 2. OpenClaw will then create a fresh per-`--session-id`
JSONL with only the current turn's messages — the agent's only path to the
session-1 marker is via MemGPT's recall/archival tools.

**Three orthogonal properties verified.**

1. **A — Rehydration.** Post sidecar-restart with `agents_resident:0`, the
   first `:ensure` call returned `{"agent_id":"vs-cross-session-test","via":"load"}`.
   Sidecar log confirms `Agent cold-start loaded: namespace=vs-cross-session-test`.
   Re-verified across two independent sidecar restarts.

2. **B — Index integrity (LLM-independent).** Direct curls to the sidecar
   after restart, before the agent ran:
   - `POST /archival:search query="PINEAPPLE_7831"` → 1 result, exact session-1
     marker text
   - `POST /archival:search query="Q3 dissertation milestone"` → same 1 result
   - `POST /recall:search query="PINEAPPLE_7831"` → 7 results (substring
     backend; multiple session-1 turns mention the marker)
   - `GET /stats` → `total_message_count: 66` (same as pre-restart, proving
     full state rehydration via pickle)

3. **C — Agent reasoning (end-to-end).** In session 2 (strict variant — fresh
   OpenClaw buffer AND fresh sidecar), the agent autonomously called
   `conversation_search(query="project codename")`, received the marker from
   the recall index, and responded via `send_message` with: `"The project
   codename you mentioned was **PINEAPPLE_7831**, which is your Q3
   dissertation milestone identifier."` The session-2 `finalPromptText`
   showed `76 previous messages in recall memory, 1 in archival memory` —
   the rehydrated counts visible to the agent at prompt construction.

**Side findings.**

- The cross-namespace mirror sweep is real. When you change `namespace` in
  `openclaw.json` mid conversation, the new namespace's first `agent_end`
  mirror call ingests OpenClaw's full session buffer (which still contains
  messages from the previous namespace's turns) into the new namespace's
  recall log. Cleanest path: a fresh `--session-id` for each cross-session
  test pair, plus archiving the old session JSONL before session 2 if
  strictness matters.

- The CLI shows `livenessState: "abandoned"` + `⚠️ Agent couldn't generate a
  response` on every turn despite `send_message` succeeding correctly through
  `reply_dispatch`. This is a CLI-surface artefact of the 6c.9.2
  turn-termination pattern (the synthetic trailing-empty assistant gets
  `replayInvalid: true` flagged by OpenClaw's mutating-tool heuristic), not a
  real failure. Verify success via: (a) the assistant `send_message` toolCall
  content in the session JSONL; (b) recall-count growth on the next turn's
  `finalPromptText`. Don't trust the CLI's success/failure summary alone.

- Sidecar restart time on this machine is ~60–90s (embedder reload). The
  6a.0 startup dependency is correct — don't issue any sidecar requests
  until `/healthz` shows `embedder:"ready"`.

### 6c.9.4 — `send_message` text is recall-searchable (Scenario A)

The property under test: does the user-facing text emitted by `send_message`
survive the mirror → recall path and become findable by the agent's
next-session `conversation_search`? Open from S0.5 / the Stage-0 §2.10 hedge.
Verified on `feat/vertical-slice` against namespace `vs-send-message-field-test`
on the running vertical-slice stack.

**The Stage-0 hedge.** §2.10 / §4.3 anticipated that after normalisation
(§3.7), the assistant's `send_message` call becomes a `function_call` whose
user-facing text lives in `function_call.arguments`, and
`DummyRecallMemory.text_search` matches over `d["message"]["content"]` (not
over `function_call.arguments`). Under that reading, the text would *not*
be recall-searchable, and the V1 threat model would only reach injections
in the inner monologue.

**The empirical finding — Scenario A.** The text *is* recall-searchable, by
a different path than the hedge anticipated. The data path:

1. The tool returns `{content: [{type:"text", text: <user-facing>}]}`.
2. OpenClaw records the result as a *separate* `toolResult`-role message in
   the session buffer — NOT folded into the assistant message's
   `function_call.arguments`.
3. `agent_end` fires; `normalise()` walks `event.messages`. The normaliser
   has no clause for `toolResult`, so the role passes through unchanged into
   the `messages:append` payload.
4. `pm.append_to_messages` writes the entry to `pm.all_messages` (and to
   recall_memory via the F2-repaired reference).
5. `DummyRecallMemory.text_search` at `memory.py:517` filters out
   `role=="system"` and `role=="function"` only — `toolResult` survives the
   filter, and the search matches on `d["message"]["content"]`.

**Two-step verification.** Direct sidecar curls after a `send_message`-bearing
turn:
- Pickle inspection (`uv run python -c "import pickle; ..."` against
  `agents/<ns>/persistence_manager.pkl`) showed a `toolResult`-role entry
  whose `content` is the verbatim user-facing text from the prior turn —
  confirming steps 3–4.
- `POST /recall:search query="<send_message marker>"` returned the entry
  inline — confirming step 5.

**Implication for V1 attack model.** Injections delivered via the agent's
`send_message` payload (not only those carried in inner monologue) are
reachable by the next session's `conversation_search`. The cross-session
memory-poisoning attack surface includes outputs the agent told the user —
broader than the Stage-0 reading allowed. The canonical statement is in
`API_DESIGN.md §2.10 / §4.3` (Scenario A).

**Side finding.** Because the user's prompt also lands in `pm.all_messages`
(via OpenClaw's `user`-role record being mirrored as-is), *both* halves of
the user/assistant exchange contribute to recall. The recall corpus the
next session sees is the full conversation log of prior runs, not a
one-sided slice — important when reasoning about what an attacker can
plant via prompts vs via the agent's own outputs.
