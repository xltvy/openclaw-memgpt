"""
Tests for GET /agents/{id}/stats  (§2.2, 6c.6.2).

The endpoint exists to give the TS-side flush-pressure hook (§4.4) a
canonical source for the `total_message_count` it must pass on :summarize
requests. OpenClaw's SessionEntry has no all-time message counter (only
`compactionCount`), so the sidecar is the source of truth via
len(pm.all_messages).

Done-criteria:
  - Resident agent: returns total_message_count = len(pm.all_messages).
  - Boot sequence baseline (preset injects 4 messages on init).
  - Count grows by N after messages:append([... N messages]).
  - Survives a :save/:load round-trip (cold-start arm relevance).
  - 404 if agent is not resident.
"""

from __future__ import annotations

import uuid

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────


def _stats(client, agent_id: str) -> int:
    r = client.get(f"/agents/{agent_id}/stats")
    assert r.status_code == 200, r.text
    return r.json()["total_message_count"]


def _live_agent(agent_id: str):
    """Return the resident Agent so we can read pm.all_messages directly."""
    import sys, os
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    return registry.get(agent_id)


# ── tests ────────────────────────────────────────────────────────────────────


class TestStatsEndpoint:
    def test_returns_boot_sequence_count_on_fresh_agent(self, client, agent_id):
        """
        Fresh agent: pm.all_messages = preset boot sequence (system + bootup
        assistant + login user + initial user ping = 4 by default). Whatever
        the preset's exact count, /stats must match len(pm.all_messages).
        """
        agent = _live_agent(agent_id)
        expected = len(agent.persistence_manager.all_messages)
        assert _stats(client, agent_id) == expected
        # Sanity: boot sequence is non-trivial — without this, the test would
        # pass even if pm.all_messages was empty for some reason.
        assert expected >= 4, f"preset boot sequence should be >=4 messages; got {expected}"

    def test_count_grows_by_appended_count(self, client, agent_id):
        """
        Appending N messages grows the count by exactly N. The host-tracked
        total_message_count on :summarize must reflect the post-append
        reality; this test pins the sidecar's contribution.
        """
        before = _stats(client, agent_id)

        messages = [
            {"role": "user", "content": "first appended"},
            {"role": "assistant", "content": "second appended"},
            {"role": "user", "content": "third appended"},
        ]
        r = client.post(
            f"/agents/{agent_id}/messages:append",
            json={"messages": messages},
        )
        assert r.status_code == 200, r.text

        after = _stats(client, agent_id)
        assert after == before + len(messages), (
            f"expected count to grow by {len(messages)}; got {before} -> {after}"
        )

    def test_count_matches_pm_all_messages_after_multiple_appends(
        self, client, agent_id
    ):
        """
        After several disjoint append batches, /stats == len(pm.all_messages)
        exactly. Cross-checks that no caching or off-by-one creeps in.
        """
        for batch in [
            [{"role": "user", "content": "a"}],
            [
                {"role": "assistant", "content": "b"},
                {"role": "user", "content": "c"},
            ],
            [{"role": "user", "content": "d"}, {"role": "user", "content": "e"}],
        ]:
            r = client.post(
                f"/agents/{agent_id}/messages:append", json={"messages": batch}
            )
            assert r.status_code == 200, r.text

        agent = _live_agent(agent_id)
        assert _stats(client, agent_id) == len(agent.persistence_manager.all_messages)

    def test_404_when_agent_not_resident(self, client):
        """
        Unknown agent_id → 404 (matches the pattern of other GETs on resident
        agents — system_prompt_section, core_memory).
        """
        r = client.get(f"/agents/nonexistent-{uuid.uuid4().hex[:6]}/stats")
        assert r.status_code == 404
        assert "not resident" in r.json()["detail"].lower()

    def test_survives_save_load_round_trip(self, client):
        """
        Save → reload: the post-load pm.all_messages should match what was
        saved. /stats on the rehydrated agent matches the pre-save value.
        Exercises the §2.3 :save/:load surface from the perspective of the
        all-time count — important because the cold-start experiment arm
        depends on this state surviving.
        """
        # Fresh agent so the boot count is clean.
        name = f"stats-roundtrip-{uuid.uuid4().hex[:8]}"
        r = client.post("/agents", json={"name": name, "model": "gpt-4"})
        assert r.status_code == 201, r.text

        # Append two messages, capture the count, save.
        r = client.post(
            f"/agents/{name}/messages:append",
            json={
                "messages": [
                    {"role": "user", "content": "pre-save 1"},
                    {"role": "assistant", "content": "pre-save 2"},
                ]
            },
        )
        assert r.status_code == 200, r.text
        before_save = _stats(client, name)

        r = client.post(f"/agents/{name}:save", json={})
        assert r.status_code == 200, r.text

        # Evict + reload so the :load path actually fires (resident-only
        # :load returns 409 by design — 6a.8).
        import sys, os
        sidecar_dir = os.path.dirname(os.path.dirname(__file__))
        if sidecar_dir not in sys.path:
            sys.path.insert(0, sidecar_dir)
        from registry import registry
        registry.evict(name)

        r = client.post(f"/agents/{name}:load", json={})
        assert r.status_code == 200, r.text

        after_load = _stats(client, name)
        assert after_load == before_save, (
            f"stats should survive save/load: {before_save} -> {after_load}"
        )
