"""The answer never holds a path inside the tester, nor the shared secret:
raw stderr and absolute workspace paths never reach the person. `app/scrub.py`
replaces the run's workspace (its files first), kwok's kubeconfig, the
service's own directories and the secret's exact value in every field: the
logs, the text it ran, the mutations, the findings, the error, the output and
the decoded input. The logs are then cut to 256 KiB at a line."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.runner import LOGS_TRUNCATION_MARKER, MAX_LOGS_BYTES, bounded_logs, finish_answer
from app.scrub import Scrub
from tests.conftest import (
    PREVIOUS_SECRET,
    RUNS_URL,
    SECRET,
    VERSION,
    auth_headers,
    make_settings,
    run_body,
    write_fake_collector,
)


def test_the_workspace_its_files_and_its_resolved_spelling_are_replaced(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    scrub = Scrub.for_run(workspace=str(link))

    said = scrub.text(
        f"read {link}/config.yaml, wrote {link}/output.data, staged {real}/input.raw in {real} and {link}/x"
    )

    assert said == (
        "read <sandbox/config>, wrote <sandbox/output>, staged <sandbox/input> in <sandbox> and <sandbox>/x"
    )


def test_the_kubeconfig_and_the_services_directories_are_replaced_but_not_a_short_one(tmp_path: Path) -> None:
    scrub = Scrub.for_run(
        kubeconfig="/home/otelcol-testing/.kwok/clusters/telflo-test/kubeconfig.yaml",
        service_dirs=("/app/services/otelcol-testing", "/opt/otelcol", "/home/otelcol-testing", "/root", "/"),
    )

    said = scrub.text(
        "KUBECONFIG=/home/otelcol-testing/.kwok/clusters/telflo-test/kubeconfig.yaml "
        "/opt/otelcol/v0.162.0/otelcol-contrib /app/services/otelcol-testing/app/run.py "
        "/home/otelcol-testing/.kwok /root/x /tmp/mine"
    )

    assert said == (
        "KUBECONFIG=<kubeconfig> <tester>/v0.162.0/otelcol-contrib <tester>/app/run.py <tester>/.kwok /root/x /tmp/mine"
    )


def test_the_secret_is_replaced_as_it_is_and_as_json_spells_it() -> None:
    awkward = 'secret-with-"quotes"-and-\\-0123456789abcdef'
    scrub = Scrub.for_run(secrets=(SECRET, awkward))

    assert scrub.text(f"a {SECRET} b") == "a <redacted> b"
    assert scrub.text(json.dumps({"v": awkward})) == '{"v": "<redacted>"}'
    assert scrub.data(f"x{SECRET}y".encode()) == b"x<redacted>y"


def test_every_string_of_a_value_is_scrubbed_keys_too() -> None:
    scrub = Scrub.for_run(secrets=(SECRET,))

    assert scrub.value({"details": {SECRET: [SECRET, 1, None, {"k": f"_{SECRET}_"}]}}) == {
        "details": {"<redacted>": ["<redacted>", 1, None, {"k": "_<redacted>_"}]}
    }


def test_bounded_logs_keep_whole_lines_within_256_kib() -> None:
    line = "x" * 99 + "\n"
    logs = line * 4000  # 400,000 bytes

    bounded = bounded_logs(logs)

    assert len(bounded.encode()) <= MAX_LOGS_BYTES
    assert bounded.endswith(LOGS_TRUNCATION_MARKER)
    kept = bounded[: -len(LOGS_TRUNCATION_MARKER)]
    assert kept and set(kept.splitlines()) == {"x" * 99}
    assert bounded_logs("short\n") == "short\n"


def test_finish_answer_scrubs_every_field_and_both_files(tmp_path: Path) -> None:
    """With the scrub the service builds (the workspace included, as the
    runner records it); the run's own path to it is tested end to
    end below."""
    workspace = str(tmp_path / "otelcol-run-abc")
    scrub = Scrub.for_run(workspace=workspace, secrets=(SECRET,))
    leak = f"{workspace}/config.yaml {SECRET}"
    document = {
        "status": "failed",
        "error": {"code": "collector_failed", "message": leak},
        "strategy": None,
        "kwokEnabled": False,
        "collectorVersion": VERSION,
        "logs": leak,
        "mutatedYaml": leak,
        "mutations": [{"id": "R-105", "severity": "warn", "message": leak, "details": {"path": leak}}],
        "compatibility": [{"id": "C-001", "severity": "advisory", "component": leak, "message": leak, "details": {}}],
        "output": {"base64": base64.b64encode(leak.encode()).decode(), "bytesOnDisk": 10, "truncated": False},
        "decodedInput": {"base64": base64.b64encode(leak.encode()).decode(), "truncated": False},
        "timings": {"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None},
    }

    rendered = finish_answer(document, scrub)

    answer = json.loads(rendered)
    everything = rendered.decode() + "".join(
        base64.b64decode(answer[name]["base64"]).decode() for name in ("output", "decodedInput")
    )
    assert workspace not in everything
    assert SECRET not in everything
    assert base64.b64decode(answer["output"]["base64"]) == b"<sandbox/config> <redacted>"
    assert answer["output"]["bytesOnDisk"] == 10


def test_a_runs_answer_holds_no_path_inside_the_tester_and_never_the_secret(
    binary_dir: Path, tmp_path: Path
) -> None:
    """The fake collector prints and writes everything it can see of the
    tester: its configuration's path, its working directory, its own path,
    its home, a kubeconfig-like path, and the secret's file's contents (as a
    collector that read the secret's file would)."""
    secret_file = tmp_path / "otelcol_testing_secret"
    secret_file.write_text(f"{SECRET}\n{PREVIOUS_SECRET}\n")
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude=(
            "said = (f'config={sys.argv[2]} cwd={os.getcwd()} real={os.path.realpath(os.getcwd())} '\n"
            "        f'self={sys.argv[0]} home={os.environ[\"HOME\"]}\\n' + open("
            + repr(str(secret_file))
            + ").read())\n"
            "sys.stderr.write(said)\n"
        ),
        after_ready="emit({'said': said})\n",
    )
    text = (
        "processors:\n  attributes:\n    actions:\n"
        f"      - {{key: k, value: {SECRET}, action: insert}}\n"
        "service:\n  pipelines:\n    logs:\n      processors: [attributes]\n"
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(yaml=text), headers=auth_headers())

    answer = resp.json()
    output = base64.b64decode(answer["output"]["base64"]).decode()
    everything = resp.text + output
    assert answer["status"] == "succeeded"
    assert SECRET not in everything and PREVIOUS_SECRET not in everything
    assert "otelcol-run-" not in everything
    assert str(binary_dir) not in everything and os.path.realpath(binary_dir) not in everything
    assert os.environ["HOME"] not in everything
    said_in_output = json.loads(output)["records"][0]["said"]
    for said in (answer["logs"], said_in_output):
        assert "config=<sandbox/config> cwd=<sandbox> real=<sandbox> self=<tester>/v0.162.0/otelcol-contrib" in said
        assert "home=<tester>" in said
        assert "<redacted>\n<redacted>" in said
    assert "value: <redacted>" in answer["mutatedYaml"]


