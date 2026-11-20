"""The neutraliser in a run, on the fake path: a canary file stands for a
file a run must never read (the secret's, another run's), and each text below
references it in one of the forms a collector decodes and expands: a plain
value, a `\\x24` escape, a `\\u`-escaped dollar, an escaped line break, a
tagged scalar, a key, a tagged key, an alias, a flow mapping, and duplicate
keys (with a clean fixture of duplicate keys beside them).

The fake collector (`tests/conftest.py`'s, with a prelude) does what the
collector's confmap layer does with the text it reads: it decodes the YAML
(PyYAML's composer: escapes, tags, keys, both of two duplicate keys, an
alias's anchor) and expands every live `${file:…}` in each decoded key and
value (an odd run of `$` before `{`), writing what it expanded to its output
and its logs. So a reference that reached it would put the canary in the
answer.

The run mutates the text (R-001 to R-008), so the same canaries are checked
after the mutations that add or move text:
R-001 (the receivers replaced), R-004 (the telemetry replaced), R-005 (the
other pipelines dropped) and R-008 (a filelog receiver's operators carried
into the synthesized receiver). Duplicate keys are refused before any
collector by the run's ruamel read (C-000), as the collector itself
refuses them; the canary never appears either way. The real collector's
canaries are binary tests.
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

from app.main import create_app
from tests.conftest import (
    FAKE_COLLECTOR,
    READY_LINE,
    RUNS_URL,
    VERSION,
    auth_headers,
    make_settings,
    run_body,
    write_fake_collector,
    write_python_collector,
)

# What the collector's confmap layer does, as the fake's prelude: every
# decoded key and value, each live `${file:…}` expanded, written to the logs
# and, once the configuration is read, as the output's first record.
CONFMAP_PRELUDE = r'''
import re
from yaml.nodes import MappingNode, ScalarNode, SequenceNode

LIVE = re.compile(r"(?<!\$)((?:\$\$)*)\$\{file:([^}]*)\}")


def expand(value):
    def read(match):
        try:
            return match.group(1)[: len(match.group(1)) // 2] + open(match.group(2)).read()
        except OSError:
            return match.group(0)
    return LIVE.sub(read, value)


seen, walked = [], set()


def walk(node):
    if id(node) in walked:
        return
    walked.add(id(node))
    if isinstance(node, ScalarNode) and isinstance(node.value, str):
        seen.append(expand(node.value))
    elif isinstance(node, MappingNode):
        for key, value in node.value:
            walk(key)
            walk(value)
    elif isinstance(node, SequenceNode):
        for item in node.value:
            walk(item)


root = yaml.compose(open(CONFIG, encoding="utf-8").read(), Loader=yaml.SafeLoader)
if root is not None:
    walk(root)
sys.stderr.write("\\n".join(seen) + "\\n")
sys.stderr.flush()
_values_written = False
'''

# Once the configuration is read, the expanded values become the output's
# first record (the exporter's path is known then).
CONFMAP_AFTER_READY = '''
emit({"values": seen})
'''

@pytest.fixture
def canary(tmp_path: Path) -> Iterator[tuple[Path, str]]:
    path = tmp_path / "canary-file"
    content = f"CANARY-{uuid.uuid4().hex}"
    path.write_text(content)
    yield path, content


@pytest.fixture
def started(binary_dir: Path) -> Iterator[TestClient]:
    write_fake_collector(binary_dir, VERSION, prelude=CONFMAP_PRELUDE, after_ready=CONFMAP_AFTER_READY)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        yield client


# Each form, with {c} for the canary file's path.
CANARIES: list[tuple[str, str]] = [
    ("a plain value", "processors:\n  attributes:\n    actions:\n      - key: k\n        value: ${{file:{c}}}\n"),
    ("a \\x24 escape", 'a: "\\x24{{file:{c}}}"\n'),
    ("a \\u-escaped dollar", 'a: "\\u0024{{file:{c}}}"\n'),
    ("an escaped line break", 'a: "$\\\n  {{file:{c}}}"\n'),
    ("a tagged scalar", 'a: !!str "${{file:{c}}}"\n'),
    ("a key", '"${{file:{c}}}": x\n'),
    ("a tagged key", "!!str ${{file:{c}}}: x\n"),
    ("an alias", 'a: &ref "${{file:{c}}}"\nb: *ref\n'),
    ("a flow mapping", 'processors: {{attributes: {{actions: [{{key: k, value: "${{file:{c}}}"}}]}}}}\n'),
    ("a triple dollar", "a: $$${{file:{c}}}\n"),
]
# Refused before any collector (C-000), the reference neutralised all the same.
DUPLICATE_KEYS: list[tuple[str, str]] = [
    ("duplicate keys, the reference first", "a: ${{file:{c}}}\na: clean\n"),
    ("duplicate keys, the reference last", "a: clean\na: ${{file:{c}}}\n"),
]


def _run(client: TestClient, text: str) -> dict:
    resp = client.post(RUNS_URL, json=run_body(yaml=text), headers=auth_headers())
    assert resp.status_code == 200, resp.text
    return resp.json()


def _everything(answer: dict) -> str:
    """The answer as text, its output decoded too."""
    output = answer["output"]
    decoded = base64.b64decode(output["base64"]).decode("utf-8", "replace") if output else ""
    return json.dumps(answer, ensure_ascii=False) + decoded


def test_the_fake_collector_expands_a_live_reference_it_is_given(binary_dir: Path, tmp_path: Path, canary) -> None:  # noqa: ANN001
    """The canaries' instrument works: given a live reference (here directly,
    with no tester in between), the fake reads the file into its logs and
    output."""
    path, content = canary
    source = FAKE_COLLECTOR.format(
        prelude=CONFMAP_PRELUDE,
        after_ready=CONFMAP_AFTER_READY + "\nos._exit(0)\n",
        ready=READY_LINE,
    )
    binary = write_python_collector(binary_dir, VERSION, source)
    workspace = tmp_path / "direct"
    workspace.mkdir()
    for name, form in [*CANARIES, *DUPLICATE_KEYS]:
        config = workspace / "config.yaml"
        output = workspace / "output.data"
        output.unlink(missing_ok=True)
        config.write_text(form.format(c=path) + f"exporters:\n  file/test_out:\n    path: {output}\n")
        ran = subprocess.run([str(binary), "--config", str(config)], cwd=workspace, check=True, capture_output=True, text=True)
        assert content in output.read_text(), name
        assert content in ran.stderr, name


@pytest.mark.parametrize("form", [form for _, form in CANARIES], ids=[name for name, _ in CANARIES])
def test_a_reference_in_any_form_is_neutralised_before_the_collector_reads_it(started: TestClient, canary, form: str) -> None:  # noqa: ANN001
    path, content = canary

    answer = _run(started, form.format(c=path))

    _assert_neutralised_and_ran(answer, path, content)


def _assert_neutralised_and_ran(answer: dict, path: Path, content: str) -> None:
    assert answer["status"] == "succeeded", answer.get("error")
    assert content not in _everything(answer)
    assert str(path) not in answer["mutatedYaml"]
    [r105] = [m for m in answer["mutations"] if m["id"] == "R-105"]
    assert r105["details"] == {"schemes": ["file"]}
    assert r105["severity"] == "warn"
    assert r105["message"].startswith("Configuration provider references (${file:...}) were replaced with a placeholder.")
    # The collector ran: its output holds what it decoded, the placeholder.
    assert "otelvalidatorplaceholder" in base64.b64decode(answer["output"]["base64"]).decode()


@pytest.mark.parametrize("form", [form for _, form in DUPLICATE_KEYS], ids=[name for name, _ in DUPLICATE_KEYS])
def test_duplicate_keys_are_refused_before_any_collector_with_the_reference_neutralised(
    started: TestClient, canary, form: str  # noqa: ANN001
) -> None:
    path, content = canary

    answer = _run(started, form.format(c=path))

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "unreadable", "message": "could not parse YAML: found a duplicate key (line 2)"}
    assert content not in json.dumps(answer)
    assert str(path) not in json.dumps(answer)
    assert answer["output"] is None and answer["logs"] == "" and answer["mutatedYaml"] is None
    assert [m["id"] for m in answer["mutations"]] == ["R-105"]


def test_a_clean_text_with_duplicate_keys_is_refused_as_the_collector_would(started: TestClient) -> None:
    """The run's ruamel read refuses duplicate keys (C-000), as the
    collector's own YAML reader does."""
    text = "a: clean\na: also clean\nb: $${file:/escaped/stays/inert}\n"

    answer = _run(started, text)

    assert answer["status"] == "failed"
    [c000] = answer["compatibility"]
    assert (c000["id"], c000["component"], c000["details"]) == ("C-000", "<yaml>", {"error_type": "DuplicateKeyError"})
    assert "clean" not in c000["message"]
    assert answer["mutations"] == []


