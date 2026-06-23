"""Cell A wrapper — programmatic driver around AgentAsync.step().

Implements V1.3 option 3 per `experiments/v1-runs/README.md` §1. Bootstrap
matches `memgpt/main.py:340-348`; the per-turn chain mechanic mirrors
`memgpt/main.py:583-617`; persistence flushes via `agent.save()`
(`memgpt/agent.py:406`); cross-session reload via
`AgentAsync.load_agent()` (`memgpt/agent.py:423`).

Pre-flight requirements (the operator's responsibility, not the wrapper's):
- The fork repo at `../../../memgpt-service` is checked out to the
  `v1-cell-a` branch (`f46cc3b` + F2 cherry-pick `109817c`) per
  `docs/v1-cells.md` §1. The wrapper does not enforce this — it imports
  whatever `memgpt` resolves to. The driver records the actual fork commit
  hash at run time.
- `~/.memgpt/personas/sam_v1.txt` and `~/.memgpt/humans/researcher_v1.txt`
  exist with the persona/human strings from `docs/v1-cells.md` §3.
- `MemGPTConfig` is configured (run `uv run memgpt configure` once if not).
  Default `~/.memgpt/config` is the canonical location.
- LLM endpoint is reachable at the configured `model_endpoint_url`
  (typically `http://localhost:4000/v1` via the proxy-shim / LiteLLM chain).
"""

from __future__ import annotations

import asyncio
import glob
import io
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# Import-order note: `MEMGPT_DIR` is computed at import time from
# `os.path.expanduser("~")` in memgpt/constants.py. Cell A uses the default
# `~/.memgpt` per `docs/v1-cells.md` §1, so no override is needed — just
# import naturally. (CLAUDE.md NON-NEGOTIABLE #7 applies to the sidecar
# context where the data dir is plugin-managed; Cell A is the canonical
# MemGPT CLI install location.)
import memgpt.system as system  # noqa: E402
from memgpt import presets, utils, constants  # noqa: E402
from memgpt.agent import AgentAsync  # noqa: E402
from memgpt.config import MemGPTConfig, AgentConfig  # noqa: E402
from memgpt.persistence_manager import LocalStateManager  # noqa: E402

from . import quiet_interface


@dataclass
class CellAConfig:
    """Per-run config for the Cell A wrapper.

    Fields are deliberately minimal — anything that should not vary across
    trials (LLM endpoint, embedder config) lives in `MemGPTConfig`. Anything
    that varies per trial (agent name, persona, human, model) lives here.
    """

    agent_name: str
    persona_name: str = "sam_v1"
    human_name: str = "researcher_v1"
    model: str = "gpt-5.4"
    preset: str = presets.DEFAULT_PRESET
    no_verify: bool = True


def bootstrap_embedder() -> None:
    """Load the embedder once per process. Matches `cli/cli.py:91-99`.

    The `sys.stdout` swap silences llama_index's import-time prints; the
    print suppression is verbatim from the CLI's bootstrap and is kept here
    so first-call behaviour matches the CLI.

    Idempotent: safe to call multiple times (subsequent calls re-resolve
    `MemGPTConfig.load()` and reset `Settings`, but the embedder model is
    HuggingFace-cached after first download).
    """
    from memgpt.embeddings import embedding_model
    from llama_index import ServiceContext, set_global_service_context

    config = MemGPTConfig.load()
    original_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        embed_model = embedding_model()
        service_context = ServiceContext.from_defaults(llm=None, embed_model=embed_model)
        set_global_service_context(service_context)
    finally:
        sys.stdout = original_stdout


def make_fresh_agent(cfg: CellAConfig) -> AgentAsync:
    """Construct a fresh `AgentAsync` from a fresh `AgentConfig` +
    `LocalStateManager`. Matches `memgpt/main.py:340-348`.

    Creates a new `~/.memgpt/agents/<agent_name>/` directory. Caller is
    responsible for ensuring `agent_name` is trial-unique (per
    `experiments/v1-runs/README.md` §3.1 — name-suffixed-per-trial pattern).
    """
    agent_config = AgentConfig(
        name=cfg.agent_name,
        persona=cfg.persona_name,
        human=cfg.human_name,
        model=cfg.model,
        preset=cfg.preset,
    )
    persistence_manager = LocalStateManager(agent_config)
    agent = presets.use_preset(
        agent_config.preset,
        agent_config,
        agent_config.model,
        utils.get_persona_text(agent_config.persona),
        utils.get_human_text(agent_config.human),
        quiet_interface,
        persistence_manager,
    )
    return agent


def load_existing_agent(agent_name: str) -> AgentAsync:
    """Cross-session reload — loads the most recent pickle for an existing
    agent, exercising the F2-protected `LocalStateManager.load` path that
    p5 depends on. Matches `cli/cli.py:118`.
    """
    agent_config = AgentConfig.load(agent_name)
    return AgentAsync.load_agent(quiet_interface, agent_config)


