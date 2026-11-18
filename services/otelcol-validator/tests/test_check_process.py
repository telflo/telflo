"""D13b ruling 27: each check runs in its own child process and process
group, under one hard deadline; the service kills the group at the deadline
or on cancellation, holds the slot until the group is dead, and removes the
check's directory however the check ends. The event loop parses nothing.
Ruling 33: a check killed while its child still writes always ends.

Processes are followed by pid (each fake collector records its own, its
parent's, which is the check's child, and its configuration's path). Every
test that kills a check runs it under a hang guard (`tests/guard.py`, ruling
36): a check that never ends fails the test instead of hanging the suite.
Waits are safety nets, never what a test asserts."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import bounded_yaml, runner
from app import stderr as stderr_module
from app.main import create_app
from app.runner import run_validation
from tests import guard
from tests.conftest import SECRET, VALIDATE_URL, auth_headers, make_settings, write_collector

YAML = "receivers:\n  otlp:\n    protocols:\n      grpc:\n"


# ---------------------------------------------------------------------------
# Following processes
# ---------------------------------------------------------------------------


def _running(pid: int) -> bool:
    """True while `pid` runs. A zombie (killed, not yet reaped by init) is
    dead: it runs nothing and holds nothing but its pid."""
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _group_running(pgid: int) -> list[int]:
    """The pids of the group's processes that still run."""
    listing = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="], capture_output=True, text=True).stdout
    found = []
    for line in listing.splitlines():
        pid, group, state = line.split(None, 2)
        if int(group) == pgid and not state.startswith("Z"):
            found.append(int(pid))
    return found


