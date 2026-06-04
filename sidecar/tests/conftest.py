"""
Pytest fixtures for sidecar integration tests.

Sets OPENCLAW_MEMGPT_DATA_DIR to a temp directory before importing main, so
each test session gets an isolated data directory and MEMGPT_DIR is patched
before any memgpt import fires (import-ordering rule, CLAUDE.md
§NON-NEGOTIABLES 7).
"""

from __future__ import annotations

import os
import sys
import tempfile
import uuid

import pytest
from starlette.testclient import TestClient


@pytest.fixture(scope="session")
def tmp_data_dir():
    with tempfile.TemporaryDirectory(prefix="openclaw-test-") as d:
        yield d


@pytest.fixture(scope="session")
def client(tmp_data_dir):
    """
    Session-scoped TestClient that runs the sidecar lifespan (embedder load)
    once per test session.  The sidecar's sys.path must include the sidecar
    source directory so 'from settings import settings' etc. resolve.
    """
    sidecar_dir = os.path.dirname(os.path.dirname(__file__))
    if sidecar_dir not in sys.path:
        sys.path.insert(0, sidecar_dir)

    os.environ["OPENCLAW_MEMGPT_DATA_DIR"] = tmp_data_dir

    from main import app  # noqa: PLC0415 — deferred until env is set

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture
def agent_id(client):
    """Create a fresh agent per test and return its id."""
    name = f"test-{uuid.uuid4().hex[:8]}"
    r = client.post("/agents", json={"name": name, "model": "gpt-4"})
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]
