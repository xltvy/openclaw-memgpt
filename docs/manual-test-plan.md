# Manual test plan — install wizard, config gate, packaging (6d.6 / 6d.7)

Manual TTY checks for the install wizard, the unconfigured-state gate, the `uv`
prerequisite/cold-start guidance, and the package boundary. These exercise paths
that the unit suite cannot (real terminal prompts, sidecar spawn, OpenClaw
wiring). Dev-profile paths (`~/.openclaw-dev`) are assumed; this file is excluded
from the published package via the `files` whitelist in `package.json`.

## Conventions that apply to every test

- **The agent's own model is separate, and must be reachable + funded.** Every
  agent turn needs OpenClaw's own LLM (the "brain", in
  `~/.openclaw-dev/agents/main/agent/models.json`) — independent of the wizard,
  which configures only the memory **sidecar**. If the brain's endpoint is
  unreachable or out of budget, *every* turn fails regardless of memgpt. In this
  repo's dev setup the brain is `gpt-5.4` routed through a local LiteLLM
  (`http://127.0.0.1:4000/v1`) → proxy shim (`:4100`) → institutional endpoint,
  so that stack must be up before any agent turn (see CLAUDE.md "RUNNING THE
  STACK"). Quick diagnosis of an agent turn that errors:
  - `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/v1/models` →
    `000` means LiteLLM is **down** (start the stack);
  - a `500 … "Budget exceeded"` means the **upstream account hit its cap** (raise
    budget / switch model group / use a funded provider) — not a plugin or
    OpenClaw bug;
  - a normal reply means the brain is fine and you can exercise memory.
  A fresh OpenClaw install does *not* need LiteLLM — this dependency comes only
  from this repo's `models.json` pointing the brain at the local proxy.
- **Verify "memory works" by ground truth, not the CLI summary.** The CLI prints
  `livenessState:"abandoned"` + `⚠️ Agent couldn't generate a response` on every
  `send_message` turn by design (send_message isn't in OpenClaw's
  `CORE_MESSAGING_TOOLS`). Verify via the sidecar instead:
  - grab the port from the spawn log line `sidecar ready on http://127.0.0.1:<port>`,
  - `curl -s -XPOST http://127.0.0.1:<port>/agents/<namespace>/recall:search …`, or
  - recall-count growth in the next turn's `finalPromptText` (`--log-level trace`).
  See `CLAUDE.md` → "V1 PROTOCOL".
- **Back up first:** `cp ~/.openclaw-dev/openclaw.json ~/.openclaw-dev/openclaw.json.bak`
- **The plugin must be ENABLED for every wizard/gate test (1b onward).** The
  `openclaw memgpt setup` command and the tools/hooks only exist when the plugin
  is loaded — a **disabled** plugin registers nothing, so `memgpt setup` returns
  `unknown command 'memgpt'`. Test 1 disables the plugin; **re-enable before
  continuing:** `openclaw --dev plugins enable openclaw-memgpt`. (After install,
  the plugin is enabled by default, so a real first-time user already has the
  command.)
- **Restore when done** (see the end of this file).

---

## Test 1 — Not installed/active → zero effect on the agent

The plugin must not touch OpenClaw when it isn't active.

```bash
openclaw --dev plugins disable openclaw-memgpt        # "not used" without a full uninstall
openclaw --dev agent --local --agent main --message "Hello, who are you?" --json 2>&1 | tee /tmp/t1.log
grep -i "openclaw-memgpt: 7 tools" /tmp/t1.log && echo "FAIL: plugin loaded in agent run" || echo "PASS: plugin absent from agent run"
pgrep -f "uvicorn main:app" && echo "FAIL: sidecar spawned" || echo "PASS: no sidecar"
openclaw --dev plugins enable openclaw-memgpt          # restore
```

This check has **two independent parts** — keep them separate:

1. **Plugin isolation (the actual assertion, works even with the brain down):**
   the `agent` run's log must contain **no** `openclaw-memgpt: 7 tools … registered`
   line, no "not configured" notice, no sidecar, no `send_message`/`abandoned`
   artifact. This passes regardless of whether the LLM call succeeds.
2. **Agent replies normally (needs the brain up + funded):** a successful reply
   requires the host LLM to be reachable and in budget (see the prerequisites
   above). If the turn ends in `network connection error` (LiteLLM down) or
   `Budget exceeded` (account cap), that's the **brain**, not the plugin — and it
   still satisfies part 1, since the failure has zero memgpt involvement.

> **Gotcha:** the `openclaw-memgpt: … registered` line you'll see printed by the
> `plugins disable` command *itself* is expected — that command loads the plugin
> once to operate on it. Only the **`agent` run's** output (`/tmp/t1.log`) counts
> for part 1; that's why the grep targets the log file, not the disable command's
> stdout.

- If `plugins disable` errors on the config-write guard, set
  `entries.openclaw-memgpt.enabled=false` by hand instead.
- **Full-uninstall variant — use the plugin's own command** (removes artifacts
  + de-registers in one go, and bypasses the size-drop guard that blocks generic
  `plugins uninstall` on a minimal config):
  ```bash
  openclaw --dev memgpt uninstall --force
  ```

