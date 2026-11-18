"""The seed pod's uid is apiserver-assigned at every boot — the manifest's
pinned value is dead on arrival. These tests pin the read-back path and the
places that must consume the LIVE uid (staging path via test_filelog_staging,
R-008 advisory here). Regression guard for the live incident where
k8sattributes association by k8s.pod.uid silently missed and dropped
deployment/node/annotation enrichment."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app import kwok_cluster as kc_module
from app.kwok_cluster import (
    SEED_CONTAINER_NAME,
    SEED_NAMESPACE,
    SEED_POD_NAME,
    SEED_POD_UID,
    KwokCluster,
)
from app.yaml_mutations import _staged_pod_identity


def _cluster(tmp_path: Path) -> KwokCluster:
    cluster = KwokCluster(
        binaries=SimpleNamespace(kubectl=tmp_path / "kubectl"),  # type: ignore[arg-type]
        cluster_name="test",
        runtime="binary",
        seed_manifest=tmp_path / "seed.yaml",
    )
    cluster._kubeconfig_path = tmp_path / "kubeconfig.yaml"
    return cluster


def test_seed_pod_uid_falls_back_to_constant(tmp_path: Path) -> None:
    assert _cluster(tmp_path).seed_pod_uid == SEED_POD_UID


async def test_read_seed_pod_uid_stores_live_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[list[str]] = []

    async def fake_run(cmd: list[str]):
        seen.append(cmd)
        return (0, "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d\n", "")

    monkeypatch.setattr(kc_module, "_run", fake_run)
    cluster = _cluster(tmp_path)
    await cluster._read_seed_pod_uid()
    assert cluster.seed_pod_uid == "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
    # It asked the apiserver for the seed pod, not something else.
    assert SEED_POD_NAME in seen[0]
    assert SEED_NAMESPACE in seen[0]


async def test_read_seed_pod_uid_failure_keeps_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fail_run(cmd: list[str]):
        return (1, "", "connection refused")

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(kc_module, "_run", fail_run)
    monkeypatch.setattr(kc_module.asyncio, "sleep", no_sleep)
    cluster = _cluster(tmp_path)
    await cluster._read_seed_pod_uid()
    assert cluster.seed_pod_uid == SEED_POD_UID  # degraded, not crashed


async def test_fix_owner_reference_uids_patches_pod_with_live_rs_uid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deployment-name enrichment walks pod.ownerReferences -> ReplicaSet BY
    UID; the manifest's pinned uid is stale after apply, so the pod must be
    patched with the RS's live uid."""
    seen: list[list[str]] = []

    async def fake_run(cmd: list[str]):
        seen.append(cmd)
        if "get" in cmd and "replicaset" in cmd:
            return (0, "feedface-0000-1111-2222-333333333333", "")
        return (0, "", "")

    monkeypatch.setattr(kc_module, "_run", fake_run)
    cluster = _cluster(tmp_path)
    await cluster._fix_owner_reference_uids()
    patch_cmd = seen[-1]
    assert "patch" in patch_cmd and "pod" in patch_cmd
    assert SEED_POD_NAME in patch_cmd
    patch_body = patch_cmd[patch_cmd.index("-p") + 1]
    assert "feedface-0000-1111-2222-333333333333" in patch_body
    assert "/metadata/ownerReferences/0/uid" in patch_body


async def test_fix_owner_reference_uids_degrades_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fail_run(cmd: list[str]):
        return (1, "", "boom")

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(kc_module, "_run", fail_run)
    monkeypatch.setattr(kc_module.asyncio, "sleep", no_sleep)
    cluster = _cluster(tmp_path)
    await cluster._fix_owner_reference_uids()  # must not raise


def test_staged_pod_identity_parses_live_path() -> None:
    path = (
        Path("/runs/x/var/log/pods")
        / f"{SEED_NAMESPACE}_{SEED_POD_NAME}_0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
        / SEED_CONTAINER_NAME
        / "0.log"
    )
    ns, pod, uid, container = _staged_pod_identity(path)
    assert (ns, pod, container) == (SEED_NAMESPACE, SEED_POD_NAME, SEED_CONTAINER_NAME)
    assert uid == "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"


def test_staged_pod_identity_falls_back_on_odd_shapes() -> None:
    # raw_input_path shape (no container segments) → seed constants.
    assert _staged_pod_identity(Path("/runs/x/input.log")) == (
        SEED_NAMESPACE,
        SEED_POD_NAME,
        SEED_POD_UID,
        SEED_CONTAINER_NAME,
    )
    assert _staged_pod_identity(None) == (
        SEED_NAMESPACE,
        SEED_POD_NAME,
        SEED_POD_UID,
        SEED_CONTAINER_NAME,
    )
