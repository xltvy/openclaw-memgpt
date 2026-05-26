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


@dataclass(frozen=True)
class SidecarSettings:
    data_dir: str          # root data directory; maps to MEMGPT_DIR for agent state
    config_path: str       # path to the MemGPT ini config file
    host: str
    port: int


def _load() -> SidecarSettings:
    data_dir = os.environ.get(
        "OPENCLAW_MEMGMT_DATA_DIR",
        os.path.join(os.path.expanduser("~"), ".openclaw-memgpt"),
    )
    config_path = os.path.join(data_dir, "config")

    # Tell memgpt.config.MemGPTConfig where its ini file lives.
    # Must be done before the first `import memgpt.config`.
    os.environ.setdefault("MEMGPT_CONFIG_PATH", config_path)

    return SidecarSettings(
        data_dir=data_dir,
        config_path=config_path,
        host=os.environ.get("OPENCLAW_MEMGMT_HOST", "127.0.0.1"),
        port=int(os.environ.get("OPENCLAW_MEMGMT_PORT", "8765")),
    )


# Singleton — importing this module executes the load immediately.
settings: SidecarSettings = _load()
