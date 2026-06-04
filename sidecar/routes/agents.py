"""
/agents routes — §2.3 lifecycle endpoints.

6a.1: POST /agents  (composite bootstrap — §2.3)
6a.2: GET  /agents/{id}/system_prompt_section  (§2.4)
6a.3: POST /agents/{id}/core_memory:append  (§2.4)
      POST /agents/{id}/core_memory:replace  (§2.4)
      GET  /agents/{id}/core_memory           (§2.4)
6a.4: POST /agents/{id}/archival:insert  (§2.5)
      POST /agents/{id}/archival:search   (§2.5)
6a.5: POST /agents/{id}/recall:search       (§2.6)
      POST /agents/{id}/recall:search_date  (§2.6)
6a.6: POST /agents/{id}/messages:append    (§2.7)
6a.7: POST /agents/{id}:summarize          (§2.8)
6a.8: POST /agents/{id}:save               (§2.3)
      POST /agents/{id}:load               (§2.3)
TaskB POST /agents/{id}:ensure             (§3.5 composite — resident | load | create)
6c.6.2: GET  /agents/{id}/stats            (§2.2 — host-tracked total_message_count provenance)
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

# registry is a sidecar-level singleton; safe to import at module level.
# bootstrap.py has already run by the time this module is imported, so all
# memgpt modules are importable here without MEMGPT_DIR ordering concerns.
from registry import registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])

# ── Request / Response models ─────────────────────────────────────────────

class OkResponse(BaseModel):
    ok: bool = True


class CoreMemoryAppendRequest(BaseModel):
    name: Literal["persona", "human"] = Field(..., description="Memory section: 'persona' or 'human'")
    content: str = Field(..., description="Text to append")


class CoreMemoryReplaceRequest(BaseModel):
    name: Literal["persona", "human"] = Field(..., description="Memory section: 'persona' or 'human'")
    old_content: str = Field(..., description="Exact substring to replace")
    new_content: str = Field(..., description="Replacement text")


class CoreMemoryResponse(BaseModel):
    persona: str
    human: str


class RecallSearchRequest(BaseModel):
    query: str = Field(..., description="Substring search query")
    page: int = Field(0, ge=0, description="Page number (0-indexed)")


class RecallSearchDateRequest(BaseModel):
    # Parameter names confirmed against gpt_functions.FUNCTIONS_CHAINING (S0.2/§2.6):
    # "recall_memory_search_date" / "conversation_search_date" schemas both use
    # start_date / end_date in 'YYYY-MM-DD' format.
    start_date: str = Field(..., description="Start of date range, format 'YYYY-MM-DD'")
    end_date: str = Field(..., description="End of date range, format 'YYYY-MM-DD'")
    page: int = Field(0, ge=0, description="Page number (0-indexed)")


class RecallSearchResponse(BaseModel):
    formatted: str = Field(..., description="Verbatim LLM-facing result string from Agent.recall_memory_search*")
    results: List[str] = Field(..., description="Per-result strings from the formatted JSON array; structured, for verbose observability")
    total: int = Field(..., description="Grand total of matches (DummyRecallMemory returns len(all_matches), not len(paged_slice) — unlike archival)")
    page: int
    num_pages: int


class ArchivalInsertRequest(BaseModel):
    content: str = Field(..., description="Text to embed and insert into archival memory")


class ArchivalInsertResponse(BaseModel):
    ok: bool = True
    passages: int = Field(..., description="Number of chunks created; for verbose observability")


class ArchivalSearchRequest(BaseModel):
    query: str = Field(..., description="Semantic search query")
    page: int = Field(0, ge=0, description="Page number (0-indexed)")


class ArchivalSearchResponse(BaseModel):
    formatted: str = Field(..., description="Verbatim LLM-facing result string from Agent.archival_memory_search")
    results: List[str] = Field(..., description="Passage texts; structured, for verbose observability")
    total: int
    page: int
    num_pages: int


class SystemPromptSectionResponse(BaseModel):
    section: str = Field(..., description="Full rendered system-prompt memory section (verbatim construct_system_with_memory output)")
    static: str = Field(..., description="Base system prompt — does not change across turns; safe to cache")
    dynamic: str = Field(..., description="Memory metadata + persona/human blocks — changes on every core-memory edit")


class StatsResponse(BaseModel):
    """
    6c.6.2 — provenance for the host-passed `total_message_count` on
    :summarize requests. OpenClaw's SessionEntry has no all-time message
    counter (only `compactionCount`); the sidecar is the canonical place
    to read it because pm.all_messages IS the running record. Returning a
    typed object (rather than a bare int) so future stats — recall corpus
    size, archival passage count, last-saved timestamp — can extend the
    response without a new endpoint per metric.
    """
    total_message_count: int = Field(
        ...,
        description="len(pm.all_messages) — running all-time message count tracked by the sidecar; the host-passed total_message_count on :summarize requests",
    )


class SummarizeRequest(BaseModel):
    # Full active buffer, pymemgpt-v0-shaped (normalised TS-side, §3.7).
    # messages[0] must be the system message (required by select_cutoff).
    messages: List[dict] = Field(..., description="Full active buffer; messages[0] must be the system message")
    # Running total the host (OpenClaw) tracks — equals messages_total in native MemGPT.
    # Required because the sidecar cannot derive it from buffer length after prior summarisations.
    total_message_count: int = Field(..., description="Running all-time message count tracked by the host")
    # Informational only; the operative cutoff threshold is MESSAGE_SUMMARY_TRUNC_TOKEN_FRAC.
    token_budget: int = Field(8000, description="Informational token budget; operative threshold is MemGPT's MESSAGE_SUMMARY_WARNING_TOKENS")


class SummarizeResponse(BaseModel):
    cutoff: int = Field(..., description="Index into messages where the summarised prefix ends; messages[1:cutoff] was summarised")
    summary: str = Field(..., description="LLM-generated first-person summary of messages[1:cutoff]")
    summary_length: int = Field(..., description="Number of messages summarised (len(messages[1:cutoff])); appears in the packaged preamble")
    hidden_message_count: int = Field(..., description="total_message_count - len(messages[cutoff:]); messages hidden from the LLM's view")
    total_message_count: int = Field(..., description="Passed through from the request; all-time message count")
    packaged_message: dict = Field(..., description='{"role": "user", "content": "<package_summarize_message JSON>"}')


class SaveResponse(BaseModel):
    saved: bool = True


class LoadResponse(BaseModel):
    agent_id: str
    loaded_from: str = "cold_start"


class MessagesAppendRequest(BaseModel):
    # pymemgpt-shaped message dicts (normalised TS-side at the boundary, §3.7/§2.10).
    # The persistence manager adds get_local_time() timestamps — the sidecar is the
    # sole source of truth for time metadata (§2.7).
    messages: List[dict] = Field(..., description="pymemgpt-shaped message dicts: {role, content, name?}")


class MessagesAppendResponse(BaseModel):
    appended: int = Field(..., description="Number of messages written to the recall corpus")


class CreateAgentRequest(BaseModel):
    name: str = Field(..., description="Memory namespace / agent_id — maps to agent_config.name")
    model: Optional[str] = Field("gpt-4", description="LLM model identifier passed to AgentConfig")
    persona: Optional[str] = Field(None, description="Persona text written into core memory (persona section)")
    human: Optional[str] = Field(None, description="Human text written into core memory (human section)")


class CreateAgentResponse(BaseModel):
    agent_id: str


class EnsureAgentRequest(BaseModel):
    """
    Body for POST /agents/{id}:ensure (§3.5).

    Namespace comes from the URL path; the body carries only what the create
    branch needs. All fields optional — load and resident branches ignore them;
    create branch falls back to the same defaults as POST /agents.
    """
    model: Optional[str] = Field("gpt-4", description="LLM model id — create branch only")
    persona: Optional[str] = Field(None, description="Persona block — create branch only")
    human: Optional[str] = Field(None, description="Human block — create branch only")


class EnsureAgentResponse(BaseModel):
    agent_id: str
    via: Literal["resident", "load", "create"] = Field(
        ...,
        description="Which branch resolved the request: 'resident' = already in registry (no-op); "
                    "'load' = unpickled from disk via :load (F2 repair fires); 'create' = new agent",
    )


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


# ── GET /agents/{id}/system_prompt_section — §2.4 ────────────────────────────

@router.get("/{agent_id}/system_prompt_section", response_model=SystemPromptSectionResponse,
            summary="Render the per-turn memory section of the system prompt")
def get_system_prompt_section(agent_id: str) -> SystemPromptSectionResponse:
    """
    §2.4 — calls construct_system_with_memory(agent.system, agent.memory, ts,
    pm.archival_memory, pm.recall_memory) and returns the rendered string.

    Renders from agent.memory directly; never reads self._messages[0] (dead slot —
    see §2.1 boundary rule).

    Response splits static (base system prompt, safe to cache per-agent) from dynamic
    (memory timestamp + counts + persona/human blocks, changes on every core-memory edit)
    so the TS before_prompt_build hook can skip re-fetching the static portion.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    from memgpt.agent import construct_system_with_memory
    from memgpt.utils import get_local_time

    pm = agent.persistence_manager
    ts = get_local_time()

    section = construct_system_with_memory(
        agent.system,
        agent.memory,
        ts,
        archival_memory=pm.archival_memory,
        recall_memory=pm.recall_memory,
    )

    # Split at the static/dynamic boundary.
    # construct_system_with_memory produces: agent.system + "\n" + "\n" + "\n" + dynamic
    # (the "\n".join([system, "\n", ...]) inserts a blank-line separator between them).
    # The static part is exactly agent.system; everything after is dynamic.
    static = agent.system
    dynamic = section[len(static):]

    return SystemPromptSectionResponse(section=section, static=static, dynamic=dynamic)


