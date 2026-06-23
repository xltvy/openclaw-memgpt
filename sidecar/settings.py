"""
Sidecar settings — loaded FIRST, before any memgpt import.

Reads env vars and sets os.environ["MEMGPT_CONFIG_PATH"] so that
memgpt.config.MemGPTConfig.load() picks up the right ini file.
This module must NOT import memgpt.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


# ── embedding constants ────────────────────────────────────────────────────
EMBEDDING_PROVIDER = "huggingface"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384
EMBEDDING_CHUNK_SIZE = 300

# Marker the sidecar writes after a successful embedder load (see
# bootstrap.load_embedder). Its presence — and matching model name — tells the
# next process the model is cached, so it can force HF offline (below).
EMBEDDER_WARM_MARKER_NAME = ".embedder-warm"


def embedder_marker_path(data_dir: str) -> str:
    """Path to the embedder warm-marker for a given data dir."""
    return os.path.join(data_dir, EMBEDDER_WARM_MARKER_NAME)


def _embedder_cached(data_dir: str, model: str) -> bool:
    """True iff the warm-marker exists AND names the current embedder model.
    The model name makes the marker self-invalidating: changing EMBEDDING_MODEL
    in a future version means the old marker no longer matches, so the sidecar
    re-downloads online rather than forcing offline against a missing model."""
    try:
        with open(embedder_marker_path(data_dir), "r", encoding="utf-8") as f:
            return f.read().strip() == model
    except OSError:
        return False


def _apply_offline_env(data_dir: str) -> None:
    """Cold-start mitigation. If the embedder model is already cached (marker
    present + matching), force HF OFFLINE process-wide so EVERY embedder load —
    the startup eager load AND each per-agent load inside `:load` — reads the
    local cache instead of making an HF Hub network round-trip (~11s for
    `:load`, ~56s at startup, and variable). With the cache warm this turns a
    >15s cold-start (which overruns OpenClaw's before_prompt_build hook) into
    ~sub-second loads.

    Must run BEFORE any huggingface_hub/transformers import — transformers reads
    these env vars once at its import — which is why it lives in settings (the
    sidecar's first import). A fresh install (no/mismatched marker) stays ONLINE
    to download; bootstrap.load_embedder writes the marker after a successful
    load, so the next process is offline-fast."""
    if _embedder_cached(data_dir, EMBEDDING_MODEL):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


@dataclass(frozen=True)
class SidecarSettings:
    data_dir: str          # root data directory; maps to MEMGPT_DIR for agent state
    config_path: str       # path to the MemGPT ini config file
    host: str
    port: int


def _load() -> SidecarSettings:
    data_dir = os.environ.get(
        "OPENCLAW_MEMGPT_DATA_DIR",
        os.path.join(os.path.expanduser("~"), ".openclaw-memgpt"),
    )
    config_path = os.path.join(data_dir, "config")

    # Tell memgpt.config.MemGPTConfig where its ini file lives.
    # Must be done before the first `import memgpt.config`.
    os.environ.setdefault("MEMGPT_CONFIG_PATH", config_path)

    # Force HF offline iff the embedder is already cached (before any HF import).
    _apply_offline_env(data_dir)

    return SidecarSettings(
        data_dir=data_dir,
        config_path=config_path,
        host=os.environ.get("OPENCLAW_MEMGPT_HOST", "127.0.0.1"),
        port=int(os.environ.get("OPENCLAW_MEMGPT_PORT", "8765")),
    )


# Singleton — importing this module executes the load immediately.
settings: SidecarSettings = _load()
