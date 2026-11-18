#!/usr/bin/env python3
"""Downloads kwok's five release binaries for the tester's image, each
checked against its pinned sha256 before it is used (D14a spec decision 6,
Preflight ruling 19). The Dockerfile's download stage runs it; nothing it
fetches reaches a layer unchecked, and no archive is left behind.

    download-kwok.py --manifest kwok/binaries.json --arch ARCH --dest DIR

reads the manifest (each binary's name, upstream URL with `{arch}` for
Docker's TARGETARCH, sha256 per architecture, and for etcd the one archive
member to keep) and writes `DIR/v<kwokVersion>/<name>`, mode 0755: the
layout `app/kwok_binary.py` resolves and `kwok/kwokctl.yaml` names. etcd
comes as a tar.gz: the archive is checked whole, then only its `etcd` file
is copied out (a regular file at the member path the manifest names), so no
other member, owner or mode of the archive's reaches the image.

The fetching and checking are the collector downloader's
(`services/otelcol-validator/scripts/download-binaries.py`, `fetch_verified`:
retried transfers, a sha256 mismatch fatal at once), loaded from beside this
script in the download stage, or from `--downloader`. Only the standard
library: the download stage has no curl or jq.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from types import ModuleType

# Docker's TARGETARCH values kwok publishes Linux binaries for.
ARCHITECTURES = ("amd64", "arm64")
# The five, exactly: kwokctl starts or calls the other four (kwok/kwokctl.yaml).
NAMES = ("kwok", "kwokctl", "kubectl", "kube-apiserver", "etcd")
# Upstream's release locations, and nothing else.
UPSTREAMS = (
    "https://github.com/kubernetes-sigs/kwok/releases/download/",
    "https://dl.k8s.io/release/",
    "https://github.com/etcd-io/etcd/releases/download/",
)
SHA256_RE = re.compile(r"[0-9a-f]{64}")
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
CHUNK_BYTES = 1 << 20
DEFAULT_DOWNLOADER = Path(__file__).with_name("download-binaries.py")


class ManifestError(Exception):
    """The manifest isn't what the build may trust: stops the build."""


def load_downloader(path: Path) -> ModuleType:
    """The collector downloader, as a module (its file name has a hyphen)."""
    spec = importlib.util.spec_from_file_location("download_binaries", path)
    if spec is None or spec.loader is None or not path.is_file():
        raise ManifestError(f"no downloader at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def select(manifest: dict, arch: str) -> tuple[str, list[dict]]:
    """`(kwokVersion, [{name, url, sha256, member}])` for `arch`, every field
    checked: the five names once each, upstream HTTPS URLs, a 64-hex sha256
    for the architecture."""
    if arch not in ARCHITECTURES:
        raise ManifestError(f"no kwok binaries for linux/{arch}: the manifest has {', '.join(ARCHITECTURES)}")
    version = manifest.get("kwokVersion")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ManifestError("kwokVersion is not major.minor.patch")
    entries = manifest.get("binaries")
    if not isinstance(entries, list):
        raise ManifestError("the manifest has no binaries list")
    names = [entry.get("name") if isinstance(entry, dict) else None for entry in entries]
    if sorted(map(str, names)) != sorted(NAMES):
        raise ManifestError(f"the manifest must list exactly {', '.join(NAMES)}, once each")
    selected = []
    for entry in entries:
        name = entry["name"]
        url = entry.get("url")
        sha256 = (entry.get("sha256") or {}).get(arch) if isinstance(entry.get("sha256"), dict) else None
        member = entry.get("member")
        if not isinstance(url, str) or "{arch}" not in url or not url.startswith(UPSTREAMS):
            raise ManifestError(f"{name}'s url is not an upstream release URL with {{arch}}")
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            raise ManifestError(f"{name}'s sha256 for {arch} is not 64 lowercase hex characters")
        if member is not None and (not isinstance(member, str) or not url.endswith(".tar.gz")):
            raise ManifestError(f"{name}'s member needs a .tar.gz url")
        selected.append(
            {
                "name": name,
                "url": url.replace("{arch}", arch),
                "sha256": sha256,
                "member": member.replace("{arch}", arch) if member else None,
            }
        )
    return version, selected


def extract_member(archive_path: Path, member_name: str, target: Path) -> int:
    """Copies the archive's `member_name` (a regular file) to `target` and
    returns its size. Its bytes only: not its owner, mode or times."""
    with tarfile.open(archive_path, "r:gz") as archive:
        try:
            member = archive.getmember(member_name)
        except KeyError:
            raise ManifestError(f"{archive_path.name} holds no {member_name}") from None
        if not member.isreg():
            raise ManifestError(f"{archive_path.name}'s {member_name} is not a regular file")
        source = archive.extractfile(member)
        assert source is not None
        with source, target.open("xb") as out:
            shutil.copyfileobj(source, out, CHUNK_BYTES)
    return target.stat().st_size


def install(downloader: ModuleType, version: str, selected: list[dict], dest: Path) -> None:
    directory = dest / f"v{version}"
    directory.mkdir(parents=True, exist_ok=True)
    for binary in selected:
        target = directory / binary["name"]
        if target.exists():
            raise ManifestError(f"{target} already exists")
        started = time.monotonic()
        if binary["member"] is None:
            size = downloader.fetch_verified(binary["url"], binary["sha256"], target)
        else:
            # The archive lives only inside this step, in a temporary
            # directory removed before the next binary.
            with tempfile.TemporaryDirectory(dir=dest) as scratch:
                archive = Path(scratch) / binary["url"].rsplit("/", 1)[1]
                downloader.fetch_verified(binary["url"], binary["sha256"], archive)
                size = extract_member(archive, binary["member"], target)
        target.chmod(0o755)
        print(
            f"[OK] {binary['name']}: sha256 {binary['sha256']} matches; {target} "
            f"({size / 1e6:.0f} MB) in {time.monotonic() - started:.1f} s",
            flush=True,
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--arch", required=True)
    parser.add_argument("--dest", type=Path, required=True)
    parser.add_argument("--downloader", type=Path, default=DEFAULT_DOWNLOADER)
    args = parser.parse_args(argv)
    try:
        downloader = load_downloader(args.downloader)
    except ManifestError as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    try:
        try:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ManifestError(f"{args.manifest} can't be read: {error}") from None
        if not isinstance(manifest, dict):
            raise ManifestError(f"{args.manifest} is not a JSON object")
        version, selected = select(manifest, args.arch)
        print(f"kwok v{version}: {', '.join(b['name'] for b in selected)} for linux_{args.arch}", flush=True)
        install(downloader, version, selected, args.dest)
    # The downloader's BuildError: a sha256 mismatch or a failed transfer.
    except (ManifestError, downloader.BuildError) as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