def test_the_logs_are_cut_to_256_kib_at_a_line(binary_dir: Path) -> None:
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude=(
            "for _ in range(4000):\n"
            "    sys.stderr.write('a line of the collector, ninety-nine bytes long ..................................\\n')\n"
            "sys.stderr.flush()\n"
        ),
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    assert resp.json()["status"] == "succeeded"
    logs = resp.json()["logs"]
    assert len(logs.encode()) <= MAX_LOGS_BYTES
    assert logs.endswith(LOGS_TRUNCATION_MARKER)
    assert all(line.startswith("a line of the collector") for line in logs[: -len(LOGS_TRUNCATION_MARKER)].splitlines())


# ---------------------------------------------------------------------------
# The workspace scrubbed from every field, and the files scrubbed
# before they are cut
# ---------------------------------------------------------------------------

import sys  # noqa: E402

import pytest  # noqa: E402

from app import runner  # noqa: E402
from tests import guard  # noqa: E402

# A substitute run child: it answers a failed run whose error, mutations and
# compatibility findings name the run's workspace (as a collector's error
# could), none of which the child itself scrubs.
WORKSPACE_IN_EVERY_FIELD_CHILD = f"""# {guard.CHILD_MARK} naming its workspace
import json, sys
request = json.loads(sys.stdin.buffer.read())
where = request["workspace"] + "/config.yaml and " + request["workspace"]
answer = {{
    "status": "failed",
    "error": {{"code": "collector_failed", "message": "failed reading " + where}},
    "strategy": "otlp",
    "kwokEnabled": False,
    "collectorVersion": request["version"],
    "logs": "",
    "mutatedYaml": None,
    "mutations": [{{"id": "R-008", "severity": "info", "message": where, "details": {{"path": where, where: 1}}}}],
    "compatibility": [{{"id": "C-004", "severity": "refuse", "component": where, "message": where, "details": {{"at": [where]}}}}],
    "output": None,
    "decodedInput": None,
    "timings": {{"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None}},
}}
sys.stdout.write(json.dumps(answer))
"""


