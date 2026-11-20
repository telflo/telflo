"""Resolve vendored kwok binaries by version.

The tester's image bakes the binaries under ``/opt/kwok/v0.7.0/``, each
checked against its sha256.

Mirrors `app/catalog.py`'s ``binary_path`` but
returns a :class:`KwokBinaries` bundle because kwok needs three (Mac) or four
(linux) binaries that are version-locked together.

``kube-apiserver`` is linux-only — Kubernetes upstream doesn't publish a
darwin build. On Mac the resolver returns ``kube_apiserver=None``; the
caller (``KwokCluster``) is expected to switch to
``kwokctl --runtime=docker``, where the apiserver runs as a Linux container
managed by kwokctl. The platform's tester runs only in its Linux image.
"""

from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from pathlib import Path


class KwokBinariesNotFoundError(RuntimeError):
    pass


@dataclass(frozen=True)
class KwokBinaries:
    """Paths to the vendored kwok binaries for a given pinned version.

    ``kube_apiserver`` is ``None`` on darwin because no darwin build exists
    upstream; on linux it must be present or :meth:`FilesystemKwokBinaries.resolve`
    raises :class:`KwokBinariesNotFoundError`.

    ``kubectl`` is required on every platform — kwokctl shells out to it for
    its `kwokctl <name> kubectl ...` shim. Without a vendored copy, kwokctl
    pulls one from dl.k8s.io at first cluster start.
    """

    version: str
    kwok: Path
    kwokctl: Path
    kubectl: Path
    etcd: Path
    kube_apiserver: Path | None


class FilesystemKwokBinaries:
    """Resolves ``kwok`` / ``kwokctl`` / ``etcd`` / ``kube-apiserver`` under
    ``<binary_dir>/v<version>/``.

    Layout (the image's ``/opt/kwok``):

    .. code-block:: text

        /opt/kwok/
        └── v0.7.0/
            ├── kwok
            ├── kwokctl
            ├── kubectl
            ├── etcd
            └── kube-apiserver   # linux only
    """

    def __init__(self, binary_dir: Path) -> None:
        self._binary_dir = Path(binary_dir)

    def resolve(self, version: str) -> KwokBinaries:
        target = self._binary_dir / f"v{version}"
        if not target.is_dir():
            raise KwokBinariesNotFoundError(
                f"kwok v{version} not found at {target}. "
                f"The tester's image bakes it."
            )

        kwok = self._require_executable(target, "kwok")
        kwokctl = self._require_executable(target, "kwokctl")
        kubectl = self._require_executable(target, "kubectl")
        etcd = self._require_executable(target, "etcd")

        # kube-apiserver is linux-only. On darwin the resolver intentionally
        # returns None and Phase 2 picks --runtime=docker. We still check
        # the file is executable when present in case a contributor copied
        # one over manually.
        kube_apiserver: Path | None = None
        if _host_has_kube_apiserver_build():
            kube_apiserver = self._require_executable(target, "kube-apiserver")
        else:
            stray = target / "kube-apiserver"
            if stray.is_file():
                kube_apiserver = self._require_executable(target, "kube-apiserver")

        return KwokBinaries(
            version=version,
            kwok=kwok,
            kwokctl=kwokctl,
            kubectl=kubectl,
            etcd=etcd,
            kube_apiserver=kube_apiserver,
        )

    def _require_executable(self, target: Path, name: str) -> Path:
        path = target / name
        if not path.is_file():
            raise KwokBinariesNotFoundError(
                f"{name} not found at {path}. "
                f"The tester's image bakes it."
            )
        if not os.access(path, os.X_OK):
            raise KwokBinariesNotFoundError(f"{path} is not executable")
        return path


def _host_has_kube_apiserver_build() -> bool:
    """True on platforms where Kubernetes upstream publishes a kube-apiserver
    binary. As of v1.31 that's linux only; darwin/windows have no build."""
    return platform.system().lower() == "linux"
