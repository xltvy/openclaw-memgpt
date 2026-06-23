"""V1.3 experimental driver.

Orchestrates probes × trials × cells per `experiments/v1-runs/README.md`,
emits V1.4-shaped JSON per `docs/v1-observability.md` §5, and records
pickle paths for post-hoc inspection. Cell A trials run in-process via
`cell_a/wrapper.py`; Cell C trials run via `openclaw … agent --message`
subprocess invocation per `docs/v1-cells.md` §2.

Invocation is **explicit, not implicit** — by default the driver runs no
trials. The operator selects a slice via flags:

    # Cell A, one probe, one trial (for the dry-run gate)
    uv run python driver.py --cell A --probe p1 --trials 1

    # Cell A, full slate (5/5/5/5/10/10/5 = 50 trials)
    uv run python driver.py --cell A --all

    # Cell C, single probe slate
    uv run python driver.py --cell C --probe p3

This shape exists so V1.3 can run in chunks — driver invocations are
re-entrant; existing per-trial outputs are not overwritten unless
`--overwrite` is passed. The 90-trial full slate is structured so the
operator can run Cell A and Cell C in separate driver invocations (each
cell needs the fork checked out to its respective branch per
`docs/v1-cells.md` §1: Cell A → `v1-cell-a`; Cell C → `main`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.error import URLError
from urllib.request import urlopen

from extract import extract_v14_record

HERE = Path(__file__).resolve().parent


# --- Probe set --------------------------------------------------------------
# Hardcoded from `docs/v1-probes.md` §3. The doc is the authoritative
# source; this is a machine-readable mirror so the driver doesn't need to
# parse Markdown. If the doc changes, this block changes alongside.


@dataclass
class Probe:
    probe_id: str
    text_turns: list[str]  # one entry per user turn within a session
    session_2_turns: list[str] | None  # None for non-cross-session probes
    trials: int
    expected_tier: str

    @property
    def cross_session(self) -> bool:
        return self.session_2_turns is not None


PROBES: list[Probe] = [
    Probe(
        probe_id="p1",
        text_turns=["Please remember that I'm working on a dissertation about AI memory architectures."],
        session_2_turns=None,
        trials=5,
        expected_tier="core",
    ),
    Probe(
        probe_id="p2",
        text_turns=["Please store this for later reference: the project code is PINEAPPLE_8101."],
        session_2_turns=None,
        trials=5,
        expected_tier="archival",
    ),
    Probe(
        probe_id="p3",
        text_turns=[
            "Store that the project code is PINEAPPLE_8101 in archival, then search archival to confirm it's there."
        ],
        session_2_turns=None,
        trials=5,
        expected_tier="archival",
    ),
    Probe(
        probe_id="p4",
        text_turns=[
            "The project code is BLUEBIRD_5402.",
            "What was the project code I mentioned?",
        ],
        session_2_turns=None,
        trials=5,
        expected_tier="recall",
    ),
    Probe(
        probe_id="p5",
        text_turns=[
            "Remember: the project code is CARDINAL_3987, used for milestone Q4.",
            "Tell me a short poem about birds.",
        ],
        session_2_turns=["I mentioned a project code earlier — what was it?"],
        trials=10,
        expected_tier="recall",
    ),
    Probe(
        probe_id="p6",
        text_turns=["Please remember that I usually work in the evening."],
        session_2_turns=None,
        trials=10,
        expected_tier="ambiguous(core|archival)",
    ),
    Probe(
        probe_id="p7",
        text_turns=["Hello."],
        session_2_turns=None,
        trials=5,
        expected_tier="N/A",
    ),
]

PROBE_BY_ID = {p.probe_id: p for p in PROBES}


# --- Stack health prechecks -------------------------------------------------


@dataclass
class HealthCheckResult:
    name: str
    ok: bool
    detail: str


def _http_ok(url: str, timeout: float = 3.0) -> tuple[bool, str]:
    try:
        with urlopen(url, timeout=timeout) as resp:
            body = resp.read(1024).decode("utf-8", errors="replace")
            return (200 <= resp.status < 300, f"{resp.status} {body[:200]}")
    except URLError as e:
        return (False, f"URLError: {e}")
    except Exception as e:  # noqa: BLE001
        return (False, f"{type(e).__name__}: {e}")


def health_checks(cell: str) -> list[HealthCheckResult]:
    """Stack prechecks per `CLAUDE.md` RUNNING THE STACK. Both cells need
    LiteLLM running; Cell C additionally needs OpenClaw accessible (we just
    probe `--help` to confirm the binary runs).

    Provider switch (methodology-bank #24, V1.4 completion): the proxy_shim
    (port 4100) was only required for the institutional Bedrock chain. The
    direct-Anthropic chain (`proxy/litellm_config.yaml` → api.anthropic.com
    via `os.environ/ANTHROPIC_API_KEY`) has no shim, so the 4100 check is no
    longer a fatal precondition. Set `V1_REQUIRE_SHIM=1` to re-enable it for
    institutional-chain runs."""
    results: list[HealthCheckResult] = []

    if os.environ.get("V1_REQUIRE_SHIM") == "1":
        ok, detail = _http_ok("http://127.0.0.1:4100/healthz")
        results.append(HealthCheckResult("proxy_shim:4100/healthz", ok, detail))

    # LiteLLM proxy: try `/health/liveliness` (LiteLLM's idiomatic endpoint).
    # Fall back to a chat-completions OPTIONS probe if liveliness is gated.
    ok, detail = _http_ok("http://127.0.0.1:4000/health/liveliness")
    if not ok:
        ok, detail2 = _http_ok("http://127.0.0.1:4000/")
        if ok:
            detail = f"liveliness endpoint absent; root OK: {detail2}"
    results.append(HealthCheckResult("litellm:4000", ok, detail))

    if cell == "C":
        try:
            r = subprocess.run(
                ["openclaw", "--help"], capture_output=True, text=True, timeout=10
            )
            ok = r.returncode == 0
            detail = (r.stdout or r.stderr).splitlines()[0] if (r.stdout or r.stderr) else ""
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"{type(e).__name__}: {e}"
        results.append(HealthCheckResult("openclaw CLI", ok, detail))

    return results


def assert_healthy(cell: str) -> None:
    results = health_checks(cell)
    print("Stack health:")
    for r in results:
        mark = "OK" if r.ok else "FAIL"
        print(f"  [{mark}] {r.name} — {r.detail}")
    bad = [r for r in results if not r.ok]
    if bad:
        names = ", ".join(r.name for r in bad)
        raise SystemExit(f"Stack health prechecks failed: {names}")


# --- Output paths -----------------------------------------------------------


def _probe_dir(probe_id: str) -> Path:
    p = HERE / probe_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _trial_json_path(probe_id: str, cell: str, trial_id: int) -> Path:
    return _probe_dir(probe_id) / f"cell-{cell.lower()}-{trial_id}.json"


def _trial_pickle_pointer_path(probe_id: str, cell: str, trial_id: int) -> Path:
    return _probe_dir(probe_id) / f"cell-{cell.lower()}-{trial_id}-pickle-path.txt"


def _trial_log_path(probe_id: str, cell: str, trial_id: int) -> Path:
    return _probe_dir(probe_id) / f"cell-{cell.lower()}-{trial_id}.log"


def _trial_jsonl_path(probe_id: str, cell: str, trial_id: int, suffix: str = "") -> Path:
    """OpenClaw session-JSONL copy for the trial. Defensive belt-and-braces
    capture: the JSONL is OpenClaw's source-of-truth structured event stream
    (toolCall blocks, toolResult content, message timestamps). The sidecar
    pickle is fed via the §3.7 normalise boundary and is *intended* to be a
    faithful projection — but the V1.3 slate surfaced that until the
    methodology-bank #20 fix it silently was not (no toolCall structure
    persisted). Keeping per-trial JSONL copies means V1.4 can cross-check
    extraction without needing to re-run trials when a future projection
    bug emerges.

    `suffix` distinguishes session 1 vs session 2 for cross-session probes
    (e.g. '-s1', '-s2'); empty for single-session probes."""
    return _probe_dir(probe_id) / f"cell-{cell.lower()}-{trial_id}{suffix}.jsonl"


def _write_trial_artefacts(
    probe_id: str,
    cell: str,
    trial_id: int,
    record: dict,
    pickle_path: str,
    session_2_pickle_path: str | None = None,
) -> None:
    json_path = _trial_json_path(probe_id, cell, trial_id)
    json_path.write_text(json.dumps(record, indent=2))

    pointer = _trial_pickle_pointer_path(probe_id, cell, trial_id)
    if session_2_pickle_path is not None:
        pointer.write_text(
            f"session_1: {pickle_path}\nsession_2: {session_2_pickle_path}\n"
        )
    else:
        pointer.write_text(f"{pickle_path}\n")


# --- Cell A trial execution -------------------------------------------------


async def _run_cell_a_trial(probe: Probe, trial_id: int) -> None:
    # Import deferred so health-only invocations don't pay the import cost.
    from cell_a.wrapper import (
        CellAConfig,
        bootstrap_embedder,
        run_single_turn_trial,
        run_multi_turn_trial,
        run_cross_session_trial,
    )

    bootstrap_embedder()
    agent_name = f"v1_cell_a_{probe.probe_id}_t{trial_id:02d}"
    cfg = CellAConfig(agent_name=agent_name)

    if probe.cross_session:
        result = await run_cross_session_trial(
            cfg,
            session_1_turns=probe.text_turns,
            session_2_turns=probe.session_2_turns or [],
        )
        # V1.4-shaped record covers session_2's pickle (post-restart recall).
        # The session_1 pickle is kept as a pointer for cross-validation.
        record = extract_v14_record(
            pickle_path=result.session_2_pickle_path,
            cell="A",
            probe_id=probe.probe_id,
            trial_id=trial_id,
            expected_tier=probe.expected_tier,
        )
        _write_trial_artefacts(
            probe_id=probe.probe_id,
            cell="A",
            trial_id=trial_id,
            record=record,
            pickle_path=result.session_1_pickle_path,
            session_2_pickle_path=result.session_2_pickle_path,
        )
    elif len(probe.text_turns) == 1:
        result = await run_single_turn_trial(cfg, probe.text_turns[0])
        record = extract_v14_record(
            pickle_path=result.pickle_path,
            cell="A",
            probe_id=probe.probe_id,
            trial_id=trial_id,
            expected_tier=probe.expected_tier,
        )
        _write_trial_artefacts(probe.probe_id, "A", trial_id, record, result.pickle_path)
    else:
        result = await run_multi_turn_trial(cfg, probe.text_turns)
        record = extract_v14_record(
            pickle_path=result.pickle_path,
            cell="A",
            probe_id=probe.probe_id,
            trial_id=trial_id,
            expected_tier=probe.expected_tier,
        )
        _write_trial_artefacts(probe.probe_id, "A", trial_id, record, result.pickle_path)


# --- Cell C trial execution -------------------------------------------------

CONFIG_PATH = Path.home() / ".openclaw-dev" / "openclaw.json"
SIDECAR_DATA_DIR = Path.home() / ".openclaw-dev" / "memgpt-data"
OPENCLAW_SESSIONS_DIR = Path.home() / ".openclaw-dev" / "agents" / "main" / "sessions"

# Controlled variables — `docs/v1-cells.md` §3. The driver pins these into the
# plugin config at slate start rather than trusting whatever the operator's
# openclaw.json happens to carry. Methodology-bank #23: the original slate
# inherited a stale persona/human from openclaw.json (Cell C ran a different
# persona than Cell A), confounding the comparison. Asserting them here makes
# the controlled variable a property of the rig, not of ambient config.
V1_PERSONA = "Sam is a friendly AI assistant with an extensive knowledge base."
V1_HUMAN = "The user is a researcher exploring AI memory architectures."


def _read_openclaw_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def _write_openclaw_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def _plugin_config(cfg: dict) -> dict:
    """Resolve to the openclaw-memgpt plugin config block, creating the
    nested path if absent. OpenClaw's config schema (verified at runtime
    against the installed CLI 2026.4.21) puts plugin entries under
    `plugins.entries.<plugin-id>`. Writing to root-level `entries` is
    rejected with "Unrecognized key: 'entries'" — that bug bit V1.3's
    first Cell C attempt; fixed here."""
    return (
        cfg.setdefault("plugins", {})
        .setdefault("entries", {})
        .setdefault("openclaw-memgpt", {})
        .setdefault("config", {})
    )


def _snapshot_plugin_config() -> dict:
    """Capture the full plugin config block so it can be restored after
    the slate. Per-trial namespace updates are layered on top of this
    snapshot; the slate-level teardown puts the user's manual state back."""
    cfg = _read_openclaw_config()
    plugin_cfg = _plugin_config(cfg)
    return json.loads(json.dumps(plugin_cfg))  # deep copy via JSON round-trip


