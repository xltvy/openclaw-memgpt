# V1 — Cell Definitions and Rig Design

Design artefact for the §7 A≈C validation. Frozen here so V1.1 (observability
mapping) and V1.3 (probe runs) implement against a stable target. Updates to
this file are deliberate and signposted in the changelog at the foot.

Scope: defines the two cells, the variables held constant, the variables
allowed to differ (with reasoning), the per-dimension equivalence thresholds,
and the failure-mode diagnostic ladder. Does not define probes — that is V1.3.
Does not define observability — that is V1.1.

The §7 protocol nominally has three cells (A, B, C). V1.0 freezes A and C; B
remains droppable per §7.2 ("recommended but droppable under scope pressure").
If B is added later, it inherits the same controlled-variable discipline as A
and C, with the prompt swapped for the unmodified one.

---

## 1. Cell A — reference (unmodified MemGPT loop)

**Role.** "How it should behave." The behavioural target Cell C is measured
against. Drives the §7.3 four dimensions through MemGPT's own runtime loop.

**Source base.** Fork commit `f46cc3b` (pre-modification upstream baseline) with
one adapter-layer port applied:

- `109817c` — `LocalStateManager.load` recall reference-repair (F2).

F1 (cutoff factoring, `e2c8c93`) is **omitted**. F1 is a pure refactor confirmed
byte-equivalent by `tests/test_cutoff_equivalence.py`; including or excluding
it makes zero behavioural difference, and pristine reads cleaner as the
baseline framing.

F2 is **included as a test-rig adapter, not an architectural modification.** It
patches a latent upstream bug in which `recall_memory._message_logs` and
`all_messages` become independent objects after unpickle, so post-`:load`
appends are invisible to `text_search`. Without F2, the V1.3 cross-session
probes would produce false-negative recall results in Cell A — a Cell A defect
unrelated to the architectural comparison Cell C is being measured for. Cell A
is therefore "MemGPT at the runtime level required to test the dimensions of
interest," not "MemGPT exactly as upstream."

**Build.** From the fork repo:

```bash
cd ~/Workspace/UCL/dissertation/memgpt-service
git checkout -b v1-cell-a f46cc3b
git cherry-pick 109817c   # F2 only; do not pick e2c8c93 (F1)
uv sync
```

**Configure.** Persona and human strings (§3) written into the standard CLI
locations:

```bash
mkdir -p ~/.memgpt/personas ~/.memgpt/humans
cat > ~/.memgpt/personas/sam_v1.txt <<'EOF'
Sam is a friendly AI assistant with an extensive knowledge base.
EOF
cat > ~/.memgpt/humans/researcher_v1.txt <<'EOF'
The user is a researcher exploring AI memory architectures.
EOF
```

Endpoint env (same chain as Cell C — §2 Q2):

```bash
export OPENAI_API_BASE=http://localhost:4000/v1
export OPENAI_API_KEY=sk-local-dev-only
```

**Run.** Three terminals (proxy shim, LiteLLM, MemGPT CLI). Terminals A and B
identical to the vertical-slice setup in `CLAUDE.md` "RUNNING THE STACK". The
MemGPT CLI replaces the OpenClaw terminal:

```bash
# Terminal C — MemGPT CLI
cd ~/Workspace/UCL/dissertation/memgpt-service
source ~/.secrets
uv run memgpt run \
  --persona sam_v1 \
  --human researcher_v1 \
  --model gpt-5.4 \
  --no-verify
```

Probe interaction model: probes are typed (or scripted) into the interactive
CLI. Cross-session probes terminate session 1 with `/save` then `/exit`, and
resume in a fresh `memgpt run` invocation. The on-disk agent directory under
`~/.memgpt/agents/` is the persistence boundary; deleting or archiving it
between probe sets forces a fresh agent.

---

## 2. Cell C — shipped (adapted prompt, OpenClaw runtime)

