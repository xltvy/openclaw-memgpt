"""
Tests for POST /agents/{id}:ensure  (§3.5 composite, Task B).

Three core paths (one per `via` value) plus the F2-through-:ensure assertion
that proves the on-disk path delegates to :load (and not a re-create-from-disk
shortcut that would skip the F2 repair).

The F2 assertion uses the same _post-load append + recall search_ pattern as
6a.8's TestF2RepairThroughSurface — pre-save survival is preserved by pickle
identity and would not exercise F2.
"""

from __future__ import annotations

import os
import sys
import uuid

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────


def _evict(agent_id: str) -> None:
    """Remove the agent from the registry (simulates process restart)."""
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    registry.evict(agent_id)


def _is_resident(agent_id: str) -> bool:
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    return agent_id in registry


def _ensure(client, agent_id: str, body: dict | None = None) -> dict:
    payload = body if body is not None else {}
    r = client.post(f"/agents/{agent_id}:ensure", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def _save(client, agent_id: str) -> dict:
    r = client.post(f"/agents/{agent_id}:save")
    assert r.status_code == 200, r.text
    return r.json()


def _append(client, agent_id: str, messages: list[dict]) -> dict:
    r = client.post(f"/agents/{agent_id}/messages:append", json={"messages": messages})
    assert r.status_code == 200, r.text
    return r.json()


def _recall_search(client, agent_id: str, query: str) -> dict:
    r = client.post(f"/agents/{agent_id}/recall:search", json={"query": query, "page": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _archival_insert(client, agent_id: str, content: str) -> dict:
    r = client.post(f"/agents/{agent_id}/archival:insert", json={"content": content})
    assert r.status_code == 200, r.text
    return r.json()


def _archival_search(client, agent_id: str, query: str) -> dict:
    r = client.post(f"/agents/{agent_id}/archival:search", json={"query": query, "page": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _core_memory(client, agent_id: str) -> dict:
    r = client.get(f"/agents/{agent_id}/core_memory")
    assert r.status_code == 200, r.text
    return r.json()


# ── 1. Resident → via:"resident" ──────────────────────────────────────────────


class TestEnsureResident:
    """
    When an agent is already resident, :ensure returns immediately with
    via='resident' and does not mutate state.
    """

    def test_resident_returns_via_resident(self, client, agent_id):
        # agent_id fixture creates a resident agent via POST /agents (201)
        result = _ensure(client, agent_id)
        assert result["agent_id"] == agent_id
        assert result["via"] == "resident"

    def test_resident_does_not_mutate_archival(self, client, agent_id):
        marker = f"resident-no-mutation-{uuid.uuid4().hex[:8]}"
        _archival_insert(client, agent_id, marker)
        before = _archival_search(client, agent_id, marker)["total"]

        # :ensure on a resident agent should be a no-op
        result = _ensure(client, agent_id)
        assert result["via"] == "resident"

        after = _archival_search(client, agent_id, marker)["total"]
        assert before == after, f":ensure mutated archival: before={before} after={after}"

    def test_resident_body_ignored(self, client, agent_id):
        """The body's persona/human/model are ignored on the resident branch."""
        before = _core_memory(client, agent_id)
        result = _ensure(client, agent_id, body={
            "model": "claude-3-opus",
            "persona": "WRONG PERSONA - should be ignored",
            "human": "WRONG HUMAN - should be ignored",
        })
        assert result["via"] == "resident"
        after = _core_memory(client, agent_id)
        assert before == after, "resident :ensure leaked body into core memory"


# ── 2. On-disk → via:"load"  (delegates to :load; F2 fires) ───────────────────


class TestEnsureLoad:
    """
    When an agent is not resident but has on-disk state, :ensure delegates
    to :load — observable via via='load' AND by the F2 repair firing
    (post-load append findable through recall search).
    """

    @pytest.fixture
    def saved_then_evicted(self, client, agent_id):
        """Create + save + evict (mimics process restart with disk state)."""
        _save(client, agent_id)
        _evict(agent_id)
        assert not _is_resident(agent_id), "evict() failed"
        return agent_id

    def test_on_disk_returns_via_load(self, client, saved_then_evicted):
        result = _ensure(client, saved_then_evicted)
        assert result["agent_id"] == saved_then_evicted
        assert result["via"] == "load"
        assert _is_resident(saved_then_evicted), ":ensure load branch did not register"

    def test_post_ensure_append_findable_via_recall(self, client, saved_then_evicted):
        """
        F2-through-:ensure assertion (mirrors 6a.8 TestF2RepairThroughSurface):
        the on-disk → load path must run LocalStateManager.load, which fires
        the F2 reference-repair. A _post-load_ append is the only thing that
        exercises F2 — pre-save survival is preserved by pickle identity
        regardless of F2.
        """
        _ensure(client, saved_then_evicted)  # via="load"

        token = f"F2-via-ensure-{uuid.uuid4().hex[:12]}"
        _append(client, saved_then_evicted, [{
            "role": "assistant",
            "content": f"marker for the F2 test: {token}",
        }])

        # If F2 didn't fire, the append would land on the diverged _message_logs
        # and recall search would miss the token (returns "No results found.").
        result = _recall_search(client, saved_then_evicted, token)
        assert token in result["formatted"], (
            f"F2 repair did not fire through :ensure → :load — token '{token}' "
            f"missing from recall: {result['formatted']!r}"
        )


# ── 3. Fresh namespace → via:"create" ─────────────────────────────────────────


class TestEnsureCreate:
    """
    When neither resident nor on disk, :ensure delegates to POST /agents
    using body's model/persona/human (defaults when absent).
    """

    def test_create_returns_via_create_and_registers(self, client):
        namespace = f"ensure-create-{uuid.uuid4().hex[:8]}"
        assert not _is_resident(namespace)
        result = _ensure(client, namespace, body={
            "model": "gpt-4",
            "persona": "Test persona for ensure-create.",
            "human": "Test human for ensure-create.",
        })
        assert result["agent_id"] == namespace
        assert result["via"] == "create"
        assert _is_resident(namespace), ":ensure create branch did not register"

        # Core memory should reflect the body
        cm = _core_memory(client, namespace)
        assert cm["persona"] == "Test persona for ensure-create."
        assert cm["human"] == "Test human for ensure-create."

    def test_create_with_empty_body_uses_defaults(self, client):
        """Body fully optional — empty body falls back to POST /agents defaults."""
        namespace = f"ensure-defaults-{uuid.uuid4().hex[:8]}"
        result = _ensure(client, namespace, body={})
        assert result["via"] == "create"
        cm = _core_memory(client, namespace)
        # Default persona/human (per routes/agents.py) are non-empty
        assert cm["persona"]
        assert cm["human"]
        assert "Sam" in cm["persona"], "default persona text not applied"

    def test_create_then_resident_on_second_call(self, client):
        """After create, the same agent is resolved as 'resident' on the next :ensure."""
        namespace = f"ensure-twice-{uuid.uuid4().hex[:8]}"
        first = _ensure(client, namespace)
        assert first["via"] == "create"
        second = _ensure(client, namespace)
        assert second["via"] == "resident"
