"""
Tests for POST /agents/{id}/recall:search and recall:search_date.

Done-criteria (§2.6, 6a.5):
- Single Agent-method call per request (no separate storage-layer call).
- Seeded messages surface specifically (not just the boot baseline).
- recall:search with ≥1 page of seeded messages reports the true grand total
  (M in "Showing N of M") with num_pages > 0, confirming the archival/recall
  paging asymmetry: DummyRecallMemory.text_search returns len(all_matches) as
  total; EmbeddingArchivalMemory returns len(paged_slice).
- recall:search_date param names match gpt_functions schema (start_date/end_date).
- Misses return "No results found." — native to the recall backend (no AttributeError
  path like archival §6a.4).

Message seeding: messages:append (6a.6) is not yet implemented, so the fixture
seeds directly into agent.persistence_manager.all_messages, which is
DummyRecallMemory._message_logs (they share the same list object).
"""

from __future__ import annotations

import re
import uuid

import pytest

# Page size is the Agent method default
RECALL_PAGE_SIZE = 5
# Seed enough messages so total > PAGE_SIZE (forces num_pages > 0)
SEED_COUNT = RECALL_PAGE_SIZE + 2  # 7 → total > 5 → num_pages ≥ 1
UNIQUE_TOKEN = "XZEBRA"  # absent from boot messages; unique to seeded messages


# ── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def seeded_agent(client):
    """
    Create one agent and inject SEED_COUNT distinguishable messages directly
    into pm.all_messages (the DummyRecallMemory corpus).  Module-scoped so the
    seeding only happens once and tests share the result.
    """
    from memgpt.utils import get_local_time

    name = f"recall-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    agent_id = r.json()["agent_id"]

    # Access the live agent through the sidecar's registry to seed recall corpus.
    # This mirrors what messages:append (6a.6) will do via
    # persistence_manager.append_to_messages — same list, same effect.
    import sys, os
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)
    from registry import registry
    agent = registry.get(agent_id)
    pm = agent.persistence_manager

    for i in range(SEED_COUNT):
        pm.all_messages.append({
            "timestamp": get_local_time(),
            "message": {
                "role": "user" if i % 2 == 0 else "assistant",
                "content": f"{UNIQUE_TOKEN} seeded message number {i}",
            },
        })

    return agent_id


# ── recall:search tests ──────────────────────────────────────────────────────


