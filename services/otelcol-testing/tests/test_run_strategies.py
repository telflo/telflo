"""A run per strategy, against the fake collector, for the database-free
tester:

- the operator tests (5): the fixture-shape advisories ahead of the others,
  filelog's pull, syslog's push;
- the stop (2): a collector stopped cleanly succeeds, one that crashes
  fails;
- the runner (7; the service stores nothing, and output checks are the OTTL
  evaluator's): the happy path, a crash, an empty output, a clean filelog
  test, a refused operator, and the decoded input answered (OTLP) or not
  (filelog, syslog).

Through the service (a run's child, the fake collector) where the answer is
what matters; through `app.run.execute` in-process where a strategy's
collaborators are watched. Waits are conditions; the hold is a run's
shortest (1 s).
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import run as run_module
from app.executors import otlp_replay, syslog_push
from app.executors.syslog_push import _replay_syslog_tcp
from app.main import create_app
from app.run import RunRequest, execute
from tests.conftest import RUNS_URL, VERSION, auth_headers, make_settings, run_body, write_fake_collector

LOGS = {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [{"logRecords": [{"body": {"stringValue": "hi"}}]}]}]}
METRICS = {"resourceMetrics": [{"resource": {}, "scopeMetrics": []}]}
TRACES = {"resourceSpans": [{"resource": {}, "scopeSpans": []}]}

OTLP_TEXT = (
    "receivers:\n  otlp:\n    protocols:\n      http: {{}}\n"
    "processors:\n  batch: {{}}\n"
    "exporters:\n  otlphttp: {{endpoint: https://example.invalid}}\n"
    "service:\n  pipelines:\n    {signal}:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [otlphttp]\n"
)
FILELOG_TEXT = (
    "receivers:\n"
    "  filelog:\n"
    "    include: [/var/log/x.log]\n"
    "    operators:\n"
    "      - type: regex_parser\n"
    "        regex: '(?P<m>.*)'\n"
    "exporters:\n  debug: {}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:\n"
    "      receivers: [filelog]\n"
    "      exporters: [debug]\n"
)
SYSLOG_TEXT = (
    "receivers:\n"
    "  syslog:\n"
    "    tcp:\n"
    "      listen_address: 0.0.0.0:514\n"
    "    protocol: rfc5424\n"
    "    operators:\n"
    "      - type: move\n"
    "        from: attributes.message\n"
    "        to: body\n"
    "exporters:\n  debug: {}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:\n"
    "      receivers: [syslog]\n"
    "      exporters: [debug]\n"
)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _decoded(field: dict | None) -> bytes | None:
    return None if field is None else base64.b64decode(field["base64"])


@pytest.fixture
def client(binary_dir: Path) -> Iterator[TestClient]:
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app(make_settings(binary_dir))) as test_client:
        yield test_client


def _run(client: TestClient, text: str, data: bytes, *, signal: str = "logs", pipeline: str | None = None, duration: int = 1) -> dict:
    resp = client.post(
        RUNS_URL,
        json=run_body(
            yaml=text,
            signal=signal,
            pipeline=pipeline or signal,
            durationSeconds=duration,
            input={"base64": _b64(data)},
        ),
        headers=auth_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _ids(answer: dict) -> list[str]:
    return [m["id"] for m in answer["mutations"]]


# ---------------------------------------------------------------------------
# A run per strategy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("signal", "envelope"), [("logs", LOGS), ("metrics", METRICS), ("traces", TRACES)])
def test_an_otlp_replay_run_for_each_signal(client: TestClient, signal: str, envelope: dict) -> None:
    answer = _run(client, OTLP_TEXT.format(signal=signal), json.dumps(envelope).encode(), signal=signal)

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "otlp"
    assert json.loads(_decoded(answer["output"])) == envelope
    assert answer["output"]["truncated"] is False
    assert _ids(answer) == ["R-001", "R-002"]
    assert "otlp/test_in" in answer["mutatedYaml"] and "file/test_out" in answer["mutatedYaml"]
    assert "https://example.invalid" not in answer["mutatedYaml"]
    timings = answer["timings"]
    assert all(timings[name] is not None for name in ("readyMs", "replayMs", "holdMs", "stopMs"))
    assert timings["informerMs"] is None


def test_a_filelog_pull_run(client: TestClient) -> None:
    answer = _run(client, FILELOG_TEXT, b"first line\nsecond line\n")

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "filelog"
    bodies = [r["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"]["stringValue"] for r in json.loads(_decoded(answer["output"]))["records"]]
    assert bodies == ["first line", "second line"]
    assert "R-008" in _ids(answer)
    assert "include:\n    - <sandbox/input>" in answer["mutatedYaml"]
    assert answer["timings"]["readyMs"] is not None and answer["timings"]["replayMs"] is not None


def test_a_syslog_push_run(client: TestClient) -> None:
    answer = _run(client, SYSLOG_TEXT, b"<34>1 2026-01-01T00:00:00Z h a - - - hello\n<34>1 2026-01-01T00:00:01Z h a - - - again\n")

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "syslog"
    records = json.loads(_decoded(answer["output"]))["records"]
    assert [r["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"]["stringValue"][-5:] for r in records] == ["hello", "again"]
    assert "R-008" in _ids(answer)
    assert "listen_address: 127.0.0.1:" in answer["mutatedYaml"]
    assert "0.0.0.0:514" not in answer["mutatedYaml"]


# ---------------------------------------------------------------------------
# The operator tests (5)
# ---------------------------------------------------------------------------


def test_filelog_run_warns_when_fixture_is_otlp_envelope(client: TestClient) -> None:
    """An OTLP-JSON envelope (the wrong shape for filelog) on a filelog
    pipeline: the run proceeds, and F-002 leads the advisories, ahead of
    the always-on info ones."""
    answer = _run(client, FILELOG_TEXT, json.dumps({"resourceLogs": [{"resource": {}, "scopeLogs": []}]}).encode())

    assert answer["status"] == "succeeded"
    assert _ids(answer)[0] == "F-002"
    assert "R-008" in _ids(answer)


def test_otlp_run_warns_when_fixture_is_raw_text_lines(client: TestClient) -> None:
    """An OTLP pipeline and a plain-text fixture: F-001 first, and every
    line rejected (the replay block says so)."""
    answer = _run(client, OTLP_TEXT.format(signal="logs"), b"2026-05-26 10:14:03 INFO order placed\n2026-05-26 10:14:05 WARN payment declined\n")

    assert _ids(answer)[0] == "F-001"
    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "replay_rejected", "message": "The collector rejected every payload of the input."}
    assert answer["logs"].startswith("[replay] 2 of 2 fixture line(s) rejected by the collector:\n  line 1 (400): ")


def _request(binary: Path, workspace: Path, text: str, data: bytes, *, duration: int = 1) -> RunRequest:
    workspace.mkdir()
    (workspace / "input.raw").write_bytes(data)
    return RunRequest(
        binary=binary,
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=duration,
        version=VERSION,
        workspace=workspace,
    )


def test_filelog_pull_mode_skips_otlp_push_and_port(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args, **kwargs):
        raise AssertionError("filelog pull mode must NOT reserve a port or push over OTLP")

    # Boom traps catch a regression in pick_strategy that routes filelog to
    # the OTLP or syslog branch.
    monkeypatch.setattr(otlp_replay, "_hold_free_port", boom)
    monkeypatch.setattr(syslog_push, "_hold_free_port", boom)
    monkeypatch.setattr(otlp_replay, "_replay_file", boom)
    binary = write_fake_collector(binary_dir, VERSION)
    workspace = tmp_path / "workspace"

    answer = asyncio.run(execute(_request(binary, workspace, FILELOG_TEXT, b"2026-01-01 hello world\n")))

    assert answer["status"] == "succeeded"
    # The raw fixture was staged at input.log, and the collector read it.
    assert (workspace / "input.log").read_bytes() == b"2026-01-01 hello world\n"
    assert "R-008" in _ids(answer)
    assert b"hello world" in _decoded(answer["output"])


async def test_replay_syslog_tcp_streams_fixture_bytes(tmp_path: Path) -> None:
    """_replay_syslog_tcp opens a loopback TCP connection, writes the
    fixture bytes, and half-closes so the receiver sees EOF."""
    received = bytearray()
    done = asyncio.Event()

    async def handle(reader, writer):  # noqa: ANN001
        received.extend(await reader.read())
        writer.close()
        done.set()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    fixture = tmp_path / "f.syslog"
    fixture.write_bytes(b"<34>1 2026-01-01T00:00:00Z h a - - - msg\n")
    async with server:
        await _replay_syslog_tcp("127.0.0.1", port, fixture)
        await asyncio.wait_for(done.wait(), 30)  # a hang guard
    assert bytes(received) == fixture.read_bytes()


def test_syslog_push_mode_uses_loopback_replay(binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args, **kwargs):
        raise AssertionError("syslog push must NOT use the OTLP _replay_file")

    monkeypatch.setattr(otlp_replay, "_replay_file", boom)
    pushed: list[tuple[str, int]] = []
    real_push = syslog_push._replay_syslog_tcp

    async def recording(host: str, port: int, path: Path) -> None:
        pushed.append((host, port))
        await real_push(host, port, path)

    monkeypatch.setattr(syslog_push, "_replay_syslog_tcp", recording)
    binary = write_fake_collector(binary_dir, VERSION)
    workspace = tmp_path / "workspace"

    answer = asyncio.run(execute(_request(binary, workspace, SYSLOG_TEXT, b"<34>1 2026-01-01T00:00:00Z h a - - - hello\n")))

    assert answer["status"] == "succeeded"
    assert "R-008" in _ids(answer)
    [(host, port)] = pushed
    assert host == "127.0.0.1"
    mutated = (workspace / "config.yaml").read_text()
    assert f"127.0.0.1:{port}" in mutated
    assert "0.0.0.0:514" not in mutated
    assert b"hello" in _decoded(answer["output"])


# ---------------------------------------------------------------------------
# The stop (2)
# ---------------------------------------------------------------------------


def test_a_collector_stopped_cleanly_succeeds_with_its_output(client: TestClient) -> None:
    answer = _run(client, OTLP_TEXT.format(signal="logs"), json.dumps(LOGS).encode())

    assert answer["status"] == "succeeded"
    assert "error" not in answer
    assert json.loads(_decoded(answer["output"])) == LOGS
    assert answer["mutatedYaml"].startswith("receivers:\n  otlp/test_in:")
    assert answer["kwokEnabled"] is False


def test_a_collector_that_crashes_fails_with_its_exit_code(binary_dir: Path) -> None:
    write_fake_collector(binary_dir, VERSION, after_ready="time.sleep(0.2)\nos._exit(2)\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = _run(client, OTLP_TEXT.format(signal="logs"), json.dumps(LOGS).encode(), duration=60)

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "collector_failed", "message": "The collector stopped with exit code 2."}


# ---------------------------------------------------------------------------
# The runner (7)
# ---------------------------------------------------------------------------


def test_run_happy_path(client: TestClient) -> None:
    answer = _run(client, OTLP_TEXT.format(signal="metrics"), json.dumps(METRICS).encode(), signal="metrics")

    assert answer["status"] == "succeeded"
    assert answer["collectorVersion"] == VERSION
    assert json.loads(_decoded(answer["output"])) == METRICS
    assert "Everything is ready" in answer["logs"]
    assert answer["timings"]["totalMs"] >= answer["timings"]["holdMs"]


def test_run_no_output_when_the_collector_crashed(binary_dir: Path) -> None:
    """A crash before any output: failed, and nothing to answer."""
    write_fake_collector(binary_dir, VERSION, prelude="sys.stderr.write('panic: boom\\n')\nos._exit(1)\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = _run(client, OTLP_TEXT.format(signal="logs"), json.dumps(LOGS).encode())

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "collector_failed", "message": "collector exited before becoming ready (code 1)"}
    assert answer["output"] is None
    assert "panic: boom" in answer["logs"]


def test_run_clean_collector_with_empty_output_is_success(binary_dir: Path) -> None:
    """A pipeline that drops every record runs cleanly: succeeded, with no
    output (not an error)."""
    write_fake_collector(binary_dir, VERSION, prelude="config_text = open(CONFIG).read()\n", after_ready="output_path = None\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = _run(client, OTLP_TEXT.format(signal="logs"), json.dumps(LOGS).encode())

    assert answer["status"] == "succeeded"
    assert answer["output"] is None


def test_runner_clean_filelog_operator_test_reaches_the_collector(client: TestClient) -> None:
    answer = _run(client, FILELOG_TEXT, b"x\n")

    assert not [i for i in answer["compatibility"] if i["id"] == "C-004"]
    assert answer["status"] == "succeeded"
    assert answer["strategy"] == "filelog"


def test_runner_disallowed_operator_refused_before_the_collector(binary_dir: Path, tmp_path: Path) -> None:
    marker = tmp_path / "collector-ran"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(marker)!r}, 'w').close()\n")
    text = FILELOG_TEXT.replace("- type: regex_parser\n        regex: '(?P<m>.*)'", "- type: bogus_op")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = _run(client, text, b"x\n")

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert answer["error"]["message"] == (
        "sandbox refused to run pipeline: C-004 filelog: filelog: operator #0 type `bogus_op` is not in the "
        "sandbox allowlist; this operator cannot be safely tested."
    )
    assert [i["id"] for i in answer["compatibility"]] == ["C-004"]
    assert answer["strategy"] is None and answer["mutatedYaml"] is None
    assert not marker.exists()


def test_run_answers_the_decoded_input_when_there_is_one(client: TestClient) -> None:
    """The OTLP replay's decoded input is answered (the platform's Compare
    viewer reads it), as UTF-8 even when the input wasn't."""
    text = json.dumps(LOGS, ensure_ascii=False)
    answer = _run(client, OTLP_TEXT.format(signal="logs"), text.encode("utf-16"))

    assert answer["status"] == "succeeded"
    assert answer["decodedInput"] == {"base64": _b64(text.encode("utf-8")), "truncated": False}