# ── 6c.6.2: GET /agents/{id}/stats — total_message_count provenance ─────────

@router.get("/{agent_id}/stats", response_model=StatsResponse,
            summary="Read sidecar-tracked stats (currently: total_message_count)")
def get_stats(agent_id: str) -> StatsResponse:
    """
    6c.6.2 — provenance for the host-passed `total_message_count` on
    :summarize requests.

    OpenClaw's SessionEntry exposes `compactionCount` but no all-time
    message counter; the flush-pressure hook (TS-side, §4.4) was therefore
    blocked on where to source `total_message_count` for §2.8's preamble
    template. The sidecar is the canonical source: pm.all_messages IS the
    running record (boot sequence + every messages:append per-turn batch
    via the 6c.5 mirror hook). Returning it as a stats endpoint rather
    than computing it twice (host-side counter + sidecar-side reality)
    keeps a single source of truth and avoids the host-counter restart-
    survival concern.

    Returns a typed object so future stats (recall corpus size, archival
    passage count, last-saved timestamp) extend without a new endpoint per
    metric — a pragma the §6 observability stream may benefit from.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    pm = agent.persistence_manager
    return StatsResponse(total_message_count=len(pm.all_messages))


# ── Core memory endpoints — §2.4 ─────────────────────────────────────────────
#
# All three call the Agent.* method layer (§2.1).  rebuild_memory() fires
# inside edit_memory_append/replace → update_memory() in-process commit; disk
# at :save.  Overflow and old_content-not-found raise ValueError in
# CoreMemory; KeyError means an unknown field name.  Both surface as 409 with
# the pymemgpt message UNMODIFIED (§2.9 verbatim round-trip rule).

def _core_memory_409(exc: ValueError) -> HTTPException:
    """Map a pymemgpt CoreMemory edit ValueError to the §2.9 error envelope.

    Both failure modes raise ValueError from CoreMemory.edit*, differing only
    in message text (memgpt/memory.py:75,85 overflow; 114,120 not-found). The
    verbatim message is preserved (§2.9); the machine-readable `error` code is
    derived for observability / experiment-event classification (§6).
    """
    msg = str(exc) if str(exc) else repr(exc)
    if "not found" in msg:
        code = "core_memory_content_not_found"
    elif "Exceeds" in msg and "character limit" in msg:
        code = "core_memory_overflow"
    else:
        code = "core_memory_edit_failed"   # fallback for any other CoreMemory ValueError
    return HTTPException(status_code=409, detail={"error": code, "message": msg})


@router.post("/{agent_id}/core_memory:append", response_model=OkResponse,
             summary="Append text to a core-memory section")
def core_memory_append(agent_id: str, body: CoreMemoryAppendRequest) -> OkResponse:
    """
    §2.4 — Agent.edit_memory_append(name, content).
    Triggers rebuild_memory() → update_memory() (in-process commit; flushed at :save).
    Overflow → 409 with verbatim pymemgpt error string (§2.9).
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    try:
        agent.edit_memory_append(body.name, body.content)
    except ValueError as exc:
        raise _core_memory_409(exc)

    return OkResponse()


