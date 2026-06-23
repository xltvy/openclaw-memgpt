"""Structural-equality pickle diff for the V1.3 dry-run validation gate.

Compares two `LocalStateManager.save`-format pickles (3-key dict
`{recall_memory, messages, all_messages}` per `docs/v1-observability.md`
§1.1) and asserts they are structurally equal modulo run-specific noise.

What "structurally equal" means here is captured in
`experiments/v1-runs/README.md` §2.2:

  - same `all_messages` length
  - per-index `role` matches
  - role=user: `content` matches verbatim
  - role=assistant: `content` matches; `function_call.name` matches;
    `function_call.arguments` (JSON-parsed) matches by dict-equality
  - role=function: `name` and `content` match (the
    package_function_response envelope, including the "status" and
    "message" fields)
  - **ignored** (per §2.2 / `docs/v1-observability.md` §4.5):
      - top-level `timestamp` field on each entry
      - `system` role (system prompt — not a probe artefact)
      - LiteLLM-augmented assistant keys: `refusal`, `annotations`,
        `audio`, `tool_calls`, `provider_specific_fields`
      - per-call metadata `api_response`, `api_args` (agent.py:1083-1090)

Acceptance: structural equality at temperature 0 should be exact for the
dry-run's chosen probe (p1 — single tool, single send_message). At temp>0
LLM stochasticity could change argument values; the dry-run is run at
temp=0 specifically so a divergence points at a wrapper bug, not LLM
noise.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Fields we drop before comparison. The first set is per-entry top-level;
# the second is per-message inner-dict.
IGNORED_ENTRY_KEYS = {"timestamp"}
IGNORED_MESSAGE_KEYS = {
    # LiteLLM augmentation (docs/v1-observability.md §4.5).
    "refusal",
    "annotations",
    "audio",
    "tool_calls",
    "provider_specific_fields",
    # Per-call API metadata (agent.py:1083-1090).
    "api_response",
    "api_args",
}
# Timestamp-bearing keys inside JSON-encoded message content envelopes
# (`package_user_message`, `package_function_response`, `get_heartbeat`,
# `get_login_event`, `get_token_limit_warning` — all bake in a `time`
# field at write time). Always stripped — same precedent as
# IGNORED_MESSAGE_KEYS for LiteLLM augmentation: rig artefact, not
# architectural signal.
EMBEDDED_CONTENT_TIMESTAMP_KEYS = {"time"}


@dataclass
class Divergence:
    """One structural divergence between two pickles.

    `path` is a dotted/bracketed JSON-pointer-style trail, e.g.
    `all_messages[3].message.function_call.arguments.message`."""

    path: str
    a_value: object
    b_value: object
    reason: str


@dataclass
class DiffResult:
    equal: bool
    divergences: list[Divergence] = field(default_factory=list)
    a_path: str = ""
    b_path: str = ""
    # Boot-skip telemetry — how many entries were dropped from each side
    # when --skip-boot was active. Zero on both when --skip-boot is off.
    a_boot_skipped: int = 0
    b_boot_skipped: int = 0

    def to_json(self) -> dict:
        return {
            "equal": self.equal,
            "a_path": self.a_path,
            "b_path": self.b_path,
            "a_boot_skipped": self.a_boot_skipped,
            "b_boot_skipped": self.b_boot_skipped,
            "divergences": [
                {
                    "path": d.path,
                    "a_value": _to_jsonable(d.a_value),
                    "b_value": _to_jsonable(d.b_value),
                    "reason": d.reason,
                }
                for d in self.divergences
            ],
        }


def _to_jsonable(v):
    """Best-effort JSON-safe rendering of a divergence value. Pickle data
    can contain odd types (datetimes, custom classes); render them as
    strings so the diff report itself never fails to serialise."""
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return repr(v)


def load_all_messages(pickle_path: str) -> list[dict]:
    """Load `all_messages` from a LocalStateManager pickle. The pickle is a
    3-key dict; we only need `all_messages` for the four §7.3 dimensions
    (per docs/v1-observability.md §1.1)."""
    with open(pickle_path, "rb") as f:
        d = pickle.load(f)
    if "all_messages" not in d:
        raise ValueError(
            f"pickle at {pickle_path} missing 'all_messages' key (got {list(d.keys())})"
        )
    return d["all_messages"]


def _normalise_json_content(content):
    """JSON-encoded message content (user packaged envelopes, function
    result envelopes) carries a `time` field baked in at write time —
    purely a rig artefact, not architectural signal. Parse the content,
    drop time-bearing keys, return the resulting dict for structural
    comparison. Non-dict / non-JSON content passes through unchanged."""
    if not isinstance(content, str):
        return content
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return content
    if isinstance(parsed, dict):
        return {k: v for k, v in parsed.items() if k not in EMBEDDED_CONTENT_TIMESTAMP_KEYS}
    return content


_STRUCTURAL_MONOLOGUE_SENTINEL = "<MONOLOGUE>"
_STRUCTURAL_VALUE_SENTINEL = "<VALUE>"


def _strip_message(msg: dict, structural_only: bool = False) -> dict:
    """Strip ignored keys from a message dict.

    For user-role and function-role messages, also JSON-parse the
    `content` envelope and drop the embedded `time` field (rig artefact —
    every fresh write gets a fresh timestamp; not architectural signal).

    For assistant messages, also normalise `function_call.arguments` from a
    JSON string to a parsed dict (so dict-equality compares structure, not
    whitespace / key ordering in the string).

    When `structural_only=True`, the LLM-influenceable string fields are
    replaced with sentinel placeholders so the recursive diff compares
    structure only:
      - assistant `content` (inner monologue) → `"<MONOLOGUE>"` if
        non-empty, else `None` (presence-vs-absence still matters).
      - `function_call.arguments` dict VALUES → `"<VALUE>"` (keys are
        retained — same key-set = same tool-argument shape).
    Function-role `content` and user-role `content` are left alone:
      - function results are deterministic given the same call
        (`{status:OK, message:null}` for `core_memory_append`, etc.).
      - user-role content is either the probe (operator-controlled and
        identical across runs) or machine-generated boilerplate
        (heartbeats, logins — bit-identical post-time-stripping).
    """
    clean = {k: v for k, v in msg.items() if k not in IGNORED_MESSAGE_KEYS}

    # Content envelope normalisation for the two roles whose content is
    # JSON-encoded with timestamps. Assistant content is the inner
    # monologue string — not JSON-encoded; leave untouched (handled by
    # the structural_only path below).
    if clean.get("role") in ("user", "function") and "content" in clean:
        clean["content"] = _normalise_json_content(clean["content"])

    if clean.get("role") == "assistant" and "function_call" in clean:
        fc = clean["function_call"]
        if isinstance(fc, dict) and "arguments" in fc and isinstance(fc["arguments"], str):
            try:
                parsed_args = json.loads(fc["arguments"])
            except json.JSONDecodeError:
                # Leave as-is — the diff will catch the malformed string
                # in the recursive comparison.
                parsed_args = fc["arguments"]
            clean["function_call"] = {**fc, "arguments": parsed_args}

    if structural_only and clean.get("role") == "assistant":
        # Replace inner monologue with presence-sentinel.
        content = clean.get("content")
        if isinstance(content, str) and content:
            clean["content"] = _STRUCTURAL_MONOLOGUE_SENTINEL
        # Replace function_call.arguments VALUES with sentinel (preserving
        # keys = preserving argument shape).
        fc = clean.get("function_call")
        if isinstance(fc, dict):
            args = fc.get("arguments")
            if isinstance(args, dict):
                clean["function_call"] = {
                    **fc,
                    "arguments": {k: _STRUCTURAL_VALUE_SENTINEL for k in args},
                }

    return clean


def _strip_entry(entry: dict, structural_only: bool = False) -> dict:
    """Drop ignored top-level keys (timestamp) and normalise the inner
    message."""
    clean = {k: v for k, v in entry.items() if k not in IGNORED_ENTRY_KEYS}
    if "message" in clean and isinstance(clean["message"], dict):
        clean["message"] = _strip_message(clean["message"], structural_only=structural_only)
    return clean


def _diff_value(a, b, path: str, out: list[Divergence]) -> None:
    """Recursive structural equality with path-trail accumulation. Records
    every divergence (not just the first) so the diff report shows the full
    discrepancy surface — useful when more than one thing has drifted."""
    if type(a) is not type(b):
        # dict vs list etc. — structural divergence.
        out.append(
            Divergence(path=path, a_value=a, b_value=b, reason=f"type mismatch ({type(a).__name__} vs {type(b).__name__})")
        )
        return

    if isinstance(a, dict):
        a_keys = set(a.keys())
        b_keys = set(b.keys())
        if a_keys != b_keys:
            out.append(
                Divergence(
                    path=path,
                    a_value=sorted(a_keys),
                    b_value=sorted(b_keys),
                    reason="dict key-set differs",
                )
            )
            # Continue into the intersection so we report every divergence.
        for k in sorted(a_keys & b_keys):
            _diff_value(a[k], b[k], f"{path}.{k}", out)
        return

    if isinstance(a, list):
        if len(a) != len(b):
            out.append(
                Divergence(
                    path=path,
                    a_value=len(a),
                    b_value=len(b),
                    reason=f"list length differs ({len(a)} vs {len(b)})",
                )
            )
            # Compare the common prefix anyway.
        for i, (av, bv) in enumerate(zip(a, b)):
            _diff_value(av, bv, f"{path}[{i}]", out)
        return

    # Scalar.
    if a != b:
        out.append(Divergence(path=path, a_value=a, b_value=b, reason="value differs"))


def _looks_like_probe_user_message(msg: dict) -> bool:
    """A role=user message whose JSON-decoded content has
    `type=user_message` (i.e., went through `system.package_user_message`).

    Heartbeats (`type=heartbeat`), logins (`type=login`), and
    system_alerts (`type=system_alert`) are also role=user but have
    different `type` fields and aren't probe inputs.

    Handles both raw-string content (pre-normalisation) and dict content
    (post-`_normalise_json_content`) — boot-skip detection runs after
    `_strip_entry` so content arrives as a dict in the typical path."""
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, dict):
        return content.get("type") == "user_message"
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return False
        return isinstance(parsed, dict) and parsed.get("type") == "user_message"
    return False


def _find_first_probe_idx(entries: list[dict]) -> int | None:
    """Scan stripped+filtered entries for the first probe-user-message.
    Returns its index, or None if no probe is present (which would
    indicate the pickle was captured before any probe was driven —
    surface this to the operator rather than silently treating as boot-
    free).
    """
    for i, e in enumerate(entries):
        msg = e.get("message") if isinstance(e, dict) else None
        if isinstance(msg, dict) and _looks_like_probe_user_message(msg):
            return i
    return None


def diff_pickles(
    a_path: str,
    b_path: str,
    skip_boot: bool = False,
    structural_only: bool = False,
) -> DiffResult:
    """Top-level entry: load both pickles, strip noise, recursively
    compare. Returns a `DiffResult` whose `.equal` is True only when zero
    divergences were recorded.

    `skip_boot=True`: drop all entries before the first probe-user-message
    on each side. Necessary for the dry-run gate because Cell A's CLI
    runs an extra welcome step in response to the login event (the
    "Great to meet a researcher!" send_message — see
    `docs/methodology-bank.md` #16) which the wrapper deliberately
    skips. Both pickles also carry an identical `initial_boot_messages`
    prefix from `initialize_message_sequence` (agent.py:80-95); dropping
    everything before the first probe captures both rig artefacts in one
    rule.
    """
    a_all = load_all_messages(a_path)
    b_all = load_all_messages(b_path)

    # Filter out system-role messages on both sides — the system prompt is
    # not a probe artefact (docs/v1-observability.md §1.1 explicitly excludes
    # it from the four §7.3 dimensions).
    a_clean = [_strip_entry(e, structural_only=structural_only) for e in a_all if e.get("message", {}).get("role") != "system"]
    b_clean = [_strip_entry(e, structural_only=structural_only) for e in b_all if e.get("message", {}).get("role") != "system"]

    a_boot_skipped = 0
    b_boot_skipped = 0

    if skip_boot:
        a_probe_idx = _find_first_probe_idx(a_clean)
        b_probe_idx = _find_first_probe_idx(b_clean)
        if a_probe_idx is None or b_probe_idx is None:
            # Don't silently corrupt the comparison — surface this. The
            # operator should investigate why a pickle has no probe
            # user-message (was the trial captured pre-probe?).
            return DiffResult(
                equal=False,
                divergences=[
                    Divergence(
                        path="all_messages[non-system]",
                        a_value=a_probe_idx,
                        b_value=b_probe_idx,
                        reason=(
                            "skip-boot enabled but no probe-user-message "
                            "(type=user_message) found in one or both pickles"
                        ),
                    )
                ],
                a_path=str(a_path),
                b_path=str(b_path),
            )
        a_boot_skipped = a_probe_idx
        b_boot_skipped = b_probe_idx
        a_clean = a_clean[a_probe_idx:]
        b_clean = b_clean[b_probe_idx:]

    divergences: list[Divergence] = []
    _diff_value(a_clean, b_clean, "all_messages[non-system,post-boot]" if skip_boot else "all_messages[non-system]", divergences)

    return DiffResult(
        equal=(len(divergences) == 0),
        divergences=divergences,
        a_path=str(a_path),
        b_path=str(b_path),
        a_boot_skipped=a_boot_skipped,
        b_boot_skipped=b_boot_skipped,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Structural-equality diff for V1.3 dry-run validation."
    )
    parser.add_argument("a", help="Path to first pickle (e.g. manual CLI run)")
    parser.add_argument("b", help="Path to second pickle (e.g. wrapper run)")
    parser.add_argument(
        "--json-out",
        help="Optional path to write the JSON-shaped result. Always pretty-prints to stdout too.",
    )
    parser.add_argument(
        "--max-divergences",
        type=int,
        default=20,
        help="Truncate the printed divergence list to this many entries (full set still written to --json-out).",
    )
    parser.add_argument(
        "--skip-boot",
        action="store_true",
        help=(
            "Drop everything in all_messages before the first probe-user-message "
            "on each side. Necessary for Cell A wrapper-vs-CLI comparison — the "
            "CLI runs an extra welcome step in response to the login event that "
            "the wrapper deliberately skips. See docs/methodology-bank.md #16."
        ),
    )
    parser.add_argument(
        "--structural-only",
        action="store_true",
        help=(
            "Compare structure only — replace assistant inner-monologue and "
            "function_call.arguments VALUES with sentinel placeholders before "
            "the diff. Use this as the V1.3 dry-run gate when LLM-stochastic "
            "content variance is expected (temperature > 0). Compares: "
            "role sequence, function_call.name sequence, function_call.arguments "
            "key-set, presence-of-monologue. Skips: monologue text, argument "
            "values, send_message payload text. Pairs with --skip-boot."
        ),
    )
    args = parser.parse_args(argv)

    result = diff_pickles(
        args.a,
        args.b,
        skip_boot=args.skip_boot,
        structural_only=args.structural_only,
    )
    result_json = result.to_json()

    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.json_out, "w") as f:
            json.dump(result_json, f, indent=2)

    # Human-readable summary to stdout.
    print(f"a: {result.a_path}")
    print(f"b: {result.b_path}")
    print(f"mode: {'structural-only' if args.structural_only else 'content-aware'}{' + skip-boot' if args.skip_boot else ''}")
    if args.skip_boot:
        print(f"skip-boot: a dropped {result.a_boot_skipped} prefix entries; b dropped {result.b_boot_skipped}")
    print(f"equal: {result.equal}")
    if not result.equal:
        print(f"divergences: {len(result.divergences)}")
        for d in result.divergences[: args.max_divergences]:
            print(f"  - [{d.reason}] {d.path}")
            print(f"      a: {_to_jsonable(d.a_value)!r}")
            print(f"      b: {_to_jsonable(d.b_value)!r}")
        if len(result.divergences) > args.max_divergences:
            print(f"  ... ({len(result.divergences) - args.max_divergences} more — see --json-out)")

    return 0 if result.equal else 1


if __name__ == "__main__":
    sys.exit(main())
