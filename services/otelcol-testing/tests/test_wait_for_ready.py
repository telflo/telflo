"""The collector's readiness.

When ``_wait_for_ready`` gives up — the collector still running but not
listening, or the collector gone — the run fails with fixed words, and the
collector's output is never in the message (its raw stderr would be
unscrubbed there): it is in the run's logs, scrubbed. The collector is
stopped either way (the run's ``finally``).

The filelog strategy's readiness: the hold starts once the collector prints
its ready line, never at the spawn, or at the readiness limit (then the
hold runs anyway).

The readiness limit is lowered where a test waits it out (a parameter of the
code under test, never an assertion on time); every other wait is a
condition, under a generous hang guard.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import processes
from app.executors import _shared
from app.executors._shared import READY_MARKER, _wait_for_ready, _wait_for_ready_marker
from app.executors.base import CollectorNotReady
from app.main import create_app
from app.run import RunRequest, RunningCollector, execute
from tests import guard
from tests.conftest import RUNS_URL, VERSION, auth_headers, make_settings, run_body, write_fake_collector, write_python_collector

# Writes a recognizable startup error, then hangs (the original
# k8sattributes-blocking-on-creds shape), never listening.
HANGS = """
import sys, time
sys.stderr.write("ERROR could not initialize kube client from {where}\\n")
sys.stderr.flush()
while True:
    time.sleep(0.1)
