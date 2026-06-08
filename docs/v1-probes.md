# V1 — Probe Set

Companion to `docs/v1-cells.md` and `docs/v1-observability.md`. Defines the
fixed probe set V1.3 executes against Cell A and Cell C, and V1.4 compares
across to apply the `docs/v1-cells.md` §5 equivalence thresholds.

Scope: probe text (verbatim), expected behaviour per probe, trial count per
probe, execution order recommendations, predicted V1.4 outcomes. Does not
define the probe-runner harness (V1.3) or the comparison code (V1.4).

Probe count: **7 probes** (p1–p7). p1–p6 cover the §7.3 dimensions and the
required structural coverage; p7 is the negative/degenerate probe doubling
as `send_message` discipline check. The set is sized at the upper end of
the brief's 5–7 range because the dimensions × structural-coverage matrix
needs each cell filled — fewer probes leaves coverage holes.

---

## 1. Coverage rationale

The set is designed so the dimensions × structural-coverage matrix is
fully populated, not so each probe targets exactly one dimension. Probes
that exercise multiple dimensions are efficient — the goal is full
coverage at minimum cost.

### 1.1 §7.3 dimension coverage

| Dimension | Probes that exercise it | Primary target probe(s) |
|---|---|---|
| Tool invocation | p1, p2, p3, p4, p5, p6, p7 (all) | p1 (core), p2 (archival), p3 (chained), p7 (none) |
| Inner monologue | all (implicit) | p3, p5 (substantive — multi-step reasoning) |
| `send_message` discipline | all (implicit) | p7 (degenerate — discipline holds under trivial input) |
| Memory-tier reasoning | p1, p2, p4, p5, p6 | p1 (core), p2 (archival), p4 (recall in-session), p5 (recall cross-session), p6 (ambiguous) |

### 1.2 Structural coverage

| Requirement | Probe | Notes |
|---|---|---|
| Cross-turn recall within session | p4 | Marker stays in active context (gpt-5.4 context = 272k); probe tests whether both cells make the same active-context-vs-recall choice. |
| Cross-session recall | p5 | **The dissertation's load-bearing probe.** Sidecar/CLI restart clears the in-memory agent buffer; the agent must reload from disk and recall-search to find the marker. Highest-risk probe; allocated 10 trials. |
| Multi-tier coordination (chain/yield) | p3 | Exercises §4.3 chain/yield structure: one tool call → heartbeat → another tool call → `send_message`. |
| Ambiguous tier choice | p6 | Tests whether both cells make the same tier choice in genuinely ambiguous cases — harder than testing clear-cut cases. Allocated 10 trials for statistical clarity. |
| Restraint (negative probe — agent should not write) | p7 | §7.4 explicitly lists this. p7 doubles as restraint check ("Hello." should trigger no memory writes) and as `send_message` discipline check. |

### 1.3 Why p5 is the highest-risk probe

p5 is the only probe that exercises the §4.5 declared deviation full path:
sidecar/CLI process restart, on-disk `:load`, F2 recall reference-repair,
then a `conversation_search` against a marker present only in the reloaded
recall index. Any failure in F2, in mirror cadence, or in the load path
will surface here. The dissertation's load-bearing claim ("the
architecture preserves MemGPT-faithful cross-session memory") rests
entirely on p5.

Consequently:

- p5 is allocated **10 trials per cell** (vs. 5 default).
- p5 has its own pre-flight check (§4.3 below) before V1.3 commits to all
  10 trials.
- If p5 diverges and p1–p4, p6, p7 pass, that is the architecture's most
  diagnostic single signal — points directly at the cross-session reload
  path.

---

## 2. Excluded probe categories (with rationale)

### 2.1 Within-turn recall — excluded

No probe asks the agent to recall something it said earlier in the **same
turn** (e.g. "tell me X, then issue `conversation_search` for X mid-step"
within one user prompt).

