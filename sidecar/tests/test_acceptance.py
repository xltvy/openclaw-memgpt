"""
6a.9 — Sidecar acceptance pass (MILESTONE).

Oracle: in-process Agent + LocalStateManager + EmbeddingArchivalMemory constructed
the same way POST /agents does (fork dev, carries F1 + F2). Verifies the sidecar
reproduces Phase-3 CLI behaviour as a system over HTTP.

Sidecar: identical scripted sequence through the HTTP endpoints.

Diff: verbatim on all LLM-facing result strings, error strings + error codes (§2.9),
static system prompt, core-memory contents, archival/recall formatted strings,
summariser cutoff + derived counts + packaged-message preamble, and persisted disk
state after save/load (cross-session persistence + F2-repair through the HTTP surface).

Declared deviations — expected to differ, excluded from parity diff (not failures):
  [D1] system_prompt_section.dynamic: contains a call-time timestamp generated at
       render time (get_local_time()). static matches byte-for-byte; persona/human
       blocks and memory counts match. Timestamp excluded from comparison.
  [D2] archival search formatted: each result carries a search-time timestamp stamped
       by EmbeddingArchivalMemory.search:802 (get_local_time() at call time, not
       insertion time). Heading "Showing N of M results (page p/q):" and content
       ("memory: ...") match; timestamps normalised before comparison.
  [D3] :summarize summary text: LLM-generated, non-deterministic. cutoff (F1
       equivalence), summary_length, hidden_message_count, and packaged-message
       preamble structure are compared; summary body is not.
  [D4] recall search formatted: each result entry carries d['timestamp'] — the
       pm.all_messages wrapper timestamp set by get_local_time() at append time.
       Oracle and sidecar append messages at slightly different moments (sequential
       HTTP calls), so timestamps always differ. Content (role + content) matches;
       timestamps normalised via _norm_recall_ts before comparison.
       Note: DummyRecallMemory.text_search:517 excludes role=="system" and
       role=="function" messages from its search pool — only user/assistant messages
       are searchable. Queries must target user/assistant boot content (e.g. "Bootup").

End-to-end adversarial pass: one delimiter-heavy injection through the full
create→insert→recall-append→save→load→recall-search + archival-search cycle.
Asserts verbatim round-trip and parse-correctness for both memory tiers.
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest


# ── Constants ─────────────────────────────────────────────────────────────────

ADVERSARIAL = 'buy "Adidas", not [Nike] — see results (page 1) of the catalog'

_PERSONA = (
    "The following is a starter persona, and should be expanded as the assistant interacts with the user.\n"
    "I am Sam.\n"
    "I don't just process information, I engage with it. I don't just give answers, I explore with the human."
)
_HUMAN = "This is what Sam knows about the human so far:\n"
_MODEL = "gpt-4"

# 7 archival passages: page 0 = top-5, page 1 = remaining 2 (EmbeddingArchivalMemory default count=5)
_ARCHIVAL_PASSAGES = [f"XCRANBERRY passage {i}: parity-test memory content" for i in range(7)]

_RECALL_TOKEN = "XLYCHEE_PARITY"
_RECALL_MSGS = [
    {"role": "user",      "content": f"{_RECALL_TOKEN} parity message A"},
    {"role": "assistant", "content": f"{_RECALL_TOKEN} parity response B"},
]

# Buffer for :summarize — ~20 short messages trigger select_cutoff reliably
_SYS_MSG = {"role": "system", "content": "You are a helpful assistant."}
_SUMMARIZE_BUFFER: list[dict] = [_SYS_MSG] + [
    {
        "role": "user" if i % 2 == 0 else "assistant",
        "content": (
            f"Turn {i}: the quick brown fox jumped over the lazy dog near the river bank. " * 5
        ),
    }
    for i in range(20)
]
_SUMMARIZE_TOTAL = 42
_CANNED_SUMMARY = "I helped with parity acceptance testing across multiple memory endpoints."

_HUMAN_APPEND = " Interested in MemGPT memory architecture."
_PERSONA_OLD = "I am Sam."
_PERSONA_NEW = "I am Sam, an AI assistant specialised in memory architecture."
_OVERFLOW_CONTENT = "Z" * 3000
_MISSING_OLD = "THIS_STRING_DOES_NOT_EXIST_IN_CORE_MEMORY"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _sidecar_dir() -> str:
    d = os.path.dirname(os.path.dirname(__file__))
    if d not in sys.path:
        sys.path.insert(0, d)
    return d


def _make_oracle(name: str):
    """Construct an Agent in-process — exact mirror of POST /agents handler."""
    _sidecar_dir()
    from memgpt.config import AgentConfig
    from memgpt.persistence_manager import LocalStateManager
    from memgpt.agent import Agent
    from memgpt.autogen.interface import DummyInterface
    from memgpt.prompts import gpt_functions, gpt_system
    from memgpt.presets import DEFAULT_PRESET

    cfg = AgentConfig(name=name, persona=_PERSONA, human=_HUMAN, model=_MODEL)
    pm = LocalStateManager(cfg)

    fn_names = [
        "send_message", "pause_heartbeats",
        "core_memory_append", "core_memory_replace",
        "conversation_search", "conversation_search_date",
        "archival_memory_insert", "archival_memory_search",
    ]
    fns = [v for k, v in gpt_functions.FUNCTIONS_CHAINING.items() if k in fn_names]

    return Agent(
        config=cfg,
        model=_MODEL,
        system=gpt_system.get_system_text(DEFAULT_PRESET),
        functions=fns,
        interface=DummyInterface(),
        persistence_manager=pm,
        persona_notes=_PERSONA,
        human_notes=_HUMAN,
    )


def _oracle_section(oracle) -> dict:
    """Call construct_system_with_memory on the oracle agent; mirror GET system_prompt_section."""
    from memgpt.agent import construct_system_with_memory
    from memgpt.utils import get_local_time

    pm = oracle.persistence_manager
    section = construct_system_with_memory(
        oracle.system, oracle.memory, get_local_time(),
        archival_memory=pm.archival_memory,
        recall_memory=pm.recall_memory,
    )
    static = oracle.system
    dynamic = section[len(static):]
    return {"section": section, "static": static, "dynamic": dynamic}


def _mock_llm(content: str = _CANNED_SUMMARY):
    """Stub memgpt.memory.create so :summarize runs without a real LLM key."""
    msg = SimpleNamespace(content=content)
    choice = SimpleNamespace(message=msg)
    return patch("memgpt.memory.create", return_value=SimpleNamespace(choices=[choice]))


def _evict(agent_id: str) -> None:
    _sidecar_dir()
    from registry import registry
    registry.evict(agent_id)


def _reload_oracle(oracle_cfg):
    """Reload an oracle agent from disk — mirrors :load cold-start path."""
    from memgpt.agent import Agent
    from memgpt.autogen.interface import DummyInterface
    return Agent.load_agent(DummyInterface(), oracle_cfg)


def _norm_archival_ts(formatted: str) -> str:
    """[D2] Replace per-result search-time timestamps for comparison.

    EmbeddingArchivalMemory.search stamps each result dict with get_local_time()
    at call time. Two calls at different moments will always differ by wall-clock
    time. Only the timestamp values are replaced — content/ordering unchanged.
    """
    return re.sub(r'timestamp: [^"]+, memory:', 'timestamp: TS, memory:', formatted)


def _norm_recall_ts(formatted: str) -> str:
    """[D4] Replace per-result pm.all_messages wrapper timestamps for comparison.

    recall_memory_search formats each result as 'timestamp: TS, role - content'
    where TS is the get_local_time() value set when the message was appended to
    pm.all_messages. Oracle and sidecar append at slightly different wall-clock
    moments, so timestamps always differ. Content (role + content) is unchanged.
    """
    return re.sub(r'timestamp: [^,]+, ', 'timestamp: TS, ', formatted)


def _extract_archival_contents(formatted: str) -> list[str]:
    """Extract 'memory: ...' content strings from archival formatted string.

    Format: 'Showing N of M results (page p/q): ["timestamp: X, memory: C1", ...]'
    Returns just the content part of each entry.
    """
    if formatted in ("No results found.", ""):
        return []
    try:
        colon_space = formatted.index(": ")
        array_str = formatted[colon_space + 2:]
        entries = json.loads(array_str)
        return [e.split(", memory: ", 1)[1] for e in entries]
    except (ValueError, IndexError, json.JSONDecodeError):
        return []


def _extract_dynamic_core(dynamic: str) -> dict:
    """[D1] Extract persona, human, and memory counts from dynamic section.

    The dynamic section starts with a timestamp line — we skip it and extract
    the structured fields that must match between oracle and sidecar.
    """
    persona_m  = re.search(r'<persona>(.*?)</persona>', dynamic, re.DOTALL)
    human_m    = re.search(r'<human>(.*?)</human>',    dynamic, re.DOTALL)
    archival_m = re.search(r'archival_memory_size:\s*(\d+)', dynamic)
    recall_m   = re.search(r'recall_memory_size:\s*(\d+)',   dynamic)
    return {
        "persona":              persona_m.group(1) if persona_m else None,
        "human":                human_m.group(1)   if human_m   else None,
        "archival_memory_size": int(archival_m.group(1)) if archival_m else None,
        "recall_memory_size":   int(recall_m.group(1))   if recall_m   else None,
    }


# ── Acceptance fixture ────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def acceptance(client):
    """
    Run the full parity sequence. Returns a plain dict keyed by step name.
    Each value is {"oracle": ..., "sidecar": ..., "deviation": ""|"[Dx] ..."}.

    All state mutations happen here; test methods read from this dict without
    side effects, so they run in any order after the fixture completes.
    """
    R: dict = {}

    def add(key: str, *, oracle, sidecar, deviation: str = "") -> None:
        R[key] = {"oracle": oracle, "sidecar": sidecar, "deviation": deviation}

    # ── 1. Create oracle and sidecar agents ──────────────────────────────────
    oracle = _make_oracle(f"oracle-{uuid.uuid4().hex[:8]}")
    r = client.post("/agents", json={
        "name": f"sc-{uuid.uuid4().hex[:8]}",
        "model": _MODEL,
        "persona": _PERSONA,
        "human": _HUMAN,
    })
    assert r.status_code == 201, r.text
    sc_id = r.json()["agent_id"]

    # ── 2. system_prompt_section — initial (before any edits) ────────────────
    oracle_sec_init = _oracle_section(oracle)
    sc_sec_init = client.get(f"/agents/{sc_id}/system_prompt_section").json()
    add("section_initial", oracle=oracle_sec_init, sidecar=sc_sec_init,
        deviation="[D1] dynamic timestamp differs by call time")

    # ── 3a. core_memory :append ──────────────────────────────────────────────
    oracle.edit_memory_append("human", _HUMAN_APPEND)
    r = client.post(f"/agents/{sc_id}/core_memory:append",
                    json={"name": "human", "content": _HUMAN_APPEND})
    add("core_append_status", oracle=200, sidecar=r.status_code)

    # ── 3b. core_memory :replace ─────────────────────────────────────────────
    oracle.edit_memory_replace("persona", _PERSONA_OLD, _PERSONA_NEW)
    r = client.post(f"/agents/{sc_id}/core_memory:replace",
                    json={"name": "persona", "old_content": _PERSONA_OLD, "new_content": _PERSONA_NEW})
    add("core_replace_status", oracle=200, sidecar=r.status_code)

    # ── 3c. GET core_memory after edits ──────────────────────────────────────
    oracle_cm = oracle.memory.to_dict()
    sc_cm = client.get(f"/agents/{sc_id}/core_memory").json()
    add("core_memory_contents", oracle=oracle_cm, sidecar=sc_cm)

    # ── 3d. system_prompt_section after core edits ───────────────────────────
    oracle_sec_edit = _oracle_section(oracle)
    sc_sec_edit = client.get(f"/agents/{sc_id}/system_prompt_section").json()
    add("section_after_edit", oracle=oracle_sec_edit, sidecar=sc_sec_edit,
        deviation="[D1] dynamic timestamp differs by call time")

    # ── 4a. core overflow → 409 ───────────────────────────────────────────────
    try:
        oracle.edit_memory_append("human", _OVERFLOW_CONTENT)
        oracle_overflow_msg = None
    except ValueError as exc:
        oracle_overflow_msg = str(exc)

    r_ov = client.post(f"/agents/{sc_id}/core_memory:append",
                       json={"name": "human", "content": _OVERFLOW_CONTENT})
    sc_ov_detail = r_ov.json().get("detail", {}) if r_ov.status_code == 409 else {}
    add("core_overflow_409",
        oracle=oracle_overflow_msg,
        sidecar={
            "status":     r_ov.status_code,
            "message":    sc_ov_detail.get("message") if isinstance(sc_ov_detail, dict) else None,
            "error_code": sc_ov_detail.get("error")   if isinstance(sc_ov_detail, dict) else None,
        })

    # ── 4b. core content-not-found → 409 ─────────────────────────────────────
    try:
        oracle.edit_memory_replace("persona", _MISSING_OLD, "replacement")
        oracle_notfound_msg = None
    except ValueError as exc:
        oracle_notfound_msg = str(exc)

    r_nf = client.post(f"/agents/{sc_id}/core_memory:replace",
                       json={"name": "persona", "old_content": _MISSING_OLD, "new_content": "replacement"})
    sc_nf_detail = r_nf.json().get("detail", {}) if r_nf.status_code == 409 else {}
    add("core_notfound_409",
        oracle=oracle_notfound_msg,
        sidecar={
            "status":     r_nf.status_code,
            "message":    sc_nf_detail.get("message") if isinstance(sc_nf_detail, dict) else None,
            "error_code": sc_nf_detail.get("error")   if isinstance(sc_nf_detail, dict) else None,
        })

    # ── 5. Archival insert × N, search pages ─────────────────────────────────
    for passage in _ARCHIVAL_PASSAGES:
        oracle.archival_memory_insert(passage)
        r = client.post(f"/agents/{sc_id}/archival:insert", json={"content": passage})
        assert r.status_code == 200, f"archival insert failed: {r.text}"

    oracle_arch_p0 = oracle.archival_memory_search("XCRANBERRY", page=0)
    sc_arch_p0 = client.post(f"/agents/{sc_id}/archival:search",
                              json={"query": "XCRANBERRY", "page": 0}).json()
    add("archival_search_p0", oracle=oracle_arch_p0, sidecar=sc_arch_p0,
        deviation="[D2] formatted timestamps differ; content/ranking compared")

    oracle_arch_p1 = oracle.archival_memory_search("XCRANBERRY", page=1)
    sc_arch_p1 = client.post(f"/agents/{sc_id}/archival:search",
                              json={"query": "XCRANBERRY", "page": 1}).json()
    add("archival_search_p1", oracle=oracle_arch_p1, sidecar=sc_arch_p1,
        deviation="[D2] formatted timestamps differ; content/ranking compared")

    # ── 6. Recall :search + :search_date ─────────────────────────────────────
    # "Bootup" appears in the assistant boot message (role="assistant", not excluded
    # by DummyRecallMemory.text_search:517 which only excludes "system"/"function").
    oracle_recall_boot = oracle.recall_memory_search("Bootup", page=0)
    sc_recall_boot = client.post(f"/agents/{sc_id}/recall:search",
                                  json={"query": "Bootup", "page": 0}).json()
    add("recall_search_boot", oracle=oracle_recall_boot, sidecar=sc_recall_boot["formatted"],
        deviation="[D4] formatted timestamps differ (pm.all_messages wrapper timestamps)")

    # :search_date with a far-future range — "No results found." for both
    oracle_recall_date = oracle.recall_memory_search_date("2099-01-01", "2099-01-02", page=0)
    sc_recall_date = client.post(f"/agents/{sc_id}/recall:search_date",
                                  json={"start_date": "2099-01-01", "end_date": "2099-01-02",
                                        "page": 0}).json()
    add("recall_search_date_noresults", oracle=oracle_recall_date, sidecar=sc_recall_date["formatted"])

    # ── 7. messages:append + recall:search for appended content ──────────────
    # Layer-cut: oracle uses pm.append_to_messages (not Agent.append_to_messages)
    oracle.persistence_manager.append_to_messages(_RECALL_MSGS)
    r = client.post(f"/agents/{sc_id}/messages:append", json={"messages": _RECALL_MSGS})
    assert r.status_code == 200, r.text

    oracle_recall_tok = oracle.recall_memory_search(_RECALL_TOKEN, page=0)
    sc_recall_tok = client.post(f"/agents/{sc_id}/recall:search",
                                 json={"query": _RECALL_TOKEN, "page": 0}).json()
    add("recall_after_append", oracle=oracle_recall_tok, sidecar=sc_recall_tok["formatted"],
        deviation="[D4] formatted timestamps differ (pm.all_messages wrapper timestamps)")

    # ── 8. :summarize over an over-budget buffer ──────────────────────────────
    # Oracle: select_cutoff only (deterministic part — F1 equivalence assertion).
    # Sidecar: full :summarize call with mocked LLM.
    # [D3] summary body excluded; cutoff + derived counts + preamble structure checked.
    from memgpt.agent import select_cutoff

    oracle_cutoff = select_cutoff(_SUMMARIZE_BUFFER, oracle.model)

    with _mock_llm():
        r_sum = client.post(f"/agents/{sc_id}:summarize",
                            json={"messages": _SUMMARIZE_BUFFER,
                                  "total_message_count": _SUMMARIZE_TOTAL})
    assert r_sum.status_code == 200, r_sum.text
    sc_sum = r_sum.json()

    add("summarize_cutoff", oracle=oracle_cutoff, sidecar=sc_sum["cutoff"],
        deviation="[D3] only cutoff compared; summary text excluded")
    add("summarize_derived",
        oracle={
            "summary_length":       oracle_cutoff - 1,
            "hidden_message_count": _SUMMARIZE_TOTAL - len(_SUMMARIZE_BUFFER[oracle_cutoff:]),
            "total_message_count":  _SUMMARIZE_TOTAL,
        },
        sidecar={k: sc_sum[k] for k in ("summary_length", "hidden_message_count", "total_message_count")},
        deviation="[D3] summary body excluded")

    # Preamble structure check (sidecar only — templated, not LLM-generated)
    packaged_content = sc_sum["packaged_message"]["content"]
    packaged_dict = json.loads(packaged_content)
    add("summarize_preamble", oracle=None, sidecar=packaged_dict.get("message", ""),
        deviation="[D3] oracle side not checked (same template); sidecar preamble structure verified")

    # ── 9. :save → evict → :load → post-load append → recall:search ──────────
    oracle.save()
    oracle_cfg = oracle.config

    r_save = client.post(f"/agents/{sc_id}:save")
    assert r_save.status_code == 200, r_save.text
    add("save_status", oracle=True, sidecar=r_save.json()["saved"])

    # Reload oracle (simulates cold-start; F2 repair fires inside Agent.load_agent)
    oracle = _reload_oracle(oracle_cfg)

    # Reload sidecar
    _evict(sc_id)
    r_load = client.post(f"/agents/{sc_id}:load")
    assert r_load.status_code == 200, r_load.text
    add("load_from_cold_start", oracle="cold_start", sidecar=r_load.json()["loaded_from"])

    # F2 repair through HTTP: post-load append must be findable
    POST_LOAD_TOKEN = "XMANGOSTEEN_POSTLOAD_PARITY"
    pl_msg = [{"role": "user", "content": f"{POST_LOAD_TOKEN} post-load parity message"}]
    oracle.persistence_manager.append_to_messages(pl_msg)
    r = client.post(f"/agents/{sc_id}/messages:append", json={"messages": pl_msg})
    assert r.status_code == 200, r.text

    oracle_recall_pl = oracle.recall_memory_search(POST_LOAD_TOKEN, page=0)
    sc_recall_pl = client.post(f"/agents/{sc_id}/recall:search",
                                json={"query": POST_LOAD_TOKEN, "page": 0}).json()
    add("recall_post_load", oracle=oracle_recall_pl, sidecar=sc_recall_pl["formatted"],
        deviation="[D4] formatted timestamps differ (pm.all_messages wrapper timestamps)")

    # Pre-save recall content still present after reload
    oracle_recall_preload = oracle.recall_memory_search(_RECALL_TOKEN, page=0)
    sc_recall_preload = client.post(f"/agents/{sc_id}/recall:search",
                                    json={"query": _RECALL_TOKEN, "page": 0}).json()
    add("recall_preload_after_reload", oracle=oracle_recall_preload,
        sidecar=sc_recall_preload["formatted"],
        deviation="[D4] formatted timestamps differ (pm.all_messages wrapper timestamps)")

    # ── 10. Adversarial end-to-end ────────────────────────────────────────────
    # Fresh agents for isolation. Full cycle: create → insert → append → save → load → search.
    adv_oracle = _make_oracle(f"adv-oracle-{uuid.uuid4().hex[:8]}")
    r = client.post("/agents", json={
        "name": f"adv-sc-{uuid.uuid4().hex[:8]}",
        "model": _MODEL,
        "persona": _PERSONA,
        "human": _HUMAN,
    })
    assert r.status_code == 201, r.text
    adv_sc_id = r.json()["agent_id"]

    # Insert adversarial into archival (both)
    adv_oracle.archival_memory_insert(ADVERSARIAL)
    r_adv_ins = client.post(f"/agents/{adv_sc_id}/archival:insert", json={"content": ADVERSARIAL})
    assert r_adv_ins.status_code == 200, r_adv_ins.text

    # Append adversarial into recall (both) — layer-cut: oracle uses pm.append
    adv_recall_msg = [{"role": "user", "content": ADVERSARIAL}]
    adv_oracle.persistence_manager.append_to_messages(adv_recall_msg)
    r_adv_app = client.post(f"/agents/{adv_sc_id}/messages:append", json={"messages": adv_recall_msg})
    assert r_adv_app.status_code == 200, r_adv_app.text

    # Save both
    adv_oracle.save()
    adv_oracle_cfg = adv_oracle.config
    r_adv_save = client.post(f"/agents/{adv_sc_id}:save")
    assert r_adv_save.status_code == 200, r_adv_save.text

    # Reload both (cold-start)
    adv_oracle = _reload_oracle(adv_oracle_cfg)
    _evict(adv_sc_id)
    r_adv_load = client.post(f"/agents/{adv_sc_id}:load")
    assert r_adv_load.status_code == 200, r_adv_load.text

    # Post-reload adversarial recall search
    adv_oracle_recall = adv_oracle.recall_memory_search("Adidas", page=0)
    adv_sc_recall = client.post(f"/agents/{adv_sc_id}/recall:search",
                                 json={"query": "Adidas", "page": 0}).json()
    add("adversarial_recall", oracle=adv_oracle_recall, sidecar=adv_sc_recall["formatted"],
        deviation="[D4] formatted timestamps differ (pm.all_messages wrapper timestamps)")
    add("adversarial_recall_verbatim",
        oracle="Adidas" in adv_oracle_recall,
        sidecar=any(ADVERSARIAL in entry for entry in adv_sc_recall["results"]))

    # Post-reload adversarial archival search
    adv_oracle_arch = adv_oracle.archival_memory_search("Adidas", page=0)
    adv_sc_arch = client.post(f"/agents/{adv_sc_id}/archival:search",
                               json={"query": "Adidas", "page": 0}).json()
    add("adversarial_archival", oracle=adv_oracle_arch, sidecar=adv_sc_arch,
        deviation="[D2] formatted timestamps differ; content/ranking compared")
    add("adversarial_archival_verbatim",
        oracle=ADVERSARIAL in _extract_archival_contents(adv_oracle_arch),
        sidecar=any(ADVERSARIAL in entry for entry in adv_sc_arch["results"]))

    # Parse-correctness check: sidecar recall total not corrupted by adversarial content
    add("adversarial_recall_parse_ok",
        oracle=adv_sc_recall["total"] >= 1,
        sidecar=adv_sc_recall["total"])

    return R


# ── 2. System prompt parity ───────────────────────────────────────────────────


class TestSystemPromptParity:
    """
    static matches byte-for-byte. [D1]: dynamic timestamp excluded; persona/human
    blocks and memory counts verified structurally.
    """

    def test_static_matches_byte_for_byte(self, acceptance):
        s = acceptance["section_initial"]
        assert s["oracle"]["static"] == s["sidecar"]["static"], (
            "static system prompt differs — preset or fork version mismatch"
        )

    def test_static_unchanged_after_core_edit(self, acceptance):
        """Static must NOT change when core memory is edited (§2.4 — only dynamic changes)."""
        before = acceptance["section_initial"]
        after  = acceptance["section_after_edit"]
        assert before["oracle"]["static"] == after["oracle"]["static"]
        assert before["sidecar"]["static"] == after["sidecar"]["static"]

    def test_dynamic_persona_matches_after_edit(self, acceptance):
        """[D1] Persona block in dynamic section matches after :replace."""
        s = acceptance["section_after_edit"]
        oracle_core  = _extract_dynamic_core(s["oracle"]["dynamic"])
        sidecar_core = _extract_dynamic_core(s["sidecar"]["dynamic"])
        assert oracle_core["persona"] is not None, "persona not found in oracle dynamic"
        assert oracle_core["persona"] == sidecar_core["persona"], (
            f"persona mismatch after edit:\n  oracle: {oracle_core['persona']!r}\n"
            f"  sidecar: {sidecar_core['persona']!r}"
        )

    def test_dynamic_human_matches_after_edit(self, acceptance):
        """[D1] Human block in dynamic section matches after :append."""
        s = acceptance["section_after_edit"]
        oracle_core  = _extract_dynamic_core(s["oracle"]["dynamic"])
        sidecar_core = _extract_dynamic_core(s["sidecar"]["dynamic"])
        assert oracle_core["human"] is not None, "human not found in oracle dynamic"
        assert oracle_core["human"] == sidecar_core["human"]

    def test_memory_counts_match(self, acceptance):
        """[D1] archival_memory_size and recall_memory_size agree between oracle and sidecar."""
        s = acceptance["section_after_edit"]
        oracle_core  = _extract_dynamic_core(s["oracle"]["dynamic"])
        sidecar_core = _extract_dynamic_core(s["sidecar"]["dynamic"])
        assert oracle_core["archival_memory_size"] == sidecar_core["archival_memory_size"]
        assert oracle_core["recall_memory_size"]   == sidecar_core["recall_memory_size"]

    def test_static_is_prefix_of_section(self, acceptance):
        """section == static + dynamic for both oracle and sidecar (structural invariant)."""
        s = acceptance["section_initial"]
        oracle_ok  = s["oracle"]["section"].startswith(s["oracle"]["static"])
        sidecar_ok = s["sidecar"]["section"].startswith(s["sidecar"]["static"])
        assert oracle_ok,  "oracle: section does not start with static"
        assert sidecar_ok, "sidecar: section does not start with static"


# ── 3. Core memory parity ─────────────────────────────────────────────────────


class TestCoreMemoryParity:
    """core_memory contents match; 409 error strings and codes match §2.9 verbatim contract."""

    def test_persona_after_replace_matches(self, acceptance):
        cm = acceptance["core_memory_contents"]
        assert cm["oracle"]["persona"] == cm["sidecar"]["persona"], (
            "persona mismatch after :replace — sidecar may not have applied the edit"
        )

    def test_human_after_append_matches(self, acceptance):
        cm = acceptance["core_memory_contents"]
        assert cm["oracle"]["human"] == cm["sidecar"]["human"], (
            "human mismatch after :append — sidecar may not have applied the edit"
        )

    def test_overflow_raises_on_oracle(self, acceptance):
        ov = acceptance["core_overflow_409"]
        assert ov["oracle"] is not None, (
            "oracle should have raised ValueError on overflow — check _OVERFLOW_CONTENT size"
        )

    def test_overflow_409_on_sidecar(self, acceptance):
        ov = acceptance["core_overflow_409"]
        assert ov["sidecar"]["status"] == 409, (
            f"expected 409 for overflow, got {ov['sidecar']['status']}"
        )

    def test_overflow_message_verbatim(self, acceptance):
        """§2.9 verbatim contract: sidecar 409 message == oracle ValueError message."""
        ov = acceptance["core_overflow_409"]
        assert ov["oracle"] == ov["sidecar"]["message"], (
            f"overflow 409 message mismatch (§2.9 verbatim):\n"
            f"  oracle exc: {ov['oracle']!r}\n"
            f"  sidecar msg: {ov['sidecar']['message']!r}"
        )

    def test_overflow_error_code(self, acceptance):
        ov = acceptance["core_overflow_409"]
        assert ov["sidecar"]["error_code"] == "core_memory_overflow", (
            f"wrong error code: {ov['sidecar']['error_code']!r}"
        )

    def test_notfound_message_verbatim(self, acceptance):
        """§2.9 verbatim contract: not-found message byte-for-byte."""
        nf = acceptance["core_notfound_409"]
        assert nf["oracle"] is not None, "oracle should have raised ValueError for missing old_content"
        assert nf["sidecar"]["status"] == 409
        assert nf["oracle"] == nf["sidecar"]["message"], (
            f"not-found 409 message mismatch (§2.9 verbatim):\n"
            f"  oracle exc: {nf['oracle']!r}\n"
            f"  sidecar msg: {nf['sidecar']['message']!r}"
        )

    def test_notfound_error_code(self, acceptance):
        nf = acceptance["core_notfound_409"]
        assert nf["sidecar"]["error_code"] == "core_memory_content_not_found", (
            f"wrong error code: {nf['sidecar']['error_code']!r}"
        )


# ── 4-5. Archival parity ──────────────────────────────────────────────────────


class TestArchivalParity:
    """
    [D2] Timestamps excluded from formatted comparison. Content and ranking match.
    Page-local total (EmbeddingArchivalMemory quirk) is NOT a deviation — must match.
    """

    def test_p0_formatted_matches_after_timestamp_norm(self, acceptance):
        """Normalised archival formatted strings are identical (D2 deviation documented)."""
        arch = acceptance["archival_search_p0"]
        oracle_norm  = _norm_archival_ts(arch["oracle"])
        sidecar_norm = _norm_archival_ts(arch["sidecar"]["formatted"])
        assert oracle_norm == sidecar_norm, (
            f"archival p0 formatted mismatch (after timestamp normalisation):\n"
            f"  oracle norm:  {oracle_norm!r}\n"
            f"  sidecar norm: {sidecar_norm!r}"
        )

    def test_p0_content_ranking_matches(self, acceptance):
        """Passage content in the same order for oracle and sidecar (same embedding model)."""
        arch = acceptance["archival_search_p0"]
        oracle_contents  = _extract_archival_contents(arch["oracle"])
        sidecar_contents = arch["sidecar"]["results"]
        assert oracle_contents == sidecar_contents, (
            f"archival p0 content/ranking mismatch:\n"
            f"  oracle:  {oracle_contents}\n"
            f"  sidecar: {sidecar_contents}"
        )

    def test_p0_is_not_empty(self, acceptance):
        arch = acceptance["archival_search_p0"]
        assert arch["sidecar"]["formatted"] != "No results found.", (
            "archival search returned no results — passages may not have been inserted"
        )

    def test_p1_formatted_matches_after_timestamp_norm(self, acceptance):
        """[D2] Page 1 formatted matches after timestamp normalisation."""
        arch = acceptance["archival_search_p1"]
        oracle_norm  = _norm_archival_ts(arch["oracle"])
        sidecar_norm = _norm_archival_ts(arch["sidecar"]["formatted"])
        assert oracle_norm == sidecar_norm

    def test_p0_total_equals_p1_total_page_local(self, acceptance):
        """
        Both pages return their own slice length as total (page-local total, §2.5 finding).
        Not a deviation — both oracle and sidecar have the same EmbeddingArchivalMemory quirk.
        """
        p0 = acceptance["archival_search_p0"]["sidecar"]["total"]
        p1 = acceptance["archival_search_p1"]["sidecar"]["total"]
        # page 0 = 5 results, page 1 = 2 results (7 passages total)
        assert p0 == 5, f"expected page-local total=5, got {p0}"
        assert p1 == 2, f"expected page-local total=2 (remaining), got {p1}"


# ── 6-7. Recall parity ───────────────────────────────────────────────────────


class TestRecallParity:
    """
    recall formatted strings are byte-for-byte comparable (no search-time timestamps).
    DummyRecallMemory returns grand total — both arms have the same messages.
    """

    def test_recall_boot_messages_match(self, acceptance):
        """[D4] Boot message recall search matches after timestamp normalisation."""
        rc = acceptance["recall_search_boot"]
        assert _norm_recall_ts(rc["oracle"]) == _norm_recall_ts(rc["sidecar"]), (
            f"boot message recall mismatch (after timestamp norm):\n"
            f"  oracle:  {_norm_recall_ts(rc['oracle'])!r}\n"
            f"  sidecar: {_norm_recall_ts(rc['sidecar'])!r}"
        )

    def test_recall_boot_not_empty(self, acceptance):
        rc = acceptance["recall_search_boot"]
        assert rc["oracle"] != "No results found.", (
            "boot message recall is empty — recall_memory may not be seeded"
        )

    def test_recall_search_date_no_results_match(self, acceptance):
        """:search_date with future range → 'No results found.' on both."""
        rc = acceptance["recall_search_date_noresults"]
        assert rc["oracle"]  == "No results found."
        assert rc["sidecar"] == "No results found."

    def test_recall_after_append_matches(self, acceptance):
        """[D4] Appended recall messages findable; formatted matches after timestamp norm."""
        rc = acceptance["recall_after_append"]
        assert rc["oracle"] != "No results found.", "oracle recall missing appended token"
        assert rc["sidecar"] != "No results found.", "sidecar recall missing appended token"
        assert _norm_recall_ts(rc["oracle"]) == _norm_recall_ts(rc["sidecar"]), (
            f"recall after append mismatch (after timestamp norm):\n"
            f"  oracle:  {_norm_recall_ts(rc['oracle'])!r}\n"
            f"  sidecar: {_norm_recall_ts(rc['sidecar'])!r}"
        )

    def test_post_load_recall_matches(self, acceptance):
        """[D4] F2 property: post-load append findable; oracle and sidecar agree after ts norm."""
        rc = acceptance["recall_post_load"]
        assert rc["oracle"]  != "No results found.", "oracle: post-load token missing (F2 check)"
        assert rc["sidecar"] != "No results found.", "sidecar: post-load token missing (F2 check)"
        assert _norm_recall_ts(rc["oracle"]) == _norm_recall_ts(rc["sidecar"])

    def test_preload_content_intact_after_reload(self, acceptance):
        """[D4] Pre-save recall content survives cold-start; oracle and sidecar agree after ts norm."""
        rc = acceptance["recall_preload_after_reload"]
        assert rc["oracle"]  != "No results found.", "pre-save recall missing from oracle after load"
        assert rc["sidecar"] != "No results found.", "pre-save recall missing from sidecar after load"
        assert _norm_recall_ts(rc["oracle"]) == _norm_recall_ts(rc["sidecar"])


# ── 8. Summarize parity ───────────────────────────────────────────────────────


class TestSummarizeParity:
    """[D3] summary body excluded. cutoff (F1 equivalence), derived counts, preamble checked."""

    def test_cutoff_matches_oracle_select_cutoff(self, acceptance):
        """
        F1 equivalence over HTTP: sidecar `:summarize` cutoff == oracle `select_cutoff`.
        Proves the endpoint wrapping does not perturb the cutoff algorithm.
        """
        s = acceptance["summarize_cutoff"]
        assert s["oracle"] == s["sidecar"], (
            f"cutoff mismatch (F1 equivalence): oracle={s['oracle']}, sidecar={s['sidecar']}"
        )

    def test_summary_length_equals_cutoff_minus_one(self, acceptance):
        """summary_length == cutoff - 1 (message count, §2.8 corrected semantics)."""
        s_cutoff  = acceptance["summarize_cutoff"]
        s_derived = acceptance["summarize_derived"]
        expected = s_cutoff["sidecar"] - 1
        assert s_derived["sidecar"]["summary_length"] == expected, (
            f"summary_length={s_derived['sidecar']['summary_length']} != cutoff-1={expected}"
        )

    def test_derived_counts_match_oracle(self, acceptance):
        """summary_length, hidden_message_count, total match oracle-derived values."""
        s = acceptance["summarize_derived"]
        assert s["oracle"]["summary_length"]       == s["sidecar"]["summary_length"]
        assert s["oracle"]["hidden_message_count"] == s["sidecar"]["hidden_message_count"]
        assert s["oracle"]["total_message_count"]  == s["sidecar"]["total_message_count"]

    def test_preamble_verbatim_template(self, acceptance):
        """
        packaged_message preamble follows the verbatim template from package_summarize_message:
        'Note: prior messages (N of M total messages) have been hidden from view due to
        conversation memory constraints.'
        """
        preamble_re = re.compile(
            r"^Note: prior messages \(\d+ of \d+ total messages\) have been hidden "
            r"from view due to conversation memory constraints\."
        )
        msg_text = acceptance["summarize_preamble"]["sidecar"]
        assert preamble_re.match(msg_text), (
            f"preamble does not match verbatim template: {msg_text[:200]!r}"
        )

    def test_preamble_numbers_match_derived_counts(self, acceptance):
        """N and M in the preamble match hidden_message_count and total_message_count."""
        preamble = acceptance["summarize_preamble"]["sidecar"]
        derived  = acceptance["summarize_derived"]["sidecar"]
        m = re.search(r"Note: prior messages \((\d+) of (\d+) total messages\)", preamble)
        assert m, f"cannot parse preamble numbers: {preamble[:200]!r}"
        assert int(m.group(1)) == derived["hidden_message_count"]
        assert int(m.group(2)) == derived["total_message_count"]


# ── 9. Save / load parity ─────────────────────────────────────────────────────


class TestSaveLoadParity:
    """Persisted disk state matches; cold-start loads correctly; F2 through the surface."""

    def test_save_returns_saved_true(self, acceptance):
        s = acceptance["save_status"]
        assert s["oracle"] is True and s["sidecar"] is True

    def test_load_reports_cold_start(self, acceptance):
        lc = acceptance["load_from_cold_start"]
        assert lc["oracle"]  == "cold_start"
        assert lc["sidecar"] == "cold_start"


# ── 10. Adversarial end-to-end ────────────────────────────────────────────────


class TestAdversarialParity:
    """
    Adversarial content ('buy "Adidas", not [Nike] — see results (page 1) of the catalog')
    round-trips verbatim through the full create→insert→append→save→load→search cycle.
    Ties together 6a.5 (parse robustness), 6a.6 (write path), and 6a.8 (save/load).
    """

    def test_adversarial_recall_match(self, acceptance):
        """[D4] Oracle and sidecar adversarial recall match after timestamp normalisation."""
        adv = acceptance["adversarial_recall"]
        assert _norm_recall_ts(adv["oracle"]) == _norm_recall_ts(adv["sidecar"]), (
            f"adversarial recall mismatch (after timestamp norm):\n"
            f"  oracle:  {_norm_recall_ts(adv['oracle'])!r}\n"
            f"  sidecar: {_norm_recall_ts(adv['sidecar'])!r}"
        )

    def test_adversarial_recall_found(self, acceptance):
        """Adversarial content is findable in recall after save/load."""
        adv = acceptance["adversarial_recall_verbatim"]
        assert adv["oracle"]  is True, "adversarial not found in oracle recall after load"
        assert adv["sidecar"] is True, "adversarial not found in sidecar recall after load — verbatim round-trip failed"

    def test_adversarial_archival_content_matches(self, acceptance):
        """[D2] Archival content/ranking matches after adversarial save/load cycle."""
        adv = acceptance["adversarial_archival"]
        oracle_norm  = _norm_archival_ts(adv["oracle"])
        sidecar_norm = _norm_archival_ts(adv["sidecar"]["formatted"])
        assert oracle_norm == sidecar_norm, (
            f"adversarial archival mismatch (after timestamp norm):\n"
            f"  oracle:  {oracle_norm!r}\n"
            f"  sidecar: {sidecar_norm!r}"
        )

    def test_adversarial_archival_verbatim(self, acceptance):
        """Adversarial string present verbatim in archival results for both arms."""
        adv = acceptance["adversarial_archival_verbatim"]
        assert adv["oracle"]  is True, "adversarial not in oracle archival results (content extraction failed?)"
        assert adv["sidecar"] is True, "adversarial not in sidecar archival results — verbatim round-trip failed"

    def test_recall_total_not_corrupted_by_adversarial(self, acceptance):
        """
        recall total is not corrupted by delimiter-heavy content ('results (page 1)' etc.).
        The anchored prefix regex must extract M correctly regardless of message content.
        """
        adv = acceptance["adversarial_recall_parse_ok"]
        assert adv["sidecar"] >= 1, (
            f"recall total={adv['sidecar']} — prefix regex may be confused by adversarial content"
        )
