# V1 — Observability Mapping

Companion to `docs/v1-cells.md`. Specifies the evidence streams V1.4 reads
from each cell, the parsing rules, and the per-dimension comparison input
shape. V1.3 (probe runs) emits artefacts in the shapes documented here; V1.4
(comparison) reads them.

Scope: which file, which field, which parsing rule, which comparison input.
Does **not** define probes (V1.3) or implement the comparison code (V1.4).

Foundational finding from the V1.1 investigation: **Cell A and Cell C share
the same on-disk pickle format**. Both write a 3-key dict
(`{recall_memory, messages, all_messages}`) via `LocalStateManager.save`;
each `all_messages` entry is `{timestamp, message}` where `message` is an
OpenAI-style message dict. This means the same parser can extract from both
cells, and pickle-to-pickle comparison is the cleanest spine of V1.4. The
session JSONL (Cell C only) is a supplementary stream for OpenClaw-side
state.

---

## 1. Evidence streams in Cell A

Source: fork at `f46cc3b` + F2 (`109817c`) per `docs/v1-cells.md` §1.
References below are to `memgpt-service/` paths.

### 1.1 Persistence pickle — primary structured source

- **Path:** `~/.memgpt/agents/<name>/persistence_manager/<timestamp>.persistence.pickle`
- **Writer:** `LocalStateManager.save` (`persistence_manager.py:134`),
  triggered by `/save` slash command or `/exit` (`main.py:85–89`).
- **Shape:** pickle of `{"recall_memory", "messages", "all_messages"}`.
- **`all_messages`:** list of `{timestamp: str, message: dict}`. The
  `message` dict carries:
  - `role=system`: `{role, content}` (the system prompt; not a probe artefact).
  - `role=user`: `{role, content}` — user's typed prompt.
  - `role=assistant`: `{role, content, function_call}` where `content` is the
    inner monologue and `function_call={name, arguments}` (arguments is a
    JSON string). LiteLLM-augmented assistant messages additionally carry
    `refusal, annotations, audio, tool_calls, provider_specific_fields` —
    LiteLLM artefacts; ignore for V1.
  - `role=function`: `{role, name, content}` — `name` is the tool name,
    `content` is the function response string in
    `package_function_response` envelope (`{"status":"OK","message":"…","time":"…"}`).
- **First-step metadata:** the first response message of each `step()` is
  stamped with `api_response` (raw OpenAI response) and `api_args` (model,
  messages, functions) at `agent.py:1083–1090`. Useful for cross-checking
  what the LLM actually saw if a divergence needs root-causing; not
  required for the four §7.3 dimensions.
- **Coverage:** all four §7.3 dimensions extractable from this single
  source. Primary V1.1 evidence stream for Cell A.
- **Liveness:** written only at `/save` / `/exit`. To capture mid-probe
  state, either `/save` between probes (deliberate flush) or use the
  in-process inspection path (§1.4).

### 1.2 CLI stdout — auxiliary, human-formatted

`interface.py` (~210 lines, fully read) is the print layer.
Per-turn prefixes:

| Prefix | Source | Carries |
|---|---|---|
| 💭 italic grey | `interface.internal_monologue` | Assistant `content` field (inner monologue). |
| 🤖 yellow bold | `interface.assistant_message` | `function_call.arguments.message` — the user-facing `send_message` payload. |
| 🧠 magenta bold | `interface.memory_message` / function_message fallback | Memory-modifying tool calls (`updating memory with <function_name>`). |
| ⚡🟢 / ⚡🔴 | `interface.function_message` | Function success / error result. |
| 🧑 green bold | `interface.user_message` | User's prompt echoed back (in `json` form). |

**Default DEBUG=False** (`interface.py:11`); tool-call args and intermediate
function messages route through `printd` (suppressed) unless DEBUG flipped.
The `--strip_ui` CLI flag (`main.py:142`) drops ANSI escapes but keeps the
prefix structure, helpful for grep-based parsing.

**Coverage:** all four dimensions visible to a human reader; structured
extraction by regex is feasible but pickle (§1.1) is cleaner. Use stdout
when verifying a single probe by eye during V1.3 dry-runs.

### 1.3 Verbose / debug logging

- `--debug` flag (`main.py:143`) exists but routes through `printd`; in
  practice it controls whether `function_message` prints intermediate
  "Running …" lines, not whether structured per-event JSON is emitted.
- `--strip_ui` (`main.py:142`) for ANSI removal.
- **No JSON-structured event log option.** The CLI does not have an
  equivalent of OpenClaw's `--log-level trace`. Structured per-event
  capture must come from the pickle (§1.1) or from in-process inspection
  (§1.4).

