"""
Tests for POST /agents/{id}:summarize  (§2.8, 6a.7).

Done-criteria:
- cutoff matches select_cutoff called directly on the same buffer (F1 equivalence,
  endpoint wrapping does not perturb the algorithm).
- summary is a non-empty string (LLM output is non-deterministic; checked structurally).
- packaged_message.content starts with the verbatim package_summarize_message preamble
  template (anchored regex on the prefix).
- Endpoint touches no buffer state: agent._messages, pm.messages, pm.all_messages
  lengths are all unchanged before/after the call.
- LLMError from select_cutoff (buffer too small) surfaces as 422.
- F1 callable (select_cutoff) is importable from memgpt.agent (e2c8c93 lineage).

LLM call isolation:
  summarize_messages (memgpt.memory) calls create (= completions_with_backoff) for
  the actual LLM completion.  Tests patch memgpt.memory.create to return a canned
  response object so the test suite runs without a real API key.  The mock response
  matches the shape that summarize_messages reads: response.choices[0].message.content.
"""

from __future__ import annotations

import json
import re
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# ── constants (mirror memgpt constants used by select_cutoff) ─────────────────

# MESSAGE_SUMMARY_TRUNC_KEEP_N_LAST = 3 — buffer must have at least this many
# messages after the system message, plus one to summarise.
# Build a buffer that gives select_cutoff enough to work with.
_SYSTEM_MSG = {"role": "system", "content": "You are a helpful assistant."}
_CANNED_SUMMARY = (
    "I helped the user debug their Python environment. "
    "We resolved an import error and installed the missing package."
)

# Build a buffer that exceeds the token-fraction threshold.
# select_cutoff targets messages[1:] * TRUNC_TOKEN_FRAC tokens front-to-back,
# then keeps KEEP_N_LAST = 3 at the tail.  A buffer of ~20 short messages is
# well beyond any threshold — the exact cutoff is algorithm-determined, not fixed.
_N_MESSAGES = 20
_BUFFER: list[dict] = [_SYSTEM_MSG] + [
    {
        "role": "user" if i % 2 == 0 else "assistant",
        "content": f"Turn {i}: the quick brown fox jumped over the lazy dog near the river bank.",
    }
    for i in range(_N_MESSAGES)
]
_TOTAL_MESSAGE_COUNT = 42  # illustrative all-time count the host tracks


# ── mock factory ─────────────────────────────────────────────────────────────


def _make_mock_response(content: str):
    """Return a mock OpenAI completion response matching the shape summarize_messages reads."""
    msg = SimpleNamespace(content=content)
    choice = SimpleNamespace(message=msg)
    return SimpleNamespace(choices=[choice])


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def summarize_agent(client):
    """One resident agent shared across the module."""
    name = f"summarize-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


