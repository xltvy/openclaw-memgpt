"""
Tests for POST /agents/{id}/messages:append  (§2.7, 6a.6).

Done-criteria:
- Appended messages land in pm.all_messages (the recall corpus).
- agent._messages (the active buffer, OpenClaw's responsibility) is NOT grown.
- Each message written to all_messages carries a get_local_time() timestamp.
- Appended messages are findable via recall:search.
- Adversarial-content round-trip: seed delimiter-heavy content ('buy "Adidas",
  not [Nike] — see results (page 1) of the catalog') via messages:append (the
  real write path), confirm it surfaces verbatim in recall:search and that
  total/num_pages are not corrupted (closes the loop that 6a.5 TestAdversarialContent
  left open by bypassing the write path with direct pm.all_messages.append).

Layer-cut note (§2.1/§2.7):
  LocalStateManager.append_to_messages adds timestamps and extends BOTH pm.messages
  and pm.all_messages — pm.messages is the pm's internal shadow copy of the active
  buffer, separate from agent._messages.  The test asserts agent._messages is unchanged,
  not pm.messages.
"""

from __future__ import annotations

import uuid

import pytest

_UNIQUE = "XWOMBAT"  # absent from boot messages; unique to this test module
_ADVERSARIAL = 'buy "Adidas", not [Nike] — see results (page 1) of the catalog'


# ── helpers ──────────────────────────────────────────────────────────────────


def _append(client, agent_id: str, messages: list[dict]) -> dict:
    r = client.post(f"/agents/{agent_id}/messages:append", json={"messages": messages})
    assert r.status_code == 200, r.text
    return r.json()


def _search(client, agent_id: str, query: str, page: int = 0) -> dict:
    r = client.post(
        f"/agents/{agent_id}/recall:search",
        json={"query": query, "page": page},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _live_agent(agent_id: str):
    """Return the resident Agent object from the sidecar registry."""
    import sys, os
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    return registry.get(agent_id)


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def append_agent(client):
    """One agent shared across the module; all tests append into it."""
    name = f"append-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


# ── basic contract ────────────────────────────────────────────────────────────


class TestMessagesAppend:
    def test_returns_appended_count(self, client, append_agent):
        """Response carries the count of messages passed in the body."""
        msgs = [
            {"role": "user",      "content": f"{_UNIQUE} hello"},
            {"role": "assistant", "content": f"{_UNIQUE} world"},
        ]
        r = _append(client, append_agent, msgs)
        assert r["appended"] == 2

    def test_messages_land_in_all_messages(self, client, append_agent):
        """
        Messages appended via the endpoint appear in pm.all_messages.
        Verified by counting: the unique token appears in recall:search results.
        """
        r = _search(client, append_agent, _UNIQUE)
        assert r["formatted"] != "No results found.", (
            "appended messages not found in recall — not in all_messages"
        )
        assert r["total"] >= 2, f"expected ≥2 seeded messages, got total={r['total']}"

    def test_agent_active_buffer_unchanged(self, client, append_agent):
        """
        agent._messages (the active conversation buffer) must NOT grow.

        LocalStateManager.append_to_messages extends pm.messages (the pm's shadow
        copy) but does not touch agent._messages.  Snapshot len before and after
        a fresh append to confirm this.
        """
        agent = _live_agent(append_agent)
        before = len(agent._messages)

        _append(client, append_agent, [{"role": "user", "content": f"{_UNIQUE} extra"}])

        after = len(agent._messages)
        assert after == before, (
            f"agent._messages grew from {before} to {after} — "
            "messages:append must call pm.append_to_messages, not Agent.append_to_messages"
        )

    def test_appended_messages_carry_timestamp(self, client, append_agent):
        """
        Each entry written to pm.all_messages must have a 'timestamp' key
        (added by LocalStateManager.append_to_messages via get_local_time()).
        """
        agent = _live_agent(append_agent)
        pm = agent.persistence_manager

        # Snapshot the tail of all_messages before appending
        before_len = len(pm.all_messages)

        _append(client, append_agent, [{"role": "user", "content": f"{_UNIQUE} ts-check"}])

        new_entries = pm.all_messages[before_len:]
        assert len(new_entries) == 1, f"expected 1 new entry, got {len(new_entries)}"
        assert "timestamp" in new_entries[0], (
            f"no 'timestamp' key in appended entry: {new_entries[0]!r}"
        )
        assert new_entries[0]["timestamp"], "timestamp is empty/falsy"

    def test_unknown_agent_404(self, client):
        """Non-resident agent_id returns 404."""
        r = client.post(
            "/agents/nonexistent-agent/messages:append",
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        assert r.status_code == 404


# ── adversarial-content round-trip ───────────────────────────────────────────


@pytest.fixture(scope="module")
def adversarial_append_agent(client):
    """
    Separate agent for the adversarial round-trip test.  Uses the real write
    path (messages:append endpoint) rather than direct pm manipulation, closing
    the loop left open by 6a.5 TestAdversarialContent.
    """
    name = f"adv-append-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    agent_id = r.json()["agent_id"]

    _append(client, agent_id, [{"role": "user", "content": _ADVERSARIAL}])

    return agent_id


class TestAdversarialAppendRoundTrip:
    """
    Adversarial content seeded via messages:append (the real write path).

    6a.5 TestAdversarialContent proved the parse survives delimiter-heavy content,
    but seeded directly into pm.all_messages bypassing the endpoint.  These tests
    confirm the full path: endpoint write → pm.all_messages → recall:search parse.
    """

    def test_adversarial_message_surfaces(self, client, adversarial_append_agent):
        """Adversarial content written via messages:append is found by recall:search."""
        r = _search(client, adversarial_append_agent, "Adidas")
        assert r["formatted"] != "No results found.", (
            "adversarial message not found — messages:append may not have written to all_messages"
        )
        assert r["total"] >= 1

    def test_adversarial_content_round_trips_verbatim(self, client, adversarial_append_agent):
        """The full adversarial string is returned verbatim in results."""
        r = _search(client, adversarial_append_agent, "Adidas")
        assert any(_ADVERSARIAL in entry for entry in r["results"]), (
            f"adversarial content not found verbatim in results: {r['results']!r}"
        )

    def test_total_not_corrupted_by_delimiter_content(self, client, adversarial_append_agent):
        """
        total/num_pages are not corrupted by delimiter-heavy content in the message.

        The prefix regex (_RECALL_PREF_RE) is anchored at the start of the formatted
        string; the 'results (page 1)' substring inside the message content cannot
        confuse M/P extraction.  A corrupted total would surface as 0 here.
        """
        r = _search(client, adversarial_append_agent, "Adidas")
        assert r["total"] >= 1, (
            f"total={r['total']} — prefix regex may be confused by delimiter content"
        )

    def test_results_list_nonempty_after_append(self, client, adversarial_append_agent):
        """
        results list must be non-empty — proves json.loads succeeded on the
        array portion of the formatted string after messages:append write path.
        """
        r = _search(client, adversarial_append_agent, "Adidas")
        assert len(r["results"]) >= 1, (
            "results empty — json.loads may have raised JSONDecodeError on "
            "delimiter-heavy content written through the real append path"
        )
