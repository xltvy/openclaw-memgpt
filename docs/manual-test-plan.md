# Manual test plan — rc1 pre-publish (OpenClaw 2026.6.8)

The last gate before publishing. Run top-to-bottom. Each test is **Reset → Run →
Check**; the **Check** block prints `PASS`/`FAIL` (or a value to compare) so you
never have to eyeball logs. Where a step is interactive (wizard prompts), the
Run block says exactly what to type and the Check verifies the persisted result.

`REPO` and dev paths are assumed below. Set once per shell:
```bash
REPO=~/Workspace/UCL/dissertation/openclaw-memgpt
CFG=~/.openclaw-dev/openclaw.json
cd "$REPO"
```

## Preflight (run once, before everything)

```bash
# 0a. Back up config
cp "$CFG" "$CFG.bak" && echo "backed up"

# 0b. Brain (host LLM) reachable? memory turns need it, independent of the plugin.
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/v1/models)
[ "$code" != "000" ] && echo "PASS: brain endpoint up ($code)" || echo "FAIL: LiteLLM down — start the stack (CLAUDE.md → RUNNING THE STACK)"

# 0c. uv present (plugin spawns the sidecar via uv)
command -v uv >/dev/null && echo "PASS: uv present" || echo "FAIL: install uv"
```
A `500 "Budget exceeded"` from the brain is an account cap, not a plugin bug.

---

## 1 — Install

### 1a — Packaged install (community path; clean, no force flag)
**Run:**
```bash
cd "$REPO"
rm -f openclaw-memgpt-*.tgz
npm pack 2>/tmp/pack.err 1>/tmp/pack.out                      # prepack builds dist/
rm -rf ~/.openclaw-pkgtest
OPENCLAW_PROFILE=pkgtest openclaw --profile pkgtest plugins install ./openclaw-memgpt-*.tgz > /tmp/t1a.log 2>&1
```
**Check (PASS prints PASS):**
```bash
grep -q "Installed plugin: openclaw-memgpt" /tmp/t1a.log \
  && ! grep -qiE "requires compiled runtime output|dangerous|unsafe-install" /tmp/t1a.log \
  && echo "PASS" || { echo "FAIL"; cat /tmp/t1a.log; }
```
**Cleanup:** `rm -rf ~/.openclaw-pkgtest; rm -f openclaw-memgpt-*.tgz`

### 1b — Dev `--link` install (used by all later tests)
**Reset (run first):**
```bash
cd "$REPO" && rm -rf sidecar/.venv 'sidecar/~'
find . -type d | wc -l    # must be < 10000; if not, see the note below
```
**Run:**
```bash
openclaw --dev plugins install --link . > /tmp/t1b.log 2>&1
```
**Check:**
```bash
node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins||{};
const ok=(c.load?.paths||[]).some(p=>p.includes("openclaw-memgpt")) && c.slots?.memory==="openclaw-memgpt";
console.log(ok?"PASS":"FAIL", "| inLoad:",(c.load?.paths||[]).some(p=>p.includes("openclaw-memgpt")),"slot:",c.slots?.memory)'
```
> **If "manifest dependency scan exceeded max directories (10000)":** a stray heavy
> dir. Find + remove it, then re-run:
> ```bash
> for d in */ sidecar/*/ ; do echo "$(find "$d" -type d|wc -l) $d"; done | sort -rn | head
> rm -rf sidecar/.venv 'sidecar/~'   # a uv venv, or a literal "~" dir, are the usual culprits
> ```

### 1c — Enable (later tests need the `memgpt` command)
**Run + Check:**
```bash
openclaw --dev plugins enable openclaw-memgpt >/dev/null 2>&1
node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].enabled===true?"PASS":"FAIL")'
```

---

## 2 — Config gates

### 2a — Disabled → zero effect on the agent
**Run:**
```bash
openclaw --dev plugins disable openclaw-memgpt >/dev/null 2>&1
source ~/.secrets && openclaw --dev agent --local --agent main --message "Hello" --json > /tmp/t2a.log 2>&1
```
**Check:**
```bash
! grep -q "openclaw-memgpt: 7 tools" /tmp/t2a.log \
  && ! pgrep -f "uvicorn main:app" >/dev/null \
  && echo "PASS: plugin inert + no sidecar" || echo "FAIL"
```
**Reset (re-enable for the rest):**
```bash
openclaw --dev plugins enable openclaw-memgpt >/dev/null 2>&1
```

