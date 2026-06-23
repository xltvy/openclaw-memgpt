# V1.3 — Experimental Runs

Operational artefacts for the §7 A≈C validation. V1.3 executes the 7 probes
from `docs/v1-probes.md` against Cell A (reference MemGPT) and Cell C (shipped
plugin) per the cell definitions in `docs/v1-cells.md`, capturing structured
output in the V1.1 comparison-input shape (`docs/v1-observability.md` §5).

Scope of this README: the three V1.3 design choices that must be recorded
before execution, plus run-outcome documentation as runs land. Does not
re-state the probe set (V1.2), the cells (V1.0), or the observability mapping
(V1.1) — those documents are authoritative.

---

## 1. Cell A automation choice

**Chosen path: Python wrapper around `AgentAsync.step()`** (option 3 of the
three options flagged in the V1.3 brief). Implemented in `cell_a/`. Bootstraps
an `AgentAsync` via `presets.use_preset(...)` matching the bootstrap in
`memgpt-service/memgpt/main.py:340-348`; drives the heartbeat / function-failed
/ token-warning re-step chain from `main.py:583-617`; calls `agent.save()`
(`agent.py:406`) for pickle write; calls `AgentAsync.load_agent()`
(`agent.py:423`) for cross-session reload.

### 1.1 Why not the other two

- **stdin piping — mechanically dead.** `run_agent_loop`
  (`memgpt-service/memgpt/main.py:390`) reads user input via
  `questionary.text(...).ask_async()`, which sits on `prompt_toolkit`. Without
  a PTY, `prompt_toolkit` either errors or returns `None`, which the CLI
  treats as `/exit` (`main.py:399`).
- **pexpect — workable but expensive.** Allocating a PTY satisfies
  `prompt_toolkit`, but: (a) the fresh-agent discipline (V1.2 §4.2) requires a
  fresh `memgpt run` per trial, and `cli/cli.py:95` synchronously loads the
  embedder on every startup — the embedder cold-start cost dominates the
  90-trial wall-clock; (b) ANSI-soaked output (rich `console.status` spinner,
  `clear_line` escapes) makes the "turn done" signal fragile; (c) the new
  `run` command pops a "Would you like to select an existing agent?" confirm
  (`cli/cli.py:87`) when any agents exist — another expect-step. Workable,
  but option 3 is cleaner and faster.

### 1.2 Equivalence-claim implication — symmetry argument

The dissertation's V1 claim is **architectural equivalence under controlled
inputs**, not deployment equivalence. Deployment was verified separately in
6c.9 (vertical slice MILESTONE, `vertical-slice-verified` tag — plugin loads
into OpenClaw, spawns the sidecar, drives end-to-end memory writes/reads
under a real OpenClaw agent). The deployment-verification trail is recorded
in `docs/methodology-bank.md` (vertical-slice findings — synthetic-record
cascade, cross-session recall, `send_message` Scenario A).

Within V1, both cells are driven programmatically:

- **Cell A**: this wrapper around `AgentAsync.step()`.
- **Cell C**: OpenClaw's `agent --message` invocation (CLI flag, not interactive).

The CLI-vs-programmatic distinction is held equal across cells — both
exercise the architecture below the user-facing input layer. The §7.3
dimensions (tool invocation, inner monologue, `send_message` discipline,
memory-tier reasoning) all live in `Agent.step()`'s return values and the
persistence pickle, below the `questionary` / `prompt_toolkit` boundary. The
input layer is a UI concern, not an architectural one.

The wrapper reproduces the loop-relevant code path verbatim — ~15 lines
lifted from `main.py:583-617`. We skip the keyboard and the spinner; we do
not skip any code path that touches the dimensions under test.

`docs/v1-observability.md` §1.4 ("In-process state inspection") already
pre-blesses in-process access to `agent.persistence_manager.all_messages` as
a valid Cell A evidence-collection route. Option 3 extends the same boundary
from evidence-collection to probe-execution; the boundary itself is
unchanged.

### 1.3 Symmetry argument in one sentence (for V1.4 / dissertation cross-reference)