### 1.4 In-process state inspection

Possible via a small Python script that imports the agent, calls a probe
turn, and inspects `agent.persistence_manager.all_messages` mid-conversation
without going through `/save`. The fork's `Agent` is loop-inert per
Stage 0 spike 4 (`CLAUDE.md` NON-NEGOTIABLES item 7 references).

Optional for V1.1; only needed if V1.3 wants per-turn state without
`/save` overhead. Default plan is `/save` after each probe (cheap, on the
order of <100 ms — pickle write of a few KB).

### 1.5 Sidecar curl endpoints

Not applicable to Cell A — no sidecar. Cell A's recall corpus is reachable
only via pickle inspection (§1.1).

---

## 2. Evidence streams in Cell C

Source: plugin at `462084c` per `docs/v1-cells.md` §2.

### 2.1 Sidecar persistence pickle — primary structured source

- **Path:** `~/.openclaw-dev/memgpt-data/agents/<namespace>/persistence_manager/<timestamp>.persistence.pickle`
- **Writer:** identical `LocalStateManager.save` to Cell A — same class,
  same fork code path (the plugin's sidecar imports `pymemgpt` from the
  fork as a dependency).
- **Shape:** **byte-identical structure to Cell A's pickle** (verified
  empirically against `vs-cross-session-test` fixtures): 3-key dict
  `{recall_memory, messages, all_messages}`; each `all_messages` entry
  `{timestamp, message}`; same `message` field shapes per role.
- **Liveness:** written per-turn at `agent_end` via the plugin's mirror
  hook (D1 declared deviation, §4.5). Always current at probe boundaries —
  no manual `/save` needed.
- **Coverage:** all four §7.3 dimensions. Primary V1.1 evidence stream for
  Cell C, matching the Cell A primary stream for clean comparison.

**Implication for V1.4.** One parser, two inputs. Walking `all_messages`
by index against the same probe sequence gives a direct event-by-event
comparison. The §4 free variables (mirror cadence, tool-result envelope
shape) require minor normalisation at extraction time; see §3 below.

### 2.2 Session JSONL — supplementary OpenClaw-side stream

- **Path:** `~/.openclaw-dev/agents/main/sessions/<session-id>.jsonl`
- **Writer:** OpenClaw runtime (one record per event).
- **Shape:** newline-delimited JSON. First line: session header
  `{type:"session", version:3, id, timestamp, cwd}`. Subsequent lines:
  - `{type:"model_change", id, parentId, timestamp, provider, modelId}`
  - `{type:"thinking_level_change", id, parentId, timestamp, thinkingLevel}`
  - `{type:"custom", customType, data, id, parentId, timestamp}`
  - `{type:"message", id, parentId, timestamp, message:{...}}` ← primary
- **Inner `message` shapes:**
  - `role=user`: `{role, content, timestamp}`
  - `role=assistant`: `{role, content, api, provider, model, usage, stopReason, timestamp, responseId}`; `content` is an array of blocks:
    - `{type:"text", text}` — inner monologue.
    - `{type:"toolCall", id, name, arguments}` — tool invocation.
  - `role=toolResult`: `{role, toolCallId, toolName, content, isError, timestamp}` — tool response.
- **Use in V1.4.** Cross-check against the sidecar pickle when role-tagging
  differs (the §4.4 tool-result envelope deviation). Provides OpenClaw's
  view of the turn; pickle gives the sidecar's view; both should agree on
  content modulo the documented free variables.

### 2.3 OpenClaw trace logs

- **Activation:** `openclaw --dev … --log-level trace`.
- **Notable per-turn artefact:** `finalPromptText` carries
  `"N previous messages in recall memory, M in archival memory"` per
  `CLAUDE.md` V1 PROTOCOL — the agent's view of memory counts at prompt
  build time, useful for the recall-growth fast sanity check.
- **Use in V1.4.** Supplementary; cross-validates that pickle growth
  matches the agent's view. Not required for the four dimensions.

### 2.4 Sidecar curl endpoints — independent retrieval verification

- `POST /agents/{namespace}/recall:search` — what `conversation_search`
  would surface to the agent next turn.
- `POST /agents/{namespace}/archival:search` — same for
  `archival_memory_search`.
- **Use in V1.4.** Independent verification that pickle contents are
  actually retrievable by the LLM-visible search path, not just on disk
  (the two-channel verification from `CLAUDE.md` V1 PROTOCOL). Not part of
  the §7.3 dimension extraction matrix; used only when a dimension's
  divergence needs root-causing.

