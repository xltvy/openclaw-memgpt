"""
Bootstrap — runs after settings.py but before any sidecar endpoint code.

Responsibilities:
  1. Patch memgpt.constants.MEMGPT_DIR and memgpt.config.MEMGPT_DIR to our
     data_dir (constants.py evaluates the path at module load time from HOME;
     we patch both the source module and the local copy in config.py).
  2. Ensure the MemGPT ini config file exists with the configured embedding
     settings (settings.py, env-driven; defaults to HuggingFace bge-small),
     reconciling an existing ini's [embedding] section when the operator
     explicitly configured the embedder.
  3. Eagerly load the embedder at startup so a missing model / unreachable
     embedding endpoint fails loudly here, not at the first archival:insert.

Import order matters: settings must be imported before this module.
"""

from __future__ import annotations

import os
import logging

from settings import (
    settings,
    EMBEDDING_PROVIDER,
    EMBEDDING_MODEL,
    EMBEDDING_ENDPOINT_URL,
    EMBEDDING_DIM,
    EMBEDDING_CHUNK_SIZE,
    EMBEDDING_EXPLICIT,
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
    """Write the MemGPT ini config with the configured embedding settings if
    absent; reconcile an existing ini's [embedding] section when the embedder
    was explicitly configured and the ini disagrees.

    Uses MemGPTConfig.save() so the file format stays in sync with the fork.
    An existing file is left unchanged UNLESS the operator explicitly set
    OPENCLAW_MEMGPT_EMBEDDING_* (EMBEDDING_EXPLICIT): the plugin config is the
    user-facing source of truth for the embedder, and the original
    write-if-absent behaviour meant a config change was silently ignored on
    any profile that already had an ini.
    """
    from memgpt.config import MemGPTConfig

    if os.path.exists(settings.config_path):
        if EMBEDDING_EXPLICIT:
            _reconcile_embedding_section(MemGPTConfig)
        else:
            logger.debug(
                "MemGPT config exists at %s — skipping write", settings.config_path
            )
        return

    os.makedirs(settings.data_dir, exist_ok=True)
    logger.info("Writing MemGPT config to %s", settings.config_path)

    cfg = MemGPTConfig(
        config_path=settings.config_path,
        embedding_provider=EMBEDDING_PROVIDER,
        embedding_model=EMBEDDING_MODEL,
        # Required by the openai_compatible provider; None for huggingface
        # (MemGPTConfig.save omits the key when unset).
        embedding_endpoint_url=EMBEDDING_ENDPOINT_URL,
        embedding_dim=EMBEDDING_DIM,
        embedding_chunk_size=EMBEDDING_CHUNK_SIZE,
        # archival storage: local (path resolved per-agent by AgentConfig)
        archival_storage_type="local",
    )
    cfg.save()


def _reconcile_embedding_section(MemGPTConfig) -> None:
    """Rewrite the ini's [embedding] section to the explicitly-configured
    values when they differ, warning loudly on a dimension change: existing
    agent stores hold old-dimension vectors and are incompatible with the new
    embedder (clear the agents dir, or revert the embedding config)."""
    cfg = MemGPTConfig.load()
    same = (
        cfg.embedding_provider == EMBEDDING_PROVIDER
        and cfg.embedding_model == EMBEDDING_MODEL
        and (cfg.embedding_endpoint_url or None) == EMBEDDING_ENDPOINT_URL
        and int(cfg.embedding_dim) == EMBEDDING_DIM
    )
    if same:
        return

    agents_dir = os.path.join(settings.data_dir, "agents")
    has_agents = os.path.isdir(agents_dir) and len(os.listdir(agents_dir)) > 0
    if int(cfg.embedding_dim) != EMBEDDING_DIM and has_agents:
        logger.warning(
            "Embedding dimension change (%d → %d) with existing agent state in "
            "%s. Existing archival/recall vectors were embedded at the old "
            "dimension and are INCOMPATIBLE with the new embedder — clear the "
            "agents directory (or revert the embedding config) before relying "
            "on memory search.",
            int(cfg.embedding_dim),
            EMBEDDING_DIM,
            agents_dir,
        )

    logger.info(
        "Reconciling MemGPT [embedding] config: %s/%s (dim=%d) → %s/%s (dim=%d)",
        cfg.embedding_provider,
        cfg.embedding_model,
        int(cfg.embedding_dim),
        EMBEDDING_PROVIDER,
        EMBEDDING_MODEL,
        EMBEDDING_DIM,
    )
    cfg.embedding_provider = EMBEDDING_PROVIDER
    cfg.embedding_model = EMBEDDING_MODEL
    cfg.embedding_endpoint_url = EMBEDDING_ENDPOINT_URL
    cfg.embedding_dim = EMBEDDING_DIM
    cfg.embedding_chunk_size = EMBEDDING_CHUNK_SIZE
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
    online in this process.

    The whole marker/offline dance applies to the huggingface provider only.
    Remote providers (openai_compatible / openai / azure) download nothing;
    for them this is a connectivity + configuration probe, and the startup
    probe's vector length is asserted against EMBEDDING_DIM for every provider
    (a wrong dim is otherwise silent until the vector store misbehaves)."""
    from memgpt.embeddings import embedding_model

    hf = EMBEDDING_PROVIDER == "huggingface"
    offline = hf and os.environ.get("HF_HUB_OFFLINE") == "1"
    if hf:
        mode = "offline cache" if offline else "online"
    else:
        mode = f"remote endpoint {EMBEDDING_ENDPOINT_URL or '(provider default)'}"
    logger.info(
        "Loading embedding model %s/%s (%s) …", EMBEDDING_PROVIDER, EMBEDDING_MODEL, mode
    )
    try:
        embedder = embedding_model()
        probe = embedder.get_text_embedding("startup probe")
    except Exception as exc:
        if offline:
            _clear_warm_marker()
            raise RuntimeError(
                "Embedder model cache appears unavailable. "
                "Run `openclaw memgpt prewarm` or restart to re-download."
            ) from exc
        raise RuntimeError(
            f"Embedder load failed — cannot start sidecar. "
            f"provider={EMBEDDING_PROVIDER} model={EMBEDDING_MODEL}"
            + (f" endpoint={EMBEDDING_ENDPOINT_URL}" if not hf else "")
            + f". Cause: {exc}"
        ) from exc

    if len(probe) != EMBEDDING_DIM:
        raise RuntimeError(
            f"Embedding dimension mismatch — cannot start sidecar. Model "
            f"{EMBEDDING_MODEL!r} returned a {len(probe)}-dim vector but the "
            f"configured dim is {EMBEDDING_DIM}. Set "
            f"OPENCLAW_MEMGPT_EMBEDDING_DIM={len(probe)} (plugin config: "
            f"embeddingDim) to match the model."
        )

    if hf:
        _write_warm_marker()
        logger.info(
            "Embedder ready (dim=%d, %s)",
            EMBEDDING_DIM, "offline cache hit" if offline else "downloaded + cached",
        )
    else:
        logger.info("Embedder ready (dim=%d, remote)", EMBEDDING_DIM)
    return embedder
