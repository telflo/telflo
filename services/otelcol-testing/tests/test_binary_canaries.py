"""The neutraliser's canaries on the real collectors (marked `binary`), on
every offered version the image holds: a canary file stands for a file a run
must never read (the secret's, another run's), readable by the collector's
user, and each text references it in one of the forms the collector's confmap
layer decodes and expands. The canary must never reach the answer, in any
field.

- The instrument first: given a live `${file:…}` (with no tester in
  between), the version's `validate` reads the canary into its error (as an
  unrecognised log level), so a reference that reached a run's collector
  would put the canary in the answer.
- Values (a plain value, a `\\x24` escape, a `\\u`-escaped dollar, an escaped
  line break, a tagged scalar, an alias, a flow mapping, a triple dollar) sit
  in an `attributes` processor's inserted value: the run succeeds and its
  output holds the placeholder where the canary would be.
- Keys (a key, a tagged key) sit in `batch`, which refuses unknown keys: the
  collector fails to start and names the key it read, the placeholder.
- After the mutations that move text (R-001, R-004, R-005, R-008), the fake
  path's whole configurations (tests/test_neutraliser_canaries.py) run on
  the real collector; R-005's with its transform statements given their
  context, which the real collector needs (the fake reads no OTTL).
"""

from __future__ import annotations

import base64
import json
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.environment import allowed
from app.main import create_app
from tests.binary_support import OFFERED, image_settings, mutation_ids, require, run
from tests.test_neutraliser_canaries import AFTER_MUTATIONS as FAKE_AFTER_MUTATIONS

pytestmark = pytest.mark.binary

PLACEHOLDER = "otelvalidatorplaceholder"
LOG = json.dumps(
    {
        "resourceLogs": [
            {
                "resource": {},
                "scopeLogs": [{"scope": {}, "logRecords": [{"body": {"stringValue": "order placed"}}]}],
            }
        ]
    }
).encode()


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(create_app(image_settings())) as test_client:
        yield test_client


@pytest.fixture
def canary(tmp_path: Path) -> tuple[Path, str]:
    path = tmp_path / "canary-file"
    content = f"CANARY-{uuid.uuid4().hex}"
    path.write_text(content)
    return path, content


def _everything(answer: dict) -> str:
    """The answer as text, its files decoded too."""
    parts = [json.dumps(answer, ensure_ascii=False)]
    for field in ("output", "decodedInput"):
        if answer.get(field):
            parts.append(base64.b64decode(answer[field]["base64"]).decode("utf-8", "replace"))
    return "\n".join(parts)


def _text(processors: str, names: str) -> str:
    return (
        "receivers:\n  otlp:\n    protocols:\n      http: {}\n"
        f"processors:\n{processors}"
        "exporters:\n  debug: {}\n"
        f"service:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [{names}]\n      exporters: [debug]\n"
    )


def _attributes(value: str) -> str:
    return f"  attributes:\n    actions:\n      - key: leak\n        value: {value}\n        action: insert\n"


# Each value form, with {c} for the canary file's path: (name, processors).
VALUES: list[tuple[str, str]] = [
    ("a plain value", _attributes("${{file:{c}}}")),
    ("a \\x24 escape", _attributes('"\\x24{{file:{c}}}"')),
    ("a \\u-escaped dollar", _attributes('"\\u0024{{file:{c}}}"')),
    ("an escaped line break", _attributes('"$\\\n          {{file:{c}}}"')),
    ("a tagged scalar", _attributes('!!str "${{file:{c}}}"')),
    ("a triple dollar", _attributes("$$${{file:{c}}}")),
    (
        "an alias",
        "  attributes:\n    actions:\n"
        '      - key: leak\n        value: &ref "${{file:{c}}}"\n        action: insert\n'
        "      - key: again\n        value: *ref\n        action: insert\n",
    ),
    ("a flow mapping", '  attributes: {{actions: [{{key: leak, value: "${{file:{c}}}", action: insert}}]}}\n'),
]
# The fake path's configurations; R-005's transform statements get their
# context (`set(attributes[…])` alone is ambiguous to the real collector).
AFTER_MUTATIONS = [
    (
        name,
        mutation,
        signal,
        form.replace(
            '    trace_statements: ["set(attributes[\\"k\\"], \\"${{file:{c}}}\\")"]\n',
            '    trace_statements:\n      - context: span\n        statements: ["set(attributes[\\"k\\"], \\"${{file:{c}}}\\")"]\n',
        ),
        input_text,
    )
    for name, mutation, signal, form, input_text in FAKE_AFTER_MUTATIONS
]
assert "context: span" in AFTER_MUTATIONS[2][3]

