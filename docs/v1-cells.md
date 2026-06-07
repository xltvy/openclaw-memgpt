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
| Temperature | 0 (low/zero per §7.4 — minimise stochastic variance) |
| Persona string | `Sam is a friendly AI assistant with an extensive knowledge base.` |
| Human string | `The user is a researcher exploring AI memory architectures.` |
| Probe prompt set | Defined in V1.3; identical text across cells per §7.4 |
| Trials per probe | Defined in V1.3 per §7.4 (statistical equivalence requirement) |

Endpoint chain rationale (Q2): the LiteLLM → shim → Bedrock chain is the same
one Cell C uses operationally; reusing it for Cell A controls for endpoint
variance (auth, parsing, latency, request shaping). Both cells exercise the
identical wire format upstream.

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

1. Cell endpoint configuration — both pointing at the same LiteLLM:4000.
2. Persona/human strings — byte-identical across cells.
3. Cell C namespace not contaminated from a prior run (per V2 follow-up #7).
4. Cell A agent state not carrying over from a prior probe set (delete or
   archive `~/.memgpt/agents/<name>/` between probe sets).

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
