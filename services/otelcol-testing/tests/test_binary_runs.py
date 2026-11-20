"""Runs on the real collectors (marked `binary`), on every offered version
the image holds, through the service with its own run child, under
`--network none` (CI's otelcol-testing job): OTLP replay for each signal,
filelog's pull under either of its names (`file_log` too) (and the
collector's "Everything is ready" line, which filelog's readiness waits for,
on each version), syslog's push, a collector that fails to start, a fully
rejected replay, a UTF-16 input, the 10 MiB output cap (R-006), and a run
killed at a lowered deadline leaving no process and no workspace behind.

kwok's tests are test_binary_kwok.py's, the neutralizer's canaries
test_binary_canaries.py's, the image's own checks test_binary_image.py's.
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Iterator
from pathlib import Path

import psutil
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.binary_support import (
    BINARY_DIR,
    OFFERED,
    decoded,
    image_settings,
    log_bodies,
    mutation_ids,
    output_records,
    require,
    run,
)

pytestmark = pytest.mark.binary

READY_LINE = "Everything is ready. Begin running and processing data."


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(create_app(image_settings())) as test_client:
        yield test_client


def _log_records(answer: dict) -> list[dict]:
    return [
        record
        for document in output_records(answer)
        for resource in document.get("resourceLogs", [])
        for scope in resource.get("scopeLogs", [])
        for record in scope.get("logRecords", [])
    ]


def _attributes(record: dict) -> dict[str, object]:
    return {a["key"]: next(iter(a["value"].values()), None) for a in record.get("attributes", [])}


def _no_workspace_path(answer: dict) -> None:
    text = json.dumps(answer)
    assert "otelcol-run-" not in text
    assert str(BINARY_DIR) not in text


# ---------------------------------------------------------------------------
# 1. OTLP replay, each signal
# ---------------------------------------------------------------------------

RESOURCE = {"attributes": [{"key": "service.name", "value": {"stringValue": "checkout"}}]}
INPUTS = {
    "logs": {
        "resourceLogs": [
            {
                "resource": RESOURCE,
                "scopeLogs": [
                    {
                        "scope": {"name": "binary-test"},
                        "logRecords": [
                            {
                                "timeUnixNano": "1700000000000000000",
                                "severityText": "INFO",
                                "body": {"stringValue": "order placed"},
                            }
                        ],
                    }
                ],
            }
        ]
    },
    "traces": {
        "resourceSpans": [
            {
                "resource": RESOURCE,
                "scopeSpans": [
                    {
                        "scope": {"name": "binary-test"},
                        "spans": [
                            {
                                "traceId": "5b8efff798038103d269b633813fc60c",
                                "spanId": "eee19b7ec3c1b174",
                                "name": "place-order",
                                "kind": 2,
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001000000000",
                            }
                        ],
                    }
                ],
            }
        ]
    },
    "metrics": {
        "resourceMetrics": [
            {
                "resource": RESOURCE,
                "scopeMetrics": [
                    {
                        "scope": {"name": "binary-test"},
                        "metrics": [
                            {
                                "name": "queue.depth",
                                "gauge": {"dataPoints": [{"asInt": "7", "timeUnixNano": "1700000000000000000"}]},
                            }
                        ],
                    }
                ],
            }
        ]
    },
}
OTLP_TEXT = """\
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  batch:
    timeout: 200ms
exporters:
  otlphttp:
    endpoint: https://collector.example.invalid
service:
  pipelines:
    {signal}:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp]
