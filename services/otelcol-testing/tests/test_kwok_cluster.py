"""kwok's fake cluster.

Unmarked: the baked kwokctl configuration and how ``KwokCluster`` uses it
(``-c`` on every kwokctl call, ``--timeout 60s``, no kubectl cache seeded),
every command bounded and given only the allowlisted environment, and a
failed start cleaned up. kwok's binaries are fakes here.

Marked ``kwok`` (deselected by default; run in the image, as uid 10001, with
no network and a read-only root): the cluster's lifecycle (3) and the
end-to-end gate (1), on the image's binaries and configuration. They never
skip: in the image, everything they need is there.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from textwrap import dedent

import pytest
import yaml

from app import kwok_cluster as kc_module
from app.kwok_binary import FilesystemKwokBinaries, KwokBinaries
from app.kwok_cluster import (
    CREATE_COMMAND_TIMEOUT_SECONDS,
    DEFAULT_KWOKCTL_CONFIG,
    SEED_MANIFEST,
    KwokCluster,
    _default_runtime,
    _run,
    start_from_environment,
)
from tests import guard

# ---------------------------------------------------------------------------
# The baked configuration
# ---------------------------------------------------------------------------


def test_the_kwokctl_configuration_pins_the_version_the_address_and_the_images_binaries() -> None:
    config = yaml.safe_load(DEFAULT_KWOKCTL_CONFIG.read_text())

    assert config["kind"] == "KwokctlConfiguration"
    assert config["apiVersion"] == "config.kwok.x-k8s.io/v1alpha1"
    assert config["options"] == {
        "kubeVersion": "v1.31.6",
        "bindAddress": "127.0.0.1",
        "kubectlBinary": "/opt/kwok/v0.7.0/kubectl",
        "kubeApiserverBinary": "/opt/kwok/v0.7.0/kube-apiserver",
        "etcdBinary": "/opt/kwok/v0.7.0/etcd",
        "kwokControllerBinary": "/opt/kwok/v0.7.0/kwok",
    }
    assert config["componentsPatches"] == [
        {"name": "kube-apiserver", "extraArgs": [{"key": "advertise-address", "value": "127.0.0.1"}]}
    ]
    assert SEED_MANIFEST.is_file()


def _binaries(directory: Path) -> KwokBinaries:
    return KwokBinaries(
        version="0.7.0",
        kwok=directory / "kwok",
        kwokctl=directory / "kwokctl",
        kubectl=directory / "kubectl",
        etcd=directory / "etcd",
        kube_apiserver=directory / "kube-apiserver",
    )


@pytest.fixture
def kwok_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


def _fake_kwok(monkeypatch: pytest.MonkeyPatch, home: Path, *, fail_create: bool = False) -> list[tuple[list[str], float | None]]:
    """kwokctl and kubectl as a fake ``_run``: create writes the kubeconfig
    where kwokctl does; every kubectl call succeeds (the uid reads answer
    one). Records each command and its timeout."""
    calls: list[tuple[list[str], float | None]] = []

    async def fake_run(cmd: list[str], *, timeout: float | None = None):
        calls.append((cmd, timeout))
        if "create" in cmd and "cluster" in cmd:
            if fail_create:
                return 1, "", "kwokctl: it broke"
            name = cmd[cmd.index("--name") + 1]
            kubeconfig = home / ".kwok" / "clusters" / name / "kubeconfig.yaml"
            kubeconfig.parent.mkdir(parents=True)
            kubeconfig.write_text("clusters:\n- cluster:\n    server: https://127.0.0.1:32766\n")
            return 0, "", ""
        if "jsonpath={.metadata.uid}" in cmd:
            return 0, "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d", ""
        return 0, "", ""

    monkeypatch.setattr(kc_module, "_run", fake_run)
    return calls


async def test_every_kwokctl_call_carries_the_configuration_and_create_its_timeout(
    tmp_path: Path, kwok_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _fake_kwok(monkeypatch, kwok_home)
    config = tmp_path / "kwokctl.yaml"
    cluster = KwokCluster(
        binaries=_binaries(tmp_path),
        cluster_name="telflo-test",
        runtime="binary",
        seed_manifest=SEED_MANIFEST,
        config=config,
    )

    await cluster.start()
    await cluster.stop()

    kwokctl = [cmd for cmd, _ in calls if cmd[0].endswith("kwokctl")]
    assert [cmd[3:5] for cmd in kwokctl] == [["delete", "cluster"], ["create", "cluster"], ["delete", "cluster"]]
    assert all(cmd[1:3] == ["-c", str(config)] for cmd in kwokctl)
    [(create, timeout)] = [(cmd, t) for cmd, t in calls if "create" in cmd]
    assert create[create.index("--timeout") + 1] == "60s"
    assert timeout == CREATE_COMMAND_TIMEOUT_SECONDS
    assert "--disable" in create and "kube-controller-manager" in create and "kube-scheduler" in create


async def test_no_kubectl_cache_is_seeded_and_the_cluster_says_where_its_certificates_are(
    tmp_path: Path, kwok_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_kwok(monkeypatch, kwok_home)
    cluster = KwokCluster(binaries=_binaries(tmp_path), cluster_name="telflo-test", runtime="binary", seed_manifest=SEED_MANIFEST)

    await cluster.start()

    assert not (kwok_home / ".kwok" / "cache").exists()
    assert cluster.kubeconfig == cluster.kubeconfig_path == kwok_home / ".kwok" / "clusters" / "telflo-test" / "kubeconfig.yaml"
    assert cluster.pki_dir == kwok_home / ".kwok" / "clusters" / "telflo-test" / "pki"
    assert cluster.apiserver_url == "https://127.0.0.1:32766"
    assert cluster.seed_pod_uid == "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
    assert not hasattr(cluster, "_seed_kubectl_cache")


async def test_a_failed_start_from_the_environment_removes_what_it_began(
    tmp_path: Path, kwok_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _fake_kwok(monkeypatch, kwok_home, fail_create=True)
    binaries = tmp_path / "kwok-binaries"
    for name in ("kwok", "kwokctl", "kubectl", "etcd", "kube-apiserver"):
        path = binaries / "v0.7.0" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
    config = tmp_path / "kwokctl.yaml"
    monkeypatch.setenv("KWOK_BINARY_DIR", str(binaries))
    monkeypatch.setenv("KWOKCTL_CONFIG", str(config))

    with pytest.raises(RuntimeError, match="kwokctl create cluster failed"):
        await start_from_environment()

    kwokctl = [cmd for cmd, _ in calls if cmd[0].endswith("kwokctl")]
    assert kwokctl[0][0] == str(binaries / "v0.7.0" / "kwokctl")
    assert [cmd[3] for cmd in kwokctl] == ["delete", "create", "delete"]  # the last removes the failed start
    assert all(cmd[1:3] == ["-c", str(config)] for cmd in kwokctl)


def test_the_starter_defaults_to_the_images_layout() -> None:
    assert kc_module.kwok_binary_dir({}) == Path("/opt/kwok")
    assert kc_module.kwokctl_config({}) == DEFAULT_KWOKCTL_CONFIG
    assert kc_module.kwok_binary_dir({"KWOK_BINARY_DIR": "/x"}) == Path("/x")


# ---------------------------------------------------------------------------
# Every command bounded, with the allowlisted environment only
# ---------------------------------------------------------------------------


def _running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def test_a_command_past_its_timeout_is_killed_with_its_process_group(tmp_path: Path) -> None:
    """Without a timeout, a kwokctl that hung would hang the start. A
    command (and what it started) is killed at its timeout, and
    fails."""
    record = tmp_path / "children"
    command = ["/bin/sh", "-c", f"sleep 600 & echo $! > {record}.part; mv {record}.part {record}; exec sleep 600"]

    async def scenario():
        return await _run(command, timeout=0.5)

    result = guard.in_thread(scenario)

    assert result == (-1, "", "timed out after 0.5 s")
    assert not _running(int(record.read_text()))


def test_a_command_gets_only_the_allowlisted_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """A kwok command never inherits the whole environment."""
    monkeypatch.setenv("SOME_TOKEN_FOR_THE_TEST", "do-not-pass-it-on")
    monkeypatch.setenv("LANG", "C.UTF-8")

    async def scenario():
        return await _run(["/usr/bin/env"])

    returncode, stdout, _ = guard.in_thread(scenario)

    names = {line.split("=", 1)[0] for line in stdout.splitlines()}
    assert returncode == 0
    assert "SOME_TOKEN_FOR_THE_TEST" not in names
    assert "LANG" in names


# ---------------------------------------------------------------------------
# kwok-marked: the lifecycle tests (3) and the end-to-end gate (1),
# on the image's binaries
# ---------------------------------------------------------------------------


def _image_cluster(name: str) -> KwokCluster:
    binaries = FilesystemKwokBinaries(kc_module.kwok_binary_dir()).resolve(kc_module.KWOK_VERSION)
    return KwokCluster(
        binaries=binaries,
        cluster_name=name,
        runtime=_default_runtime(),
        seed_manifest=SEED_MANIFEST,
        config=kc_module.kwokctl_config(),
    )


@pytest.mark.kwok
async def test_kwok_cluster_lifecycle_seeds_fixture_pod() -> None:
    """End-to-end: start the cluster, fetch the seeded pod via the
    apiserver, stop. The seeded pod must come back with podIP=127.0.0.1 (so
    k8sattributes' `from: connection` association finds it) and the full
    Deployment/ReplicaSet owner chain."""
    cluster = _image_cluster(f"telflo-pytest-{uuid.uuid4().hex[:8]}")
    try:
        await cluster.start()
        result = subprocess.run(
            [
                str(cluster.binaries.kubectl),
                "--kubeconfig",
                str(cluster.kubeconfig_path),
                "get",
                "pod",
                "telflo-test-pod",
                "--namespace",
                "demo",
                "-o",
                "json",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
        pod = json.loads(result.stdout)
        assert pod["metadata"]["name"] == "telflo-test-pod"
        assert pod["metadata"]["namespace"] == "demo"
        owner = pod["metadata"]["ownerReferences"][0]
        assert owner["kind"] == "ReplicaSet"
        assert owner["name"] == "telflo-test-deployment-7d8c9"
        status = pod["status"]
        assert status["podIP"] == "127.0.0.1"
        assert status["phase"] == "Running"
        assert status["containerStatuses"][0]["name"] == "app"
        # The apiserver's live uid was read back (not the manifest's).
        assert cluster.seed_pod_uid == pod["metadata"]["uid"]
    finally:
        await cluster.stop()


@pytest.mark.kwok
async def test_kwok_cluster_start_is_idempotent() -> None:
    """Calling start() twice is a no-op the second time, not an error."""
    cluster = _image_cluster(f"telflo-pytest-idem-{uuid.uuid4().hex[:8]}")
    try:
        await cluster.start()
        first_url = cluster.apiserver_url
        await cluster.start()
        assert cluster.apiserver_url == first_url
        assert cluster.is_started
    finally:
        await cluster.stop()


@pytest.mark.kwok
async def test_kwok_cluster_stop_before_start_is_noop() -> None:
    """stop() on a never-started instance must not raise, so the lifespan's
    teardown can be unconditional."""
    cluster = _image_cluster("telflo-never-started")
    await cluster.stop()
    assert not cluster.is_started


# ---------------------------------------------------------------------------
# Liveness
# ---------------------------------------------------------------------------


async def test_a_cluster_that_was_never_started_is_not_alive(tmp_path: Path) -> None:
    cluster = KwokCluster(
        binaries=_binaries(tmp_path), cluster_name="never", runtime="binary", seed_manifest=SEED_MANIFEST
    )

    assert await cluster.is_alive() is False


async def test_an_apiserver_that_refuses_connections_is_not_alive(tmp_path: Path) -> None:
    """Nothing listens on the apiserver's port: the probe retries until its
    limit and says the cluster is dead (here the limit is lowered)."""
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    cluster = KwokCluster(
        binaries=_binaries(tmp_path), cluster_name="dead", runtime="binary", seed_manifest=SEED_MANIFEST
    )
    cluster._started = True
    cluster._kubeconfig_path = tmp_path / "kubeconfig.yaml"
    cluster._apiserver_url = f"https://127.0.0.1:{port}"

    assert await asyncio.wait_for(cluster.is_alive(timeout_seconds=0.2), 30) is False  # a hang guard


@pytest.mark.kwok
async def test_a_started_cluster_is_alive_until_its_apiserver_dies() -> None:
    """The real cluster: alive once started; its kube-apiserver killed, the
    probe says it's dead (the supervisor then fails kwok and the service
    exits)."""
    import psutil

    name = f"telflo-pytest-live-{uuid.uuid4().hex[:8]}"
    cluster = _image_cluster(name)
    try:
        await cluster.start()
        assert await cluster.is_alive() is True

        apiservers = [
            process
            for process in psutil.process_iter(["cmdline"])
            if (process.info["cmdline"] or [""])[0].endswith("kube-apiserver")
            and any(f"/clusters/{name}/" in part for part in process.info["cmdline"])
        ]
        assert len(apiservers) == 1, apiservers
        apiservers[0].kill()
        apiservers[0].wait(timeout=30)

        assert await cluster.is_alive() is False
    finally:
        await cluster.stop()


# A user's YAML that failed without kwok (the end-to-end gate), trimmed of
# components that aren't load-bearing for this verification.
_USER_FAILING_YAML = dedent(
    """
    receivers:
      filelog:
        include: [/var/log/pods/*/*/*.log]
        encoding: utf-8
        start_at: end
    processors:
      memory_limiter:
        limit_mib: 512
        check_interval: 1s
      k8sattributes:
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.node.name
            - k8s.container.name
        auth_type: serviceAccount
        passthrough: false
        pod_association:
          - sources:
              - from: connection
      batch:
        timeout: 200ms
    exporters:
      otlphttp:
        endpoint: http://localhost:4318
    service:
      pipelines:
        logs:
          receivers: [filelog]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlphttp]
    """
).strip()

# Through the service, a filelog receiver picks the filelog strategy (the
# OTLP document read as a line of text), so this text has the user's
# processors behind an OTLP receiver, for the OTLP replay. The text as the
# user wrote it, filelog and all, runs below too
# (``test_users_failing_yaml_runs_as_filelog_after_the_informer_wait``):
# filelog waits for the informer as the replay does.
_USER_FAILING_YAML_REPLAYED = _USER_FAILING_YAML.replace(
    "  filelog:\n    include: [/var/log/pods/*/*/*.log]\n    encoding: utf-8\n    start_at: end\n",
    "  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n",
).replace("receivers: [filelog]", "receivers: [otlp]")
assert "filelog" not in _USER_FAILING_YAML_REPLAYED

_OTLP_LOG_PAYLOAD = (
    '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"telflo-e2e"}}]},'
    '"scopeLogs":[{"scope":{"name":"e2e"},"logRecords":[{"timeUnixNano":"1714000000000000000","severityNumber":9,'
    '"severityText":"INFO","body":{"stringValue":"hello"}}]}]}]}'
)


@pytest.mark.kwok
def test_users_failing_yaml_now_succeeds_with_k8s_attributes(binary_dir: Path) -> None:
    """The end-to-end gate, through the tester: kwok up, the
    ``serviceAccount`` auth rewritten (R-100), the OTLP log replayed from
    127.0.0.1, and the output enriched from the seeded pod. The image's
    first offered collector it holds (test_binary_kwok.py runs every one)."""
    from fastapi.testclient import TestClient

    from app.catalog import Catalog, binary_path
    from app.kwok import KwokState
    from app.main import DISTRIBUTION, create_app
    from tests.conftest import CATALOG_DIR, RUNS_URL, auth_headers, make_settings, run_body

    images_binaries = Path(os.environ.get("OTELCOL_BINARY_DIR", "/opt/otelcol"))
    catalog_dir = Path(os.environ.get("OTELCOL_CATALOG_DIR", str(CATALOG_DIR)))
    version = next(
        v for v in Catalog.load(catalog_dir).offered_versions(DISTRIBUTION) if binary_path(images_binaries, v).is_file()
    )
    settings = make_settings(images_binaries, catalog_dir=catalog_dir)

    async def scenario():
        def call():
            with TestClient(create_app(settings, kwok_starter=start_from_environment)) as client:
                for _ in range(1_200):  # kwok starts in seconds; a hang guard
                    if client.app.state.kwok.state is not KwokState.STARTING:
                        break
                    time.sleep(0.1)
                assert client.app.state.kwok.state is KwokState.READY
                body = run_body(
                    yaml=_USER_FAILING_YAML_REPLAYED,
                    version=version,
                    input={"base64": base64.b64encode(_OTLP_LOG_PAYLOAD.encode()).decode()},
                )
                return client.post(RUNS_URL, json=body, headers=auth_headers()).json()

        return await asyncio.to_thread(call)

    answer = guard.in_thread(scenario, limit=180)

    assert answer["status"] == "succeeded", answer
    assert answer["kwokEnabled"] is True
    assert "R-100" in [m["id"] for m in answer["mutations"]]
    assert "auth_type: kubeConfig" in answer["mutatedYaml"]
    assert "auth_type: serviceAccount" not in answer["mutatedYaml"]
    assert answer["timings"]["informerMs"] is not None
    record = json.loads(base64.b64decode(answer["output"]["base64"]))
    attributes = {a["key"]: a["value"]["stringValue"] for a in record["resourceLogs"][0]["resource"]["attributes"]}
    assert attributes.get("k8s.namespace.name") == "demo"
    assert attributes.get("k8s.pod.name") == "telflo-test-pod"
    assert attributes.get("k8s.node.name") == "kwok-node-0"
    assert attributes.get("k8s.container.name") == "app"
    assert attributes.get("service.name") == "telflo-e2e"


@pytest.mark.kwok
def test_users_failing_yaml_runs_as_filelog_after_the_informer_wait(binary_dir: Path) -> None:
    """The user's text as written (filelog), through the tester: kwok up,
    R-100 and R-008, the informer waited for before the input was staged, and
    the line read. Its ``pod_association`` is ``from: connection``, the
    sender's address, which a line read from a file doesn't have, so nothing
    associates it with the seeded pod: no k8s.* attribute is added (the
    container operator's enrichment of a file is test_binary_kwok.py's)."""
    from fastapi.testclient import TestClient

    from app.catalog import Catalog, binary_path
    from app.kwok import KwokState
    from app.main import DISTRIBUTION, create_app
    from tests.conftest import CATALOG_DIR, RUNS_URL, auth_headers, make_settings, run_body

    images_binaries = Path(os.environ.get("OTELCOL_BINARY_DIR", "/opt/otelcol"))
    catalog_dir = Path(os.environ.get("OTELCOL_CATALOG_DIR", str(CATALOG_DIR)))
    version = next(
        v for v in Catalog.load(catalog_dir).offered_versions(DISTRIBUTION) if binary_path(images_binaries, v).is_file()
    )
    settings = make_settings(images_binaries, catalog_dir=catalog_dir)

    async def scenario():
        def call():
            with TestClient(create_app(settings, kwok_starter=start_from_environment)) as client:
                for _ in range(1_200):  # kwok starts in seconds; a hang guard
                    if client.app.state.kwok.state is not KwokState.STARTING:
                        break
                    time.sleep(0.1)
                assert client.app.state.kwok.state is KwokState.READY
                body = run_body(
                    yaml=_USER_FAILING_YAML,
                    version=version,
                    input={"base64": base64.b64encode(b"order placed\npayment declined\n").decode()},
                )
                return client.post(RUNS_URL, json=body, headers=auth_headers()).json()

        return await asyncio.to_thread(call)

    answer = guard.in_thread(scenario, limit=180)

    assert answer["status"] == "succeeded", answer
    assert answer["strategy"] == "filelog"
    assert answer["kwokEnabled"] is True
    ids = [m["id"] for m in answer["mutations"]]
    assert "R-100" in ids and "R-008" in ids
    assert "auth_type: kubeConfig" in answer["mutatedYaml"]
    assert answer["timings"]["informerMs"] is not None
    document = json.loads(base64.b64decode(answer["output"]["base64"]))
    records = document["records"] if "records" in document else [document]
    bodies = sorted(
        record["body"]["stringValue"]
        for document in records
        for resource in document["resourceLogs"]
        for scope in resource["scopeLogs"]
        for record in scope["logRecords"]
    )
    assert bodies == ["order placed", "payment declined"]
    for document in records:
        for resource in document["resourceLogs"]:
            keys = {a["key"] for a in resource.get("resource", {}).get("attributes", [])}
            assert not any(key.startswith("k8s.") for key in keys), keys