> V1 tests architectural equivalence under controlled inputs; deployment was
> verified in 6c.9 (`docs/methodology-bank.md`). Cell A's wrapper bypass is
> symmetric to Cell C's `--message` invocation — both cells exercise their
> architectures below the user-facing CLI, holding the input layer constant
> across cells.

---

## 2. Dry-run pickle diff — Cell-A-internal validation gate

The symmetry argument (§1.2) is the *defense* for option 3; the dry-run is
the *executable check* that the defense is sound. Before committing to 90
trials, we verify that one probe driven via `memgpt run` (the canonical Cell
A path the symmetry argument waves away) and via the wrapper produces
**structurally equivalent pickle output**. If they do, the bypass loses no
architectural signal. If they diverge, the wrapper has missed a code path the
CLI exercises — diagnose before doing anything else.

### 2.1 Probe choice

**p1** (identity fact, core memory expected — `docs/v1-probes.md` §3.1).
Rationale: simplest viable probe — single user turn, single tool call
(`core_memory_append`), single `send_message` terminator. Minimises the
surface area for incidental differences (multi-step chains, cross-session
state) so any divergence points at a wrapper bug, not at probe complexity.

### 2.2 Procedure

1. **Manual CLI run.** Three terminals (proxy shim, LiteLLM, MemGPT CLI per
   `docs/v1-cells.md` §1). One probe trial: type p1's probe text into the
   `memgpt run` prompt, wait for the agent's `send_message` reply, issue
   `/save`, then `/exit`. Capture the resulting `.persistence.pickle` path.
2. **Wrapper run.** Same fresh-agent state, same persona/human/model, same
   LLM endpoint chain. Drive p1 via the wrapper. Capture the resulting
   pickle path.
3. **Structural-equality script.** `cell_a/pickle_diff.py` extracts V1.4-shaped
   step-by-step data from both pickles using the V1.1 parser primitive
   (`docs/v1-observability.md` §3 — walk `all_messages`, group into steps),
   then asserts equality on:
   - message sequence (length and per-index `role`)
   - per-`role=assistant`: `function_call.name`, `function_call.arguments`
     (JSON-parsed, key-equality; argument *values* may differ if LLM
     temperature ≠ 0, but at temp=0 they should match)
   - per-`role=function`: `name` and `content` (the
     `package_function_response` envelope)
   - per-step `send_message.arguments.message` payload
   - **ignored** as run-specific noise: `timestamp` fields; LiteLLM-augmented
     keys per `docs/v1-observability.md` §4.5 (`refusal`, `annotations`,
     `audio`, `tool_calls`, `provider_specific_fields`); `api_response` /
     `api_args` per-call metadata (`agent.py:1083-1090`)
4. **Result.** Pass: pickle structurally equal — option 3 validated; proceed
   to full execution. Fail: surface the first-divergence pointer; diagnose
   wrapper bug before continuing.

### 2.3 Acceptance bar

Single-trial pass is sufficient for the dry-run. Wider variance across CLI
re-runs would surface as Cell A stochastic noise during the full 90-trial
run, where the per-dimension thresholds in `docs/v1-cells.md` §5 already
budget for it. The dry-run's job is structural sanity, not statistical
characterisation.

---

## 3. Per-trial state hygiene with amortised process

V1.2 §4.2 requires fresh agent state per trial. Option 3 lets us share the
embedder load across trials within one Python process — a major
wall-clock saving compared to pexpect (one embedder cold-start per trial
× ~60 trials = the dominant cost on the pexpect path).

### 3.1 Cell A protocol

- **One driver process per cell × probe-set.** Bootstrap once: load
  `MemGPTConfig`, load the embedder via `embedding_model()` (matching
  `cli/cli.py:95-98`), configure `llama_index.Settings`. Hold this state
  for the lifetime of the process.