**Role.** The configuration we ship and measure. The headline claim is
behavioural equivalence to Cell A across the §7.3 dimensions.

**Source base.** Plugin at `462084c` (current `feat/v1-cells` parent, post-
6c.10 spawn-lifecycle close). Fork dep tracked via the plugin's editable
install — pins to fork-`main` at `0c31f10` for V1 runs.

**Configure.** `~/.openclaw-dev/openclaw.json` entry for the plugin (per
`CLAUDE.md` "Configure the plugin"):

```json
"entries": {
  "openclaw-memgpt": {
    "enabled": true,
    "config": {
      "namespace": "v1-cell-c",
      "model": "gpt-5.4",
      "persona": "Sam is a friendly AI assistant with an extensive knowledge base.",
      "human": "The user is a researcher exploring AI memory architectures."
    }
  }
}
```

`sidecarUrl` is **deliberately omitted** so spawn mode fires (§2 Q2 — restart
mechanic must match the cross-architecture benchmark cells).

LLM provider config in `~/.openclaw-dev/agents/main/agent/models.json` per
`CLAUDE.md` "Configure the LLM provider" — explicit `gpt-5.4` entry with
`api: "openai-completions"` and `request.allowPrivateNetwork: true`.

**Run.** Three terminals (proxy shim, LiteLLM, OpenClaw). Sidecar terminal is
absent: spawn mode owns its lifecycle.

```bash
# Terminal A — proxy shim (port 4100)
cd ~/Workspace/UCL/dissertation/openclaw-memgpt/sidecar
source ~/.secrets && uv run uvicorn proxy_shim:app --host 127.0.0.1 --port 4100

# Terminal B — LiteLLM proxy (port 4000)
cd ~/Workspace/UCL/dissertation/openclaw-memgpt/sidecar
source ~/.secrets && uv run litellm --config litellm_config.yaml --port 4000

# Terminal C — OpenClaw (sidecar spawned and torn down by the plugin)
source ~/.secrets && openclaw --dev agent --local --agent main \
  --message "<probe text>" --json
```

Session boundary: cross-session probes restart the OpenClaw process. In spawn
mode this triggers sidecar restart (via `registerService.stop` → SIGTERM →
fresh spawn on next OpenClaw run). The data dir at
`~/.openclaw-dev/memgpt-data` persists across restarts and carries the agent
across sessions via `:load`.

For strict cross-session isolation (block OpenClaw buffer-replay carrying
markers forward), archive `~/.openclaw-dev/agents/main/sessions/*.jsonl` and
`sessions.json` aside between sessions per `CLAUDE.md` V1 PROTOCOL.

---

## 3. Controlled variables

Identical across cells. Any difference here is an experimental error, not a
result.

| Variable | Value |
|---|---|
| LLM endpoint | `http://localhost:4000/v1` (LiteLLM:4000 → shim:4100 → institutional Bedrock) |
| Model id | `gpt-5.4` |
| Served model | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 via institutional Bedrock gateway). Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) tried and rejected on 2026-06-09 — failed p1's `send_message`-discipline criterion by explicit `request_heartbeat=false` on `core_memory_append`; see `methodology-bank.md` #15. |
| Temperature | 0 (low/zero per §7.4 — minimise stochastic variance) |
| Persona string | `Sam is a friendly AI assistant with an extensive knowledge base.` |
| Human string | `The user is a researcher exploring AI memory architectures.` |
| Probe prompt set | Defined in V1.3; identical text across cells per §7.4 |
| Trials per probe | Defined in V1.3 per §7.4 (statistical equivalence requirement) |

Endpoint chain rationale (Q2): the LiteLLM → shim → Bedrock chain is the same
one Cell C uses operationally; reusing it for Cell A controls for endpoint
variance (auth, parsing, latency, request shaping).