**Rationale.** Within-turn recall is the §4.5 declared deviation: Cell C
mirrors per-turn at `agent_end`, so same-turn messages are not in
`all_messages` when a mid-turn `conversation_search` fires; Cell A's
in-process loop mirrors per-message so they are. Including such a probe
would test the deviation rather than testing architectural equivalence —
it is engineered to fail on Cell C and is therefore not a fair comparison
input. The deviation is documented in `docs/v1-cells.md` §4.2 and is the
first suspect if memory-tier reasoning diverges on any probe; we do not
need a dedicated probe to confirm a deviation we already declared.

### 2.2 Heartbeat-bait probes — excluded

No probe is designed to force a multi-turn heartbeat loop. The §4.3 chain/
yield structure is exercised by p3 (multi-tier chaining); heartbeats are
emergent rather than under direct test.

### 2.3 Adversarial / injection probes — excluded

V1 validates the architecture under normal use; injection probing is a
separate phase (the MINJA cross-session vector, gated behind V1 closure
per `CLAUDE.md` NON-NEGOTIABLES item 5). V1.2 probes are honest user
prompts.

---

## 3. Probe specifications

Each probe records: ID, verbatim text, dimensions exercised, expected
behaviour, equivalence focus, session context, trial count, and per-probe
sanity check (the predicted post-probe pickle state, used by V1.3 to
catch misconfiguration before running full trial counts).

### 3.1 p1 — Identity fact, core memory expected

- **Probe text** (verbatim): `Please remember that I'm working on a dissertation about AI memory architectures.`
- **Dimensions exercised:** tool invocation, memory-tier reasoning, inner monologue, `send_message` discipline.
- **Expected tier:** `core`.
- **Primary focus:** memory-tier reasoning — `core` (identity-level fact about the user).
- **Expected behaviour:** `core_memory_append(name="human", content=…)` then `send_message` confirming the update.
- **Equivalence focus:** tier choice. If Cell A chooses `core_memory_append` and Cell C chooses `archival_memory_insert` (or vice versa), apply §6.3 of `docs/v1-cells.md` — likely a tier-routing prompt drift.
- **Session context:** single-session, single-turn. Fresh agent state at probe start.
- **Trial count:** 5 per cell.
- **Sanity check (predicted pickle state after probe):** `all_messages` grows by 4 entries — 1 user + 1 assistant (with `function_call.name="core_memory_append"`) + 1 function result + 1 assistant (with `function_call.name="send_message"`). Core memory section updated with the dissertation context.

### 3.2 p2 — Searchable storage, archival expected

- **Probe text** (verbatim): `Please store this for later reference: the project code is PINEAPPLE_8101.`
- **Dimensions exercised:** tool invocation, memory-tier reasoning, inner monologue, `send_message` discipline.
- **Expected tier:** `archival`.
- **Primary focus:** memory-tier reasoning — `archival` ("for later reference" is a strong archival cue). Tool invocation — `archival_memory_insert`.
- **Expected behaviour:** `archival_memory_insert(content=…)` then `send_message` confirming the storage.
- **Equivalence focus:** tier choice and tool name. If Cell A chooses `archival_memory_insert` and Cell C chooses `core_memory_append`, that's the inverse of p1's failure mode — same diagnosis.
- **Session context:** single-session, single-turn. Fresh agent state at probe start.
- **Trial count:** 5 per cell.
- **Sanity check:** `all_messages` grows by 4 entries (user + assistant w/ `archival_memory_insert` + function result + assistant w/ `send_message`). Archival memory grows by 1 entry containing `PINEAPPLE_8101`.

### 3.3 p3 — Multi-tier chaining

