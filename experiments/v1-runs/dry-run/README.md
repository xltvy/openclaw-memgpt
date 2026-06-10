# V1.3 Dry-Run — Cell A wrapper vs `memgpt run` pickle diff

The Cell-A-internal validation gate per `experiments/v1-runs/README.md` §2.
One probe (p1) run via the canonical `memgpt run` CLI **and** via the
wrapper; the two pickles are diffed structurally per
`cell_a/pickle_diff.py`. Pass = wrapper validated; proceed to the 90-trial
slate. Fail = wrapper has missed a code path; diagnose before continuing.

This is an operator-collaborated procedure. Steps marked **[op]** are
done by hand at a terminal; steps marked **[driver]** are the wrapper
side invoked via the V1.3 driver. The diff is the closing step.

---

## V1.3 gate semantics — two modes

The diff runs in two modes; both must be inspected for V1.3 gate acceptance:

- **`--structural-only` + `--skip-boot` (gate decision)** — compares role
  sequence, function_call.name sequence, function_call.arguments key-set,
  presence-of-monologue. Replaces LLM-influenceable content (assistant
  inner monologue, argument values, send_message payload text) with
  sentinel placeholders. **Pass = wrapper bypass is architecturally
  innocuous.** This is the V1.3 gate.
- **Default (content-aware) + `--skip-boot` (noise floor calibration)** —
  full byte-equal comparison post-normalisation. With temperature=0
  pinned (see step 4 below), expected to be exact. Any divergence is
  LLM-stochastic floor — informs how V1.4 calibrates its inner-monologue
  Jaccard threshold (`docs/v1-cells.md` §5).

Pin temperature=0 before re-running; otherwise the noise floor is
provider-default (~1.0) and the content-aware diff will surface
paraphrase variance unrelated to the wrapper bypass.

---

## Pre-flight checklist (do once, before either side runs)

1. **[op] Fork branch.** The Cell A fork branch carries `f46cc3b` + F2 only.
   ```bash
   cd ~/Workspace/UCL/dissertation/memgpt-service
   git checkout -b v1-cell-a f46cc3b
   git cherry-pick 109817c   # F2 only; DO NOT pick e2c8c93 (F1)
   uv sync
   ```
   Record the resulting HEAD SHA in step 8.

2. **[op] Personas + humans.** Per `docs/v1-cells.md` §1.
   ```bash
   mkdir -p ~/.memgpt/personas ~/.memgpt/humans
   cat > ~/.memgpt/personas/sam_v1.txt <<'EOF'
   Sam is a friendly AI assistant with an extensive knowledge base.
   EOF
   cat > ~/.memgpt/humans/researcher_v1.txt <<'EOF'
   The user is a researcher exploring AI memory architectures.
   EOF
   ```

3. **[op] MemGPTConfig.** If `~/.memgpt/config` doesn't exist (first run on
   this branch), run `uv run memgpt configure` from the fork dir. Set
   model endpoint to `openai`, model to `gpt-5.4`, endpoint URL to
   `http://localhost:4000/v1`. Embedding provider: huggingface +
   `BAAI/bge-small-en-v1.5` (matches the sidecar default — keeps Cell A
   embedder consistent with Cell C).

4. **[op] Proxy stack with temperature=0 pinned.**
   Three terminals per `CLAUDE.md` "RUNNING THE STACK" — proxy shim on
   4100, LiteLLM on 4000.

   The plugin's `sidecar/litellm_config.yaml` now pins `temperature: 0`
   under the `gpt-5.4` model's `litellm_params` (rationale: the fork's
   `acreate` at `agent.py:144` doesn't pass `temperature`; without
   pinning, LiteLLM defaults to provider-default ~1.0 and probe runs
   exhibit paraphrase variance that masks any wrapper bug).

   Restart LiteLLM after the config change. Verify:

   ```bash
   curl -s http://127.0.0.1:4100/healthz
   curl -s http://127.0.0.1:4000/health/liveliness

   # Confirm temperature passes through to the upstream call. The shim
   # receives temperature in the request body — log it on the proxy side
   # (LiteLLM `--debug`) or watch the shim's stderr if it logs requests.
   # The simplest end-to-end check: a one-shot completion that mentions
   # randomness; at temp=0 it should produce identical output across two
   # invocations.
   curl -s http://localhost:4000/v1/chat/completions \
     -H "Authorization: Bearer sk-local-dev-only" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Pick a random integer 0-99 and return only the number."}],"max_tokens":10}' \
   | python -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])"

   # Run the curl above TWICE in quick succession — same output = temp=0
   # is in effect. Different output = the pin isn't reaching the upstream
   # call (check LiteLLM logs, confirm the yaml change was loaded on
   # restart, check the proxy shim isn't dropping the param).
   ```

