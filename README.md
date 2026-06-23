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
5. **Observability** — `off` (default), `default`, or `verbose` (see below).
6. **Sidecar URL** — leave blank to let the plugin spawn and manage the sidecar itself; set it only if you run the sidecar yourself.

A few notes:

- **Conversation access.** Storing memory means reading the conversation, so the plugin needs OpenClaw's conversation-access permission. In gateway mode OpenClaw requires you to grant this explicitly; the setup wizard does it for you and tells you so.
- **Manual sidecar (advanced).** Set `OPENCLAW_MEMGPT_SIDECAR_URL` (or the `sidecarUrl` config field) to attach to a sidecar you started yourself instead of having the plugin spawn one.

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

- **The agent replies to you conversationally.** Unlike MemGPT's reference CLI, which forces every reply through a `send_message` tool call, this plugin lets the agent answer in free-form text. This is purely a user-experience choice and does not affect how memory is stored or recalled.
- **First-run cold start (~60 s).** The first time the embedding model is needed it is downloaded and cached. Run `openclaw memgpt prewarm` (or accept the wizard's offer) to get this out of the way; every run after that is fast.
- **One-shot `--local` mode.** Either run `openclaw memgpt prewarm` first, or accept the one-time cold-start cost on the first turn — it works normally afterwards.

## Troubleshooting

- **"The agent doesn't remember things across sessions."** Check that your API key is correct — that the configured environment variable is set, or the stored key is valid. Memory operations silently no-op if the sidecar can't reach the LLM.
- **"My first turn times out (cold start)."** Run `openclaw memgpt prewarm` to download and cache the embedding model up front, or wait through the first ~60 s.
- **"Embedder cache appears unavailable."** Run `openclaw memgpt prewarm` to re-download the embedding model.

## License

[Apache-2.0](./LICENSE).

## Contributing

This is the first public release of `openclaw-memgpt`. Bug reports and feedback are very welcome — future versions will incorporate user reports and iterate on the plugin's design. Please open an issue on [GitHub](https://github.com/xltvy/openclaw-memgpt/issues).

## Acknowledgements

Built on the memory architecture from **MemGPT**, created by the [Letta](https://github.com/letta-ai/letta) team — full credit to the original authors. The plugin consumes a maintained MemGPT fork published as [`openclaw-memgpt-sidecar`](https://pypi.org/project/openclaw-memgpt-sidecar/).