- **Probe text** (verbatim): `Store that the project code is PINEAPPLE_8101 in archival, then search archival to confirm it's there.`
- **Dimensions exercised:** tool invocation (multiple), inner monologue (substantive — multi-step reasoning), `send_message` discipline.
- **Expected tier:** `archival` (both the insert and the search target archival; the chain itself is the focus, not the tier choice).
- **Primary focus:** tool invocation (chain), multi-tier coordination (the §4.3 chain/yield structure). Explicit "in archival" cue removes tier-reasoning ambiguity so the test isolates the chain mechanic.
- **Expected behaviour:** `archival_memory_insert(content=…)` → heartbeat → `archival_memory_search(query=…)` → `send_message` with the search result.
- **Equivalence focus:** chain structure and tool sequence. If Cell A produces a 2-tool chain and Cell C produces a 1-tool chain (or vice versa), the §4.3 chain/yield gate is the first suspect (`docs/v1-cells.md` §6.1).
- **Session context:** single-session, single-turn (one user prompt drives the entire chain). Fresh agent state at probe start.
- **Trial count:** 5 per cell.
- **Sanity check:** `all_messages` grows by ≥6 entries (user + 2 assistant tool-call entries + 2 function results + 1 assistant w/ `send_message`). Heartbeat continuation may add intermediate assistant entries; expect 6–8 total.

### 3.4 p4 — Cross-turn recall within session [multi-turn]

- **Probe text** (verbatim):
  - **Turn 1:** `The project code is BLUEBIRD_5402.`
  - **Turn 2:** `What was the project code I mentioned?`
- **Dimensions exercised:** tool invocation, memory-tier reasoning (active-context vs `conversation_search`), inner monologue, `send_message` discipline.
- **Expected tier:** `recall` (the dimension under test is recall behaviour, even if the agent serves the answer from active context without calling `conversation_search`; V1.4 records the chosen tier per trial and compares cell-to-cell for path agreement).
- **Primary focus:** memory-tier reasoning — the agent has two valid recall paths: (a) read from active context (the marker is recent and stays in the 272k window), (b) call `conversation_search`. **Either path is acceptable; the test is whether both cells make the same choice.**
- **Expected behaviour at turn 2:**
  - **Likely path:** agent reads from active context, calls `send_message` directly with `BLUEBIRD_5402`. No memory tool invoked.
  - **Alternate path:** agent calls `conversation_search(query="project code")`, then `send_message`.
  - Cells diverging on path is the divergence to investigate. If Cell A reads active-context and Cell C calls `conversation_search`, the within-turn mirror gap (§4.2 of `docs/v1-cells.md`) is **not** the cause (turn 2 fires after `agent_end` of turn 1, so the marker IS in Cell C's `all_messages`). Likely cause: prompt-edit drift in tier guidance.
- **Equivalence focus:** path agreement. If both cells take the active-context path, tier-reasoning dimension is trivially satisfied (no tool call, no tier to compare). If both call `conversation_search`, recall tier is exercised cleanly.
- **Session context:** single-session, two-turn. Probe runner sends turn 1, captures pickle state, sends turn 2 (same session, same agent), captures pickle state again.
- **Trial count:** 5 per cell.
- **Sanity check:** after turn 1, `all_messages` grows by 1+ entries (user + possible tool calls + `send_message`). After turn 2, `all_messages` grows by another 2–4 entries depending on path. Turn 2 assistant's `send_message.arguments.message` should contain `BLUEBIRD_5402`.

### 3.5 p5 — Cross-session recall [cross-session, load-bearing]

- **Probe text** (verbatim):
  - **Session 1, turn 1:** `Remember: the project code is CARDINAL_3987, used for milestone Q4.`
  - **Session 1, turn 2:** `Tell me a short poem about birds.`
  - **(process restart per §4.3 below)**
  - **Session 2, turn 1:** `I mentioned a project code earlier — what was it?`
- **Dimensions exercised:** tool invocation, memory-tier reasoning, inner monologue (substantive — recall + answer composition), `send_message` discipline.
- **Expected tier:** `recall` (cross-session; `conversation_search` is the only path that can find the marker after process restart clears the in-memory buffer).
- **Primary focus:** memory-tier reasoning — `recall` (cross-session). **The load-bearing probe.** Session 2 fires against a fresh in-memory agent that has just loaded from disk; the marker is reachable only via `conversation_search`. F2 must be active in both cells.
- **Expected behaviour:**
  - **Session 1, turn 1:** agent may call `archival_memory_insert(CARDINAL_3987)` (defensible) or just `send_message` acknowledgement. Either is fine — turn 1's storage path is not what's under test. The marker enters `all_messages` either way via the mirror.
  - **Session 1, turn 2:** agent composes a short poem via `send_message`. No memory tool expected. The poem itself enters `all_messages` via mirror but is noise, not signal.
  - **Session 2, turn 1:** agent calls `conversation_search(query="project code")` (or similar), receives the recall hit containing `CARDINAL_3987`, then `send_message` with the codename.
- **Equivalence focus:** does session 2 find `CARDINAL_3987`? If Cell A finds it and Cell C does not (or vice versa), the cross-session reload path is broken — diagnose via `docs/v1-cells.md` §6.3 step 3 (cold-start path corruption: confirm F2 is active in the failing cell).
- **Session context:** cross-session. Two-turn session 1, then process restart, then one-turn session 2. Session 2 must run against a freshly-loaded agent — not against a resident one. Restart protocol in §4.3 below.
- **Trial count:** **10 per cell** (vs. 5 default). Highest-risk probe; statistical clarity matters.
- **Padding turn (session 1 turn 2) is not load-bearing.** At gpt-5.4's 272k context window, one padding turn cannot push the marker out of active context. The mechanism that makes recall necessary is the process restart, which clears the in-memory `messages` buffer. The padding turn is included for two reasons: (a) it makes session 1 feel like a real conversation rather than a single-turn store-and-quit; (b) it gives the mirror a non-marker turn to ingest, useful as a recall-corpus noise check (the poem should not appear in session 2's `conversation_search` hits for "project code").
- **Sanity check (post-restart, before session 2):** Cell A pickle's `all_messages` and Cell C pickle's `all_messages` both contain entries with `CARDINAL_3987`. `POST /recall:search query="project code"` against the Cell C sidecar returns the marker. If pre-flight fails, V1.3 stops — running 10 trials when the marker isn't even in the pickle is wasted compute.

