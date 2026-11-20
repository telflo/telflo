"""`file_log`, filelog's name from collector 0.149.0.

The catalog renamed the `filelog` receiver to `file_log`
(catalog/distributions/otelcol-contrib.json's `renamedTypes`), and every
version the platform offers knows it by both names. The same text with either
spelling takes the same strategy, the same checks and the same mutations,
through the service and in each piece the run uses.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.compatibility import check_compatibility
from app.executors import pick_strategy
from app.fixture_shape import run_advisory
from app.main import create_app
from app.settings import DEFAULT_CATALOG_DIR
from app.testable_receivers import TESTABLE_RECEIVER_KINDS, InputMode, detect_testable_receiver, kind_of_receiver
from tests.conftest import RUNS_URL, VERSION, auth_headers, make_settings, run_body, write_fake_collector

SPELLINGS = ("filelog", "file_log")

TEXT = (
    "receivers:\n"
    "  {r}:\n"
    "    include: [/var/log/x.log]\n"
    "    storage: file_storage\n"
    "    multiline: {{line_start_pattern: '^[A-Z]'}}\n"
    "    operators:\n"
    "      - type: regex_parser\n"
    "        regex: '^(?P<level>[A-Z]+) (?P<m>.*)$'\n"
    "processors:\n  batch: {{}}\n"
    "exporters:\n  debug: {{}}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:\n"
    "      receivers: [{r}]\n"
    "      processors: [batch]\n"
    "      exporters: [debug]\n"
)

SIBLINGS = (
    "receivers:\n"
    "  otlp: {{protocols: {{http: {{}}}}}}\n"
    "  {r}/app: {{include: [/a.log], operators: [{{type: json_parser}}]}}\n"
    "exporters:\n  debug: {{}}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:      {{receivers: [{r}/app], exporters: [debug]}}\n"
    "    logs/otlp: {{receivers: [otlp], exporters: [debug]}}\n"
    "    traces:    {{receivers: [otlp], exporters: [debug]}}\n"
)

LOGS = {"resourceLogs": [{"resource": {}, "scopeLogs": []}]}


# The tester's own words that name both spellings, whichever the text uses.
_FIXED_WORDS = (
    "file_log (filelog)",
    "`file_log` (or `filelog`)",
    "`file_log` reads input",
    "To test `file_log` operators",
)


def _respelt(value: str, spelling: str) -> str:
    """`value` with the text's own spelling of the receiver written as
    RECEIVER (the tester's fixed words left alone), to compare across
    spellings."""
    for index, words in enumerate(_FIXED_WORDS):
        value = value.replace(words, f"\0{index}\0")
    value = value.replace(spelling, "RECEIVER")
    for index, words in enumerate(_FIXED_WORDS):
        value = value.replace(f"\0{index}\0", words)
    return value


# ---------------------------------------------------------------------------
# The names
# ---------------------------------------------------------------------------


def test_every_name_the_catalogue_gives_a_testable_receiver_is_testable() -> None:
    renamed: list[dict] = []
    for path in sorted(DEFAULT_CATALOG_DIR.glob("*.json")):
        renamed.extend(json.loads(path.read_text(encoding="utf-8")).get("renamedTypes", []))
    receivers = [entry for entry in renamed if entry["kind"] == "receiver"]

    assert {"kind": "receiver", "name": "file_log", "deprecatedName": "filelog", "since": "0.149.0"} in receivers
    for entry in receivers:
        names = {entry["name"], entry["deprecatedName"]}
        # A rename touching a testable receiver must keep both names testable.
        assert not names & set(TESTABLE_RECEIVER_KINDS) or names <= set(TESTABLE_RECEIVER_KINDS), entry
    # syslog has no rename, so its one name is enough.
    assert not [entry for entry in receivers if "syslog" in (entry["name"], entry["deprecatedName"])]
    assert set(TESTABLE_RECEIVER_KINDS) == {"filelog", "file_log", "syslog"}


@pytest.mark.parametrize(
    ("name", "kind"),
    [("file_log", "filelog"), ("file_log/app", "filelog"), ("filelog/app", "filelog"), ("syslog/in", "syslog"),
     ("otlp", None), ("file_logs", None), ("filelogx/app", None)],
)
def test_a_receivers_kind_by_its_key(name: str, kind: str | None) -> None:
    assert kind_of_receiver(name) == kind


def test_a_file_log_receiver_is_detected_under_its_own_key() -> None:
    tr = detect_testable_receiver({"receivers": {"file_log/app": {"include": ["/a"]}}})

    assert tr is not None
    assert (tr.kind, tr.name, tr.input_mode) == ("filelog", "file_log/app", InputMode.PULL)


# ---------------------------------------------------------------------------
# The same strategy, advisory and checks, either spelling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "signal", "target", "kind"),
    [
        (TEXT, "logs", "logs", "filelog"),
        (TEXT, "logs", None, "filelog"),
        (TEXT, "traces", None, "otlp"),
        (SIBLINGS, "logs", "logs", "filelog"),
        (SIBLINGS, "logs", "logs/otlp", "otlp"),
        (SIBLINGS, "logs", "logs/gone", "filelog"),
        (SIBLINGS, "traces", "traces", "otlp"),
    ],
    ids=["the target", "the signal", "another signal", "a target beside otlp", "the otlp sibling", "a stale target",
         "a traces target"],
)
def test_either_spelling_takes_the_same_strategy(text: str, signal: str, target: str | None, kind: str) -> None:
    kinds = {spelling: pick_strategy(text.format(r=spelling), signal, target_pipeline=target)[1] for spelling in SPELLINGS}

    assert kinds == {"filelog": kind, "file_log": kind}


@pytest.mark.parametrize("data", [json.dumps(LOGS).encode(), b"INFO a line\n", b""], ids=["an envelope", "raw lines", "empty"])
def test_either_spelling_raises_the_same_advisory(data: bytes) -> None:
    advisories = {
        spelling: run_advisory(data, TEXT.format(r=spelling), "logs", target_pipeline="logs") for spelling in SPELLINGS
    }

    assert advisories["file_log"] == advisories["filelog"]
    if data.startswith(b"{"):
        assert advisories["file_log"] is not None and advisories["file_log"].id == "F-002"
        assert "uses a `file_log` (or `filelog`) receiver" in advisories["file_log"].message


@pytest.mark.parametrize(
    "text",
    [
        TEXT.replace("[{r}]", "[{r}, otlp]").replace("receivers:\n", "receivers:\n  otlp: {{protocols: {{http: {{}}}}}}\n", 1),
        TEXT.replace("[{r}]", "[{r}, syslog]").replace("receivers:\n", "receivers:\n  syslog: {{protocol: rfc5424}}\n", 1),
        TEXT.replace("type: regex_parser\n        regex: '^(?P<level>[A-Z]+) (?P<m>.*)$'", "type: bogus_op"),
        TEXT.replace("    logs:\n", "    traces:\n"),
    ],
    ids=["mixed with otlp", "beside a syslog", "an operator off the allowlist", "in a traces pipeline"],
)
def test_either_spelling_meets_the_same_c004(text: str) -> None:
    signal = "traces" if "    traces:\n" in text else "logs"
    issues = {
        spelling: [
            (issue.id, _respelt(issue.component, spelling), _respelt(issue.message, spelling))
            for issue in check_compatibility(text.format(r=spelling), signal_type=signal, target_pipeline=signal)
        ]
        for spelling in SPELLINGS
    }

    assert [issue_id for issue_id, _, _ in issues["file_log"]] == ["C-004"]
    assert issues["file_log"] == issues["filelog"]


# ---------------------------------------------------------------------------
# Through the service: the same run
# ---------------------------------------------------------------------------


@pytest.fixture
def client(binary_dir: Path) -> Iterator[TestClient]:
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app(make_settings(binary_dir))) as test_client:
        yield test_client


def _run(client: TestClient, text: str, data: bytes, pipeline: str = "logs") -> dict:
    import base64

    response = client.post(
        RUNS_URL,
        json=run_body(yaml=text, signal="logs", pipeline=pipeline, durationSeconds=1,
                      input={"base64": base64.b64encode(data).decode("ascii")}),
        headers=auth_headers(),
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    ("text", "pipeline", "data"),
    [
        (TEXT, "logs", b"INFO first\nWARN second\n"),
        (TEXT, "logs", json.dumps(LOGS).encode()),
        (SIBLINGS, "logs", b'{"a": 1}\n'),
    ],
    ids=["raw lines", "an envelope (F-002)", "the target beside an otlp sibling"],
)
def test_either_spelling_runs_the_same_with_the_same_mutations(client: TestClient, text: str, pipeline: str, data: bytes) -> None:
    answers = {spelling: _run(client, text.format(r=spelling), data, pipeline) for spelling in SPELLINGS}
    filelog, file_log = answers["filelog"], answers["file_log"]

    assert file_log["status"] == "succeeded", file_log.get("error")
    assert file_log["strategy"] == filelog["strategy"] == "filelog"
    assert [m["id"] for m in file_log["mutations"]] == [m["id"] for m in filelog["mutations"]]
    assert "R-008" in [m["id"] for m in file_log["mutations"]]
    assert "R-001" not in [m["id"] for m in file_log["mutations"]]
    assert [_respelt(m["message"], "file_log") for m in file_log["mutations"]] == [
        _respelt(m["message"], "filelog") for m in filelog["mutations"]
    ]
    # The receiver is synthesized under its own key, the operators kept, the
    # file source and storage replaced.
    assert _respelt(file_log["mutatedYaml"], "file_log") == _respelt(filelog["mutatedYaml"], "filelog")
    assert "file_log" in file_log["mutatedYaml"] and "otlp/test_in" not in file_log["mutatedYaml"]
    assert "regex_parser" in file_log["mutatedYaml"] or "json_parser" in file_log["mutatedYaml"]
    assert "/var/log/x.log" not in file_log["mutatedYaml"] and "file_storage" not in file_log["mutatedYaml"]
    assert file_log["compatibility"] == filelog["compatibility"]


# ---------------------------------------------------------------------------
# A `container` operator: the same staging path and the same R-008 advisory
# under either name
# ---------------------------------------------------------------------------

CONTAINER_TEXT = (
    "receivers:\n"
    "  {r}:\n"
    "    include: [/var/log/pods/*/*/*.log]\n"
    "    operators:\n"
    "      - type: container\n"
    "        add_metadata_from_filepath: true\n"
    "processors:\n  k8sattributes: {{}}\n"
    "exporters:\n  debug: {{}}\n"
    "service:\n"
    "  pipelines:\n"
    "    logs:\n"
    "      receivers: [{r}]\n"
    "      processors: [k8sattributes]\n"
    "      exporters: [debug]\n"
)


class _LiveCluster:
    seed_pod_uid = "11111111-2222-3333-4444-555555555555"


@pytest.mark.parametrize("cluster", [None, _LiveCluster()], ids=["no cluster", "a live cluster's uid"])
def test_either_spelling_with_a_container_operator_stages_at_the_container_path(tmp_path: Path, cluster: object) -> None:
    from uuid import uuid4

    from app.executors.base import ExecutorContext
    from app.executors.filelog_pull import choose_staging_path
    from app.run_workspace import RunWorkspace

    workspace = RunWorkspace(uuid4(), tmp_path)
    staged = {}
    for spelling in SPELLINGS:
        ctx = ExecutorContext(
            yaml_config=CONTAINER_TEXT.format(r=spelling),
            signal_type="logs",
            cached_fixture=tmp_path / "fixture",
            run_workspace=workspace,
            binary=tmp_path / "otelcol",
            duration_seconds=1,
            kwok_cluster=cluster,  # type: ignore[arg-type]
            max_output_bytes=1024,
            target_pipeline="logs",
        )
        staged[spelling] = choose_staging_path(ctx)

    expected = workspace.container_log_path(_LiveCluster.seed_pod_uid) if cluster else workspace.container_log_path()
    assert staged == {"filelog": expected, "file_log": expected}
    assert staged["file_log"] != workspace.raw_input_path


def test_either_spelling_with_a_container_operator_gets_the_same_r008_advisory(tmp_path: Path) -> None:
    from uuid import uuid4

    from app.run_workspace import RunWorkspace
    from app.yaml_mutations import mutate_for_operator_test

    fixture = RunWorkspace(uuid4(), tmp_path).container_log_path()
    results = {
        spelling: mutate_for_operator_test(
            CONTAINER_TEXT.format(r=spelling), "logs", tmp_path / "out.json", fixture, None, target_pipeline="logs"
        )
        for spelling in SPELLINGS
    }
    r008 = {spelling: [a for a in advisories if a.id == "R-008"] for spelling, (_text, advisories) in results.items()}

    assert len(r008["file_log"]) == 1
    message = r008["file_log"][0].message
    assert "Because the chain includes a `container` operator" in message
    assert "your `file_log` receiver" in message.lower()
    assert _respelt(message, "file_log") == _respelt(r008["filelog"][0].message, "filelog")
    # The receiver by its own key; the kind is the strategy's, the same for both.
    assert {spelling: r008[spelling][0].details for spelling in SPELLINGS} == {
        "filelog": {"receiver": "filelog", "kind": "filelog"},
        "file_log": {"receiver": "file_log", "kind": "filelog"},
    }
    # The synthesized receiver reads the container-shaped path, under its own key.
    text, _ = results["file_log"]
    assert "  file_log:\n" in text
    assert _respelt(text, "file_log") == _respelt(results["filelog"][0], "filelog")
