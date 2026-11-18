"""kwok's manifest (`kwok/binaries.json`) and its downloader
(`scripts/download-kwok.py`), which the image's download stage runs (D14a
spec decision 6, Preflight ruling 19): the manifest, kwokctl's
configuration and the service agree on the version and the layout; the
downloader takes only upstream URLs and 64-hex sha256s for amd64 and arm64,
and copies out of etcd's archive only the one file's bytes. Unmarked: no
network, no binary (the downloader's fetch is a fake here; the image's build
is where the real one runs)."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import stat
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from app import kwok_cluster

SERVICE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((SERVICE_ROOT / "kwok" / "binaries.json").read_text(encoding="utf-8"))
KWOKCTL = yaml.safe_load((SERVICE_ROOT / "kwok" / "kwokctl.yaml").read_text(encoding="utf-8"))


def _load_script():
    spec = importlib.util.spec_from_file_location("download_kwok", SERVICE_ROOT / "scripts" / "download-kwok.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


download_kwok = _load_script()


def test_kwokctls_configuration_names_the_manifests_binaries_and_version() -> None:
    version = MANIFEST["kwokVersion"]
    directory = f"{kwok_cluster.DEFAULT_KWOK_BINARY_DIR}/v{version}"
    options = KWOKCTL["options"]

    assert options["kubeVersion"] == f"v{MANIFEST['kubernetesVersion']}"
    assert options["kubectlBinary"] == f"{directory}/kubectl"
    assert options["kubeApiserverBinary"] == f"{directory}/kube-apiserver"
    assert options["etcdBinary"] == f"{directory}/etcd"
    assert options["kwokControllerBinary"] == f"{directory}/kwok"
    assert kwok_cluster.KWOK_VERSION == version
    assert str(kwok_cluster.DEFAULT_KWOK_BINARY_DIR) == "/opt/kwok"


def test_the_kubernetes_binaries_are_the_configurations_version() -> None:
    by_name = {entry["name"]: entry for entry in MANIFEST["binaries"]}

    assert by_name["kwok"]["version"] == by_name["kwokctl"]["version"] == f"v{MANIFEST['kwokVersion']}"
    assert by_name["kubectl"]["version"] == by_name["kube-apiserver"]["version"] == f"v{MANIFEST['kubernetesVersion']}"
    assert all(entry["license"] == "Apache-2.0" for entry in MANIFEST["binaries"])


@pytest.mark.parametrize("arch", ["amd64", "arm64"])
def test_each_architecture_gets_the_five_binaries_from_upstream(arch: str) -> None:
    version, selected = download_kwok.select(MANIFEST, arch)

    assert version == "0.7.0"
    assert sorted(binary["name"] for binary in selected) == sorted(download_kwok.NAMES)
    for binary in selected:
        assert binary["url"].startswith(download_kwok.UPSTREAMS)
        assert f"linux-{arch}" in binary["url"] or f"/linux/{arch}/" in binary["url"]
        assert "{arch}" not in binary["url"]
        assert len(binary["sha256"]) == 64
    [etcd] = [binary for binary in selected if binary["name"] == "etcd"]
    assert etcd["member"] == f"etcd-v3.5.21-linux-{arch}/etcd"


def test_the_two_architectures_pin_different_files() -> None:
    _, amd64 = download_kwok.select(MANIFEST, "amd64")
    _, arm64 = download_kwok.select(MANIFEST, "arm64")

    assert {b["sha256"] for b in amd64}.isdisjoint({b["sha256"] for b in arm64})


def _broken(change) -> dict:  # noqa: ANN001
    manifest = copy.deepcopy(MANIFEST)
    change(manifest)
    return manifest


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda m: m["binaries"].pop(), "exactly"),
        (lambda m: m["binaries"].append(copy.deepcopy(m["binaries"][0])), "exactly"),
        (lambda m: m["binaries"][0].update(url="https://example.invalid/kwok-linux-{arch}"), "upstream"),
        (lambda m: m["binaries"][0].update(url="http://github.com/kubernetes-sigs/kwok/releases/download/x-{arch}"), "upstream"),
        (lambda m: m["binaries"][2]["sha256"].update(arm64="abc"), "sha256"),
        (lambda m: m["binaries"][2]["sha256"].pop("arm64"), "sha256"),
        (lambda m: m["binaries"][0].update(member="kwok"), ".tar.gz"),
        (lambda m: m.update(kwokVersion="latest"), "kwokVersion"),
    ],
    ids=["a binary missing", "a binary twice", "another host", "plain http", "a short sha256", "no sha256", "a member of a plain file", "no version"],
)
def test_a_manifest_the_build_cant_trust_stops_it(change, message: str) -> None:  # noqa: ANN001
    with pytest.raises(download_kwok.ManifestError, match=message):
        download_kwok.select(_broken(change), "arm64")


@pytest.mark.parametrize("arch", ["386", "riscv64", "", "amd64 "])
def test_another_architecture_stops_the_build(arch: str) -> None:
    with pytest.raises(download_kwok.ManifestError, match="no kwok binaries"):
        download_kwok.select(MANIFEST, arch)


def _archive(path: Path, members: dict[str, bytes | None], *, symlink: str | None = None) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.uid, info.gid, info.mode = 4242, 4242, 0o4777
            if data is None:
                info.type = tarfile.SYMTYPE
                info.linkname = symlink or "/etc/passwd"
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))


def test_only_the_members_bytes_leave_the_archive(tmp_path: Path) -> None:
    archive = tmp_path / "etcd.tar.gz"
    _archive(archive, {"etcd-v3.5.21-linux-arm64/etcd": b"ETCD", "etcd-v3.5.21-linux-arm64/etcdctl": b"CTL", "../escape": b"X"})
    target = tmp_path / "out" / "etcd"
    target.parent.mkdir()

    size = download_kwok.extract_member(archive, "etcd-v3.5.21-linux-arm64/etcd", target)

    assert size == 4 and target.read_bytes() == b"ETCD"
    assert sorted(p.name for p in tmp_path.rglob("*") if p.is_file()) == ["etcd", "etcd.tar.gz"]
    assert not target.stat().st_mode & (stat.S_ISUID | stat.S_IWOTH)


def test_a_member_that_isnt_a_regular_file_or_is_missing_stops_the_build(tmp_path: Path) -> None:
    archive = tmp_path / "etcd.tar.gz"
    _archive(archive, {"etcd-v3.5.21-linux-arm64/etcd": None})

    with pytest.raises(download_kwok.ManifestError, match="not a regular file"):
        download_kwok.extract_member(archive, "etcd-v3.5.21-linux-arm64/etcd", tmp_path / "etcd")
    with pytest.raises(download_kwok.ManifestError, match="holds no"):
        download_kwok.extract_member(archive, "etcd-v3.5.21-linux-arm64/other", tmp_path / "other")
    assert not (tmp_path / "etcd").exists()


def test_install_lays_the_binaries_out_as_the_service_resolves_them(tmp_path: Path) -> None:
    """With a fake fetch (the downloader's checks are its own), every binary
    lands at <dest>/v0.7.0/<name>, executable, and etcd from its archive."""
    fetched: list[tuple[str, str]] = []

    def fetch_verified(url: str, sha256: str, destination: Path) -> int:
        fetched.append((url, sha256))
        if url.endswith(".tar.gz"):
            _archive(destination, {"etcd-v3.5.21-linux-arm64/etcd": b"#!/bin/sh\n"})
        else:
            destination.write_bytes(b"#!/bin/sh\n")
        return destination.stat().st_size

    version, selected = download_kwok.select(MANIFEST, "arm64")
    download_kwok.install(SimpleNamespace(fetch_verified=fetch_verified), version, selected, tmp_path)

    from app.kwok_binary import FilesystemKwokBinaries

    resolved = FilesystemKwokBinaries(tmp_path).resolve(version)
    for path in (resolved.kwok, resolved.kwokctl, resolved.kubectl, resolved.etcd):
        assert path.parent == tmp_path / "v0.7.0"
        assert path.stat().st_mode & 0o777 == 0o755
    assert (tmp_path / "v0.7.0" / "kube-apiserver").stat().st_mode & 0o777 == 0o755
    assert [p.name for p in tmp_path.iterdir()] == ["v0.7.0"]  # no archive left behind
    assert [sha for _, sha in fetched] == [b["sha256"] for b in selected]
