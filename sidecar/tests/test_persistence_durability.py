"""
Tests for the P4 + P5 persistence-durability fixes.

Context: OpenClaw 2026.6.8 does not fire the plugin's per-turn `agent_end`
hook, and in one-shot `--local` mode no `:save` path runs at all — so agents
were left with only a create-time `config.json` and no `agent_state/`. Next
session `:ensure` → `:load` failed ("Cannot load …"), and re-create was blocked
by the config-exists guard — a brick wall.

  P4 — the sidecar saves all resident agents in its lifespan-shutdown sweep
       (`save_all_on_shutdown`), which uvicorn runs on the SIGTERM the sidecar
       receives in BOTH deployment modes. A complementary safety net under the
       §2.3 per-turn-flush model, not a replacement.

  P5 — `:ensure` / `create_agent` gate the on-disk/load-vs-create decision on a
       SAVED state (`agent_state/*.json`), not bare `config.json`, so a
       create-without-save namespace re-creates cleanly instead of bricking.
"""

from __future__ import annotations

import os
import sys
import uuid

import pytest


# ── helpers ───────────────────────────────────────────────────────────────────


def _sidecar_on_path() -> None:
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)


def _evict(agent_id: str) -> None:
    _sidecar_on_path()
    from registry import registry
    registry.evict(agent_id)


def _is_resident(agent_id: str) -> bool:
    _sidecar_on_path()
    from registry import registry
    return agent_id in registry


def _resident_agent(agent_id: str):
    """The live Agent instance for a resident agent (for driving the sweep
    helper directly, scoped to just this agent)."""
    _sidecar_on_path()
    from registry import registry
    agent = registry.get(agent_id)
    assert agent is not None, f"{agent_id} not resident"
    return agent


def _agent_dir(agent_id: str) -> str:
    _sidecar_on_path()
    from memgpt.constants import MEMGPT_DIR
    return os.path.join(MEMGPT_DIR, "agents", agent_id)


def _has_saved_state_on_disk(agent_id: str) -> bool:
    state_dir = os.path.join(_agent_dir(agent_id), "agent_state")
    if not os.path.isdir(state_dir):
        return False
    return any(n.endswith(".json") for n in os.listdir(state_dir))


def _has_config_on_disk(agent_id: str) -> bool:
    return os.path.exists(os.path.join(_agent_dir(agent_id), "config.json"))


def _core_append(client, agent_id: str, name: str, content: str) -> None:
    r = client.post(f"/agents/{agent_id}/core_memory:append",
                    json={"name": name, "content": content})
    assert r.status_code == 200, r.text


# ── P5: config-only (create-without-save) must re-create, not brick ────────────


class TestEnsureConfigOnlyReCreates:
    """A namespace with config.json but no saved agent_state/ (created, never
    :saved, then process restarted) must route :ensure to a clean re-create —
    never to :load (404 "Cannot load") and never to a 409 wall."""

    def _config_only_namespace(self, client) -> str:
        # Create (writes config.json, no save) then evict → config-only on disk.
        ns = f"config-only-{uuid.uuid4().hex[:8]}"
        r = client.post("/agents", json={"name": ns, "model": "gpt-4"})
        assert r.status_code == 201, r.text
        _evict(ns)
        assert not _is_resident(ns)
        assert _has_config_on_disk(ns), "precondition: config.json present"
        assert not _has_saved_state_on_disk(ns), "precondition: no saved state"
        return ns

    def test_ensure_recreates_when_config_only(self, client):
        ns = self._config_only_namespace(client)
        r = client.post(f"/agents/{ns}:ensure", json={})
        assert r.status_code == 200, r.text  # NOT 404 "Cannot load"
        assert r.json()["via"] == "create", (
            "config-only namespace must re-create, not :load"
        )
        assert _is_resident(ns)

    def test_create_endpoint_allows_config_only_overwrite(self, client):
        ns = self._config_only_namespace(client)
        # Direct POST /agents must also succeed (guard gates on saved state now).
        r = client.post("/agents", json={"name": ns, "model": "gpt-4"})
        assert r.status_code == 201, r.text


