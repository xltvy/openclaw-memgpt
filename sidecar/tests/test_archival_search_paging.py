"""
Multi-page paging consistency test for POST /agents/{id}/archival:search.

Verifies that the handler's cache-slice and the Agent method's internal paging
describe the same window on every page — the property "consistent by construction"
claimed after the single-call refactor, which the 1-of-1 smoke test cannot expose.

The 1-of-1 case degenerates: start=0, one result, one page — a slice mismatch is
invisible.  Mismatches only surface when page ≥ 1 (start > 0) and there are
enough results to fill more than one page.

EmbeddingArchivalMemory.search returns (paged_slice, len(paged_slice)) — total is
always the page result count, NOT the grand total across all pages.  Concretely:
- page 0 formatted → "Showing 5 of 5 results (page 0/0)"
- page 1 formatted → "Showing 5 of 5 results (page 1/0)"
- page 2 formatted → "Showing 2 of 2 results (page 2/0)"
num_pages in the formatted string is therefore always 0 and cannot be used to
locate the last page.  The test computes last_page = TOTAL_INSERTIONS // P directly.

Other EmbeddingArchivalMemory notes (§2.5):
- top_k cap: default top_k=100; 2P+2=12 insertions is well under that cap.
- Search cache: never invalidated per-instance; cache key is the query string.
  The page-0 search populates the cache; page-1 search is a cache hit.
"""

from __future__ import annotations

import re

import pytest

# Must match routes/agents.py _ARCHIVAL_PAGE_SIZE
ARCHIVAL_PAGE_SIZE = 5
P = ARCHIVAL_PAGE_SIZE
TOTAL_INSERTIONS = 2 * P + 2  # 12 for P=5; spans three pages (5 + 5 + 2)


def _parse_showing(formatted: str) -> tuple[int, int]:
    """Extract (N, M) from 'Showing N of M results (page p/P): ...'"""
    m = re.search(r"Showing (\d+) of (\d+) results", formatted)
    assert m is not None, f"Could not parse formatted string: {formatted!r}"
    return int(m.group(1)), int(m.group(2))


def _parse_page_info(formatted: str) -> tuple[int, int]:
    """Extract (p, num_pages) from '... (page p/P): ...'"""
    m = re.search(r"\(page (\d+)/(\d+)\)", formatted)
    assert m is not None, f"Could not parse page info from: {formatted!r}"
    return int(m.group(1)), int(m.group(2))


@pytest.fixture(scope="module")
def populated_agent(client):
    """
    Module-scoped: create one agent and insert TOTAL_INSERTIONS semantically
    similar passages.  Reused across all tests in this module so the (slow)
    inserts only happen once.
    """
    import uuid

    name = f"paging-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    agent_id = r.json()["agent_id"]

    for i in range(TOTAL_INSERTIONS):
        r = client.post(
            f"/agents/{agent_id}/archival:insert",
            json={"content": f"Eiffel Tower Paris detail number {i}: a famous iron lattice tower on the Champ de Mars"},
        )
        assert r.status_code == 200, r.text

    return agent_id