@router.post("/{agent_id}/core_memory:replace", response_model=OkResponse,
             summary="Replace a substring in a core-memory section")
def core_memory_replace(agent_id: str, body: CoreMemoryReplaceRequest) -> OkResponse:
    """
    §2.4 — Agent.edit_memory_replace(name, old_content, new_content).
    old_content-not-found → 409 with verbatim pymemgpt error string (§2.9).
    Overflow after replacement → 409 similarly.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    try:
        agent.edit_memory_replace(body.name, body.old_content, body.new_content)
    except ValueError as exc:
        raise _core_memory_409(exc)

    return OkResponse()


@router.get("/{agent_id}/core_memory", response_model=CoreMemoryResponse,
            summary="Read current core-memory contents (observability / validation)")
def get_core_memory(agent_id: str) -> CoreMemoryResponse:
    """
    §2.4 — CoreMemory.to_dict(); off the hot path.
    Returns raw persona/human strings for observability and validation use.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    d = agent.memory.to_dict()
    return CoreMemoryResponse(persona=d["persona"], human=d["human"])


# ── Archival endpoints — §2.5 ─────────────────────────────────────────────────
#
# Backend is EmbeddingArchivalMemory on every path (§2.5 — DummyArchivalMemory not used).
# insert: in-memory only; disk write deferred to :save (§2.3).
# search: AttributeError on EmptyIndex is caught here (sidecar adapter, not a fork touchpoint).
# Note the per-instance, never-invalidated search cache in EmbeddingArchivalMemory (§2.5):
# a cached result for a query persists across subsequent inserts until cache miss or restart.

