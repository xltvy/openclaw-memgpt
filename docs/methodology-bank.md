# Methodology bank

Non-obvious findings surfaced during the build of the OpenClaw-MemGPT vertical slice
(Phase 6c.9). Each entry records a moment where intuition or the design hedge proved
wrong against source, and what the actual mechanism turned out to be. Banked here as
dissertation evidence for the claim that faithful reproduction of an undocumented
system requires baseline source checks at every step.

This file is referenced from `CLAUDE.md` (gitignored operating manual) but stands on
its own — read it without other context.

---

## "Almost certainly X" was wrong — eleven instances

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
