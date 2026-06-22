# Manual test plan — rc1 pre-publish (OpenClaw 2026.6.8)

The last gate before publishing to the community. Covers the full end-user
surface: install (packaged + dev), the config gates, the setup wizard, prewarm,
memory working end-to-end (store / recall / **cross-session**), cold-start,
edge cases, and uninstall. Each test states a **PASS** condition.

Dev-profile paths (`~/.openclaw-dev`) assumed. This file ships **excluded** from
the package (`files` whitelist).

## Prerequisites & conventions (read once)

- **The agent's brain is separate from the memory sidecar.** Every agent turn
  needs OpenClaw's own LLM (`~/.openclaw-dev/agents/main/agent/models.json`);
  the wizard configures only the memory **sidecar**'s LLM. In this repo the
  brain is `gpt-5.4` via local LiteLLM (`:4000`) → proxy shim (`:4100`), so that
  stack must be up before any turn (CLAUDE.md → RUNNING THE STACK). Diagnose a
  failing turn: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/v1/models`
  → `000` = LiteLLM down; `500 "Budget exceeded"` = account cap. Neither is a
  plugin bug.
- **Verify memory by ground truth, not the CLI summary.** Every `send_message`
  turn prints `livenessState:"abandoned"` + `⚠️ couldn't generate a response`
  **by design** — ignore it. Verify via: (a) the next turn's `finalPromptText`
  (`--log-level trace`) showing the stored fact in the `<human>`/`<persona>`
  block or a grown recall count, or (b) `curl …/recall:search` against a live
  sidecar (attach mode, or mid-turn). See CLAUDE.md → V1 PROTOCOL.
- **`--dangerously-force-unsafe-install` is no longer required** on 2026.6.8 (the
  dangerous-code scanner is gone). Dev installs use a plain `--link`.
- **Back up:** `cp ~/.openclaw-dev/openclaw.json ~/.openclaw-dev/openclaw.json.bak`
- **Most tests need the plugin ENABLED** (`openclaw --dev plugins enable
  openclaw-memgpt`) — a disabled/uninstalled plugin has no `memgpt` command.
- **Restore** when done (last section).

---

## 1 — Install

### 1a — Packaged install (the community path) — clean, no force flag
```bash
npm pack                                   # builds dist/ via prepack → openclaw-memgpt-<v>.tgz
mkdir -p /tmp/oc-pkgtest && OPENCLAW_PROFILE=pkgtest \
  openclaw --profile pkgtest plugins install ./openclaw-memgpt-*.tgz
```
**PASS:** install completes with **no** "requires compiled runtime output", **no**
dangerous-code warning, **no** `--dangerously-force-unsafe-install`; output ends
"Installed plugin: openclaw-memgpt". (Throwaway profile — discard after.)

### 1b — Dev `--link` install (iteration)
```bash
cd ~/Workspace/UCL/dissertation/openclaw-memgpt && rm -rf sidecar/.venv
openclaw --dev plugins install --link .
```
**PASS:** installs; `~/.openclaw-dev/openclaw.json` shows the plugin in
`load.paths` + `slots.memory = openclaw-memgpt`. Packaged installs (1a) never
hit the scan — this is dev-`--link`-only.

> **If it aborts with "manifest dependency scan exceeded max directories
> (10000)":** the dev tree is too big. The repo's own dirs (`experiments/` ~5.6k
> + `proxy/` ~3k) sit just under the limit, so any stray heavy dir tips it over.
> Diagnose + clean:
> ```bash
> find . -type d | wc -l                                   # total (must be <10000)
> for d in */ sidecar/*/ ; do echo "$(find "$d" -type d|wc -l) $d"; done | sort -rn | head
> rm -rf sidecar/.venv 'sidecar/~'                          # common strays: a uv venv, or a
> #   literal "~" dir from a test cmd that passed UV_PROJECT_ENVIRONMENT=~/… unexpanded
> ```
> A real `uv`-managed venv lives under the **state dir** (`~/.openclaw-dev/
> memgpt-sidecar-venv`), never in the repo — anything venv-like inside the repo
> is a stray to delete.

---

## 2 — Config gates (plugin present but should do nothing)