async def _until(condition: Callable[[], object], what: str) -> None:
    """Poll `condition` (a safety net of about 10 s, never the assertion)."""
    for _ in range(2_000):
        if condition():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never happened: {what} (this process's children: {guard.children_report()})")


def _recording_collector(binary_dir: Path, record: Path, then: str = "exec sleep 60") -> Path:
    """A collector that records `<its pid> <its parent's pid> <its config>
    <its working directory>` (atomically), then runs `then`."""
    return write_collector(
        binary_dir,
        "0.162.0",
        f'echo "$$ $PPID ${{2#--config=}} $(pwd -P)" > {record}.part\nmv {record}.part {record}\n{then}\n',
    )


def _read_record(record: Path) -> tuple[int, int, Path]:
    collector, child, config, _ = record.read_text().split(" ", 3)
    return int(collector), int(child), Path(config)


def _kill_recorded(record: Path) -> Callable[[], None]:
    """Kill what the record names (never leave one behind, even when a test
    fails)."""

    def cleanup() -> None:
        if record.exists():
            collector, child, _ = _read_record(record)
            for pid in (collector, child):
                if pid != os.getpid() and _running(pid):
                    os.kill(pid, signal.SIGKILL)

    return cleanup


class _RecordingSlots(asyncio.Semaphore):
    """A one-slot semaphore that records `probe()` when the slot is released."""

    def __init__(self, probe: Callable[[], object]) -> None:
        super().__init__(1)
        self.probe = probe
        self.at_release: list[object] = []

    def release(self) -> None:
        self.at_release.append(self.probe())
        super().release()


def _state(record: Path) -> Callable[[], tuple[bool, bool, list[int], bool, bool]]:
    """At a moment: (collector runs, child runs, the group's running pids,
    config file exists, the check's directory exists)."""

    def probe() -> tuple[bool, bool, list[int], bool, bool]:
        collector, child, config = _read_record(record)
        return _running(collector), _running(child), _group_running(child), config.exists(), config.parent.exists()

    return probe


DEAD_AND_GONE = (False, False, [], False, False)


def _substitute_child(monkeypatch: pytest.MonkeyPatch, source: str) -> None:
    """The check's child replaced by `source` (Python), started exactly as
    the real one is (its own session, the allowlisted environment)."""
    monkeypatch.setattr(runner, "CHECK_COMMAND", (sys.executable, "-c", f"# {guard.CHILD_MARK} substitute\n{source}"))


def _recording_directories(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    made: list[str] = []
    real = runner._make_directory

    def recording() -> str:
        made.append(real())
        return made[-1]

    monkeypatch.setattr(runner, "_make_directory", recording)
    return made


# ---------------------------------------------------------------------------
# The deadline
# ---------------------------------------------------------------------------


def test_the_deadline_kills_the_checks_whole_group_and_removes_its_directory(
    binary_dir: Path, tmp_path: Path
) -> None:
    """The collector would run a minute (its own limit is 30 s here): at
    the deadline the child and the collector die together, the slot is
    released only after, and the answer is the timeout."""
    record = tmp_path / "record"
    binary = _recording_collector(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        result = await run_validation(
            binary, YAML, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30, deadline_seconds=1
        )
        return result, slots.at_release, slots.locked()

    result, at_release, locked = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    assert result.valid is False
    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]
    assert result.outcome == "deadline"
    collector, child, config = _read_record(record)
    assert child != os.getpid()  # the collector ran under the check's child
    assert config.parent.name.startswith("otelcol-check-")  # the check's own directory
    assert at_release == [DEAD_AND_GONE]
    assert not locked


def test_the_deadline_ends_a_child_that_never_answers(monkeypatch: pytest.MonkeyPatch, binary_dir: Path) -> None:
    """A child busy past the deadline (before the collector: pre-processing
    that would run for minutes) is killed at the deadline."""
    _substitute_child(monkeypatch, "while True:\n    pass\n")
    made = _recording_directories(monkeypatch)
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")

    async def scenario():
        check = asyncio.create_task(
            run_validation(
                binary, YAML, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10, deadline_seconds=1
            )
        )
        await _until(guard.check_children, "the check's child started")
        [child] = guard.check_children()
        return await check, child

    result, child = guard.in_thread(scenario)

    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]
    assert not _running(child)
    assert _group_running(child) == []
    assert [Path(directory).exists() for directory in made] == [False]


def test_the_service_passes_the_deadline_the_settings_give() -> None:
    settings = make_settings(Path("/nowhere"))
    assert settings.validate_timeout == 10
    assert settings.check_deadline_seconds == 12
    assert make_settings(Path("/nowhere"), validate_timeout=3).check_deadline_seconds == 5


# ---------------------------------------------------------------------------
# D13b ruling 33: a check killed while its child writes always ends
# ---------------------------------------------------------------------------

# Children that never read their request (so a service that waits to hand it
# over reads nothing meanwhile) and write more than asyncio's streams keep
# unread before they pause the pipe (128 KiB). 207bc02's service then never
# saw the pipe's end, and `Process.wait()` waits for it: the check never
# ended, its slot was never released, its directory stayed.
FLOODING_CHILD = (
    "import os, pathlib, sys\n"
    "chunk = b'x' * 16384\n"
    "for _ in range(10):\n"  # 160 KiB, then say so
    "    os.write(1, chunk)\n"
    "pathlib.Path(sys.argv[1]).touch()\n"
    "while True:\n"
    "    os.write(1, chunk)\n"
)
BLOCKED_CHILD = (
    "import os, pathlib, sys, time\n"
    "os.write(1, b'x' * 163840)\n"  # 160 KiB, then say so and block
    "pathlib.Path(sys.argv[1]).touch()\n"
    "time.sleep(600)\n"
)
# Larger than a pipe holds: the request can't be handed over whole.
LARGE_TEXT = "#" + "x" * 200_000 + "\n"


def _writing_child(monkeypatch: pytest.MonkeyPatch, source: str, wrote: Path) -> None:
    _substitute_child(monkeypatch, source)
    monkeypatch.setattr(runner, "CHECK_COMMAND", (*runner.CHECK_COMMAND, str(wrote)))


def _child_state(made: list[str], children: list[int]) -> Callable[[], tuple[bool, list[int], bool]]:
    """At a moment: (the child runs, its group's running pids, the check's
    directory exists)."""

    def probe() -> tuple[bool, list[int], bool]:
        [child] = children
        return _running(child), _group_running(child), Path(made[0]).exists()

    return probe


@pytest.mark.parametrize("source", [FLOODING_CHILD, BLOCKED_CHILD], ids=["flooding", "blocked"])
def test_a_check_whose_child_writes_past_the_deadline_ends(
    monkeypatch: pytest.MonkeyPatch, binary_dir: Path, tmp_path: Path, source: str
) -> None:
    wrote = tmp_path / "wrote"
    _writing_child(monkeypatch, source, wrote)
    made = _recording_directories(monkeypatch)
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")
    children: list[int] = []

    async def scenario():
        slots = _RecordingSlots(_child_state(made, children))
        check = asyncio.create_task(
            run_validation(
                binary, LARGE_TEXT, slots=slots, slot_wait_seconds=1.0, timeout_seconds=10, deadline_seconds=1
            )
        )
        await _until(guard.check_children, "the check's child started")
        children.extend(guard.check_children())
        result = await check
        return result, slots.at_release, slots.locked(), wrote.exists()

    result, at_release, locked, written = guard.in_thread(scenario)

    assert written  # the child had written past what a paused pipe keeps
    assert result.outcome == "deadline"
    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]
    assert at_release == [(False, [], False)]
    assert not locked
    assert guard.check_children() == []


