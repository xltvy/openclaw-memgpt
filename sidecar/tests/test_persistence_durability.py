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


# ── b2: corrupt/truncated saved state degrades to re-create (no 500) ───────────


def _latest_pickle_path(agent_id: str) -> str:
    pm = os.path.join(_agent_dir(agent_id), "persistence_manager")
    picks = sorted(n for n in os.listdir(pm) if n.endswith(".pickle"))
    assert picks, f"no pickle for {agent_id}"
    return os.path.join(pm, picks[-1])


class TestCorruptStateRecovery:
    """A truncated/empty persistence pickle (e.g. a shutdown save interrupted
    mid-write) must NOT 500. `:ensure` degrades to a clean re-create; `:load`
    surfaces a 404, not an unhandled traceback. Defense-in-depth under b1."""

    def _saved_then_evicted(self, client) -> str:
        ns = f"corrupt-{uuid.uuid4().hex[:8]}"
        assert client.post("/agents", json={"name": ns, "model": "gpt-4"}).status_code == 201
        _core_append(client, ns, "human", "marker before corruption")
        assert client.post(f"/agents/{ns}:save").status_code == 200
        assert _has_saved_state_on_disk(ns), "precondition: real saved state"
        _evict(ns)
        return ns

    def test_zero_byte_pickle_recreates_via_ensure(self, client):
        ns = self._saved_then_evicted(client)
        open(_latest_pickle_path(ns), "wb").close()  # truncate to 0 bytes

        r = client.post(f"/agents/{ns}:ensure", json={})
        assert r.status_code == 200, r.text  # NOT 500
        assert r.json()["via"] == "create", "0-byte pickle must re-create, not :load"
        assert _is_resident(ns)

    def test_midpoint_truncated_pickle_recreates_via_ensure(self, client):
        ns = self._saved_then_evicted(client)
        p = _latest_pickle_path(ns)
        with open(p, "rb") as f:
            data = f.read()
        with open(p, "wb") as f:
            f.write(data[: max(1, len(data) // 2)])  # non-empty but truncated

        r = client.post(f"/agents/{ns}:ensure", json={})
        assert r.status_code == 200, r.text  # NOT 500
        assert r.json()["via"] == "create", "truncated pickle must re-create, not 500"
        assert _is_resident(ns)

    def test_load_on_corrupt_pickle_returns_404_not_500(self, client):
        ns = self._saved_then_evicted(client)
        p = _latest_pickle_path(ns)
        with open(p, "rb") as f:
            data = f.read()
        with open(p, "wb") as f:
            f.write(data[: max(1, len(data) // 2)])

        r = client.post(f"/agents/{ns}:load", json={})
        assert r.status_code == 404, f"corrupt pickle must 404, got {r.status_code}: {r.text}"

    def test_zero_byte_pickle_not_counted_as_saved_state(self, client):
        """`:ensure` re-create path also means direct create succeeds (the
        0-byte pickle isn't a 409-blocking 'saved state')."""
        ns = self._saved_then_evicted(client)
        open(_latest_pickle_path(ns), "wb").close()
        _evict(ns) if _is_resident(ns) else None
        r = client.post("/agents", json={"name": ns, "model": "gpt-4"})
        assert r.status_code == 201, r.text