"""

# A config parse error: writes to stderr, exits non-zero.
EXITS = """
import sys
sys.stderr.write("ERROR invalid YAML at line 7 of " + sys.argv[2] + "\\n")
sys.exit(1)
"""


async def _spawn(binary: Path, workspace: Path) -> RunningCollector:
    transport, pipes = await asyncio.get_running_loop().subprocess_exec(
        lambda: processes.Pipes({1: 1024 * 1024}),
        str(binary),
        "--config",
        str(workspace / "config.yaml"),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(workspace),
    )
    return RunningCollector(transport, pipes)


def test_wait_for_ready_gives_up_on_a_collector_that_never_listens_without_its_output_in_the_message(
    binary_dir: Path, tmp_path: Path
) -> None:
    binary = write_python_collector(binary_dir, VERSION, HANGS.format(where=tmp_path))

    async def scenario():
        collector = await _spawn(binary, tmp_path)
        try:
            with pytest.raises(CollectorNotReady) as raised:
                await _wait_for_ready(collector, "127.0.0.1", 1, timeout_seconds=0.5)
            # Its output is still there for the logs, as it printed it.
            await processes.within(collector.pipes.exited, 0)
            return raised.value.message, collector.output_so_far()
        finally:
            await processes.stop(collector.transport, collector.pipes)

    message, output = guard.in_thread(scenario)

    assert message == "otlp endpoint 127.0.0.1:1 not ready within 0.5s"
    assert "kube client" not in message and str(tmp_path) not in message
    assert b"could not initialize kube client" in output


def test_wait_for_ready_reports_an_early_exit_without_its_output_in_the_message(binary_dir: Path, tmp_path: Path) -> None:
    binary = write_python_collector(binary_dir, VERSION, EXITS)

    async def scenario():
        collector = await _spawn(binary, tmp_path)
        try:
            with pytest.raises(CollectorNotReady) as raised:
                await _wait_for_ready(collector, "127.0.0.1", 1)
            return raised.value.message
        finally:
            await processes.stop(collector.transport, collector.pipes)

    message = guard.in_thread(scenario)

    assert message == "collector exited before becoming ready (code 1)"


def test_a_runs_answer_carries_the_collectors_output_scrubbed_when_it_never_became_ready(
    binary_dir: Path,
) -> None:
    """Through the service: the error names what happened, and the logs (not
    the message) hold what the collector printed, its paths scrubbed."""
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude="sys.stderr.write('ERROR bad config at ' + CONFIG + ' in ' + os.getcwd() + '\\n')\nos._exit(1)\n",
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = client.post(RUNS_URL, json=run_body(), headers=auth_headers()).json()

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "collector_failed", "message": "collector exited before becoming ready (code 1)"}
    assert "ERROR bad config at <sandbox/config> in <sandbox>" in answer["logs"]
    assert "otelcol-run-" not in json.dumps(answer)
    assert answer["timings"]["holdMs"] is None


# ---------------------------------------------------------------------------
# The filelog strategy's readiness
# ---------------------------------------------------------------------------


class _Watched:
    """A collector the test drives: its output and its exit."""

    def __init__(self) -> None:
        self.output = b""
        self.returncode: int | None = None
        self.polls = 0

    def output_so_far(self) -> bytes:
        return self.output

    async def exited_within(self, seconds: float) -> bool:
        self.polls += 1
        await asyncio.sleep(0)
        return self.returncode is not None


async def test_the_filelog_readiness_waits_for_the_ready_line() -> None:
    collector = _Watched()
    waiting = asyncio.create_task(_wait_for_ready_marker(collector, timeout_seconds=600))

    for _ in range(20):
        await asyncio.sleep(0)
    assert not waiting.done()  # many polls in, no ready line yet
    collector.output = b"starting\n" + READY_MARKER + b". Begin running and processing data.\n"

    assert await asyncio.wait_for(waiting, 30) is True  # a hang guard


async def test_the_filelog_readiness_gives_up_quietly_at_its_limit_and_raises_on_an_exit() -> None:
    silent = _Watched()
    assert await _wait_for_ready_marker(silent, timeout_seconds=0) is False

    gone = _Watched()
    gone.returncode = 2
    with pytest.raises(CollectorNotReady, match=r"^collector exited before becoming ready \(code 2\)$"):
        await _wait_for_ready_marker(gone, timeout_seconds=600)


def test_a_filelog_run_holds_only_once_the_collector_is_ready(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fake prints its ready line only once the test releases it: the
    run's hold (a wait of the run's duration) begins after the release, never
    before (never at the spawn). In-process, the hold's wait is
    recorded as it starts."""
    release = tmp_path / "ready-now"
    waiting = tmp_path / "collector-waiting"
    write_python_collector(
        binary_dir,
        VERSION,
        "import os, signal, sys, time, yaml\n"
        "config = yaml.safe_load(open(sys.argv[2]))\n"
        "path = config['exporters']['file/test_out']['path']\n"
        "line = open(config['receivers']['filelog']['include'][0]).read().strip()\n"
        "open(path, 'w').write('{\"resourceLogs\":[{\"body\":\"' + line + '\"}]}\\n')\n"
        f"open({str(waiting)!r}, 'w').close()\n"
        f"while not os.path.exists({str(release)!r}):\n"
        "    time.sleep(0.02)\n"
        "signal.signal(signal.SIGTERM, lambda *a: os._exit(0))\n"
        "sys.stderr.write('Everything is ready. Begin running and processing data.\\n'); sys.stderr.flush()\n"
        "while True: time.sleep(1)\n",
    )
    text = (
        "receivers:\n  filelog:\n    include: [/x.log]\n"
        "exporters:\n  debug: {}\n"
        "service:\n  pipelines:\n    logs: {receivers: [filelog], exporters: [debug]}\n"
    )
    events: list[str] = []
    real_within = processes.within

    async def recording(future, seconds):  # noqa: ANN001
        if seconds == 1:  # the hold: the run's duration
            events.append("hold")
        return await real_within(future, seconds)

    monkeypatch.setattr(processes, "within", recording)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "input.raw").write_bytes(b"line\n")
    request = RunRequest(
        binary=binary_dir / f"v{VERSION}" / "otelcol-contrib",
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=1,
        version=VERSION,
        workspace=workspace,
    )

    async def scenario():
        run = asyncio.create_task(execute(request))
        for _ in range(4_000):
            if waiting.exists():
                break
            await asyncio.sleep(0.005)
        events.append("released")
        release.touch()
        return await run

    answer = guard.in_thread(scenario, cleanup=release.touch)

    assert waiting.exists()
    assert events == ["released", "hold"]
    assert answer["status"] == "succeeded"
    assert answer["strategy"] == "filelog"
    assert _shared._READY_TIMEOUT_SECONDS == 10.0
