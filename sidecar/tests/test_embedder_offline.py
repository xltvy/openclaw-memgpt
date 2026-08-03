"""
Cold-start mitigation tests — offline-first embedder via the warm-marker.

The sidecar forces HF offline (process-wide, in settings, before any HF import)
iff a marker file naming the current model exists, so every embedder load — the
startup load AND each per-agent load inside `:load` — reads the local cache
(~0.6s) instead of an HF Hub round-trip (~11–56s, which overruns OpenClaw's 15s
before_prompt_build hook). A fresh install runs online to download, then writes
the marker; the model name makes the marker self-invalidating on a model change.
"""

from __future__ import annotations

import os
import sys

import pytest

_SIDECAR = os.path.dirname(os.path.dirname(__file__))
if _SIDECAR not in sys.path:
    sys.path.insert(0, _SIDECAR)


# `settings` is imported lazily INSIDE the helpers/tests, not at module top:
# importing it runs settings._load() as a side-effect, which reads
# OPENCLAW_MEMGPT_DATA_DIR + sets MEMGPT_CONFIG_PATH. At collection time (before
# conftest's `client` fixture sets the env) that would lock in the wrong data
# dir for the whole session — the CLAUDE.md import-ordering rule. By test-run
# time the env is already set, so the lazy import is safe.
def _settings():
    import settings  # noqa: PLC0415
    return settings


def _marker_path(data_dir: str) -> str:
    return _settings().embedder_marker_path(data_dir)


def _model() -> str:
    return _settings().EMBEDDING_MODEL


def _write_marker(data_dir: str, content: str) -> None:
    with open(_marker_path(data_dir), "w", encoding="utf-8") as f:
        f.write(content)


# ── settings._embedder_cached ──────────────────────────────────────────────


def test_cached_true_when_marker_matches_model(tmp_path):
    _write_marker(str(tmp_path), _model())
    assert _settings()._embedder_cached(str(tmp_path), _model()) is True


def test_cached_false_when_marker_absent(tmp_path):
    assert _settings()._embedder_cached(str(tmp_path), _model()) is False


def test_cached_false_when_model_name_mismatches(tmp_path):
    # A future embedder change must auto-invalidate the marker.
    _write_marker(str(tmp_path), "BAAI/some-other-model-v2")
    assert _settings()._embedder_cached(str(tmp_path), _model()) is False


# ── settings._apply_offline_env ────────────────────────────────────────────


def test_apply_offline_env_sets_when_cached(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    _write_marker(str(tmp_path), _model())
    _settings()._apply_offline_env(str(tmp_path))
    assert os.environ.get("HF_HUB_OFFLINE") == "1"
    assert os.environ.get("TRANSFORMERS_OFFLINE") == "1"


def test_apply_offline_env_noop_when_not_cached(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    _settings()._apply_offline_env(str(tmp_path))  # no marker
    assert "HF_HUB_OFFLINE" not in os.environ
    assert "TRANSFORMERS_OFFLINE" not in os.environ


# ── bootstrap.load_embedder marker behaviour ───────────────────────────────


class _FakeSettings:
    """Stand-in for the frozen SidecarSettings — only `data_dir` is read by the
    marker helpers, and the real one is frozen (can't setattr in a test)."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir


def test_load_embedder_writes_marker_on_success(tmp_path, monkeypatch):
    import bootstrap

    # Redirect the marker to a tmp dir + fake a successful embedder load.
    monkeypatch.setattr(bootstrap, "settings", _FakeSettings(str(tmp_path)))
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)  # online path

    class _FakeEmbedder:
        def get_text_embedding(self, _text):
            # Must match the configured dim — load_embedder asserts it.
            return [0.0] * bootstrap.EMBEDDING_DIM

    monkeypatch.setattr("memgpt.embeddings.embedding_model", lambda: _FakeEmbedder())

    bootstrap.load_embedder()

    p = _marker_path(str(tmp_path))
    assert os.path.exists(p), "successful load must write the warm-marker"
    with open(p, encoding="utf-8") as f:
        assert f.read().strip() == _model(), "marker must name the model"


def test_load_embedder_offline_failure_clears_marker_and_raises(tmp_path, monkeypatch):
    import bootstrap

    monkeypatch.setattr(bootstrap, "settings", _FakeSettings(str(tmp_path)))
    _write_marker(str(tmp_path), _model())  # marker says "cached"
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")       # …but we're offline and it fails

    def _boom():
        raise OSError("model files not found in cache")

    monkeypatch.setattr("memgpt.embeddings.embedding_model", _boom)

    with pytest.raises(RuntimeError, match="prewarm|restart"):
        bootstrap.load_embedder()

    assert not os.path.exists(_marker_path(str(tmp_path))), (
        "an offline load failure (cache evicted) must clear the marker so the "
        "next start re-downloads online"
    )