def test_the_workspace_is_scrubbed_from_every_field_of_an_answer(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The child scrubs only the logs, the files and the text it ran; the
    service's scrub, which knows the workspace, replaces it in the error, the
    mutations and the compatibility findings too."""
    write_fake_collector(binary_dir, VERSION)
    monkeypatch.setattr(runner, "RUN_COMMAND", (sys.executable, "-c", WORKSPACE_IN_EVERY_FIELD_CHILD))
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers())

    answer = resp.json()
    assert resp.status_code == 200
    assert "otelcol-run-" not in resp.text
    assert answer["error"]["message"] == "failed reading <sandbox/config> and <sandbox>"
    [mutation] = answer["mutations"]
    assert mutation["message"] == "<sandbox/config> and <sandbox>"
    assert mutation["details"] == {"path": "<sandbox/config> and <sandbox>", "<sandbox/config> and <sandbox>": 1}
    [finding] = answer["compatibility"]
    assert finding["component"] == finding["message"] == "<sandbox/config> and <sandbox>"
    assert finding["details"] == {"at": ["<sandbox/config> and <sandbox>"]}


TEN_MIB = 10 * 1024 * 1024


# A substitute run child whose output's form passes 10 MiB, as the real
# child's does when its own scrub lengthens a path (a short kubeconfig path
# becomes `<kubeconfig>`): the secret is in the first record, and again in a
# record whose `<redacted>`, once the service scrubs it, would start 5 bytes
# before the 10 MiB cut.
SECRET_ACROSS_THE_CUT_CHILD = f"""# {guard.CHILD_MARK} with an output past 10 MiB
import base64, json, sys
request = json.loads(sys.stdin.buffer.read())
cap = {TEN_MIB}
secret = {SECRET!r}
def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
def pad(size):
    return {{"resourceLogs": [{{"pad": "x" * size}}]}}
first = {{"resourceLogs": [{{"leak": secret}}]}}
across = {{"resourceLogs": [{{"leak2": secret + "-tail"}}]}}
def scrubbed(records):
    return compact({{"records": records}}).replace(secret, "<redacted>")
records = [first, across]
missing = cap - 5 - scrubbed(records).rindex("<redacted>")
overhead = len(compact(pad(0))) + 1
while missing > 2 * (100_000 + overhead):
    records.insert(-1, pad(100_000))
    missing -= 100_000 + overhead
records.insert(-1, pad(missing - overhead))
assert scrubbed(records).rindex("<redacted>") == cap - 5
data = compact({{"records": records}}).encode()
answer = {{
    "status": "succeeded",
    "strategy": "otlp",
    "kwokEnabled": False,
    "collectorVersion": request["version"],
    "logs": "",
    "mutatedYaml": "",
    "mutations": [],
    "compatibility": [],
    "output": {{"base64": base64.b64encode(data).decode(), "bytesOnDisk": len(data), "truncated": False}},
    "decodedInput": None,
    "timings": {{"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None}},
}}
sys.stdout.write(json.dumps(answer))
"""


def test_a_secret_across_the_outputs_10_mib_cut_never_leaves_part_of_itself(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The child's output passes 10 MiB, the secret in its first record and
    in one crossing the cut: the service scrubs, then cuts at a record, so
    the first is `<redacted>`, the one across the cut is dropped whole, and
    what is left is whole records. Scrubbing, then cutting at a byte, would
    leave the record across the cut, its `<redacted>` and the form's JSON
    cut short, and this test would fail."""
    write_fake_collector(binary_dir, VERSION)
    monkeypatch.setattr(runner, "RUN_COMMAND", (sys.executable, "-c", SECRET_ACROSS_THE_CUT_CHILD))
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = guard.in_thread(lambda: asyncio.to_thread(client.post, RUNS_URL, json=run_body(), headers=auth_headers()))

    answer = resp.json()
    assert resp.status_code == 200
    output = base64.b64decode(answer["output"]["base64"]).decode()
    assert answer["output"]["truncated"] is True
    assert len(output.encode()) <= TEN_MIB
    assert SECRET[:10] not in output and SECRET[:10] not in resp.text
    records = json.loads(output)["records"]
    assert records[0] == {"resourceLogs": [{"leak": "<redacted>"}]}
    assert all(set(record["resourceLogs"][0]) == {"pad"} for record in records[1:])
    assert "leak2" not in output and "<reda" not in output.replace('"<redacted>"', "")


def test_a_record_across_the_collectors_10_mib_mark_is_never_read(binary_dir: Path) -> None:
    """The child's own read: the collector writes the secret in its first
    record and again in a record that crosses the file's 10 MiB mark; the
    child reads whole records within the cap, so the one across the mark is
    dropped whole and the first is replaced by the service."""
    write_fake_collector(
        binary_dir,
        VERSION,
        after_ready=(
            f"cap = {TEN_MIB}\n"
            f"secret = {SECRET!r}\n"
            "def line(record): return json.dumps({'resourceLogs': [record]}) + '\\n'\n"
            "with open(output_path, 'w') as file:\n"
            "    written = file.write(line({'leak': secret}))\n"
            "    across = line({'leak2': secret + '-tail'})\n"
            "    target = cap - 10 - across.index(secret)  # the secret starts 10 bytes before the cut\n"
            "    overhead = len(line({'pad': ''}))\n"
            "    while target - written > 100_000 + overhead:\n"
            "        written += file.write(line({'pad': 'x' * 100_000}))\n"
            "    written += file.write(line({'pad': 'x' * (target - written - overhead)}))\n"
            "    assert written == target\n"
            "    file.write(across)\n"
        ),
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = guard.in_thread(lambda: asyncio.to_thread(client.post, RUNS_URL, json=run_body(), headers=auth_headers()))

    answer = resp.json()
    output = base64.b64decode(answer["output"]["base64"]).decode()
    assert answer["output"]["truncated"] is True
    assert SECRET[:10] not in output and SECRET[:10] not in resp.text
    records = json.loads(output)["records"]
    assert records[0] == {"resourceLogs": [{"leak": "<redacted>"}]}
    assert all("leak2" not in json.dumps(record) for record in records)


def test_a_secret_across_the_decoded_inputs_10_mib_cut_never_leaves_part_of_itself(binary_dir: Path) -> None:
    """A UTF-16 input whose UTF-8 decoding passes 10 MiB, the secret crossing
    the 10 MiB mark: the child sends a little more than the cap, the service
    replaces the secret, then cuts."""
    write_fake_collector(binary_dir, VERSION)
    wide = "中"  # 2 bytes in UTF-16, 3 in UTF-8
    before = TEN_MIB - 10  # the secret's first byte, in UTF-8
    text = wide * (before // 3) + "a" * (before % 3) + SECRET + wide * 1000
    data = text.encode("utf-16")
    assert len(data) <= TEN_MIB and len(text.encode()) > TEN_MIB
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = guard.in_thread(
            lambda: asyncio.to_thread(
                client.post,
                RUNS_URL,
                json=run_body(input={"base64": base64.b64encode(data).decode("ascii")}),
                headers=auth_headers(),
            )
        )

    decoded = base64.b64decode(resp.json()["decodedInput"]["base64"])
    assert resp.json()["decodedInput"]["truncated"] is True
    assert len(decoded) <= TEN_MIB
    assert SECRET[:10].encode() not in decoded and SECRET[:10] not in resp.text
    assert decoded.decode("utf-8").startswith(wide * 1000)


def test_the_text_it_ran_is_bounded_after_the_scrub_too() -> None:
    """A scrub can lengthen the text (a short path, a longer placeholder): the
    bound holds on what is sent."""
    scrub = Scrub(pairs=(("/w", "<sandbox/config>"),))
    document = {
        "status": "succeeded",
        "strategy": "otlp",
        "kwokEnabled": False,
        "collectorVersion": VERSION,
        "logs": "",
        "mutatedYaml": "/w" * (runner.MAX_MUTATED_YAML_CHARACTERS // 2),
        "mutations": [],
        "compatibility": [],
        "output": None,
        "decodedInput": None,
        "timings": {"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None},
    }
    assert runner.check_answer(document)

    with pytest.raises(runner.RunFailed, match="mutated_yaml_too_long"):
        finish_answer(document, scrub)


def test_a_scrub_that_lengthens_the_output_cuts_it_at_a_record() -> None:
    record = {"resourceLogs": [{"body": "/w" * 10}]}
    data = json.dumps({"records": [record] * 3}, separators=(",", ":")).encode()
    scrub = Scrub(pairs=(("/w", "<sandbox/output>"),))
    cap = len(json.dumps({"records": [scrub.value(record)] * 2}, separators=(",", ":")))
    document_file = {"base64": base64.b64encode(data).decode(), "bytesOnDisk": len(data), "truncated": False}

    original = runner.MAX_OUTPUT_BYTES
    runner.MAX_OUTPUT_BYTES = cap
    try:
        scrubbed = runner._scrubbed_file(document_file, scrub, output=True)
    finally:
        runner.MAX_OUTPUT_BYTES = original

    assert json.loads(base64.b64decode(scrubbed["base64"])) == {"records": [scrub.value(record)] * 2}
    assert scrubbed["truncated"] is True
