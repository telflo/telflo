"""Hang guards (D13b ruling 36): a test whose code under test could hang runs
that code where a hang can be seen and stopped, and a hang fails the test.

The limit is a guard, never a timing assertion: it is far above what the
work takes (seconds), and nothing asserts how fast anything ran.

- `in_thread` runs an asyncio scenario on its own event loop in a daemon
  thread. A hung loop waits in `select`, so the test's thread gets the
  interpreter back at the limit, kills the check processes the scenario
  left, and fails.
- `in_subprocess` runs Python source in a fresh interpreter in its own
  session, for work that holds the interpreter while it runs (a regex
  backtracking in C never lets another thread in). At the limit the whole
  session is killed and the test fails.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import psutil
import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]

# Far above any guarded test's own work (a few seconds at most).
GUARD_SECONDS = 45.0

# What marks a check's child (the real one runs `-m app.check`; a test's
# substitute child carries it in its source).
CHILD_MARK = "app.check"


def check_children() -> list[int]:
    """This process's children running a check's child (or a substitute).

    Read from the process table through psutil (a runtime dependency), not
    by parsing `ps`: CI's runner didn't see a substitute child through `ps`
    though it ran (PR #20's first run)."""
    found = []
    for child in psutil.Process().children(recursive=False):
        try:
            if CHILD_MARK in " ".join(child.cmdline()) and child.status() != psutil.STATUS_ZOMBIE:
                found.append(child.pid)
        except psutil.Error:
            continue
    return found


def children_report() -> str:
    """Every child of this process, for a failing test's message."""
    lines = []
    for child in psutil.Process().children(recursive=False):
        try:
            lines.append(f"{child.pid} {child.status()} {child.cmdline()!r}")
        except psutil.Error as error:
            lines.append(f"{child.pid} ({type(error).__name__})")
    return "; ".join(lines) or "no children"


def kill_check_children() -> None:
    """SIGKILL every check child of this process, and its process group."""
    for pid in check_children():
        for kill in (os.killpg, os.kill):
            try:
                kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def in_thread(
    scenario: Callable[[], Coroutine[Any, Any, Any]],
    *,
    limit: float = GUARD_SECONDS,
    cleanup: Callable[[], None] | None = None,
) -> Any:
    """Run `scenario()` to completion on a fresh event loop in a daemon
    thread and return its result (or raise what it raised). Still running
    after `limit` seconds: the check children it left are killed (and
    `cleanup` runs), and the test fails as hung."""
    outcome: dict[str, Any] = {}

    def target() -> None:
        try:
            outcome["value"] = asyncio.run(scenario())
        except BaseException as error:  # noqa: BLE001 - handed to the test's thread
            outcome["error"] = error

    thread = threading.Thread(target=target, name="hang-guarded scenario", daemon=True)
    thread.start()
    thread.join(limit)
    if thread.is_alive():
        kill_check_children()
        if cleanup is not None:
            cleanup()
        pytest.fail(f"hung: still running after {limit:.0f} s (a hang guard, not a timing assertion)")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")


def in_subprocess(source: str, *, limit: float = GUARD_SECONDS) -> Any:
    """Run `source` in a fresh interpreter (the service's directory as its
    working directory and first import path); it prints one JSON value on
    its last line of stdout, which is returned. Still running after `limit`
    seconds: its whole session is killed and the test fails as hung."""
    process = subprocess.Popen(
        [sys.executable, "-c", f"import sys\nsys.path.insert(0, {str(SERVICE_ROOT)!r})\n{source}"],
        cwd=SERVICE_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        pytest.fail(f"hung: still running after {limit:.0f} s (a hang guard, not a timing assertion)")
    assert process.returncode == 0, stderr
    return json.loads(stdout.strip().splitlines()[-1])