def test_env_references_are_left_for_the_sandbox(started: TestClient) -> None:
    text = "a: ${env:HOME}\nb: ${HOME}\nc: $${file:/escaped/stays/inert}\n"

    answer = _run(started, text)

    assert answer["status"] == "succeeded"
    assert "R-105" not in [m["id"] for m in answer["mutations"]]
    assert "a: ${env:HOME}\nb: ${HOME}\nc: $${file:/escaped/stays/inert}\n" in answer["mutatedYaml"]
    values = json.loads(base64.b64decode(answer["output"]["base64"]))["records"][0]["values"]
    assert "$${file:/escaped/stays/inert}" in values


# ---------------------------------------------------------------------------
# After the mutations that add or move text
# ---------------------------------------------------------------------------

# Each a whole configuration whose reference sits where a mutation adds,
# replaces or moves text; {c} is the canary file's path.
AFTER_MUTATIONS: list[tuple[str, str, str, str, str]] = [
    (
        "R-001: in a receiver the sandbox replaces",
        "R-001",
        "logs",
        "receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: ${{file:{c}}}\n"
        "processors:\n  attributes:\n    actions:\n      - {{key: k, value: \"${{file:{c}}}\", action: insert}}\n"
        "exporters:\n  debug: {{}}\n"
        "service:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [attributes]\n      exporters: [debug]\n",
        '{"resourceLogs":[]}',
    ),
    (
        "R-004: in the telemetry the sandbox replaces",
        "R-004",
        "logs",
        "receivers:\n  otlp: {{}}\n"
        "processors:\n  attributes:\n    actions:\n      - {{key: k, value: \"${{file:{c}}}\", action: insert}}\n"
        "exporters:\n  debug: {{}}\n"
        "service:\n  telemetry:\n    logs:\n      level: !!str ${{file:{c}}}\n"
        "  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [attributes]\n      exporters: [debug]\n",
        '{"resourceLogs":[]}',
    ),
    (
        "R-005: in a pipeline the sandbox drops",
        "R-005",
        "logs",
        "receivers:\n  otlp: {{}}\n"
        "processors:\n  transform/other:\n    trace_statements: [\"set(attributes[\\\"k\\\"], \\\"${{file:{c}}}\\\")\"]\n"
        "exporters:\n  debug: {{}}\n"
        "service:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n"
        "    traces:\n      receivers: [otlp]\n      processors: [transform/other]\n      exporters: [debug]\n",
        '{"resourceLogs":[]}',
    ),
    (
        "R-008: in an operator the sandbox carries into its filelog receiver",
        "R-008",
        "logs",
        "receivers:\n  filelog:\n    include: [/var/log/app.log]\n    operators:\n"
        "      - {{type: add, field: attributes.k, value: \"\\x24{{file:{c}}}\"}}\n"
        "exporters:\n  debug: {{}}\n"
        "service:\n  pipelines:\n    logs:\n      receivers: [filelog]\n      exporters: [debug]\n",
        "a log line\n",
    ),
]