"""


def _names(answer: dict, signal: str) -> list[str]:
    [document] = output_records(answer)
    if signal == "logs":
        return log_bodies(answer)
    if signal == "traces":
        return [s["name"] for r in document["resourceSpans"] for ss in r["scopeSpans"] for s in ss["spans"]]
    return [m["name"] for r in document["resourceMetrics"] for sm in r["scopeMetrics"] for m in sm["metrics"]]


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize(("signal", "name"), [("logs", "order placed"), ("traces", "place-order"), ("metrics", "queue.depth")])
def test_an_otlp_replay_for_each_signal(client: TestClient, version: str, signal: str, name: str) -> None:
    answer = run(client, version, OTLP_TEXT.format(signal=signal), json.dumps(INPUTS[signal]).encode(), signal=signal)

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "otlp"
    assert answer["collectorVersion"] == version
    assert answer["kwokEnabled"] is False
    assert _names(answer, signal) == [name]
    assert answer["output"]["truncated"] is False
    assert {"R-001", "R-002"} <= set(mutation_ids(answer))
    assert "collector.example.invalid" not in answer["mutatedYaml"]
    assert json.loads(decoded(answer["decodedInput"])) == INPUTS[signal]
    assert all(answer["timings"][key] is not None for key in ("readyMs", "replayMs", "holdMs", "stopMs"))
    _no_workspace_path(answer)


# ---------------------------------------------------------------------------
# 2. Filelog's pull, and the readiness line it waits for
# ---------------------------------------------------------------------------

FILELOG_TEXT = """\
receivers:
  filelog:
    include: [/var/log/app/*.log]
    operators:
      - type: regex_parser
        regex: '^(?P<level>[A-Z]+) (?P<message>.*)$'
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("spelling", ["filelog", "file_log"])
def test_a_filelog_pull_runs_the_operators_on_each_line(client: TestClient, version: str, spelling: str) -> None:
    """Either name of the receiver: `file_log` from collector 0.149.0, which
    every offered version reads, and `filelog`, deprecated."""
    answer = run(client, version, FILELOG_TEXT.replace("filelog", spelling), b"INFO order placed\nWARN payment declined\n")

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "filelog"
    assert f"  {spelling}:\n" in answer["mutatedYaml"]
    assert "R-001" not in mutation_ids(answer)
    records = _log_records(answer)
    assert [r["body"]["stringValue"] for r in records] == ["INFO order placed", "WARN payment declined"]
    assert [_attributes(r)["level"] for r in records] == ["INFO", "WARN"]
    assert [_attributes(r)["message"] for r in records] == ["order placed", "payment declined"]
    assert "R-008" in mutation_ids(answer)
    assert answer["decodedInput"] is None
    _no_workspace_path(answer)


@pytest.mark.parametrize("version", OFFERED)
def test_the_collector_says_everything_is_ready_which_filelogs_readiness_waits_for(client: TestClient, version: str) -> None:
    """Filelog's hold starts at the collector's own "Everything is ready"
    line (`_wait_for_ready_marker`; the readiness limit otherwise): every
    offered version prints it, so no filelog run waits the full limit."""
    answer = run(client, version, FILELOG_TEXT, b"INFO one\n")

    assert answer["status"] == "succeeded", answer.get("error")
    assert READY_LINE in answer["logs"]
    assert answer["timings"]["readyMs"] < 10_000


# ---------------------------------------------------------------------------
# 4. Syslog's push
# ---------------------------------------------------------------------------

SYSLOG_TEXT = """\
receivers:
  syslog:
    tcp:
      listen_address: 0.0.0.0:54526
    protocol: rfc5424
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [syslog]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
def test_a_syslog_push_is_parsed_by_the_receiver(client: TestClient, version: str) -> None:
    lines = (
        b"<34>1 2026-01-01T00:00:00Z web-1 checkout 4242 ID47 - order placed\n"
        b"<34>1 2026-01-01T00:00:01Z web-1 checkout 4242 ID47 - payment declined\n"
    )

    answer = run(client, version, SYSLOG_TEXT, lines)

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "syslog"
    records = _log_records(answer)
    assert sorted(_attributes(r)["message"] for r in records) == ["order placed", "payment declined"]
    assert {_attributes(r)["appname"] for r in records} == {"checkout"}
    assert "0.0.0.0:54526" not in answer["mutatedYaml"]
    _no_workspace_path(answer)


# ---------------------------------------------------------------------------
# 7. A collector that fails to start
# ---------------------------------------------------------------------------

FAILS_TO_START = """\
receivers:
  otlp:
    protocols:
      http: {}
processors:
  attributes:
    actions:
      - key: k
        value: v
        action: not-an-action
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [attributes]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
def test_a_collector_that_fails_to_start_is_an_error_with_scrubbed_logs(client: TestClient, version: str) -> None:
    answer = run(client, version, FAILS_TO_START, json.dumps(INPUTS["logs"]).encode())

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "collector_failed"
    assert "not-an-action" in answer["logs"]  # the collector's own reason, kept
    assert answer["output"] is None
    _no_workspace_path(answer)


# ---------------------------------------------------------------------------
# 8. A fully rejected replay
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("version", OFFERED)
def test_a_replay_the_collector_rejects_whole_is_an_error(client: TestClient, version: str) -> None:
    answer = run(client, version, OTLP_TEXT.format(signal="logs"), b"2026-05-26 INFO order placed\n2026-05-26 WARN declined\n")

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "replay_rejected", "message": "The collector rejected every payload of the input."}
    assert answer["logs"].startswith("[replay] 2 of 2 fixture line(s) rejected by the collector:\n")
    assert "F-001" in mutation_ids(answer)


# ---------------------------------------------------------------------------
# 9. A UTF-16 input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("codec", ["utf-16", "utf-16-le"], ids=["with a BOM", "without a BOM"])
def test_a_utf16_input_is_decoded_and_replayed(client: TestClient, version: str, codec: str) -> None:
    document = json.loads(json.dumps(INPUTS["logs"]))
    document["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"]["stringValue"] = "Bestellung aufgegeben: Grüße"
    data = json.dumps(document, ensure_ascii=False).encode(codec)

    answer = run(client, version, OTLP_TEXT.format(signal="logs"), data)

    assert answer["status"] == "succeeded", answer.get("error")
    assert log_bodies(answer) == ["Bestellung aufgegeben: Grüße"]
    assert json.loads(decoded(answer["decodedInput"]).decode("utf-8")) == document


# ---------------------------------------------------------------------------
# 10. The output cap (R-006)
# ---------------------------------------------------------------------------

# Each record is copied into two attributes, so the output is about three
# times the input: 45 records of 100 KiB in, about 13.5 MiB out, between
# the 10 MiB cap and the 16 MiB watchdog.
COPYING_TEXT = """\
receivers:
  otlp:
    protocols:
      http: {}
processors:
  transform:
    log_statements:
      - context: log
        statements:
          - set(attributes["copy"], body)
          - set(attributes["again"], body)
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [transform]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
def test_an_output_past_10_mib_is_cut_at_a_record_with_r006(client: TestClient, version: str) -> None:
    lines = []
    for index in range(45):
        document = json.loads(json.dumps(INPUTS["logs"]))
        document["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"]["stringValue"] = f"{index:04d}" + "x" * 100_000
        lines.append(json.dumps(document, separators=(",", ":")))
    data = ("\n".join(lines) + "\n").encode()

    answer = run(client, version, COPYING_TEXT, data)

    assert answer["status"] == "succeeded", answer.get("error")
    output = answer["output"]
    assert output["truncated"] is True
    assert output["bytesOnDisk"] > 10 * 1024 * 1024
    assert len(decoded(output)) <= 10 * 1024 * 1024
    [r006] = [m for m in answer["mutations"] if m["id"] == "R-006"]
    assert r006["severity"] in ("caution", "warn")
    # Whole records only, the first ones in order.
    bodies = log_bodies(answer)
    assert 0 < len(bodies) < 45
    assert [body[:4] for body in bodies] == [f"{i:04d}" for i in range(len(bodies))]


# ---------------------------------------------------------------------------
# 11. A run killed at a lowered deadline
# ---------------------------------------------------------------------------


def _collectors_running() -> list[int]:
    """Every process running one of the image's collectors (zombies are dead)."""
    found = []
    for process in psutil.process_iter(["cmdline", "status"]):
        try:
            command = process.info["cmdline"] or []
            if command and command[0].startswith(str(BINARY_DIR)) and process.info["status"] != psutil.STATUS_ZOMBIE:
                found.append(process.pid)
        except psutil.Error:
            continue
    return found


def _workspaces() -> set[str]:
    return {path.name for path in Path(tempfile.gettempdir()).glob("otelcol-run-*")}


@pytest.mark.parametrize("version", OFFERED)
def test_a_run_killed_at_its_deadline_leaves_no_collector_and_no_workspace(version: str) -> None:
    """The run's deadline lowered to its duration (3 s, `run_deadline_base_seconds=0`),
    shorter than the collector's start plus its hold: the whole group is
    killed, the answer is `timed_out`, and nothing of the run is left."""
    require(version)
    before = _workspaces()
    assert _collectors_running() == []

    with TestClient(create_app(image_settings(run_deadline_base_seconds=0))) as killing:
        answer = run(killing, version, OTLP_TEXT.format(signal="logs"), json.dumps(INPUTS["logs"]).encode(), duration=3)

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "timed_out", "message": "The run didn't finish within its 3 s budget and was stopped."}
    assert _collectors_running() == []
    assert _workspaces() == before


# ---------------------------------------------------------------------------
# The service detectors stripped, geoip refused
# ---------------------------------------------------------------------------

SERVICE_DETECTORS = """\
receivers:
  otlp:
    protocols:
      http: {}
processors:
  resource_detection:
    detectors: [env, consul, openshift]
    consul: {address: "http://127.0.0.1:20001"}
    openshift: {address: "https://127.0.0.1:20002"}
  resourcedetection/docker:
    detectors: [docker]
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [resource_detection, resourcedetection/docker]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
def test_the_service_detectors_are_stripped_and_the_rest_still_runs(client: TestClient, version: str) -> None:
    """R-106 on each version: the processor keeps `env` (either spelling is
    accepted), the one left with no detector is gone, and the run succeeds."""
    answer = run(client, version, SERVICE_DETECTORS, json.dumps(INPUTS["logs"]).encode())

    assert answer["status"] == "succeeded", answer.get("error")
    assert "R-106" in mutation_ids(answer)
    assert "consul" not in answer["mutatedYaml"] and "openshift" not in answer["mutatedYaml"]
    assert "resourcedetection/docker" not in answer["mutatedYaml"]
    assert "127.0.0.1:2000" not in answer["mutatedYaml"]
    assert len(output_records(answer)) == 1


@pytest.mark.parametrize("version", OFFERED)
def test_a_geoip_processor_is_refused_on_every_version(client: TestClient, version: str) -> None:
    text = SERVICE_DETECTORS.replace(
        "  resourcedetection/docker:\n    detectors: [docker]\n",
        "  geoip:\n    providers: {maxmind: {database_path: /run/secrets/otelcol_testing_secret}}\n",
    ).replace("resourcedetection/docker]", "geoip]")

    answer = run(client, version, text, json.dumps(INPUTS["logs"]).encode())

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert [issue["id"] for issue in answer["compatibility"]] == ["C-005"]
    assert answer["timings"]["readyMs"] is None


# A processor setting that names a file is refused (C-006).
@pytest.mark.parametrize("version", OFFERED)
def test_a_processor_setting_that_names_a_file_is_refused_on_every_version(client: TestClient, version: str) -> None:
    text = SERVICE_DETECTORS.replace(
        "  resourcedetection/docker:\n    detectors: [docker]\n",
        "  resourcedetection/docker:\n    detectors: [env]\n    tls: {ca_file: /run/secrets/otelcol_testing_secret}\n",
    )

    answer = run(client, version, text, json.dumps(INPUTS["logs"]).encode())

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert [(issue["id"], issue["details"]) for issue in answer["compatibility"]] == [
        ("C-006", {"processor": "resourcedetection/docker", "key": "tls.ca_file"})
    ]
    assert answer["timings"]["readyMs"] is None
    assert "/run/secrets" not in json.dumps(answer)


# Schema and remotetap refused outright (C-005).
@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize(
    "processor",
    [
        "  schema:\n    prefetch: [\"file:///run/secrets/otelcol_testing_secret\"]\n",
        "  remotetap:\n    endpoint: 127.0.0.1:12001\n",
    ],
    ids=["schema", "remotetap"],
)
def test_schema_and_remotetap_are_refused_on_every_version(client: TestClient, version: str, processor: str) -> None:
    name = processor.split(":", 1)[0].strip()
    text = SERVICE_DETECTORS.replace("  resourcedetection/docker:\n    detectors: [docker]\n", processor).replace(
        "resourcedetection/docker]", f"{name}]"
    )

    answer = run(client, version, text, json.dumps(INPUTS["logs"]).encode())

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert [(issue["id"], issue["component"]) for issue in answer["compatibility"]] == [("C-005", name)]
    assert answer["timings"]["readyMs"] is None
    assert "/run/secrets" not in json.dumps(answer)
