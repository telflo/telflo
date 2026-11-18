"""Regression tests for the subprocess concurrency cap and stderr buffer cap.

They close a security review's findings #3 (no concurrency cap) and #4
(unbounded stderr buffer). The two are tested together because they live in
the same code path (the runner). D13b ruling 33 reads the pipes through one
subprocess protocol, `_Pipes`.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from app.runner import (
    _STDERR_MAX_BYTES,
    _STDERR_TRUNCATION_MARKER,
    _Pipes,
    acquire_slot,
    run_collector,
)
from app.settings import DEFAULT_MAX_CONCURRENCY as VALIDATE_MAX_CONCURRENCY
from tests.conftest import write_collector


# ---------------------------------------------------------------------------
# Stderr cap — finding #4.
#
# Pre-fix, ``process.communicate()`` read stderr into memory with no bound.
# A YAML triggering high-volume stderr could grow against the pod's memory
# limit. The fix keeps an explicit cap and drops the remainder as it arrives,
# still reading, so the subprocess doesn't deadlock on a full pipe buffer.
# ---------------------------------------------------------------------------


async def _fed(caps: dict[int, int], chunks: list[bytes], fd: int = 2) -> _Pipes:
    pipes = _Pipes(caps)
    for chunk in chunks:
        pipes.pipe_data_received(fd, chunk)
    return pipes


async def test_pipes_keep_everything_under_the_cap() -> None:
    pipes = await _fed({2: 1024}, [b"abc" * 5, b"abc" * 5])
    assert bytes(pipes.kept[2]) == b"abc" * 10
    assert pipes.dropped[2] is False


async def test_pipes_keep_exactly_the_cap_and_say_they_dropped_the_rest() -> None:
    pipes = await _fed({2: 1_000}, [b"x" * 4096] * 3)
    assert bytes(pipes.kept[2]) == b"x" * 1_000
    assert pipes.dropped[2] is True


async def test_pipes_take_whatever_arrives_after_the_cap() -> None:
    """The pipe must keep draining even after nothing more is stored —
    otherwise the subprocess blocks on its next write: data past the cap is
    taken (and dropped), never left in the pipe or refused."""
    pipes = await _fed({2: 1_000}, [b"y" * 4096] * 12)
    assert len(pipes.kept[2]) == 1_000
    pipes.pipe_data_received(2, b"z" * 50_000)  # still taken
    assert len(pipes.kept[2]) == 1_000


async def test_pipes_handle_an_empty_stream() -> None:
    pipes = await _fed({2: 1_000}, [])
    assert bytes(pipes.kept[2]) == b""
    assert pipes.dropped[2] is False


async def test_a_collectors_stderr_under_the_cap_passes_through(binary_dir: Path) -> None:
    """End-to-end check via a real subprocess: a small stderr payload is
    returned verbatim, no truncation marker."""
    binary = write_collector(binary_dir, "0.162.0", "echo error-line-1 >&2; echo error-line-2 >&2; exit 1\n")
    outcome = await run_collector(binary, "x: 1\n", {}, timeout_seconds=10)
    assert "error-line-1" in outcome.stderr
    assert "error-line-2" in outcome.stderr
    assert _STDERR_TRUNCATION_MARKER.decode() not in outcome.stderr
    assert outcome.kind == "failed"


async def test_a_collectors_oversize_stderr_is_capped_and_marked(binary_dir: Path) -> None:
    """A subprocess that floods stderr beyond the cap returns capped data
    plus the truncation marker, and the process is awaited to completion."""
    binary = write_collector(
        binary_dir, "0.162.0", f"yes 'flooded' | head -c {_STDERR_MAX_BYTES + 200_000} >&2\nexit 1\n"
    )
    outcome = await run_collector(binary, "x: 1\n", {}, timeout_seconds=10)
    marker = _STDERR_TRUNCATION_MARKER.decode()
    assert len(outcome.stderr) == _STDERR_MAX_BYTES + len(marker)
    assert outcome.stderr.endswith(marker)
    assert outcome.kind == "failed"  # process completed, didn't hang


# ---------------------------------------------------------------------------
# Concurrency cap — finding #3.
#
# A semaphore around subprocess spawns bounds simultaneous validate runs to
# OTELCOL_VALIDATOR_MAX_CONCURRENCY (default 8). Each collector holds about
# 80 MB, so the container's memory is sized for this number (app/settings.py).
# ---------------------------------------------------------------------------


async def test_validate_semaphore_default_max_matches_pod_sizing() -> None:
    """The default cap must remain in lockstep with the container's memory.
    If you bump the default above 8 here, size the memory accordingly."""
    assert VALIDATE_MAX_CONCURRENCY == 8, (
        "OTELCOL_VALIDATOR_MAX_CONCURRENCY's default changed; verify the "
        "container's memory is sized accordingly"
    )


async def test_validate_semaphore_blocks_n_plus_one() -> None:
    """The (N+1)th acquire waits until a holder releases. Uses a small
    2-slot semaphore so the test is cheap; the app's has the same shape with
    N=8 (created at startup)."""
    sem = asyncio.Semaphore(2)
    await acquire_slot(sem, wait_seconds=1.0)
    await acquire_slot(sem, wait_seconds=1.0)
    # Third acquire must not complete immediately.
    task = asyncio.create_task(acquire_slot(sem, wait_seconds=5.0))
    await asyncio.sleep(0.05)
    assert not task.done(), "3rd acquire should be blocked on a 2-slot semaphore"
    sem.release()
    await asyncio.wait_for(task, timeout=1.0)  # now it should unblock
    assert task.done()