_ARCHIVAL_NO_RESULTS = "No results found."
_ARCHIVAL_PAGE_SIZE = 5  # Agent.archival_memory_search default count


@router.post("/{agent_id}/archival:insert", response_model=ArchivalInsertResponse,
             summary="Embed and insert content into archival memory")
def archival_insert(agent_id: str, body: ArchivalInsertRequest) -> ArchivalInsertResponse:
    """
    §2.5 — Agent.archival_memory_insert(content) → EmbeddingArchivalMemory.insert.
    Chunked via SimpleNodeParser; storage.insert_many is in-memory only (disk at :save).
    Passage count (chunk count) is derived from len(archival_memory) delta — the only
    way to get it without modifying the fork, since EmbeddingArchivalMemory.insert
    returns True, not the passage count.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    pm = agent.persistence_manager
    before = len(pm.archival_memory)
    agent.archival_memory_insert(body.content)
    passages = len(pm.archival_memory) - before

    logger.debug("archival:insert agent=%s passages=%d", agent_id, passages)
    return ArchivalInsertResponse(ok=True, passages=passages)


@router.post("/{agent_id}/archival:search", response_model=ArchivalSearchResponse,
             summary="Semantic search over archival memory")
def archival_search(agent_id: str, body: ArchivalSearchRequest) -> ArchivalSearchResponse:
    """
    §2.5 — Agent.archival_memory_search(query, page) → EmbeddingArchivalMemory.search.

    Single search call via the Agent method, which owns the page↔(count,start) translation
    and result formatting.  As a side-effect, EmbeddingArchivalMemory.cache[query] is
    populated with all matched Passage objects (List[Passage], each with .text).  The
    handler reads from that cache to derive structured observability fields — no second
    embedding computation, no duplicate search call.

    EmbeddingArchivalMemory.search returns len(paged_results) as "total" (not grand total);
    the structured fields match that contract so formatted/results/total are consistent
    by construction (same call).

    EmptyIndex raises AttributeError on .search; caught here (§2.5 adapter, not a fork
    touchpoint), returning the verbatim "No results found." interface string.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    pm = agent.persistence_manager

    try:
        # Single Agent-method call: page↔(count,start) translation and formatting live here.
        # Populates pm.archival_memory.cache[query] as a side-effect.
        formatted = agent.archival_memory_search(body.query, page=body.page)
    except AttributeError:
        # EmptyIndex.search raises AttributeError — return the standard "no results" string
        return ArchivalSearchResponse(
            formatted=_ARCHIVAL_NO_RESULTS,
            results=[],
            total=0,
            page=body.page,
            num_pages=0,
        )

    # Derive structured fields from the cache populated by the call above.
    # Slice to the same page window used internally by EmbeddingArchivalMemory.search.
    all_nodes = pm.archival_memory.cache.get(body.query, [])
    start = body.page * _ARCHIVAL_PAGE_SIZE
    page_nodes = all_nodes[start : start + _ARCHIVAL_PAGE_SIZE]
    results = [node.text for node in page_nodes]
    total = len(results)  # EmbeddingArchivalMemory.search returns len(paged_slice) as total
    num_pages = max(math.ceil(total / _ARCHIVAL_PAGE_SIZE) - 1, 0)

    return ArchivalSearchResponse(
        formatted=formatted,
        results=results,
        total=total,
        page=body.page,
        num_pages=num_pages,
    )


