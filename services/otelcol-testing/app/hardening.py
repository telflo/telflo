"""The service's process made non-dumpable.

`prctl(PR_SET_DUMPABLE, 0)` makes the kernel refuse another process of the
same uid (a run's collector, kwok) `ptrace` and the service's
`/proc/<pid>/environ`, `fd`, `mem`, `maps` and `cwd`: "Permission denied".
It is set at start, before the secret's file is read, through ctypes (no
dependency). It is Linux's: elsewhere (a developer's macOS) it does nothing.

`exec` resets the flag, so a collector or kwok is dumpable again; that is
why the secret is in no process's environment and only in its file
(app/settings.py).
"""

from __future__ import annotations

import ctypes
import sys
from typing import Protocol

PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4


class _Libc(Protocol):
    def prctl(self, option: int, arg2: int, arg3: int, arg4: int, arg5: int) -> int: ...


class HardeningError(OSError):
    """prctl refused: the service refuses to start rather than run dumpable."""


def _libc() -> _Libc:
    return ctypes.CDLL(None, use_errno=True)  # type: ignore[return-value]


def make_not_dumpable(*, platform: str | None = None, libc: _Libc | None = None) -> bool | None:
    """Set PR_SET_DUMPABLE to 0 and check it took. Returns True on Linux once
    the flag reads 0, and None elsewhere (nothing to do). Raises
    HardeningError when prctl fails or the flag still reads dumpable.
    `platform` and `libc` are the tests' seams."""
    if not (platform or sys.platform).startswith("linux"):
        return None
    library = libc if libc is not None else _libc()
    if library.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise HardeningError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) failed")
    if library.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise HardeningError(0, "the process is still dumpable after prctl(PR_SET_DUMPABLE, 0)")
    return True


def is_dumpable(*, platform: str | None = None, libc: _Libc | None = None) -> bool | None:
    """PR_GET_DUMPABLE's answer on Linux (True when dumpable); None elsewhere."""
    if not (platform or sys.platform).startswith("linux"):
        return None
    library = libc if libc is not None else _libc()
    return library.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0
