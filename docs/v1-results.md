# V1.4 — A≈C Equivalence Results and Verdict

The §7 validation gate: does the OpenClaw-MemGPT plugin (Cell C) preserve reference
MemGPT behaviour (Cell A) across the four §7.3 dimensions? This document records the
V1.4 verdict against the V1.3 90-trial slate plus a corrected, single-provider re-run of
the diagnostic probes, with the equivalence claim refined to what the evidence supports.

Companion artefacts: `experiments/v1-runs/analysis/v1_4_analysis.json` (the frozen
analysis), `…/provider_compare.py` (the #24 provider-equivalence check),
`…/wire_check_p2_direct/` (the #24 wire-format canary), `…/institutional_p5_jsonl/` +
`…/institutional_backup/` (the institutional data preserved across the provider switch),
`…/v1_4_borderline_classification.md`; `docs/methodology-bank.md` #18–#25.

---

## 0. Executive verdict — A≈C holds for the *memory architecture*; send_message is an I/O-layer divergence

**The plugin preserves MemGPT's memory architecture; as of V2.1 it also enforces MemGPT's
send_message I/O discipline plugin-side — fully on hosts ≤2026.6.8, display-layer for
tool-bearing turns on ≥2026.6.10 (replay-safety policy, characterised in methodology bank
#30).** The V1.4 verdict below stands as the pre-enforcement record: the layers are
different, and V1.4's central result is that the original four-dimension gate conflated
them.

- **Memory architecture — preserved (Sense 3, architectural).** Tier reasoning is faithful
  on every memory-compelling probe (p1 core, p3 multi-tier, p6 ambiguous→core all match
  Cell A), the **load-bearing cross-session recall property holds 10/10** (CARDINAL_3987
  recovered across the sidecar restart on every p5 trial), and archival insert/search and
  the §4.3 chain/yield structure reproduce. This is structurally guaranteed by the sidecar
  (`LocalStateManager` + `EmbeddingArchivalMemory`), not by prompting.
- **send_message discipline — diverges (preserved only at Sense 1, behavioural-under-coaching).**
  With the controlled-variable persona corrected to MemGPT-faithful §3 strings, Cell C
  replies in **free text** on simple-acknowledgment / bare-declarative probes instead of
  calling `send_message` (p6: 8/10 trials do `core_memory_append` then free-text; p4: 2/5).
  This is an **architectural gap in the I/O layer**, not a memory finding and not a
  measurement artefact (§4).
- **V2.1 update (2026-07-06) — I/O-layer Sense 3 recovered via plugin-side enforcement,
  host-version-scoped.** V2.1 implemented the missing suspenders + bouncer analogues
  (methodology bank #25 closure, #30): `reply_payload_sending` cancels free-text
  final/block payloads on the channel delivery path (assistant content is structurally
  monologue, as in native `handle_ai_response`), and `before_agent_finalize` re-prompts a
  turn that would finalize in free text without `send_message` (belt sentence verbatim as
  the corrective instruction, ≤3 attempts). Re-run on the V1.4 environment
  (openclaw@2026.6.8, Sonnet 4.5, uncoached §3 persona): **p6 discipline 10/10** (was
  2/10; tier reasoning 10/10 unchanged), p1 3/3, p4 5/5 post-rubric (raw 0.60; both flags
  adjudicated as the re-prompt duplication artefact) with #18-signature path agreement
  2/5 (was 0/5; Cell A 3/5); gateway arm: full disciplined chain on the dispatcher lane
  with 0 assistant free-text payloads. The recovery is **host-version-scoped**: from
  OpenClaw 2026.6.10 the embedded runtime's replay-safety tightening blocks same-turn
  re-prompt after any plugin-tool execution (bank #30), leaving display-layer suppression
  (channel deliveries) as the guarantee for tool-bearing turns on newer hosts.

The unified gate as numerically specified in V1.0 §5 **does not pass uniformly** (all four
dimension rates miss their thresholds). But the dimensions cluster cleanly into a
**memory-architecture group (passes)** and an **I/O-layer group (diverges)** — the gate
definition needs refinement to separate them (§5; V1.5).

**MINJA may proceed.** Its attack vectors target memory *contents* — which are preserved at
Sense 3 — so MINJA interpretability is unaffected by the send_message I/O-layer finding (§6).

---

## 1. What changed since the prior (qualified-pass) verdict

The earlier verdict rested on the V1.3 slate, which was confounded by **#23**: every Cell C
trial ran a **stale persona** carrying a non-canonical instruction — *"…always uses the
send_message tool to reply to users rather than responding with free text…"*. V1.4 corrects
this and completes the diagnostic probes on a single provider:

1. **Persona correction is MemGPT-faithful.** MemGPT's default personas
   (`memgpt/personas/examples/sam.txt`, `sam_pov.txt`) contain **no** send_message coaching;
   only the gpt-3.5 crutch variant does. The §3 neutral persona is therefore *more* faithful
   for a Sonnet-class model than the coached one. The driver now pins §3 persona/human on
   every run (`_apply_v1_overrides`), so the controlled variable cannot drift again.
2. **Provider switch (#24).** The institutional Bedrock budget was depleted mid-pilot; p4/p5/p6
   were completed on a personal Anthropic key via a direct `api.anthropic.com` chain (same
   model snapshot, `claude-sonnet-4-5-20250929`). Validated non-material three ways (§3).
3. **The correction unmasked the send_message divergence.** The stale coaching had been
   propping up send_message discipline (it held at ~0.99 in the confounded slate). Removing it
   revealed that the discipline is not architecturally enforced in Cell C (§4).

V1.4 slate: p1/p2/p3/p7 institutional (unchanged), **p4/p5/p6 fresh, corrected §3 persona,
direct chain**, analysed as one dataset (licensed by #24).

---

## 2. Per-dimension results (corrected slate, `v1_4_analysis.json`)

| Dimension | Rate | Threshold | Layer | Reading |
|---|---|---|---|---|
| send_message discipline | 0.856 | 1.00 | **I/O** | 13/90 misses: 1 Cell-A stochastic (`p2/a-3`) + 12 Cell-C free-text (p6 8, p4 3, p5 1). The §4 finding. |
| Tool invocation | 0.867 | ≥0.95 | mixed | p1/p2/p3/p6 = 1.00; misses localise to p4 (0.80) and p5 (0.60, recall-eagerness) |
| Memory-tier reasoning | 0.556 vs-expected | ≥0.80 | **memory** | p1 0.8, p3 1.0, p6 1.0 (compelling probes pass); p4 0.0 (I/O divergence, see #18); p5 0.0 vs the *expected* "recall" label but Cell A also chose `core` — cell-agreement is the right lens and the recall **property** holds 10/10 |
| Inner monologue (Jaccard) | 0.089 | ≥0.70 | metric | not scorable — lexical Jaccard fails cross-architecture even when behaviour is identical (#22) |

Read against the diagnosis, the failing mass is **(a) the I/O-layer send_message divergence
(p6, p4), (b) p5's recall-eagerness in tool counts, and (c) the broken monologue metric** —
not the memory architecture, which is faithful wherever a probe compels memory use.

---

## 3. Provider switch — #24 (non-material)

| Check | Evidence | Result |
|---|---|---|
| Wire-format canary | p2/PINEAPPLE_8101, direct vs institutional | Byte-structurally identical: `archival_memory_insert`+`send_message`, archival tier, same `arg_keys`, marker stored. Extractor parses direct-chain wire shape unchanged. |
| p5 provider-equivalence | inst 0–5 vs direct 0–5 (`provider_compare.py`) | **CARDINAL_3987 recovered 6/6 on both chains**; dominant-tier agreement 4/6 (2 stochastic flips ≈ within-provider variance) |
| p4 divergence | both chains | Same modes on both (free-text / archival / stock `exec`) → not a provider artefact |

Same model snapshot, only the gateway differs. Cell A (Bedrock) remains a valid reference for
direct-chain Cell C; the mixed-chain slate is sound. Full detail: methodology-bank #24.

---

## 4. The send_message finding — belt without suspenders or bouncer (#25)

On the corrected slate, Cell C reliably chooses the **right memory tier** but **delivers the
reply in free text** rather than via `send_message`. Representative (p6/t1):

```
core_memory_append   | "I'll remember that you typically work in the evening."   ← faithful tier
[]                   | "Updated! I've added your evening work preference…"       ← free text, no send_message
```

This is architectural, and source-confirmed in the fork. MemGPT enforces send_message at three
levels; Cell C inherits only the first:

| Layer | MemGPT mechanism (source) | In Cell C? |
|---|---|---|
| **Belt** (prompt) | base prompt: *"'send_message' is the ONLY action that sends a notification to the user, the user does not see anything else you do"* (`memgpt_base.txt:18-19`) | ✅ injected |
| **Suspenders** (rendering) | `handle_ai_response`: assistant `content` is **always** rendered as internal monologue (*"The content is then internal monologue, not chat"*); `send_message`→`send_ai_message`→`interface.assistant_message` is the *sole* user-facing path | ❌ OpenClaw renders `content` **as the reply** |
| **Bouncer** (verification) | `verify_first_message_correctness(require_send_message=True)` (`agent.py:526`) re-prompts if the first turn isn't a send_message call | ❌ absent |

Cell A's ~1.0 send_message discipline is **architecturally guaranteed** (there is no
free-text-to-user path), not model compliance. Cell C has the prompt instruction but OpenClaw
renders free-text `content` straight to the user, so a capable model — no longer nudged by the
non-canonical persona crutch — skips the now-redundant `send_message`. Restoring the coaching
would re-introduce a deviation from MemGPT-faithful prompting *and* not restore the
architectural guarantee. Disposition: a **bounded I/O-layer divergence**, fixable plugin-side
at the §4.3 `reply_dispatch` boundary (V1.5 optional Track 2).

### Three senses of preservation (V1.4 vocabulary)

- **Sense 1 — behavioural-under-coaching:** holds when the prompt explicitly elicits it.
- **Sense 2 — behavioural-by-default:** holds from the model's default behaviour given the
  faithful, uncoached prompt.
- **Sense 3 — architectural:** structurally guaranteed regardless of model behaviour.

MemGPT's **memory architecture** is preserved by the plugin at **Sense 3** (the sidecar
enforces tiering/recall/persistence). MemGPT's **send_message discipline** is preserved at
**Sense 1 only** (held under coaching) and fails at Sense 2/3. The original V1 measurement
conflated Sense 1 with Sense 3; V1.4 isolates them.

---

## 5. Aggregate gate — the V1.0 §5 definition needs refinement

The four-dimension unified gate **does not pass uniformly** (sm 0.856 / tools 0.867 / tier
0.556 / mono 0.089; gate conditions 1 and 2 fail). But this is a **gate-definition** problem,
not a single architectural failure: the four dimensions span two layers that should be scored
separately.

- **Memory-architecture cluster (tier reasoning on compelling probes; recall property; archival;
  chain/yield): passes.**
- **I/O-layer cluster (send_message delivery): diverges** — preserved at Sense 1, not Sense 3.
- **Monologue: not scorable** by the current metric (#22).

**V1.5 will refine V1.0 §5** to (a) separate the memory-architecture and I/O-layer dimension
clusters with distinct pass criteria, and (b) re-specify the monologue dimension on a semantic
measure. `docs/v1-cells.md` §5 carries a marker to this effect.

---

## 6. Probe-by-probe breakdown

- **p1 (core)** — tools 1.00, tier 0.80. Identity fact → `core_memory_append`. **Memory: pass.**
- **p2 (archival)** — tools 1.00, tier 0.40. Core-vs-archival stochastic margin on "store for
  later reference"; both defensible. The one send_message miss is Cell A's. **Acceptable variance.**
- **p3 (multi-tier chain)** — tools 1.00, tier 1.00, monologue 0.60 (only probe clearing it).
  `archival_memory_insert`→`archival_memory_search`→`send_message` reproduces. **Pass.**
- **p4 (cross-turn recall)** — tier 0.00, tools 0.80, send_message 0.70. **#18 REJECT** (Cell A
  matches own pattern 3/5; Cell C 0/5). Misses are free-text (2/5) and stock `read`/`write`/`exec`
  (1/5) on the bare-declarative turn-1 → the **#25 I/O-layer gap**, not a memory difference;
  turn-2 active-context recall matches Cell A on trials that reach it. Reproduces on both providers.
- **p5 (cross-session recall — load-bearing)** — **CARDINAL_3987 recovered 10/10 across the
  restart.** Tier converges to `core` (vs Cell A `core`); tools 0.60 from recall-eagerness
  (some trials add `conversation_search`/`archival`). **Recall property preserved (Sense 3).**
- **p6 (ambiguous tier — monologue control)** — tools 1.00, **tier 1.00** (10/10 `core`, matches
  Cell A exactly), send_message 0.60. The decisive control: identical memory behaviour, yet
  monologue Jaccard ≈0 (metric, #22) and send_message free-texts 8/10 (I/O, #25). **Memory: pass.**
- **p7 (degenerate "Hello.")** — tools 0.80, tier 0.80, send_message 1.00. **Restraint holds.**

---

## 7. Implications for the MINJA gate

The §7 gate exists to ensure attack-vector measurements run against an architecturally-faithful
*memory* substrate. The evidence supports that at Sense 3:

- **Cross-session recall (p5) is MemGPT-faithful** — the property MINJA's cross-session vector
  depends on (CARDINAL 10/10).
- **Tier routing, archival, and chain/yield reproduce** on every memory-compelling probe; the
  recall-probe tool divergence is recall-eagerness in counts, not a missing tier.
- **MINJA vectors target memory contents**, which are Sense-3-preserved. The send_message
  divergence is an I/O-layer delivery concern orthogonal to whether poisoned memory influences
  retrieval/behaviour. **MINJA interpretability is unaffected.**

**Debts carried into the write-up (do not block MINJA):**

1. **send_message enforcement** — optional V1.5 plugin work (#25 / §4.3) to recover Sense 3, if
   the dissertation framing wants behavioural send_message equivalence rather than the
   memory-architecture claim.
2. **Semantic monologue metric** — re-specify the monologue dimension (#22) before it can be
   scored pass/fail.

Neither blocks attack-vector work; both are measurement/engineering closures.

---

## Changelog

- 2026-06-18 — **V1.4 final verdict: A≈C holds for the memory architecture (Sense 3);
  send_message is a characterised I/O-layer divergence (Sense 1 only).** Written against the
  V1.3 slate (p1/p2/p3/p7 institutional) plus a corrected §3-persona, single-provider direct-chain
  re-run of p4/p5/p6 (5/10/10 trials). Rests on: #24 (provider switch non-material, three-way
  validated); #23 (persona confound confirmed + unmasked #25); #25 (send_message belt-without-
  suspenders/bouncer, source-confirmed in `handle_ai_response`/`verify_first_message_correctness`);
  #18 REJECT (p4 divergence real, re-attributed to the #25 I/O-layer gap, reproduced across
  providers); #22 (monologue metric not scorable, p6 control decisive). The V1.0 §5 unified gate
  is flagged for V1.5 refinement (separate memory-architecture vs I/O-layer clusters). Tag:
  `v1-equivalence-characterised`.
- 2026-06-17 — V1.4 interim verdict: A≈C qualified pass (confounded by #23; superseded by the
  2026-06-18 final above).