# ── Recall endpoints — §2.6 ──────────────────────────────────────────────────
#
# recall_memory.insert is NOT exposed — DummyRecallMemory.insert raises;
# the persistence manager is the sole writer (via messages:append, §2.7).
#
# Single-call discipline: unlike archival (where EmbeddingArchivalMemory.cache is
# readable post-call), DummyRecallMemory has no cache.  Both formatted and
# structured fields are derived from the Agent-method return value alone —
# the formatted string is parsed.
#
# DummyRecallMemory.text_search / date_search return len(all_matches) as total
# (grand total, not page-slice count) — unlike EmbeddingArchivalMemory which
# returns len(paged_slice).  Recall total and num_pages are therefore meaningful
# (§2.6 archival/recall paging asymmetry).

_RECALL_NO_RESULTS = "No results found."
# Anchored to the start of the string; captures only the numeric prefix —
# M (group 1) and P (group 2) — stopping at the ':' before the JSON array.
# No re.DOTALL, no array group: counts are extracted independently of content.
_RECALL_PREF_RE = re.compile(r"Showing \d+ of (\d+) results \(page \d+/(\d+)\):")


def _parse_recall_formatted(formatted: str) -> tuple[list[str], int, int]:
    """Parse (results, total, num_pages) from the Agent recall method's return value.

    Two-step parse — prefix and array are separated:
      Step 1: anchored prefix regex extracts M (total) and P (num_pages) from the
              fixed 'Showing N of M results (page p/P):' head. No re.DOTALL; no
              array content in the pattern. Counts are always correct regardless of
              what the message/passage content contains.
      Step 2: json.loads on formatted[m.end() + 1:] parses the JSON array that
              follows the ': ' separator. Array parsing is entirely independent of
              the count extraction.

    DummyRecallMemory returns the grand total (len(all_matches)), so total and
    num_pages are real (§2.6 archival/recall asymmetry).
    """
    if formatted == _RECALL_NO_RESULTS:
        return [], 0, 0
    # Step 1 — prefix only; anchored by re.match
    m = _RECALL_PREF_RE.match(formatted)
    if m is None:
        logger.warning("Could not parse recall formatted string: %r", formatted[:120])
        return [], 0, 0
    total = int(m.group(1))
    num_pages = int(m.group(2))
    # Step 2 — array from after ': '. json.dumps in the Agent method makes this valid
    # JSON (verified against adversarial content, 6a.5); the guard is defensive insurance
    # so a future non-JSON array degrades to counts-only rather than 500-ing the endpoint.
    try:
        results: list[str] = json.loads(formatted[m.end() + 1:])
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning(
            "recall array parse failed (counts preserved): %s — array=%r",
            exc, formatted[m.end() + 1:][:200],
        )
        results = []
    return results, total, num_pages


