"""
Sidecar settings — loaded FIRST, before any memgpt import.

Reads env vars and sets os.environ["MEMGPT_CONFIG_PATH"] so that
memgpt.config.MemGPTConfig.load() picks up the right ini file.
This module must NOT import memgpt.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


# ── embedding configuration ────────────────────────────────────────────────
# Sourced from OPENCLAW_MEMGPT_EMBEDDING_* env vars — injected by the plugin's
# LifecycleManager (from plugin config) in spawn mode, set by hand in attach
# mode. Defaults reproduce the original built-in embedder (HuggingFace
# bge-small), so an unconfigured sidecar behaves exactly as every release
# before embedder configurability.
#
# Providers:
#   huggingface        — in-process sentence-transformers load (the default).
#   openai_compatible  — POST <endpoint>/embeddings against any OpenAI-protocol
#                        server (Ollama / vLLM / LM Studio / LiteLLM). Requires
#                        the matching provider branch in memgpt.embeddings
#                        (openclaw-memgpt-sidecar >= 1.1.0). The stock `openai`
#                        branch cannot serve this case: it validates the model
#                        name against OpenAI's own enum and raises
#                        `'nomic-embed-text' is not a valid OpenAIEmbeddingModelType`.
#   openai / azure     — passed through to the fork's existing branches.

_EMBEDDING_ENV_PREFIX = "OPENCLAW_MEMGPT_EMBEDDING_"

_DEFAULT_HF_MODEL = "BAAI/bge-small-en-v1.5"
_DEFAULT_HF_DIM = 384
_DEFAULT_COMPAT_ENDPOINT = "http://127.0.0.1:11434/v1"  # Ollama's default

_KNOWN_EMBEDDING_PROVIDERS = ("huggingface", "openai_compatible", "openai", "azure")


@dataclass(frozen=True)
class EmbeddingSettings:
    provider: str
    model: str
    dim: int
    endpoint_url: Optional[str]
    # True iff the operator explicitly configured the embedder (any env var
    # set). bootstrap.ensure_memgpt_config uses this to decide whether an
    # existing ini's [embedding] section may be reconciled.
    explicit: bool


def _parse_dim(raw: str, provider: str) -> int:
    try:
        dim = int(raw)
    except ValueError:
        dim = 0
    if dim <= 0:
        raise RuntimeError(
            f"{_EMBEDDING_ENV_PREFIX}DIM must be a positive integer "
            f"(got {raw!r}, provider={provider!r})."
        )
    return dim


def _resolve_embedding_config(
    env: Mapping[str, str] = os.environ,
) -> EmbeddingSettings:
    """Resolve the embedder from OPENCLAW_MEMGPT_EMBEDDING_* env vars.

    Raises on an unknown provider or missing required fields: a misconfigured
    embedder must fail loudly at startup, not fall through to the HuggingFace
    branch and attempt a Hub download of a model that does not exist there
    (observed failure mode: the sidecar started, the embedder load failed, and
    the whole trial voided).
    """
    provider = env.get(_EMBEDDING_ENV_PREFIX + "PROVIDER", "").strip() or "huggingface"
    model = env.get(_EMBEDDING_ENV_PREFIX + "MODEL", "").strip()
    dim_raw = env.get(_EMBEDDING_ENV_PREFIX + "DIM", "").strip()
    endpoint = env.get(_EMBEDDING_ENV_PREFIX + "ENDPOINT_URL", "").strip() or None
    explicit = any(
        env.get(_EMBEDDING_ENV_PREFIX + key)
        for key in ("PROVIDER", "MODEL", "DIM", "ENDPOINT_URL")
    )

    if provider not in _KNOWN_EMBEDDING_PROVIDERS:
        raise RuntimeError(
            f"Unknown embedding provider {provider!r} "
            f"(set via {_EMBEDDING_ENV_PREFIX}PROVIDER). "
            f"Known providers: {', '.join(_KNOWN_EMBEDDING_PROVIDERS)}."
        )

    if provider == "huggingface":
        model = model or _DEFAULT_HF_MODEL
        if dim_raw:
            dim = _parse_dim(dim_raw, provider)
        elif model == _DEFAULT_HF_MODEL:
            dim = _DEFAULT_HF_DIM
        else:
            raise RuntimeError(
                f"{_EMBEDDING_ENV_PREFIX}DIM is required for non-default "
                f"huggingface embedding model {model!r} — it must match the "
                f"vector length the model produces."
            )
        return EmbeddingSettings(provider, model, dim, endpoint, explicit)

    # Remote providers (openai_compatible / openai / azure): no guessable
    # defaults for model or dim, and a wrong dim is silent until the vector
    # store misbehaves — require both (the startup probe then verifies dim).
    if not model:
        raise RuntimeError(
            f"{_EMBEDDING_ENV_PREFIX}MODEL is required when the embedding "
            f"provider is {provider!r}."
        )
    if not dim_raw:
        raise RuntimeError(
            f"{_EMBEDDING_ENV_PREFIX}DIM is required when the embedding "
            f"provider is {provider!r} — the vector length the model returns "
            f"(e.g. 768 for nomic-embed-text)."
        )
    dim = _parse_dim(dim_raw, provider)
    if provider == "openai_compatible" and endpoint is None:
        endpoint = _DEFAULT_COMPAT_ENDPOINT
    return EmbeddingSettings(provider, model, dim, endpoint, explicit)


_embedding = _resolve_embedding_config()

EMBEDDING_PROVIDER = _embedding.provider
EMBEDDING_MODEL = _embedding.model
EMBEDDING_DIM = _embedding.dim
EMBEDDING_ENDPOINT_URL = _embedding.endpoint_url
EMBEDDING_EXPLICIT = _embedding.explicit
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
    load, so the next process is offline-fast.

    huggingface-only: remote providers download nothing, have no cache to warm,
    and must not have HF forced offline process-wide (it would break any
    unrelated HF load elsewhere in the process)."""
    if EMBEDDING_PROVIDER != "huggingface":
        return
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