def _call_summarize(client, agent_id: str, messages=None, total=None) -> dict:
    """POST /{agent_id}:summarize with the standard test buffer (LLM mocked by caller)."""
    r = client.post(
        f"/agents/{agent_id}:summarize",
        json={
            "messages": messages if messages is not None else _BUFFER,
            "total_message_count": total if total is not None else _TOTAL_MESSAGE_COUNT,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def _live_agent(agent_id: str):
    import sys, os
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    return registry.get(agent_id)


# ── F1 import smoke test ──────────────────────────────────────────────────────


def test_select_cutoff_importable():
    """
    Confirms F1's select_cutoff is importable from memgpt.agent (e2c8c93 lineage).
    A missing symbol here means the fork checkout is not on the dev branch.
    """
    from memgpt.agent import select_cutoff  # noqa: F401 — import is the assertion


# ── cutoff equivalence ────────────────────────────────────────────────────────


class TestCutoffEquivalence:
    """
    The endpoint's cutoff must equal select_cutoff called directly on the same buffer.
    Proves host wrapping does not perturb F1's algorithm.
    """

    def test_cutoff_matches_direct_call(self, client, summarize_agent):
        """Endpoint cutoff == select_cutoff(_BUFFER, 'gpt-4') — F1 equivalence."""
        from memgpt.agent import select_cutoff

        expected_cutoff = select_cutoff(_BUFFER, "gpt-4")

        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        assert r["cutoff"] == expected_cutoff, (
            f"endpoint cutoff {r['cutoff']} != direct select_cutoff {expected_cutoff} — "
            "host wrapping must not alter the cutoff algorithm"
        )

    def test_cutoff_excludes_system_message(self, client, summarize_agent):
        """
        cutoff >= 1: messages[0] (the system message) is never part of the summarised
        prefix — select_cutoff always sets cutoff such that messages[1:cutoff] starts
        after the system message.
        """
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        assert r["cutoff"] >= 1, f"cutoff={r['cutoff']} includes system message (must be ≥1)"

    def test_summary_length_equals_messages_summarised(self, client, summarize_agent):
        """summary_length == len(messages[1:cutoff]) == cutoff - 1."""
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        expected = r["cutoff"] - 1
        assert r["summary_length"] == expected, (
            f"summary_length={r['summary_length']} != cutoff-1={expected}"
        )


# ── system-less buffer (production shape) — 1.0.1 regression ──────────────────


class TestSystemlessBuffer:
    """
    1.0.1 regression. In Shape B, OpenClaw owns the conversation buffer and injects the
    system prompt separately (promptBuilder), so the buffer POSTed to :summarize is
    *system-less* — it begins with the first user message. Before 1.0.1 this tripped
    select_cutoff's `messages[0]["role"] == "system"` assertion → 500 on every
    flush-pressure summarisation. The sidecar now prepends agent.system internally to
    restore the native shape select_cutoff was written for. The whole pre-1.0.1 suite
    missed this because every other test feeds the native-shaped _BUFFER (system at [0]).
    """

    # _BUFFER minus its leading system message — exactly what OpenClaw sends.
    _SYSTEMLESS = _BUFFER[1:]

    def test_systemless_buffer_succeeds(self, client, summarize_agent):
        """The bug repro: a system-less buffer returns 200, not 500."""
        assert self._SYSTEMLESS[0]["role"] != "system"  # guard: this is the production shape
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent, messages=self._SYSTEMLESS)
        assert r["cutoff"] >= 1
        assert isinstance(r["summary"], str) and len(r["summary"]) > 0
        assert r["packaged_message"]["role"] == "user"

    def test_systemless_cutoff_is_native_space(self, client, summarize_agent):
        """
        Returned cutoff is native-space: equals select_cutoff applied to the buffer with a
        system message prepended. The prepended system's content is irrelevant (index 0 is
        token-counted then discarded), so any system message yields the same cutoff.
        """
        from memgpt.agent import select_cutoff

        native = [_SYSTEM_MSG] + self._SYSTEMLESS
        expected_cutoff = select_cutoff(native, "gpt-4")

        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent, messages=self._SYSTEMLESS)

        assert r["cutoff"] == expected_cutoff, (
            f"endpoint cutoff {r['cutoff']} != native-space select_cutoff {expected_cutoff}"
        )

    def test_systemless_and_native_same_cutoff(self, client, summarize_agent):
        """
        A system-less buffer and its system-led equivalent (same real messages) yield the
        same cutoff — proving the conditional prepend is idempotent and content-independent.
        """
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r_systemless = _call_summarize(client, summarize_agent, messages=self._SYSTEMLESS)
            r_native = _call_summarize(client, summarize_agent, messages=_BUFFER)

        assert r_systemless["cutoff"] == r_native["cutoff"]


# ── response structure ────────────────────────────────────────────────────────