### 2b — Enabled but UNCONFIGURED → loads yet fully inert
**Reset (clear config so it's unconfigured):**
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));const g=c.plugins.entries["openclaw-memgpt"].config||{};delete g.provider;delete g.baseUrl;delete g.credential;c.plugins.entries["openclaw-memgpt"].config=g;fs.writeFileSync(p,JSON.stringify(c,null,2));'
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key
```
**Run:**
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember I like espresso." --json > /tmp/t2b.log 2>&1
```
**Check:**
```bash
grep -q "openclaw-memgpt: 7 tools" /tmp/t2b.log \
  && grep -qi "not configured" /tmp/t2b.log \
  && ! pgrep -f "uvicorn main:app" >/dev/null \
  && echo "PASS: loaded, notice shown, no sidecar" || { echo "FAIL"; grep -i "openclaw-memgpt" /tmp/t2b.log; }
```

---

## 3 — Setup wizard (interactive)

> Each sub-test runs `openclaw --dev memgpt setup` and you answer the prompts as
> described; the **Check** verifies the persisted result.

### 3a — Paste API key
**Run:** `openclaw --dev memgpt setup` → provider **OpenAI-compatible** · base `http://127.0.0.1:4000/v1` · **Paste** · key `sk-local-dev-only` · model `claude-haiku-dev` (any) · observability `off` · sidecar **blank** · summary **Yes** · pre-warm **No** (faster).
**Check:**
```bash
F=~/.openclaw-dev/plugins/openclaw-memgpt/api-key
[ -f "$F" ] && [ "$(stat -f '%Lp' "$F")" = "600" ] \
  && node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config; process.exit(c.credential&&c.credential.source==="file"?0:1)' \
  && echo "PASS: 600 secret file + credential=file" || echo "FAIL"
```

### 3b — Env-var API key
**Reset:** `export OPENAI_API_KEY=sk-local-dev-only`
**Run:** `openclaw --dev memgpt setup` → provider **OpenAI-compatible** · **Environment variable** · name `OPENAI_API_KEY` · (rest as 3a).
**Check:**
```bash
[ ! -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key ] \
  && node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config; process.exit(c.credential&&c.credential.source==="env"&&c.credential.var==="OPENAI_API_KEY"?0:1)' \
  && echo "PASS: no secret file + credential=env" || echo "FAIL"
```

### 3c — Re-entry + file→env switch (no key re-display)
**Reset (make it file-mode first):** do 3a.
**Run:** `openclaw --dev memgpt setup` → on the credential prompt choose **Switch** to env, name `ANTHROPIC_API_KEY` (observe: the stored key is **never printed**).
**Check:**
```bash
[ ! -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key ] \
  && node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config; process.exit(c.credential&&c.credential.source==="env"?0:1)' \
  && echo "PASS: secret file removed + credential=env" || echo "FAIL"
```

### 3d — Pre-warm offer
**Reset:** `rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm`
**Run:** `openclaw --dev memgpt setup` → at the end, **Accept** "Pre-download the embedding model now".
**Check:**
```bash
[ "$(cat ~/.openclaw-dev/memgpt-data/.embedder-warm 2>/dev/null)" = "BAAI/bge-small-en-v1.5" ] \
  && echo "PASS: marker written" || echo "FAIL"
```
(Decline variant: reset the marker, run setup, choose **No** → Check expects the marker **absent**: `[ ! -f ~/.openclaw-dev/memgpt-data/.embedder-warm ] && echo PASS || echo FAIL`.)

