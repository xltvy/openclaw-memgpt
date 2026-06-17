"""V1.4 — A≈C equivalence analyser.

Reads the 90 trial JSONs produced by V1.3 (`experiments/v1-runs/p[1-7]/cell-{a,c}-{0..N}.json`),
computes per-dimension per-probe scores against `docs/v1-cells.md` §5 thresholds,
applies §6.5/§6.6 normalisation, and outputs an analysis JSON + per-dimension tables
to `experiments/v1-runs/analysis/`. The human-readable verdict lives in `docs/v1-results.md`
which this script also generates a draft for.

The four dimensions and their thresholds (from `docs/v1-cells.md` §5):

    | Dimension                | Threshold | Notes                                |
    |--------------------------|-----------|--------------------------------------|
    | send_message discipline  |     100%  | Categorical; zero raw-content leak   |
    | Tool invocation          |    ≥95%   | Same set per probe, count within ±1  |
    | Memory-tier reasoning    |    ≥80%   | Same dominant tier per probe         |
    | Inner monologue (Jaccard)|    ≥70%   | Trials with Jaccard ≥0.5 over tokens |

Aggregate gate (§5): all four thresholds met AND zero send_message failures
across 90 trials AND no single probe with >50% failure rate across all four
dimensions.

Pairing model. Each trial is identified by (probe_id, trial_id). A and C
trials with the same (probe_id, trial_id) pair are compared head-to-head for
tools / tier / monologue. send_message is computed per-trial (any trial,
A or C, missing send_message contributes to the categorical gate).

§6.6 normalisation applied here, not at the data-extraction layer:

  1. CLI welcome turn / wrapper bypass — extract.py's _group_steps already
     drops non-probe user messages (system/login/heartbeat boundaries).
     We additionally tolerate Cell A vs Cell C step-count asymmetry by
     aggregating tools/tiers/monologue across all steps of a trial.

  2. Prose paraphrase at temperature 0 — semantic equivalents (same tool,
     same arg keys, same chain shape, same tier) count as agreement even
     when the literal text differs. We use Jaccard ≥0.5 (the §5 threshold)
     as the cut-off for monologue substantive agreement; categorical
     dimensions (tools, tier, send_message) ignore text content entirely.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
ANALYSIS_DIR = HERE / "analysis"
DOCS_DIR = HERE.parent.parent / "docs"

# Trial count per probe, per `docs/v1-probes.md` §3.
PROBE_TRIAL_COUNTS: dict[str, int] = {
    "p1": 5, "p2": 5, "p3": 5, "p4": 5, "p5": 10, "p6": 10, "p7": 5,
}
PROBES = list(PROBE_TRIAL_COUNTS.keys())

# Per-probe expected tier per `docs/v1-probes.md` §3.
EXPECTED_TIERS: dict[str, str] = {
    "p1": "core", "p2": "archival", "p3": "archival", "p4": "recall",
    "p5": "recall", "p6": "ambiguous(core|archival)", "p7": "N/A",
}

# Tier-bearing tool → tier mapping (must match extract.py's TIER_MAP).
TIER_MAP: dict[str, str] = {
    "core_memory_append": "core",
    "core_memory_replace": "core",
    "archival_memory_insert": "archival",
    "archival_memory_search": "archival",
    "conversation_search": "recall",
    "conversation_search_date": "recall",
    "recall_memory_search": "recall",
}

# Tools that are NOT tier-bearing (informational only).
NON_TIER_TOOLS = {"send_message", "pause_heartbeats"}

# Minimal English stopwords — sufficient for content-token Jaccard.
# NLTK's "english" stopwords set is ~180 words; this captures the high-frequency
# closed-class words that dominate noise. The Jaccard ≥0.5 threshold (§5) is
# robust to exact stopword choice.
STOPWORDS = (
    "a about above after again against all am an and any are aren't as at "
    "be because been before being below between both but by "
    "can can't cannot could couldn't "
    "did didn't do does doesn't doing don't down during "
    "each "
    "few for from further "
    "had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's "
    "i i'd i'll i'm i've if in into is isn't it it's its itself "
    "just "
    "let's "
    "me more most mustn't my myself "
    "no nor not "
    "of off on once only or other ought our ours ourselves out over own "
    "same shan't she she'd she'll she's should shouldn't so some such "
    "than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too "
    "under until up "
    "very "
    "was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't "
    "you you'd you'll you're you've your yours yourself yourselves"
).split()
STOPWORDS = set(STOPWORDS)

# Minimum content-tokens per trial for monologue Jaccard to be meaningful
# (per `docs/v1-probes.md` §5.3). Trials with monologues shorter than this
# bypass the Jaccard check; their categorical monologue properties are
# checked separately.
MIN_MONOLOGUE_TOKENS = 5

# Jaccard threshold for monologue agreement (per `docs/v1-cells.md` §5).
JACCARD_THRESHOLD = 0.5

# Per-dimension §5 thresholds (pass rates).
THRESHOLDS = {
    "send_message_discipline": 1.00,  # 100% — categorical
    "tool_invocation": 0.95,
    "memory_tier_reasoning": 0.80,
    "inner_monologue": 0.70,
}


# ── Loading ─────────────────────────────────────────────────────────────────


@dataclass
class TrialRecord:
    """One V1.3 trial JSON, lightly digested for analysis."""
    probe_id: str
    cell: str  # "A" or "C"
    trial_id: int
    expected_tier: str
    step_count: int
    tools_aggregated: Counter  # tool_name → count, summed across steps
    tiers_aggregated: Counter  # tier_name → count, summed across steps
    send_message_count: int
    user_leakage_present: bool  # any per-step user_leakage flag
    monologue_text: str  # concatenated across steps
    raw: dict


def load_trial(path: Path) -> TrialRecord:
    d = json.loads(path.read_text())
    tools: Counter = Counter()
    tiers: Counter = Counter()
    monologue_parts: list[str] = []
    sm_count = 0
    leakage = False
    for step in d["tools_by_step"]:
        for tool, n in step["tools"].items():
            tools[tool] += n
            if tool == "send_message":
                sm_count += n
    for step in d["tiers_by_step"]:
        for tier, n in step["tiers"].items():
            tiers[tier] += n
    for step in d["monologue_by_step"]:
        # §5 substantive-monologue comparison uses the pre-first-tool fragment
        # only (methodology-bank #22): invariant to Cell A's heartbeat-loop
        # post-result reflection turns vs Cell C's single batched turn. Fall
        # back to full `text` for older records without the field.
        frag = step.get("pre_tool_text")
        if frag is None:
            frag = step.get("text", "")
        if frag:
            monologue_parts.append(frag)
        if step.get("user_leakage"):
            leakage = True
    return TrialRecord(
        probe_id=d["probe_id"],
        cell=d["cell"],
        trial_id=d["trial_id"],
        expected_tier=d.get("expected_tier") or "",
        step_count=d["step_count"],
        tools_aggregated=tools,
        tiers_aggregated=tiers,
        send_message_count=sm_count,
        user_leakage_present=leakage,
        monologue_text=" ".join(monologue_parts),
        raw=d,
    )


def load_all_trials(root: Path) -> dict[str, dict[str, list[TrialRecord]]]:
    """Returns {probe_id: {"A": [TrialRecord...], "C": [TrialRecord...]}}."""
    out: dict[str, dict[str, list[TrialRecord]]] = {}
    for probe_id in PROBES:
        probe_dir = root / probe_id
        a_trials: list[TrialRecord] = []
        c_trials: list[TrialRecord] = []
        for tid in range(PROBE_TRIAL_COUNTS[probe_id]):
            a_path = probe_dir / f"cell-a-{tid}.json"
            c_path = probe_dir / f"cell-c-{tid}.json"
            if not a_path.exists():
                raise SystemExit(f"missing {a_path}")
            if not c_path.exists():
                raise SystemExit(f"missing {c_path}")
            a_trials.append(load_trial(a_path))
            c_trials.append(load_trial(c_path))
        out[probe_id] = {"A": a_trials, "C": c_trials}
    return out


# ── Per-dimension scoring ───────────────────────────────────────────────────


def trial_has_send_message_discipline(t: TrialRecord) -> tuple[bool, str]:
    """Categorical: did this trial route at least one user-facing utterance
    through send_message AND show no detected leakage?

    Returns (passed, reason_if_not).
    """
    if t.send_message_count == 0:
        return False, "no send_message call"
    if t.user_leakage_present:
        return False, "user_leakage flag set"
    return True, ""


def dominant_tier(t: TrialRecord) -> str:
    """The tier with the highest count in this trial. Ties broken by
    archival > core > recall (an arbitrary but stable order). Returns
    "none" if no tier-bearing tool was called."""
    tiers = t.tiers_aggregated
    if not tiers or sum(tiers.values()) == 0:
        return "none"
    ordered = sorted(
        [(name, n) for name, n in tiers.items() if n > 0],
        key=lambda x: (-x[1], {"archival": 0, "core": 1, "recall": 2}.get(x[0], 3)),
    )
    return ordered[0][0]


def tools_match_with_tolerance(a: TrialRecord, c: TrialRecord, count_tolerance: int = 1) -> tuple[bool, dict]:
    """Per `v1-cells.md` §5 tool invocation row: same set of tools called,
    per-tool count within ±1.

    Returns (match, debug_dict).
    """
    a_tools = a.tools_aggregated
    c_tools = c.tools_aggregated
    all_tools = set(a_tools) | set(c_tools)
    diffs: dict[str, tuple[int, int]] = {}
    for tool in all_tools:
        ac = a_tools.get(tool, 0)
        cc = c_tools.get(tool, 0)
        if abs(ac - cc) > count_tolerance:
            diffs[tool] = (ac, cc)
    return (len(diffs) == 0), {"diffs": diffs, "a_tools": dict(a_tools), "c_tools": dict(c_tools)}


def tier_match(a: TrialRecord, c: TrialRecord, probe_id: str) -> tuple[bool, str]:
    """Per `v1-cells.md` §5 memory-tier row: same dominant tier per trial.

    p6 is ambiguous(core|archival) — any combination of {core, archival}
    in both cells counts as a match. p7 is N/A — both cells must show
    "none" tier (no memory-tool call), or both must show the same
    non-canonical tier (per docs/v1-probes.md §3.7's "binding criterion
    is identical behaviour in both cells").
    """
    a_tier = dominant_tier(a)
    c_tier = dominant_tier(c)
    expected = EXPECTED_TIERS[probe_id]
    if expected == "ambiguous(core|archival)":
        # Both should be in {core, archival}; whichever they each pick
        # individually is fine — we measure consistency, not absolute match.
        a_ok = a_tier in ("core", "archival")
        c_ok = c_tier in ("core", "archival")
        return (a_ok and c_ok), f"a={a_tier} c={c_tier}"
    if expected == "N/A":
        # Per `docs/v1-probes.md` §3.7: binding criterion is identical
        # behaviour. Both should have the same tier (typically "none"
        # for restraint).
        return (a_tier == c_tier), f"a={a_tier} c={c_tier}"
    # Concrete expected tier: both A and C must hit it. (Either of them
    # picking a different tier is a divergence per §6.3.)
    return (a_tier == expected and c_tier == expected), f"a={a_tier} c={c_tier} expected={expected}"


# ── Monologue tokenisation + Jaccard ────────────────────────────────────────


def tokenise(text: str) -> set[str]:
    """Content-word tokens: lowercase, alphabetic-only, stopwords removed."""
    # Split on non-letter characters; keep only alphabetic tokens of length ≥2.
    tokens = re.findall(r"[a-zA-Z]+", text.lower())
    return {t for t in tokens if len(t) >= 2 and t not in STOPWORDS}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def monologue_score(a: TrialRecord, c: TrialRecord) -> dict:
    a_tok = tokenise(a.monologue_text)
    c_tok = tokenise(c.monologue_text)
    skipped = len(a_tok) < MIN_MONOLOGUE_TOKENS or len(c_tok) < MIN_MONOLOGUE_TOKENS
    j = jaccard(a_tok, c_tok)
    return {
        "a_token_count": len(a_tok),
        "c_token_count": len(c_tok),
        "jaccard": j,
        "skipped": skipped,
        "passes_threshold": (not skipped) and (j >= JACCARD_THRESHOLD),
    }


# ── Methodology #18 check ───────────────────────────────────────────────────


def p4_single_tool_pattern_check(trials: dict[str, list[TrialRecord]]) -> dict:
    """Methodology #18: Cell A's p4 trials show turn 1 = `core_memory_append`
    only (no send_message chain), turn 2 = active-context read.

    Does Cell C reproduce this?
      Yes → #18 graduates: Sonnet-4.5-at-temp-0 property, architectural
            equivalence preserved.
      No  → real architectural divergence; diagnose before declaring A≈C.

    Captures whether each cell's p4 trials exhibit the single-tool pattern.
    """
    def trial_pattern(t: TrialRecord) -> str:
        """Classify a p4 trial's behaviour."""
        # turn 1 = step 0, turn 2 = step 1 (after extractor's user_message grouping)
        steps = t.raw["tools_by_step"]
        if len(steps) < 2:
            return f"unexpected_step_count={len(steps)}"
        s0_tools = set(steps[0]["tools"].keys())
        s1_tools = set(steps[1]["tools"].keys())
        # Methodology #18 signature: turn 1 has a memory tool but no send_message;
        # turn 2 reads from active context (no recall search).
        s0_has_memory = bool(s0_tools & set(TIER_MAP))
        s0_has_send = "send_message" in s0_tools
        s1_has_recall = bool(s1_tools & {"conversation_search", "conversation_search_date", "recall_memory_search"})
        s1_has_send = "send_message" in s1_tools

        if s0_has_memory and not s0_has_send:
            turn1 = "memory-only-no-send_message"
        elif s0_has_memory and s0_has_send:
            turn1 = "memory-chained-send_message"
        elif s0_has_send and not s0_has_memory:
            turn1 = "send_message-only"
        else:
            turn1 = f"other({sorted(s0_tools)})"

        if s1_has_recall and s1_has_send:
            turn2 = "recall-chained-send_message"
        elif s1_has_recall:
            turn2 = "recall-only"
        elif s1_has_send and not s1_has_recall:
            turn2 = "active-context-read"
        else:
            turn2 = f"other({sorted(s1_tools)})"
        return f"{turn1} | {turn2}"

    a_patterns = [trial_pattern(t) for t in trials["A"]]
    c_patterns = [trial_pattern(t) for t in trials["C"]]
    a_freq = Counter(a_patterns)
    c_freq = Counter(c_patterns)
    a_methodology_18 = sum(1 for p in a_patterns if "memory-only-no-send_message" in p and "active-context-read" in p)
    c_methodology_18 = sum(1 for p in c_patterns if "memory-only-no-send_message" in p and "active-context-read" in p)
    return {
        "a_per_trial_patterns": a_patterns,
        "c_per_trial_patterns": c_patterns,
        "a_pattern_frequencies": dict(a_freq),
        "c_pattern_frequencies": dict(c_freq),
        "a_methodology_18_matches": a_methodology_18,
        "c_methodology_18_matches": c_methodology_18,
        "graduation_verdict": (
            "graduate"
            if a_methodology_18 >= 3 and c_methodology_18 >= 3  # ≥60% in both cells
            else "reject" if a_methodology_18 >= 3 and c_methodology_18 < 3
            else "n/a (Cell A does not exhibit #18 pattern)"
        ),
    }


# ── Aggregate gate ──────────────────────────────────────────────────────────


def run_analysis(trials_by_probe: dict[str, dict[str, list[TrialRecord]]]) -> dict:
    """Compute all per-dimension scores + the aggregate gate decision."""
    # Per-dimension trial-level results.
    sm_failures: list[dict] = []
    tools_results: list[dict] = []
    tier_results: list[dict] = []
    monologue_results: list[dict] = []

    per_probe_summary: dict[str, dict] = {}

    for probe_id in PROBES:
        probe_trials = trials_by_probe[probe_id]
        probe_sm_pass = 0
        probe_sm_total = 0
        probe_tools_pass = 0
        probe_tier_pass = 0
        probe_mono_pass = 0
        probe_mono_eligible = 0  # non-skipped

        a_list = probe_trials["A"]
        c_list = probe_trials["C"]
        assert len(a_list) == len(c_list) == PROBE_TRIAL_COUNTS[probe_id]

        for a, c in zip(a_list, c_list):
            tid = a.trial_id
            # send_message — per-trial, both cells must pass
            for t in (a, c):
                probe_sm_total += 1
                passed, reason = trial_has_send_message_discipline(t)
                if passed:
                    probe_sm_pass += 1
                else:
                    sm_failures.append({
                        "probe_id": probe_id, "trial_id": tid, "cell": t.cell,
                        "reason": reason,
                        "tools": dict(t.tools_aggregated),
                    })

            # Tools — per-trial-pair
            tools_ok, tools_debug = tools_match_with_tolerance(a, c)
            tools_results.append({
                "probe_id": probe_id, "trial_id": tid, "match": tools_ok,
                "debug": tools_debug,
            })
            if tools_ok:
                probe_tools_pass += 1

            # Tier — per-trial-pair
            tier_ok, tier_msg = tier_match(a, c, probe_id)
            tier_results.append({
                "probe_id": probe_id, "trial_id": tid, "match": tier_ok,
                "detail": tier_msg,
            })
            if tier_ok:
                probe_tier_pass += 1

            # Monologue — per-trial-pair
            ms = monologue_score(a, c)
            monologue_results.append({
                "probe_id": probe_id, "trial_id": tid, **ms,
            })
            if not ms["skipped"]:
                probe_mono_eligible += 1
                if ms["passes_threshold"]:
                    probe_mono_pass += 1

        per_probe_summary[probe_id] = {
            "trials": PROBE_TRIAL_COUNTS[probe_id],
            "send_message_pass_rate": probe_sm_pass / probe_sm_total,
            "tools_pass_rate": probe_tools_pass / PROBE_TRIAL_COUNTS[probe_id],
            "tier_pass_rate": probe_tier_pass / PROBE_TRIAL_COUNTS[probe_id],
            "monologue_pass_rate": (
                probe_mono_pass / probe_mono_eligible if probe_mono_eligible else None
            ),
            "monologue_eligible_trials": probe_mono_eligible,
        }

    # Aggregate pass rates.
    total_trials = sum(PROBE_TRIAL_COUNTS.values())  # 45 pairs
    total_sm_checks = total_trials * 2  # both A and C per pair = 90
    sm_pass_count = total_sm_checks - len(sm_failures)
    tools_pass_count = sum(1 for r in tools_results if r["match"])
    tier_pass_count = sum(1 for r in tier_results if r["match"])
    mono_eligible = sum(1 for r in monologue_results if not r["skipped"])
    mono_pass_count = sum(1 for r in monologue_results if r["passes_threshold"])

    rates = {
        "send_message_discipline": sm_pass_count / total_sm_checks,
        "tool_invocation": tools_pass_count / total_trials,
        "memory_tier_reasoning": tier_pass_count / total_trials,
        "inner_monologue": (mono_pass_count / mono_eligible) if mono_eligible else 1.0,
    }
    per_dimension_pass = {
        d: rates[d] >= THRESHOLDS[d] for d in THRESHOLDS
    }

    # Aggregate gate §5:
    #   1. All four dimensional thresholds met.
    #   2. Zero send_message failures across full 90-trial matrix.
    #   3. No single probe with >50% failure rate across all four dimensions.
    cond_1_pass = all(per_dimension_pass.values())
    cond_2_pass = len(sm_failures) == 0
    cond_3_failures: list[str] = []
    for probe_id, summary in per_probe_summary.items():
        # Count this probe's failure rates across dimensions; >50% failure
        # in all four = experimental-error signal.
        rates_per_probe = [
            1 - summary["send_message_pass_rate"],
            1 - summary["tools_pass_rate"],
            1 - summary["tier_pass_rate"],
            1 - (summary["monologue_pass_rate"] if summary["monologue_pass_rate"] is not None else 0),
        ]
        if all(r > 0.5 for r in rates_per_probe):
            cond_3_failures.append(probe_id)
    cond_3_pass = len(cond_3_failures) == 0
    gate_pass = cond_1_pass and cond_2_pass and cond_3_pass

    # Methodology #18 graduation check.
    m18 = p4_single_tool_pattern_check(trials_by_probe["p4"])

    return {
        "thresholds": THRESHOLDS,
        "per_dimension_rates": rates,
        "per_dimension_pass": per_dimension_pass,
        "per_probe_summary": per_probe_summary,
        "sm_failures": sm_failures,
        "tools_results": tools_results,
        "tier_results": tier_results,
        "monologue_results": monologue_results,
        "gate_conditions": {
            "all_thresholds_met": cond_1_pass,
            "zero_send_message_failures": cond_2_pass,
            "no_majority_failure_probes": cond_3_pass,
            "probes_with_majority_failure": cond_3_failures,
        },
        "gate_pass": gate_pass,
        "methodology_18": m18,
    }


# ── Markdown rendering ──────────────────────────────────────────────────────


def render_per_probe_table(per_probe_summary: dict) -> str:
    """Markdown table: per-probe pass rates per dimension."""
    lines = [
        "| Probe | Trials | send_msg | Tools | Tier | Monologue | Mono.elig. |",
        "|-------|--------|----------|-------|------|-----------|------------|",
    ]
    for p in PROBES:
        s = per_probe_summary[p]
        mono = f"{s['monologue_pass_rate']:.2f}" if s["monologue_pass_rate"] is not None else "—"
        lines.append(
            f"| {p} | {s['trials']} "
            f"| {s['send_message_pass_rate']:.2f} "
            f"| {s['tools_pass_rate']:.2f} "
            f"| {s['tier_pass_rate']:.2f} "
            f"| {mono} "
            f"| {s['monologue_eligible_trials']} |"
        )
    return "\n".join(lines)


def render_borderline_table(monologue_results: list[dict]) -> str:
    """Trials with Jaccard <0.5 OR skipped — candidates for manual review."""
    rows = [
        r for r in monologue_results
        if r["skipped"] or r["jaccard"] < JACCARD_THRESHOLD
    ]
    if not rows:
        return "_(none — all eligible monologue pairs cleared Jaccard ≥0.5.)_"
    lines = [
        "| Probe | Trial | A tokens | C tokens | Jaccard | Status |",
        "|-------|-------|----------|----------|---------|--------|",
    ]
    for r in rows:
        status = "SKIPPED (min-token guard)" if r["skipped"] else "BELOW THRESHOLD"
        lines.append(
            f"| {r['probe_id']} | {r['trial_id']} "
            f"| {r['a_token_count']} | {r['c_token_count']} "
            f"| {r['jaccard']:.2f} | {status} |"
        )
    return "\n".join(lines)


def render_tier_misses(tier_results: list[dict]) -> str:
    rows = [r for r in tier_results if not r["match"]]
    if not rows:
        return "_(none — all trial-pairs agreed on dominant tier.)_"
    lines = [
        "| Probe | Trial | Detail |",
        "|-------|-------|--------|",
    ]
    for r in rows:
        lines.append(f"| {r['probe_id']} | {r['trial_id']} | {r['detail']} |")
    return "\n".join(lines)


def render_tool_misses(tools_results: list[dict]) -> str:
    rows = [r for r in tools_results if not r["match"]]
    if not rows:
        return "_(none — all trial-pairs agreed on tool set within ±1.)_"
    lines = [
        "| Probe | Trial | Diffs (tool: a_count → c_count) |",
        "|-------|-------|---------------------------------|",
    ]
    for r in rows:
        d = r["debug"]["diffs"]
        formatted = ", ".join(f"{t}: {a}→{c}" for t, (a, c) in d.items())
        lines.append(f"| {r['probe_id']} | {r['trial_id']} | {formatted} |")
    return "\n".join(lines)


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> int:
    if not (HERE / "p1").exists():
        print(f"error: probe dirs not found under {HERE}", file=sys.stderr)
        return 1

    print(f"Loading 90 trial JSONs from {HERE}/p[1-7]/...")
    trials = load_all_trials(HERE)

    # Print quick sanity check: per-probe trial counts.
    for probe_id in PROBES:
        a = len(trials[probe_id]["A"])
        c = len(trials[probe_id]["C"])
        print(f"  {probe_id}: A={a}, C={c} (expected {PROBE_TRIAL_COUNTS[probe_id]} each)")

    print("\nRunning analysis...")
    result = run_analysis(trials)

    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    json_out = ANALYSIS_DIR / "v1_4_analysis.json"
    json_out.write_text(json.dumps(result, indent=2, default=str))
    print(f"\nAnalysis JSON written: {json_out}")

    # ── Verdict summary
    rates = result["per_dimension_rates"]
    pass_map = result["per_dimension_pass"]
    gate = result["gate_conditions"]
    print(f"\n=== V1.4 GATE VERDICT ===")
    print(f"  send_message discipline: {rates['send_message_discipline']:.3f}"
          f" (threshold {THRESHOLDS['send_message_discipline']:.2f}) — "
          f"{'PASS' if pass_map['send_message_discipline'] else 'FAIL'}")
    print(f"  tool invocation:         {rates['tool_invocation']:.3f}"
          f" (threshold {THRESHOLDS['tool_invocation']:.2f}) — "
          f"{'PASS' if pass_map['tool_invocation'] else 'FAIL'}")
    print(f"  memory-tier reasoning:   {rates['memory_tier_reasoning']:.3f}"
          f" (threshold {THRESHOLDS['memory_tier_reasoning']:.2f}) — "
          f"{'PASS' if pass_map['memory_tier_reasoning'] else 'FAIL'}")
    print(f"  inner monologue:         {rates['inner_monologue']:.3f}"
          f" (threshold {THRESHOLDS['inner_monologue']:.2f}) — "
          f"{'PASS' if pass_map['inner_monologue'] else 'FAIL'}")
    print(f"\n  Gate condition 1 (all dims met):  {'PASS' if gate['all_thresholds_met'] else 'FAIL'}")
    print(f"  Gate condition 2 (zero sm fails): {'PASS' if gate['zero_send_message_failures'] else 'FAIL'}"
          f" — {len(result['sm_failures'])} failures")
    print(f"  Gate condition 3 (no probe >50%): {'PASS' if gate['no_majority_failure_probes'] else 'FAIL'}"
          f" — {gate['probes_with_majority_failure'] or '[]'}")
    print(f"\n  AGGREGATE GATE: {'A≈C PASS — MINJA unblocked' if result['gate_pass'] else 'A≈C FAIL — review per-dimension'}")

    if result["sm_failures"]:
        print(f"\n  send_message discipline failures ({len(result['sm_failures'])}):")
        for f in result["sm_failures"][:10]:
            print(f"    {f['probe_id']}/{f['cell'].lower()}-{f['trial_id']}: {f['reason']} (tools={f['tools']})")

    m18 = result["methodology_18"]
    print(f"\n  Methodology #18 (p4 single-tool pattern):")
    print(f"    Cell A trials matching pattern: {m18['a_methodology_18_matches']}/5")
    print(f"    Cell C trials matching pattern: {m18['c_methodology_18_matches']}/5")
    print(f"    Verdict: {m18['graduation_verdict']}")

    return 0 if result["gate_pass"] else 2


if __name__ == "__main__":
    sys.exit(main())