- **Per-trial bootstrap.** For each trial:
  1. Construct a fresh `AgentConfig(name=<probe>_<trial>, persona=…,
     human=…, model=…, preset=…)`. Trial-suffixed agent name gives every
     trial its own on-disk dir under `~/.memgpt/agents/<name>/`, no
     archive-and-delete dance.
  2. Construct a fresh `LocalStateManager(agent_config)`.
  3. Construct a fresh `AgentAsync` via
     `presets.use_preset(preset, agent_config, model, persona_text,
     human_text, interface, persistence_manager)` matching
     `main.py:340-348`.
  4. Drive the probe (one or more `agent.step()` calls per the chain
     mechanic from `main.py:583-617`).
  5. `agent.save()` to flush the pickle. Path is
     `~/.memgpt/agents/<name>/persistence_manager/<timestamp>.persistence.pickle`
     — recorded in `cell-a-<trial>-pickle-path.txt`.

### 3.2 Cross-session probe (p5)

Cell A's cross-session restart per `docs/v1-probes.md` §4.3 is
`/save` + `/exit` + relaunch. In the wrapper:

- After session 1 turns 1 and 2: `agent.save()` — writes the pickle.
- **Discard the in-process `agent` object** (`del agent`). This wipes the
  `_messages` buffer and the `persistence_manager.recall_memory` in-memory
  state, matching what CLI exit would do.
- For session 2: `AgentAsync.load_agent(interface, agent_config)`
  (`agent.py:423`) loads from disk, exercising the F2-bearing
  `LocalStateManager.load` path that the architectural claim depends on.
- The embedder is **not** reloaded across the discard — it's process-level
  state, not per-agent. This is consistent with Cell C's spawn-mode
  behaviour where the sidecar process restarts but the embedder is cached
  on disk after first cold-start (still re-loaded per spawn, but disk
  cache makes it fast).

### 3.3 Trade-off documented

Sharing the Python process across trials means a transient failure in
trial N can in principle pollute trial N+1 via process-level state
(loaded modules, llama_index singletons, environment side-effects of
prior runs). Mitigation:

- All per-trial state lives in `agent_config` / `agent` / `persistence_manager`,
  which are fresh-constructed per trial; we do not reuse `Agent` instances.
- `llama_index.Settings` is reset only once at bootstrap; per-trial agents
  don't mutate it.
- If a trial raises, the driver logs and continues to trial N+1 with a fresh
  `agent` construction. The traceback is captured in `cell-a-<trial>.log`.
- Process restart for full hygiene is available as a fallback: pass
  `--no-process-reuse` to the driver to spawn a fresh Python process per
  trial (slow but maximally clean). Default is process-reuse; flip if a
  trial-cross-contamination symptom surfaces.

### 3.4 Cell C protocol

Per V1.2 §4.2's namespace-per-trial pattern: `v1-cell-c-<probe-id>-<trial-id>`
as namespace. OpenClaw invoked per trial via `openclaw … agent --message`
(per `docs/v1-cells.md` §2). Sidecar lifecycle is spawn-mode, owned by the
plugin — one sidecar process per OpenClaw invocation per trial; sidecar
state lives at `~/.openclaw-dev/memgpt-data/agents/<namespace>/`.

