# Manual test plan — install wizard, config gate, packaging (6d.6 / 6d.7)

Manual TTY checks for the install wizard, the unconfigured-state gate, the `uv`
prerequisite/cold-start guidance, and the package boundary. These exercise paths
that the unit suite cannot (real terminal prompts, sidecar spawn, OpenClaw
wiring). Dev-profile paths (`~/.openclaw-dev`) are assumed; this file is excluded
from the published package via the `files` whitelist in `package.json`.

## Conventions that apply to every test

- **The agent's own model is separate.** Every agent turn needs OpenClaw's own
  LLM configured (the "brain", in `~/.openclaw-dev/agents/main/agent/models.json`)
  — independent of the wizard, which configures only the memory **sidecar**.
- **Verify "memory works" by ground truth, not the CLI summary.** The CLI prints
  `livenessState:"abandoned"` + `⚠️ Agent couldn't generate a response` on every
  `send_message` turn by design (send_message isn't in OpenClaw's
  `CORE_MESSAGING_TOOLS`). Verify via the sidecar instead:
  - grab the port from the spawn log line `sidecar ready on http://127.0.0.1:<port>`,
  - `curl -s -XPOST http://127.0.0.1:<port>/agents/<namespace>/recall:search …`, or
  - recall-count growth in the next turn's `finalPromptText` (`--log-level trace`).
  See `CLAUDE.md` → "V1 PROTOCOL".
- **Back up first:** `cp ~/.openclaw-dev/openclaw.json ~/.openclaw-dev/openclaw.json.bak`
- **Restore when done** (see the end of this file).

---

## Test 1 — Not installed/active → zero effect on the agent

The plugin must not touch OpenClaw when it isn't active.

```bash
openclaw --dev plugins disable openclaw-memgpt        # "not used" without a full uninstall
openclaw --dev agent --local --agent main --message "Hello, who are you?" --json 2>&1 | tee /tmp/t1.log
grep -i "openclaw-memgpt" /tmp/t1.log && echo "FAIL: plugin still involved" || echo "PASS: no memgpt log lines"
pgrep -f "uvicorn main:app" && echo "FAIL: sidecar spawned" || echo "PASS: no sidecar"
openclaw --dev plugins enable openclaw-memgpt          # restore
```

**Expect:** agent replies normally; **no** `openclaw-memgpt: … registered` line, no
"not configured" notice, no sidecar process, no `send_message`/`abandoned`
artifact.

- If `plugins disable` errors on the config-write guard, set
  `entries.openclaw-memgpt.enabled=false` by hand instead.
- Full-uninstall variant: copy the `.rejected` payload OpenClaw computes (the CLI
  uninstall trips the size-drop guard on a small dev config — see
  `docs/methodology-bank.md` if recorded):
  ```bash
  R=$(ls -t ~/.openclaw-dev/openclaw.json.rejected.* | head -1)
  cp "$R" ~/.openclaw-dev/openclaw.json
  rm -rf ~/.openclaw-dev/plugins/openclaw-memgpt
  ```

## Test 1b — Installed but *unconfigured* → loaded yet fully inert (the gate)

Distinct from Test 1: the plugin loads, but does nothing until setup completes.

```bash
# ensure unconfigured (soft reset of the wizard fields only)
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));const g=c.plugins.entries["openclaw-memgpt"].config;delete g.provider;delete g.baseUrl;delete g.credential;fs.writeFileSync(p,JSON.stringify(c,null,2));'
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key
openclaw --dev agent --local --agent main --message "Remember I like espresso." --json 2>&1 | tee /tmp/t1b.log
pgrep -f "uvicorn main:app" && echo "FAIL: spawned while unconfigured" || echo "PASS: no sidecar spawned"
```

**Expect:** registration line present + the one-time
"not configured — run `openclaw memgpt setup`" notice; **no sidecar**; if the
model calls a memory tool the result is the `openclaw memgpt setup` string;
**no per-turn hook error spam** (hooks short-circuit silently); the agent still
responds.

## Test 2 — `uv` missing → wizard detects, warns, does NOT install

```bash
UV=$(which uv); mv "$UV" "$UV.bak"          # /opt/homebrew/bin is user-owned on Apple Silicon (no sudo); else use sudo
openclaw --dev memgpt setup                  # complete the flow (paste path is fine)
which uv || echo "PASS: uv still absent — wizard did not install it"
node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config)'  # config still saved
mv "$UV.bak" "$UV"                            # restore
```

**Expect:** a **"Prerequisite missing"** note with the uv install link (and the
"this wizard does not install it for you" line) + the cold-start heads-up; the
wizard still completes and saves config; `uv` is still absent afterward (no
auto-install).

