"""
Configurable-embedder tests — env-driven settings, provider-gated HF machinery,
startup dim assertion, and ini [embedding] reconcile.

The embedder is resolved from OPENCLAW_MEMGPT_EMBEDDING_* env vars
(settings._resolve_embedding_config) with defaults reproducing the original
built-in bge-small behaviour. The failure mode this design closes (observed,
not assumed): provider="openai" trips llama_index's model-name enum, and an
unrecognised provider falls through to a HuggingFace Hub download of a model
that does not exist there — the sidecar started, the embedder load failed, and
the whole trial voided. Misconfiguration must therefore fail loudly at startup.
"""

from __future__ import annotations

import os
import sys

import pytest

_SIDECAR = os.path.dirname(os.path.dirname(__file__))
if _SIDECAR not in sys.path:
    sys.path.insert(0, _SIDECAR)


# `settings` is imported lazily inside helpers — importing it at module top
# would run settings._load() before conftest sets OPENCLAW_MEMGPT_DATA_DIR
# (the CLAUDE.md import-ordering rule; same pattern as test_embedder_offline).
def _settings():
    import settings  # noqa: PLC0415
    return settings


def _resolve(env: dict):
    return _settings()._resolve_embedding_config(env)


# ── settings._resolve_embedding_config ──────────────────────────────────────


def test_defaults_reproduce_builtin_bge(tmp_path):
    cfg = _resolve({})
    assert cfg.provider == "huggingface"
    assert cfg.model == "BAAI/bge-small-en-v1.5"
    assert cfg.dim == 384
    assert cfg.endpoint_url is None
    assert cfg.explicit is False


def test_openai_compatible_full_config():
    cfg = _resolve(
        {
            "OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "openai_compatible",
            "OPENCLAW_MEMGPT_EMBEDDING_MODEL": "nomic-embed-text",
            "OPENCLAW_MEMGPT_EMBEDDING_DIM": "768",
            "OPENCLAW_MEMGPT_EMBEDDING_ENDPOINT_URL": "http://127.0.0.1:4000/v1",
        }
    )
    assert cfg.provider == "openai_compatible"
    assert cfg.model == "nomic-embed-text"
    assert cfg.dim == 768
    assert cfg.endpoint_url == "http://127.0.0.1:4000/v1"
    assert cfg.explicit is True


def test_openai_compatible_endpoint_defaults_to_ollama():
    cfg = _resolve(
        {
            "OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "openai_compatible",
            "OPENCLAW_MEMGPT_EMBEDDING_MODEL": "nomic-embed-text",
            "OPENCLAW_MEMGPT_EMBEDDING_DIM": "768",
        }
    )
    assert cfg.endpoint_url == "http://127.0.0.1:11434/v1"


def test_openai_compatible_requires_model():
    with pytest.raises(RuntimeError, match="MODEL is required"):
        _resolve(
            {
                "OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "openai_compatible",
                "OPENCLAW_MEMGPT_EMBEDDING_DIM": "768",
            }
        )


def test_openai_compatible_requires_dim():
    with pytest.raises(RuntimeError, match="DIM is required"):
        _resolve(
            {
                "OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "openai_compatible",
                "OPENCLAW_MEMGPT_EMBEDDING_MODEL": "nomic-embed-text",
            }
        )


def test_custom_hf_model_requires_dim():
    with pytest.raises(RuntimeError, match="DIM is required"):
        _resolve({"OPENCLAW_MEMGPT_EMBEDDING_MODEL": "BAAI/bge-large-en-v1.5"})