@router.post("/{agent_id}/recall:search", response_model=RecallSearchResponse,
             summary="Substring search over the recall conversation log")
def recall_search(agent_id: str, body: RecallSearchRequest) -> RecallSearchResponse:
    """
    §2.6 — Agent.recall_memory_search(query, page) → DummyRecallMemory.text_search.
    Single call; structured fields parsed from the formatted return value.
    Misses return "No results found." natively (no empty-index catch needed).
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    formatted = agent.recall_memory_search(body.query, page=body.page)
    results, total, num_pages = _parse_recall_formatted(formatted)
    return RecallSearchResponse(
        formatted=formatted,
        results=results,
        total=total,
        page=body.page,
        num_pages=num_pages,
    )


@router.post("/{agent_id}/recall:search_date", response_model=RecallSearchResponse,
             summary="Date-range search over the recall conversation log")
def recall_search_date(agent_id: str, body: RecallSearchDateRequest) -> RecallSearchResponse:
    """
    §2.6 — Agent.recall_memory_search_date(start_date, end_date, page)
           → DummyRecallMemory.date_search.
    Parameter names (start_date, end_date) confirmed against gpt_functions schema
    (conversation_search_date / recall_memory_search_date, both require these names).
    Single call; structured fields parsed from the formatted return value.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    formatted = agent.recall_memory_search_date(body.start_date, body.end_date, page=body.page)
    results, total, num_pages = _parse_recall_formatted(formatted)
    return RecallSearchResponse(
        formatted=formatted,
        results=results,
        total=total,
        page=body.page,
        num_pages=num_pages,
    )


# ── POST /agents/{id}/messages:append — §2.7 ─────────────────────────────────

@router.post("/{agent_id}/messages:append", response_model=MessagesAppendResponse,
             summary="Append messages to the recall corpus (persistence manager layer)")