@pytest.mark.parametrize(
    ("mutation", "signal", "form", "input_text"),
    [(mutation, signal, form, input_text) for _, mutation, signal, form, input_text in AFTER_MUTATIONS],
    ids=[name for name, *_ in AFTER_MUTATIONS],
)
def test_a_reference_is_neutralised_after_the_mutation_that_moves_its_text(
    started: TestClient, canary, mutation: str, signal: str, form: str, input_text: str  # noqa: ANN001
) -> None:
    path, content = canary
    body = run_body(
        yaml=form.format(c=path),
        pipeline=signal,
        signal=signal,
        input={"base64": base64.b64encode(input_text.encode()).decode("ascii")},
    )

    resp = started.post(RUNS_URL, json=body, headers=auth_headers())
    answer = resp.json()

    _assert_neutralised_and_ran(answer, path, content)
    assert mutation in [m["id"] for m in answer["mutations"]]


def test_every_scheme_but_env_is_neutralised_and_named(started: TestClient, canary) -> None:  # noqa: ANN001
    path, content = canary
    text = (
        f"a: ${{file:{path}}}\n"
        "b: ${http://169.254.169.254/latest/meta-data}\n"
        "c: ${https://example.invalid/x}\n"
        'd: "${yaml:{k: v}}"\n'
        "e: ${org:REGION}\n"
        "f: ${env:HOME}\n"
    )

    answer = _run(started, text)

    assert content not in _everything(answer)
    [r105] = [m for m in answer["mutations"] if m["id"] == "R-105"]
    assert r105["details"] == {"schemes": ["file", "http", "https", "org", "yaml"]}
    assert "${env:HOME}" in answer["mutatedYaml"]


@pytest.mark.parametrize(
    "text",
    ["a: [unclosed\n", "a: 1\n---\nb: 2\n", "a: \"\\x24{file:/etc/hostname\"\n\tb: 1\n"],
    ids=["unclosed", "two documents", "a tab"],
)
def test_a_text_pyyaml_cant_read_never_runs(started: TestClient, text: str) -> None:
    answer = _run(started, text)

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "unreadable"
    assert answer["error"]["message"].startswith("could not parse YAML: ")
    assert answer["output"] is None and answer["mutatedYaml"] is None and answer["logs"] == ""
    [c000] = answer["compatibility"]
    assert (c000["id"], c000["severity"], c000["component"]) == ("C-000", "refuse", "<yaml>")
    assert c000["message"] == answer["error"]["message"]
    # PyYAML's problem and line only: never the text.
    assert "/etc/hostname" not in json.dumps(answer)


def test_a_text_too_deep_or_with_too_many_aliases_never_runs(started: TestClient) -> None:
    deep = "a: " + "[" * 120 + "]" * 120 + "\n"
    aliases = "a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n" + "".join(
        f"a{i}: &a{i} [{', '.join([f'*a{i - 1}'] * 10)}]\n" for i in range(1, 7)
    )

    for text, message in (
        (deep, "The configuration nests too deeply."),
        (aliases, "The configuration expands too many YAML aliases."),
    ):
        answer = _run(started, text)
        assert answer["status"] == "failed"
        assert answer["error"] == {"code": "unreadable", "message": message}
        assert answer["compatibility"][0]["id"] == "C-000"