### 2a — Disabled → zero effect on the agent
```bash
openclaw --dev plugins disable openclaw-memgpt
openclaw --dev agent --local --agent main --message "Hello" --json 2>&1 | tee /tmp/t2a.log
openclaw --dev plugins enable openclaw-memgpt    # re-enable for later tests
```
**PASS:** `/tmp/t2a.log` (the **agent run**, not the disable command) contains
**no** `openclaw-memgpt: … registered` line, no sidecar (`pgrep -f "uvicorn
main:app"` empty), no `abandoned` artifact. (Agent reply itself needs the brain
up; a brain error still passes this — it has zero memgpt involvement.)

### 2b — Enabled but UNCONFIGURED → loads yet fully inert
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));const g=c.plugins.entries["openclaw-memgpt"].config;delete g.provider;delete g.baseUrl;delete g.credential;fs.writeFileSync(p,JSON.stringify(c,null,2));'
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key
openclaw --dev agent --local --agent main --message "Remember I like espresso." --json 2>&1 | tee /tmp/t2b.log
```
**PASS:** registration line present + one-time "not configured — run `openclaw
memgpt setup`" notice; **no sidecar spawned**; if a memory tool is called its
result is the setup string; no per-turn hook error spam; agent still responds.

---

## 3 — Setup wizard

`openclaw --dev memgpt setup` (plugin must be enabled).

### 3a — Credential modes (run each; config saved, no key leak)
- **Paste** (OpenAI-compatible, base `http://127.0.0.1:4000/v1`, key
  `sk-local-dev-only`): **PASS** — `…/plugins/openclaw-memgpt/api-key` exists,
  `stat -f '%Lp'` = `600`; key never printed.
- **Env var** (`OPENAI_API_KEY`): **PASS** — **no** `api-key` file written;
  config `credential={source:"env",var:"OPENAI_API_KEY"}`.
- **Re-entry:** re-run setup → intro says "reconfigure", provider prefilled,
  credential prompt offers Keep / Replace / Switch and **never prints the stored
  key**. **PASS** for file→env (switch): after, `…/api-key` is gone and config
  shows `{source:"env"}` (config written before file removed).

### 3b — Pre-warm offer (new)
During setup, after the summary, in spawn mode (no `sidecarUrl`) with `uv`
present: a confirm "Pre-download the embedding model now (~60s)?".
- **Accept (default):** **PASS** — "Downloading…" then "Embedder cached — first
  agent turn will be fast"; `~/.openclaw-dev/memgpt-data/.embedder-warm` exists
  and its content is `BAAI/bge-small-en-v1.5`.
- **Decline:** **PASS** — "Skipped pre-warm … first turn downloads (~60s)" note;
  wizard still completes; no marker written.

### 3c — Wizard edge cases
- **Cancel (Ctrl-C mid-wizard, or decline the summary):** **PASS** — "Setup
  cancelled"; `sha256` of `openclaw.json` unchanged.
- **Invalid key:** paste a wrong-prefix key → **PASS** rejected inline
  (format-only; never network-tested).
- **Unreachable endpoint:** configure a local base URL with nothing listening →
  **PASS** wizard shows "Endpoint not reachable" + "start your local server"
  hint, still saves; a direct provider (`api.anthropic.com`) never warns.
- **`uv` missing** (`UV=$(which uv); mv "$UV" "$UV.bak"`): **PASS** wizard shows
  "Prerequisite missing" + uv install link + "does not install it for you", and
  **no** pre-warm offer; still saves config; `uv` still absent. Restore: `mv
  "$UV.bak" "$UV"`. (Restore uv before `node --test` — integration tests spawn a
  real sidecar.)

---

## 4 — Prewarm (standalone)

```bash
rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm     # force a cold marker state
openclaw --dev memgpt prewarm
cat ~/.openclaw-dev/memgpt-data/.embedder-warm
```
**PASS:** logs "pre-warming … downloads once" then "embedder cached — agent turns
will be offline-fast"; exits 0; marker file contains `BAAI/bge-small-en-v1.5`.
(`uv` missing → **PASS** clear error, exit 1, no marker.)

---

## 5 — Memory end-to-end (the load-bearing property)

