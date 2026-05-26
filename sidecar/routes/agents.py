"""
/agents routes — §2.3 lifecycle endpoints.

6a.1: POST /agents  (composite bootstrap — §2.3)
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

# registry is a sidecar-level singleton; safe to import at module level.
# bootstrap.py has already run by the time this module is imported, so all
# memgpt modules are importable here without MEMGPT_DIR ordering concerns.
from registry import registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])

# ── Request / Response models ─────────────────────────────────────────────

class CreateAgentRequest(BaseModel):
    name: str = Field(..., description="Memory namespace / agent_id — maps to agent_config.name")
    model: Optional[str] = Field("gpt-4", description="LLM model identifier passed to AgentConfig")
    persona: Optional[str] = Field(None, description="Persona text written into core memory (persona section)")
    human: Optional[str] = Field(None, description="Human text written into core memory (human section)")


class CreateAgentResponse(BaseModel):
    agent_id: str


# ── Default persona / human text ─────────────────────────────────────────
# Matches what `use_preset` passes when the CLI creates a default agent.

_DEFAULT_PERSONA: str = (
    "The following is a starter persona, and should be expanded as the assistant interacts with the user.\n"
    "I am Sam.\n"
    "I don't just process information, I engage with it. I don't just give answers, I explore with the human."
)
_DEFAULT_HUMAN: str = "This is what Sam knows about the human so far:\n"


# ── POST /agents — §2.3 composite bootstrap ───────────────────────────────

@router.post("", status_code=201, response_model=CreateAgentResponse,
             summary="Create a resident MemGPT agent (composite bootstrap)")
def create_agent(body: CreateAgentRequest) -> CreateAgentResponse:
    """
    COMPOSITE — §2.3.  Four pymemgpt touchpoints:

      1. AgentConfig(...)                           — construct + persist config.json to disk
                                                      (precondition for archival path resolution:
                                                       EmbeddingArchivalMemory keyed off config.name)
      2. LocalStateManager(agent_config)            — creates EmbeddingArchivalMemory(agent_config)
                                                      which resolves the save_agent_index_dir path
                                                      and loads/creates the llama-index VectorStoreIndex
      3. Agent(config, model, system, functions,    — construct in-memory agent container:
               interface, persistence_manager,         initialize_memory (CoreMemory),
               persona_notes, human_notes)             initialize_message_sequence (preset boot sequence)
      4. persistence_manager.init(agent)            — called inside Agent.__init__ (persistence_manager_init=True);
                                                      seeds all_messages + messages from agent._messages,
                                                      creates DummyRecallMemory(message_database=all_messages)

    409 if the namespace is already resident or has a config on disk.
    """
    namespace = body.name
    persona = body.persona or _DEFAULT_PERSONA
    human = body.human or _DEFAULT_HUMAN
    model = body.model or "gpt-4"

    # Guard: already resident
    if namespace in registry:
        raise HTTPException(status_code=409, detail=f"Agent '{namespace}' is already resident")

    # Guard: config on disk (protect against accidental overwrite of existing agent state)
    from memgpt.config import AgentConfig as _AgentConfig
    from memgpt.constants import MEMGPT_DIR as _DIR
    config_path = os.path.join(_DIR, "agents", namespace, "config.json")
    if os.path.exists(config_path):
        raise HTTPException(
            status_code=409,
            detail=f"Agent config already exists at {config_path}. Use :load to reload a persisted agent.",
        )

    logger.info("Creating agent namespace=%s model=%s", namespace, model)

    # ── 1. AgentConfig — saves config.json ───────────────────────────────
    # AgentConfig.__init__ calls self.save() unconditionally; the config
    # snapshot is on disk before EmbeddingArchivalMemory resolves its path.
    from memgpt.config import AgentConfig
    cfg = AgentConfig(name=namespace, persona=persona, human=human, model=model)
    logger.debug("AgentConfig saved to %s", cfg.agent_config_path)

    # ── 2. LocalStateManager — EmbeddingArchivalMemory init ───────────────
    # LocalStateManager.__init__ creates EmbeddingArchivalMemory(agent_config),
    # which resolves cfg.save_agent_index_dir() and loads/creates the
    # llama-index VectorStoreIndex.  recall_memory is None until init().
    from memgpt.persistence_manager import LocalStateManager
    pm = LocalStateManager(cfg)
    logger.debug("LocalStateManager created, archival backend: EmbeddingArchivalMemory")

    # ── 3. Agent construction ─────────────────────────────────────────────
    # Loads the preset function schemas and system prompt text.
    # initialize_memory → CoreMemory(persona, human)
    # initialize_message_sequence → [system, bootup-assistant, login-user, initial-ping]
    # No LLM calls; DummyInterface swallows all output callbacks (loop-inert by construction).
    from memgpt.agent import Agent
    from memgpt.autogen.interface import DummyInterface
    from memgpt.prompts import gpt_functions, gpt_system
    from memgpt.presets import DEFAULT_PRESET

    _functions_names = [
        "send_message", "pause_heartbeats",
        "core_memory_append", "core_memory_replace",
        "conversation_search", "conversation_search_date",
        "archival_memory_insert", "archival_memory_search",
    ]
    available_functions = [
        v for k, v in gpt_functions.FUNCTIONS_CHAINING.items()
        if k in _functions_names
    ]

    # ── 4. persistence_manager.init called inside Agent.__init__ ──────────
    # persistence_manager_init=True (default): Agent.__init__ calls
    # pm.init(self), which seeds all_messages + messages from agent._messages
    # and creates DummyRecallMemory(message_database=all_messages).
    agent = Agent(
        config=cfg,
        model=model,
        system=gpt_system.get_system_text(DEFAULT_PRESET),
        functions=available_functions,
        interface=DummyInterface(),
        persistence_manager=pm,
        persona_notes=persona,
        human_notes=human,
        # persistence_manager_init=True is the default — step 4 fires here
    )

    # Register as resident
    registry.put(namespace, agent)

    logger.info(
        "Agent created and resident: namespace=%s _messages=%d all_messages=%d",
        namespace,
        len(agent._messages),
        len(pm.all_messages),
    )
    return CreateAgentResponse(agent_id=namespace)