### 3e — Conversation-access grant (the gateway hook gate; the wizard sets it)
**Reset (prove the wizard sets it, not a leftover):**
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));delete c.plugins.entries["openclaw-memgpt"].hooks;fs.writeFileSync(p,JSON.stringify(c,null,2));'
```
**Run:** `openclaw --dev memgpt setup` (any valid path; observe the **"Conversation access"** note before it saves).
**Check:**
```bash
node -e 'const h=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].hooks; console.log(h&&h.allowConversationAccess===true?"PASS":"FAIL", JSON.stringify(h))'
```

### 3f — Cancel writes nothing
**Run + Check (one block):**
```bash
B=$(shasum -a 256 "$CFG" | awk '{print $1}')
openclaw --dev memgpt setup        # Ctrl-C mid-wizard, OR answer "No" at the summary
A=$(shasum -a 256 "$CFG" | awk '{print $1}')
[ "$B" = "$A" ] && echo "PASS: config unchanged" || echo "FAIL: config mutated"
```
Test **both** paths (Ctrl-C early, and decline at summary).

### 3g — Invalid key rejected (format only)
**Run:** `openclaw --dev memgpt setup` → provider **Anthropic** · **Paste** · key `not-a-key`.
**Check:** **PASS** = the prompt rejects inline with `Expected an Anthropic … key starting with "sk-ant-"` and won't proceed until you enter a valid-prefix key (no network call). (Don't use OpenAI-compatible here — it has no prefix rule.) Then Ctrl-C out.

### 3h — Unreachable endpoint warns (still saves)
**Run:** `openclaw --dev memgpt setup` → **OpenAI-compatible** · base `http://127.0.0.1:4999/v1` (nothing listening) · finish.
**Check:** **PASS** = wizard shows an **"Endpoint not reachable"** note with a "start your local server" hint **and still completes** (config saved). Verify saved:
```bash
node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config.baseUrl==="http://127.0.0.1:4999/v1"?"PASS: saved despite warning":"FAIL")'
```
**Reset (restore a working endpoint): re-run 3a or 3b before continuing.**