def _search(client, agent_id: str, page: int) -> dict:
    r = client.post(
        f"/agents/{agent_id}/archival:search",
        json={"query": "Eiffel Tower Paris", "page": page},
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestMultiPageConsistency:
    """
    Three-page scenario with TOTAL_INSERTIONS = 2P+2 passages:
      page 0 → P results
      page 1 → P results
      page 2 → 2 results  (partial last page)
    """

    def test_page0_consistency(self, client, populated_agent):
        """len(results) == N from formatted, total == M, page indices agree."""
        r = _search(client, populated_agent, page=0)
        n, m = _parse_showing(r["formatted"])
        p, num_pages = _parse_page_info(r["formatted"])

        assert len(r["results"]) == n,        "slice count != formatted N on page 0"
        assert r["total"] == m,               "total != formatted M on page 0"
        assert r["page"] == p,                "r.page != formatted page index"
        assert r["num_pages"] == num_pages,   "r.num_pages != formatted num_pages"
        assert n == P,                        f"full first page should have {P} results, got {n}"

    def test_page1_consistency(self, client, populated_agent):
        """Same checks for page 1 — this is the case that exercises start=P."""
        r = _search(client, populated_agent, page=1)
        n, m = _parse_showing(r["formatted"])
        p, num_pages = _parse_page_info(r["formatted"])

        assert len(r["results"]) == n,        "slice count != formatted N on page 1"
        assert r["total"] == m,               "total != formatted M on page 1"
        assert r["page"] == p,                "r.page != formatted page index"
        assert r["num_pages"] == num_pages,   "r.num_pages != formatted num_pages"
        assert n == P,                        f"full second page should have {P} results, got {n}"

    def test_pages_are_different_windows(self, client, populated_agent):
        """
        Page 0 and page 1 must return disjoint result windows — proves body.page
        is actually advancing the cache slice (start = page * P), not stuck at 0.
        """
        r0 = _search(client, populated_agent, page=0)
        r1 = _search(client, populated_agent, page=1)

        assert r0["results"] != r1["results"],         "page 0 and page 1 returned identical results"
        assert set(r0["results"]).isdisjoint(r1["results"]), "page 0 and page 1 results overlap"

    def test_partial_last_page(self, client, populated_agent):
        """
        Last page has only TOTAL_INSERTIONS % P = 2 results (a partial page).
        Verifies cache[start:start+P] slices correctly when fewer than P remain.

        NOTE: EmbeddingArchivalMemory.search returns len(paged_slice) as total,
        NOT the grand total.  num_pages in the formatted string is therefore
        always 0 and cannot locate the last page.  Compute it directly.
        """
        last_page = TOTAL_INSERTIONS // P  # = 12 // 5 = 2
        expected_last = TOTAL_INSERTIONS - last_page * P  # = 12 - 10 = 2

        r = _search(client, populated_agent, page=last_page)
        n, m = _parse_showing(r["formatted"])

        assert n == expected_last,     f"partial last page: expected {expected_last} results, got {n}"
        assert len(r["results"]) == n, "slice count != formatted N on last partial page"
        assert r["total"] == m,        "total != formatted M on last partial page"


# ── adversarial content (completeness) ───────────────────────────────────────

#: Content whose characters could corrupt a naïve parse of the formatted string:
#: double-quotes, square brackets, and the literal "results (page 1)".
_ADVERSARIAL = 'buy "Adidas", not [Nike] — see results (page 1) of the catalog'


@pytest.fixture(scope="module")
def adversarial_archival_agent(client):
    """
    Create one agent and insert one passage with the adversarial content.
    Module-scoped so the (slow) embedding only happens once.
    """
    import uuid

    name = f"adv-arch-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    agent_id = r.json()["agent_id"]

    r = client.post(
        f"/agents/{agent_id}/archival:insert",
        json={"content": _ADVERSARIAL},
    )
    assert r.status_code == 200, r.text

    return agent_id


class TestAdversarialContent:
    """
    Lighter completeness check: prove archival:search survives delimiter-heavy
    content.

    EmbeddingArchivalMemory stores and retrieves passage text verbatim; the
    formatted string is produced by the Agent method (json.dumps escaping).
    The handler reads results from pm.archival_memory.cache — a list of Passage
    objects whose .text is the original unescaped string.

    No parse-corruption check is needed for archival (the handler does not
    regex-parse the formatted string for structured fields); these tests confirm
    the round-trip at the storage/cache level.
    """

    def _search(self, client, agent_id: str, query: str, page: int = 0) -> dict:
        r = client.post(
            f"/agents/{agent_id}/archival:search",
            json={"query": query, "page": page},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_adversarial_passage_surfaces(self, client, adversarial_archival_agent):
        """archival:search returns at least one result for the inserted passage."""
        r = self._search(client, adversarial_archival_agent, "Adidas Nike catalog")
        assert r["formatted"] != "No results found.", (
            "adversarial archival passage not found"
        )
        assert len(r["results"]) >= 1

    def test_adversarial_content_round_trips(self, client, adversarial_archival_agent):
        """
        The full adversarial string is present verbatim in results.

        results come from pm.archival_memory.cache[start:end], where each entry
        is a Passage whose .text is the original unescaped string.  Double-quotes
        and square brackets in the content are stored and returned without
        transformation.
        """
        r = self._search(client, adversarial_archival_agent, "Adidas Nike catalog")
        assert any(_ADVERSARIAL in entry for entry in r["results"]), (
            f"adversarial content not found verbatim in archival results: {r['results']!r}"
        )

    def test_formatted_is_not_empty_on_hit(self, client, adversarial_archival_agent):
        """
        The formatted string from the Agent method is a non-empty, parseable
        'Showing N of M results ...' string — not a bare JSON blob or empty.

        This confirms the Agent method's json.dumps round-trip does not break
        the formatted header when content contains double-quotes.
        """
        r = self._search(client, adversarial_archival_agent, "Adidas Nike catalog")
        m = re.search(r"Showing (\d+) of (\d+) results", r["formatted"])
        assert m is not None, (
            f"formatted string not in expected shape: {r['formatted']!r}"
        )
