"""The run's fixes, each pinned here, plus the contract's distribution
(contrib only):

- the collector's pipes drained while it runs (a chatty collector blocked);
- the collector always stopped, in a ``finally`` (an exception orphaned it);
- an unknown signal refused at the contract (``_SIGNAL_PATHS[signal]``
  raised);
- C-002 with a non-mapping processor (it raised), and texts of the wrong
  shape (they raised): refused or left to the collector, never a 500;
- the replay's total budget: the replay stops, the hold still runs;
- the output watchdog: a collector whose file passes 16 MiB is stopped, R-006;
- the decoded input capped at 10 MiB, ``truncated``;
- no path outside the run's workspace survives the mutations (all runs share
  one uid and /tmp);
- ClickStack (any distribution but contrib) refused at the contract.

Fixed elsewhere, and tested there: stderr scrubbed on every path
(`test_wait_for_ready.py`, `test_scrub.py`), the input as bytes so UTF-16
reaches the decoder (`test_run_strategies.py`), the filelog readiness
(`test_wait_for_ready.py`), the free port's race (`test_otlp_replay_rejections.py`),
the fixture-shape check on the target pipeline (`test_run_strategies.py`).

Waits are conditions, under the hang guard.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from ruamel.yaml import YAML

from app import run as run_module
from app import runner
from app.catalog import binary_path
from app.executors import _shared, otlp_replay
from app.executors.base import FeedFailed
from app.executors.syslog_push import SyslogPushStrategy
from app.main import create_app
from app.run import MAX_DECODED_INPUT_BYTES, OUTPUT_WATCHDOG_BYTES, RunRequest, Strategy, execute
from app.scrub import Scrub
from tests import guard
from tests.conftest import RUNS_URL, VERSION, auth_headers, make_settings, run_body, write_fake_collector

OTLP_LOGS = (
    "receivers:\n  otlp: {protocols: {http: {}}}\n"
    "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [otlp], exporters: [debug]}\n"
)
LOGS = b'{"resourceLogs":[]}'


@pytest.fixture
def client(binary_dir: Path) -> Iterator[TestClient]:
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app(make_settings(binary_dir))) as test_client:
        yield test_client


def _post(client: TestClient, **overrides: object):
    return client.post(RUNS_URL, json=run_body(**overrides), headers=auth_headers())


def _running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _request(binary_dir: Path, workspace: Path, text: str, data: bytes, *, duration: int = 1) -> RunRequest:
    workspace.mkdir()
    (workspace / "input.raw").write_bytes(data)
    return RunRequest(
        binary=binary_path(binary_dir, VERSION),
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=duration,
        version=VERSION,
        workspace=workspace,
    )


# ---------------------------------------------------------------------------
# The pipes, and the collector stopped whatever happens
# ---------------------------------------------------------------------------


def test_a_chatty_collector_is_drained_as_it_runs(binary_dir: Path) -> None:
    """2 MiB printed before it listens: read only at the end, such a
    collector would block on a full pipe and never become ready. Drained as
    it arrives, the run succeeds, its logs cut and marked."""
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude="for _ in range(2048):\n    sys.stderr.write('x' * 1023 + '\\n')\nsys.stderr.flush()\n",
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = guard.in_thread(lambda: asyncio.to_thread(_post, client, yaml=OTLP_LOGS)).json()

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["logs"].endswith("\n[logs truncated by the tester]\n")


def test_the_collector_is_stopped_when_the_run_fails_unexpectedly(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An error between the spawn and the stop (here, in the replay) still
    ends the collector: the ``finally`` kills and reaps it."""
    pid_file = tmp_path / "collector-pid"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n")

    async def broken(*args, **kwargs):
        raise RuntimeError("the replay broke")

    monkeypatch.setattr(otlp_replay, "_replay_file", broken)
    request = _request(binary_dir, tmp_path / "workspace", OTLP_LOGS, LOGS, duration=60)

    async def scenario():
        with pytest.raises(RuntimeError, match="the replay broke"):
            await execute(request)

    guard.in_thread(scenario)

    assert not _running(int(pid_file.read_text()))


def test_a_cancelled_run_stops_its_collector(binary_dir: Path, tmp_path: Path) -> None:
    pid_file = tmp_path / "collector-pid"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n")
    request = _request(binary_dir, tmp_path / "workspace", OTLP_LOGS, LOGS, duration=60)

    async def scenario():
        run = asyncio.create_task(execute(request))
        for _ in range(4_000):
            if pid_file.exists() and pid_file.read_text():
                break
            await asyncio.sleep(0.005)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run

    guard.in_thread(scenario)

    assert not _running(int(pid_file.read_text()))


# ---------------------------------------------------------------------------
# The contract, the shapes, and C-002
# ---------------------------------------------------------------------------


