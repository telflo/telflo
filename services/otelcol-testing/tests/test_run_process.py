"""Each run is its own process group under one budget (D14a spec decision 5,
Preflight ruling 2; the validator's D13b rulings 26, 27 and 33): the run's
child and its collector are killed together at the run's deadline (57 + d s),
when the request's budget (64 + d s) runs out, when the request is cancelled
and when the client goes away; the workspace is removed before the slot is
released; at most the cap's runs hold slots, and a request that finds none
within 5 s answers 503 `tester_busy`. The event loop parses nothing.

Processes are followed by pid: each fake collector records its own pid, a
child's it started and its parent's (the run's child). Every test that kills
a run runs it under a hang guard (`tests/guard.py`): a run that never ends
fails the test instead of hanging the suite. Waits are conditions, and the
deadlines are lowered (`run_deadline_base_seconds=0`: a one-second run's
deadline is one second); nothing asserts how long anything took.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import signal
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import bounded_yaml, compatibility, neutralise, output_reader, providers, runner, yaml_mutations
from app.main import create_app
from app.runner import Job, SlotUnavailable, acquire_slot, run_test
from tests import guard
from tests.conftest import (
    HEALTH_URL,
    RUN_ID,
    RUNS_URL,
    SECRET,
    TEXT,
    VERSION,
    auth_headers,
    call_asgi,
    make_settings,
    run_body,
    write_collector,
    write_fake_collector,
)

# ---------------------------------------------------------------------------
# Following processes
# ---------------------------------------------------------------------------


def _running(pid: int) -> bool:
    """True while `pid` runs. A zombie (killed, not yet reaped) is dead."""
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


# A collector that ignores SIGTERM, starts a child of its own, records
# `<its pid> <its child's pid> <its parent's pid> <its working directory>`,
# and never exits: only a kill of the whole group ends both.
STUBBORN = (
    "trap '' TERM\n"
    "sleep 600 &\n"
    'echo "$$ $! $PPID $(pwd -P)" > {record}.part\n'
    "mv {record}.part {record}\n"
    "exec sleep 600\n"
)


def _stubborn(binary_dir: Path, record: Path) -> Path:
    return write_collector(binary_dir, VERSION, STUBBORN.format(record=record))


def _read(record: Path) -> tuple[int, int, int, Path]:
    collector, grandchild, child, workspace = record.read_text().split(" ", 3)
    return int(collector), int(grandchild), int(child), Path(workspace.strip())


def _kill_recorded(record: Path) -> Callable[[], None]:
    """Kill what the record names (never leave one behind, even when a test
    fails)."""

    def cleanup() -> None:
        if record.exists():
            collector, grandchild, child, _ = _read(record)
            for pid in (collector, grandchild, child):
                if pid != os.getpid() and _running(pid):
                    os.kill(pid, signal.SIGKILL)

    return cleanup


@pytest.fixture
def record(tmp_path: Path):
    """Where a stubborn collector records its processes; whatever the test
    does (an assertion failing included), they are killed at teardown
    (Ruling 27, m4)."""
    path = tmp_path / "record"
    yield path
    _kill_recorded(path)()


class _RecordingSlots(asyncio.Semaphore):
    """A semaphore that records `probe()` whenever a slot is released."""

    def __init__(self, probe: Callable[[], object], value: int = 1) -> None:
        super().__init__(value)
        self.probe = probe
        self.at_release: list[object] = []

    def release(self) -> None:
        self.at_release.append(self.probe())
        super().release()


def _state(record: Path) -> Callable[[], tuple[bool, bool, bool, list[int], bool]]:
    """At a moment: (the collector runs, its child runs, the run's child
    runs, the group's running pids, the workspace exists)."""

    def probe() -> tuple[bool, bool, bool, list[int], bool]:
        collector, grandchild, child, workspace = _read(record)
        return _running(collector), _running(grandchild), _running(child), _group_running(child), workspace.exists()

    return probe


DEAD_AND_GONE = (False, False, False, [], False)


def _job(binary: Path, *, duration: int = 1, text: str = TEXT) -> Job:
    return Job(
        run_id=RUN_ID,
        binary=binary,
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=duration,
        version=VERSION,
        input=b'{"resourceLogs":[]}',
    )


# ---------------------------------------------------------------------------
# The run's deadline (57 + d s; lowered here to d)
# ---------------------------------------------------------------------------


def test_the_deadline_kills_a_collector_that_never_exits_and_its_children(binary_dir: Path, tmp_path: Path, record: Path) -> None:
    """The collector ignores SIGTERM and has a child of its own: at the
    deadline the run's child, the collector and the collector's child die
    together, the workspace goes, and only then is the slot released."""
    binary = _stubborn(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        answer = await run_test(_job(binary), slots=slots, slot_wait_seconds=1.0, deadline_seconds=1)
        return answer, slots.at_release, slots.locked()

    answer, at_release, locked = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    collector, grandchild, child, workspace = _read(record)
    assert child != os.getpid()  # the collector ran under the run's child
    assert workspace.name.startswith("otelcol-run-")
    assert at_release == [DEAD_AND_GONE]
    assert not locked
    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "timed_out", "message": "The run didn't finish within its 1 s budget and was stopped."}


def test_the_service_kills_at_57_plus_d_and_the_request_at_64_plus_d(binary_dir: Path) -> None:
    settings = make_settings(binary_dir)

    assert [settings.run_deadline_seconds(d) for d in (1, 5, 60)] == [58, 62, 117]
    assert [settings.request_budget_seconds(d) for d in (1, 5, 60)] == [65, 69, 124]


def test_the_requests_budget_kills_the_group_and_answers_timed_out(binary_dir: Path, tmp_path: Path, record: Path) -> None:
    """The request's budget (lowered to d, the run's deadline left far off)
    runs out: the run is cancelled, its whole group killed, and the answer
    is 200 `failed`, `timed_out`."""
    _stubborn(binary_dir, record)
    settings = make_settings(binary_dir, request_budget_base_seconds=0, run_deadline_base_seconds=600)

    def scenario_sync():
        with TestClient(create_app(settings)) as client:
            resp = client.post(RUNS_URL, json=run_body(durationSeconds=1), headers=auth_headers())
            return resp.status_code, resp.json(), client.app.state.slots.locked()

    async def scenario():
        return await asyncio.to_thread(scenario_sync)

    status, body, locked = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    collector, grandchild, child, workspace = _read(record)
    assert status == 200
    assert body["status"] == "failed"
    assert body["error"]["code"] == "timed_out"
    assert not any(_running(pid) for pid in (collector, grandchild, child))
    assert _group_running(child) == []
    assert not workspace.exists()
    assert not locked


# ---------------------------------------------------------------------------
# Cancellation and the client going away
# ---------------------------------------------------------------------------


def test_a_cancelled_run_kills_its_group_and_removes_its_workspace_before_it_lets_go(
    binary_dir: Path, tmp_path: Path, record: Path
) -> None:
    binary = _stubborn(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        task = asyncio.create_task(run_test(_job(binary, duration=60), slots=slots, slot_wait_seconds=1.0, deadline_seconds=600))
        await _until(record.exists, "the collector started")
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return slots.at_release, slots.locked()

    at_release, locked = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    assert at_release == [DEAD_AND_GONE]
    assert not locked


@pytest.mark.parametrize("yields", [0, 1, 2, 3, 4, 6, 10])
def test_a_second_cancellation_still_ends_the_run(binary_dir: Path, tmp_path: Path, record: Path, yields: int) -> None:
    binary = _stubborn(binary_dir, record)

    async def scenario():
        slots = _RecordingSlots(_state(record))
        task = asyncio.create_task(run_test(_job(binary, duration=60), slots=slots, slot_wait_seconds=1.0, deadline_seconds=600))
        await _until(record.exists, "the collector started")
        task.cancel()
        for _ in range(yields):
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return slots.at_release

    at_release = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    assert at_release == [DEAD_AND_GONE]


def test_the_client_going_away_kills_the_group(binary_dir: Path, tmp_path: Path, record: Path) -> None:
    """Once the body is read, the server's next message is the client's
    disconnect: the run is stopped, its group killed and its workspace gone,
    and the slot is free again."""
    _stubborn(binary_dir, record)
    app = create_app(make_settings(binary_dir, run_deadline_base_seconds=600, request_budget_base_seconds=600))

    async def scenario():
        gone = asyncio.Event()
        body = json.dumps(run_body(durationSeconds=60)).encode()
        call = asyncio.create_task(call_asgi(app, "POST", RUNS_URL, auth_headers(), [body], disconnect=gone))
        await _until(record.exists, "the collector started")
        gone.set()
        result = await call
        return result.status, app.state.slots._value

    status, free = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    collector, grandchild, child, workspace = _read(record)
    assert status == 500  # nobody reads it
    assert not any(_running(pid) for pid in (collector, grandchild, child))
    assert _group_running(child) == []
    assert not workspace.exists()
    assert free == 4


def test_health_answers_while_a_run_is_busy_and_cancelling_the_request_kills_its_group(
    binary_dir: Path, tmp_path: Path, record: Path
) -> None:
    _stubborn(binary_dir, record)
    app = create_app(make_settings(binary_dir, run_deadline_base_seconds=600, request_budget_base_seconds=600))

    async def scenario():
        async with app.router.lifespan_context(app):
            transport = httpx2.ASGITransport(app=app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
                request = asyncio.create_task(
                    http.post(RUNS_URL, json=run_body(durationSeconds=60), headers=auth_headers())
                )
                await _until(record.exists, "the collector started")
                health = await http.get(HEALTH_URL)
                busy_meanwhile = not request.done()
                request.cancel()
                await asyncio.wait({request}, timeout=10)  # a safety net
                return health.status_code, busy_meanwhile, request.done(), not app.state.slots.locked()

    status, busy_meanwhile, ended, slot_free = guard.in_thread(scenario, cleanup=_kill_recorded(record))

    collector, grandchild, child, workspace = _read(record)
    assert status == 200
    assert busy_meanwhile
    assert ended
    assert not any(_running(pid) for pid in (collector, grandchild, child))
    assert _group_running(child) == []
    assert not workspace.exists()
    assert slot_free


# ---------------------------------------------------------------------------
# The cap and the busy answer
# ---------------------------------------------------------------------------


# A collector that records its start, answers the run's replay, then runs
# until a release file appears (or it is stopped), and exits 0.
HELD_PRELUDE = "open(os.path.join({marks!r}, f'started-{{os.getpid()}}'), 'w').close()\n"
HELD_AFTER_READY = (
    "while not (os.path.exists({release!r}) and answered[0] >= 1):\n"
    "    time.sleep(0.02)\n"
    "os._exit(0)\n"
)


def test_the_cap_holds_runs_past_it_and_frees_slots_as_runs_end(binary_dir: Path, tmp_path: Path) -> None:
    """With a cap of two, two runs hold both slots; a third finds none
    within its wait and is refused (SlotUnavailable: 503 tester_busy) without
    starting anything; once the two end, a fourth runs."""
    release = tmp_path / "release"
    marks = tmp_path / "marks"
    marks.mkdir()
    binary = write_fake_collector(
        binary_dir,
        VERSION,
        prelude=HELD_PRELUDE.format(marks=str(marks)),
        after_ready=HELD_AFTER_READY.format(release=str(release)),
    )

    def started() -> int:
        return len(list(marks.iterdir()))

    async def scenario():
        slots = asyncio.Semaphore(2)
        first, second = (
            asyncio.create_task(
                run_test(_job(binary, duration=60), slots=slots, slot_wait_seconds=1.0, deadline_seconds=600)
            )
            for _ in range(2)
        )
        await _until(lambda: started() == 2, "two collectors started")
        refused = False
        try:
            await run_test(_job(binary), slots=slots, slot_wait_seconds=0.05, deadline_seconds=600)
        except SlotUnavailable:
            refused = True
        count_while_full = started()
        release.touch()
        answers = [await first, await second]
        fourth = await run_test(_job(binary), slots=slots, slot_wait_seconds=1.0, deadline_seconds=600)
        return refused, count_while_full, [answer["status"] for answer in answers], fourth["status"], slots._value

    refused, count_while_full, statuses, fourth, free = guard.in_thread(scenario, cleanup=release.touch)

    assert refused
    assert count_while_full == 2  # the refused run never started a collector
    assert statuses == ["succeeded", "succeeded"]
    assert fourth == "succeeded"
    assert started() == 3
    assert free == 2


async def test_acquire_slot_waits_and_gives_up_only_at_its_bound() -> None:
    slots = asyncio.Semaphore(1)
    await slots.acquire()

    with pytest.raises(SlotUnavailable):
        await acquire_slot(slots, 0.01)

    waiting = asyncio.create_task(acquire_slot(slots, 30))
    await asyncio.sleep(0)
    assert not waiting.done()
    slots.release()  # a slot frees up while it waits: it takes it
    await waiting
    assert slots.locked()


def test_a_full_tester_answers_503_tester_busy_after_its_5_second_wait(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The wait is the settings' 5 s (ruling 2), passed to the slot's
    acquire; the clock is a fake that says it ran out, so nothing waits."""
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, VERSION, f"touch {marker}\nexec sleep 600\n")
    waits: list[float] = []
    real_wait_for = runner.asyncio.wait_for

    async def ran_out(awaitable, timeout):  # noqa: ANN001
        if timeout == 5.0:
            waits.append(timeout)
            awaitable.close()
            raise TimeoutError()
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(runner.asyncio, "wait_for", ran_out)
    with TestClient(create_app(make_settings(binary_dir, max_concurrency=1))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert waits == [5.0]
    assert resp.status_code == 503
    assert resp.json() == {"error": {"code": "tester_busy", "message": "Every run slot is busy. Retry shortly."}}
    assert not marker.exists()


def test_the_cap_defaults_to_four_slots(binary_dir: Path) -> None:
    write_collector(binary_dir, VERSION, "exit 0\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        assert client.app.state.slots._value == 4


# ---------------------------------------------------------------------------
# What the service's own process does, and what the run's processes get
# ---------------------------------------------------------------------------


def test_the_service_process_never_parses_the_text(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every parse and splice, broken in the service's process: the run still
    neutralises (R-105), so they all ran in the child."""

    def forbidden(*args, **kwargs):
        raise AssertionError("ran in the service's process")

    for module, name in (
        (bounded_yaml, "single_node"),
        (bounded_yaml, "safe_load"),
        (providers, "neutralize_providers"),
        (neutralise, "neutralise"),
        (neutralise, "backstop"),
        (compatibility, "parse"),
        (compatibility, "check_compatibility_doc"),
        (yaml_mutations, "_load"),
        (output_reader, "encode_output"),
    ):
        monkeypatch.setattr(module, name, forbidden)
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(yaml="a: ${file:/etc/hostname}\n"), headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json()["status"] == "succeeded"
    assert [m["id"] for m in resp.json()["mutations"]] == ["R-105"]


def test_the_runs_processes_get_only_the_allowlisted_environment(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The child and the collector hold none of the service's other
    variables: the secret file's path, a token, the telemetry endpoint."""
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", "/run/secrets/otelcol_testing_secret")
    monkeypatch.setenv("SOME_OTHER_TOKEN", "other-" + SECRET)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT_FOR_TEST", "http://somewhere")
    seen = tmp_path / "collector-environment"
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude=f"open({str(seen)!r}, 'w').write(json.dumps(dict(os.environ)))\n",
    )
    child_seen = tmp_path / "child-environment.json"
    recording_child = (
        f"# {guard.CHILD_MARK} recording\n"
        "import json, os, sys\n"
        f"open({str(child_seen)!r}, 'w').write(json.dumps(dict(os.environ)))\n"
        "from app import run_child\n"
        "sys.exit(run_child.main())\n"
    )
    monkeypatch.setattr(runner, "RUN_COMMAND", (sys.executable, "-E", "-s", "-c", recording_child))
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.json()["status"] == "succeeded"
    child_environment = json.loads(child_seen.read_text())
    collector_environment = json.loads(seen.read_text())
    from app.environment import ALLOWED_PARENT_ENV
    from app.sandbox_env import SANDBOX_ENV_OVERRIDES

    platform_own = {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}
    assert set(child_environment) <= ALLOWED_PARENT_ENV | platform_own
    # The collector: the allowlist and the sandbox's fixed overrides.
    assert set(collector_environment) <= ALLOWED_PARENT_ENV | set(SANDBOX_ENV_OVERRIDES) | platform_own
    assert {name: collector_environment[name] for name in SANDBOX_ENV_OVERRIDES} == SANDBOX_ENV_OVERRIDES
    assert "KUBECONFIG" not in collector_environment
    for environment in (json.dumps(child_environment), seen.read_text()):
        assert SECRET not in environment
        assert "OTELCOL_TESTING_SECRET_FILE" not in environment
        assert "SOME_OTHER_TOKEN" not in environment


def test_the_collector_runs_in_the_runs_own_workspace(binary_dir: Path, tmp_path: Path) -> None:
    record = tmp_path / "record"
    binary = write_fake_collector(
        binary_dir,
        VERSION,
        prelude=f"open({str(record)!r}, 'w').write(sys.argv[2] + ' ' + os.path.realpath(os.getcwd()))\n",
    )

    async def scenario():
        return await run_test(_job(binary), slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, deadline_seconds=600)

    answer = guard.in_thread(scenario)

    config, working = record.read_text().split()
    assert answer["status"] == "succeeded"
    assert Path(working) == Path(config).parent.resolve()
    assert Path(working).name.startswith("otelcol-run-")
    assert not Path(working).exists()


def test_a_child_that_answers_nonsense_is_500_with_nothing_quoted(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_collector(binary_dir, VERSION, "exit 0\n")
    for source in (
        "print('not json')",
        "import json; print(json.dumps({'status': 'succeeded'}))",
        "import json; print(json.dumps({'failure': 'ValueError: a: secret-text'}))",
    ):
        monkeypatch.setattr(runner, "RUN_COMMAND", (sys.executable, "-c", f"# {guard.CHILD_MARK}\n{source}"))
        with TestClient(create_app(make_settings(binary_dir))) as client:
            resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())
        assert resp.status_code == 500, source
        assert resp.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_a_collector_that_cannot_be_run_is_503(binary_dir: Path) -> None:
    path = write_collector(binary_dir, VERSION, "exit 0\n")
    path.chmod(0o644)  # held, but not executable
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "version_unavailable"


# ---------------------------------------------------------------------------
# Ruling 27: only the collector's exec is "unavailable"; every error is the
# envelope; the findings' ids are the contract's
# ---------------------------------------------------------------------------


def test_an_os_error_escaping_the_run_is_500_not_unavailable(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A TimeoutError (or ENOSPC, any OSError) escaping the run is a failure
    of the tester, answered 500: only the collector's exec failing is 503
    ``version_unavailable`` (m2)."""
    write_fake_collector(binary_dir, VERSION)
    failing_child = (
        f"# {guard.CHILD_MARK} with a run that times out\n"
        "import sys\n"
        "from app import run_child\n"
        "async def times_out(request):\n"
        "    raise TimeoutError('timed out')\n"
        "run_child.execute = times_out\n"
        "sys.exit(run_child.main())\n"
    )
    monkeypatch.setattr(runner, "RUN_COMMAND", (sys.executable, "-E", "-s", "-c", failing_child))
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.status_code == 500
    assert resp.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_only_the_collectors_exec_failing_marks_the_answer_unavailable() -> None:
    from app import run_child
    from app.run import CollectorExecFailed

    async def exec_failed(request):  # noqa: ANN001
        raise CollectorExecFailed("PermissionError")

    async def disk_full(request):  # noqa: ANN001
        raise OSError(28, "No space left on device")

    real = run_child.execute
    document = {
        "binary": "/x",
        "yaml": "a: 1\n",
        "pipeline": "logs",
        "signal": "logs",
        "durationSeconds": 1,
        "version": VERSION,
        "workspace": "/nowhere",
    }
    try:
        run_child.execute = exec_failed
        assert run_child.answer_for(document) == {"failure": "PermissionError", "unavailable": True}
        run_child.execute = disk_full
        assert run_child.answer_for(document) == {"failure": "OSError"}
    finally:
        run_child.execute = real


# ---------------------------------------------------------------------------
# Ruling 29: "unavailable" only for the exec's own errnos
# ---------------------------------------------------------------------------

EXEC_TEXT = (
    "receivers:\n  otlp: {protocols: {http: {}}}\n"
    "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [otlp], exporters: [debug]}\n"
)


def _spawn_fails_with(monkeypatch: pytest.MonkeyPatch, code: int) -> None:
    """Starting the collector raises the OSError ``code`` names (as Python's
    subprocess does for the exec's errno, or for a fork or a pipe)."""

    async def fails(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        raise OSError(code, os.strerror(code))

    monkeypatch.setattr(asyncio.base_events.BaseEventLoop, "subprocess_exec", fails)


def _child_document(binary_dir: Path, tmp_path: Path) -> dict:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "input.raw").write_bytes(b'{"resourceLogs":[]}')
    return {
        "binary": str(write_fake_collector(binary_dir, VERSION)),
        "yaml": EXEC_TEXT,
        "pipeline": "logs",
        "signal": "logs",
        "durationSeconds": 1,
        "version": VERSION,
        "workspace": str(workspace),
    }


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        (errno.ENOENT, "FileNotFoundError"),
        (errno.EACCES, "PermissionError"),
        (errno.EPERM, "PermissionError"),
        (errno.ENOEXEC, "OSError"),
    ],
)
def test_the_execs_own_errnos_mark_the_answer_unavailable(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: int, kind: str
) -> None:
    from app import run_child

    document = _child_document(binary_dir, tmp_path)
    _spawn_fails_with(monkeypatch, code)

    assert run_child.answer_for(document) == {"failure": kind, "unavailable": True}


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        (errno.EAGAIN, "BlockingIOError"),
        (errno.ENOMEM, "OSError"),
        (errno.EMFILE, "OSError"),
        (errno.ENFILE, "OSError"),
    ],
)
def test_a_fork_or_pipe_that_fails_is_a_plain_failure_not_unavailable(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: int, kind: str
) -> None:
    """Ruling 29: a fork (EAGAIN, ENOMEM) or a pipe (EMFILE, ENFILE) that
    fails is the tester's own trouble: the child answers a plain failure,
    which the service answers 500, never 503 ``version_unavailable``."""
    from app import run_child

    document = _child_document(binary_dir, tmp_path)
    _spawn_fails_with(monkeypatch, code)

    assert run_child.answer_for(document) == {"failure": kind}


def test_a_child_that_cannot_be_started_is_500_not_unavailable(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ruling 29: ChildNotStarted (the run's own child process couldn't be
    started: here, no descriptor left for its pipes) is 500 ``internal_error``."""

    async def no_descriptors() -> None:
        raise OSError(errno.EMFILE, os.strerror(errno.EMFILE))

    write_fake_collector(binary_dir, VERSION)
    monkeypatch.setattr(runner, "_start_child", no_descriptors)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.status_code == 500
    assert resp.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_an_unexpected_error_is_answered_in_the_envelope(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No handler expected it: still the JSON envelope, never a plain-text
    500 or a traceback (Ruling 27's nit)."""
    from app import main as main_module

    def broken(body: bytes) -> dict:
        raise RuntimeError("something nobody expected, with /a/path in it")

    write_fake_collector(binary_dir, VERSION)
    monkeypatch.setattr(main_module, "parse_request", broken)
    with TestClient(create_app(make_settings(binary_dir)), raise_server_exceptions=False) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.status_code == 500
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_the_childs_findings_must_carry_the_contracts_ids() -> None:
    def answer(mutations: list[dict], compatibility: list[dict]) -> dict:
        return {
            "status": "succeeded",
            "strategy": "otlp",
            "kwokEnabled": False,
            "collectorVersion": VERSION,
            "logs": "",
            "mutatedYaml": "",
            "mutations": mutations,
            "compatibility": compatibility,
            "output": None,
            "decodedInput": None,
            "timings": {"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None},
        }

    def finding(identifier: str) -> dict:
        return {"id": identifier, "severity": "warn", "message": "m", "details": {}}

    def issue(identifier: str) -> dict:
        return {"id": identifier, "severity": "advisory", "component": "c", "message": "m", "details": {}}

    assert runner.check_answer(answer([finding("R-001"), finding("F-003")], [issue("C-003")]))
    assert runner.check_answer(answer([finding("R-106")], [issue("C-005")]))
    for broken in (
        answer([finding("C-003")], []),
        answer([finding("R-1")], []),
        answer([finding("X-001")], []),
        answer([], [issue("R-001")]),
        answer([], [issue("C-0003")]),
    ):
        assert not runner.check_answer(broken)