def test_unknown_provider_rejected_loudly():
    # The silent alternative is the observed trial-voiding failure: fall
    # through to the HuggingFace branch and attempt a bogus Hub download.
    with pytest.raises(RuntimeError, match="Unknown embedding provider"):
        _resolve({"OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "olama"})


def test_non_positive_or_garbage_dim_rejected():
    base = {
        "OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "openai_compatible",
        "OPENCLAW_MEMGPT_EMBEDDING_MODEL": "nomic-embed-text",
    }
    for bad in ("0", "-5", "many"):
        with pytest.raises(RuntimeError, match="positive integer"):
            _resolve({**base, "OPENCLAW_MEMGPT_EMBEDDING_DIM": bad})


def test_explicit_true_when_any_var_set():
    cfg = _resolve({"OPENCLAW_MEMGPT_EMBEDDING_PROVIDER": "huggingface"})
    assert cfg.explicit is True
    assert cfg.model == "BAAI/bge-small-en-v1.5"  # defaults still fill in


# ── provider-gated HF offline machinery ─────────────────────────────────────


def test_apply_offline_env_noop_for_remote_provider(tmp_path, monkeypatch):
    s = _settings()
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    # Marker present AND matching — would force offline under huggingface.
    with open(s.embedder_marker_path(str(tmp_path)), "w", encoding="utf-8") as f:
        f.write(s.EMBEDDING_MODEL)
    monkeypatch.setattr(s, "EMBEDDING_PROVIDER", "openai_compatible")
    s._apply_offline_env(str(tmp_path))
    assert "HF_HUB_OFFLINE" not in os.environ
    assert "TRANSFORMERS_OFFLINE" not in os.environ


class _FakeSettings:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.config_path = os.path.join(data_dir, "config")


class _FakeEmbedder:
    def __init__(self, dim: int):
        self._dim = dim

    def get_text_embedding(self, _text):
        return [0.0] * self._dim


def test_load_embedder_remote_skips_warm_marker(tmp_path, monkeypatch):
    import bootstrap

    monkeypatch.setattr(bootstrap, "settings", _FakeSettings(str(tmp_path)))
    monkeypatch.setattr(bootstrap, "EMBEDDING_PROVIDER", "openai_compatible")
    monkeypatch.setattr(bootstrap, "EMBEDDING_ENDPOINT_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setattr(
        "memgpt.embeddings.embedding_model",
        lambda: _FakeEmbedder(bootstrap.EMBEDDING_DIM),
    )

    bootstrap.load_embedder()

    marker = _settings().embedder_marker_path(str(tmp_path))
    assert not os.path.exists(marker), (
        "remote providers download nothing — no warm-marker must be written"
    )


def test_load_embedder_asserts_probe_dim(tmp_path, monkeypatch):
    import bootstrap

    monkeypatch.setattr(bootstrap, "settings", _FakeSettings(str(tmp_path)))
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.setattr(
        "memgpt.embeddings.embedding_model",
        lambda: _FakeEmbedder(bootstrap.EMBEDDING_DIM + 1),
    )

    with pytest.raises(RuntimeError, match="dimension mismatch"):
        bootstrap.load_embedder()


# ── ensure_memgpt_config: [embedding] reconcile ─────────────────────────────


def _write_ini_via_bootstrap(monkeypatch, data_dir: str) -> str:
    """Run the fresh-install write path against a tmp dir; returns ini path."""
    import bootstrap

    fake = _FakeSettings(data_dir)
    monkeypatch.setattr(bootstrap, "settings", fake)
    monkeypatch.setenv("MEMGPT_CONFIG_PATH", fake.config_path)
    bootstrap.ensure_memgpt_config()
    assert os.path.exists(fake.config_path)
    return fake.config_path


def test_existing_ini_untouched_when_not_explicit(tmp_path, monkeypatch):
    import bootstrap

    ini = _write_ini_via_bootstrap(monkeypatch, str(tmp_path))
    with open(ini, encoding="utf-8") as f:
        before = f.read()

    # Not explicit → original write-if-absent behaviour, even if constants
    # differ from the file (e.g. defaults changed in a future version).
    monkeypatch.setattr(bootstrap, "EMBEDDING_EXPLICIT", False)
    monkeypatch.setattr(bootstrap, "EMBEDDING_MODEL", "some/other-model")
    bootstrap.ensure_memgpt_config()

    with open(ini, encoding="utf-8") as f:
        assert f.read() == before


def test_explicit_config_reconciles_existing_ini(tmp_path, monkeypatch, caplog):
    import bootstrap
    from memgpt.config import MemGPTConfig

    _write_ini_via_bootstrap(monkeypatch, str(tmp_path))

    # Simulate an agent store embedded at the old dimension.
    agents_dir = os.path.join(str(tmp_path), "agents")
    os.makedirs(os.path.join(agents_dir, "old-agent"))

    monkeypatch.setattr(bootstrap, "EMBEDDING_EXPLICIT", True)
    monkeypatch.setattr(bootstrap, "EMBEDDING_PROVIDER", "openai_compatible")
    monkeypatch.setattr(bootstrap, "EMBEDDING_MODEL", "nomic-embed-text")
    monkeypatch.setattr(bootstrap, "EMBEDDING_DIM", 768)
    monkeypatch.setattr(
        bootstrap, "EMBEDDING_ENDPOINT_URL", "http://127.0.0.1:11434/v1"
    )

    import logging

    with caplog.at_level(logging.WARNING, logger="bootstrap"):
        bootstrap.ensure_memgpt_config()

    cfg = MemGPTConfig.load()
    assert cfg.embedding_provider == "openai_compatible"
    assert cfg.embedding_model == "nomic-embed-text"
    assert int(cfg.embedding_dim) == 768
    assert cfg.embedding_endpoint_url == "http://127.0.0.1:11434/v1"
    # Dim changed with existing agent state → the incompatibility warning.
    assert any("INCOMPATIBLE" in r.message for r in caplog.records)


def test_explicit_config_matching_ini_is_noop(tmp_path, monkeypatch):
    import bootstrap

    ini = _write_ini_via_bootstrap(monkeypatch, str(tmp_path))
    before_mtime = os.path.getmtime(ini)
    with open(ini, encoding="utf-8") as f:
        before = f.read()

    monkeypatch.setattr(bootstrap, "EMBEDDING_EXPLICIT", True)
    bootstrap.ensure_memgpt_config()  # same values → no rewrite

    with open(ini, encoding="utf-8") as f:
        assert f.read() == before
    assert os.path.getmtime(ini) == before_mtime
