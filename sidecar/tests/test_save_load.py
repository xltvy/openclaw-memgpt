"""
Tests for POST /agents/{id}:save and POST /agents/{id}:load (§2.3, 6a.8).

Four done-criteria:
  1. :save writes to disk — nodes.pkl and persistence pickle exist before any kill.
  2. Cold-start round-trip — :save → evict → :load → pre-save recall + archival intact.
  3. F2 repair through the surface — after :load, messages:append of a new unique token
     is findable via recall:search.  Without F2, the post-load append hits the diverged
     _message_logs and the search misses it.  Pre-save content surviving (assertion 2)
     does NOT exercise this — only a post-load append does (§2.11).
  4. Residency is the default — after :save without eviction the agent is still resident;
     a subsequent endpoint access succeeds without :load, proving the reference-split
     bug stays dormant on the resident arm.
"""

from __future__ import annotations

import glob
import os
import sys
import uuid

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────


def _live_agent(agent_id: str):
    """Return the resident Agent object directly from the sidecar registry."""
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    return registry.get(agent_id)


def _evict(agent_id: str) -> None:
    """Remove the agent from the registry without touching disk (simulates process restart)."""
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    registry.evict(agent_id)


def _save(client, agent_id: str) -> dict:
    r = client.post(f"/agents/{agent_id}:save")
    assert r.status_code == 200, r.text
    return r.json()


def _load(client, agent_id: str) -> dict:
    r = client.post(f"/agents/{agent_id}:load")
    assert r.status_code == 200, r.text
    return r.json()


def _append(client, agent_id: str, messages: list[dict]) -> dict:
    r = client.post(f"/agents/{agent_id}/messages:append", json={"messages": messages})
    assert r.status_code == 200, r.text
    return r.json()


def _archival_insert(client, agent_id: str, content: str) -> dict:
    r = client.post(f"/agents/{agent_id}/archival:insert", json={"content": content})
    assert r.status_code == 200, r.text
    return r.json()