def test_an_unknown_signal_is_refused_at_the_contract(client: TestClient, binary_dir: Path) -> None:
    """A signal the run doesn't know would raise in ``_SIGNAL_PATHS[signal]``;
    the contract refuses one, and nothing runs."""
    resp = _post(client, signal="profiles")

    assert resp.status_code == 400
    assert resp.json() == {"error": {"code": "invalid_request", "message": "`signal` must be traces, metrics or logs."}}


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("- a\n- b\n", "could not parse YAML: the configuration must be a mapping at the top level"),
        ("receivers: [otlp]\n", "could not parse YAML: `receivers` must be a mapping of component names"),
        ("service:\n  pipelines:\n    logs: just text\n", "could not parse YAML: pipeline `logs` must be a mapping"),
    ],
)
def test_a_text_of_the_wrong_shape_is_refused_never_a_500(client: TestClient, text: str, message: str) -> None:
    resp = _post(client, yaml=text)

    assert resp.status_code == 200
    answer = resp.json()
    assert answer["error"] == {"code": "unreadable", "message": message}
    assert answer["compatibility"][0]["id"] == "C-000"


@pytest.mark.parametrize(
    "text",
    [
        "processors:\n  k8sattributes: 5\n" + OTLP_LOGS,
        "processors:\n  k8sattributes: kube_config_path\n" + OTLP_LOGS,
        "processors:\n  resourcedetection: [gcp]\n" + OTLP_LOGS,
        "receivers:\n  filelog: just text\nservice:\n  pipelines:\n    logs: {receivers: [filelog]}\n",
        "service:\n  pipelines:\n    logs:\n",
    ],
)
def test_an_odd_component_configuration_is_left_to_the_collector_never_a_500(client: TestClient, text: str) -> None:
    """C-002 skips a processor that isn't a mapping (never raising on an
    integer or matching a string), and the mutations leave such values for
    the collector to judge."""
    resp = _post(client, yaml=text)

    assert resp.status_code == 200, resp.text
    assert not [i for i in resp.json()["compatibility"] if i["id"] == "C-002"]


# ---------------------------------------------------------------------------
# The replay's budget, the watchdog, the decoded input's cap
# ---------------------------------------------------------------------------


def test_when_the_replays_budget_runs_out_the_hold_still_runs(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The replay stops, the hold still runs, and the [replay]
    block says how many payloads weren't sent. (The budget is spent before
    the first payload here.)"""
    write_fake_collector(binary_dir, VERSION)
    monkeypatch.setattr(otlp_replay, "_replay_file", functools.partial(otlp_replay._replay_file, budget_seconds=0))
    data = b'{"resourceLogs":[]}\n{"resourceLogs":[]}\n{"resourceLogs":[]}\n'
    request = _request(binary_dir, tmp_path / "workspace", OTLP_LOGS, data)

    answer = guard.in_thread(lambda: execute(request))

    assert answer["status"] == "succeeded"
    assert answer["logs"].startswith("[replay] 3 of 3 payloads not sent: the replay's 0 s budget ran out\n")
    assert answer["timings"]["holdMs"] is not None
    assert answer["output"] is None


FLOOD = (
    "line = json.dumps({'resourceLogs': [{'pad': 'x' * 1000}]}) + '\\n'\n"
    "with open(output_path, 'a') as file:\n"
    "    for _ in range(17 * 1024):\n"
    "        file.write(line)\n"
)


@pytest.mark.parametrize(
    "after_ready",
    [FLOOD, "while answered[0] < 1:\n    time.sleep(0.01)\n" + FLOOD],
    ids=["flooding as the replay starts", "flooding once the replay is answered"],
)
def test_the_output_watchdog_stops_a_collector_whose_file_passes_16_mib(binary_dir: Path, after_ready: str) -> None:
    """One run can't fill the shared /tmp. The collector writes
    17 MiB, the run (60 s long) ends once the watchdog stops it, and the
    answer carries R-006 and 10 MiB at most. A collector stopped while the
    replay still runs isn't a rejected replay: its output overflowed."""
    write_fake_collector(binary_dir, VERSION, after_ready=after_ready)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = guard.in_thread(lambda: asyncio.to_thread(_post, client, yaml=OTLP_LOGS, durationSeconds=60))

    answer = resp.json()
    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["output"]["bytesOnDisk"] > OUTPUT_WATCHDOG_BYTES
    assert answer["output"]["truncated"] is True
    assert len(base64.b64decode(answer["output"]["base64"])) <= 10 * 1024 * 1024
    [r006] = [m for m in answer["mutations"] if m["id"] == "R-006"]
    assert r006["details"]["cap_bytes"] == 10 * 1024 * 1024
    assert answer["timings"]["holdMs"] < 60_000  # stopped by the watchdog, not the hold's end