5. **[op] Env vars (in each working terminal).**
   ```bash
   export OPENAI_API_BASE=http://localhost:4000/v1
   export OPENAI_API_KEY=sk-local-dev-only
   source ~/.secrets
   ```

6. **[op] Wrapper env.** From this directory's parent (`experiments/v1-runs/`):
   ```bash
   cd /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs
   uv sync
   ```
   This installs `pymemgpt` editable from the fork at its current branch
   (`v1-cell-a` after step 1).

7. **[op] Clear any prior dry-run agents.** Both runs name their agents
   uniquely (CLI: `cli_dryrun_p1`; wrapper: `v1_cell_a_p1_t00`), but if
   you're re-running the dry-run, archive prior agents first to avoid
   confusion:
   ```bash
   mv ~/.memgpt/agents/cli_dryrun_p1 ~/.memgpt/agents-archive/cli_dryrun_p1-$(date +%s) 2>/dev/null || true
   mv ~/.memgpt/agents/v1_cell_a_p1_t00 ~/.memgpt/agents-archive/v1_cell_a_p1_t00-$(date +%s) 2>/dev/null || true
   ```

8. **[op] Record stack versions** for the run log (filled in below in
   `Run log` section as you go).

---

## Run

### Step A — manual CLI run

**[op]** From the fork dir, three terminals already up (shim, LiteLLM,
your CLI terminal):

```bash
cd ~/Workspace/UCL/dissertation/memgpt-service
source ~/.secrets
export OPENAI_API_BASE=http://localhost:4000/v1
export OPENAI_API_KEY=sk-local-dev-only

uv run memgpt run \
  --agent cli_dryrun_p1 \
  --persona sam_v1 \
  --human researcher_v1 \
  --model gpt-5.4 \
  --no_verify
```

At the `> Enter your message:` prompt, type **verbatim**:

> `Please remember that I'm working on a dissertation about AI memory architectures.`

Wait for the agent's `send_message` reply (yellow 🤖 line).

Type `/save`. Note the path printed (`Saved persistence manager to:
…cli_dryrun_p1/persistence_manager/<timestamp>.persistence.pickle`).
Record it as `manual-cli-pickle-path.txt`:

```bash
echo "<paste-the-full-path-here>" > \
  /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs/dry-run/manual-cli-pickle-path.txt
```

Type `/exit`.

### Step B — wrapper run

**[driver]** From this repo's experiments dir:

```bash
cd /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs

# The driver runs the same probe through the wrapper; --trials 1 is the
# dry-run slice. The driver also writes the V1.4-shaped JSON, which
# we'll inspect alongside the diff but which isn't load-bearing for the
# gate itself.
uv run python driver.py --cell A --probe p1 --trials 1
```

The driver prints `[p1 cell A trial 0] OK (Xs)` on success. The wrapper
pickle path is recorded in `p1/cell-a-0-pickle-path.txt`. Copy it:

```bash
cp /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs/p1/cell-a-0-pickle-path.txt \
   /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs/dry-run/wrapper-pickle-path.txt
```

### Step C — diff in both modes

**[driver]** From the experiments dir:

```bash
cd /Users/altayacar/Workspace/UCL/dissertation/openclaw-memgpt/experiments/v1-runs

CLI_PICKLE=$(cat dry-run/manual-cli-pickle-path.txt)
WRAPPER_PICKLE=$(cat dry-run/wrapper-pickle-path.txt)

# Mode 1: structural-only (V1.3 gate decision).
uv run python cell_a/pickle_diff.py \
  "$CLI_PICKLE" \
  "$WRAPPER_PICKLE" \
  --skip-boot \
  --structural-only \
  --json-out dry-run/diff-result-structural.json

# Mode 2: content-aware (noise floor calibration).
uv run python cell_a/pickle_diff.py \
  "$CLI_PICKLE" \
  "$WRAPPER_PICKLE" \
  --skip-boot \
  --json-out dry-run/diff-result-content.json
```

The mode 1 (structural-only) exit code is the **gate decision**: 0 = pass,
non-zero = wrapper-vs-CLI architectural divergence. The mode 2
(content-aware) exit code is **noise floor calibration** — at
temperature=0 should also be 0; any divergence is the LLM-stochastic
floor and gets banked as a methodology baseline for V1.4's Jaccard
threshold calibration.

---

## Acceptance & interpretation

**Pass criteria (gate = mode 1, structural-only):**
- `equal: true` in `diff-result-structural.json`.
- Driver-side JSON record at `p1/cell-a-0.json` shows:
  - `tools_by_step[0].tools` containing both `core_memory_append` and
    `send_message` (per `docs/v1-probes.md` §3.1 sanity check).
  - `tiers_by_step[0].tiers.core >= 1` (the expected tier for p1).
  - `send_message_calls` length 1, payload non-empty.
  - `leakage_flags` empty.

**Noise floor (mode 2, content-aware):**
- With `temperature=0` pinned, expected `equal: true`. Any divergence
  here is residual LLM-stochastic content variance and gets banked as a
  methodology baseline — informs V1.4's Jaccard threshold calibration.
- If mode 2 has divergences but mode 1 passes: the wrapper bypass is
  architecturally innocuous (gate pass) AND there's a non-zero noise
  floor (record it). Both findings are useful.

**If mode 1 (structural-only) fails:**

1. **Tool-name or argument-key divergence.** The LLM saw different
   prompts/tools between wrapper and CLI runs. Cross-check by re-running
   the wrapper side once more — if the wrapper agrees with itself but
   disagrees with the CLI, the wrapper has changed the prompt/context.
   Likely culprits: persona/human resolution path, system prompt
   construction, embedder difference.

2. **Length divergence.** The wrapper is producing more or fewer messages
   than the CLI. Diagnose: did the wrapper's chain mechanic skip a
   heartbeat case (token_warning / function_failed branches in
   `wrapper.drive_turn` — compare to `main.py:583-617`)? Re-run with
   `--debug` enabled to see step-by-step output.

3. **LiteLLM-augmented field divergence.** Shouldn't happen — those keys
   are filtered by `pickle_diff.IGNORED_MESSAGE_KEYS`. If they show up
   in divergences, a new LiteLLM key has appeared that the filter
   doesn't cover. Add it to the ignored set.

4. **Aborted before send_message terminator.** The wrapper turn returned
   early. Diagnose: was the chain mechanic broken (heartbeat ignored)?
   Was the LLM response missing a function_call? Inspect
   `cell-a-0.log` for traceback.

**If the JSON record looks wrong but the diff passes:** the
wrapper-vs-CLI bypass is innocuous (which is what the dry-run gates),
but p1's probe shape itself may need refinement. Surface to V1.2 revision
rather than V1.3 wrapper rework.

---

## Run log

(Fill in as the dry-run executes.)

### Stack versions

- Cell A fork branch: `v1-cell-a` at `<HEAD SHA>` (should be
  `f46cc3b` + `109817c` cherry-pick).
- Proxy shim: …
- LiteLLM: …
- Wrapper env (`experiments/v1-runs/`): `pymemgpt` editable from
  `../../memgpt-service` at `<HEAD SHA>`.
- Model: `gpt-5.4`, temperature 0 (or whatever the MemGPTConfig records).

### Run timestamps

- Pre-flight done: …
- CLI run: …
- Wrapper run: …
- Diff: …

### Outcome

- `equal`: …
- Divergence count: …
- First divergence (if any): …
- Decision: …