@pytest.mark.parametrize("source", [FLOODING_CHILD, BLOCKED_CHILD], ids=["flooding", "blocked"])
def test_a_check_cancelled_while_its_child_writes_ends(
    monkeypatch: pytest.MonkeyPatch, binary_dir: Path, tmp_path: Path, source: str
) -> None:
    wrote = tmp_path / "wrote"
    _writing_child(monkeypatch, source, wrote)
    made = _recording_directories(monkeypatch)
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")
    children: list[int] = []

    async def scenario():
        slots = _RecordingSlots(_child_state(made, children))
        check = asyncio.create_task(
            run_validation(binary, LARGE_TEXT, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30)
        )
        await _until(wrote.exists, "the child wrote past what a paused pipe keeps")
        children.extend(guard.check_children())
        check.cancel()
        try:
            await check
        except asyncio.CancelledError:
            cancelled = True
        else:
            cancelled = False
        return cancelled, slots.at_release, slots.locked()

    cancelled, at_release, locked = guard.in_thread(scenario)

    assert cancelled
    assert at_release == [(False, [], False)]
    assert not locked
    assert guard.check_children() == []


def test_a_collector_flooding_its_output_past_its_time_limit_ends_at_that_limit(
    binary_dir: Path,
) -> None:
    """The same inside the child (207bc02: the collector's own limit never
    ended a flooding collector; only the service's deadline did)."""
    binary = write_collector(binary_dir, "0.162.0", "exec yes 'E1006 reflector.go:1] dial tcp: i/o timeout' >&2\n")

    async def scenario():
        return await run_validation(
            binary, YAML, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=1, deadline_seconds=30
        )

    result = guard.in_thread(scenario)

    assert result.outcome == "timeout"
    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]


def test_a_collector_killed_while_another_process_holds_its_pipe_ends_at_its_time_limit(
    binary_dir: Path, tmp_path: Path
) -> None:
    """A reap waits for the process's exit, never for its pipes: here the
    collector runs past its limit and has left a process holding its stderr
    open, so its output never ends. The collector's own limit ends the run
    (the service's group kill then ends the holder). 207bc02's reap waited
    for every pipe to close, so only the service's deadline ended it."""
    holder = tmp_path / "holder"
    binary = write_collector(binary_dir, "0.162.0", f"sleep 300 >&2 &\necho $! > {holder}\nexec sleep 300\n")

    async def scenario():
        return await run_validation(
            binary, YAML, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=1, deadline_seconds=20
        )

    def cleanup() -> None:
        if holder.exists() and _running(int(holder.read_text())):
            os.kill(int(holder.read_text()), signal.SIGKILL)

    try:
        result = guard.in_thread(scenario, cleanup=cleanup)
    finally:
        cleanup()

    assert result.outcome == "timeout"
    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]
    assert not _running(int(holder.read_text()))  # killed with the check's group


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