### 3.6 p6 — Ambiguous tier choice

- **Probe text** (verbatim): `Please remember that I usually work in the evening.`
- **Dimensions exercised:** tool invocation, memory-tier reasoning (ambiguous), inner monologue, `send_message` discipline.
- **Expected tier:** `ambiguous(core|archival)` — both are defensible. V1.4 records the chosen tier per trial in both cells and compares for agreement rather than against a fixed baseline.
- **Primary focus:** memory-tier reasoning under genuine ambiguity. The user statement is defensible as `core` (a durable preference, identity-adjacent) or `archival` (a searchable factoid).
- **Expected behaviour:** either `core_memory_append("human", …)` or `archival_memory_insert(…)`, then `send_message` confirming. **No single right answer.** The test is whether both cells make the same choice given the same prompt.
- **Equivalence focus:** tier-choice agreement rate. If Cell A picks core 8/10 trials and Cell C picks core 7/10 trials (and the third-trial discrepancy is on the same probe seed), the architectures are aligned within stochastic noise. If Cell A picks core 10/10 and Cell C picks archival 10/10, that's a structural bias divergence — diagnose via `docs/v1-cells.md` §6.3 step 2 (tier-routing prompt drift).
- **Session context:** single-session, single-turn. Fresh agent state at probe start.
- **Trial count:** **10 per cell** (vs. 5 default). Statistical clarity matters because the outcome is fundamentally stochastic.
- **Sanity check:** `all_messages` grows by 4 entries (user + assistant tool-call + function result + assistant w/ `send_message`). Either core or archival is updated, not both.

### 3.7 p7 — Degenerate input / negative probe

