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

def load_embedder():
    """Load bge-small-en-v1.5 at startup; raises loudly on any failure.

    A warm-up embedding is issued so weight loading completes here, not
    during the first archival:insert.  Returns the loaded embedding model.
    """
    from memgpt.embeddings import embedding_model

    logger.info("Loading embedding model %s/%s …", EMBEDDING_PROVIDER, EMBEDDING_MODEL)
    try:
        embedder = embedding_model()
        _ = embedder.get_text_embedding("startup probe")
    except Exception as exc:
        raise RuntimeError(
            f"Embedder load failed — cannot start sidecar. "
            f"provider={EMBEDDING_PROVIDER} model={EMBEDDING_MODEL}. "
            f"Cause: {exc}"
        ) from exc

    logger.info("Embedder ready (dim=%d)", EMBEDDING_DIM)
    return embedder