KEYS: list[tuple[str, str]] = [
    ("a key", '  batch:\n    "${{file:{c}}}": 1\n'),
    ("a tagged key", "  batch:\n    !!str ${{file:{c}}}: 1\n"),
]


@pytest.mark.parametrize("version", OFFERED)
def test_the_collector_reads_a_live_reference_it_is_given(tmp_path: Path, canary, version: str) -> None:  # noqa: ANN001
    """The canaries' instrument works on this version: a live reference, given
    straight to the collector, reads the canary file into its error."""
    binary = require(version)
    path, content = canary
    config = tmp_path / "direct.yaml"
    config.write_text(
        _text("  batch: {}\n", "batch") + f"  telemetry:\n    logs:\n      level: ${{file:{path}}}\n"
    )

    ran = subprocess.run(
        [str(binary), "validate", "--config", str(config)],
        cwd=tmp_path,
        env=allowed(),
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert ran.returncode != 0
    assert content in ran.stdout + ran.stderr


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("processors", [p for _, p in VALUES], ids=[n for n, _ in VALUES])
def test_a_reference_in_a_value_never_reaches_the_collector(client: TestClient, canary, version: str, processors: str) -> None:  # noqa: ANN001
    path, content = canary

    answer = run(client, version, _text(processors.format(c=path), "attributes"), LOG)

    assert answer["status"] == "succeeded", answer.get("error")
    assert content not in _everything(answer)
    assert str(path) not in answer["mutatedYaml"]
    assert "R-105" in mutation_ids(answer)
    # The collector ran the placeholder where the reference was.
    assert PLACEHOLDER in base64.b64decode(answer["output"]["base64"]).decode()


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("processors", [p for _, p in KEYS], ids=[n for n, _ in KEYS])
def test_a_reference_in_a_key_never_reaches_the_collector(client: TestClient, canary, version: str, processors: str) -> None:  # noqa: ANN001
    path, content = canary

    answer = run(client, version, _text(processors.format(c=path), "batch"), LOG)

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "collector_failed"
    assert content not in _everything(answer)
    assert str(path) not in answer["mutatedYaml"]
    assert "R-105" in mutation_ids(answer)
    # batch refused the key it read: the placeholder.
    assert PLACEHOLDER in answer["logs"]


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize(
    ("mutation", "signal", "form", "input_text"),
    [(mutation, signal, form, input_text) for _, mutation, signal, form, input_text in AFTER_MUTATIONS],
    ids=[name for name, *_ in AFTER_MUTATIONS],
)
def test_a_reference_is_neutralised_after_the_mutation_that_moves_its_text(
    client: TestClient, canary, version: str, mutation: str, signal: str, form: str, input_text: str  # noqa: ANN001
) -> None:
    path, content = canary
    data = input_text.encode() if mutation == "R-008" else LOG

    answer = run(client, version, form.format(c=path), data, signal=signal)

    assert answer["status"] == "succeeded", answer.get("error")
    assert content not in _everything(answer)
    assert str(path) not in answer["mutatedYaml"]
    assert {mutation, "R-105"} <= set(mutation_ids(answer))
    if mutation in ("R-001", "R-008"):  # the reference's processor or operator runs on the input
        assert PLACEHOLDER in base64.b64decode(answer["output"]["base64"]).decode()