- **Probe text** (verbatim): `Hello.`
- **Dimensions exercised:** `send_message` discipline (under degenerate input), restraint (no memory write expected).
- **Expected tier:** `N/A` — no memory tool call expected. If a tool is called, V1.4 records the tier for the cell-to-cell agreement check (the binding criterion is identical behaviour in both cells, not absolute restraint).
- **Primary focus:** `send_message` discipline — does even a trivial greeting route through `send_message`? Doubles as the §7.4 negative probe — does the agent restrain itself from writing to any memory tier when there is no content worth storing?
- **Expected behaviour:** `send_message` only (greeting reply). No memory tool calls.
- **Equivalence focus:** zero memory tool calls in both cells; `send_message` discipline 100%. If either cell writes to any memory tier, that's a restraint failure — diagnose as prompt-adaptation regression (Cell C only) or upstream over-eagerness (both cells).
- **Session context:** single-session, single-turn. Fresh agent state at probe start.
- **Trial count:** 5 per cell.
- **Sanity check:** `all_messages` grows by exactly 2 entries (user + assistant w/ `send_message`). No function-role result entries. Core/archival untouched.
- **Possible alternate behaviour:** the agent may decide "Hello." is worth recording as a conversational opener and call a memory tool. This would be unusual but not a probe failure per se if **both cells do it identically**. The probe's binding criterion is cell-to-cell agreement, not absolute restraint. Document the actual behaviour in V1.3.

---

## 4. V1.3 execution order and protocol

### 4.1 Order

1. **Single-session probes first:** p1, p2, p3, p6, p7 — independent fresh-agent runs, easy to parallelise across trials.
2. **Cross-turn-within-session probe:** p4 — same agent across the two turns, but new agent per trial.
3. **Cross-session probe last:** p5 — most complex, requires restart protocol; 10 trials is the largest single-probe cost.

### 4.2 Fresh-agent discipline

Each probe trial runs against a **fresh agent state.** Concretely:

- **Cell A:** delete or archive `~/.memgpt/agents/<name>/` between trials, then re-run `memgpt run` to bootstrap a fresh agent with the persona/human files.
- **Cell C:** issue `POST /agents/{namespace}` with a trial-suffixed namespace (e.g. `v1-cell-c-p1-t01`, `…-t02`, etc.) so each trial gets its own sidecar agent. Alternatively, delete `~/.openclaw-dev/memgpt-data/agents/<namespace>/` between trials and reuse the namespace.

The namespace-per-trial pattern is cleaner — no state-deletion race, easier to debug, easier to map artefacts to trials post-hoc. Trade-off: more namespaces accumulate on disk. V1.3 should cleanup or archive at the end.

### 4.3 p5 cross-session restart protocol

The restart protocol must produce the `:load` rehydration path in both
cells. V1.0 §4.3 (the spawn-mode session-restart mechanism) and
`CLAUDE.md` V1 PROTOCOL ("Session boundary = sidecar process restart")
define the mechanism. Here is the per-cell sequence:

**Cell A (MemGPT CLI):**

1. After session 1 turn 2 completes, issue `/save` then `/exit` to the MemGPT CLI.
   - `/save` writes the pickle to `~/.memgpt/agents/<name>/persistence_manager/<timestamp>.persistence.pickle`.
   - `/exit` terminates the CLI process.
2. (Pre-flight check) Load the pickle and confirm `CARDINAL_3987` appears in `all_messages`.
3. Re-launch `memgpt run --persona sam_v1 --human researcher_v1 --model gpt-5.4 --no-verify`. The CLI's startup loads the latest pickle for the agent name (`memgpt run` selects most-recent agent or prompts for selection).
4. Drive session 2 turn 1.

**Cell C (OpenClaw + plugin in spawn mode):**

1. After session 1 turn 2 completes, exit OpenClaw (or kill the OpenClaw process). In spawn mode, plugin's `registerService.stop` fires:
   - Plugin issues final `client.save()` → sidecar writes pickle.
   - Plugin sends SIGTERM to spawned sidecar; uvicorn graceful-shutdown runs; SIGKILL fallback at 10 s if needed.
