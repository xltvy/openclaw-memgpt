# openclaw-memgpt

> OpenClaw plugin providing MemGPT's three-tier memory architecture for any OpenClaw agent.

## What it does

`openclaw-memgpt` gives an OpenClaw agent the memory architecture from [MemGPT](https://github.com/letta-ai/letta): three tiers the agent manages itself through tool calls.

- **Core memory** — a small, always-in-context block holding the agent's persona and what it knows about you. The agent edits it directly as facts change.
- **Recall memory** — the searchable history of your conversation, so the agent can look up what was said earlier even after it has scrolled out of context.
- **Archival memory** — an embedding-backed long-term store for facts the agent chooses to keep, retrievable by semantic search.

On top of the tiers the plugin provides **cross-session persistence** (memory survives restarts — the default in gateway mode, and supported in one-shot `--local` mode) and **conversation summarisation** (older turns are compacted into recall memory when context fills up, instead of being lost).

It is **provider-agnostic**: the memory sidecar talks to any OpenAI-compatible endpoint (OpenAI, Anthropic, a local LLM, LiteLLM/OpenRouter, etc.), configured once through the setup wizard.

Under the hood the plugin runs a small Python sidecar built on a maintained MemGPT fork, published to PyPI as [`openclaw-memgpt-sidecar`](https://pypi.org/project/openclaw-memgpt-sidecar/). The plugin spawns and manages that process for you.

## Requirements

- **OpenClaw ≥ 2026.5.31**
- **Python 3.11** (3.12 not yet supported) — for the memory sidecar
- **Node ≥ 20.12.0**
- **[`uv`](https://docs.astral.sh/uv/getting-started/installation/) on your `PATH`** — the plugin uses it to run the sidecar

## Installation

```bash
openclaw plugins install openclaw-memgpt
```

On first use the plugin notices it isn't configured yet and points you at the setup wizard. Run it any time to (re)configure:

```bash
openclaw memgpt setup
```

Optionally, warm the embedding-model cache ahead of time so your first agent turn isn't slowed by a one-time (~60 s) model download:

```bash
openclaw memgpt prewarm
```

To remove the plugin and its data:

```bash
openclaw memgpt uninstall
```

The interactive uninstall lets you **keep your memory data** or remove everything; `--keep-data`, `--force`, and `--dry-run` are also available.

## Quick start

```bash
# 1. Install the plugin
openclaw plugins install openclaw-memgpt

# 2. Configure it (provider, API key, model, …)
openclaw memgpt setup

# 3. (optional) Pre-download the embedding model so turn 1 is fast
openclaw memgpt prewarm

# 4. Talk to your agent — it now remembers across turns and sessions
openclaw agent --message "Hi, I'm working on a thesis due March 15. Remember that."
openclaw agent --message "When is my thesis due?"
# → the agent recalls "March 15" from memory
```

## Configuration

`openclaw memgpt setup` walks you through, in order:

1. **Provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint.
2. **Base URL** — only for the OpenAI-compatible option.
3. **API key** — paste it (stored in a private mode-`0600` file) or point the plugin at an **environment variable** you already have set (e.g `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Keys are never written into `openclaw.json`.
4. **Model** — the model the sidecar should use.
5. **Embedder** — the embedding model behind memory search. Either the **built-in** one (bge-small, runs in-process, one-time ~60 s download — the default) or any **OpenAI-compatible embedding endpoint** (Ollama, vLLM, LM Studio, LiteLLM). For the endpoint option the wizard asks for the endpoint URL and model name, then measures the embedding dimension with a live probe (falling back to a manual prompt if the endpoint isn't reachable yet).
6. **Observability** — `off` (default), `default`, or `verbose` (see below).
7. **Sidecar URL** — leave blank to let the plugin spawn and manage the sidecar itself; set it only if you run the sidecar yourself.

A few notes:

- **Conversation access.** Storing memory means reading the conversation, so the plugin needs OpenClaw's conversation-access permission. In gateway mode OpenClaw requires you to grant this explicitly; the setup wizard does it for you and tells you so.
- **Manual sidecar (advanced).** Set `OPENCLAW_MEMGPT_SIDECAR_URL` (or the `sidecarUrl` config field) to attach to a sidecar you started yourself instead of having the plugin spawn one.
- **Embedder by hand (advanced).** The wizard's embedder step maps to four config fields you can also set directly on the plugin entry: `embeddingProvider` (`"huggingface"` | `"openai-compatible"`), `embeddingModel`, `embeddingEndpointUrl`, and `embeddingDim`. For `openai-compatible`, `embeddingModel` and `embeddingDim` are required (`embeddingEndpointUrl` defaults to Ollama's `http://127.0.0.1:11434/v1`); the sidecar verifies `embeddingDim` against a live probe at startup and refuses to start on a mismatch. In attach mode, set the equivalent `OPENCLAW_MEMGPT_EMBEDDING_PROVIDER` / `_MODEL` / `_ENDPOINT_URL` / `_DIM` env vars on the sidecar you run yourself (provider in underscore form: `openai_compatible`).
- **Changing embedders on an existing profile.** Vectors already stored were embedded by the old model and are incompatible with the new one — memory search over them will misbehave. The sidecar rewrites its config and warns loudly at startup; clear the profile's `memgpt-data/agents` directory (or start a fresh namespace) after switching.
- **Flush ratio (advanced).** Conversation summarisation triggers when the buffer's estimated token count (measured by the plugin itself — never trusted from the provider's `usage` report) reaches `flushRatio` × the session's context-token budget. `flushRatio` defaults to `0.75` (MemGPT's own warning fraction) and can be set on the plugin config entry to any value in `(0, 1]`; when OpenClaw supplies no budget the trigger falls back to an absolute 6000-token threshold. Every evaluation is visible at debug log level. Note: a low ratio against a large context window makes summarisation fire often — each firing is an LLM call.

## Memory tools

The agent calls these tools itself; you don't invoke them directly.

| Tool | What it does |
|---|---|
| `core_memory_append` | Append to the contents of core memory. |
| `core_memory_replace` | Replace the contents of core memory. To delete memories, use an empty string for new content. |
| `archival_memory_insert` | Add to archival memory, phrased so it can be queried later. |
| `archival_memory_search` | Search archival memory using semantic (embedding-based) search. |
| `conversation_search` | Search prior conversation history using case-insensitive string matching. |
| `conversation_search_date` | Search prior conversation history using a date range. |
| `send_message` | Send a message to the user. |

## Observability

When enabled, the plugin writes a structured event log as JSON Lines to `<OpenClaw state dir>/memgpt-observability.jsonl` (e.g. `~/.openclaw/memgpt-observability.jsonl`). Three levels:

- **`off`** (default) — no events captured.
- **`default`** — one event per memory operation, **metadata only** (no message/query/result text):
  ```json
  {"kind":"archival_search","namespace":"my-agent","ts":"2026-06-23T02:27:40.833Z","meta":{"total":3,"page":0,"numPages":1}}
  ```

- **`verbose`** — the same events **plus the content** (queries, results, written text) for full provenance:
  ```json
  {"kind":"archival_search","namespace":"my-agent","ts":"2026-06-23T02:27:40.833Z","meta":{"total":3,"page":0,"numPages":1},"content":{"query":"when is my thesis due","results":["User's thesis is due March 15"]}}
  ```

The JSONL file is the authoritative record. You can also subscribe to events live from your own code:

```ts
import { memoryEvents, MEMORY_EVENT_CHANNEL } from "openclaw-memgpt";

memoryEvents.on(MEMORY_EVENT_CHANNEL, (e) => {
  console.log(e.kind, e.namespace, e.meta);
});
```

**Privacy.** Your API key is stored in a private file at `<OpenClaw state dir>/plugins/openclaw-memgpt/api-key` (mode `0600`, in a `0700` directory). At `verbose`, the observability log contains your conversation content. If you use backup or file-sync tools (Time Machine, iCloud Drive, dotfile managers), consider excluding both of these paths.

## Known behaviour

- **The agent replies through `send_message`, like native MemGPT.** As of 1.1.0 the plugin enforces MemGPT's I/O discipline structurally: a turn that would end in free-form text without a `send_message` call is re-prompted (up to 3 attempts, using MemGPT's own base-prompt wording), and on channel deliveries any remaining free-form assistant text is treated as inner monologue — suppressed from the chat and recorded in the observability log as `monologue_suppressed` events (with the text at `verbose`). Memory storage and recall are unaffected.
- **First-run cold start (~60 s, built-in embedder only).** The first time the built-in embedding model is needed it is downloaded and cached. Run `openclaw memgpt prewarm` (or accept the wizard's offer) to get this out of the way; every run after that is fast. With an OpenAI-compatible embedding endpoint there is no download and no cold start — but that server must be running before the agent starts.
- **One-shot `--local` mode.** Either run `openclaw memgpt prewarm` first, or accept the one-time cold-start cost on the first turn — it works normally afterwards.

### Host version compatibility

The send_message enforcement's re-prompt behaves differently across OpenClaw versions, because OpenClaw's replay-safety policy — which decides when a plugin may ask for another model pass — changed between releases:

- **OpenClaw ≤ 2026.6.8** — the re-prompt fires for turns that end in free-form text after a single memory-tool call (the common shape: one `core_memory_append`, then text). Turns with multiple tool calls in one message, or long sessions with accumulated tool activity, may still hit the host's replay-safety path and finalize without a re-prompt — models that batch several tool calls per turn (e.g. Claude Sonnet 4.6) encounter this more often.
- **OpenClaw ≥ 2026.6.10** — the replay-safety policy tightened further: the re-prompt fires only on turns that ran no tools at all. Any turn that executed a tool first cannot be re-prompted; the host treats plugin-tool execution as a potential side effect and declines the extra model pass.

The inner-monologue suppression on channel deliveries holds on all versions, as does everything about memory storage and recall.

This is a characterised property of the OpenClaw host, not a plugin defect — the same single-tool scenario produces a re-prompt on 2026.6.8 and a logged `requested revision after potential side effects` refusal on 2026.6.10, and the refusal line is the marker to look for in the host log when a re-prompt didn't fire. See `docs/v1-results.md` (V2.1 update) in the repository for the verification detail.

## Troubleshooting

- **"The agent doesn't remember things across sessions."** Check that your API key is correct — that the configured environment variable is set, or the stored key is valid. Memory operations silently no-op if the sidecar can't reach the LLM.
- **"My first turn times out (cold start)."** Run `openclaw memgpt prewarm` to download and cache the embedding model up front, or wait through the first ~60 s.
- **"Embedder cache appears unavailable."** Run `openclaw memgpt prewarm` to re-download the embedding model.

Common issues encountered when installing and running `openclaw-memgpt`, based on real setup experience.

---

### Plugin loads but MemGPT tools are not available to the agent

**Symptom:** The gateway logs show the plugin registering correctly —

```
openclaw-memgpt: 7 tools + before_prompt_build ... + ContextEngine + lifecycle service registered
```

— but the agent reports only file-based tools (`read`, `write`, `exec`, etc.) and denies having `core_memory_append`, `archival_memory_search`, etc.

**Cause:** The plugin's tools are blocked by OpenClaw's tool allowlist, or the memory slot is still set to `memory-core`.

**Fix:**

```bash
# Allow the plugin's tools explicitly
openclaw config set tools.alsoAllow '["core_memory_append","core_memory_replace","archival_memory_insert","archival_memory_search","conversation_search","conversation_search_date","send_message"]' --strict-json

# Ensure the memory slot points to this plugin
openclaw config set plugins.slots.memory "openclaw-memgpt"

# Silence the auto-load warning and lock in the plugin
openclaw config set plugins.allow '["openclaw-memgpt"]' --strict-json

openclaw gateway restart
```

Verify with:

```bash
openclaw agent --agent main --message "List every tool you have available right now."
```

---

### `openclaw memgpt setup` — Unknown command

**Symptom:**

```
[openclaw] Reason: Unknown command: openclaw memgpt. No built-in command or plugin CLI metadata owns "memgpt".
```

**Cause:** The plugin does not currently register a CLI command via `api.registerCli`. The `openclaw memgpt setup` wizard is not yet implemented.

**Fix:** Configure the plugin manually via `openclaw config set`:

```bash
openclaw config set plugins.entries.openclaw-memgpt.config.provider "anthropic"
openclaw config set plugins.entries.openclaw-memgpt.config.namespace "default"
openclaw config set plugins.entries.openclaw-memgpt.config.credential '{"source":"env","var":"ANTHROPIC_API_KEY"}' --strict-json
openclaw gateway restart
```

---

### Plugin is installed but disabled — `memory slot set to "memory-core"`

**Symptom:** `openclaw plugins inspect openclaw-memgpt --runtime --json` shows:

```json
"activated": false,
"activationReason": "memory slot set to \"memory-core\""
```

**Cause:** OpenClaw's memory slot is occupied by the default `memory-core` plugin. Memory is an exclusive slot — only one plugin can own it at a time.

**Fix:**

```bash
openclaw config set plugins.slots.memory "openclaw-memgpt"
openclaw gateway restart
```

---

### Sidecar not found / MemGPT tools registered but agent uses file-based memory anyway

**Symptom:** Tools appear in the agent's toolset but the agent reports it is using file-based memory, or core memory blocks are empty (`"The user."`).

**Cause:** The Python sidecar (`openclaw-memgpt-sidecar`) is not installed or not running.

**Fix:** Install the sidecar into a Python 3.11 environment (the package requires `>=3.11,<3.12`):

```bash
# If you use pyenv and are on Python 3.12+
pyenv install 3.11
~/.pyenv/versions/3.11.*/bin/python3 -m venv ~/.venvs/openclaw-memgpt-sidecar
source ~/.venvs/openclaw-memgpt-sidecar/bin/activate
pip install openclaw-memgpt-sidecar
```

If you want to run the sidecar manually and point the plugin to it:

```bash
# In a separate terminal, with the venv active
source ~/.venvs/openclaw-memgpt-sidecar/bin/activate
python -m openclaw_memgpt_sidecar  # note the port it binds to

# Then tell the plugin where to find it
openclaw config set plugins.entries.openclaw-memgpt.config.sidecarUrl "http://localhost:<port>"
openclaw gateway restart
```

> **Note for macOS users:** `pip show <package> --break-system-packages` is not a valid flag for `pip show`. Use plain `pip show <package>` to inspect installed packages.

---

### `openclaw memgpt` command unavailable after install

**Symptom:**

```
[openclaw] The `openclaw memgpt` command is unavailable
```

**Cause:** Either the plugin is not in `plugins.allow`, or the CLI descriptors are not registered. Check both:

```bash
openclaw config get plugins.allow
openclaw plugins inspect openclaw-memgpt --runtime --json | grep -E '"cliCommands"|"commands"'
```

**Fix:** Add the plugin to the allow list:

```bash
openclaw config set plugins.allow '["openclaw-memgpt"]' --strict-json
openclaw gateway restart
```

---

### No target session — missing `--agent` flag

**Symptom:**

```
Error: No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>.
```

**Cause:** `openclaw agent` requires an explicit agent target. There is no config key for a default agent ID — it is hardcoded as `main`.

**Fix:** Always pass `--agent main`:

```bash
openclaw agent --agent main --message "your message"
```

For convenience, add a shell alias to `~/.zshrc` or `~/.bashrc`:

```bash
alias oc='openclaw agent --agent main'
```

---

### How to disable file-based memory and use MemGPT exclusively

To ensure the agent only uses MemGPT tools and cannot fall back to file-based memory:

```bash
openclaw config set plugins.slots.memory "openclaw-memgpt"
openclaw config set agents.defaults.memorySearch.enabled false
openclaw config set agents.defaults.contextInjection "never"
openclaw gateway restart
```

> **Note:** `contextInjection: "never"` also disables injection of `SOUL.md`, `AGENTS.md`, and `USER.md`. If you want to keep persona files active but only disable memory file injection, check `agents.defaults.bootstrap` for finer-grained controls.

---

### How to verify the plugin is active in a session

```bash
# Check runtime activation status
openclaw plugins inspect openclaw-memgpt --runtime --json | grep -E '"activated"|"status"|"toolNames"'

# Check which plugin owns the memory slot
openclaw config get plugins.slots

# Ask the agent directly
openclaw agent --agent main --message "List every tool you have available right now."
```

The agent should list `core_memory_append`, `core_memory_replace`, `archival_memory_insert`, `archival_memory_search`, `conversation_search`, `conversation_search_date`, and `send_message` among its tools.

---

### How to start a fresh session

Use `--session-key` with a unique name:

```bash
openclaw agent --agent main --session-key test-1 --message "your message"
```

Each unique key starts an isolated session with no in-context history. Cross-session memory (core, recall, archival) still persists via the sidecar.

---

### Enable verbose observability for debugging

```bash
openclaw config set plugins.entries.openclaw-memgpt.config.observability "verbose"
openclaw gateway restart
```

The gateway logs will then emit per-turn memory events, sidecar interactions, and hook firing details, which makes it much easier to confirm the plugin is doing real work rather than falling back silently.

## License

[Apache-2.0](./LICENSE).

## Contributing

This is the first public release of `openclaw-memgpt`. Bug reports and feedback are very welcome — future versions will incorporate user reports and iterate on the plugin's design. Please open an issue on [GitHub](https://github.com/xltvy/openclaw-memgpt/issues).

## Acknowledgements

Built on the memory architecture from **MemGPT**, created by the [Letta](https://github.com/letta-ai/letta) team — full credit to the original authors. The plugin consumes a maintained MemGPT fork published as [`openclaw-memgpt-sidecar`](https://pypi.org/project/openclaw-memgpt-sidecar/).