Configure via **paste** (3a), bring LiteLLM up, **prewarm** (4) so cold-start
isn't a confound. Use a fresh namespace per run:
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.namespace="mt-"+Date.now();fs.writeFileSync(p,JSON.stringify(c,null,2));console.log("ns:",c.plugins.entries["openclaw-memgpt"].config.namespace)'
```

### 5a — Store + cross-session recall (`--local`, two processes)
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my lucky number is 4173. Acknowledge." --json   # TURN 1 (write)
sleep 8   # let the detached sidecar finish its shutdown save
NS=<the namespace above>
find ~/.openclaw-dev/memgpt-data/agents/$NS/persistence_manager -name '*.pickle' -exec ls -la {} \;   # pickle present + NON-zero
source ~/.secrets && openclaw --dev agent --local --agent main --message "What is my lucky number? Check your memory." --json   # TURN 2 (recall, fresh process)
```
**PASS (all):** turn 1 exits 0; after the wait, `agent_state/*.json` **and** a
**non-zero** `*.persistence.pickle` exist on disk; turn 2 completes in **<15s**
with **no** "timed out"/"not resident"/"Cannot load"/500 in the log, and the
agent's reply contains **4173** sourced from memory (the next turn's
`finalPromptText`/core-memory block shows it; the string is in no workspace
file). This is the genuine `:load` cross-session path (turn 2 is a separate
sidecar process).

### 5b — One sidecar per process (multi-register fix)
In turn 1's log: the `openclaw-memgpt: … registered` line appears multiple times
(OpenClaw registers per-context) but `sidecar spawning on 127.0.0.1:<port>`
appears **once**.
**PASS:** exactly one `sidecar spawning` line; no `Agent '<ns>' is not resident`
error.

### 5c — Gateway mode (real-user daemon path)
```bash
source ~/.secrets && (openclaw --dev gateway run --allow-unconfigured &)   # wait for "sidecar ready"
source ~/.secrets && openclaw --dev agent --agent main --message "Remember my plant is Fernie." --json
kill -TERM "$(pgrep -f 'gateway run' | head -1)"                            # clean shutdown
```
**PASS:** turn runs (no `EMBEDDED FALLBACK`); gateway log shows "teardown — final
save complete"; the namespace's `*.persistence.pickle` is non-zero. Restart the
gateway and ask for the plant → recalls **Fernie**.

---

## 6 — Cold-start behaviour

### 6a — Prewarmed → first turn is fast
Marker present (after 4). First `--local` turn on a fresh namespace.
**PASS:** the sidecar log shows "offline cache hit"; turn completes <15s; memory
works on the **first** turn (5a holds without a throwaway turn).