class TestEnsureSavedStateStillLoads:
    """Regression guard for P5: a genuinely saved agent still takes the :load
    path (via='load'), so the on-disk branch isn't lost when we tightened it."""

    def test_saved_then_evicted_still_loads(self, client):
        ns = f"saved-loads-{uuid.uuid4().hex[:8]}"
        r = client.post("/agents", json={"name": ns, "model": "gpt-4"})
        assert r.status_code == 201, r.text
        assert client.post(f"/agents/{ns}:save").status_code == 200
        assert _has_saved_state_on_disk(ns), "precondition: saved state present"
        _evict(ns)

        r = client.post(f"/agents/{ns}:ensure", json={})
        assert r.status_code == 200, r.text
        assert r.json()["via"] == "load"


# ── P4: shutdown sweep flushes resident agents to disk ─────────────────────────


class TestShutdownSaveSweep:
    """`save_all_on_shutdown` is the durability sweep uvicorn runs on SIGTERM
    (lifespan shutdown). It must flush resident agents that haven't been saved
    yet — the one save path guaranteed to run in one-shot `--local`.

    Tests drive the underlying `_save_agents(resident)` with a CONTROLLED agent
    list (just the test's own agent), not the global registry, so they don't
    sweep-save every other test's accumulated agents or mutate shared state.
    That the wrapper feeds it `registry.items()` is trivial; that the sweep
    actually fires on real SIGTERM shutdown is covered by the live end-to-end
    verification, not a TestClient (whose lifespan only closes at session end).
    """

    def test_sweep_writes_state_for_unsaved_resident_agent(self, client):
        from main import _save_agents

        ns = f"p4-sweep-{uuid.uuid4().hex[:8]}"
        r = client.post("/agents", json={"name": ns, "model": "gpt-4"})
        assert r.status_code == 201, r.text
        _core_append(client, ns, "human", "Lucky number is 4173.")
        # Not saved yet — only config.json on disk.
        assert not _has_saved_state_on_disk(ns), "precondition: unsaved"

        _save_agents([(ns, _resident_agent(ns))])

        assert _has_saved_state_on_disk(ns), (
            "shutdown sweep must write agent_state/ for a resident agent"
        )
        # The pickle the :load path reads must exist too.
        pm_dir = os.path.join(_agent_dir(ns), "persistence_manager")
        assert os.path.isdir(pm_dir) and any(
            n.endswith(".pickle") for n in os.listdir(pm_dir)
        ), "shutdown sweep must write the persistence pickle"

    def test_swept_agent_reloads_with_its_edit(self, client):
        """End-to-end: sweep → evict → :ensure(:load) → the core-memory edit
        survives. Proves the sweep produced a genuinely loadable state."""
        from main import _save_agents

        ns = f"p4-reload-{uuid.uuid4().hex[:8]}"
        assert client.post("/agents", json={"name": ns, "model": "gpt-4"}).status_code == 201
        _core_append(client, ns, "human", "Plant is named Fernie.")
        _save_agents([(ns, _resident_agent(ns))])
        _evict(ns)

        r = client.post(f"/agents/{ns}:ensure", json={})
        assert r.status_code == 200, r.text
        assert r.json()["via"] == "load", "swept agent must reload via :load"
        cm = client.get(f"/agents/{ns}/core_memory").json()
        assert "Fernie" in cm["human"], "swept edit lost on reload"

    def test_sweep_isolates_per_agent_failure(self, client):
        """A failing agent.save() must not abort the sweep — the good agent
        still gets saved, and no exception escapes (shutdown must complete)."""
        from main import _save_agents

        ns = f"p4-isolate-{uuid.uuid4().hex[:8]}"
        assert client.post("/agents", json={"name": ns, "model": "gpt-4"}).status_code == 201
        _core_append(client, ns, "human", "survives the bad neighbour")

        class _Boom:
            def save(self):
                raise RuntimeError("simulated bad agent")

        # Bad agent first, good agent second — must not raise, good one saved.
        _save_agents([("p4-bad", _Boom()), (ns, _resident_agent(ns))])
        assert _has_saved_state_on_disk(ns), "good agent must be saved despite bad neighbour"

    def test_sweep_empty_list_is_noop(self):
        """Empty input → returns cleanly (shutdown must not error)."""
        from main import _save_agents
        _save_agents([])  # must not raise
