"""
In-process resident agent registry.

Holds live Agent instances keyed by agent_id (= namespace = agent_config.name).
All access is synchronous; FastAPI's async handlers use run_in_executor if they
need to call blocking Agent methods (deferred to 6a endpoints).
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class AgentRegistry:
    """Dict[agent_id, Agent] with a clean interface."""

    def __init__(self) -> None:
        self._agents: Dict[str, Any] = {}

    # ── read ──────────────────────────────────────────────────────────────

    def get(self, agent_id: str) -> Optional[Any]:
        return self._agents.get(agent_id)

    def __contains__(self, agent_id: str) -> bool:
        return agent_id in self._agents

    def __len__(self) -> int:
        return len(self._agents)

    # ── write ─────────────────────────────────────────────────────────────

    def put(self, agent_id: str, agent: Any) -> None:
        self._agents[agent_id] = agent

    def evict(self, agent_id: str) -> None:
        """Remove an agent from the resident table (e.g. before cold-start reload)."""
        self._agents.pop(agent_id, None)

    # ── introspection ─────────────────────────────────────────────────────

    def agent_ids(self) -> list[str]:
        return list(self._agents.keys())

    def items(self) -> list[tuple[str, Any]]:
        """Snapshot of (agent_id, agent) pairs — used by the shutdown save-all
        sweep so iteration is over a stable list, not the live dict."""
        return list(self._agents.items())


# Sidecar-wide singleton.
registry: AgentRegistry = AgentRegistry()
