"""#23 pilot comparison — corrected-persona Cell C vs stale Cell C vs Cell A.

Pilot slate (institutional budget depleted mid-run):
  p4: trials 0-4 corrected (§3 persona)        [5/5]
  p5: trials 0-5 corrected; 6-9 still stale     [6/10]
  p6: not re-run (stale only)

Three sources per (probe, trial):
  C_corr : corrected Cell C, projected from the fresh per-trial JSONL (#21 fix)
  C_stale: the committed stale-persona Cell C (git eb0dd04)
  A      : Cell A (disk == git; unchanged reference)

Axis 1 — did persona correction change Cell C?  (C_corr vs C_stale)
Axis 2 — does corrected Cell C match Cell A?     (C_corr vs A)
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import reextract_cell_c as R  # noqa: E402 (installs openai shim, PROBES, paths)
from extract import extract_v14_record_from_jsonl  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
STALE_REF = "eb0dd04"

# corrected trial ranges actually collected
CORR = {"p4": range(5), "p5": range(6)}

TIER_MAP = {
    "core_memory_append": "core", "core_memory_replace": "core",
    "archival_memory_insert": "archival", "archival_memory_search": "archival",
    "conversation_search": "recall", "conversation_search_date": "recall",
    "recall_memory_search": "recall",
}
STOP = set("a an the i you it to of and is in that this my your for be on was with as are have has".split())


def dominant_tier(tools_by_step) -> str:
    c = Counter()
    for s in tools_by_step:
        for name, n in s["tools"].items():
            t = TIER_MAP.get(name)
            if t:
                c[t] += n
    if not c:
        return "none"
    return sorted(c.items(), key=lambda x: (-x[1], {"archival": 0, "core": 1, "recall": 2}[x[0]]))[0][0]


def toolset(tools_by_step) -> dict:
    c = Counter()
    for s in tools_by_step:
        for name, n in s["tools"].items():
            c[name] += n
    return dict(c)


def toks(rec) -> set:
    parts = []
    for s in rec["monologue_by_step"]:
        parts.append(s.get("pre_tool_text") or s.get("text", ""))
    import re
    w = re.findall(r"[a-zA-Z]+", " ".join(parts).lower())
    return {t for t in w if len(t) >= 2 and t not in STOP}


def jacc(a, b):
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def corrected_C(probe_id, tid):
    _, exp, xs = R.PROBES[probe_id]
    paths = R.jsonl_paths_for(probe_id, tid, xs)
    return extract_v14_record_from_jsonl([str(p) for p in paths], "C", probe_id, tid, exp)


def stale_C(probe_id, tid):
    out = subprocess.run(["git", "show", f"{STALE_REF}:experiments/v1-runs/{probe_id}/cell-c-{tid}.json"],
                         cwd=HERE.parent.parent, capture_output=True, text=True)
    return json.loads(out.stdout)


def cell_A(probe_id, tid):
    return json.loads((HERE / probe_id / f"cell-a-{tid}.json").read_text())


def main():
    summary = {}
    for probe_id, rng in CORR.items():
        print(f"\n===== {probe_id} (corrected trials {list(rng)}) =====")
        tier_match_A = 0
        tier_changed = 0
        jac_pass = 0
        for tid in rng:
            cc, cs, a = corrected_C(probe_id, tid), stale_C(probe_id, tid), cell_A(probe_id, tid)
            tcc, tcs, ta = dominant_tier(cc["tools_by_step"]), dominant_tier(cs["tools_by_step"]), dominant_tier(a["tools_by_step"])
            j = jacc(toks(cc), toks(a))
            if tcc == ta:
                tier_match_A += 1
            if tcc != tcs:
                tier_changed += 1
            if j >= 0.5:
                jac_pass += 1
            print(f" t{tid}: tier  A={ta:8} C_stale={tcs:8} C_corr={tcc:8}"
                  f"  | match_A={tcc==ta} changed={tcc!=tcs}  monoJacc(A,Ccorr)={j:.2f}")
            print(f"       tools A={toolset(a['tools_by_step'])}")
            print(f"             C_stale={toolset(cs['tools_by_step'])}")
            print(f"             C_corr ={toolset(cc['tools_by_step'])}")
        n = len(rng)
        summary[probe_id] = dict(n=n, tier_match_A=tier_match_A, tier_changed=tier_changed, jac_pass=jac_pass)
    print("\n===== SUMMARY =====")
    for p, s in summary.items():
        print(f"{p}: n={s['n']}  C_corr tier matches A: {s['tier_match_A']}/{s['n']}"
              f"  |  tier changed by correction: {s['tier_changed']}/{s['n']}"
              f"  |  monologue Jaccard>=0.5 (A vs C_corr): {s['jac_pass']}/{s['n']}")


if __name__ == "__main__":
    main()