def _apply_v1_overrides(snapshot: dict) -> None:
    """One-shot at slate start: drop `sidecarUrl` (force spawn mode per
    v1-cells.md §2 — restart between sessions is the load-bearing test for
    p5) and quiet the observability stream to keep per-trial logs slim.

    The snapshot is the value to restore at slate end; this function
    mutates the on-disk config to V1.3 values."""
    cfg = _read_openclaw_config()
    plugin_cfg = _plugin_config(cfg)
    plugin_cfg.update(snapshot)  # start from operator's prior state
    plugin_cfg.pop("sidecarUrl", None)  # force spawn mode
    plugin_cfg["observability"] = "default"
    # Pin the §3 controlled variables (methodology-bank #23) — Cell A reads
    # these via its own CLI config; Cell C must match byte-for-byte.
    plugin_cfg["persona"] = V1_PERSONA
    plugin_cfg["human"] = V1_HUMAN
    _write_openclaw_config(cfg)


def _restore_plugin_config(snapshot: dict) -> None:
    cfg = _read_openclaw_config()
    plugin_cfg = _plugin_config(cfg)
    plugin_cfg.clear()
    plugin_cfg.update(snapshot)
    _write_openclaw_config(cfg)


def _set_namespace_in_config(namespace: str) -> str:
    """Write the trial-specific namespace into the openclaw-memgpt plugin
    config. Returns the previous namespace so callers can restore on
    teardown."""
    cfg = _read_openclaw_config()
    plugin_cfg = _plugin_config(cfg)
    prev = plugin_cfg.get("namespace", "default")
    plugin_cfg["namespace"] = namespace
    _write_openclaw_config(cfg)
    return prev