## Test 1b — Installed but *unconfigured* → loaded yet fully inert (the gate)

Distinct from Test 1: the plugin loads, but does nothing until setup completes.

> **Precondition:** the plugin must be **enabled** (`openclaw --dev plugins
> enable openclaw-memgpt`). If you just ran Test 1, it's disabled — this test
> would otherwise show no registration line and look (wrongly) like Test 1.

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

> **Precondition:** the plugin must be **enabled** so the `memgpt` command
> exists — otherwise `openclaw --dev memgpt setup` returns
> `unknown command 'memgpt'`. If you ran Test 1:
> `openclaw --dev plugins enable openclaw-memgpt`.

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

**Bonus (runtime, uv missing) — fail-fast:** with `uv` still renamed, configure
then run an agent turn → `spawn("uv")` emits `ENOENT` and the plugin **aborts
the healthz wait immediately** (it does *not* sit through the 120s timeout),
marks itself dead, and tools degrade with the sidecar-unavailable message — the
agent itself keeps working. Watch the timing: the failure should land within a
second or two of `sidecar spawning…`, not after ~120s. (Regression guard for
the original 120s hang, fixed in `fix(lifecycle): fail fast when sidecar spawn
errors`.)

> **Heads-up:** while `uv` is renamed, the **integration test suite will fail**
> (those tests spawn a real sidecar via `uv run`). Restore uv
> (`mv ~/.local/bin/uv.bak ~/.local/bin/uv`) before running `node --test`.

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

**Primary signal in `--local` mode: `finalPromptText`.** Each turn's prompt
carries the MemGPT section the sidecar injected — e.g. *"N previous messages …
in recall memory, M … in archival"* plus the `<human>`/`<persona>` core-memory
blocks. Success looks like:
- a stored fact appears in the `<human>` block on a *later* turn (e.g. after a
  `core_memory_append`, the next run's prompt shows "Favourite drink is
  espresso" — and that string is in **no** workspace file, so it's genuine
  memgpt core memory, not injected markdown), and
- the recall count grows across turns.

> **Why not curl the sidecar after the turn?** In `--local` mode the plugin
> tears the sidecar down when the CLI process exits, so a port from the spawn
> log is dead by the time the prompt returns. To curl `recall:search`/`archival
> :search` directly, either run it *while a turn is in flight*, or use **attach
> mode** (start the sidecar by hand on a fixed port, set `config.sidecarUrl`),
> which keeps it alive:
> ```bash
> PORT=8765   # your manually-started attach-mode sidecar
> NS=v1-cell-c-p5-t00   # your config.namespace (see the registration log line)
> curl -s -XPOST "http://127.0.0.1:${PORT}/agents/${NS}/recall:search" \
>   -H 'content-type: application/json' -d '{"query":"espresso"}'
> ```

**Cross-session (load-bearing) — already exercised by `--local`.** Because each
`--local` turn spawns a *fresh* sidecar that `:load`s from `OPENCLAW_MEMGPT_DATA_DIR`,
a fact written in one turn's process and surfaced in a *later* turn's prompt
(different sidecar process) already proves the `:load` rehydration path. In
gateway/attach mode, force it explicitly by killing the sidecar PID between
turns. A sidecar restart is the real "cross-session" boundary, not a new
`--session-id`.

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
- **Unreachable-endpoint notify (the plugin does NOT boot LiteLLM/Ollama for
  you):** configure OpenAI-compatible with a *local* base URL (e.g.
  `http://127.0.0.1:4000/v1`) while nothing is listening there →
  - **wizard** shows an "Endpoint not reachable" note with a "start your local
    server" hint, and still saves config;
  - **runtime** — start an agent with that endpoint down → after the sidecar
    comes up, a warning logs that the LLM endpoint is unreachable (summarisation
    will fail until it's up); the turn still works for non-LLM memory ops.
  Then start the endpoint and confirm no warning. A direct provider
  (`api.anthropic.com`/`api.openai.com`) is reachable over the internet, so it
  never warns. (Connection-level check: an auth-gated endpoint returning 401
  counts as reachable — no false warning.)
- **Attach mode skips spawn guidance:** set a `sidecarUrl` in the wizard → no
  `uv`/cold-start notes; start a manual sidecar and confirm the plugin attaches
  instead of spawning, and at teardown does **not** SIGTERM your sidecar.
- **Observability levels:** `verbose` → `events.jsonl` (under the state dir) gets
  entries with content; `off` → stays empty/absent.
- **Secret-file security:** paste path → `stat -f '%Lp' …/api-key` is `600`; the
  key never appears in terminal output or logs.
- **Uninstall command:** `openclaw --dev memgpt uninstall --dry-run` lists the
  artifacts (secret dir, `memgpt-data`, observability log) + the config path,
  changing nothing. Then `… uninstall --force` removes them and de-registers the
  plugin (`plugins list` no longer shows it; an agent run shows no registration
  line). `--keep-data` preserves `memgpt-data`; without `--force` it confirms
  first (and errors in a non-interactive shell). The linked source repo is
  untouched.
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
