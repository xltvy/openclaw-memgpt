"""Re-derive the 45 Cell C trial JSONs from per-trial session JSONL.

Fixes methodology-bank #21: the Cell C *pickle* duplicates replayed prior turns
on multi-turn probes (p4/p5). The JSONL is OpenClaw's append-only event truth —
each turn once — so Cell C is projected from it. Cell A is untouched (pickle).

Usage:
    python reextract_cell_c.py            # regenerate all 45 cell-c-*.json
    python reextract_cell_c.py --check p4 0   # print one trial's digest, no write
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

# Cell A pickles were written by the fork against the pre-v1 openai SDK and
# reference `openai.openai_object.OpenAIObject` (removed in openai>=1.0). The
# original generation env had it; this offline re-extraction does not. Install
# a minimal dict-subclass shim so `pickle.load` can reconstruct the message
# dicts (`all_messages` entries are plain dicts; the shim only satisfies the
# class reference). No behavioural effect — the extractor reads dict fields.
if "openai" not in sys.modules:
    try:
        import openai  # noqa: F401  (new SDK; just to anchor the package)
    except Exception:
        sys.modules["openai"] = types.ModuleType("openai")
_oo = types.ModuleType("openai.openai_object")
class _OpenAIObject(dict):  # noqa: N801
    """Stand-in for the legacy openai.openai_object.OpenAIObject (dict-based).

    Tolerates the legacy reduce's constructor args (ignored) and restores
    instance state; dict items come back via the reduce's dict-iterator."""
    def __init__(self, *args, **kwargs):
        super().__init__()
    def __setstate__(self, state):
        # Legacy OpenAIObject.__reduce__ passes the object's *content* as the
        # pickle state (args are id/api_key/… which we ignore). Restore it as
        # dict items so function_call/message fields are present.
        if isinstance(state, dict):
            self.update(state)
_oo.OpenAIObject = _OpenAIObject
sys.modules["openai.openai_object"] = _oo

from extract import extract_v14_record, extract_v14_record_from_jsonl  # noqa: E402

HERE = Path(__file__).parent

# (trial_count, expected_tier, cross_session) per docs/v1-probes.md §3.
PROBES = {
    "p1": (5, "core", False),
    "p2": (5, "archival", False),
    "p3": (5, "archival", False),
    "p4": (5, "recall", False),
    "p5": (10, "recall", True),
    "p6": (10, "ambiguous(core|archival)", False),
    "p7": (5, "N/A", False),
}


def jsonl_paths_for(probe_id: str, trial_id: int, cross_session: bool) -> list[Path]:
    d = HERE / probe_id
    if cross_session:
        return [d / f"cell-c-{trial_id}-s1.jsonl", d / f"cell-c-{trial_id}-s2.jsonl"]
    return [d / f"cell-c-{trial_id}.jsonl"]


def _cell_a_pickle_path(probe_id: str, trial_id: int) -> str:
    """Cell A pickle path from the trial's `-pickle-path.txt`. Cross-session
    probes (p5) record two lines (`session_1:`/`session_2:`); use session_2 —
    its `all_messages` is the post-`:load` buffer spanning both sessions, which
    matches Cell A's original 3-step extraction."""
    raw = (HERE / probe_id / f"cell-a-{trial_id}-pickle-path.txt").read_text().strip()
    if "session_2:" in raw:
        for line in raw.splitlines():
            if line.strip().startswith("session_2:"):
                return line.split("session_2:", 1)[1].strip()
    return raw


def build(probe_id: str, trial_id: int) -> dict:
    count, expected_tier, cross_session = PROBES[probe_id]
    paths = jsonl_paths_for(probe_id, trial_id, cross_session)
    for p in paths:
        if not p.exists():
            raise SystemExit(f"missing JSONL: {p}")
    return extract_v14_record_from_jsonl(
        jsonl_paths=[str(p) for p in paths],
        cell="C",
        probe_id=probe_id,
        trial_id=trial_id,
        expected_tier=expected_tier,
    )


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "--check":
        rec = build(sys.argv[2], int(sys.argv[3]))
        print(f"step_count={rec['step_count']}")
        for s in rec["tools_by_step"]:
            print(f"  step{s['step_idx']} tools={s['tools']}")
        for s in rec["monologue_by_step"]:
            print(f"  mono{s['step_idx']}: {s['text'][:90]!r}")
        return 0

    written_c = 0
    written_a = 0
    for probe_id, (count, expected_tier, _xs) in PROBES.items():
        for tid in range(count):
            # Cell C — project from JSONL (replay-deduplicated; #21).
            rec_c = build(probe_id, tid)
            (HERE / probe_id / f"cell-c-{tid}.json").write_text(json.dumps(rec_c, indent=2))
            written_c += 1
            # Cell A — re-extract from pickle to refresh the monologue
            # `pre_tool_text` field (#22). Behaviourally identical to the
            # prior extraction; only the new field is added.
            pk_path = _cell_a_pickle_path(probe_id, tid)
            rec_a = extract_v14_record(
                pickle_path=pk_path,
                cell="A",
                probe_id=probe_id,
                trial_id=tid,
                expected_tier=expected_tier,
            )
            (HERE / probe_id / f"cell-a-{tid}.json").write_text(json.dumps(rec_a, indent=2))
            written_a += 1
    print(f"re-extracted {written_c} Cell C (JSONL) + {written_a} Cell A (pickle) trial JSONs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