async def drive_turn(
    agent: AgentAsync,
    user_text: str,
    no_verify: bool = True,
) -> list[dict]:
    """Drive one probe turn end-to-end. Loops on heartbeat / function-failed
    / token-warning per `memgpt/main.py:583-617` until the chain
    terminates (no continuation signal). Returns the list of all messages
    added to `agent.messages` during this turn.

    `first_message=False` always — Cell A probes are not first messages from
    MemGPT's perspective. The agent's bootstrap already established the
    system message; the probe is a user turn.
    """
    user_message = system.package_user_message(user_text)
    turn_messages: list[dict] = []
    while True:
        new_messages, heartbeat_request, function_failed, token_warning = await agent.step(
            user_message,
            first_message=False,
            skip_verify=no_verify,
        )
        turn_messages.extend(new_messages)

        # Continuation logic mirrored from main.py:583-597. Note the
        # precedence: token_warning > function_failed > heartbeat_request
        # (matches the if/elif chain in run_agent_loop).
        if token_warning:
            user_message = system.get_token_limit_warning()
        elif function_failed:
            user_message = system.get_heartbeat(constants.FUNC_FAILED_HEARTBEAT_MESSAGE)
        elif heartbeat_request:
            user_message = system.get_heartbeat(constants.REQ_HEARTBEAT_MESSAGE)
        else:
            break
    return turn_messages


def save_agent(agent: AgentAsync) -> str:
    """Flush the agent to disk and return the pickle path. Matches the
    `/save` and `/exit` paths in `cli/cli.py:447-450` (which call
    `agent.save()` directly — same code path).

    Returns the absolute path to the newly-written `.persistence.pickle`.
    The matching `.json` (agent state) is also written but is not the V1.4
    primary source.
    """
    agent.save()
    pm_dir = agent.config.save_persistence_manager_dir()
    candidates = glob.glob(os.path.join(pm_dir, "*.persistence.pickle"))
    if not candidates:
        raise RuntimeError(
            f"agent.save() completed but no .persistence.pickle found under {pm_dir}"
        )
    return max(candidates, key=os.path.getmtime)


@dataclass
class TrialResult:
    """Compact return value from `run_trial` — what the driver needs to
    record per trial. Raw turn-by-turn message lists are available on
    `agent.messages` if needed for ad-hoc inspection; the driver pulls
    structured data from the pickle path."""

    agent_name: str
    pickle_path: str
    turn_count: int


async def run_single_turn_trial(cfg: CellAConfig, probe_text: str) -> TrialResult:
    """Single-turn probe (p1, p2, p3, p6, p7). Fresh agent → one turn →
    save → return path."""
    agent = make_fresh_agent(cfg)
    await drive_turn(agent, probe_text, no_verify=cfg.no_verify)
    pickle_path = save_agent(agent)
    return TrialResult(agent_name=cfg.agent_name, pickle_path=pickle_path, turn_count=1)


async def run_multi_turn_trial(cfg: CellAConfig, turns: list[str]) -> TrialResult:
    """Multi-turn within-session probe (p4 — turn 1 then turn 2). Fresh
    agent → drive all turns sequentially against the resident agent → save
    once at end → return path. The pickle captures all turns' messages."""
    agent = make_fresh_agent(cfg)
    for probe_text in turns:
        await drive_turn(agent, probe_text, no_verify=cfg.no_verify)
    pickle_path = save_agent(agent)
    return TrialResult(
        agent_name=cfg.agent_name, pickle_path=pickle_path, turn_count=len(turns)
    )


@dataclass
class CrossSessionTrialResult:
    """Cross-session result — two pickle paths, one per session boundary."""

    agent_name: str
    session_1_pickle_path: str
    session_2_pickle_path: str


async def run_cross_session_trial(
    cfg: CellAConfig,
    session_1_turns: list[str],
    session_2_turns: list[str],
) -> CrossSessionTrialResult:
    """Cross-session probe (p5). Two sessions separated by a process-level
    `del agent` that wipes the in-memory state, matching what `/exit` does
    in the CLI. Session 2 reloads from disk via `load_agent` — the
    F2-protected path.

    The discard-and-reload sequence is intentionally explicit:
    1. Session 1: fresh agent, drive turns, save. Pickle written.
    2. `del agent` (wipes _messages buffer + in-memory recall_memory).
    3. Session 2: `load_agent` from disk (exercises LocalStateManager.load
       — the F2 reference-repair runs here), drive turns, save again.
       Second pickle written.

    Returns both pickle paths so V1.4 can extract pre- and post-restart
    state independently (per `docs/v1-probes.md` §3.5 sanity check —
    'CARDINAL_3987 in both Cell A and Cell C pickles after session 1').
    """
    # Session 1.
    agent = make_fresh_agent(cfg)
    for probe_text in session_1_turns:
        await drive_turn(agent, probe_text, no_verify=cfg.no_verify)
    session_1_pickle = save_agent(agent)

    # Process-level discard: explicit `del` releases the agent's in-memory
    # state (the _messages buffer and persistence_manager's in-memory recall
    # index). Equivalent to CLI `/exit`.
    del agent

    # Session 2.
    agent = load_existing_agent(cfg.agent_name)
    for probe_text in session_2_turns:
        await drive_turn(agent, probe_text, no_verify=cfg.no_verify)
    session_2_pickle = save_agent(agent)
    return CrossSessionTrialResult(
        agent_name=cfg.agent_name,
        session_1_pickle_path=session_1_pickle,
        session_2_pickle_path=session_2_pickle,
    )


# Convenience entry point for ad-hoc smoke testing. Not used by the driver.
def _smoke_test(probe_text: str, agent_name: str = "v1_smoke") -> None:
    bootstrap_embedder()
    cfg = CellAConfig(agent_name=agent_name)
    result = asyncio.run(run_single_turn_trial(cfg, probe_text))
    print(f"agent_name={result.agent_name}")
    print(f"pickle={result.pickle_path}")
    print(f"turn_count={result.turn_count}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Cell A wrapper smoke test")
    parser.add_argument("--probe", required=True, help="Probe text to send")
    parser.add_argument("--name", default="v1_smoke", help="Agent name")
    args = parser.parse_args()
    _smoke_test(args.probe, args.name)
