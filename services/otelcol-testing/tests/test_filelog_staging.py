"""(``cached_fixture`` is the staged input; ``kwok_cluster`` the cluster's
endpoint, of which only the seed pod's uid is read here.)

Container-runtime staging for filelog operator tests.

A filelog chain with a `container` operator derives pod identity from the
log file's PATH (add_metadata_from_filepath, on by default). Staging the
fixture as a bare `input.log` makes that derivation silently yield nothing,
which starves k8sattributes of association keys — observed live as "the
data was not getting enriched at all". These tests pin the fix: such chains
stage at a container-runtime-shaped path matching the KWOK seed pod.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from app.executors.base import ExecutorContext
from app.executors.filelog_pull import choose_staging_path
from app.kwok_cluster import (
    SEED_CONTAINER_NAME,
    SEED_NAMESPACE,
    SEED_POD_NAME,
    SEED_POD_UID,
)
from app.run_workspace import RunWorkspace
from app.testable_receivers import has_container_operator

_CONTAINER_YAML = """
receivers:
  filelog:
    include: [/var/log/pods/*/*/*.log]
    operators:
      - type: container
        add_metadata_from_filepath: true
processors:
  k8sattributes: {}
exporters:
  otlp: {endpoint: example:4317}
service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [k8sattributes]
      exporters: [otlp]
"""

_PLAIN_YAML = _CONTAINER_YAML.replace(
    "- type: container\n        add_metadata_from_filepath: true",
    "- type: regex_parser\n        regex: '(?P<msg>.*)'",
)


def _ctx(yaml_config: str, tmp_path: Path) -> ExecutorContext:
    return ExecutorContext(
        yaml_config=yaml_config,
        signal_type="logs",
        cached_fixture=tmp_path / "fixture",
        run_workspace=RunWorkspace(uuid4(), tmp_path),
        binary=tmp_path / "otelcol",
        duration_seconds=1,
        kwok_cluster=None,
        max_output_bytes=1024,
        target_pipeline="logs",
    )


def test_has_container_operator() -> None:
    assert has_container_operator({"operators": [{"type": "container"}]})
    assert not has_container_operator({"operators": [{"type": "regex_parser"}]})
    assert not has_container_operator({"operators": []})
    assert not has_container_operator({})
    assert not has_container_operator(None)


def test_container_log_path_encodes_seed_pod_identity(tmp_path: Path) -> None:
    ws = RunWorkspace(uuid4(), tmp_path)
    path = ws.container_log_path()
    assert path.name == "0.log"
    assert path.parent.name == SEED_CONTAINER_NAME
    assert path.parent.parent.name == (
        f"{SEED_NAMESPACE}_{SEED_POD_NAME}_{SEED_POD_UID}"
    )
    assert str(path).startswith(str(ws.root))


def test_container_log_path_takes_live_uid(tmp_path: Path) -> None:
    """The uid segment must be the apiserver-assigned uid, not the pinned
    manifest constant — a stale uid breaks k8sattributes association by
    k8s.pod.uid (observed live: deployment/node/annotation enrichment
    silently missing)."""
    ws = RunWorkspace(uuid4(), tmp_path)
    path = ws.container_log_path("0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d")
    assert path.parent.parent.name == (
        f"{SEED_NAMESPACE}_{SEED_POD_NAME}_0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
    )


class _FakeKwokCluster:
    seed_pod_uid = "11111111-2222-3333-4444-555555555555"


def test_container_chain_stages_at_container_path(tmp_path: Path) -> None:
    ctx = _ctx(_CONTAINER_YAML, tmp_path)
    assert choose_staging_path(ctx) == ctx.run_workspace.container_log_path()


def test_container_chain_uses_cluster_live_uid(tmp_path: Path) -> None:
    ctx = _ctx(_CONTAINER_YAML, tmp_path)
    ctx.kwok_cluster = _FakeKwokCluster()  # type: ignore[assignment]
    assert choose_staging_path(ctx) == ctx.run_workspace.container_log_path(
        _FakeKwokCluster.seed_pod_uid
    )


def test_plain_chain_stages_at_raw_input(tmp_path: Path) -> None:
    ctx = _ctx(_PLAIN_YAML, tmp_path)
    assert choose_staging_path(ctx) == ctx.run_workspace.raw_input_path


def test_unparseable_yaml_falls_back_to_raw_input(tmp_path: Path) -> None:
    ctx = _ctx("receivers: [::bad", tmp_path)
    assert choose_staging_path(ctx) == ctx.run_workspace.raw_input_path
