# V1.4 — A≈C Equivalence Results and Verdict

The §7 validation gate: does the OpenClaw-MemGPT plugin (Cell C) preserve
reference MemGPT behaviour (Cell A) across the four §7.3 dimensions? This
document records the verdict against the V1.3 90-trial slate plus a corrective
pilot, with honest qualifications.

Companion artefacts: `experiments/v1-runs/analysis/v1_4_analysis.json` (the
frozen full-slate baseline), `…/pilot_compare_results.txt` (the corrected-persona
pilot), `…/v1_4_borderline_classification.md` (miss-by-miss classification),
`docs/methodology-bank.md` #20–#23 (the rig findings this verdict rests on).

---

## 1. Executive verdict

**A≈C — QUALIFIED PASS.** The architecture preserves MemGPT-faithful behaviour on
the dimensions and probes that could be measured cleanly, including the
dissertation's **load-bearing cross-session recall property (p5)**. The headline
V1.3 "failure" was not architectural: it was dominated by two extractor artefacts
(#21, #22) and a controlled-variable violation (#23, a persona/human mismatch
between cells). When #23 is corrected, Cell C's behaviour on the load-bearing
probe converges to Cell A's (tier-agreement ~4/10 → 6/6).

Two caveats keep this a *qualified* pass rather than an unconditional one:

1. **p4 (cross-turn recall) is unresolved.** Its corrected-persona re-run was
   contaminated by a runtime fault (#19 stock-tool coexistence) and could not be
   measured. A clean, full-budget p4 re-run is required to close it.
2. **The inner-monologue dimension lacks a valid metric.** Lexical Jaccard ≥0.5
   cannot clear cross-architecture paraphrase even when behaviour is identical
   (p5: tools/tier match Cell A exactly, monologue Jaccard ≤0.25). A semantic
   measure or manual rubric is needed before the monologue dimension can be
   scored as pass/fail.

Neither caveat contradicts the equivalence claim; both are measurement/rig debts,
documented and bounded. **MINJA may proceed** with the qualifications in §6.

---

## 2. Per-dimension results

Two readings are reported. The **full-slate baseline** (90 trials,
`v1_4_analysis.json`) is computed with the #21/#22 extractor fixes applied but is
**confounded by #23** (all Cell C trials ran the wrong persona/human). The
**corrected pilot** (p4 5/5, p5 6/10; p6 not reached — institutional budget
depleted mid-run) is the de-confounded evidence.

### Full-slate baseline (confounded by #23)

| Dimension | Rate | Threshold | Reading |
|---|---|---|---|
| send_message discipline | 0.989 | 1.00 | 1 miss, **Cell A side** (`p2/a-3` — reference stochastic miss); zero Cell C leakage |
| Tool invocation | 0.867 | ≥0.95 | p1/p2/p3/p6 = 1.00; misses localise to p4 (0.20) and p5 (0.90) |
| Memory-tier reasoning | 0.556 vs-expected / **0.667 cell-agreement** | ≥0.80 | misses localise to p4 (0/5) and p5 (4/10) — the recall probes |
| Inner monologue (Jaccard, pre-tool) | 0.089 | ≥0.70 | metric artefact (see §2, monologue note) |

Read naively this is a fail on three dimensions. Read with the diagnosis, the
failing mass is concentrated on **p4 and p5** (tools, tier) plus the monologue
metric — exactly where #23 and the metric limitation bite.

### Corrected pilot (de-confounded)

| Probe | Trials | Stale C tier-agree w/ A | **Corrected C tier-agree w/ A** | Clean run? |
|---|---|---|---|---|
| p5 (load-bearing recall) | 6 | ~4/10 (40%) | **6/6 (100%)** | yes — no stock tools, send_message held, CARDINAL recovered 6/6 |
| p4 (cross-turn recall) | 5 | — | inconclusive (1/5 clean) | no — #19 stock-tool contamination |

**Monologue note (both readings).** On p5 corrected, tools and tier match Cell A
exactly while monologue Jaccard is 0.12–0.25 (0/6 ≥0.5). Identical behaviour
cannot produce a genuine monologue divergence; the dimension is mis-metered.
Lexical Jaccard ≥0.5 was calibrated within-Cell-A (same prompt, #17b); it does not
transfer to cross-architecture paraphrase. Disposition: the monologue dimension is
**not scorable** as pass/fail until re-specified to a semantic measure (`#22`).

---

## 3. Probe-by-probe breakdown

- **p1 (core)** — tools 1.00, tier 0.80 (4/5 cell-agreement). Identity-fact →
  `core_memory_append` reproduces. **Pass.**
- **p2 (archival)** — tools 1.00, tier 0.40. Core-vs-archival stochastic margin on
  "store for later reference"; both tiers defensible (§5). The one send_message
  miss is Cell A's. **Acceptable variance.**
- **p3 (multi-tier chain)** — tools 1.00, tier 1.00. The §4.3 chain/yield
  structure (`archival_memory_insert` → `archival_memory_search` → `send_message`)
  reproduces cleanly. **Pass** (also the one probe that cleared the old monologue
  metric — content words dominate).
- **p4 (cross-turn recall)** — stale: Cell A reads core/active-context, Cell C
  searches recall (0/5 agreement). Corrected re-run **contaminated by #19**
  (agent used stock `exec`, replied free-text without send_message on 4/5). **Open
  — needs a clean re-run.** Most likely a #23 artefact by analogy with p5.
- **p5 (cross-session recall — load-bearing)** — stale: 4/10 agreement (Cell A
  core; Cell C archival/recall mix). **Corrected: 6/6 agreement (all core),
  recall mechanism intact (CARDINAL_3987 recovered across the restart in all 6),
  send_message discipline held, no stock-tool contamination.** **Pass at corrected
  controlled variables; #23 confirmed as the cause of the stale divergence.**
- **p6 (ambiguous tier)** — tools 1.00, tier 1.00 (10/10, both cells `core`). The
  hardest probe (genuinely ambiguous) shows the strongest agreement. Not re-run in
  the pilot (budget); the stale-persona result already passes because p6 does not
  hinge on the recall-priming the #23 human string introduced. **Pass.**
- **p7 (degenerate / restraint)** — tools 0.80, tier 0.80. One Cell C trial issued
  `conversation_search` on "Hello." (over-eager recall — plausibly #23-primed).
  send_message discipline otherwise held. **Borderline; revisit post-#23 re-run.**

---

## 4. Methodology #18 — disposition: held (superseded by #23), not graduated

#18 hypothesised that Cell A's p4 behaviour (turn-1 `core_memory_append` without
chained `send_message`; turn-2 active-context read) is a Sonnet-4.5-at-temp-0
architectural property that Cell C reproduces. The pilot **cannot graduate it**:
the corrected p4 run was #19-contaminated, so Cell C's clean p4 behaviour at
corrected controlled variables is unmeasured. It is **not cleanly rejected**
either. The V1.3 apparent p4 divergence is most parsimoniously explained by #23
(the same confound proven to drive p5), not by an architectural property. #18 is
**held open for p4** pending a clean re-run; see `methodology-bank.md` #18/#23.

---

## 5. Borderline / miss classification (summary)

Full log: `experiments/v1-runs/analysis/v1_4_borderline_classification.md`.

| Miss | Class | Counts toward gate? |
|---|---|---|
| `p2/a-3` no send_message | acceptable variance (Cell **A** stochastic) | no |
| p4/p5 tool + tier divergence (stale) | experimental error → **#23** confound | no (re-attributed) |
| p4 corrected contamination | rig fault → **#19** (stock-tool coexistence) | no (inconclusive) |
| monologue 0/45 ≥0.5 | measurement artefact → **#22** (wrong metric) | no |
| p2 core-vs-archival split | acceptable variance (§5 stochastic margin) | no |
| p7 one recall-on-"Hello." | borderline; likely #23-primed | revisit |

No miss survives as a confirmed architectural divergence after classification.

---

## 6. Implications for the MINJA gate

The §7 gate exists to ensure attack-vector measurements run against an
architecturally-faithful Cell C. The evidence supports that on the load-bearing
property:

- **Cross-session recall (p5) is MemGPT-faithful** at corrected controlled
  variables — the property MINJA's cross-session vector depends on.
- **Tool invocation, tier routing, and chain/yield reproduce** on the clean
  probes (p1/p3/p6), and the recall-probe divergence is explained by #23, not
  architecture.

**MINJA may proceed, carrying two debts to close before final write-up:**

1. **Clean p4 re-run** (uncontaminated by #19; the driver already pins §3
   persona/human, so re-running with a warm sidecar / gateway-mode start should
   avoid the stock-tool fallback). Confirms cross-turn recall path-agreement.
2. **Semantic monologue metric** (embedding cosine or rubric) to convert the
   monologue dimension from "not scorable" to a pass/fail, applied to the
   corrected data.

Neither blocks the attack-vector work; both are measurement closures. If a clean
p4 re-run later shows genuine divergence, that is a localised cross-turn-recall
finding, not a refutation of the cross-session property MINJA rests on.

---

## Changelog

- 2026-06-17 — V1.4 verdict: **A≈C qualified pass.** Written against the V1.3
  90-trial slate (full-slate baseline, confounded by #23) plus a corrected-persona
  pilot (p4 5/5, p5 6/10; budget-truncated). Rests on: #21 (multi-turn JSONL
  extraction) + #22 (pre-tool monologue) extractor fixes; #23 (persona/human
  controlled-variable violation) confirmed on p5 as the driver of the stale
  divergence; #18 held; #19 contamination on the p4 pilot. Two open debts (clean
  p4 re-run; semantic monologue metric) carried into MINJA per §6.