---

## 3. Per-dimension extraction recipe

The 4 × 2 matrix. Each cell defines the parsing rule, input field, and the
shape V1.4 consumes.

Universal extraction primitive — define once, used by all four dimensions:

```python
# Pseudocode — concrete impl in V1.4
def extract_steps(pickle_path) -> list[Step]:
    """Walk all_messages, group into 'steps' (one user-message → one or more
    assistant turns → terminator). Each Step carries: user_msg, monologue[],
    tool_calls[], tool_results[], send_message_text|None."""
    with open(pickle_path, "rb") as f:
        d = pickle.load(f)
    return _group_steps(d["all_messages"])
```

A "step" corresponds to a probe's full request-response cycle: one user
prompt followed by the agent's chain of internal tool calls and the
terminal `send_message`. The `_group_steps` helper is the only piece of
V1.4 logic that differs between cells (because of §4.4 tool-result envelope
shape); from there, the four dimensions read fields off `Step` uniformly.

### 3.1 Proactive tool invocation

| Field | Cell A | Cell C |
|---|---|---|
| Source | pickle `all_messages` | pickle `all_messages` (same) |
| Extract | for each `role=assistant` entry with `function_call`: emit `(function_call.name, function_call.arguments)` | same |
| Tool name | `message.function_call.name` | `message.function_call.name` |
| Arguments | `parse_json(message.function_call.arguments)` | same |
| Per-step grouping | step ends at terminal `send_message` (heartbeat-driven chain folds into one step) | same |

**Parsing rule.** Per step, accumulate the multiset of tool names called.
Capture argument shapes (keys only, not values) for the manual-review
trail.

**V1.4 comparison input.** Per probe, per cell:

```json
{
  "probe_id": "p3",
  "trial_id": 7,
  "tools_by_step": [
    {"step_idx": 0, "tools": {"archival_memory_insert": 1, "send_message": 1}},
    {"step_idx": 1, "tools": {"archival_memory_search": 1, "send_message": 1}}
  ]
}
```

Equivalence per §5 of `docs/v1-cells.md`: same tool-name set per step, per-
tool count within ±1, order ignored.

### 3.2 Inner monologue

| Field | Cell A | Cell C |
|---|---|---|
| Source | pickle `all_messages` | pickle `all_messages` (same) |
| Extract | for each `role=assistant` entry, take `message.content` (the prose; function_call lives separately) | same |
| Length-cap check | `len(content)` against the documented cap | same |
| User-leakage check | confirm assistant `content` does **not** contain the user-facing text — that should live only in `function_call.arguments.message` (the `send_message` payload) | same |

**Parsing rule.** Per step, concatenate the `content` fields of all
assistant messages in the chain. Mid-chain "heartbeat" assistant messages
contribute their own monologue prose.

**V1.4 comparison input.** Per probe, per cell:

```json
{
  "probe_id": "p3",
  "trial_id": 7,
  "monologue_by_step": [
    {
      "step_idx": 0,
      "text": "<concatenated inner monologue>",
      "char_count": 412,
      "user_leakage": false
    }
  ]
}
```

Equivalence: categorical half (present, within cap, no leakage) checks
categorically per §5; substantive half computes Jaccard ≥0.5 over content-
word tokens (NLTK stopwords removed, lowercase, punctuation stripped).
Below-threshold trials escalate to manual rubric review.

### 3.3 `send_message` discipline

| Field | Cell A | Cell C |
|---|---|---|
| Source | pickle `all_messages` | pickle `all_messages` (same) |
| Extract | for each `role=assistant` with `function_call.name == "send_message"`: `parse_json(function_call.arguments).message` | same |
| Leakage detector | scan **all** assistant `content` across the chain for non-empty user-facing strings; flag if any non-monologue user-addressed text appears outside `send_message` | same |

**Parsing rule.** Per step, exactly one `send_message` should appear at the
chain terminus; zero non-`send_message` user-facing output. Concretely, the
detector flags failure if assistant `content` contains
imperative/declarative second-person prose AND no `send_message` carries
the same content in `arguments.message`.

The detector is necessarily imprecise — assistant `content` is supposed to
be inner monologue, which is third-person reasoning. If the monologue
drifts into second-person ("I'll tell you that …"), that's a leakage
signal even if a `send_message` follows. Manual rubric check on flagged
cases.

**V1.4 comparison input.** Per probe, per cell:

```json
{
  "probe_id": "p3",
  "trial_id": 7,
  "send_message_calls": [
    {"step_idx": 0, "text": "<user-facing payload>"}
  ],
  "leakage_flags": []
}
```

Equivalence per §5: zero leakage flags, exactly one `send_message` per
step, payload text non-empty. 100% threshold — categorical pass/fail per
trial.

### 3.4 Memory-tier reasoning

| Field | Cell A | Cell C |
|---|---|---|
| Source | pickle `all_messages` | pickle `all_messages` (same) |
| Tool→tier map | `core_memory_*` → core; `archival_memory_*` → archival; `conversation_search` / `recall_memory_search` / `conversation_search_date` → recall; `send_message` excluded | same |
| Tier count per step | count tool invocations per tier | same |
| Tier rubric | per probe, V1.3 specifies the expected tier ("core for durable identity facts, archival for searchable long-term, recall for conversation history") | same |

**Parsing rule.** Per step, classify each tool call by tier using the
fixed map above. Emit a per-step counts dict; emit the per-probe expected
tier from V1.3's probe specification.

**V1.4 comparison input.** Per probe, per cell:

```json
{
  "probe_id": "p3",
  "trial_id": 7,
  "expected_tier": "archival",
  "tiers_by_step": [
    {"step_idx": 0, "tiers": {"core": 0, "archival": 1, "recall": 0}}
  ]
}
```

Equivalence per §5: same dominant tier choice per step in both cells ≥80%
of probe×trial cells. Misses escalate to manual rubric review (the §7.4
"defensible alternative" check — Cell A picked archival, Cell C picked
recall for a borderline probe is reviewed, not auto-failed).

---

## 4. Parsing implementation notes

### 4.1 Single shared parser

Because Cell A and Cell C share pickle format, the V1.4 implementation is
**one parser module** with no per-cell branching at the field-extraction
level. Differences between cells are confined to:

- The path the pickle is loaded from (config-controlled).
- The `_group_steps` helper (§3) — Cell C's tool-result-as-`toolResult`-role
  vs Cell A's tool-result-as-`function`-role normalises here. Both are
  treated as a "tool result terminator" for grouping; downstream extractors
  are oblivious to the role tag.

### 4.2 Cross-validation: session JSONL ↔ pickle (Cell C only)

For Cell C, the session JSONL and the sidecar pickle should agree on the
turn's tool-call sequence and `send_message` payload. A divergence is a
mirror-cadence symptom (§4.5 / D1) or a bug — surface to manual review.
The session JSONL is read only for cross-validation in V1.4, not for
dimension extraction.

### 4.3 Automation vs manual

- **Fully automated** (no human in loop): tool invocation count, monologue
  length cap, user-leakage flag, `send_message` discipline categorical
  check, tier classification.
- **Automated with manual review trigger**: monologue Jaccard (below 0.5
  triggers review); memory-tier reasoning (mismatches trigger rubric).
- **Manual only**: rubric scoring on flagged cases. V1.4 produces a
  flagged-cases report; reviewer decides "real divergence" vs "defensible
  alternative" vs "stochastic noise."

### 4.4 Tool dependencies

- Python 3.12 (`uv` env in `memgpt-service`).
- `pickle` (stdlib), `json` (stdlib).
- For Jaccard: NLTK or scikit-learn for tokenisation/stopword removal.
- No probe execution code in V1.4 — V1.3 produces probe artefacts, V1.4
  reads them. The parser script lives in the plugin repo
  (`tools/v1-extract.py` or similar; path settled in V1.3).

### 4.5 LiteLLM-augmented assistant fields

Both cells go through the LiteLLM chain, so assistant messages carry the
LiteLLM-added `refusal, annotations, audio, tool_calls,
provider_specific_fields` keys observed in §1.1. These are LiteLLM
artefacts and are **ignored** by the parser — V1.4 reads only `role`,
`content`, and `function_call` from assistant messages.

---

## 5. Equivalence comparison input shape

V1.4 reads one JSON record per cell per probe per trial, of the form:

```json
{
  "cell": "A",
  "probe_id": "p3",
  "trial_id": 7,
  "tools_by_step": [...],
  "monologue_by_step": [...],
  "send_message_calls": [...],
  "leakage_flags": [...],
  "tiers_by_step": [...],
  "expected_tier": "archival"
}
```

Aggregation: V1.4 groups by `(probe_id, trial_id)`, pairs Cell A and Cell C
records, computes per-dimension equivalence per `docs/v1-cells.md` §5
thresholds, and aggregates across the probe×trial matrix to apply the
aggregate gate. Output is a pass/fail per dimension plus a flagged-cases
report for manual review.