class TestResponseStructure:
    def test_summary_nonempty(self, client, summarize_agent):
        """summary field is a non-empty string (LLM output, non-deterministic)."""
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        assert isinstance(r["summary"], str) and len(r["summary"]) > 0

    def test_packaged_message_role(self, client, summarize_agent):
        """packaged_message has role='user' (mirrors summarize_messages_inplace)."""
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        assert r["packaged_message"]["role"] == "user"

    def test_packaged_message_preamble(self, client, summarize_agent):
        """
        packaged_message.content starts with the verbatim package_summarize_message
        preamble template — anchored regex on the prefix.

        Template: "Note: prior messages (N of M total messages) have been hidden
        from view due to conversation memory constraints."
        """
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        content_json = r["packaged_message"]["content"]
        content_dict = json.loads(content_json)
        message_text = content_dict["message"]

        preamble_re = re.compile(
            r"^Note: prior messages \(\d+ of \d+ total messages\) have been hidden "
            r"from view due to conversation memory constraints\."
        )
        assert preamble_re.match(message_text), (
            f"packaged preamble not in expected form: {message_text[:200]!r}"
        )

    def test_packaged_message_preamble_numbers(self, client, summarize_agent):
        """
        The N and M in the preamble match hidden_message_count and total_message_count.
        """
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        content_dict = json.loads(r["packaged_message"]["content"])
        message_text = content_dict["message"]

        m = re.search(r"Note: prior messages \((\d+) of (\d+) total messages\)", message_text)
        assert m, f"cannot parse N/M from preamble: {message_text[:200]!r}"

        hidden_in_text = int(m.group(1))
        total_in_text = int(m.group(2))

        assert hidden_in_text == r["hidden_message_count"], (
            f"preamble hidden={hidden_in_text} != response hidden_message_count={r['hidden_message_count']}"
        )
        assert total_in_text == r["total_message_count"], (
            f"preamble total={total_in_text} != response total_message_count={r['total_message_count']}"
        )

    def test_hidden_message_count_derivation(self, client, summarize_agent):
        """hidden_message_count == total_message_count - len(messages[cutoff:])."""
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent)

        expected_hidden = _TOTAL_MESSAGE_COUNT - len(_BUFFER[r["cutoff"]:])
        assert r["hidden_message_count"] == expected_hidden, (
            f"hidden={r['hidden_message_count']} != total - remaining = {expected_hidden}"
        )

    def test_total_message_count_passthrough(self, client, summarize_agent):
        """total_message_count in the response equals the value sent in the request."""
        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            r = _call_summarize(client, summarize_agent, total=99)

        assert r["total_message_count"] == 99


# ── buffer isolation ──────────────────────────────────────────────────────────


class TestBufferIsolation:
    """
    The endpoint must not mutate any buffer state.

    agent._messages, pm.messages, and pm.all_messages are all unchanged
    before/after the call — messages is a request parameter, not a buffer reference.
    """

    def test_agent_messages_unchanged(self, client, summarize_agent):
        agent = _live_agent(summarize_agent)
        before = len(agent._messages)

        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            _call_summarize(client, summarize_agent)

        assert len(agent._messages) == before, (
            f"agent._messages grew from {before} to {len(agent._messages)} — "
            ":summarize must not touch the active buffer"
        )

    def test_pm_messages_unchanged(self, client, summarize_agent):
        agent = _live_agent(summarize_agent)
        pm = agent.persistence_manager
        before = len(pm.messages)

        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            _call_summarize(client, summarize_agent)

        assert len(pm.messages) == before, (
            f"pm.messages grew from {before} to {len(pm.messages)} — "
            ":summarize must not touch pm.messages"
        )

    def test_pm_all_messages_unchanged(self, client, summarize_agent):
        agent = _live_agent(summarize_agent)
        pm = agent.persistence_manager
        before = len(pm.all_messages)

        with patch("memgpt.memory.create", return_value=_make_mock_response(_CANNED_SUMMARY)):
            _call_summarize(client, summarize_agent)

        assert len(pm.all_messages) == before, (
            f"pm.all_messages grew from {before} to {len(pm.all_messages)} — "
            ":summarize must not touch the recall corpus"
        )


# ── error handling ────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_too_small_buffer_returns_422(self, client, summarize_agent):
        """
        A buffer too small for select_cutoff to find a cutoff (LLMError) → 422.
        Buffer: system message + fewer messages than MESSAGE_SUMMARY_TRUNC_KEEP_N_LAST.
        """
        tiny_buffer = [
            {"role": "system", "content": "System."},
            {"role": "user",   "content": "Hi."},
        ]
        r = client.post(
            f"/agents/{summarize_agent}:summarize",
            json={"messages": tiny_buffer, "total_message_count": 2},
        )
        assert r.status_code == 422, (
            f"expected 422 for buffer too small, got {r.status_code}: {r.text}"
        )

    def test_unknown_agent_404(self, client):
        """Non-resident agent_id returns 404."""
        r = client.post(
            "/agents/nonexistent:summarize",
            json={"messages": _BUFFER, "total_message_count": _TOTAL_MESSAGE_COUNT},
        )
        assert r.status_code == 404
