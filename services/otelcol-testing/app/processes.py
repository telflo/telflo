"""Subprocesses, as the validator runs them
(`services/otelcol-validator/app/runner.py`), shared by the service's half
(a run's child process) and the child's (the collector).

- **Pipes are read as their data arrives and never paused** (`Pipes`): each
  pipe keeps its first bytes up to a cap and drops the rest, so a chatty
  process never blocks on a full pipe.
- **A reap waits for the process's exit only** (`stop`), then closes its
  pipes, so a reap always ends, whatever the pipes still hold and whoever
  else still holds them.
- **A process group is killed whole** (`kill_group`), and the rest of the
  group is waited for, at most about a second (`reap_group`).

Nothing here reads what a process wrote beyond keeping its bytes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal

logger = logging.getLogger(__name__)

# Once a group is killed and its leader reaped, how long to wait for the
# rest of the group to be gone: 200 polls 5 ms apart, about a second in all.
# Without an init to reap orphans (a container whose first process is the
# service; the image runs tini), a killed collector stays a zombie: it runs
# nothing and holds nothing but its pid, until something reaps it.
GROUP_GONE_POLLS = 200
GROUP_GONE_POLL_SECONDS = 0.005


class Pipes(asyncio.SubprocessProtocol):
    """A subprocess's pipes, read as their data arrives and never paused:
    each pipe keeps its first `caps[fd]` bytes and drops the rest. `exited`
    resolves once the process has exited; `finished` once it has and every
    pipe has closed (the end of its output)."""

    def __init__(self, caps: dict[int, int]) -> None:
        loop = asyncio.get_running_loop()
        self._caps = caps
        self.kept: dict[int, bytearray] = {fd: bytearray() for fd in caps}
        self.dropped: dict[int, bool] = dict.fromkeys(caps, False)
        self.exited: asyncio.Future[None] = loop.create_future()
        self.finished: asyncio.Future[None] = loop.create_future()

    def pipe_data_received(self, fd: int, data: bytes) -> None:
        kept = self.kept.get(fd)
        if kept is None:
            return
        room = self._caps[fd] - len(kept)
        if room > 0:
            kept += data[:room]
        if len(data) > room:
            self.dropped[fd] = True

    def process_exited(self) -> None:
        resolve(self.exited)

    def connection_lost(self, exc: Exception | None) -> None:
        resolve(self.exited)
        resolve(self.finished)


def resolve(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


async def within(future: asyncio.Future[None], seconds: float) -> bool:
    """True when `future` resolves within `seconds`; never cancels it."""
    done, _ = await asyncio.wait({future}, timeout=max(seconds, 0))
    return bool(done)


async def stop(transport: asyncio.SubprocessTransport, pipes: Pipes) -> None:
    """Kill the process if it still runs, wait for its exit (SIGKILL ends
    it), then close its pipes, whatever they still hold. Safe to call once
    the process has finished, and more than once."""
    try:
        transport.kill()
    except ProcessLookupError:
        pass  # it exited on its own meanwhile
    # Shielded: a reap cancelled while it waits must not cancel the shared
    # futures, or a later reap of the same process would never close the
    # transport.
    await asyncio.shield(pipes.exited)
    stdin = transport.get_pipe_transport(0)
    if isinstance(stdin, asyncio.WriteTransport) and (not stdin.is_closing() or stdin.get_write_buffer_size()):
        stdin.abort()  # a request the process never read
    transport.close()
    await asyncio.shield(pipes.finished)


async def terminate(transport: asyncio.SubprocessTransport, pipes: Pipes, grace_seconds: float) -> None:
    """SIGTERM, up to `grace_seconds` for the process to exit, then `stop`
    (SIGKILL and the reap)."""
    if transport.get_returncode() is None:
        try:
            transport.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass
        await within(pipes.exited, grace_seconds)
    await stop(transport, pipes)


def exit_code(returncode: int) -> int:
    """The exit status a shell would report: a process killed by signal N
    (Python's negative returncode) exits 128 + N, so SIGKILL is 137."""
    return 128 - returncode if returncode < 0 else returncode


def complete_lines(output: bytes) -> bytes:
    """`output` up to and including its last line break: a cut output's
    partial last line dropped (nothing when no line was complete), so a cut
    never leaves part of a path the scrub can no longer recognise."""
    return output[: output.rfind(b"\n") + 1]


def kill_group(pgid: int) -> None:
    """SIGKILL every process in the group. A group's id isn't reused while
    any member lives, so whenever there is something to kill, the kill
    reaches only the run's own processes."""
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # already gone (PermissionError: only zombies left, on macOS)


async def reap_group(transport: asyncio.SubprocessTransport, pipes: Pipes, pgid: int) -> None:
    """Reap the group's leader (`stop` kills it again, by its own pid) and
    close its pipes, then poll, at most `GROUP_GONE_POLLS` times, until no
    process of its group is left. Every step ends."""
    await stop(transport, pipes)
    for _ in range(GROUP_GONE_POLLS):
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return  # nobody left (or only zombies, which macOS refuses to signal)
        await asyncio.sleep(GROUP_GONE_POLL_SECONDS)
    logger.warning("a killed run's processes outlived their kill (no init reaps them)")


def remove_directory(directory: str) -> list[str]:
    """Remove `directory` and everything in it, carrying on past any entry
    that can't be removed. Returns the type of each failure, in order; an
    entry already gone is no failure."""
    failures: list[str] = []

    def record(_function: object, _path: str, error: BaseException) -> None:
        if not isinstance(error, FileNotFoundError):
            failures.append(type(error).__name__)

    shutil.rmtree(directory, onexc=record)
    return failures
