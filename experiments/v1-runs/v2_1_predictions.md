# V2.1 pre-registered predictions — send_message enforcement re-run

**Banked:** 2026-07-05, before any V2.1 probe execution (operator directive: measure
"predicted vs observed", not "did it work").
**Against:** plugin `feat/v2-sense3-recovery` (finalizeGuard bouncer + payloadGuard
suspenders; reply_dispatch retired), OpenClaw 2026.6.8 throwaway profile, V1.4 probe
methodology (`--local`, Cell C environment), V1.4 analyser unchanged.
**Mechanism basis:** INVESTIGATION_REPORT §2–§5 (SDK 2026.6.10 evidence) + the
2026.6.8 dist spot-check performed 2026-07-05 (scratchpad install; details below).

## Mechanism recap (what the enforcement can and cannot do)

- **Bouncer** (`before_agent_finalize` revise): fires when the turn would finalize with
  visible free text and no send_message fired. The runtime refuses revision after
  "potential side effects" — **and the definition is version-dependent**:
  - **2026.6.8 (the pinned probe version):** side effects = *completed mutating* tool
    calls (`completedMutatingAction`, selection dist:2502/2541). `isMutatingToolCall`
    returns **false** for every memory tool name (`core_memory_append` etc. — no
    "send" substring, no `message_` prefix, not in the mutating-name table;
    tool-mutation dist:232-255). **The chained memory-op → free-text turn IS
    re-promptable under 2026.6.8.** (`send_message` itself contains "send" and counts
    as mutating, but a turn with send_message is never revised anyway.)
  - **2026.6.10:** rule tightened to "any non-replay-safe tool executed"
    (`attemptedPotentialSideEffect`), and plugin tools are never replay-safe on the
    embedded harness → chained turns cannot be re-prompted there. This version
    dependence is itself a finding (upstream replay-safety tightening).
- **Suspenders** (`reply_payload_sending` cancel): gateway/channel delivery path only;
  does not fire in `--local`, the primary probe environment.
- V1.4 discipline metric (`trial_has_send_message_discipline`) counts whether the model
  *called* send_message — suppression alone cannot move it; only the bouncer's re-prompt
  can, and only where it is permitted to fire.
- Bouncer budget: 3 revisions/run (runtime hard cap; our maxAttempts matches).

## Predictions (for the pinned 2026.6.8 environment)

**P1 — p1 smoke (3 trials).** No regression. p1 turns that chain the memory op +
send_message keep passing (flag set → no revise, no behaviour change). Expected
discipline 3/3, tier choice unchanged (core).

**P2 — p6 (10 trials): discipline recovers toward 1.0.**
V1.4 signature: dominant failure was `core_memory_append` → free text (chained). Under
2026.6.8 the bouncer fires on BOTH the chained and the free-text-only failure modes:
- Predicted p6 discipline ≥ 0.9, target 1.0. The only residual failure mode is the
  model ignoring the corrective instruction three times in one run (exhausting the
  revision budget) — expected rare for Sonnet-class models given the instruction
  embeds the belt sentence it was trained on.
- Mechanism signature per recovered trial: `finalize_revision_requested` event followed
  by a `send_message` event in the same trial's JSONL; OpenClaw log line
  `before_agent_finalize requested one more pass`.
- p6 tier reasoning: stays 10/10 (enforcement touches the I/O layer only). A drop
  means the revise instruction is perturbing tier choice — regression.
- **Falsifier:** any trial logging `requested revision after potential side effects`
  would mean the 2026.6.8 mutating-action analysis is wrong — stop and re-investigate.

**P3 — p4 (5 trials, 2-turn): shift toward Cell A.**
- Free-text-bleed turns (either turn) → recovered by the bouncer (send_message called
  on the revised pass) → path agreement with Cell A improves from 0/5 toward ≥2/5.
- Turn-2 (active-context read, typically no memory tool before the reply): bouncer
  fires unimpeded — expect turn-2 free-text bleed to disappear entirely.
- Residual divergence, if any, should be *path-shape* (e.g. which tier is consulted),
  not delivery-channel — delivery failures should be eliminated.

**P4 — gateway supplementary arm (1–2 representative probes): display guarantee holds.**
Zero free-text assistant payloads reach gateway output; every suppressed payload
appears as a `monologue_suppressed` event in the observability JSONL (verbose ⇒ with
text). This holds for chained turns too — the guarantee is display-layer, independent
of the replay-safety ceiling.

**P5 — revision-visible signatures.** Where the bouncer fires, the observability JSONL
shows `finalize_revision_requested` followed (same trial) by a `send_message` event;
OpenClaw logs `before_agent_finalize requested one more pass`. Where the guard refuses,
OpenClaw logs `before_agent_finalize requested revision after potential side effects` —
these log lines are the per-trial mechanism attribution.

**P6 — no memory-architecture regression.** Cross-session recall (CARDINAL_3987-style),
core append/replace, archival insert/search, conversation search (string + date),
flush-pressure summarisation: all unchanged (enforcement hooks sit on the reply path;
306-test suite + new integration test green before runs).

## Falsifiable expectations summary

| Metric | V1.4 (pre) | Predicted (post, 2026.6.8) |
|---|---|---|
| p1 discipline | pass | 3/3 (no change) |
| p6 discipline | 0.6 | ≥0.9, target 1.0; residual failures only via revision-budget exhaustion |
| p6 tier reasoning | 10/10 | 10/10 (regression check) |
| p4 path agreement w/ Cell A | 0/5 | ≥2/5; turn-2 free-text bleed eliminated |
| Gateway free-text bleed | n/a (not measured) | 0 |
| `requested revision after potential side effects` in logs | n/a | 0 occurrences (falsifier for the 2026.6.8 analysis) |