For p5 cross-session: per `docs/v1-probes.md` §4.3 — session 1 runs, OpenClaw
exits (plugin's `registerService.stop` flushes pickle and SIGTERMs sidecar),
session 2 launches OpenClaw fresh (plugin's `start` spawns a new sidecar that
`:load`s from the same data dir). Strict-isolation step: archive
`~/.openclaw-dev/agents/main/sessions/*.jsonl` + `sessions.json` between
sessions to block OpenClaw buffer-replay carrying the marker forward via
JSONL rather than recall.

---

## 4. Output structure

```
experiments/v1-runs/
├── README.md                         ← this file
├── cell_a/                           ← Cell A wrapper + diff tooling
│   ├── wrapper.py                    ← Python wrapper around AgentAsync.step()
│   ├── pickle_diff.py                ← structural-equality script (§2.3)
│   └── ...
├── driver.py                         ← orchestrates probes × trials × cells
├── dry-run/
│   ├── manual-cli-pickle-path.txt    ← path to manual `memgpt run` pickle
│   ├── wrapper-pickle-path.txt       ← path to wrapper-driven pickle
│   ├── diff-result.json              ← structural-equality output
│   └── README.md                     ← dry-run procedure log
├── p1/
│   ├── cell-a-0.json                 ← V1.1-shaped extraction per trial
│   ├── cell-a-0-pickle-path.txt
│   ├── cell-a-0.log                  ← per-trial stdout / traceback
│   ├── ...
│   └── cell-c-4.json
├── p2/ … p7/                         ← same shape per probe
└── run-log.md                        ← run outcomes (§5)
```

Total per full run: 90 JSONs + 90 pickle-path pointers + per-trial logs.
Raw pickles stay at their canonical locations (`~/.memgpt/agents/…` and
`~/.openclaw-dev/memgpt-data/agents/…`); their paths are recorded but the
binaries are not copied into the experiment directory (keep the
experiment dir small and git-friendly).

---

## 5. Run outcomes

(Populated as runs complete. Each entry records date/time, stack versions,
anomalies, trial count, deviations.)

### 5.0 Stack versions (executed config)

- **Plugin** (this repo, `feat/v1-runs`): Cell A ran at `03b0bc5` (V1.3
  driver + dry-run gate); Cell C ran at `ed2f53f` (after the two SDK-bypass
  fixes that landed mid-execution — see §5.2 anomalies).
- **Fork (`memgpt-service`)**:
  - Cell A: `v1-cell-a` branch at `f3ccd08` (`f46cc3b` + F2 cherry-pick
    `109817c`). F1 omitted by design (`docs/v1-cells.md` §1).
  - Cell C: `main` at `0c31f10` (sidecar imports editable from fork; the
    operator swapped branches between cells).
- **Proxy chain** (`CLAUDE.md` RUNNING THE STACK):
  - proxy_shim: `proxy/proxy_shim.py`, port 4100, institutional Bedrock
    upstream.
  - LiteLLM: port 4000, `proxy/litellm_config.yaml` with `temperature: 0`
    pinned under `gpt-5.4`'s `litellm_params`.
  - Cell A only: `cell-a-adapter` on port 4200 (Functions API → modern
    `tool_calls` rewrite per methodology #12; see `docs/v1-cells.md` §7).
- **Model**: `gpt-5.4` → Anthropic Claude Sonnet 4.5
  (`anthropic.claude-sonnet-4-5-20250929-v1:0`) via institutional Bedrock
  gateway. `temperature: 0`.

### 5.1 Dry-run (2026-06-10, probe p1)

Pass — `--structural-only --skip-boot` gate clean (zero divergences after
boot-prefix normalisation); content-aware noise floor at temperature 0 is
3 divergences, all prose paraphrase at inner-monologue / `send_message`
text level (banked as methodology #17(b) — well above V1.4's Jaccard ≥0.5
threshold). Boot-turn divergence between manual CLI and wrapper is the
expected rig artefact handled by `--skip-boot`. Full record:
`dry-run/diff-structural-temp0.json`, `dry-run/diff-content-temp0.json`,
`dry-run/README.md`.

### 5.2 Full V1.3 execution (2026-06-10)

**Outcome: 90/90 trials complete, zero hard failures across both cells.**

**Cell A — 45 trials in ~13 min wall-clock.**

| Probe | Trials | Avg/trial | Notes |
|---|---|---|---|
| p1 (core, single-turn) | 5 | ~13 s | clean — `core_memory_*` + `send_message` |
| p2 (archival, single-turn) | 5 | ~13 s | clean |
| p3 (multi-tier chain) | 5 | ~11 s | clean |
| p4 (cross-turn within session) | 5 | ~12 s | **noted pattern**: turn 1 = `core_memory_append` only (no `send_message` ack); turn 2 = `send_message` only (active-context read, no `conversation_search`) — banked as methodology candidate #18 pending Cell C comparison |
| p5 (cross-session, load-bearing) | 10 | ~22 s | clean — `:load` rehydration path exercised 10× |
| p6 (ambiguous tier) | 10 | ~11 s | clean (tier choices to be tabulated in V1.4) |
| p7 (degenerate "Hello.") | 5 | ~6.6 s | clean |

**Cell C — 45 trials in ~135 min wall-clock.** Significantly slower than
Cell A because each user turn in Cell C is one full `openclaw` invocation
(spawn + lazy-init + 60–90 s embedder warm-up via disk cache + LLM turn
+ clean exit), where Cell A amortises the embedder load across all
trials in one Python process (V1.1 §1.4 in-process inspection path).

| Probe | Trials | Avg/trial | Notes |
|---|---|---|---|
| p1 | 5 | ~49 s | clean |
| p2 | 5 | ~49.7 s | clean |
| p3 | 5 | ~51 s | clean |
| p4 | 5 | ~105 s | 2 invocations/trial; clean |
| p5 | 10 | ~165 s | 3 invocations/trial; clean. **Trial 9 was 695 s** (single outlier, upstream LLM slowness — see anomalies) |
| p6 | 10 | ~245 s | clean. Per-trial wall-clock ~4–5× larger than p1-p3 — upstream LLM slowness sustained from p5 trial 9 onward |
| p7 | 5 | ~244 s | clean, same sustained slowness |

**Anomalies during execution:**

1. **Cell C first attempt failed structurally — SDK `--local` services
   bypass.** First Cell C trial attempts surfaced `"openclaw-memgpt:
   lifecycle not started"` because `openclaw agent --local` skips
   `startPluginServices` (only the gateway path at
   `server.impl-DLF59fRo.js:21287` fires it). Fixed by adding a lazy-init
   fallback to `LifecycleManager.resolveBaseUrl` (commit `7bf1026`,
   methodology bank #19).

2. **Cell C second attempt failed at trial 0 — Node child kept event loop
   alive.** After the lazy-init fix, the lazy-spawned sidecar's
   stdout/stderr streams kept the parent's event loop alive post-turn;
   openclaw exited only at the driver's 600 s timeout. Fixed by
   `child.unref()` + `process.on('exit')` SIGTERM handler (commit
   `ed2f53f`). Verified e2e openclaw turn now exits in ~46 s.

3. **Upstream LLM slowness mid-Cell-C (probe p5 trial 9 onward).**
   Per-trial wall-clock jumped from ~165 s to ~250–700 s. No trial
   failed; the JSON artefacts and pickles are structurally complete.
   Likely Bedrock provider transient (no client-side change correlated
   with the onset). V1.4 will inspect for any payload-content
   correlation; if not, attribute to provider noise.

4. **Cell A p4 single-tool pattern (turn 1 no `send_message` ack).** Same
   pattern as methodology #15's Haiku 4.5 finding but observed on Sonnet
   4.5. Reproduced across all 5 Cell A p4 trials. Pending Cell C
   comparison to determine whether it's a Sonnet-4.5-at-temp-0 trait or a
   Cell-A-specific artefact (banked as methodology candidate #18).

**Total trials: 90.** Cell A 45 + Cell C 45 matches V1.2's spec (5+5+5+5+10+10+5
per cell). Per-trial JSON outputs at `experiments/v1-runs/p[1-7]/cell-{a,c}-{0..N}.json`;
per-trial pickle pointers at `…/cell-{a,c}-{0..N}-pickle-path.txt`; per-trial
OpenClaw logs (Cell C only) at `…/cell-c-{0..N}.log`. Raw pickles stay at
their canonical locations (`~/.memgpt/agents/…` for Cell A,
`~/.openclaw-dev/memgpt-data/agents/v1-cell-c-…/…` for Cell C); paths are
recorded in the pointer files for V1.4 cross-reference.

---

## Changelog

- 2026-06-08 — V1.3 README initial freeze. Cell A automation choice: option 3
  (Python wrapper around `AgentAsync.step()`); symmetry argument articulated
  with reference to 6c.9 deployment verification and the V1.1 §1.4
  in-process-inspection pre-blessing; dry-run pickle-diff procedure
  specified with p1 as the probe and structural-equality script as the gate;
  per-trial state hygiene specified for shared-process amortised embedder
  load with named per-trial agent dirs; `--no-process-reuse` fallback flag
  documented as the maximally-clean escape hatch.
