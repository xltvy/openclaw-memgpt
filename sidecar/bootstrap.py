"""
Bootstrap — runs after settings.py but before any sidecar endpoint code.

Responsibilities:
  1. Patch memgpt.constants.MEMGPT_DIR and memgpt.config.MEMGPT_DIR to our
     data_dir (constants.py evaluates the path at module load time from HOME;
     we patch both the source module and the local copy in config.py).
  2. Ensure the MemGPT ini config file exists with the bge-small embedding
     settings the sidecar requires.
  3. Eagerly load the embedder at startup so a missing model fails loudly here,
     not at the first archival:insert.

Import order matters: settings must be imported before this module.
"""

from __future__ import annotations

import os
import logging

from settings import (
    settings,
    EMBEDDING_PROVIDER,
    EMBEDDING_MODEL,
    EMBEDDING_DIM,
    EMBEDDING_CHUNK_SIZE,
)

logger = logging.getLogger(__name__)

# ── 1. Patch MEMGPT_DIR before deeper memgpt modules use it ────────────────
# memgpt.constants evaluates MEMGPT_DIR = os.path.join(HOME, ".memgpt") at
# import time; config.py copies it with `from memgpt.constants import MEMGPT_DIR`.
# We must patch both the source constant and the copy.

import memgpt.constants as _mc  # noqa: E402 (intentional: after env-var setup)

_mc.MEMGPT_DIR = settings.data_dir

import memgpt.config as _cfg  # noqa: E402

_cfg.MEMGPT_DIR = settings.data_dir


# ── 2. Ensure MemGPT ini config ────────────────────────────────────────────

def ensure_memgpt_config() -> None:
    """Write the MemGPT ini config with bge-small settings if absent.

    Uses MemGPTConfig.save() so the file format stays in sync with the fork.
    Does not overwrite an existing file — if the file exists it is left
    unchanged (the embedder load step will catch a misconfigured provider).
    """
    from memgpt.config import MemGPTConfig

    if os.path.exists(settings.config_path):
        logger.debug("MemGPT config exists at %s — skipping write", settings.config_path)
        return

    os.makedirs(settings.data_dir, exist_ok=True)
    logger.info("Writing MemGPT config to %s", settings.config_path)

    cfg = MemGPTConfig(
        config_path=settings.config_path,
        embedding_provider=EMBEDDING_PROVIDER,
        embedding_model=EMBEDDING_MODEL,
        embedding_dim=EMBEDDING_DIM,
        embedding_chunk_size=EMBEDDING_CHUNK_SIZE,
        # archival storage: local (path resolved per-agent by AgentConfig)
        archival_storage_type="local",
    )
    cfg.save()


# ── 3. Eager embedder load ─────────────────────────────────────────────────

def _write_warm_marker() -> None:
    """Record that the embedder model is cached (content = model name, so a
    future model change auto-invalidates it — see settings._embedder_cached).
    Next process reads this in settings._apply_offline_env to force HF offline."""
    from settings import embedder_marker_path

    try:
        os.makedirs(settings.data_dir, exist_ok=True)
        with open(embedder_marker_path(settings.data_dir), "w", encoding="utf-8") as f:
            f.write(EMBEDDING_MODEL)
    except OSError as exc:
        logger.warning("Could not write embedder warm-marker: %s", exc)


def _clear_warm_marker() -> None:
    from settings import embedder_marker_path

    try:
        os.remove(embedder_marker_path(settings.data_dir))
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not clear embedder warm-marker: %s", exc)


def load_embedder():
    """Load the embedder at startup; raises loudly on any failure. Returns the
    loaded embedding model. Writes the warm-marker on success.

    OFFLINE-FIRST (cold-start mitigation). settings._apply_offline_env has
    already forced HF offline (process-wide) iff the model was cached — so this
    load, and every per-agent load inside `:load`, reads the local cache (~0.6s)
    instead of an HF Hub round-trip (~11–56s, which overruns OpenClaw's 15s
    before_prompt_build hook). The env is the lever because per-agent loads go
    through the fork's `embedding_model()`, which we can't parametrize.

    A fresh install runs ONLINE (no marker) and downloads once; we then write
    the marker so the next process is offline-fast. If we were running OFFLINE
    (marker present) and the load fails — the cache was evicted under us — we
    clear the marker (so the next start re-downloads online) and raise an
    actionable error, because the env is import-locked and we can't switch to
    online in this process."""
    from memgpt.embeddings import embedding_model

    offline = os.environ.get("HF_HUB_OFFLINE") == "1"
    logger.info(
        "Loading embedding model %s/%s (%s) …",
        EMBEDDING_PROVIDER, EMBEDDING_MODEL, "offline cache" if offline else "online",
    )
    try:
        embedder = embedding_model()
        _ = embedder.get_text_embedding("startup probe")
    except Exception as exc:
        if offline:
            _clear_warm_marker()
            raise RuntimeError(
                "Embedder model cache appears unavailable. "
                "Run `openclaw memgpt prewarm` or restart to re-download."
            ) from exc
        raise RuntimeError(
            f"Embedder load failed — cannot start sidecar. "
            f"provider={EMBEDDING_PROVIDER} model={EMBEDDING_MODEL}. Cause: {exc}"
        ) from exc

    _write_warm_marker()
    logger.info(
        "Embedder ready (dim=%d, %s)",
        EMBEDDING_DIM, "offline cache hit" if offline else "downloaded + cached",
    )
    return embedder