class TestRecallSearch:
    def _search(self, client, agent_id: str, query: str, page: int = 0) -> dict:
        r = client.post(
            f"/agents/{agent_id}/recall:search",
            json={"query": query, "page": page},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def _parse_showing(self, formatted: str) -> tuple[int, int, int, int]:
        """Return (N, M, p, P) from 'Showing N of M results (page p/P): ...'"""
        m = re.search(r"Showing (\d+) of (\d+) results \(page (\d+)/(\d+)\)", formatted)
        assert m, f"Cannot parse formatted: {formatted!r}"
        return int(m[1]), int(m[2]), int(m[3]), int(m[4])

    def test_miss_returns_no_results(self, client, seeded_agent):
        """A query that matches nothing returns 'No results found.' natively."""
        r = self._search(client, seeded_agent, query="QQQQNOMATCH9999")
        assert r["formatted"] == "No results found."
        assert r["results"] == []
        assert r["total"] == 0
        assert r["num_pages"] == 0

    def test_seeded_messages_surface(self, client, seeded_agent):
        """The unique token only appears in seeded messages, not boot baseline."""
        r = self._search(client, seeded_agent, query=UNIQUE_TOKEN)
        assert r["formatted"] != "No results found.", "unique token not found in recall"
        # Every result must contain the unique token
        for result in r["results"]:
            assert UNIQUE_TOKEN in result, f"result missing unique token: {result!r}"

    def test_formatted_and_structured_consistent_page0(self, client, seeded_agent):
        """len(results) == N, total == M, page indices agree — page 0."""
        r = self._search(client, seeded_agent, query=UNIQUE_TOKEN, page=0)
        N, M, p, P = self._parse_showing(r["formatted"])

        assert len(r["results"]) == N, "slice count != formatted N"
        assert r["total"] == M,        "total != formatted M"
        assert r["page"] == p,         "r.page != formatted page index"
        assert r["num_pages"] == P,    "r.num_pages != formatted num_pages"

    def test_grand_total_and_multipage(self, client, seeded_agent):
        """
        Recall reports the true grand total (len(all_matches)) — unlike archival
        which reports len(paged_slice).  With SEED_COUNT > PAGE_SIZE, total > PAGE_SIZE
        and num_pages > 0 (real pagination, §2.6 asymmetry confirmed).
        """
        r = self._search(client, seeded_agent, query=UNIQUE_TOKEN, page=0)
        N, M, p, P = self._parse_showing(r["formatted"])

        assert M == SEED_COUNT, (
            f"grand total M={M} != SEED_COUNT={SEED_COUNT}; "
            f"recall should return len(all_matches), not len(paged_slice)"
        )
        assert P > 0, f"expected num_pages > 0 with {SEED_COUNT} messages, got P={P}"
        assert N == RECALL_PAGE_SIZE, f"full first page should have {RECALL_PAGE_SIZE} results, got {N}"

    def test_page1_different_window(self, client, seeded_agent):
        """Page 1 returns a different, non-overlapping window from page 0."""
        r0 = self._search(client, seeded_agent, query=UNIQUE_TOKEN, page=0)
        r1 = self._search(client, seeded_agent, query=UNIQUE_TOKEN, page=1)

        assert r0["results"] != r1["results"], "page 0 and page 1 returned identical results"
        assert set(r0["results"]).isdisjoint(r1["results"]), "page 0 and page 1 results overlap"

    def test_page1_consistency(self, client, seeded_agent):
        """Structured fields on page 1 are consistent with the formatted string."""
        r = self._search(client, seeded_agent, query=UNIQUE_TOKEN, page=1)
        N, M, p, P = self._parse_showing(r["formatted"])

        assert len(r["results"]) == N, "slice count != formatted N on page 1"
        assert r["total"] == M,        "total != formatted M on page 1"
        assert r["page"] == p,         "r.page != formatted page index on page 1"
        assert r["num_pages"] == P,    "r.num_pages != formatted num_pages on page 1"
        assert N == SEED_COUNT - RECALL_PAGE_SIZE, (
            f"partial second page: expected {SEED_COUNT - RECALL_PAGE_SIZE} results, got {N}"
        )


# ── recall:search_date tests ─────────────────────────────────────────────────


class TestRecallSearchDate:
    def _search_date(self, client, agent_id: str, start_date: str, end_date: str, page: int = 0) -> dict:
        r = client.post(
            f"/agents/{agent_id}/recall:search_date",
            json={"start_date": start_date, "end_date": end_date, "page": page},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_param_names_accepted(self, client, seeded_agent):
        """
        Request model accepts start_date / end_date (gpt_functions schema names,
        confirmed against conversation_search_date / recall_memory_search_date).
        A 422 here would indicate a field-name mismatch.
        """
        # Wide date range to capture all seeded messages (which have today's timestamp)
        r = self._search_date(client, seeded_agent, "2020-01-01", "2099-12-31")
        # Should not be a 422 — any 200 (even "No results found.") proves param names match
        assert r["formatted"] is not None

    def test_future_range_returns_no_results(self, client, seeded_agent):
        """Date range in the far future returns 'No results found.' natively."""
        r = self._search_date(client, seeded_agent, "2099-01-01", "2099-12-31")
        assert r["formatted"] == "No results found."
        assert r["results"] == []
        assert r["total"] == 0

    def test_today_range_hits_seeded_messages(self, client, seeded_agent):
        """Date range spanning today captures the seeded messages."""
        import datetime
        today = datetime.date.today().isoformat()
        r = self._search_date(client, seeded_agent, today, today)
        # Boot messages and seeded messages all have today's timestamp
        assert r["formatted"] != "No results found.", "today's range missed all messages"
        assert r["total"] > 0