### 6b — NOT prewarmed → first turn slow, second fast (graceful)
```bash
rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm
rm -rf ~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5    # truly cold (forces ~60s download)
# (only do this if you accept a one-time re-download)
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my code is 5566." --json   # TURN 1: downloads
sleep 8
source ~/.secrets && openclaw --dev agent --local --agent main --message "What is my code?" --json             # TURN 2
```
**PASS:** turn 1 may show the `before_prompt_build … timed out after 15000ms`
hook line and answer without memory (download > 15s) — this is the documented
cold first-turn; it still **downloads + writes the marker**. Turn 2 shows
"offline cache hit", completes <15s, and recalls **5566**. (Prewarm avoids the
slow turn 1 entirely — that's its purpose.)

---

## 7 — Edge cases (robustness)

### 7a — Corrupt / truncated saved state → re-creates, never 500
With a saved namespace (after 5a), against a **live** sidecar (attach mode on a
fixed port, or mid-turn):
```bash
PK=$(find ~/.openclaw-dev/memgpt-data/agents/$NS/persistence_manager -name '*.pickle' | head -1)
: > "$PK"                                  # truncate to 0 bytes
curl -s -XPOST "http://127.0.0.1:<port>/agents/$NS:ensure" -d '{}' -H 'content-type: application/json'
```
**PASS:** returns `{"via":"create"}` (re-creates fresh), **not** a 500. (A
mid-truncated pickle behaves the same — `:load` 404s internally → re-create.)

### 7b — Cache eviction → clear error + recovery
```bash
# marker present, but model cache gone:
rm -rf ~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5
source ~/.secrets && openclaw --dev agent --local --agent main --message "hi" --json 2>&1 | grep -i "prewarm\|cache"
openclaw --dev memgpt prewarm        # recover
```
**PASS:** the turn surfaces "Embedder model cache appears unavailable. Run
`openclaw memgpt prewarm` or restart"; the marker is cleared; after `prewarm` a
subsequent turn works again.

### 7c — Sidecar-dead degradation
Rename `uv` (`mv $(which uv) …bak`), configure, run a turn.
**PASS:** within ~1–2s of `sidecar spawning…` (not after 120s) the plugin marks
itself dead and tools return "sidecar … restart to recover"; the agent itself
still responds. Restore `uv`.

### 7d — Attach mode (escape hatch)
Set `config.sidecarUrl` to a manually-started sidecar.
**PASS:** wizard skips uv/prewarm guidance; the plugin attaches (no spawn) and at
teardown does **not** SIGTERM your sidecar; a final `:save` still fires.

### 7e — Observability
`config.observability:"verbose"` → `~/.openclaw-dev/memgpt-observability.jsonl`
gets entries with content; `"off"` → stays empty/absent. **PASS** accordingly.

---

## 8 — Uninstall (`openclaw memgpt uninstall [--dry-run] [--force] [--keep-data]`)

Set up once before the destructive cases: installed, configured via **paste**
(creates the secret file), one turn run (creates `memgpt-data`).

```bash
inspect() {
  echo "-- artifacts --"; ls -d ~/.openclaw-dev/plugins/openclaw-memgpt \
    ~/.openclaw-dev/memgpt-data ~/.openclaw-dev/memgpt-observability.jsonl \
    ~/.openclaw-dev/memgpt-sidecar-venv 2>/dev/null || true
  echo "-- registration --"; node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins||{};
    console.log("entry:",!!c.entries?.["openclaw-memgpt"],"| install:",!!c.installs?.["openclaw-memgpt"],
    "| slot:",c.slots?.memory,"| inLoad:",(c.load?.paths||[]).some(p=>p.includes("openclaw-memgpt")))'
}
reinstall() { cd ~/Workspace/UCL/dissertation/openclaw-memgpt && rm -rf sidecar/.venv && openclaw --dev plugins install --link . && openclaw --dev memgpt setup; }
```

- **U1 `--dry-run`:** `inspect` → `uninstall --dry-run` → `inspect`. **PASS:**
  "Dry run — no changes" box; artifacts + registration **identical**.
- **U2 decline:** `uninstall` → answer No. **PASS:** "cancelled"; nothing removed.
- **U3 accept:** `uninstall` → Yes. **PASS:** all artifacts gone; `entry:false
  install:false slot:memory-core inLoad:false`; `memgpt --help` → "unknown
  command". `reinstall`.
- **U4 `--force`:** **PASS:** same as U3, no prompt. `reinstall`.
- **U5 `--keep-data`:** **PASS:** `memgpt-data` **kept**; secret dir +
  observability log + venv removed; de-registered. `reinstall`.
- **U6 non-interactive, no `--force`** (`uninstall </dev/null`): **PASS:** errors
  "needs confirmation — re-run with --force"; nothing removed.
- **U7 round-trip:** `uninstall --force` → `reinstall` → `setup` → a turn works.
  **PASS:** clean reinstall from the removed state; turn succeeds (no residue).

**Expected note (minimal dev config only):** de-register shrinks the tiny
`openclaw.json` >50%, so the SDK rejects the update and the command falls back to
a direct atomic write (one-line warning). Expected here; absent on normal configs.

**Note:** a full uninstall removes the whole config block incl.
`namespace`/`persona`/`human`, so post-reinstall the agent runs the **default**
namespace (prior memory still on disk under `memgpt-data`, just not loaded). Use
`--keep-data` + re-add `namespace` to resume a specific agent.

---

## 9 — Package boundary
```bash
npm pack --dry-run
```
**PASS:** ships `dist/` + `src/` + `sidecar/` (`.py`, `pyproject.toml`,
`uv.lock`) + manifest + README + LICENSE; **0** `tests/`, `__pycache__`,
`.venv`, `docs/`, `experiments/`, or `*.test.*` files.

---

## Restore
```bash
cp ~/.openclaw-dev/openclaw.json.bak ~/.openclaw-dev/openclaw.json
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key
rm -f ~/.openclaw-dev/openclaw.json.rejected.* 2>/dev/null
pkill -f "uvicorn main:app"; pkill -f "gateway run" 2>/dev/null
```