2. (Pre-flight check) Load the sidecar pickle from `~/.openclaw-dev/memgpt-data/agents/<namespace>/persistence_manager/<latest>.persistence.pickle` and confirm `CARDINAL_3987` appears in `all_messages`. Also verify via `POST /recall:search query="project code"` against the **restarted** sidecar (after step 4 below — chicken-and-egg note: this curl confirms session 2 readiness, not session 1 closure).
3. **For strict isolation:** archive `~/.openclaw-dev/agents/main/sessions/*.jsonl` and `sessions.json` aside per `CLAUDE.md` V1 PROTOCOL — prevents OpenClaw's session-buffer replay from carrying the marker forward via JSONL rather than recall.
4. Re-launch OpenClaw with the same `namespace` config. Plugin's `register()` runs; `lifecycle.start` allocates a new ephemeral port, spawns a fresh sidecar (with `OPENCLAW_MEMGPT_DATA_DIR` unchanged), polls healthz (~60–90 s embedder cold-start unless cached). First sidecar call triggers `:ensure` → since `agents_resident == 0` and `config.json` exists, the `:load` path fires (the F2-protected one).
5. Drive session 2 turn 1.

**Session JSONL archival caveat.** Cell A has no equivalent of the
OpenClaw session JSONL, so step 3's strict-isolation archival applies to
Cell C only. This is a structural asymmetry between cells but not a
divergence — Cell A's session boundary is intrinsically clean (CLI exit
wipes the in-memory buffer with no separate JSONL replay risk).

### 4.4 Per-trial artefact naming

For V1.4's deterministic pickle→trial mapping, V1.3 emits per trial:

- Trial directory: `v1-results/<cell>/<probe_id>/<trial_id>/`
- Pickle copy (or path reference): `pickle.path`
- Stdout capture (Cell A) / session JSONL copy (Cell C): `stream.log`
- Pre-flight check result: `preflight.json`

V1.4 reads from this directory structure. Exact path layout settled in
V1.3.

---

## 5. Predicted V1.4 outcomes

### 5.1 If A≈C across all probes (the headline pass)

The §7 validation claim holds: the architecture preserves MemGPT
behaviour across all four §7.3 dimensions, including the load-bearing
cross-session recall property. The plugin is releasable as a faithful
MemGPT-on-OpenClaw composition. V1 closes.

### 5.2 If individual probes fail

| Failed probe(s) | Likely diagnosis | First investigative step |
|---|---|---|
| p1 only | Tier-routing prompt drift on identity tier | Diff adapted vs unmodified `memgpt_base.txt` (`docs/v1-cells.md` §6.3 step 2) |
| p2 only | Tier-routing prompt drift on archival tier | Same as p1 |
| p3 only | Chain/yield gate (§4.3) or heartbeat handling | `docs/v1-cells.md` §6.1 |
| p4 only | Tier-routing drift (cross-turn recall preference) | Compare path choice across trials; check prompt edit |
| p5 only | Cross-session reload path | F2 active in both cells? sidecar pickle contains marker? `:load` reached `LocalStateManager.load`? `docs/v1-cells.md` §6.3 step 3 |
| p6 only | Tier-routing structural bias divergence | If one cell consistently picks core and the other consistently picks archival, the adapted prompt has shifted tier guidance. Diff the prompts. |
| p7 only | Restraint failure (one cell over-writes) or `send_message` discipline failure | `docs/v1-cells.md` §6.1 |
| Multiple unrelated probes | Likely experimental error, not divergence | `docs/v1-cells.md` §6.5: endpoint config, persona strings, namespace contamination, agent state carryover |

### 5.3 Note for V1.4 design — Jaccard minimum-token-length guard

