"""V1.4-shaped JSON extractor — Cell A and Cell C share this code path.

Implements the per-dimension parser primitives from
`docs/v1-observability.md` §3, plus the step-grouping primitive from §3
intro. V1.3 calls this to produce the per-trial JSON records that V1.4
will read (V1.4 has not been built yet; this code emits the shape it's
specified to consume).

Foundational property (`docs/v1-observability.md` foundational finding):
Cell A and Cell C share an identical pickle format
(`{recall_memory, messages, all_messages}` via
`LocalStateManager.save`). One parser; no per-cell branching at the
field-extraction layer. The §4.4 free variable (tool-result envelope
shape) is also pickle-uniform for both cells when going through the
`function`-role normaliser in `_group_steps` — see comment there.
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass, field

# Tier classifier per `docs/v1-observability.md` §3.4. Map is exhaustive
# for the V1 tool set (functions registered in `presets.use_preset`
# DEFAULT_PRESET). `send_message` and `pause_heartbeats` are tool calls
# but not tier-bearing — they get tier `None`.
TIER_MAP: dict[str, str] = {
    "core_memory_append": "core",
    "core_memory_replace": "core",
    "archival_memory_insert": "archival",
    "archival_memory_search": "archival",
    "conversation_search": "recall",
    "conversation_search_date": "recall",
    # Older alias seen in some fork variants; same semantics as conversation_search.
    "recall_memory_search": "recall",
}


@dataclass
class Step:
    """One probe step — user prompt → tool chain → send_message terminator.

    `assistant_messages`: every `role=assistant` entry in the chain
        (multiple if heartbeat-driven). Carries `content` (monologue) and
        `function_call`.
    `function_results`: every `role=function` entry in the chain (the
        tool responses, paired 1:1 with the assistant's function calls
        modulo final send_message).
    `step_idx`: position within the trial (0-based).
    """

    step_idx: int
    user_text: str
    assistant_messages: list[dict] = field(default_factory=list)
    function_results: list[dict] = field(default_factory=list)


def _try_parse_user_type(content: str | None) -> str | None:
    """Read the `type` field from a packaged user-role message.

    `system.package_user_message(...)` wraps as
    `{"type":"user_message","message":<probe>,"time":...}`;
    `system.get_heartbeat(...)` wraps as
    `{"type":"heartbeat","reason":...,"time":...}`;
    `system.get_token_limit_warning()` wraps as
    `{"type":"system_alert","message":...,"time":...}`.
    Returns the `type` string, or `None` for unparseable / non-dict
    content. Treat `None` returns as "probably a real probe" (defensive)."""
    if not isinstance(content, str):
        return None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(parsed, dict):
        return parsed.get("type")
    return None


def _try_extract_user_probe_text(content: str | None) -> str:
    """Pull the original probe text out of a packaged user message. If the
    content isn't a recognisable user_message envelope, returns the raw
    content as-is (defensive — keep the extractor resilient to upstream
    format drift)."""
    if not isinstance(content, str):
        return str(content) if content is not None else ""
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict) and parsed.get("type") == "user_message":
            return parsed.get("message", "")
    except (json.JSONDecodeError, TypeError):
        pass
    return content


def _is_probe_user_message(msg: dict) -> bool:
    """A user-role entry that initiates a new step. Heartbeats /
    system_alerts / logins are user-role but not step boundaries."""
    if msg.get("role") != "user":
        return False
    msg_type = _try_parse_user_type(msg.get("content"))
    if msg_type is None:
        # Defensive: treat unparseable user messages as probes. Real
        # probes always go through `package_user_message`, so this branch
        # would only fire on a corrupted pickle.
        return True
    return msg_type == "user_message"


def load_all_messages(pickle_path: str) -> list[dict]:
    """Load `all_messages` from a LocalStateManager pickle. Lifts the
    `{timestamp, message}` wrapping — returns a flat list of message
    dicts (the per-message representation V1.4 reads against)."""
    with open(pickle_path, "rb") as f:
        d = pickle.load(f)
    if "all_messages" not in d:
        raise ValueError(
            f"pickle at {pickle_path} missing 'all_messages' key (got {list(d.keys())})"
        )
    # `all_messages` entries are `{timestamp: str, message: dict}` per
    # docs/v1-observability.md §1.1. Strip the wrapping.
    return [entry["message"] for entry in d["all_messages"] if "message" in entry]


def _group_steps(all_messages: list[dict]) -> list[Step]:
    """Walk `all_messages` (after timestamp-unwrapping) and group into
    `Step`s. One step = one probe user message → chain of (assistant →
    function)* → terminal assistant w/ send_message.

    System-role messages are skipped (system prompt — not a probe artefact
    per docs/v1-observability.md §1.1).

    Cell-architecture note: Cell C's tool-result entries are recorded with
    `role=toolResult` rather than `role=function` per the 6c.9.4 finding
    (docs/v1-cells.md §4.4 free variable). For *this* extractor, the
    pickle uses `role=function` in both cells because both go through
    `LocalStateManager.save`, which records the function-call API shape
    (Cell A: direct; Cell C: the sidecar normalises before persisting).
    The §4.4 deviation lives in OpenClaw's session-JSONL stream, not in
    the pickle — so no per-cell branching is needed here.
    """
    steps: list[Step] = []
    current: Step | None = None
    step_idx = 0

    for msg in all_messages:
        role = msg.get("role")

        if role == "system":
            # System prompt — not a probe artefact.
            continue

        if role == "user" and _is_probe_user_message(msg):
            # New step begins.
            if current is not None:
                steps.append(current)
                step_idx += 1
            current = Step(
                step_idx=step_idx,
                user_text=_try_extract_user_probe_text(msg.get("content")),
            )
            continue

        if current is None:
            # Heartbeat / system_alert / login before the first probe —
            # part of agent bootstrap. Skip.
            continue

        if role == "assistant":
            current.assistant_messages.append(msg)
        elif role == "function":
            current.function_results.append(msg)
        elif role == "user":
            # Heartbeat / system_alert — chain continuation, not a step
            # boundary. We don't need to record these for the four
            # dimensions; the assistant messages they trigger are what
            # carries the architectural signal.
            continue

    if current is not None:
        steps.append(current)

    return steps


def _parse_function_arguments(args_str: str | None) -> dict:
    """JSON-parse `function_call.arguments`. Returns `{}` on parse
    failure (defensive — the LLM occasionally emits malformed JSON; V1.4
    sees the empty dict and the failure becomes a dimension miss rather
    than a parser crash)."""
    if not isinstance(args_str, str):
        return {}
    try:
        parsed = json.loads(args_str)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def extract_tools_by_step(steps: list[Step]) -> list[dict]:
    """§3.1 — per step, multiset of tool names called (counts dict).
    Argument shapes (keys only, for the manual-review trail) accumulated
    alongside.
    """
    out: list[dict] = []
    for s in steps:
        tools: dict[str, int] = {}
        arg_keys: dict[str, list[list[str]]] = {}
        for am in s.assistant_messages:
            fc = am.get("function_call")
            if not isinstance(fc, dict):
                continue
            name = fc.get("name")
            if not name:
                continue
            tools[name] = tools.get(name, 0) + 1
            args = _parse_function_arguments(fc.get("arguments"))
            arg_keys.setdefault(name, []).append(sorted(args.keys()))
        out.append({"step_idx": s.step_idx, "tools": tools, "arg_keys": arg_keys})
    return out


def extract_monologue_by_step(steps: list[Step], length_cap: int = 5000) -> list[dict]:
    """§3.2 — per step, the assistant inner monologue.

    Two fields:
      - `text`: concatenation of *all* assistant `content` in the step (used
        for the categorical checks: within cap, no user-leakage).
      - `pre_tool_text`: the monologue emitted *before the first tool call* in
        the step — `content` of assistant messages up to and including the
        first one bearing a `function_call` (or all of them if the step calls
        no tool). This is the §5 substantive-monologue comparison field
        (methodology-bank #22): it is invariant to the heartbeat-loop vs
        single-batched-turn structural deviation (§4.3), because Cell A's
        post-tool-result reflection turns and Cell C's absence of them are
        excluded on both sides. The whole-step `text` over-counts Cell A's
        extra heartbeat-turn monologues and is not comparable cross-cell.

    Categorical check: within cap, no user-leakage (assistant content doesn't
    contain text that should live only in `send_message.arguments.message`)."""
    out: list[dict] = []
    for s in steps:
        parts: list[str] = []
        pre_tool_parts: list[str] = []
        seen_tool = False
        send_message_texts: list[str] = []
        for am in s.assistant_messages:
            content = am.get("content")
            fc = am.get("function_call")
            has_fc = isinstance(fc, dict) and fc.get("name")
            if isinstance(content, str) and content:
                parts.append(content)
                if not seen_tool:
                    pre_tool_parts.append(content)
            if has_fc and not seen_tool:
                # This message issues the first tool call; its own monologue
                # (added above) is the pre-tool fragment, nothing after counts.
                seen_tool = True
            if isinstance(fc, dict) and fc.get("name") == "send_message":
                args = _parse_function_arguments(fc.get("arguments"))
                if isinstance(args.get("message"), str):
                    send_message_texts.append(args["message"])
        text = "".join(parts)
        pre_tool_text = "".join(pre_tool_parts)
        # Leakage detector: any send_message payload that appears
        # verbatim in the monologue. Imprecise per docs/v1-observability.md
        # §3.3 — flagged cases route to manual rubric review.
        user_leakage = any(t and t in text for t in send_message_texts)
        out.append(
            {
                "step_idx": s.step_idx,
                "text": text,
                "pre_tool_text": pre_tool_text,
                "char_count": len(text),
                "within_cap": len(text) <= length_cap,
                "user_leakage": user_leakage,
            }
        )
    return out


def extract_send_message_calls(steps: list[Step]) -> tuple[list[dict], list[dict]]:
    """§3.3 — per step, the `send_message.arguments.message` payload(s).
    Returns `(send_message_calls, leakage_flags)`.

    Per §5 categorical check: exactly one send_message per step, payload
    non-empty, zero leakage. Multi-send_message per step would be a
    discipline failure; we record all calls so V1.4 can apply the count
    check uniformly."""
    calls: list[dict] = []
    flags: list[dict] = []
    for s in steps:
        step_calls = []
        for am in s.assistant_messages:
            fc = am.get("function_call")
            if not isinstance(fc, dict) or fc.get("name") != "send_message":
                continue
            args = _parse_function_arguments(fc.get("arguments"))
            msg_text = args.get("message", "")
            step_calls.append({"text": msg_text})
        for c in step_calls:
            calls.append({"step_idx": s.step_idx, "text": c["text"]})
        if len(step_calls) == 0:
            flags.append(
                {"step_idx": s.step_idx, "reason": "no send_message at chain terminus"}
            )
        elif len(step_calls) > 1:
            flags.append(
                {
                    "step_idx": s.step_idx,
                    "reason": f"multiple send_message calls in step ({len(step_calls)})",
                }
            )
        elif not step_calls[0]["text"]:
            flags.append({"step_idx": s.step_idx, "reason": "empty send_message payload"})
    return calls, flags


def extract_tiers_by_step(steps: list[Step]) -> list[dict]:
    """§3.4 — per step, count tool invocations per tier (core / archival
    / recall). `send_message` and other non-tier-bearing tools are
    excluded by the TIER_MAP not having entries for them."""
    out: list[dict] = []
    for s in steps:
        counts = {"core": 0, "archival": 0, "recall": 0}
        for am in s.assistant_messages:
            fc = am.get("function_call")
            if not isinstance(fc, dict):
                continue
            tier = TIER_MAP.get(fc.get("name", ""))
            if tier is not None:
                counts[tier] += 1
        out.append({"step_idx": s.step_idx, "tiers": counts})
    return out


def extract_v14_record(
    pickle_path: str,
    cell: str,
    probe_id: str,
    trial_id: int,
    expected_tier: str | None = None,
) -> dict:
    """Top-level entry — produces the V1.4 comparison-input record from
    one pickle, in the shape specified by `docs/v1-observability.md` §5.

    `cell`: 'A' or 'C'.
    `probe_id`: 'p1' ... 'p7'.
    `trial_id`: 0-based per-cell trial index.
    `expected_tier`: from `docs/v1-probes.md` §3 (e.g., 'core', 'archival',
        'recall', 'ambiguous(core|archival)', 'N/A'). V1.4 uses this for
        the per-probe tier-equivalence check."""
    all_messages = load_all_messages(pickle_path)
    steps = _group_steps(all_messages)

    send_message_calls, leakage_flags = extract_send_message_calls(steps)

    return {
        "cell": cell,
        "probe_id": probe_id,
        "trial_id": trial_id,
        "expected_tier": expected_tier,
        "pickle_path": str(pickle_path),
        "step_count": len(steps),
        "tools_by_step": extract_tools_by_step(steps),
        "monologue_by_step": extract_monologue_by_step(steps),
        "send_message_calls": send_message_calls,
        "leakage_flags": leakage_flags,
        "tiers_by_step": extract_tiers_by_step(steps),
    }


# ── Cell C JSONL projection (methodology-bank #21) ───────────────────────────
#
# Cell C's multi-turn *pickle* duplicates prior turns: OpenClaw replays the
# session buffer into the agent on each new `openclaw agent` invocation, and the
# per-turn `agent_end` mirror re-persists the whole replayed buffer. Single-turn
# probes fire one `agent_end` and are unaffected; p4/p5 carry each prior turn
# twice (byte-identical content, fresh timestamp — so timestamp-dedup misses it).
# The per-trial session JSONL is OpenClaw's append-only event truth and contains
# each turn exactly once, so Cell C is projected from JSONL. Cell A stays on its
# (replay-free, single in-process loop) pickle via `extract_v14_record`.
#
# The projector emits the same `Step` shape the pickle path produces — one step
# per `role=user` turn, assistant `content[]` `toolCall` blocks fanned out into
# `function_call` entries (multi-call assistant → multiple entries in the *same*
# step, monologue text on the first), `toolResult` → `function`. The downstream
# `extract_*_by_step` functions are reused unchanged.


def _flatten_blocks(content: object) -> str:
    """Join the text of pi-ai content blocks (or pass through a plain string)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _jsonl_messages(path: str) -> list[dict]:
    """Yield the `message`-typed entries from an OpenClaw session JSONL, in
    order. Non-message events (session / model_change / custom / …) are skipped."""
    out: list[dict] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("type") != "message":
                continue
            out.append(entry.get("message", entry))
    return out


def load_steps_from_jsonl(paths: list[str]) -> list[Step]:
    """Project one or more OpenClaw session JSONLs into `Step`s. Multiple paths
    (p5's `-s1` + `-s2`) are walked in order and concatenated into one step
    sequence — the cross-session boundary is not itself a step boundary.

    A `role=user` entry opens a step. An assistant entry contributes its leading
    text block as monologue and each `toolCall` block as a `function_call`
    (arguments JSON-stringified to match the v0 pickle shape the extractors
    expect). A `toolResult` becomes a `function`-role result. The trailing
    empty assistant turn (no text, no toolCall) OpenClaw emits as a terminator
    contributes nothing."""
    steps: list[Step] = []
    current: Step | None = None
    step_idx = 0

    for path in paths:
        for m in _jsonl_messages(path):
            role = m.get("role")
            content = m.get("content")

            if role == "user":
                if current is not None:
                    steps.append(current)
                    step_idx += 1
                current = Step(step_idx=step_idx, user_text=_flatten_blocks(content))
                continue

            if current is None:
                # Anything before the first user turn (there is no synthetic
                # boot/welcome in the JSONL — §6.6.1 Cell C has no welcome prefix).
                continue

            if role == "assistant":
                if not isinstance(content, list):
                    text = content if isinstance(content, str) else ""
                    if text:
                        current.assistant_messages.append(
                            {"role": "assistant", "content": text, "function_call": None}
                        )
                    continue
                text = "".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
                tool_calls = [
                    b for b in content
                    if isinstance(b, dict) and b.get("type") == "toolCall"
                ]
                if not tool_calls:
                    if text:
                        current.assistant_messages.append(
                            {"role": "assistant", "content": text, "function_call": None}
                        )
                    continue
                for i, tc in enumerate(tool_calls):
                    args = tc.get("arguments")
                    if args is None:
                        args = tc.get("args") or {}
                    fc = {
                        "name": tc.get("name") or tc.get("toolName"),
                        "arguments": json.dumps(args),
                    }
                    current.assistant_messages.append(
                        {
                            "role": "assistant",
                            # Monologue belongs to the turn, not each split call —
                            # attach to the first only so it is not double-counted.
                            "content": text if i == 0 else "",
                            "function_call": fc,
                        }
                    )
            elif role == "toolResult":
                current.function_results.append(
                    {"role": "function", "content": _flatten_blocks(content)}
                )

    if current is not None:
        steps.append(current)

    return steps


def extract_v14_record_from_jsonl(
    jsonl_paths: list[str],
    cell: str,
    probe_id: str,
    trial_id: int,
    expected_tier: str | None = None,
) -> dict:
    """Cell C counterpart of `extract_v14_record` — same output shape, sourced
    from the per-trial session JSONL(s) rather than the (replay-duplicated)
    pickle. See `load_steps_from_jsonl` and methodology-bank #21."""
    steps = load_steps_from_jsonl(jsonl_paths)
    send_message_calls, leakage_flags = extract_send_message_calls(steps)
    return {
        "cell": cell,
        "probe_id": probe_id,
        "trial_id": trial_id,
        "expected_tier": expected_tier,
        "source": "jsonl",
        "source_jsonl": [str(p) for p in jsonl_paths],
        "step_count": len(steps),
        "tools_by_step": extract_tools_by_step(steps),
        "monologue_by_step": extract_monologue_by_step(steps),
        "send_message_calls": send_message_calls,
        "leakage_flags": leakage_flags,
        "tiers_by_step": extract_tiers_by_step(steps),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="V1.4-shaped JSON extractor")
    parser.add_argument("pickle", help="Path to LocalStateManager pickle")
    parser.add_argument("--cell", required=True, choices=["A", "C"])
    parser.add_argument("--probe-id", required=True)
    parser.add_argument("--trial-id", type=int, required=True)
    parser.add_argument("--expected-tier", default=None)
    parser.add_argument("--out", help="Optional output path; otherwise prints to stdout")
    args = parser.parse_args()

    record = extract_v14_record(
        pickle_path=args.pickle,
        cell=args.cell,
        probe_id=args.probe_id,
        trial_id=args.trial_id,
        expected_tier=args.expected_tier,
    )
    rendered = json.dumps(record, indent=2)
    if args.out:
        from pathlib import Path

        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "w") as f:
            f.write(rendered)
    else:
        print(rendered)
