"""The kwok binaries' resolver. The darwin case runs with a monkeypatched
``platform.system`` (so it isn't skipped on Linux, the image's platform),
with a Linux case beside it.
"""

from __future__ import annotations

import platform
from pathlib import Path

import pytest

from app import kwok_binary as kwok_binary_module
from app.kwok_binary import (
    FilesystemKwokBinaries,
    KwokBinariesNotFoundError,
)


def _make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


def _make_layout(
    base: Path,
    version: str,
    *,
    include_kube_apiserver: bool,
) -> Path:
    target = base / f"v{version}"
    _make_executable(target / "kwok")
    _make_executable(target / "kwokctl")
    _make_executable(target / "kubectl")
    _make_executable(target / "etcd")
    if include_kube_apiserver:
        _make_executable(target / "kube-apiserver")
    return target


def test_resolve_returns_all_paths_when_layout_complete(tmp_path: Path) -> None:
    is_linux = platform.system().lower() == "linux"
    _make_layout(tmp_path, "0.7.0", include_kube_apiserver=is_linux)

    bins = FilesystemKwokBinaries(tmp_path).resolve("0.7.0")

    assert bins.version == "0.7.0"
    assert bins.kwok.name == "kwok"
    assert bins.kwokctl.name == "kwokctl"
    assert bins.kubectl.name == "kubectl"
    assert bins.etcd.name == "etcd"
    if is_linux:
        assert bins.kube_apiserver is not None
        assert bins.kube_apiserver.name == "kube-apiserver"
    else:
        assert bins.kube_apiserver is None


def test_resolve_raises_when_version_dir_missing(tmp_path: Path) -> None:
    with pytest.raises(KwokBinariesNotFoundError, match="not found"):
        FilesystemKwokBinaries(tmp_path).resolve("9.9.9")


def test_resolve_raises_when_kwok_missing(tmp_path: Path) -> None:
    target = tmp_path / "v0.7.0"
    target.mkdir(parents=True)
    _make_executable(target / "kwokctl")
    _make_executable(target / "kubectl")
    _make_executable(target / "etcd")

    with pytest.raises(KwokBinariesNotFoundError, match="kwok not found"):
        FilesystemKwokBinaries(tmp_path).resolve("0.7.0")


def test_resolve_raises_when_kubectl_missing(tmp_path: Path) -> None:
    target = tmp_path / "v0.7.0"
    target.mkdir(parents=True)
    _make_executable(target / "kwok")
    _make_executable(target / "kwokctl")
    _make_executable(target / "etcd")

    with pytest.raises(KwokBinariesNotFoundError, match="kubectl not found"):
        FilesystemKwokBinaries(tmp_path).resolve("0.7.0")


def test_resolve_raises_when_kwokctl_not_executable(tmp_path: Path) -> None:
    target = tmp_path / "v0.7.0"
    target.mkdir(parents=True)
    _make_executable(target / "kwok")
    (target / "kwokctl").write_text("#!/bin/sh\nexit 0\n")  # not chmod +x
    _make_executable(target / "kubectl")
    _make_executable(target / "etcd")

    with pytest.raises(KwokBinariesNotFoundError, match="not executable"):
        FilesystemKwokBinaries(tmp_path).resolve("0.7.0")


def test_resolve_picks_up_stray_kube_apiserver_on_darwin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """On platforms without an upstream kube-apiserver build, the resolver
    normally returns None — but if a contributor manually copied one in,
    surface it rather than ignoring it. (Rewritten: the platform is
    monkeypatched, so the case runs on every host.)"""
    monkeypatch.setattr(kwok_binary_module.platform, "system", lambda: "Darwin")
    _make_layout(tmp_path, "0.7.0", include_kube_apiserver=False)
    assert FilesystemKwokBinaries(tmp_path).resolve("0.7.0").kube_apiserver is None

    _make_executable(tmp_path / "v0.7.0" / "kube-apiserver")
    bins = FilesystemKwokBinaries(tmp_path).resolve("0.7.0")
    assert bins.kube_apiserver is not None
    assert bins.kube_apiserver.name == "kube-apiserver"


def test_resolve_requires_kube_apiserver_on_linux(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The image's platform: kube-apiserver is required (kwokctl's binary
    runtime starts it)."""
    monkeypatch.setattr(kwok_binary_module.platform, "system", lambda: "Linux")
    _make_layout(tmp_path, "0.7.0", include_kube_apiserver=False)

    with pytest.raises(KwokBinariesNotFoundError, match="kube-apiserver not found"):
        FilesystemKwokBinaries(tmp_path).resolve("0.7.0")