@pytest.mark.parametrize(("text", "data"), [(FILELOG_TEXT, b"a line\n"), (SYSLOG_TEXT, b"<34>1 2026-01-01T00:00:00Z h a - - - m\n")])
def test_run_leaves_the_decoded_input_out_for_filelog_and_syslog(client: TestClient, text: str, data: bytes) -> None:
    answer = _run(client, text, data)

    assert answer["status"] == "succeeded"
    assert answer["decodedInput"] is None


# ---------------------------------------------------------------------------
# C-003's advisory rides along a run, and the fixture-shape check follows the
# target pipeline
# ---------------------------------------------------------------------------


def test_c003_rides_along_a_run_with_its_recommended_duration(client: TestClient) -> None:
    text = (
        "receivers:\n  otlp: {}\n"
        "processors:\n  tail_sampling: {decision_wait: 30s}\n"
        "exporters:\n  debug: {}\n"
        "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [tail_sampling]\n      exporters: [debug]\n"
    )

    answer = _run(client, text, json.dumps(TRACES).encode(), signal="traces")

    assert answer["status"] == "succeeded"
    [c003] = answer["compatibility"]
    assert (c003["id"], c003["severity"], c003["component"]) == ("C-003", "advisory", "tail_sampling")
    assert c003["details"]["recommended_duration_seconds"] == 31
    assert c003["details"]["recommended_covers_window"] is True
    assert c003["details"]["duration_seconds"] == 1
    assert "Raise the run duration to at least 31s" in c003["message"]


SIBLINGS = (
    "receivers:\n"
    "  otlp: {protocols: {http: {}}}\n"
    "  filelog: {include: [/a.log]}\n"
    "exporters:\n  debug: {}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:      {receivers: [filelog], exporters: [debug]}\n"
    "    logs/otlp: {receivers: [otlp],    exporters: [debug]}\n"
)


def test_the_fixture_shape_check_follows_the_target_pipeline(client: TestClient) -> None:
    """A filelog in a sibling pipeline can't change which advisory fires:
    raw text on the OTLP target is F-001; an OTLP envelope on the filelog
    target is F-002."""
    on_otlp = _run(client, SIBLINGS, b"a raw line\nanother\n", pipeline="logs/otlp")
    on_filelog = _run(client, SIBLINGS, json.dumps(LOGS).encode(), pipeline="logs")

    assert on_otlp["strategy"] == "otlp"
    assert _ids(on_otlp)[0] == "F-001"
    assert on_filelog["strategy"] == "filelog"
    assert _ids(on_filelog)[0] == "F-002"
    assert run_module.SNIFF_BYTES == 64 * 1024
