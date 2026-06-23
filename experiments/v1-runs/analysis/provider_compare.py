"""#24 provider-equivalence check — institutional Bedrock vs direct Anthropic.

Both arms ran Cell C p5 with the SAME corrected §3 persona/human; the only
difference is the serving chain:
  INST : OpenClaw -> LiteLLM -> shim -> institutional Bedrock (Sonnet 4.5)
         JSONLs preserved in analysis/institutional_p5_jsonl/ (trials 0-5)
  ANTH : OpenClaw -> LiteLLM -> api.anthropic.com (Sonnet 4.5, 20250929)
         JSONLs on disk at p5/ (trials 0-9; compare 0-5)

If dominant tier, tool set, and cross-session recall agree across the two
chains, the provider switch is behaviourally non-material for the §7.3
dimensions (analogous to the wire-format finding #12), and Cell A (Bedrock)
remains a valid reference for the new-chain Cell C.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from extract import extract_v14_record_from_jsonl  # noqa: E402

VRUNS = Path(__file__).resolve().parent.parent
INST = VRUNS / "analysis" / "institutional_p5_jsonl"
ANTH = VRUNS / "p5"

TIER_MAP = {
    "core_memory_append": "core", "core_memory_replace": "core",
    "archival_memory_insert": "archival", "archival_memory_search": "archival",
    "conversation_search": "recall", "conversation_search_date": "recall",
    "recall_memory_search": "recall",
}
STOP = set("a an the i you it to of and is in that this my your for be on was with as are have has".split())
STOCK = {"exec", "read", "write", "bash", "edit", "glob", "grep", "ls"}


def dom_tier(rec):
    c = Counter()
    for s in rec["tools_by_step"]:
        for n, k in s["tools"].items():
            if TIER_MAP.get(n):
                c[TIER_MAP[n]] += k
    if not c:
        return "none"
    return sorted(c.items(), key=lambda x: (-x[1], {"archival": 0, "core": 1, "recall": 2}[x[0]]))[0][0]


def toolset(rec):
    c = Counter()
    for s in rec["tools_by_step"]:
        c.update(s["tools"])
    return dict(c)


def toks(rec):
    import re
    parts = [s.get("pre_tool_text") or s.get("text", "") for s in rec["monologue_by_step"]]
    w = re.findall(r"[a-zA-Z]+", " ".join(parts).lower())
    return {t for t in w if len(t) >= 2 and t not in STOP}


def jacc(a, b):
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def rec_for(base: Path, tid: int):
    paths = [str(base / f"cell-c-{tid}-s1.jsonl"), str(base / f"cell-c-{tid}-s2.jsonl")]
    return extract_v14_record_from_jsonl(paths, "C", "p5", tid, "recall")


def main():
    tier_agree = 0
    cardinal_both = 0
    n = 0
    print("trial | INST tier/tools           | ANTH tier/tools           | tier= | CARDINAL i/a | monoJacc")
    for tid in range(6):
        ri, ra = rec_for(INST, tid), rec_for(ANTH, tid)
        ti, ta = dom_tier(ri), dom_tier(ra)
        ci = "CARDINAL_3987" in (INST / f"cell-c-{tid}-s2.jsonl").read_text()
        ca = "CARDINAL_3987" in (ANTH / f"cell-c-{tid}-s2.jsonl").read_text()
        j = jacc(toks(ri), toks(ra))
        n += 1
        if ti == ta:
            tier_agree += 1
        if ci and ca:
            cardinal_both += 1
        print(f"  t{tid}  | {ti:8} {toolset(ri)}  | {ta:8} {toolset(ra)}  | {ti==ta} | {ci}/{ca} | {j:.2f}")
        stock_a = set(toolset(ra)) & STOCK
        if stock_a:
            print(f"        !! ANTH stock-tool contamination: {sorted(stock_a)}")
    print(f"\n#24 SUMMARY (n={n}): tier-agreement INST==ANTH {tier_agree}/{n}"
          f" | CARDINAL recovered both chains {cardinal_both}/{n}")
    print("Interpretation: high tier-agreement + recall both = provider switch non-material.")


if __name__ == "__main__":
    main()