def test_a_cancelled_check_kills_its_group_and_removes_its_directory_before_it_lets_go(
    binary_dir: Path, tmp_path: Path
) -> None:
    record = tmp_path / "record"
    binary = _recording_collector(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        check = asyncio.create_task(
            run_validation(binary, YAML, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30)
        )
        await _until(record.exists, "the collector started")
        check.cancel()
        with pytest.raises(asyncio.CancelledError):
            await check
        return slots.at_release, slots.locked()

    at_release, locked = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    assert at_release == [DEAD_AND_GONE]
    assert not locked


@pytest.mark.parametrize("yields", [0, 1, 2, 3, 4, 6, 10])
def test_a_second_cancellation_still_removes_the_directory(binary_dir: Path, tmp_path: Path, yields: int) -> None:
    """The first fix pass left the configuration on disk when a second
    cancellation arrived while the kill was being reaped (from 3 yields)."""
    record = tmp_path / "record"
    binary = _recording_collector(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        check = asyncio.create_task(
            run_validation(binary, YAML, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30)
        )
        await _until(record.exists, "the collector started")
        check.cancel()
        for _ in range(yields):
            await asyncio.sleep(0)
        check.cancel()
        with pytest.raises(asyncio.CancelledError):
            await check
        return slots.at_release

    at_release = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    _, _, config = _read_record(record)
    assert at_release == [DEAD_AND_GONE]
    assert not config.exists()
    assert not config.parent.exists()


def test_a_cancellation_during_the_reap_never_cuts_it_short(
    monkeypatch: pytest.MonkeyPatch, binary_dir: Path, tmp_path: Path
) -> None:
    """The reap runs shielded: a second cancellation that lands while it
    runs doesn't stop it, and the slot is released only once it is done."""
    record = tmp_path / "record"
    binary = _recording_collector(binary_dir, record)
    steps: list[str] = []
    real = runner._reap_group

    async def slow_reap(*args):  # noqa: ANN002
        steps.append("started")
        await asyncio.sleep(0.05)  # a reap that takes a while: the second cancellation lands here
        await real(*args)
        steps.append("finished")

    monkeypatch.setattr(runner, "_reap_group", slow_reap)

    async def scenario():
        slots = _RecordingSlots(lambda: list(steps))
        check = asyncio.create_task(
            run_validation(binary, YAML, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30)
        )
        await _until(record.exists, "the collector started")
        check.cancel()
        await _until(lambda: steps == ["started"], "the reap started")
        check.cancel()
        with pytest.raises(asyncio.CancelledError):
            await check
        return slots.at_release

    at_release = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    assert at_release == [["started", "finished"]]


def test_health_answers_while_a_check_is_busy_and_cancelling_it_kills_its_child(
    monkeypatch: pytest.MonkeyPatch, binary_dir: Path
) -> None:
    """The service stays responsive while a check's child is busy, and a
    cancelled request ends the child at once (the first fix pass's thread
    couldn't be stopped: the slot stayed held for as long as it ran)."""
    _substitute_child(monkeypatch, "while True:\n    pass\n")
    write_collector(binary_dir, "0.162.0", "exit 0\n")
    app = create_app(make_settings(binary_dir))

    async def scenario():
        async with app.router.lifespan_context(app):
            transport = httpx2.ASGITransport(app=app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
                check = asyncio.create_task(http.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers()))
                await _until(guard.check_children, "the check's child started")
                [child] = guard.check_children()

                health = await http.get("/health")
                busy_meanwhile = not check.done() and _running(child)

                check.cancel()
                await asyncio.wait({check}, timeout=10)  # a safety net
                return health.status_code, busy_meanwhile, check.done(), child, not app.state.slots.locked()

    status, busy_meanwhile, ended, child, slot_free = guard.in_thread(scenario)

    assert status == 200
    assert busy_meanwhile
    assert ended
    assert not _running(child)
    assert _group_running(child) == []
    assert slot_free


# ---------------------------------------------------------------------------
# The group's poll (bounded)
# ---------------------------------------------------------------------------


async def _finished_child() -> tuple[asyncio.SubprocessTransport, runner._Pipes]:
    transport, pipes = await asyncio.get_running_loop().subprocess_exec(
        lambda: runner._Pipes({1: 16}),
        "/bin/sh",
        "-c",
        "exit 0",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await pipes.finished
    return transport, pipes


async def test_the_slot_waits_until_the_rest_of_the_group_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    """After the child, the group's other processes (the collector, reaped
    by init) may linger for a moment: the reap polls until none is left."""
    transport, pipes = await _finished_child()
    polls: list[int] = []

    def group_still_there(pgid: int, sig: int) -> None:
        if sig == 0:
            polls.append(pgid)
            if len(polls) <= 3:
                return  # still there for three polls
        raise ProcessLookupError()

    monkeypatch.setattr(os, "killpg", group_still_there)

    await runner._reap_group(transport, pipes, 4242)

    assert polls == [4242] * 4


async def test_the_poll_gives_up_after_its_bound(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Zombies with no init to reap them stay in the group: the poll gives
    up at its bound (about a second) and says so."""
    transport, pipes = await _finished_child()
    polls: list[int] = []
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: polls.append(sig))
    monkeypatch.setattr(runner, "_GROUP_GONE_POLL_SECONDS", 0)

    with caplog.at_level(logging.WARNING, logger="app.runner"):
        await runner._reap_group(transport, pipes, 4242)

    assert polls == [0] * runner._GROUP_GONE_POLLS
    assert "outlived their kill" in caplog.text


# ---------------------------------------------------------------------------
# What the service's own process does, and what the child gets
# ---------------------------------------------------------------------------


def test_the_service_process_never_parses_yaml_or_classifies_stderr(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every parse and classification, broken in the service's process: the
    check still answers, so they all ran in the child. The first fix pass
    parsed the collector's output on the event loop (an 80 KB output froze
    it for 12 s)."""

    def forbidden(*args, **kwargs):
        raise AssertionError("ran in the service's process")

    for module, name in (
        (bounded_yaml, "safe_load"),
        (bounded_yaml, "check_depth"),
        (runner, "_prepare"),
        (runner, "parse_stderr"),
        (stderr_module, "parse_stderr"),
        (stderr_module, "classify_error"),
        (stderr_module, "classify_cause"),
    ):
        monkeypatch.setattr(module, name, forbidden)
    write_collector(
        binary_dir,
        "0.162.0",
        "echo 'Error: receivers::otlp: must specify at least one protocol' >&2\n"
        "echo 'extensions::file_storage: directory must exist: stat /var/lib/otel: no such file or directory. "
        "You can enable the create_directory option to automatically create it' >&2\n"
        "exit 1\n",
    )
    text = "receivers:\n  otlp:\nexporters:\n  file:\n    path: /var/log/otel/out.json\n"
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": text}, headers=auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["errors"] == [{"message": "must specify at least one protocol", "componentPath": "receivers::otlp"}]
    # The collector's first, then the text's (D13b ruling 71).
    assert [r["title"] for r in body["requirements"]] == [
        "Ensure /var/lib/otel exists at runtime",  # read from the collector's output
        "Directory /var/log/otel must exist",  # read from the text
    ]


async def test_the_checks_child_never_holds_the_secret(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real child, started as the service starts it, records the
    environment it was given before it runs the check."""
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRET", SECRET)
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRETS_PREVIOUS", "previous-" + SECRET)
    monkeypatch.setenv("SOME_OTHER_TOKEN", "other-" + SECRET)
    seen = tmp_path / "child-environment.json"
    recording_child = (
        "import json, os, sys\n"
        f"open({str(seen)!r}, 'w').write(json.dumps(dict(os.environ)))\n"
        "from app import check\n"
        "sys.exit(check.main())\n"
    )
    monkeypatch.setattr(runner, "CHECK_COMMAND", (*runner.CHECK_COMMAND[:3], "-c", recording_child))
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")

    result = await run_validation(binary, YAML, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10)

    assert result.valid is True
    environment = json.loads(seen.read_text())
    assert SECRET not in json.dumps(environment)
    assert not any(name.startswith("OTELCOL_VALIDATOR_SECRET") for name in environment)
    assert set(environment) <= runner._ALLOWED_PARENT_ENV | {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}
    assert environment.get("PATH") == os.environ.get("PATH")


async def test_the_collector_runs_in_the_checks_own_directory(binary_dir: Path, tmp_path: Path) -> None:
    """D13b ruling 38: the collector's working directory is the check's
    directory (a relative path in the text lands there, and goes with it),
    never the service's."""
    record = tmp_path / "record"
    binary = _recording_collector(binary_dir, record, then="exit 0")

    result = await run_validation(binary, YAML, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10)

    assert result.valid is True
    *_, config, working = record.read_text().split()
    assert Path(working) == Path(config).parent.resolve()
    assert Path(working).name.startswith("otelcol-check-")


def test_a_child_that_cannot_be_started_is_503_with_its_own_log_line(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """D13b ruling 38: an OSError starting the check's child isn't logged as
    a collector that can't be run; the answer is still 503."""
    monkeypatch.setattr(runner, "CHECK_COMMAND", (str(binary_dir / "no-such-interpreter"),))
    write_collector(binary_dir, "0.162.0", "exit 0\n")
    made = _recording_directories(monkeypatch)

    with caplog.at_level(logging.INFO), TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers())

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "version_unavailable"
    assert "the check's child process could not be started: FileNotFoundError" in caplog.text
    assert "otelcol-contrib could not be run" not in caplog.text
    assert [Path(directory).exists() for directory in made] == [False]


# ---------------------------------------------------------------------------
# The text's length (the platform's limit)
# ---------------------------------------------------------------------------


def test_a_text_of_262_144_characters_is_checked_and_one_more_is_413(binary_dir: Path, tmp_path: Path) -> None:
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")
    at_limit = "#" + "x" * (262_144 - 2) + "\n"
    assert len(at_limit) == 262_144
    with TestClient(create_app(make_settings(binary_dir))) as client:
        over = client.post(VALIDATE_URL, json={"yaml": at_limit + "#"}, headers=auth_headers())
        assert not marker.exists()
        checked = client.post(VALIDATE_URL, json={"yaml": at_limit}, headers=auth_headers())

    assert over.status_code == 413
    assert over.json() == {
        "error": {"code": "payload_too_large", "message": "`yaml` is longer than 262,144 characters."}
    }
    assert checked.status_code == 200
    assert checked.json()["valid"] is True
    assert marker.exists()