**Bonus (runtime, uv missing):** with `uv` still renamed, configure then run an
agent turn → the sidecar spawn fails, the plugin marks itself dead, and memory
tools return `sidecar process died; restart OpenClaw` — the agent itself keeps
working. Confirms graceful degradation, not a crash.

## Test 3 — Correct installs across credential modes

For each mode: run the wizard, bring the matching stack up, run a turn that
stores a fact, then verify via recall (and a sidecar restart for cross-session).

### 3a — Paste API key (direct OpenAI-compatible)

```bash
openclaw --dev memgpt setup
#  provider: OpenAI-compatible · base: http://127.0.0.1:4000/v1 · Paste · key: sk-local-dev-only · model: <served>
ls -l ~/.openclaw-dev/plugins/openclaw-memgpt/api-key   # mode 600 file written
stat -f '%Lp' ~/.openclaw-dev/plugins/openclaw-memgpt/api-key   # expect 600
# LiteLLM up, then:
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my favourite drink is espresso." --json
pgrep -f "uvicorn main:app" && echo "PASS: sidecar spawned"
```

### 3b — Env-var API key

```bash
export OPENAI_API_KEY=sk-local-dev-only      # the var you'll name in the wizard
openclaw --dev memgpt setup                  # credential → environment variable → OPENAI_API_KEY
ls ~/.openclaw-dev/plugins/openclaw-memgpt/api-key 2>&1   # expect: No such file (env mode writes none)
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my favourite drink is espresso." --json
```

Failure edge: `unset OPENAI_API_KEY` then run a turn → basic memory still works,
but summarisation (on overflow) can't reach an LLM. Confirms the env var is
resolved at sidecar-spawn time.

### 3c — Institutional Bedrock (proxy shim + LiteLLM)

```bash
# Terminal A (in sidecar/): source ~/.secrets && uv run uvicorn proxy_shim:app --host 127.0.0.1 --port 4100
# Terminal B (in sidecar/): source ~/.secrets && uv run litellm --config litellm_config.yaml --port 4000
openclaw --dev memgpt setup                  # OpenAI-compatible · base: http://127.0.0.1:4000/v1 · paste or env key
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my favourite drink is espresso." --json
```

### Verify (all three), via ground truth

```bash
# PORT from the gateway/CLI log: "sidecar ready on http://127.0.0.1:<port>"
curl -s -XPOST "http://127.0.0.1:$PORT/agents/<namespace>/recall:search" \
  -H 'content-type: application/json' -d '{"query":"espresso"}'
# OR run a 2nd turn and confirm finalPromptText "N previous messages in recall memory" grew.
```

**Cross-session (load-bearing):** kill the sidecar PID, run another turn with the
same `OPENCLAW_MEMGPT_DATA_DIR` → recall still finds "espresso" (exercises the
`:load` rehydration path). A sidecar restart is the real "cross-session"
boundary, not a new `--session-id`.

## Test 4+ — Other manual checks

- **Re-entry / no key re-display:** re-run setup → intro reads "reconfigure",
  provider prefilled, credential prompt offers Keep / Replace / Switch and never
  prints the stored key. Try env→paste and Replace as well as file→env.
- **Switch paste→env cleanup:** after switching, `…/api-key` is gone and config
  shows `{source:"env",…}`. (Ordering: config written before the file is removed.)
- **Cancel writes nothing:** Ctrl-C mid-wizard → "Setup cancelled"; the
  `openclaw.json` sha256 is unchanged. Also test declining at the summary confirm.
- **Invalid key rejected:** paste a wrong-prefix key (Anthropic/OpenAI) → wizard
  rejects inline (format-only; never tests the key against the network).
- **Attach mode skips spawn guidance:** set a `sidecarUrl` in the wizard → no
  `uv`/cold-start notes; start a manual sidecar and confirm the plugin attaches
  instead of spawning, and at teardown does **not** SIGTERM your sidecar.
- **Observability levels:** `verbose` → `events.jsonl` (under the state dir) gets
  entries with content; `off` → stays empty/absent.
- **Secret-file security:** paste path → `stat -f '%Lp' …/api-key` is `600`; the
  key never appears in terminal output or logs.
- **Package boundary:** `npm pack --dry-run` → 48 files, no `tests/`,
  `__pycache__`, or dissertation dirs (`docs/`, `experiments/`, …).
- **First-run cold-start:** first configured turn blocks ~60–90s (embedder
  download); second run is fast.

---

## Restore

```bash
cp ~/.openclaw-dev/openclaw.json.bak ~/.openclaw-dev/openclaw.json
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key      # if you used the paste path
rm -f ~/.openclaw-dev/openclaw.json.rejected.* 2>/dev/null
```
