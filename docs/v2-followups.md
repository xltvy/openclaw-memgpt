# V2 follow-ups

Items surfaced during the Phase 6c.9 vertical slice that are out of scope for V1
acceptance but should be addressed before broader release or any second-user
adoption. Order is by independence (no implementation dependencies between
items), not priority.

`CLAUDE.md` carries a compressed one-liner per item plus a pointer here. This
file is the full record.

---

## 1. Config validation

`config.ts` currently uses `stringWithDefault` for all four string fields so the
plugin installs without a config block (necessary in 6c.9.0). Unknown keys are
detected, but obviously-broken values (empty `namespace`, malformed
`sidecarUrl`, missing `persona`/`human` in a real run) are silently defaulted.

**V2 work.** Split "permits silent default" (boot-time, current) from "rejects
at first real use" (run-time, new). On the first `ensure` call, log a warning
and require non-empty `namespace`; refuse to proceed if `persona`/`human` are
the empty defaults in a non-test run. Avoid hard-failing at `register()` —
that breaks the lifecycle escape hatch (the plugin must load so its lifecycle
hooks fire even when config is incomplete).

## 2. Build pipeline

`npm run build` is `tsc --noEmit` (type-check only). OpenClaw's jiti runner
reads `.ts` directly so this is sufficient for plugin-loading inside OpenClaw,
but there's no compiled artifact, no source map, no bundling for downstream
consumers that expect conventional CommonJS / ESM.

**V2 work.** Add a real `tsc` emit and a `dist/` layout, or pick a bundler
(esbuild for build speed; rollup for cleaner output; tsup for the typical
plugin shape). Pre-requirement for npm publishing.

## 3. Package whitelist

`package.json` has no `"files"` field. `npm pack` would include `tests/`,
fixture directories, the editable fork dep path, working-copy state, and other
files that shouldn't ship.

**V2 work.** Explicit `"files"` whitelist: `dist/`, `openclaw.plugin.json`,
`README.md`, `LICENSE`. Hard pre-requirement for publishing — currently a
publish would leak local paths and the editable-install relative path to the
fork.

## 4. Exclusive slot

The plugin claims OpenClaw's exclusive `memory` slot, displacing `memory-core`
and `memory-lancedb`. This is by design for the MemGPT memory architecture
(the prompt section assumes MemGPT's tier model and its specific tool
vocabulary), but it means users can't combine our memory with a second memory
plugin for non-MemGPT corpora.

**V2 work.** Investigate whether the slot can be made non-exclusive when our
plugin is scoped to a specific `agentId`, allowing coexistence with
`memory-core` on other agents in the same OpenClaw instance. Requires
understanding OpenClaw's per-agent plugin scoping (whether the exclusive-slot
rule is global or per-agent).

## 5. Multimodal

`flattenContent()` in `normalise.ts` silently drops non-text content parts
(images, files) — only `{type:"text",text:string}` blocks survive. For
multimodal agents, image references vanish from the recall mirror, so a
subsequent `conversation_search` for "the image you showed me" finds nothing.

**V2 work.** Two paths to consider: (a) preserve a placeholder reference
(`<image: <url-or-hash>>`) in the flattened text so the agent can reason about
what was there; (b) document the loss explicitly and refuse `messagesAppend`
when non-text content is present (fail loud rather than silent drop). Path (a)
preserves multimodal experiments; path (b) is safer for fidelity claims.

## 6. Upstream fix (OpenClaw)

`send_message` is not in OpenClaw's `CORE_MESSAGING_TOOLS`
(`["sessions_send","message"]`, `attempt.tool-run-context--CUdbb6u.js:27`), so
the runtime doesn't count it as a "messaging tool" and
`hadDeterministicSideEffect` stays false. The downstream effect is
`livenessState:"abandoned"` on every successful `send_message` turn — the
6c.9.3 / 6c.9.4 CLI artefact that contaminates any harness reading the `--json`
success field.

**V2 work.** File an OpenClaw issue/PR adding either (a) `send_message` to the
core set, or (b) a per-plugin `registerMessagingTool(name)` API the plugin can
call at `register()` time. Either eliminates the artefact at the source rather
than working around it downstream. (b) is the more general fix and matches
OpenClaw's plugin model better; (a) is narrower but probably faster to merge.

## 7. Namespace contamination

When `namespace` in `openclaw.json` changes mid-conversation, the new
namespace's first `agent_end` mirror ingests OpenClaw's session buffer (which
still contains messages from the previous namespace's turns) into the new
namespace's recall log. Documented as a 6c.9.3 side finding; affects any
researcher who edits `openclaw.json` between sessions without also rotating
`--session-id`.

**V2 work.** Detect namespace change at `before_prompt_build` (compare against
a stamped `agent_id` in `SessionEntry`'s plugin metadata) and either trigger
a `:save` + agent swap, or refuse to mirror until a fresh session begins.
Eliminates a silent provenance corruption that would confound any
per-namespace ISR/ASR measurement.
