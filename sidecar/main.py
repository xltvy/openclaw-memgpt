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

    # Ensure MemGPT ini config exists with the configured embedding settings
    # (env-driven; defaults to HuggingFace bge-small — see settings.py).
    ensure_memgpt_config()

    # Eagerly load embedder — fails loudly if the model cannot be loaded /
    # the embedding endpoint is unreachable / the configured dim is wrong.
    _embedder = load_embedder()

    logger.info(
        "Sidecar ready — host=%s port=%d agents_resident=%d",
        settings.host,
        settings.port,
        len(registry),
    )
    yield

    # ── P4: complementary durability sweep ────────────────────────────────
    # A safety net *under* the per-turn-flush model (§2.3), not a replacement:
    # per-turn `:save` stays the primary durability boundary. This sweep saves
    # whatever is still resident when the sidecar is asked to stop.
    #
    # uvicorn runs this lifespan-shutdown on SIGTERM — which the sidecar
    # receives in BOTH deployment modes (LifecycleManager.stop SIGTERMs the
    # child in gateway mode; the parent's process-exit handler SIGTERMs it in
    # `--local` one-shot mode, where neither the TS `agent_end` hook nor the
    # plugin's `stop` save fires). So this is the one save path guaranteed to
    # run regardless of how the host drives the turn. Idempotent: if a prior
    # `:save` already ran this process, this just writes an identical snapshot.
    save_all_on_shutdown()

    logger.info("Sidecar shutting down — agents_resident=%d", len(registry))


def save_all_on_shutdown() -> None:
    """Save every currently-resident agent. Thin wrapper over `_save_agents`
    so the sweep logic is unit-testable on a controlled agent list without
    touching (or having to mutate) the process-wide registry."""
    _save_agents(registry.items())


def _save_agents(resident: "list[tuple[str, object]]") -> None:
    """Save each (agent_id, agent) in `resident`, isolating per-agent failures
    so one bad agent can't block the rest. Errors are logged, never raised —
    shutdown must complete."""
    if not resident:
        return
    logger.info("P4 shutdown save — flushing %d resident agent(s)", len(resident))
    for agent_id, agent in resident:
        try:
            agent.save()
            logger.info("P4 shutdown save — agent=%s flushed", agent_id)
        except Exception as exc:  # noqa: BLE001 — best-effort durability sweep
            logger.error("P4 shutdown save — agent=%s FAILED: %s", agent_id, exc)


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


# ── Prewarm mode (no server) ────────────────────────────────────────────────
#
# `uv run python main.py --prewarm` loads the embedder (downloading + caching it
# if absent) and exits, WITHOUT starting the FastAPI server. The wizard offers to
# run this at setup so the first real agent turn finds a warm cache and fits
# inside OpenClaw's 15s before_prompt_build hook budget (a cold online load is
# ~56s; a warm offline load is ~0.5s — see bootstrap.load_embedder). Exits 0 on
# success, 1 on failure, so the wizard can report the outcome.

if __name__ == "__main__":
    import sys

    if "--prewarm" in sys.argv:
        logger.info("Prewarm: loading embedder (will download + cache if absent) …")
        try:
            ensure_memgpt_config()
            load_embedder()
        except Exception as exc:  # noqa: BLE001 — report + non-zero exit for the wizard
            logger.error("Prewarm failed: %s", exc)
            sys.exit(1)
        logger.info("Prewarm complete — embedder cached; first agent turn will be fast.")
        sys.exit(0)

    raise SystemExit(
        "main.py is the FastAPI app (run via `uvicorn main:app`). "
        "The only direct-exec mode is `python main.py --prewarm`."
    )
