"""V2.1 analysis — before/after comparison for the send_message enforcement re-run.

Reuses v1_4_analyse's extraction/scoring primitives. Loads:
  - Cell A: the V1.4 artefacts (unchanged reference; `p<N>/cell-a-*.json`),
  - Cell C "pre": the V1.4 Cell C artefacts (same dirs),
  - Cell C "post": the V2.1 re-run artefacts under `v2_1/p<N>/`.

Only the re-run probes are analysed (p1x3 smoke, p4x5, p6x10 per the V2.1
brief); pre-slate counts follow the V1.4 matrix. Mechanism attribution is
read from the per-trial OpenClaw logs (`cell-c-<t>.log` carries stderr):
`requested one more pass` = bouncer honored; `requested revision after
potential side effects` = replay-safety refusal (the pre-registered 2026.6.8
falsifier — expected zero).

Output: v2_1/analysis-summary.json + a printed markdown table for the
methodology bank / v1-results update.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

import v1_4_analyse as v14

HERE = Path(__file__).parent
V14_ROOT = HERE
V21_ROOT = HERE / "v2_1"

# Probe -> V2.1 trial count (brief §"Probes to run").
RERUN_COUNTS = {"p1": 3, "p4": 5, "p6": 10}

HONOR_RE = re.compile(r"before_agent_finalize requested one more pass")
REFUSE_RE = re.compile(
    r"before_agent_finalize requested revision after potential side effects"
)


def load_cell(root: Path, probe: str, cell: str, count: int) -> list[v14.TrialRecord]:
    out = []
    for tid in range(count):
        p = root / probe / f"cell-{cell.lower()}-{tid}.json"
        if not p.exists():
            raise SystemExit(f"missing {p}")
        out.append(v14.load_trial(p))
    return out


def discipline_rate(trials: list[v14.TrialRecord]) -> tuple[float, list[str]]:
    fails = []
    for t in trials:
        ok, reason = v14.trial_has_send_message_discipline(t)
        if not ok:
            fails.append(f"t{t.trial_id}: {reason}")
    n = len(trials)
    return (n - len(fails)) / n if n else 0.0, fails


def log_mechanism(probe: str, count: int) -> dict:
    honored = refused = 0
    per_trial = {}
    for tid in range(count):
        log = V21_ROOT / probe / f"cell-c-{tid}.log"
        text = log.read_text(errors="replace") if log.exists() else ""
        h = len(HONOR_RE.findall(text))
        r = len(REFUSE_RE.findall(text))
        honored += h
        refused += r
        if h or r:
            per_trial[f"t{tid}"] = {"honored": h, "refused": r}
    return {"honored_total": honored, "refused_total": refused, "per_trial": per_trial}


def main() -> int:
    summary: dict = {"probes": {}}
    for probe, n_post in RERUN_COUNTS.items():
        n_v14 = v14.PROBE_TRIAL_COUNTS[probe]
        a_trials = load_cell(V14_ROOT, probe, "A", n_v14)
        c_pre = load_cell(V14_ROOT, probe, "C", n_v14)
        c_post = load_cell(V21_ROOT, probe, "C", n_post)

        a_rate, a_fails = discipline_rate(a_trials)
        pre_rate, pre_fails = discipline_rate(c_pre)
        post_rate, post_fails = discipline_rate(c_post)

        entry: dict = {
            "discipline": {
                "A": {"rate": a_rate, "fails": a_fails, "n": n_v14},
                "C_pre": {"rate": pre_rate, "fails": pre_fails, "n": n_v14},
                "C_post": {"rate": post_rate, "fails": post_fails, "n": n_post},
            },
            "mechanism": log_mechanism(probe, n_post),
        }

        if probe == "p6":
            entry["tier_post"] = Counter(v14.dominant_tier(t) for t in c_post)
            entry["tier_pre"] = Counter(v14.dominant_tier(t) for t in c_pre)
        if probe == "p4":
            entry["p4_patterns_pre"] = v14.p4_single_tool_pattern_check(
                {"A": a_trials, "C": c_pre}
            )
            entry["p4_patterns_post"] = v14.p4_single_tool_pattern_check(
                {"A": a_trials, "C": c_post}
            )

        summary["probes"][probe] = entry

    out = V21_ROOT / "analysis-summary.json"
    out.write_text(json.dumps(summary, indent=2, default=str))

    print("# V2.1 before/after — send_message discipline\n")
    print("| probe | A | C pre (V1.4) | C post (V2.1) | bouncer honored | refusals |")
    print("|---|---|---|---|---|---|")
    for probe, e in summary["probes"].items():
        d = e["discipline"]
        m = e["mechanism"]
        print(
            f"| {probe} | {d['A']['rate']:.2f} (n={d['A']['n']})"
            f" | {d['C_pre']['rate']:.2f} (n={d['C_pre']['n']})"
            f" | {d['C_post']['rate']:.2f} (n={d['C_post']['n']})"
            f" | {m['honored_total']} | {m['refused_total']} |"
        )
    for probe, e in summary["probes"].items():
        if e["discipline"]["C_post"]["fails"]:
            print(f"\n{probe} post failures: {e['discipline']['C_post']['fails']}")
    p6 = summary["probes"].get("p6", {})
    if "tier_post" in p6:
        print(f"\np6 tier (pre):  {dict(p6['tier_pre'])}")
        print(f"p6 tier (post): {dict(p6['tier_post'])}")
    p4 = summary["probes"].get("p4", {})
    if "p4_patterns_post" in p4:
        pre = p4["p4_patterns_pre"]
        post = p4["p4_patterns_post"]
        print(f"\np4 #18-signature counts — A: {pre['a_methodology_18_matches']}"
              f" | C pre: {pre['c_methodology_18_matches']}"
              f" | C post: {post['c_methodology_18_matches']}")
        print(f"p4 C post per-trial patterns: {post['c_per_trial_patterns']}")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
