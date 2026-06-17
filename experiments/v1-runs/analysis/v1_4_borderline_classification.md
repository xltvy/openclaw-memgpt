# V1.4 — Borderline / miss classification log (post-fix)

Companion to `v1_4_analysis.json`. Classifies every sub-threshold result as one
of: **true divergence** / **declared deviation** / **acceptable variance** /
**measurement artefact** / **experimental error (controlled-variable violation)**.
Per `docs/v1-cells.md` §6, only true divergences count as gate failures.

**Bottom line.** The V1.4 gate fails, but the comparison is **confounded by a
controlled-variable violation** (`methodology-bank.md` #23): the Cell C slate ran
a different persona/human than Cell A. Two extractor artefacts were also found
and fixed (#21 multi-turn duplication, #22 monologue structure). No clean A≈C
verdict can be issued against this slate; the Cell C slate must be re-run with the
§3 persona/human before the equivalence question can be answered. `docs/v1-results.md`
is intentionally **not** written.

---

## Timeline of the V1.4 analysis

1. **Raw run** (artefact-laden): send_message 0.989, tools 0.689, tier 0.556,
   monologue 0.067. Gate FAIL.
2. **Fix #21** (Cell C digests re-derived from JSONL — the pickle duplicated
   replayed turns on p4/p5). Tools 0.689 → **0.867**; only p4/p5 changed;
   single-turn probes byte-identical.
3. **Fix #22** (monologue scored on the pre-first-tool fragment). Monologue
   0.067 → **0.089** — barely moved.
4. **Diagnosis of the residual** surfaced **#23**: Cell C's persona/human ≠
   Cell A's, uniform across all 7 probes.

Post-fix per-dimension (still confounded by #23):

| Dimension | Rate | Threshold | Note |
|---|---|---|---|
| send_message discipline | 0.989 | 1.00 | 1 miss, Cell A side (`p2/a-3`) |
| Tool invocation | 0.867 | 0.95 | misses localise to p4 (0.20), p5 (0.90), p7 (0.80) |
| Memory-tier reasoning | 0.556 vs-expected / **0.667 cell-agreement** | 0.80 | misses localise to p4 (0/5), p5 (4/10), p2 (3/5) |
| Inner monologue (Jaccard, pre-tool) | 0.089 | 0.70 | cross-prompt paraphrase; see #22/#23 |

---

## Experimental error — #23 (the dominant blocker)

Cell A ran the §3 controlled persona (*"Sam is a friendly AI assistant with an
extensive knowledge base."*) / human (*"The user is a researcher exploring AI
memory architectures."*). Cell C ran, from a stale `~/.openclaw-dev/openclaw.json`,
a different persona (*"…knowledgeable… concise, thoughtful, always uses the
send_message tool…"*) and human (*"…studying… how MemGPT-style three-tier memory
can be integrated…"*). `driver.py` sets no persona/human, so the slate inherited
the stale config.

**Class: experimental error (controlled-variable violation, §3 / §6.5 step 2).**
Confounds (a) the monologue dimension (different prompt → different register and
length, so even aligned pre-tool fragments are cross-prompt paraphrases) and (b)
plausibly the p4/p5 recall-tier divergence (Cell C's human string foregrounds
"three-tier memory … recall," priming explicit `conversation_search` where Cell A
reads from context). **Not countable as architectural divergence while it stands.**

---

## Per-dimension classification (post-fix)

### send_message discipline — PASS in substance (0.989)
The single miss is `p2/cell-A/trial-3`: the *reference* emitted
`core_memory_append` with no chained `send_message` (temp-0 stochastic miss; cf.
#15). Zero Cell C leakage. **Acceptable variance (Cell A side).** Not a Cell C defect.

### Tool invocation — 0.867 (was 0.689)
- p1/p2/p3/p6 = 1.00; p7 = 0.80 (one p7 trial Cell C issued `conversation_search ×3`
  on "Hello." — over-eager recall, candidate minor divergence or persona-primed).
- p4 = 0.20, p5 = 0.90: the recall probes. After #21 dedup, counts are honest;
  the residual mismatch is the **real** tier-strategy difference (Cell C reaches
  for recall/archival search; Cell A reads core/context) — **confounded by #23**.

### Memory-tier reasoning — 0.667 cell-agreement (analyser reports 0.556 vs-expected)
Per-probe agreement (a_tier == c_tier): p1 4/5, p2 3/5, p3 5/5, p4 0/5, p5 4/10,
p6 10/10, p7 4/5.
- p1/p3/p6 strong → core/archival/ambiguous tiers reproduce cleanly.
- p2 3/5 → core-vs-archival stochastic margin (**acceptable variance**, §5).
- p4 0/5, p5 4/10 → **candidate true divergence, but confounded by #23.** Cannot
  be classified as architectural until the persona/human is corrected.
- **Measurement note:** the analyser's `tier_match` scores concrete-expected
  probes (p1–p5) against the *expected* tier, not against cell-agreement. The
  equivalence question is A-vs-C agreement; agreement gives 0.667 vs 0.556
  vs-expected. This semantics gap is documented but not silently changed —
  flagged for the verdict step.

### Inner monologue — 0.089 (was 0.067)
Structural inflation removed by #22 (fragments now length-comparable, none
skipped), but only 4/45 pairs clear Jaccard ≥0.5. **Measurement artefact +
experimental error:** lexical Jaccard is too strict for cross-architecture
paraphrase, and the gap is dominated by #23 (different prompt). Needs a semantic
measure or rubric, applied after the #23 re-run. **Not a true divergence.**

---

## Methodology #18 — held (not graduated, not cleanly rejected)
Clean p4 data: Cell A 3/5 exhibit "memory-only-no-send_message | active-context-read";
Cell C 0/5 (all chain send_message and search recall). Computes as **reject**, but
Cell C's recall eagerness is plausibly a #23 persona/human artefact. **Hold #18 at
"reject pending the #23-corrected re-run."**

---

## Aggregate gate
FAIL as computed, but **uninterpretable as A≠C** while #23 stands. Condition 3
(no probe >50% across all four dims) passes; conditions 1 and 2 fail, dominated by
the confound and a Cell-A-side stochastic send_message miss.

## Disposition (supervisor decision required)
Re-run the Cell C slate with the §3 persona/human (`openclaw.json` edit + 90-trial
re-drive — an LLM re-run, not offline re-extraction), then re-apply V1.4 with the
#21/#22 fixes in place and a semantic monologue measure. Only then is the A≈C
question answerable. The #21/#22 extractor fixes are correct and retained.