### 3i — `uv` missing → warns, no pre-warm offer, still saves
**Reset:** `UVP=$(command -v uv); mv "$UVP" "$UVP.bak"`
**Run:** `openclaw --dev memgpt setup` (any valid path).
**Check:** **PASS** = a **"Prerequisite missing"** note with the uv install link + "does not install it for you", **no** pre-warm offer, config still saved, and:
```bash
command -v uv >/dev/null && echo "FAIL: uv reappeared" || echo "PASS: uv still absent (wizard didn't install it)"
```
**Reset (REQUIRED — restore uv before any later test; self-locating, doesn't need `$UVP`):**
```bash
for d in $(echo "$PATH" | tr ':' ' '); do [ -e "$d/uv.bak" ] && mv "$d/uv.bak" "$d/uv" && echo "restored $d/uv"; done
command -v uv && echo "uv on PATH ✓" || echo "STILL MISSING"
```

---

## 4 — Prewarm (standalone CLI)

**Reset:** `rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm`
**Run:**
```bash
openclaw --dev memgpt prewarm > /tmp/t4.log 2>&1; echo "exit=$?"
```
**Check:**
```bash
[ "$(cat ~/.openclaw-dev/memgpt-data/.embedder-warm 2>/dev/null)" = "BAAI/bge-small-en-v1.5" ] \
  && grep -qi "cached" /tmp/t4.log && echo "PASS: cached + marker written" || echo "FAIL"
```

---

## 5 — Memory end-to-end (the load-bearing property)

**Reset (configure + prewarm + fresh namespace):**
```bash
# configure if not already (paste path): openclaw --dev memgpt setup
openclaw --dev memgpt prewarm >/dev/null 2>&1                      # so cold-start isn't a confound
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.namespace="mt-"+Date.now();fs.writeFileSync(p,JSON.stringify(c,null,2));'
NS=$(node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config.namespace)')
echo "NS=$NS"
```

### 5a — Cross-session recall (`--local`, two processes) + 5b one-sidecar
**Run:**
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my lucky number is 4173. Acknowledge." --json > /tmp/t5_turn1.log 2>&1
sleep 8                                                            # detached sidecar finishes its shutdown save
source ~/.secrets && openclaw --dev agent --local --agent main --message "What is my lucky number? Check your memory." --json > /tmp/t5_turn2.log 2>&1
```
**Check — turn 1 wrote a complete pickle + one sidecar (5b):**
```bash
PK=$(find ~/.openclaw-dev/memgpt-data/agents/$NS/persistence_manager -name '*.pickle' 2>/dev/null | head -1)
[ -n "$PK" ] && [ "$(stat -f%z "$PK")" -gt 0 ] && echo "PASS: non-zero pickle" || echo "FAIL: pickle missing/empty"
[ "$(grep -c 'sidecar spawning' /tmp/t5_turn1.log)" = "1" ] && echo "PASS: exactly one sidecar (5b)" || echo "FAIL: multi-sidecar"
```
**Check — turn 2 had no hook timeout / errors:**
```bash
! grep -qE "timed out after 15000ms|not resident|Cannot load|Internal Server Error" /tmp/t5_turn2.log && echo "PASS: clean turn" || { echo "FAIL"; grep -iE "timed out|not resident|Cannot load|500" /tmp/t5_turn2.log; }
```
**Check — DECISIVE cross-session (rule out the session buffer):**
```bash
# (a) saved memgpt state actually holds it
python3 -c "import json,glob,os; d=os.path.expanduser('~/.openclaw-dev/memgpt-data/agents/$NS/agent_state'); f=sorted(glob.glob(d+'/*.json'))[-1]; print('PASS' if '4173' in json.dumps(json.load(open(f))) else 'FAIL', '(saved state)')"
# (b) buffer-free: archive sessions, ask in a NEW session — only memgpt :load can answer
mkdir -p /tmp/oc-sess-bak && mv ~/.openclaw-dev/agents/main/sessions/*.jsonl /tmp/oc-sess-bak/ 2>/dev/null
source ~/.secrets && openclaw --dev agent --local --agent main --session-id clean-$(date +%s) --message "What is my lucky number? Use only your memory." --json > /tmp/t5_bufferfree.log 2>&1
grep -q 4173 /tmp/t5_bufferfree.log && echo "PASS: buffer-free recall (genuine :load)" || echo "FAIL"
```
**Reset (restore archived sessions before later tests):**
```bash
mv /tmp/oc-sess-bak/*.jsonl ~/.openclaw-dev/agents/main/sessions/ 2>/dev/null; echo "sessions restored"
```

### 5c — Gateway mode (real-user daemon path)
**Reset (grant must be present — wizard sets it; ensure it for this test):**
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));const e=c.plugins.entries["openclaw-memgpt"];e.hooks={...(e.hooks||{}),allowConversationAccess:true};fs.writeFileSync(p,JSON.stringify(c,null,2));'
pkill -9 -f "gateway run" 2>/dev/null; lsof -ti :19001 2>/dev/null | xargs -r kill -9; sleep 2
```
**Run:**
```bash
source ~/.secrets && nohup openclaw --dev gateway run --allow-unconfigured > /tmp/t5c_gw.log 2>&1 &
for i in $(seq 1 100); do grep -q "sidecar ready" /tmp/t5c_gw.log && break; sleep 1; done
source ~/.secrets && openclaw --dev agent --agent main --message "Remember my plant is Fernie." --json > /tmp/t5c_turn.log 2>&1
sleep 2
PORT=$(grep -oE "sidecar ready on http://127.0.0.1:[0-9]+" /tmp/t5c_gw.log | tail -1 | grep -oE "[0-9]+$")
```
**Check — hooks allowed (Fix 1), turn ran, mirror reached recall:**
```bash
! grep -qi "openclaw-memgpt.*blocked because" /tmp/t5c_gw.log && echo "PASS: hooks not blocked (Fix 1)" || echo "FAIL: hooks blocked"
! grep -q "EMBEDDED FALLBACK" /tmp/t5c_turn.log && echo "PASS: ran on gateway" || echo "FAIL: fell back to embedded (gateway down)"
curl -s -XPOST "http://127.0.0.1:$PORT/agents/$(node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config.namespace)')/recall:search" -H 'content-type: application/json' -d '{"query":"Fernie"}' | grep -qi Fernie && echo "PASS: agent_end mirror reached recall" || echo "FAIL: mirror missing"
```
**Check — clean teardown + persistence:**
```bash
lsof -ti :19001 | xargs kill -TERM; sleep 3
grep -qi "teardown — final save complete" /tmp/t5c_gw.log && echo "PASS: final save on shutdown" || echo "FAIL"
```

### 5d — Observability JSONL completeness under multi-register (Fix 2)
Uses the gateway turn from 5c (run it with `observability:"verbose"` for full coverage; default also emits these).
**Check:**
```bash
python3 -c "
import json, collections, os
path = os.path.expanduser('~/.openclaw-dev/memgpt-observability.jsonl')
c = collections.Counter(json.loads(l).get('kind') for l in open(path) if l.strip())
print(c)
print('PASS' if c['messages_mirrored'] and c['agent_saved'] else 'FAIL')
"
```
**PASS:** the counter shows `messages_mirrored` and `agent_saved` ≥1 (hook events reached the JSONL, not just `sidecar_spawned`).

---

## 6 — Cold-start behaviour

### 6a — Prewarmed → first turn fast (no throwaway turn needed)
**Reset:**
```bash
openclaw --dev memgpt prewarm >/dev/null 2>&1
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.namespace="cold-"+Date.now();fs.writeFileSync(p,JSON.stringify(c,null,2));'
NS=$(node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config.namespace)')
```
**Run + Check:**
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my code is 7788." --json > /tmp/t6a.log 2>&1
! grep -q "timed out after 15000ms" /tmp/t6a.log && echo "PASS: first turn within hook budget (prewarmed)" || echo "FAIL: timed out"
```

### 6b — Cold cache → first turn slow, second fast (DESTRUCTIVE — one-time ~60s re-download)
**Reset (only if you accept re-downloading the model):**
```bash
rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm
rm -rf ~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.namespace="coldcache-"+Date.now();fs.writeFileSync(p,JSON.stringify(c,null,2));'
NS=$(node -e 'console.log(require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins.entries["openclaw-memgpt"].config.namespace)')
```
**Run:**
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "Remember my code is 5566." --json > /tmp/t6b1.log 2>&1   # downloads
sleep 8
source ~/.secrets && openclaw --dev agent --local --agent main --message "What is my code?" --json > /tmp/t6b2.log 2>&1            # offline-fast
```
**Check:**
```bash
[ "$(cat ~/.openclaw-dev/memgpt-data/.embedder-warm 2>/dev/null)" = "BAAI/bge-small-en-v1.5" ] && echo "PASS: marker written after download" || echo "FAIL"
! grep -q "timed out after 15000ms" /tmp/t6b2.log && grep -q 5566 /tmp/t6b2.log && echo "PASS: turn 2 fast + recalls" || echo "FAIL"
```
(Turn 1 may show `timed out after 15000ms` — documented cold first-turn; not a failure.)

---

## 7 — Edge cases

### 7a — Corrupt/truncated saved state → re-creates, never 500
Self-contained. Note: **P4 re-saves the resident agent on every sidecar
shutdown**, so you must corrupt the pickles *after* the final save — otherwise
`:ensure` just loads the fresh P4 save. Sequence: create + mutate → kill (P4
writes the saved state) → corrupt **all** pickles → fresh sidecar → `:ensure`
must re-create. No dependence on `$NS` from earlier tests.

A reusable start helper (paste once per shell):
```bash
start_sc() {
  cd "$REPO"; pkill -f "uvicorn main:app" 2>/dev/null; sleep 1
  OPENCLAW_MEMGPT_DATA_DIR="$HOME/.openclaw-dev/memgpt-data" UV_PROJECT_ENVIRONMENT="$HOME/.openclaw-dev/memgpt-sidecar-venv" \
    uv run --project sidecar uvicorn main:app --app-dir sidecar --host 127.0.0.1 --port 8765 > /tmp/sc.log 2>&1 &
  until curl -sf http://127.0.0.1:8765/healthz >/dev/null; do sleep 1; done; echo "sidecar up on 8765"
}
```
> **zsh note:** the namespace before `:ensure` is wrapped as `${N7}` — bare
> `$N7:ensure` makes zsh try a `:e` history-modifier ("bad substitution").
> `$N7/core_memory:append` (slash after the var) is fine as-is.

**Step 1 — clean slate + create + mutate a test agent:**
```bash
D="$HOME/.openclaw-dev/memgpt-data"; N7=edge-7a
rm -rf "$D/agents/$N7"          # remove any stale state from a prior run
start_sc
curl -s -XPOST "http://127.0.0.1:8765/agents" -H 'content-type: application/json' -d "{\"name\":\"$N7\",\"model\":\"gpt-4\"}" >/dev/null
curl -s -XPOST "http://127.0.0.1:8765/agents/$N7/core_memory:append" -H 'content-type: application/json' -d '{"name":"human","content":"edge-7a marker"}' >/dev/null
```

**Step 2 — kill (P4 saves on shutdown), wait, then corrupt ALL pickles:**
```bash
pkill -f "uvicorn main:app"; sleep 3
for f in "$D/agents/$N7/persistence_manager/"*.pickle; do : > "$f"; done
ls -la "$D/agents/$N7/persistence_manager/"*.pickle | awk '{print $5, $NF}'   # all should be 0 bytes
```

**Step 3 — fresh sidecar → `:ensure` must re-create (not 500):**
```bash
start_sc
VIA=$(curl -s -XPOST "http://127.0.0.1:8765/agents/${N7}:ensure" -H 'content-type: application/json' -d '{}')
echo "$VIA" | grep -q '"via":"create"' && echo "PASS: re-created (no 500)" || { echo "FAIL"; echo "$VIA"; }
```

**Step 4 — kill the sidecar:** `pkill -f "uvicorn main:app"`

### 7b — Cache eviction → clear error + recovery
> **The error half is automated-only.** Triggering a real cache miss on demand is
> unreliable on macOS: `bge-small` reloads from a persistent HF/sentence-transformers
> cache that neither `rm -rf …/hub/models--BAAI…` nor `HF_HOME=<empty>` evicts
> deterministically. The offline-fail → "cache appears unavailable" + marker-clear
> path is covered by the automated test
> `sidecar/tests/test_embedder_offline.py::test_load_embedder_offline_failure_clears_marker_and_raises`
> (mocks the load failure). Verify that once:
> ```bash
> cd "$REPO" && UV_PROJECT_ENVIRONMENT=~/.openclaw-dev/memgpt-sidecar-venv \
>   uv run --project sidecar pytest sidecar/tests/test_embedder_offline.py -q 2>&1 | tail -2
> ```
> **PASS:** `7 passed`.

**Manual half — the recovery path (reliable):** `prewarm` re-establishes the
warm cache + marker, so a subsequent turn is offline-fast.
**Run + Check:**
```bash
rm -f ~/.openclaw-dev/memgpt-data/.embedder-warm
openclaw --dev memgpt prewarm > /tmp/t7b.log 2>&1; echo "exit=$?"
[ "$(cat ~/.openclaw-dev/memgpt-data/.embedder-warm 2>/dev/null)" = "BAAI/bge-small-en-v1.5" ] \
  && grep -qi "cached" /tmp/t7b.log && echo "PASS: prewarm recovered (marker + cache)" || echo "FAIL"
```

### 7c — Sidecar-dead degradation (fail-fast, not 120s hang)
**Reset:** `UVP=$(command -v uv); mv "$UVP" "$UVP.bak"`
**Run + Check:**
```bash
t0=$(date +%s)
source ~/.secrets && openclaw --dev agent --local --agent main --message "hi" --json > /tmp/t7c.log 2>&1
t1=$(date +%s)
# degraded message — the actual wording is "did not become ready / not resident / uv installed and on PATH":
grep -qiE "did not become ready|not resident|uv installed and on PATH|spawn uv ENOENT|sidecar process died" /tmp/t7c.log \
  && echo "PASS: degraded message (clear, actionable)" || { echo "FAIL"; grep -i "openclaw-memgpt" /tmp/t7c.log | tail -3; }
# fast-fail — the spawn aborts on ENOENT instead of waiting the 120s healthz timeout.
# (the whole turn still includes the brain's LLM call, so allow generous headroom under 120s)
[ $((t1-t0)) -lt 90 ] && echo "PASS: no 120s hang ($((t1-t0))s)" || echo "FAIL: hung ($((t1-t0))s)"
```
(The agent itself still responds — the failure is confined to the memory sidecar.)
**Reset (REQUIRED — self-locating, doesn't need `$UVP`):**
```bash
for d in $(echo "$PATH" | tr ':' ' '); do [ -e "$d/uv.bak" ] && mv "$d/uv.bak" "$d/uv" && echo "restored $d/uv"; done
command -v uv && echo "uv on PATH ✓" || echo "STILL MISSING"
```

### 7d — Attach mode (plugin attaches, doesn't kill your sidecar)
**Reset:** start a manual sidecar on 8765 (reuse `start_sc` from 7a, or paste its
body), then point the plugin at it:
```bash
start_sc    # the helper defined in 7a; or paste its 3 lines
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.sidecarUrl="http://127.0.0.1:8765";fs.writeFileSync(p,JSON.stringify(c,null,2));'
```
**Run + Check:**
```bash
source ~/.secrets && openclaw --dev agent --local --agent main --message "hi attach" --json > /tmp/t7d.log 2>&1
[ "$(grep -c 'sidecar spawning' /tmp/t7d.log)" = "0" ] && echo "PASS: attached (no spawn)" || echo "FAIL: spawned its own"
curl -sf http://127.0.0.1:8765/healthz >/dev/null && echo "PASS: your sidecar still alive (not SIGTERMed)" || echo "FAIL: plugin killed your sidecar"
```
**Reset (REQUIRED):**
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));delete c.plugins.entries["openclaw-memgpt"].config.sidecarUrl;fs.writeFileSync(p,JSON.stringify(c,null,2));'
pkill -f "uvicorn main:app" 2>/dev/null
```

### 7e — Observability levels
**Run + Check (verbose writes content; off stays empty):**
```bash
node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.plugins.entries["openclaw-memgpt"].config.observability="verbose";fs.writeFileSync(p,JSON.stringify(c,null,2));'
: > ~/.openclaw-dev/memgpt-observability.jsonl
source ~/.secrets && openclaw --dev agent --local --agent main --message "verbose check" --json >/dev/null 2>&1
[ -s ~/.openclaw-dev/memgpt-observability.jsonl ] && echo "PASS: verbose wrote events" || echo "FAIL"
```
**Reset:** `node -e 'const fs=require("fs"),p=process.env.HOME+"/.openclaw-dev/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));delete c.plugins.entries["openclaw-memgpt"].config.observability;fs.writeFileSync(p,JSON.stringify(c,null,2));'`

---

## 8 — Uninstall

**Reset (set up artifacts to watch them get removed):** plugin installed + configured via **paste** (3a, creates the secret file) + one turn run (creates `memgpt-data`). Helpers:
```bash
inspect() {
  echo "-- artifacts --"; ls -d ~/.openclaw-dev/plugins/openclaw-memgpt ~/.openclaw-dev/memgpt-data \
    ~/.openclaw-dev/memgpt-observability.jsonl ~/.openclaw-dev/memgpt-sidecar-venv 2>/dev/null || true
  node -e 'const c=require(process.env.HOME+"/.openclaw-dev/openclaw.json").plugins||{};
    console.log("entry:",!!c.entries?.["openclaw-memgpt"],"install:",!!c.installs?.["openclaw-memgpt"],"slot:",c.slots?.memory)'
}
reinstall() { cd "$REPO" && rm -rf sidecar/.venv && openclaw --dev plugins install --link . >/dev/null 2>&1 && openclaw --dev memgpt setup; }
```
> **`install: false` is normal for a dev `--link` install** — what loads the
> plugin is `load.paths` + `entry.enabled` + the `memory` `slot` (all present).
> The `plugins.installs` map is install-provenance bookkeeping that a **packaged**
> install (Test 1a) writes but `--link` doesn't re-add after a `memgpt uninstall`.
> Not a failure; the U-case PASS checks gate on artifacts + the `memgpt` command,
> not on this flag.

- **U1 `--dry-run`:** `inspect; openclaw --dev memgpt uninstall --dry-run; inspect` → **PASS** = "Dry run — no changes" box (mentions "an interactive uninstall will offer to keep memgpt-data"); both `inspect` outputs identical.
- **U2 decline (interactive 3-way prompt):** `openclaw --dev memgpt uninstall` → the prompt offers **Remove everything / Keep my memory data / Cancel — remove nothing**; choose **Cancel — remove nothing** (or press Esc) → **PASS** = "cancelled"; `inspect` unchanged.
- **U3 accept — remove everything:** `openclaw --dev memgpt uninstall` → choose **Remove everything**. **Check:**
  ```bash
  ls ~/.openclaw-dev/plugins/openclaw-memgpt 2>/dev/null && echo "FAIL: artifacts remain" || echo "PASS: artifacts gone"
  ls ~/.openclaw-dev/memgpt-data 2>/dev/null && echo "FAIL: data remains" || echo "PASS: data gone"
  openclaw --dev memgpt --help 2>&1 | grep -qi "unknown command" && echo "PASS: command gone" || echo "FAIL"
  ```
  then `reinstall`.
- **U3b interactive keep (no flag):** `openclaw --dev memgpt uninstall` → choose **Keep my memory data**. **Check:**
  ```bash
  [ -d ~/.openclaw-dev/memgpt-data ] && echo "PASS: data kept" || echo "FAIL"
  [ ! -d ~/.openclaw-dev/plugins/openclaw-memgpt ] && echo "PASS: secret dir removed" || echo "FAIL"
  openclaw --dev memgpt --help 2>&1 | grep -qi "unknown command" && echo "PASS: command gone" || echo "FAIL"
  ```
  then `reinstall` (re-add `namespace` in setup to resume the kept data).
- **U4 `--force`:** `openclaw --dev memgpt uninstall --force` → no prompt; same checks as U3 (everything gone). then `reinstall`.
- **U5 `--keep-data`:** `openclaw --dev memgpt uninstall --force --keep-data`. **Check:**
  ```bash
  [ -d ~/.openclaw-dev/memgpt-data ] && echo "PASS: data kept" || echo "FAIL"
  [ ! -d ~/.openclaw-dev/plugins/openclaw-memgpt ] && echo "PASS: secret dir removed" || echo "FAIL"
  ```
  then `reinstall`.
- **U6 non-interactive, no `--force`:** `openclaw --dev memgpt uninstall </dev/null` → **PASS** = errors "needs confirmation — re-run with --force"; `inspect` unchanged.
- **U7 round-trip:** `openclaw --dev memgpt uninstall --force; reinstall` then a turn:
  ```bash
  source ~/.secrets && openclaw --dev agent --local --agent main --message "hi" --json > /tmp/u7.log 2>&1
  grep -q "openclaw-memgpt: 7 tools" /tmp/u7.log && echo "PASS: clean reinstall works" || echo "FAIL"
  ```

A one-line "SDK config update rejected … writing config directly" warning on the minimal dev config is **expected** (size-drop guard). A full uninstall resets `namespace`/`persona`/`human` to defaults (data stays on disk; use `--keep-data` + re-add `namespace` to resume).

---

## 9 — Package boundary
**Run + Check:**
```bash
cd "$REPO"
npm pack --dry-run > /tmp/t9.log 2>&1
grep -q "dist/index.js" /tmp/t9.log && grep -q "sidecar/main.py" /tmp/t9.log \
  && ! grep -qiE "(tests/|__pycache__|\.venv|docs/|experiments/|\.test\.)" /tmp/t9.log \
  && echo "PASS: ships src+dist+sidecar; no tests/docs/experiments" || { echo "FAIL — offenders:"; grep -iE "(tests/|docs/|experiments/|__pycache__|\.venv|\.test\.)" /tmp/t9.log; }
```

---

## Restore (after all tests)
```bash
pkill -f "uvicorn main:app" 2>/dev/null; pkill -f "gateway run" 2>/dev/null; lsof -ti :19001 2>/dev/null | xargs -r kill
cp "$CFG.bak" "$CFG"
rm -f ~/.openclaw-dev/plugins/openclaw-memgpt/api-key
rm -f ~/.openclaw-dev/openclaw.json.rejected.* 2>/dev/null
mv /tmp/oc-sess-bak/*.jsonl ~/.openclaw-dev/agents/main/sessions/ 2>/dev/null
echo "restored"
```