def test_a_collector_that_ignores_the_watchdogs_sigterm_is_killed_and_the_run_fails(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The outcome stated (`app/run.py`'s ``_watch_output``): a collector
    that ignores SIGTERM is killed after the grace (lowered here); the run
    fails, ``collector_failed`` with exit code 137, and still answers its
    output cut at 10 MiB with R-006, as a collector killed at the hold's own
    stop does."""
    write_fake_collector(
        binary_dir,
        VERSION,
        after_ready="signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" + FLOOD,
    )
    monkeypatch.setattr(run_module, "STOP_GRACE_SECONDS", 0.2)
    request = _request(binary_dir, tmp_path / "workspace", OTLP_LOGS, LOGS, duration=60)

    answer = guard.in_thread(lambda: execute(request))

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "collector_failed", "message": "The collector stopped with exit code 137."}
    assert answer["output"]["bytesOnDisk"] > OUTPUT_WATCHDOG_BYTES
    assert answer["output"]["truncated"] is True
    assert len(base64.b64decode(answer["output"]["base64"])) <= 10 * 1024 * 1024
    assert "R-006" in [m["id"] for m in answer["mutations"]]
    assert answer["timings"]["holdMs"] < 60_000  # killed by the watchdog, not the hold's end


class _Decoded:
    def __init__(self, text: str) -> None:
        self.text = text

    def decoded_input(self) -> str:
        return self.text

    def close(self) -> None:
        return None


def test_the_decoded_input_is_capped_at_10_mib_at_a_character() -> None:
    """``errors="replace"`` can turn 10 MiB into 30 MiB. The child
    sends at most the cap plus a slack and says it was longer; the service
    scrubs, then cuts at the cap, at a character."""
    text = "\ufffd" * (4 * 1024 * 1024)  # 12 MiB of UTF-8
    strategy = Strategy(text="", executor=_Decoded(text))  # type: ignore[arg-type]

    sent = run_module._decoded_input(strategy, Scrub())
    answered = runner._scrubbed_file(sent, Scrub(), output=False)

    sent_data = base64.b64decode(sent["base64"])
    assert sent["truncated"] is True
    assert MAX_DECODED_INPUT_BYTES < len(sent_data) <= MAX_DECODED_INPUT_BYTES + run_module.DECODED_INPUT_SLACK_BYTES
    data = base64.b64decode(answered["base64"])
    assert answered["truncated"] is True
    assert len(data) == MAX_DECODED_INPUT_BYTES - MAX_DECODED_INPUT_BYTES % 3
    assert data.decode("utf-8") == "\ufffd" * (len(data) // 3)


def test_a_decoded_input_within_the_cap_is_whole() -> None:
    strategy = Strategy(text="", executor=_Decoded('{"a":"é"}'))  # type: ignore[arg-type]

    assert run_module._decoded_input(strategy, Scrub()) == {
        "base64": base64.b64encode('{"a":"é"}'.encode()).decode(),
        "truncated": False,
    }


async def test_a_syslog_push_that_cant_connect_fails_the_run_with_its_reason(tmp_path: Path) -> None:
    strategy = SyslogPushStrategy()
    strategy.port = 1  # nothing listens there
    context = type("Context", (), {"cached_fixture": tmp_path / "input.raw"})()
    (tmp_path / "input.raw").write_bytes(b"<34>1 - - - - - - x\n")

    with pytest.raises(FeedFailed, match="^the input could not be sent to the collector's syslog listener$"):
        await strategy.feed(context, None)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Filelog (and syslog) wait for kwok's informer as OTLP runs do
# ---------------------------------------------------------------------------

K8S_PROCESSORS = "processors:\n  k8sattributes: {auth_type: serviceAccount}\n"
FILELOG_K8S = (
    "receivers:\n  filelog: {include: [/var/log/x.log], operators: [{type: noop}]}\n"
    + K8S_PROCESSORS
    + "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [filelog], processors: [k8sattributes], exporters: [debug]}\n"
)
SYSLOG_K8S = (
    "receivers:\n  syslog: {tcp: {listen_address: '0.0.0.0:514'}, protocol: rfc5424}\n"
    + K8S_PROCESSORS
    + "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [syslog], processors: [k8sattributes], exporters: [debug]}\n"
)


def _kwok_request(binary_dir: Path, workspace: Path, text: str, data: bytes) -> RunRequest:
    """A run with the cluster up (its endpoint as the service passes it; no
    real cluster: the informer wait's poll is replaced)."""
    workspace.mkdir()
    (workspace / "input.raw").write_bytes(data)
    kubeconfig = workspace.parent / "kwok" / "kubeconfig.yaml"
    kubeconfig.parent.mkdir()
    kubeconfig.write_text("apiVersion: v1\n")
    return RunRequest(
        binary=binary_path(binary_dir, VERSION),
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=1,
        version=VERSION,
        workspace=workspace,
        kubeconfig=str(kubeconfig),
        apiserver_url="https://127.0.0.1:1",
        seed_pod_uid="0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d",
    )


@pytest.mark.parametrize(
    ("text", "data", "kind"),
    [
        (FILELOG_K8S, b"first line\nsecond line\n", "filelog"),
        (SYSLOG_K8S, b"<34>1 2026-01-01T00:00:00Z h a - - - first line\n", "syslog"),
    ],
)
def test_a_run_with_a_kubernetes_processor_feeds_only_after_the_informer_wait(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str, data: bytes, kind: str
) -> None:
    """When the informer wait runs, the collector is ready and has been fed
    nothing (filelog's input isn't staged yet; nothing was pushed); once it
    is over, the input is fed and reaches the output."""
    write_fake_collector(binary_dir, VERSION)
    workspace = tmp_path / "workspace"
    request = _kwok_request(binary_dir, workspace, text, data)
    seen: list[dict] = []

    async def listable(apiserver_url: str, namespace: str, pod: str, **kwargs: object) -> bool:
        staged = [path for path in workspace.rglob("*") if path.is_file() and path.name not in ("input.raw", "config.yaml")]
        seen.append({"url": apiserver_url, "pod": (namespace, pod), "fed": staged})
        return True

    monkeypatch.setattr(_shared, "_wait_for_pod_listable", listable)

    answer = guard.in_thread(lambda: execute(request))

    assert answer["status"] == "succeeded", answer.get("error")
    assert (answer["strategy"], answer["kwokEnabled"]) == (kind, True)
    assert seen == [{"url": "https://127.0.0.1:1", "pod": ("demo", "telflo-test-pod"), "fed": []}]
    assert answer["timings"]["informerMs"] is not None
    records = json.loads(base64.b64decode(answer["output"]["base64"]))
    records = records["records"] if "records" in records else [records]
    assert len(records) == len(data.splitlines())


def test_filelog_without_a_kubernetes_processor_stages_before_the_collector_starts(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No Kubernetes processor (the cluster up or not): no informer wait, and
    the input is staged before the spawn, as before."""
    write_fake_collector(binary_dir, VERSION, prelude="assert os.path.exists(os.path.join(os.getcwd(), 'input.log'))\n")
    text = FILELOG_K8S.replace(K8S_PROCESSORS, "").replace("processors: [k8sattributes], ", "")

    async def listable(*args: object, **kwargs: object) -> bool:
        raise AssertionError("no informer wait without a Kubernetes processor")

    monkeypatch.setattr(_shared, "_wait_for_pod_listable", listable)
    answer = guard.in_thread(lambda: execute(_kwok_request(binary_dir, tmp_path / "workspace", text, b"a line\n")))

    assert answer["status"] == "succeeded", answer.get("error")
    assert (answer["kwokEnabled"], answer["timings"]["informerMs"]) == (False, None)


def test_a_deferred_filelog_input_is_written_whole_then_renamed_into_place(tmp_path: Path) -> None:
    from app.executors.base import ExecutorContext, KwokEndpoint
    from app.executors.filelog_pull import STAGING_TEMPORARY_NAME, FilelogPullStrategy
    from app.run_workspace import RunWorkspace

    root = tmp_path / "workspace"
    root.mkdir()
    (root / "input.raw").write_bytes(b"one\ntwo\n")
    text = FILELOG_K8S.replace("operators: [{type: noop}]", "operators: [{type: container}]")
    context = ExecutorContext(
        yaml_config=text,
        signal_type="logs",
        cached_fixture=root / "input.raw",
        run_workspace=RunWorkspace.existing(root),
        binary=tmp_path / "otelcol-contrib",
        duration_seconds=1,
        kwok_cluster=KwokEndpoint(kubeconfig_path=tmp_path / "kubeconfig.yaml", seed_pod_uid="uid-1"),
        max_output_bytes=1024,
        target_pipeline="logs",
    )
    strategy = FilelogPullStrategy()

    mutated, _ = strategy.prepare(context)
    staged = strategy.staged
    assert staged is not None and strategy.deferred is True
    assert staged.parent.is_dir() and not staged.exists()
    assert f"- {staged}" in mutated or str(staged) in mutated
    assert STAGING_TEMPORARY_NAME not in mutated

    asyncio.run(strategy.feed(context, None))

    assert staged.read_bytes() == b"one\ntwo\n"
    assert "uid-1" in str(staged)
    assert not (root / STAGING_TEMPORARY_NAME).exists()


# ---------------------------------------------------------------------------
# No path outside the run's workspace survives the mutations
# ---------------------------------------------------------------------------

ELSEWHERE = (
    "/run/secrets/otelcol_testing_secret",
    "/tmp/otelcol-run-another/output.data",
    "/home/otelcol-testing/.kwok/clusters/telflo-test/pki/admin.key",
)

# The processors that could reach out: R-106 strips resourcedetection's
# consul, openshift and docker detectors with their settings (either spelling
# of the processor). A processor setting that names a file is refused before
# any of this (C-006, below and in `tests/test_file_reading_components.py`),
# as are geoip, schema and remotetap (C-005). The others hold no path.
PROCESSORS = (
    "processors:\n"
    "  resource_detection:\n"
    "    detectors: [env, consul, openshift]\n"
    "    consul: {{address: 'http://127.0.0.1:20001'}}\n"
    "    openshift: {{address: 'https://127.0.0.1:20002'}}\n"
    "  resourcedetection/only:\n"
    "    detectors: [docker, consul]\n"
    "    consul: {{datacenter: dc1}}\n"
    "    docker: {{}}\n"
    "  resourcedetection/unused:\n"
    "    detectors: [system]\n"
    "    openshift: {{address: 'https://127.0.0.1:20003'}}\n"
    "  batch: {{}}\n"
)
# A relative path out of the workspace and a file: URI never survive either.
RELATIVE = "../../run/secrets/otelcol_testing_secret"
FILE_URI = "file:///run/secrets/otelcol_testing_secret"
CHAIN = "processors: [resource_detection, resourcedetection/only, resourcedetection/unused, batch], "

PATHS_EVERYWHERE = {
    "otlp": (
        "receivers:\n"
        "  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\n"
        "        tls: {{cert_file: {secret}, key_file: {key}}}\n"
        "  filelog/unused: {{include: [{secret}, " + RELATIVE + "]}}\n"
        + PROCESSORS
        + "exporters:\n  file: {{path: {other}}}\n  otlp: {{endpoint: x:4317, tls: {{ca_file: {secret}}}}}\n"
        "  file/rel: {{path: " + RELATIVE + "}}\n  otlphttp: {{endpoint: '" + FILE_URI + "'}}\n"
        "extensions:\n  file_storage: {{directory: {key}}}\n"
        "connectors:\n  forward: {{}}\n"
        "service:\n  extensions: [file_storage]\n"
        "  telemetry: {{logs: {{output_paths: [{other}], error_output_paths: [{secret}]}}}}\n"
        "  pipelines:\n"
        "    logs: {{receivers: [otlp], " + CHAIN + "exporters: [file, otlp, file/rel, otlphttp]}}\n"
        "    logs/2: {{receivers: [filelog/unused], exporters: [file]}}\n"
    ),
    "filelog": (
        "receivers:\n"
        "  filelog:\n    include: [{secret}, {other}, " + RELATIVE + ", '" + FILE_URI + "']\n    exclude: [{key}]\n    storage: file_storage\n"
        "    operators: [{{type: noop}}]\n"
        + PROCESSORS
        + "exporters:\n  file: {{path: {other}}}\n"
        "extensions:\n  file_storage: {{directory: {key}}}\n"
        "service:\n  extensions: [file_storage]\n  pipelines:\n"
        "    logs: {{receivers: [filelog], " + CHAIN + "exporters: [file]}}\n"
    ),
    "syslog": (
        "receivers:\n"
        "  syslog:\n    protocol: rfc5424\n    tcp:\n      listen_address: 0.0.0.0:514\n"
        "      tls: {{cert_file: {secret}, key_file: " + RELATIVE + "}}\n"
        + PROCESSORS
        + "exporters:\n  file: {{path: '" + FILE_URI + "'}}\n"
        "service:\n  telemetry: {{logs: {{output_paths: [" + RELATIVE + "]}}}}\n  pipelines:\n"
        "    logs: {{receivers: [syslog], " + CHAIN + "exporters: [file]}}\n"
    ),
}


def _strings(value: object) -> list[str]:
    if isinstance(value, dict):
        return [s for key, item in value.items() for s in (*_strings(key), *_strings(item))]
    if isinstance(value, list):
        return [s for item in value for s in _strings(item)]
    return [value] if isinstance(value, str) else []


@pytest.mark.parametrize("kind", sorted(PATHS_EVERYWHERE))
def test_no_path_outside_the_workspace_survives_the_mutations(binary_dir: Path, tmp_path: Path, kind: str) -> None:
    """Every receiver, exporter, extension and connector the collector runs,
    and its own telemetry, are the sandbox's, and no processor that survives
    names a file: the only paths left are in the run's own workspace (never
    the secret's file, kwok's certificates or another run's directory), and
    no relative path climbing out or file: URI is left."""
    secret, other, key = ELSEWHERE
    text = PATHS_EVERYWHERE[kind].format(secret=secret, other=other, key=key)
    workspace = tmp_path / "workspace"
    request = _request(binary_dir, workspace, text, b"a line\n")

    prepared = run_module._prepare_strategy(request, text)
    try:
        assert isinstance(prepared, Strategy), prepared
        assert prepared.name == kind
        mutated = YAML(typ="safe").load(prepared.text)
    finally:
        if isinstance(prepared, Strategy):
            prepared.close()

    assert set(mutated["processors"]) == {"resource_detection", "resourcedetection/unused", "batch"}
    assert mutated["service"]["pipelines"]["logs"]["processors"] == [
        "resource_detection",
        "resourcedetection/unused",
        "batch",
    ]
    for section in ("receivers", "processors", "exporters", "extensions", "connectors", "service"):
        for value in _strings(mutated.get(section) or {}):
            if value.startswith("/"):
                assert Path(value).resolve().is_relative_to(workspace.resolve()), (section, value)
            # Nor a relative path climbing out, nor a file: URI.
            assert "../" not in value and not value.startswith(".."), (section, value)
            assert not value.lower().startswith("file:"), (section, value)
    assert not any(path in prepared.text for path in (*ELSEWHERE, RELATIVE, FILE_URI))


FILE_NAMING_PROCESSORS = {
    "resource_detection's tls": "  resource_detection:\n    detectors: [env]\n    tls: {{ca_file: {secret}}}\n",
    # Refused though R-106 would strip them.
    "consul's token_file": "  resourcedetection:\n    detectors: [env, consul]\n    consul: {{token_file: {secret}}}\n",
    "openshift's tls": "  resource_detection/o:\n    detectors: [openshift]\n    openshift: {{tls: {{ca_file: {other}, key_file: {key}}}}}\n",
    "a key in a list": "  attributes:\n    actions: [{{key: a, action: insert, value: b}}, {{token_file: {secret}}}]\n",
    # Refused outright (C-005), its tls with it.
    "schema's tls": "  schema:\n    tls: {{cert_file: {other}, key_file: {key}}}\n",
    "remotetap's tls": "  remotetap:\n    tls: {{client_ca_file: {secret}}}\n",
}
REFUSED_AS = {"schema's tls": "C-005", "remotetap's tls": "C-005"}


@pytest.mark.parametrize("case", sorted(FILE_NAMING_PROCESSORS))
def test_a_processor_setting_that_names_a_file_never_reaches_the_collector(
    binary_dir: Path, tmp_path: Path, case: str
) -> None:
    """Whatever survives the mutations names no file. A processor setting
    that does is refused (C-006; C-005 for a processor refused outright)
    before any text is written for the collector."""
    secret, other, key = ELSEWHERE
    name = FILE_NAMING_PROCESSORS[case].split(":", 1)[0].strip()
    text = (
        "receivers:\n  otlp: {protocols: {http: {}}}\n"
        "processors:\n" + FILE_NAMING_PROCESSORS[case].format(secret=secret, other=other, key=key)
        + "exporters:\n  debug: {}\n"
        "service:\n  pipelines:\n"
        f"    logs: {{receivers: [otlp], processors: [{name}], exporters: [debug]}}\n"
    )
    request = _request(binary_dir, tmp_path / "workspace", text, b'{"resourceLogs":[]}')

    prepared = run_module._prepare_strategy(request, text)
    if isinstance(prepared, Strategy):
        try:
            survived = [path for path in ELSEWHERE if path in prepared.text]
        finally:
            prepared.close()
        assert survived == [], f"survived the mutations: {survived}"
    assert prepared.code == "refused"
    assert {issue["id"] for issue in prepared.compatibility} == {REFUSED_AS.get(case, "C-006")}
    assert not any(path in prepared.message for path in ELSEWHERE)


# ---------------------------------------------------------------------------
# The file-settings check again, on the exact text each collector
# reads, beside the backstop
# ---------------------------------------------------------------------------

SYSLOG_TEXT = (
    "receivers:\n  syslog: {tcp: {listen_address: '0.0.0.0:514'}, protocol: rfc5424}\n"
    "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [syslog], exporters: [debug]}\n"
)
FILELOG_TEXT = (
    "receivers:\n  filelog: {include: [/var/log/x.log], operators: [{type: noop}]}\n"
    "exporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    logs: {receivers: [filelog], exporters: [debug]}\n"
)
STRATEGY_TEXTS = {
    "otlp": (OTLP_LOGS, LOGS),
    "filelog": (FILELOG_TEXT, b"a line\n"),
    "syslog": (SYSLOG_TEXT, b"<34>1 2026-01-01T00:00:00Z h a - - - a line\n"),
}
# Where each strategy takes its mutations from (the name its module imports).
MUTATION_SOURCES = {
    "otlp": ("app.executors.otlp_replay", "mutate_for_otlp_replay"),
    "filelog": ("app.executors.filelog_pull", "mutate_for_operator_test"),
    "syslog": ("app.executors.syslog_push", "mutate_for_operator_test"),
}


@pytest.mark.parametrize("kind", sorted(STRATEGY_TEXTS))
def test_the_final_check_reads_the_exact_text_each_strategys_collector_reads(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    from app import compatibility

    write_fake_collector(binary_dir, VERSION)
    checked: list[str] = []
    real = compatibility.final_file_settings

    def recording(text: str):  # noqa: ANN202
        checked.append(text)
        return real(text)

    monkeypatch.setattr(compatibility, "final_file_settings", recording)
    text, data = STRATEGY_TEXTS[kind]
    workspace = tmp_path / "workspace"

    answer = guard.in_thread(lambda: execute(_request(binary_dir, workspace, text, data)))

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == kind
    assert checked == [(workspace / "config.yaml").read_text(encoding="utf-8")]


@pytest.mark.parametrize("kind", sorted(STRATEGY_TEXTS))
def test_a_file_setting_a_mutation_reintroduces_is_refused_at_the_final_check(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A test double of the strategy's mutations puts a processor naming the
    secret's file into the text after every earlier check has passed: the
    final check refuses the run (C-006, the processor and the key only), and
    no collector starts."""
    import importlib

    import yaml

    started = tmp_path / "started"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(started)!r}, 'w').close()\n")
    module_name, function = MUTATION_SOURCES[kind]
    module = importlib.import_module(module_name)
    real = getattr(module, function)

    def reintroducing(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        mutated, advisories = real(*args, **kwargs)
        doc = yaml.safe_load(mutated)
        doc.setdefault("processors", {})["resource_detection/back"] = {
            "detectors": ["env"],
            "tls": {"ca_file": ELSEWHERE[0]},
        }
        for pipeline in doc["service"]["pipelines"].values():
            pipeline["processors"] = [*(pipeline.get("processors") or []), "resource_detection/back"]
        return yaml.safe_dump(doc), advisories

    monkeypatch.setattr(module, function, reintroducing)
    text, data = STRATEGY_TEXTS[kind]
    workspace = tmp_path / "workspace"

    answer = guard.in_thread(lambda: execute(_request(binary_dir, workspace, text, data)))

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert answer["error"]["message"].startswith("sandbox refused to run pipeline: C-006 resource_detection/back: ")
    assert [(issue["id"], issue["details"]) for issue in answer["compatibility"]] == [
        ("C-006", {"processor": "resource_detection/back", "key": "tls.ca_file"})
    ]
    assert not started.exists()
    assert not (workspace / "config.yaml").exists()
    assert ELSEWHERE[0] not in json.dumps(answer)


# A final text that composes but doesn't construct (a custom tag,
# an unhashable key, an ill-fitting explicit tag) is read by the collector all
# the same; the final check walks the composed graph, so a re-introduced file
# setting beside any of them is still refused.
def _tagged(value: str, tag: str):  # noqa: ANN202
    from ruamel.yaml.comments import TaggedScalar

    return TaggedScalar(value=value, tag=tag)


def _custom_tag(processor) -> None:  # noqa: ANN001
    processor["note"] = _tagged("b", "!foo")


def _unhashable_key(processor) -> None:  # noqa: ANN001
    from ruamel.yaml import YAML

    processor.update(YAML().load("? [a]\n: b\n"))


def _ill_fitting_tag(processor) -> None:  # noqa: ANN001
    processor["note"] = _tagged("abc", "tag:yaml.org,2002:int")


UNCONSTRUCTABLE_SHAPES = {
    "a custom tag": (_custom_tag, "!foo b"),
    "an unhashable key": (_unhashable_key, "[a]: b"),
    "an ill-fitting explicit tag": (_ill_fitting_tag, "!!int 'abc'"),
}


@pytest.mark.parametrize("shape", sorted(UNCONSTRUCTABLE_SHAPES))
@pytest.mark.parametrize("kind", sorted(STRATEGY_TEXTS))
def test_a_reintroduced_file_setting_beside_an_unconstructable_shape_is_refused(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, shape: str
) -> None:
    """The test double (ruamel round-trip, so the tag survives) adds a
    processor holding ``tls.ca_file`` and the shape: the final check, on the
    composed graph, refuses the run; no collector starts, no config.yaml is
    written, and the path is nowhere in the answer."""
    import importlib
    import io

    from ruamel.yaml import YAML

    from app import bounded_yaml

    started = tmp_path / "started"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(started)!r}, 'w').close()\n")
    module_name, function = MUTATION_SOURCES[kind]
    module = importlib.import_module(module_name)
    real = getattr(module, function)
    add_shape, spelled = UNCONSTRUCTABLE_SHAPES[shape]
    written: list[str] = []

    def reintroducing(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        mutated, advisories = real(*args, **kwargs)
        yaml = YAML()
        doc = yaml.load(mutated)
        processor = yaml.load(f"detectors: [env]\ntls: {{ca_file: {ELSEWHERE[0]}}}\n")
        add_shape(processor)
        if doc.get("processors") is None:
            doc["processors"] = {}
        doc["processors"]["resource_detection/back"] = processor
        for pipeline in doc["service"]["pipelines"].values():
            pipeline["processors"] = [*(pipeline.get("processors") or []), "resource_detection/back"]
        out = io.StringIO()
        yaml.dump(doc, out)
        written.append(out.getvalue())
        return out.getvalue(), advisories

    monkeypatch.setattr(module, function, reintroducing)
    text, data = STRATEGY_TEXTS[kind]
    workspace = tmp_path / "workspace"

    answer = guard.in_thread(lambda: execute(_request(binary_dir, workspace, text, data)))

    # The double's text has the shape, composes, and doesn't construct.
    [final] = written
    assert spelled in final
    bounded_yaml.single_node(final)
    with pytest.raises(bounded_yaml.YAMLError):
        bounded_yaml.safe_load(final)
    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert ("C-006", {"processor": "resource_detection/back", "key": "tls.ca_file"}) in [
        (issue["id"], issue["details"]) for issue in answer["compatibility"]
    ]
    assert not started.exists()
    assert not (workspace / "config.yaml").exists()
    assert ELSEWHERE[0] not in json.dumps(answer)


def test_a_read_failure_at_the_final_check_refuses_the_run(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Were the backstop ever to let through a text its reader can't
    compose, the final check refuses it (C-000, ``unreadable``), never lets
    it run: here the backstop is replaced and the mutations end with an
    unclosed flow sequence."""
    import importlib

    started = tmp_path / "started"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(started)!r}, 'w').close()\n")
    module = importlib.import_module("app.executors.otlp_replay")
    real = module.mutate_for_otlp_replay

    def broken(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        mutated, advisories = real(*args, **kwargs)
        return mutated + "processors_tail: [unclosed\n", advisories

    monkeypatch.setattr(module, "mutate_for_otlp_replay", broken)
    monkeypatch.setattr(run_module, "backstop", lambda text, schemes: None)
    workspace = tmp_path / "workspace"

    answer = guard.in_thread(lambda: execute(_request(binary_dir, workspace, OTLP_LOGS, LOGS)))

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "unreadable"
    assert [issue["id"] for issue in answer["compatibility"]] == ["C-000"]
    assert answer["error"]["message"].startswith("could not parse YAML: ")
    assert not started.exists()
    assert not (workspace / "config.yaml").exists()


# ---------------------------------------------------------------------------
# The distribution and version
# ---------------------------------------------------------------------------


def test_contrib_runs_the_requested_versions_binary(binary_dir: Path, tmp_path: Path) -> None:
    """Contrib uses the requested version: the version picks
    ``<binary dir>/v<version>/otelcol-contrib`` and nothing else."""
    record = tmp_path / "ran"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(record)!r}, 'w').write(sys.argv[0])\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = _post(client, yaml=OTLP_LOGS).json()

    assert answer["collectorVersion"] == VERSION
    assert Path(record.read_text()) == binary_path(binary_dir, VERSION)


def test_a_version_is_required_there_is_no_default(client: TestClient) -> None:
    """There is no default version: the platform always pins one."""
    body = run_body()
    del body["version"]

    resp = client.post(RUNS_URL, json=body, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize("distribution", ["clickstack", "", "bogus-distro", None])
def test_clickstack_and_every_other_distribution_are_refused_at_the_contract(client: TestClient, distribution: object) -> None:
    """The platform offers contrib only."""
    resp = _post(client, distribution=distribution)

    assert resp.status_code == 400
    assert resp.json() == {"error": {"code": "invalid_request", "message": "`distribution` must be otelcol-contrib."}}


def test_the_contract_names_contrib_as_the_only_distribution() -> None:
    import yaml

    spec = yaml.safe_load((Path(__file__).resolve().parents[1] / "openapi.yaml").read_text())
    assert spec["components"]["schemas"]["RunRequest"]["properties"]["distribution"] == {"const": "otelcol-contrib"}
    assert json.dumps(spec).count("clickstack") == 0
