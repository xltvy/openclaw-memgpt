"""
openclaw-memgpt sidecar — FastAPI entry point.

Import order is load-order critical:
  1. settings  — sets MEMGPT_CONFIG_PATH env var; NO memgpt imports
  2. bootstrap — patches MEMGPT_DIR in memgpt.constants + memgpt.config,
                 then imports the rest of memgpt
  3. everything else

Never reorder the first two imports.
"""

# ── 1. Settings FIRST — sets env vars before any memgpt module is touched ──
from settings import settings  # noqa: F401 (side-effect import)

# ── 2. Standard library + framework ───────────────────────────────────────
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

# ── 3. Bootstrap (patches MEMGPT_DIR, then imports memgpt internals) ───────
from bootstrap import ensure_memgpt_config, load_embedder

# ── 4. Registry (uses Any for Agent; no further memgpt import cascade) ─────
from registry import registry

# ── 5. Route modules (safe to import after bootstrap has run) ──────────────
from routes.agents import router as agents_router

# ── Logging ───────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)
logger = logging.getLogger("sidecar")

# ── Startup / shutdown ────────────────────────────────────────────────────

_embedder = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _embedder

    logger.info("Sidecar starting — data_dir=%s", settings.data_dir)

    # Ensure MemGPT ini config exists with bge-small embedding settings.
    ensure_memgpt_config()

    # Eagerly load embedder — fails loudly if bge-small cannot be loaded.
    _embedder = load_embedder()

    logger.info(
        "Sidecar ready — host=%s port=%d agents_resident=%d",
        settings.host,
        settings.port,
        len(registry),
    )
    yield

    logger.info("Sidecar shutting down — agents_resident=%d", len(registry))


# ── App ───────────────────────────────────────────────────────────────────

app = FastAPI(
    title="openclaw-memgpt sidecar",
    description="MemGPT three-tier memory substrate for OpenClaw.",
    version="0.1.0",
    lifespan=lifespan,
)


# ── Routes ────────────────────────────────────────────────────────────────

app.include_router(agents_router)


@app.get("/healthz", summary="Liveness probe")
def healthz():
    """Returns 200 when the sidecar is alive and the embedder is loaded."""
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "embedder": "ready" if _embedder is not None else "not_loaded",
            "agents_resident": len(registry),
        },
    )