What is **not** controlled is the request envelope reaching the endpoint. The
V1.0 freeze claimed "Both cells exercise the identical wire format upstream"
on intuition; V1.3 setup surfaced this as empirically false (Cell A emits
pre-v1 OpenAI Functions API; Cell C emits modern `tool_use` schema), and a
single-probe equivalence check confirmed the envelope difference is
non-material for the §7.3 dimensions. See §4.5 (declared deviation),
`methodology-bank.md` entry #12 (empirical evidence), and `/tmp/wire-format-check.md`
(raw responses). The controlled variable is the served model, not the wire
shape.

The persona/human strings are verbatim the 6c.9 vertical-slice strings
(`CLAUDE.md:336`) so V1 reuses an already-exercised configuration rather than
introducing fresh prompt-conditioning variance.

---

## 4. Free variables — declared deviations

Expected to differ between Cell A and Cell C. Each is a documented declared
deviation from §4.5 / D1, not a comparison failure. V1.4 normalises across all
four when computing the §5 thresholds.

### 4.1 Persistence cadence

- **Cell A.** Persists only at `/save` or `/exit`. The unmodified MemGPT CLI
  has no per-turn flush — it relies on user-driven `/save` and process-exit
  flush.
- **Cell C.** Per-turn `agent_end` flush of all three tiers (D1 declared
  deviation; §4.5).

**Normalisation.** Compare end-state recall content at session boundaries
only. Within-session intermediate state in Cell A may have unflushed buffer
content; this is structural and irrelevant to behavioural dimensions.

### 4.2 Within-turn mirror visibility

- **Cell A.** Per-message mid-turn: `append_to_messages` fires per message, so
  `conversation_search` issued mid-turn finds same-turn messages.
- **Cell C.** Per-turn atomically at `agent_end`: same-turn messages are not
  yet in `all_messages` when the agent issues mid-turn `conversation_search`
  (§4.5 declared deviation).

**Normalisation.** First suspect if §5's memory-tier-reasoning dimension
diverges. Specifically, any probe trial where Cell A's agent recalls
something said earlier in the same turn but Cell C's agent does not is
attributable to this deviation, not architectural failure. V1.4 should flag
such trials and inspect rather than count as divergence.

### 4.3 Session-restart mechanism

- **Cell A.** CLI process exit (`/exit` or kill) and relaunch with `:load` at
  next `memgpt run`. The agent file at `~/.memgpt/agents/<name>/` persists
  state across restarts.
- **Cell C.** OpenClaw process restart, which in spawn mode triggers sidecar
  restart automatically via `registerService.stop` → SIGTERM → fresh spawn at
  next OpenClaw run.

**Why spawn mode (not attach) for Cell C.** The Mem0 and MemOS benchmark
cells (V2 cross-architecture work) will use OpenClaw process restart as their
session-boundary mechanism. Using spawn mode for Cell C keeps the restart
mechanic consistent across all three memory architectures, avoiding an
uncontrolled variable when the cross-architecture benchmarks land later.
Attach mode remains available as a debugging escape hatch but is not the V1
configuration.

**Normalisation.** Both routes exercise `LocalStateManager.load`. Equivalence
target: post-restart recall search of pre-restart markers succeeds in both
cells. Differences in restart wall-clock time are not part of any §5
dimension and are ignored.

### 4.4 Tool-result entry shape in recall log

- **Cell A.** Tool result recorded as a `function`-role message paired with
  the assistant's `function_call` — the pre-v1 functions API shape.
- **Cell C.** Tool result recorded as a separate `toolResult`-role entry per
  the 6c.9.4 finding (`docs/methodology-bank.md`, §6c.9.4). OpenClaw does not
  fold the result back into `function_call.arguments`.

**Normalisation.** V1.4 comparison matches on the _content_ of the tool
result, not the wrapping role tag. The §5 dimensions are agent-behavioural
choices — what tool was invoked, with what arguments, in response to what —
not the storage envelope around the response.

### 4.5 LLM wire format