def messages_append(agent_id: str, body: MessagesAppendRequest) -> MessagesAppendResponse:
    """
    §2.7 — Layer-cut exception to §2.1.

    Calls persistence_manager.append_to_messages, NOT Agent.append_to_messages.
    Agent.append_to_messages grows agent._messages (the active conversation buffer),
    which is OpenClaw's responsibility in Shape B.  The persistence manager call
    timestamps each message via get_local_time() and extends pm.all_messages (the
    recall corpus) without touching agent._messages.

    LocalStateManager.append_to_messages also extends pm.messages (the pm's shadow
    copy of the active buffer), but this is a pm-internal list separate from
    agent._messages — it does not affect the agent's active turn context.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    agent.persistence_manager.append_to_messages(body.messages)
    return MessagesAppendResponse(appended=len(body.messages))


# ── POST /agents/{id}:summarize — §2.8 ───────────────────────────────────────

@router.post("/{agent_id}:summarize", response_model=SummarizeResponse,
             summary="Cutoff selection + summarisation + packaging (no buffer mutation)")
def summarize(agent_id: str, body: SummarizeRequest) -> SummarizeResponse:
    """
    §2.8 — Mirrors the body of Agent.summarize_messages_inplace minus the three
    host-side operations (trim_messages, prepend_to_messages, messages_total update).
    Those are "the two named operations" owned by OpenClaw in Shape B.

    Orchestration:
      1. select_cutoff(messages, agent.model)          — F1 callable (e2c8c93 lineage)
      2. summarize_messages(agent.model, messages[1:cutoff])
      3. package_summarize_message(summary, summary_message_count, hidden_message_count, total)

    agent.model is read from the resident agent's config (read-only, §5.5 "one model for
    both").  The endpoint touches no buffer state — agent._messages, pm.messages,
    pm.all_messages are all unchanged (messages is a request parameter, not a buffer
    reference).

    LLMError from select_cutoff (buffer too small to compress) is surfaced as 422.
    """
    from memgpt.agent import select_cutoff
    from memgpt.errors import LLMError
    from memgpt.memory import summarize_messages
    from memgpt.system import package_summarize_message

    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    messages = body.messages

    try:
        cutoff = select_cutoff(messages, agent.model)
    except LLMError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    message_sequence_to_summarize = messages[1:cutoff]
    summary = summarize_messages(agent.model, message_sequence_to_summarize)

    summary_message_count = len(message_sequence_to_summarize)
    remaining_message_count = len(messages[cutoff:])
    hidden_message_count = body.total_message_count - remaining_message_count

    packaged_json = package_summarize_message(
        summary,
        summary_message_count,
        hidden_message_count,
        body.total_message_count,
    )
    packaged_message = {"role": "user", "content": packaged_json}

    return SummarizeResponse(
        cutoff=cutoff,
        summary=summary,
        summary_length=summary_message_count,
        hidden_message_count=hidden_message_count,
        total_message_count=body.total_message_count,
        packaged_message=packaged_message,
    )


# ── POST /agents/{id}:save — §2.3 ─────────────────────────────────────────────

@router.post("/{agent_id}:save", response_model=SaveResponse,
             summary="Flush all three memory tiers to disk (archival → nodes.pkl; recall + messages → pickle)")
def save_agent(agent_id: str) -> SaveResponse:
    """
    §2.3 — Agent.save() → LocalStateManager.save().

    Writes two files under MEMGPT_DIR/agents/{name}/:
      - agent_state/{timestamp}.json          (agent config snapshot)
      - persistence_manager/{timestamp}.persistence.pickle
        (recall_memory, messages, all_messages; archival.save() called first → nodes.pkl)

    Mutations commit in-process within the turn; `:save` is the disk-durability boundary.
    The pickle's `messages` key holds the 4-entry preset boot stub — active-buffer durability
    is OpenClaw's session-store concern (§2.1, §2.7). Agent stays resident after save.
    """
    agent = registry.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' is not resident")

    agent.save()
    logger.debug("agent:save flushed agent=%s", agent_id)
    return SaveResponse(saved=True)


# ── POST /agents/{id}:load — §2.3 ─────────────────────────────────────────────

@router.post("/{agent_id}:load", response_model=LoadResponse,
             summary="Cold-start rehydration from disk (not on normal session boundaries)")
def load_agent(agent_id: str) -> LoadResponse:
    """
    §2.3 — Cold-start only.  The sidecar holds agents resident across sessions (§2.10),
    so `:load` is NOT called on normal session boundaries — only when the agent is absent
    from the registry (process restart or explicit eviction by the experiment harness).

    Calls Agent.load_agent(DummyInterface(), agent_config), which:
      1. Reads the latest .json state file from agent_state/ (sorted by mtime)
      2. Calls LocalStateManager.load(pickle_path, agent_config)
         — F2 repair: re-points recall_memory._message_logs = all_messages (§2.11)
      3. Reconstructs Agent with persistence_manager_init=False

    409 if agent is already resident (wrong arm — evict first).
    404 if no config on disk (agent never created) or no saved state (never :saved).
    """
    if agent_id in registry:
        raise HTTPException(
            status_code=409,
            detail=f"Agent '{agent_id}' is already resident; :load is cold-start-only (§2.10)",
        )

    from memgpt.config import AgentConfig
    from memgpt.agent import Agent
    from memgpt.autogen.interface import DummyInterface

    try:
        cfg = AgentConfig.load(agent_id)
    except AssertionError:
        raise HTTPException(status_code=404, detail=f"No config on disk for agent '{agent_id}'")

    try:
        agent = Agent.load_agent(DummyInterface(), cfg)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    registry.put(agent_id, agent)
    logger.info("Agent cold-start loaded: namespace=%s", agent_id)
    return LoadResponse(agent_id=agent_id, loaded_from="cold_start")


# ── POST /agents/{id}:ensure — §3.5 composite (Task B) ────────────────────────

@router.post("/{agent_id}:ensure", response_model=EnsureAgentResponse,
             summary="Resolve namespace to a ready agent — resident | load | create")
def ensure_agent(agent_id: str, body: Optional[EnsureAgentRequest] = None) -> EnsureAgentResponse:
    """
    §3.5 composite — single call the plugin's ensureAgent() consumes.

    Resolves the namespace in order:
      1. Resident — agent_id is in the registry → no-op, via="resident".
      2. On-disk  — config.json exists under MEMGPT_DIR/agents/{agent_id}/ →
                    delegates to load_agent(agent_id); F2 repair fires inside
                    LocalStateManager.load (§2.11), via="load".
      3. Create   — neither resident nor on disk → delegates to
                    create_agent(CreateAgentRequest(...)) using body's
                    model/persona/human (defaults when absent), via="create".

    Delegates to the existing create_agent / load_agent route functions rather
    than duplicating their logic. The single-process model means the residency
    and disk checks made here remain valid through the immediate inner call —
    no TOCTOU window for the registry, and the disk file can only have been
    created by another in-process call we'd have raced against (impossible
    under FastAPI's per-request synchronous handler dispatch on this thread).

    The plugin chooses nothing — the sidecar owns the residency table and
    disk; the plugin only sees `via` in the response (useful for the 6d
    observability event stream).
    """
    # 1. Resident → no-op
    if agent_id in registry:
        logger.debug(":ensure resident agent=%s", agent_id)
        return EnsureAgentResponse(agent_id=agent_id, via="resident")

    # 2. On-disk → :load (delegate to load_agent)
    # Use the same path shape load_agent / AgentConfig.load would resolve.
    from memgpt.constants import MEMGPT_DIR as _DIR
    config_path = os.path.join(_DIR, "agents", agent_id, "config.json")
    if os.path.exists(config_path):
        logger.debug(":ensure on-disk agent=%s, delegating to :load", agent_id)
        load_resp = load_agent(agent_id)  # raises HTTPException on its own failures
        return EnsureAgentResponse(agent_id=load_resp.agent_id, via="load")

    # 3. Else → create (delegate to create_agent)
    ensure_body = body or EnsureAgentRequest()
    logger.debug(":ensure create agent=%s", agent_id)
    create_resp = create_agent(CreateAgentRequest(
        name=agent_id,
        model=ensure_body.model,
        persona=ensure_body.persona,
        human=ensure_body.human,
    ))
    return EnsureAgentResponse(agent_id=create_resp.agent_id, via="create")