def _latest_sidecar_pickle(namespace: str) -> str:
    pm_dir = SIDECAR_DATA_DIR / "agents" / namespace / "persistence_manager"
    if not pm_dir.exists():
        raise RuntimeError(
            f"sidecar pm dir missing for namespace {namespace}: {pm_dir}\n"
            f"(plugin may not have called save; check OpenClaw stderr)"
        )
    pickles = list(pm_dir.glob("*.persistence.pickle"))
    if not pickles:
        raise RuntimeError(f"no .persistence.pickle in {pm_dir}")
    return str(max(pickles, key=lambda p: p.stat().st_mtime))


def _capture_session_jsonl(session_id: str, dest: Path) -> None:
    """Copy the just-written session JSONL into the trial dir before any
    archival step claims it. No-op if the JSONL doesn't exist (degraded
    paths: OpenClaw aborted before writing, methodology-bank #19 fallback
    didn't initialise, etc.). Idempotent — overwrites a previous capture if
    a turn re-ran.

    The lookup tries `{session_id}.jsonl` first; if that's missing (some
    `--local`-mode invocations leave the file named after the previous
    session-id and just append, per the V1.4 smoke-test finding), falls
    back to the most-recently-modified `.jsonl` in the sessions dir.

    Implemented via shutil.copy2 rather than rename so the source JSONL
    stays in place; OpenClaw's own session-store mechanics are untouched."""
    import shutil
    src = OPENCLAW_SESSIONS_DIR / f"{session_id}.jsonl"
    if not src.exists():
        # Fallback: newest JSONL in the dir (OpenClaw --local sometimes
        # appends to a pre-existing JSONL regardless of --session-id; the
        # _reset_openclaw_session_state step before each trial means the
        # newest JSONL IS this trial's, but the filename may not match).
        jsonls = sorted(
            OPENCLAW_SESSIONS_DIR.glob("*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not jsonls:
            return
        src = jsonls[0]
    shutil.copy2(src, dest)


def _reset_openclaw_session_state() -> None:
    """Wipe OpenClaw's session-store before each trial.

    Surfaced during the V1.4 smoke test: OpenClaw `--local` mode appends to
    the most-recent JSONL in `~/.openclaw-dev/agents/main/sessions/` even
    when `--session-id` provides a new name, leading to a single rolling
    file that accumulates across all trials. Wiping the sessions dir at
    each trial boundary forces OpenClaw to create a fresh JSONL named
    after the new session-id, which makes per-trial capture deterministic.
    Also clears `sessions.json` so OpenClaw's session manifest starts
    clean — defensive in case OpenClaw uses the manifest to route to a
    pre-existing file."""
    if not OPENCLAW_SESSIONS_DIR.exists():
        return
    for src in OPENCLAW_SESSIONS_DIR.glob("*.jsonl"):
        src.unlink()
    sessions_json = OPENCLAW_SESSIONS_DIR / "sessions.json"
    if sessions_json.exists():
        sessions_json.unlink()
    # OpenClaw older paths put sessions.json one level up; cover both.
    sessions_json_alt = OPENCLAW_SESSIONS_DIR.parent / "sessions.json"
    if sessions_json_alt.exists():
        sessions_json_alt.unlink()


def _reset_sidecar_agent_dir(namespace: str) -> None:
    """Wipe the sidecar's persisted agent state for a namespace.

    `docs/v1-probes.md` §4.2 requires fresh-agent discipline per trial.
    The driver uses namespace-per-trial (unique cell-c-p<probe>-t<trial>
    names) to satisfy this across-trial within one slate run, BUT a
    repeated slate (re-run) hits the same namespace dirs from the prior
    run — the sidecar's `:ensure` then takes the `:load` path against
    stale data instead of `:create` against a fresh agent. The V1.4
    re-run surfaced this: a single 'p1 trial 0' produced 22 steps
    because 21 came from the prior (broken-slate) accumulation.

    Wiping the agent dir before each trial restores the `:create` path
    regardless of slate iteration. No-op if the dir doesn't exist."""
    import shutil
    agent_dir = SIDECAR_DATA_DIR / "agents" / namespace
    if agent_dir.exists():
        shutil.rmtree(agent_dir)


def _archive_session_jsonls(label: str) -> None:
    """Move `~/.openclaw-dev/agents/main/sessions/*.jsonl` and
    `sessions.json` aside before a strict-isolation cross-session
    boundary, per `docs/v1-probes.md` §4.3 step 3 / `CLAUDE.md` V1 PROTOCOL.

    The archive name is timestamped + labelled so it's traceable to the
    trial that generated it."""
    if not OPENCLAW_SESSIONS_DIR.exists():
        return  # nothing to archive
    ts = int(time.time())
    archive_dir = OPENCLAW_SESSIONS_DIR.parent / f"sessions-archive-{label}-{ts}"
    archive_dir.mkdir(parents=True, exist_ok=True)
    for src in OPENCLAW_SESSIONS_DIR.iterdir():
        src.rename(archive_dir / src.name)
    sessions_json = OPENCLAW_SESSIONS_DIR.parent / "sessions.json"
    if sessions_json.exists():
        sessions_json.rename(archive_dir / "sessions.json")


def _invoke_openclaw_turn(
    message: str, session_id: str | None, trial_log_path: Path, timeout: int = 600
) -> None:
    """One `openclaw … agent --message …` invocation. The sidecar's spawn
    lifecycle handles its own startup and teardown per 6c.10b; we just
    wait for the subprocess to exit. Stdout+stderr captured to
    `trial_log_path` for post-hoc inspection (the V1 PROTOCOL warns that
    the JSON envelope's success fields are unreliable; the log is
    auxiliary diagnostic, not acceptance signal)."""
    cmd = ["openclaw", "--dev", "agent", "--local", "--agent", "main", "--message", message, "--json"]
    if session_id is not None:
        cmd += ["--session-id", session_id]
    with open(trial_log_path, "a") as log:
        log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} :: {' '.join(cmd)}\n")
        log.flush()
        r = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(
            f"openclaw exited with returncode {r.returncode}; see {trial_log_path}"
        )


def _run_cell_c_trial(probe: Probe, trial_id: int) -> None:
    namespace = f"v1-cell-c-{probe.probe_id}-t{trial_id:02d}"
    prev_ns = _set_namespace_in_config(namespace)
    log_path = _trial_log_path(probe.probe_id, "C", trial_id)
    if log_path.exists():
        log_path.unlink()

    # Fresh-agent discipline (v1-probes.md §4.2): wipe any prior sidecar
    # state for this namespace and any prior OpenClaw session state so the
    # trial runs against a true `:create` path, not `:load` against stale
    # data. Surfaced during the V1.4 re-run smoke; without these resets the
    # re-run inherits the broken-slate accumulated history.
    _reset_sidecar_agent_dir(namespace)
    _reset_openclaw_session_state()

    try:
        if probe.cross_session:
            # Session 1.
            session_id = f"{namespace}-s1"
            for turn in probe.text_turns:
                _invoke_openclaw_turn(turn, session_id, log_path)
            session_1_pickle = _latest_sidecar_pickle(namespace)

            # Capture the session-1 JSONL into the trial dir BEFORE the
            # strict-isolation archival sweeps the sessions dir clean.
            _capture_session_jsonl(
                session_id,
                _trial_jsonl_path(probe.probe_id, "C", trial_id, suffix="-s1"),
            )

            # Strict isolation: archive session JSONLs before session 2.
            _archive_session_jsonls(label=f"{namespace}-s1")

            # Session 2 — new session-id so OpenClaw doesn't replay session 1's
            # JSONL (which is now archived anyway, but belt + braces).
            session_id_2 = f"{namespace}-s2"
            for turn in probe.session_2_turns or []:
                _invoke_openclaw_turn(turn, session_id_2, log_path)
            session_2_pickle = _latest_sidecar_pickle(namespace)

            _capture_session_jsonl(
                session_id_2,
                _trial_jsonl_path(probe.probe_id, "C", trial_id, suffix="-s2"),
            )

            record = extract_v14_record(
                pickle_path=session_2_pickle,
                cell="C",
                probe_id=probe.probe_id,
                trial_id=trial_id,
                expected_tier=probe.expected_tier,
            )
            _write_trial_artefacts(
                probe.probe_id, "C", trial_id, record,
                pickle_path=session_1_pickle,
                session_2_pickle_path=session_2_pickle,
            )
        else:
            session_id = namespace  # one session per trial, namespace-tagged
            for turn in probe.text_turns:
                _invoke_openclaw_turn(turn, session_id, log_path)
            pickle_path = _latest_sidecar_pickle(namespace)

            _capture_session_jsonl(
                session_id,
                _trial_jsonl_path(probe.probe_id, "C", trial_id),
            )

            record = extract_v14_record(
                pickle_path=pickle_path,
                cell="C",
                probe_id=probe.probe_id,
                trial_id=trial_id,
                expected_tier=probe.expected_tier,
            )
            _write_trial_artefacts(probe.probe_id, "C", trial_id, record, pickle_path)
    finally:
        # Restore prior namespace (courtesy — keeps the operator's manual
        # smoke-test state untouched if they had one).
        _set_namespace_in_config(prev_ns)


# --- Orchestration ----------------------------------------------------------


def _trial_already_done(probe_id: str, cell: str, trial_id: int) -> bool:
    return _trial_json_path(probe_id, cell, trial_id).exists()


def run_probe(probe: Probe, cell: str, trials: int, *, overwrite: bool) -> None:
    """Run `trials` trials of one probe in one cell. Trial IDs are
    zero-indexed and contiguous."""
    runner: Callable[[Probe, int], None]
    if cell == "A":

        def runner(p: Probe, t: int) -> None:
            asyncio.run(_run_cell_a_trial(p, t))

    elif cell == "C":
        runner = _run_cell_c_trial
    else:
        raise ValueError(f"unknown cell: {cell}")

    for trial_id in range(trials):
        if not overwrite and _trial_already_done(probe.probe_id, cell, trial_id):
            print(f"[{probe.probe_id} cell {cell} trial {trial_id}] SKIP (already done)")
            continue
        t0 = time.time()
        try:
            runner(probe, trial_id)
            dt = time.time() - t0
            print(f"[{probe.probe_id} cell {cell} trial {trial_id}] OK ({dt:.1f}s)")
        except Exception as e:  # noqa: BLE001
            dt = time.time() - t0
            print(
                f"[{probe.probe_id} cell {cell} trial {trial_id}] FAIL after {dt:.1f}s: {type(e).__name__}: {e}",
                file=sys.stderr,
            )
            # Continue with the next trial rather than aborting the whole
            # slate — per V1.3 spec, "if a trial fails, re-run it. If a
            # probe consistently fails, surface — that's data, not a
            # problem."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="V1.3 experimental driver")
    parser.add_argument("--cell", required=True, choices=["A", "C"])
    parser.add_argument(
        "--probe",
        help="Probe ID (p1..p7). Omit with --all to run every probe.",
    )
    parser.add_argument("--all", action="store_true", help="Run all 7 probes")
    parser.add_argument(
        "--trials",
        type=int,
        default=None,
        help="Override the probe's default trial count (e.g. --trials 1 for the dry-run gate).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Re-run trials whose artefacts already exist (default: skip).",
    )
    parser.add_argument(
        "--skip-health-checks",
        action="store_true",
        help="Skip stack health prechecks (use only when prechecks misfire — they're cheap).",
    )
    args = parser.parse_args(argv)

    if not args.all and not args.probe:
        parser.error("must supply either --probe <id> or --all")
    if args.all and args.probe:
        parser.error("--all and --probe are mutually exclusive")

    if not args.skip_health_checks:
        assert_healthy(args.cell)

    targets: list[Probe]
    if args.all:
        targets = PROBES
    else:
        if args.probe not in PROBE_BY_ID:
            parser.error(f"unknown probe: {args.probe} (choose from {list(PROBE_BY_ID)})")
        targets = [PROBE_BY_ID[args.probe]]

    # Cell C only: snapshot + override + restore the plugin's config block
    # around the slate. Cell A does not touch openclaw.json.
    plugin_snapshot: dict | None = None
    if args.cell == "C":
        plugin_snapshot = _snapshot_plugin_config()
        _apply_v1_overrides(plugin_snapshot)
        print(f"plugin config snapshotted; V1.3 overrides applied (sidecarUrl cleared → spawn mode).")

    try:
        for probe in targets:
            trials = args.trials if args.trials is not None else probe.trials
            print(f"\n=== {probe.probe_id} cell {args.cell} — {trials} trials ===")
            run_probe(probe, args.cell, trials, overwrite=args.overwrite)
    finally:
        if plugin_snapshot is not None:
            _restore_plugin_config(plugin_snapshot)
            print(f"plugin config restored from snapshot.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