- **Cell A.** Pre-v1 OpenAI Chat Completions with `functions` /
  `function_call` / role=function messages. This is the wire format pre-v1
  MemGPT was built against (2023 OpenAI SDK era), pinned upstream and not
  modifiable in the fork per the PERMITTED CHANGES discipline (`CLAUDE.md`).
- **Cell C.** Modern OpenAI Chat Completions with `tools` / `tool_calls` /
  role=tool, as `normalise.ts` produces from OpenClaw's session buffer.

**Why this is a deviation, not a controlled variable.** The V1.0 freeze
implicitly assumed both cells reached the LLM with identical wire shape
because they share the LiteLLM → shim → Bedrock chain. LiteLLM was expected
to translate both shapes into valid Anthropic Messages on the way to
Bedrock. In practice, LiteLLM's translator mints independent
`uuid.uuid4()` values for the assistant `tool_use.id` and the matching
`tool_result.tool_use_id` when fed pre-v1 Functions API
(`litellm/litellm_core_utils/prompt_templates/factory.py:1877-1898` and
`:1859-1868`), producing malformed Messages that Anthropic rejects on
multi-turn agent runs. Cell A and Cell C therefore cannot reach the same
endpoint with the same envelope without a Cell A-specific upgrade pass.

**Normalisation.** Empirically checked (single-probe, single-trial; see
`methodology-bank.md` entry #12 and `/tmp/wire-format-check.md`): the same
served model, given a conversation expressed either as modern `tool_use`
shape via LiteLLM or as the same conversation hand-translated to valid
Messages bypassing LiteLLM, produces token-equivalent input (701/701) and
agent-loop-equivalent output (same tool-selection decision, same recall
content, output-token deltas within single-token noise). V1.4 treats §7.3
dimensions as wire-format-robust on this basis. The §6.5 ladder picks up
the residual confound (richer multi-turn probes may exhibit subtler
envelope-induced variance not visible on the PINEAPPLE_8101 pair).

**Operational consequence.** Cell A's chain is no longer load-bearing as
an envelope-equivalence control. A Cell A-specific pre-LiteLLM pass that
upgrades pre-v1 Functions API to modern `tool_calls` / role=tool shape
suffices to reach the served model in a form LiteLLM's translator handles
correctly; this is plumbing, not architecture, and lives outside the fork
per the PERMITTED CHANGES discipline. See §7 (Cell A operational chain)
for the chain shape, adapter role, and discipline boundary.

---

## 5. Equivalence thresholds per §7.3 dimension

Each dimension carries its own threshold reflecting whether divergence is
architecturally meaningful or stochastic. The thresholds are calibrated to
distinguish "the architecture preserves behaviour" from "the LLM rolled the
dice differently on this trial."

| Dimension | Threshold | Rationale |
|---|---|---|
| **`send_message` discipline** | 100% — every user-facing utterance routes through `send_message`; zero raw-content leakage across all probe×trial cells | Categorical, architectural. The §4.3 turn-termination gate either works on every turn or doesn't. Any failure here is a real defect, not noise. Doubles as the §4.3 acceptance test (§7.3 dimension 3). |
| **Tool invocation** | ≥95% — same set of tools called per probe, per-tool count within ±1, order may differ | Categorical, mostly architectural. The tool-name alignment and chain-yield structure either survive the prompt adaptation or don't. ≥95% allows occasional stochastic substitution of equivalent tools without flagging architectural failure. |
| **Memory-tier reasoning** | ≥80% same tier chosen per probe (core / archival / recall), with manual review of misses | Semantic, requires rubric. Tier choice is stochastic at the margin (core vs archival for "remember this"); ≥80% with rubric review catches structural drift while tolerating LLM noise. Manual review distinguishes "wrong tier" from "defensible alternative." |
| **Inner monologue (substantive)** | ≥70% of trials with Jaccard ≥0.5 over content-word tokens; below-threshold trials escalated to manual rubric review | Stochastic by nature. The categorical half (monologue present, within length cap, no user-channel leak) is checked separately as part of `send_message` discipline. The substantive half measures topical alignment, which is inherently noisier. |

**Aggregate gate — A≈C holds when all of:**

1. All four per-dimension thresholds met.
2. **Zero** `send_message` failures across the full probe×trial matrix. (Categorical, no tolerance.)
3. No single probe with >50% failure rate across all four dimensions in the same trial set. (A probe failing >50% of dimensions in a coordinated way is an experimental-error signal — misconfigured cell, wrong endpoint, corrupted state — not stochastic noise.)

Conditions 2 and 3 are sanity checks layered on top of the per-dimension
gates; either firing means investigate before counting the run.

---

## 6. Failure-mode diagnostic ladder

If a dimension fails, follow the ladder. The §7.4 hint
("tool-invocation or tier failures implicate a prompt edit or tool-name
alignment; `send_message` or monologue failures implicate the runtime
composition") provides the top of the ladder; the rungs below come from
identified declared deviations and known fork touchpoints.

### 6.1 `send_message` discipline fails

1. **Runtime composition** — the §4.3 turn-termination gate is not closing
   correctly. Check `reply_dispatch` returns `{handled: true}` on the failing
   turn; check `before_prompt_build` is not auto-repairing a synthetic
   trailing assistant that bypasses the gate (`6c.9.2b` fix).
2. **Base prompt conflict** — OpenClaw's default base prompt has reinjected a
   "speak directly to the user" instruction conflicting with the
   `send_message` discipline (§4.2). Inspect the assembled prompt.
3. **Adapted prompt edit** — the §7 prompt adaptation has accidentally
   weakened the `send_message`-exclusive contract. Diff against the
   unmodified `memgpt_base.txt`.

### 6.2 Tool invocation fails

1. **Tool-name alignment** — adapted prompt names a tool the plugin does not
   register, or vice versa. Check `src/tools/schemas.ts` against the prompt's
   tool listing.
2. **Heartbeat harmonisation** — the adapted prompt expects a heartbeat
   mechanism OpenClaw does not provide. Check whether the adapted prompt
   references heartbeats verbatim.
3. **Prompt edit regression** — the adapted prompt has trimmed a load-bearing
   tool-selection instruction. Diff against the unmodified prompt.

### 6.3 Memory-tier reasoning fails

1. **Within-turn mirror gap (4.2)** — the failing trials all involve recall
   of same-turn content. This is the §4.5 declared deviation; normalise out
   and re-measure.
2. **Tier-routing prompt drift** — the adapted prompt has weakened the
   core-vs-archival-vs-recall guidance. Diff against the unmodified
   `memgpt_base.txt` tier instructions.
3. **Cold-start path corruption** — Cell C agent loaded via `:load` with
   diverged recall index. Confirm F2 fix is taking effect on Cell C (it
   should — fork dep tracks fork-`main` which has F2 merged). For Cell A,
   confirm F2 cherry-pick succeeded.

### 6.4 Inner monologue (substantive) fails

1. **Stochastic noise** — re-run at temperature 0 with fresh seed; LLM
   monologue is the noisiest dimension. Confirm temperature config in both
   cells.
2. **Persona drift** — Cell A and Cell C are reading different persona
   strings. Confirm §3 strings byte-identical in both setups.
3. **Prompt edit semantic shift** — the adapted prompt has changed the
   monologue framing in a way that conditions different reasoning paths.
   Diff against the unmodified prompt.

### 6.5 Multiple dimensions fail simultaneously on the same probe

Likely experimental error, not architectural divergence. Sanity-check:

1. Cell endpoint configuration — both reaching the same served model
   (Claude Sonnet 4.5 via the institutional Bedrock gateway).
2. Persona/human strings — byte-identical across cells.
3. Cell C namespace not contaminated from a prior run (per V2 follow-up #7).
4. Cell A agent state not carrying over from a prior probe set (delete or
   archive `~/.memgpt/agents/<name>/` between probe sets).
5. **Wire-format-induced LLM response variance (residual confound from §4.5).**
   Cell A's Functions API → upgraded → Anthropic Messages pipeline and Cell C's
   modern `tool_use` → Anthropic Messages pipeline produce
   structurally-near-identical Messages payloads at the Bedrock boundary
   (single-probe verified — `methodology-bank.md` entry #12), but the
   single-probe check does not cover richer multi-turn topologies. If a probe
   that exercises an unusual conversation structure (e.g., nested tool calls,
   long tool-result payloads, interleaved user clarifications between tool
   rounds) fails multiple dimensions together, capture the upstream Messages
   payload on both arms and diff structurally before counting it as
   architectural divergence. A repeatable structural difference at the
   Messages boundary is a §4.5 deviation widening, not a §7 failure.

---

## 7. Cell A operational chain

**Shape.**

```
MemGPT (pre-v1 Functions API)
  → cell-a-adapter:4200 (rewrites Functions API → modern tool_calls)
  → LiteLLM:4000 (translates OpenAI tools → Anthropic Messages)
  → shim:4100 (transport-layer adapter for the Bedrock gateway)
  → institutional Bedrock gateway
```

Cell C's chain is unchanged from V1.0:
`OpenClaw → LiteLLM:4000 → shim:4100 → Bedrock`. Cell A's chain is one hop
longer by design: the adapter exists because pre-v1 MemGPT's wire format
cannot reach Anthropic through LiteLLM without an upgrade pass (§4.5
*Why this is a deviation*). The asymmetry is not a control failure — the
controlled variable is the served model, not the chain shape (§3
refinement, this changelog entry dated 2026-06-09).

**Adapter role.** Walk paired `function_call` (assistant) and role=function
(result) turns in conversation order, mint a single `tool_call_id` per pair,
and emit the equivalent modern Chat Completions request with `tools` /
`tool_calls` / role=tool. Downstream, LiteLLM's translator hits the working
branch at `convert_to_anthropic_tool_invoke` (`litellm/litellm_core_utils/prompt_templates/factory.py:1901`)
which preserves the OpenAI `tool.id` as the Anthropic `tool_use.id` (line
1956), keeping the pairing intact. Empirical evidence that this is
dimensionally equivalent to Cell C's path: `methodology-bank.md` entry #12.

**Endpoint resolution.** On the `v1-cell-a` fork branch, the OpenAI SDK
endpoint is sourced from the `OPENAI_API_BASE` environment variable
(`memgpt/openai_tools.py:8-14`), not from `~/.memgpt/config`'s
`model_endpoint` field. The MemGPT terminal must export
`OPENAI_API_BASE=http://localhost:4200/v1` before invoking `memgpt run` —
otherwise the adapter is silently bypassed and requests hit LiteLLM directly,
reproducing the original wire-format blocker. See `methodology-bank.md`
entry #13 for the diagnosis trail.

**Discipline boundary.** The adapter is plumbing, not architecture. It does
not touch `memgpt/**` (forbidden per the fork's PERMITTED CHANGES) and does
not extend `proxy_shim.py` (the shim's own discipline forbids API-flavour
translation; `proxy_shim.py:44-50`). It lives in `cell-a-adapter/` at the
openclaw-memgpt repo root with its own venv, kept visibly separate from the
shim so the naming carries the intent ("adapter for Cell A" vs "transport
adapter for any Anthropic-flavour upstream").

**Four-terminal Cell A run recipe** (replaces §1's three-terminal recipe):

```
Terminal 1 — shim
cd ~/Workspace/UCL/dissertation/openclaw-memgpt/proxy
source ~/.secrets
uv run uvicorn proxy_shim:app --host 127.0.0.1 --port 4100

Terminal 2 — LiteLLM
cd ~/Workspace/UCL/dissertation/openclaw-memgpt/proxy
uv run litellm --config litellm_config.yaml --port 4000

Terminal 3 — Adapter
cd ~/Workspace/UCL/dissertation/openclaw-memgpt/cell-a-adapter
uv run uvicorn adapter:app --port 4200

Terminal 4 — MemGPT CLI
cd ~/Workspace/UCL/dissertation/memgpt-service
export OPENAI_API_BASE=http://localhost:4200/v1     # critical, see Endpoint resolution
uv run memgpt run --persona sam_v1 --human researcher_v1
```

**Implementation status.** Adapter source landed in `cell-a-adapter/` on
the `feat/v1-runs` branch; end-to-end smoke test passed on 2026-06-09
(MemGPT → adapter → LiteLLM → shim → Bedrock, with the first agent.step
producing inner monologue, `send_message` tool invocation, and a clean
user-facing reply). §1's build/run instructions superseded by the recipe
above for Cell A.

---

## Changelog

- 2026-06-07 — V1.0 initial freeze. Q1–Q5 resolved. Cell A = `f46cc3b` + F2
  (`109817c`); F1 omitted as pure refactor. Cell C = plugin at `462084c` in
  spawn mode (consistent with future Mem0 / MemOS benchmark cells). Endpoint
  chain shared via `OPENAI_API_BASE=http://localhost:4000/v1`. Persona /
  human / model strings reused from 6c.9. Per-dimension thresholds
  calibrated to architecture-vs-stochasticity per `send_message`=100% /
  tool-invocation≥95% / tier-reasoning≥80% / monologue≥70%. Aggregate gate
  layers two sanity checks (zero `send_message` failures; no probe with
  >50% dimensional failure) on top of the per-dimension thresholds.

- 2026-06-09 — V1.0 refinement: wire-format demotion. V1.3 setup surfaced
  that Cell A's pre-v1 Functions API and Cell C's modern `tool_use` schema
  cannot reach an Anthropic endpoint with identical wire shape via LiteLLM's
  translator. §3 rationale retracted the implicit "identical wire format
  upstream" claim in favour of "controlling the served model, not the wire
  shape." New §4.5 declares wire format as a deviation with empirical
  evidence of dimensional equivalence (PINEAPPLE_8101 fact-recall probe,
  token-identical input 701/701, agent-loop-equivalent output). New §6.5
  rung points at wire-format envelope variance as a residual confound to
  inspect before counting multi-dimensional probe failures as architectural.
  Threshold structure (§5) and aggregate gate unchanged. Empirical evidence
  banked at `methodology-bank.md` entry #12. Cell A operational chain
  documented in §7; adapter lives in `cell-a-adapter/` (implementation in
  the next task; §1 build/run instructions to be updated then).

- 2026-06-09 — V1.0 refinement: served-model freeze. §3 controlled-variables
  table now names the served model explicitly
  (`eu.anthropic.claude-sonnet-4-5-20250929-v1:0`). Haiku 4.5
  (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) was tried as a candidate
  and rejected: at p1, Haiku 4.5 chose the correct memory tier
  (`core_memory_append` on the `human` field) but explicitly emitted
  `request_heartbeat=false`, terminating MemGPT's heartbeat loop after the
  function result without chaining `send_message` — a structural fail of the
  §5 100%-`send_message` discipline criterion. Sonnet 4.5 re-verified clean
  end-to-end on the same probe: `core_memory_replace` (within-tier discipline
  choice) with `request_heartbeat=true` → synthetic heartbeat user message →
  chained `send_message` with coherent confirmation reply. Empirical
  evidence: `agent_9` pickle (Haiku 4.5 fail) and `agent_10` pickle (Sonnet
  4.5 pass). Banked at `methodology-bank.md` entry #15. §3 wire-format
  re-verification at Haiku 4.5 held (#12 update) — the rejection is purely
  on chain-discipline, not on envelope handling.