---

## 6. Edge cases and known artefacts

### 6.1 `livenessState:"abandoned"` in OpenClaw CLI summary

Per `CLAUDE.md` V1 PROTOCOL and `docs/methodology-bank.md` §6c.9.2: every
successful `send_message` turn surfaces
`livenessState:"abandoned"` + `payloads:0` + `⚠️ Agent couldn't generate a
response` in OpenClaw's CLI summary because `send_message` is not in
OpenClaw's `CORE_MESSAGING_TOOLS` set. **This is a false-negative success
indicator.** V1.4 must not consume the `--json` envelope's success fields
for any acceptance logic. Verification routes through the pickle and the
sidecar curls per the two-channel V1 PROTOCOL.

### 6.2 Tool-result envelope shape (§4.4 free variable)

Cell A: function-role result paired with the assistant's `function_call`.
Cell C: separate `toolResult`-role entry per the 6c.9.4 finding.

Handled in `_group_steps` — both terminators close a chain segment. The
dimension extractors read the result's `content` field uniformly. No V1.4
dimension threshold is sensitive to the role tag.

### 6.3 Within-turn mirror gap (§4.2 free variable)

If a probe involves the agent calling `conversation_search` mid-step on
something the agent itself said earlier in the same step, Cell C's recall
will not surface it (per-turn mirror lag, §4.5 declared deviation) while
Cell A's will. This is the documented first suspect when memory-tier
reasoning diverges on a `conversation_search`-bearing probe; V1.4 should
annotate, not auto-fail.

### 6.4 LiteLLM-augmented fields in assistant messages

Documented in §4.5; ignored by parser. Worth noting because a naive walk
of assistant message keys will surface these and look like "extra state";
they are LiteLLM bookkeeping, not pymemgpt behaviour.

### 6.5 Cell A `/save` cadence

Cell A pickle is current only at `/save` / `/exit`. V1.3 must `/save`
after each probe before reading the pickle, or use the in-process
inspection path (§1.4). V1.4 assumes pickle is current at probe
boundaries — V1.3 enforces this.

### 6.6 Cross-session namespace contamination

Per V2 follow-up #7 in `docs/v2-followups.md`: switching `namespace`
mid-conversation in Cell C can cause OpenClaw's session buffer to be
ingested into the new namespace's recall log. V1 probes should pin a
single namespace per probe set; V1.3 enforces this in probe-runner
configuration. V1.4 does not need to detect contamination — it should
not happen at all if V1.3 is configured correctly.

### 6.7 Cell A LiteLLM `tool_calls` vs `function_call`

Modern LiteLLM emits both the legacy `function_call` field (used by
pymemgpt) and the newer `tool_calls` array. The fork's
`handle_ai_response` reads `response_message.function_call` (`agent.py:949`)
— so the legacy field is what's persisted and what the parser reads.
If a future LiteLLM release drops `function_call` in favour of
`tool_calls` only, the fork's translator (`memgpt/openai_tools.py`
boundary at `e348f1d`) will bridge; pickle shape stays
`function_call`-centric. V1.4 reads `function_call`; no `tool_calls`
fallback needed for V1.

---

## Open question for V1.3

V1.1's investigation stayed source-level; no live probe was run as part of
this stage. The probe-execution path is straightforward (Cell A: type
prompts into `memgpt run` then `/save`; Cell C: invoke `openclaw … agent`
per probe). The brief flagged "if MemGPT CLI's structured-data extraction
turns out to need substantial work, surface that as a V1.1.1 sub-task" —
**no such follow-up is needed**. Pickle is the structured source; it
needs no wrapper, and its shape is identical to Cell C's. V1.1 closes
without a V1.1.1 sub-task.

V1.3 should record per-probe pickle paths (timestamped) so V1.4 has a
deterministic mapping from `(probe_id, trial_id)` to a pickle file per
cell.

---

## Changelog

- 2026-06-07 — V1.1 initial freeze. Cell A evidence streams catalogued via
  fork source read (`interface.py`, `agent.py`, `main.py`,
  `persistence_manager.py`). Cell C evidence streams confirmed against
  live `~/.openclaw-dev/agents/main/sessions/vs-s2-strict.jsonl` and
  `vs-cross-session-test` pickle fixtures. Foundational finding: Cell A
  and Cell C share identical pickle format (3-key dict via
  `LocalStateManager.save`), so V1.4 reads one parser. Per-dimension
  extraction recipe specified for all four §7.3 dimensions. No
  V1.1.1 sub-task required.