def _recall_search(client, agent_id: str, query: str) -> dict:
    r = client.post(f"/agents/{agent_id}/recall:search", json={"query": query, "page": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _archival_search(client, agent_id: str, query: str) -> dict:
    r = client.post(f"/agents/{agent_id}/archival:search", json={"query": query, "page": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _new_agent(client, prefix: str = "sl") -> str:
    name = f"{prefix}-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


# ── 1. :save writes to disk ───────────────────────────────────────────────────


class TestSaveWritesToDisk:
    """
    Assertion 1: after :save (200), nodes.pkl and the persistence pickle both exist
    on disk before any kill — proving :save genuinely flushed (the persistence model
    means nothing was on disk until this call).
    """

    @pytest.fixture(scope="class")
    def saved_agent(self, client):
        """Create an agent, insert archival content (so nodes has data), then save."""
        agent_id = _new_agent(client, "sl-disk")
        _archival_insert(client, agent_id, "canary archival content for disk-write assertion")
        _save(client, agent_id)
        return agent_id

    def test_save_returns_200_saved_true(self, client, saved_agent):
        """Repeated :save is idempotent; first save already confirmed by fixture."""
        r = client.post(f"/agents/{saved_agent}:save")
        assert r.status_code == 200
        assert r.json()["saved"] is True

    def test_nodes_pkl_exists_after_save(self, client, saved_agent):
        """
        archival.save() is called inside LocalStateManager.save() before the pickle,
        writing nodes.pkl to agent_config.save_agent_index_dir().
        """
        agent = _live_agent(saved_agent)
        nodes_pkl = os.path.join(agent.config.save_agent_index_dir(), "nodes.pkl")
        assert os.path.exists(nodes_pkl), (
            f"nodes.pkl not found at {nodes_pkl} — archival.save() may not have fired"
        )

    def test_persistence_pickle_exists_after_save(self, client, saved_agent):
        """
        LocalStateManager.save() writes {timestamp}.persistence.pickle to
        agent_config.save_persistence_manager_dir().
        """
        agent = _live_agent(saved_agent)
        pm_dir = agent.config.save_persistence_manager_dir()
        pickles = glob.glob(os.path.join(pm_dir, "*.persistence.pickle"))
        assert pickles, (
            f"no *.persistence.pickle in {pm_dir} — LocalStateManager.save() may not have fired"
        )


# ── 2. Cold-start round-trip ──────────────────────────────────────────────────


class TestColdStartRoundTrip:
    """
    Assertion 2: :save → evict/kill the resident instance → :load → pre-save recall
    and pre-save archival content both intact and searchable via the HTTP endpoints.
    """

    RECALL_TOKEN = "XSALMONBERRY"   # unique; absent from boot messages
    ARCHIVAL_TOKEN = "XJACKFRUIT"   # unique; absent from archival at creation

    @pytest.fixture(scope="class")
    def loaded_agent(self, client):
        """
        Full cold-start sequence:
          1. Create agent
          2. Seed recall (messages:append) and archival (archival:insert)
          3. :save → flush to disk
          4. evict → remove from registry (simulates process restart)
          5. :load → rehydrate from disk
        """
        agent_id = _new_agent(client, "sl-roundtrip")

        # Seed pre-save recall content
        _append(client, agent_id, [{"role": "user", "content": f"{self.RECALL_TOKEN} pre-save message"}])

        # Seed pre-save archival content
        _archival_insert(client, agent_id, f"{self.ARCHIVAL_TOKEN} pre-save archival passage")

        _save(client, agent_id)
        _evict(agent_id)

        # Cold-start rehydration
        resp = _load(client, agent_id)
        assert resp["loaded_from"] == "cold_start"
        assert resp["agent_id"] == agent_id

        return agent_id

    def test_pre_save_recall_findable_after_load(self, client, loaded_agent):
        """Pre-save recall message is findable via recall:search after cold-start load."""
        r = _recall_search(client, loaded_agent, self.RECALL_TOKEN)
        assert r["formatted"] != "No results found.", (
            "Pre-save recall message not found after :load — "
            "recall state may not have been persisted or loaded correctly"
        )
        assert r["total"] >= 1

    def test_pre_save_archival_findable_after_load(self, client, loaded_agent):
        """Pre-save archival passage is findable via archival:search after cold-start load."""
        r = _archival_search(client, loaded_agent, self.ARCHIVAL_TOKEN)
        assert r["formatted"] != "No results found.", (
            "Pre-save archival passage not found after :load — "
            "nodes.pkl may not have been written or loaded correctly"
        )
        assert r["total"] >= 1

    def test_load_returns_cold_start(self, client):
        """
        :load on an already-resident agent returns 409 (cold-start-only guard).
        The loaded_agent fixture already validated the 200 path; this confirms the guard.
        """
        agent_id = _new_agent(client, "sl-409check")
        r = client.post(f"/agents/{agent_id}:load")
        assert r.status_code == 409, (
            f"Expected 409 for already-resident agent, got {r.status_code}"
        )


# ── 3. F2 repair through the HTTP surface ────────────────────────────────────


class TestF2RepairThroughSurface:
    """
    Assertion 3: F2 repair (recall_memory._message_logs = all_messages after unpickle)
    confirmed through the HTTP surface.

    After :load, messages:append writes via pm.all_messages.  Without the repair,
    DummyRecallMemory._message_logs still points to the stale pre-load list, so
    recall:search misses messages appended after load.  With the repair the reference
    is restored unconditionally, so the append is immediately findable.

    This is F2's test_recall_reference_repair_via_load one level up over HTTP.
    Pre-save content surviving (assertion 2) does NOT exercise this path — only a
    post-load append reveals whether the repair is in effect.
    """

    POST_LOAD_TOKEN = "XSTARFRUIT_F2"   # unique; appended only after :load

    @pytest.fixture(scope="class")
    def f2_agent(self, client):
        """
        Sequence: create → :save → evict → :load → (return, leave post-load append
        to the test methods so they explicitly exercise the F2 path).
        """
        agent_id = _new_agent(client, "sl-f2")
        _save(client, agent_id)
        _evict(agent_id)
        _load(client, agent_id)
        return agent_id

    def test_post_load_append_findable_via_recall(self, client, f2_agent):
        """
        Append a new unique token AFTER :load and confirm recall:search finds it.

        This is the load-bearing F2 assertion: LocalStateManager.load() re-points
        recall_memory._message_logs = all_messages (fork commit 109817c), so
        DummyRecallMemory.text_search queries the live list that pm.append_to_messages
        extends.  Without the repair _message_logs would still reference the stale
        pre-load list and the search would return "No results found."
        """
        _append(client, f2_agent, [{"role": "user", "content": f"{self.POST_LOAD_TOKEN} post-load message"}])

        r = _recall_search(client, f2_agent, self.POST_LOAD_TOKEN)
        assert r["formatted"] != "No results found.", (
            "Post-load recall message NOT found — F2 repair "
            "(recall_memory._message_logs = all_messages) may not be in effect. "
            "Check LocalStateManager.load in the fork (dev branch, commit 109817c)."
        )
        assert r["total"] >= 1, f"expected total ≥ 1, got {r['total']}"


# ── 4. Residency is the default ───────────────────────────────────────────────


class TestResidencyIsDefault:
    """
    Assertion 4: after :save, a subsequent access WITHOUT eviction finds the agent
    still resident — no :load, no unpickle — proving the reference-split bug stays
    dormant on the resident arm.

    §2.10: the sidecar holds agents resident across sessions. :load is cold-start-only.
    Normal session boundaries trigger :save but not :load; recall search is safe on
    the resident arm because _message_logs and all_messages were never unpickled.
    """

    @pytest.fixture(scope="class")
    def resident_after_save(self, client):
        """Create an agent and save it; do NOT evict."""
        agent_id = _new_agent(client, "sl-resident")
        _save(client, agent_id)
        return agent_id

    def test_agent_still_resident_after_save(self, client, resident_after_save):
        """
        :save does not evict the agent. The registry entry is intact after :save.
        """
        agent = _live_agent(resident_after_save)
        assert agent is not None, (
            "Agent not in registry after :save — :save must not evict the resident agent"
        )

    def test_second_access_does_not_require_load(self, client, resident_after_save):
        """
        A recall:search after :save succeeds without any :load call — the agent is
        served from the registry, not rehydrated from disk.  This proves the reference-
        split bug (recall_memory._message_logs diverging from all_messages) stays
        dormant: the pickle is never unpickled on the resident arm.
        """
        r = client.post(
            f"/agents/{resident_after_save}/recall:search",
            json={"query": "the", "page": 0},  # broad query; boot messages will match
        )
        assert r.status_code == 200, (
            f"recall:search returned {r.status_code} after :save without :load — "
            "agent may have been unexpectedly evicted"
        )

    def test_load_409_on_resident_agent(self, client, resident_after_save):
        """
        :load on a resident agent returns 409 — the cold-start-only guard.
        This reinforces that the resident arm never takes the :load path.
        """
        r = client.post(f"/agents/{resident_after_save}:load")
        assert r.status_code == 409, (
            f"Expected 409 (agent is resident), got {r.status_code}"
        )