The `docs/v1-cells.md` §5 monologue threshold (Jaccard ≥0.5 over content-
word tokens) is calibrated for the substantive-monologue probes (p3, p5).
Short-monologue probes (notably p7 "Hello.") will produce monologues of
zero or one content-word tokens; Jaccard over such inputs is mathematically
degenerate (0/0 or 1/1 with no signal). V1.4 should apply a **minimum-
token-length guard** — e.g. skip the Jaccard substantive check for any
trial where either cell's monologue contains fewer than N content-word
tokens after stopword removal (suggest N=5 as a starting threshold,
revisit during V1.4 implementation). Below-guard trials still go through
the categorical monologue checks (present? within cap? no user-leakage?)
which are valid at any length.

Flagged here for V1.4 design; not a V1.2 issue. The probe set is correct;
the guard belongs in the comparison code.

### 5.4 The diagnostic priority hierarchy

If p5 fails and any other probe passes, **p5 is the most informative
single failure.** Cross-session recall is the dissertation's load-bearing
property; its failure means the architectural composition does not
preserve the property the rest of the work depends on. Treat as a stop
condition pending diagnosis.

If p7 fails alone, that is a `send_message` discipline failure under
degenerate input — points at the §4.3 turn-termination gate. Same
severity as p5 in that it's architectural (zero tolerance per
`docs/v1-cells.md` §5), but narrower in scope (the gate itself, not the
end-to-end memory composition).

---

## Open questions for review

1. **Probe count 7 — over the brief's 5–7 range?** No, 7 is the upper bound. The set could be trimmed to 6 by dropping p7 (negative probe overlap with §7.4 categorical send_message check); kept here because the degenerate-input test is a useful sanity check separately from the per-probe send_message check.

2. **p3 tier-naming explicitness.** "Store … in archival, then search archival" names the tier explicitly. Intentional — p3 isolates the chain mechanic from tier reasoning. If the explicit naming feels like cheating on tier reasoning, p3 is not the tier probe (p1, p2, p6 are); it is the chain probe.

3. **p4 path ambiguity.** p4 is structured to accept either active-context-read or `conversation_search` as the recall path. This is the same shape as p6 (path agreement matters more than which path). If a single canonical path is preferred, p4's probe text needs sharpening — e.g. "search our prior conversation for the project code" forces the recall tier. Current text allows either path; recommend keeping current text.

4. **p5 padding turn justification.** The padding turn (poem about birds) is not load-bearing for cross-session recall mechanics — the restart is. Documented as such. If the padding turn introduces unexpected noise into the recall corpus (e.g. the poem accidentally contains "project" as a word and pollutes the search), V1.4 surfaces it as a flagged case and the padding turn text changes in V2.

5. **Trial count asymmetry (5 default, 10 for p5/p6) — fine?** Yes. p5 is highest-risk and load-bearing; p6 is fundamentally stochastic. The rest are categorical or near-categorical and 5 trials gives sufficient signal — though at 5 trials, the 95% and 100% thresholds from `docs/v1-cells.md` §5 collapse to "5/5 in both cells" (a single miss fails both). For V1 this is acceptable: a single miss on a categorical-architectural dimension is treated the same regardless of nominal threshold.

---

## Changelog

- 2026-06-08 — V1.2 initial freeze. 7-probe set: p1 (core), p2 (archival),
  p3 (multi-tier chain), p4 (cross-turn within session), p5 (cross-session
  load-bearing — 10 trials), p6 (ambiguous tier — 10 trials), p7
  (degenerate / negative — `send_message` discipline). Each probe carries
  an explicit `Expected tier` field (concrete tier, `ambiguous(core|archival)`
  for p6, or `N/A` for p7) so V1.4 has an unambiguous tier-equivalence
  baseline per probe. Within-turn recall excluded per §2.1 (would test the
  §4.5 declared deviation, not equivalence). Cross-session restart protocol
  fully specified per cell; session JSONL archival step Cell-C only.
  Predicted V1.4 outcomes mapped to `docs/v1-cells.md` §6 diagnostic
  ladder per probe. V1.4 design note added (§5.3) flagging the Jaccard
  minimum-token-length guard required for short-monologue probes (p7).
