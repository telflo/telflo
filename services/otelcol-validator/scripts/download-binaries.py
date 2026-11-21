#!/usr/bin/env python3
"""Downloads what the validator's image bakes in, each file checked against
its pinned sha256 before it is used. The Dockerfile's download stage runs it;
nothing it fetches reaches a layer unchecked, and no tarball is left behind.

    download-binaries.py collectors --catalog DIR --versions SPEC --arch ARCH --dest DIR

reads the collector catalog (`catalog/distributions/*.json`, the
`otelcol-contrib` distribution) and, for each version SPEC names, fetches
upstream's `otelcol-contrib_<version>_linux_<arch>.tar.gz`, checks its sha256
against the catalog's, and extracts the one file `otelcol-contrib` to
`DIR/v<version>/otelcol-contrib` (the validator's layout, `app/catalog.py`),
deleting the tarball as it goes. SPEC is the build argument
`OTELCOL_VERSIONS`:

    all          every offered (not deprecated) version, the default
    default      the catalog's default version
    0.162.0,...  those versions, each of which the catalog must offer

A name the catalog doesn't offer (a deprecated or an unknown version), an
empty entry, a download whose sha256 differs, or a URL that isn't upstream's
release of that version and platform stops the build.

    download-binaries.py file --url URL --sha256 HEX --dest PATH

fetches one file (tini) and checks it the same way.

Only the standard library: the download stage has no curl or jq.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

DISTRIBUTION = "otelcol-contrib"
UPSTREAM = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/"
# Docker's TARGETARCH values the catalog has a Linux collector for.
ARCHITECTURES = ("amd64", "arm64")
MEMBER = "otelcol-contrib"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
CHUNK_BYTES = 1 << 20
READ_TIMEOUT_SECONDS = 60
# A network failure or a truncated transfer is retried, up to ATTEMPTS
# downloads in all; a checksum mismatch never is: it fails the build at once.
ATTEMPTS = 3
# What a failed transfer raises: urllib's URLError and HTTPError, a reset or
# a timeout are OSErrors; a connection closed before Content-Length's bytes
# arrived is http.client's IncompleteRead, an HTTPException, as are the
# other protocol errors.
RETRIED = (OSError, http.client.HTTPException)


class BuildError(Exception):
    """Stops the build, with a message that says why."""


# ---------------------------------------------------------------------------
# Which versions
# ---------------------------------------------------------------------------


def load_distribution(catalog_dir: Path) -> dict:
    """The `otelcol-contrib` distribution's file from the catalog."""
    files = sorted(catalog_dir.glob("*.json"))
    if not files:
        raise BuildError(f"the catalogue {catalog_dir} holds no distribution file")
    found: dict | None = None
    for path in files:
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuildError(f"{path.name} can't be read: {error}") from None
        if isinstance(document, dict) and document.get("distribution") == DISTRIBUTION:
            if found is not None:
                raise BuildError(f"the catalogue lists {DISTRIBUTION} twice")
            found = document
    if found is None:
        raise BuildError(f"the catalogue {catalog_dir} has no {DISTRIBUTION} distribution")
    if not isinstance(found.get("versions"), list):
        raise BuildError(f"{DISTRIBUTION}'s file has no versions list")
    return found


def select_versions(document: dict, spec: str, arch: str) -> list[tuple[str, str, str]]:
    """`(version, url, sha256)` for each version `spec` names, in the
    catalog's order for `all` and in `spec`'s order for a list."""
    if arch not in ARCHITECTURES:
        raise BuildError(
            f"no collector for linux/{arch}: the catalogue has linux_{' and linux_'.join(ARCHITECTURES)}"
        )
    offered = [entry for entry in document["versions"] if isinstance(entry, dict) and entry.get("deprecated") is False]
    by_version = {entry.get("version"): entry for entry in offered}
    names = ", ".join(str(entry.get("version")) for entry in offered)

    spec = spec.strip()
    if spec == "all":
        chosen = [entry["version"] for entry in offered]
    elif spec == "default":
        chosen = [entry["version"] for entry in offered if entry.get("default") is True]
        if len(chosen) != 1:
            raise BuildError(f"the catalogue has {len(chosen)} offered default versions of {DISTRIBUTION}, not one")
    else:
        requested = [name.strip() for name in spec.split(",")]
        if any(not name for name in requested):
            raise BuildError(f"OTELCOL_VERSIONS={spec!r} has an empty entry (use all, default or a comma-separated list)")
        unknown = [name for name in requested if name not in by_version]
        if unknown:
            raise BuildError(
                f"OTELCOL_VERSIONS names {', '.join(unknown)}, which the catalogue doesn't offer "
                f"(offered: {names}; or all, default)"
            )
        chosen = list(dict.fromkeys(requested))
    if not chosen:
        raise BuildError(f"the catalogue offers no version of {DISTRIBUTION}")

    platform = f"linux_{arch}"
    selected = []
    for version in chosen:
        asset = (by_version[version].get("otelcolContrib") or {}).get(platform)
        if not isinstance(asset, dict):
            raise BuildError(f"v{version} has no otelcolContrib.{platform} in the catalogue")
        url, sha256 = asset.get("downloadUrl"), asset.get("sha256")
        expected = f"{UPSTREAM}v{version}/otelcol-contrib_{version}_{platform}.tar.gz"
        if url != expected:
            raise BuildError(f"v{version}'s {platform} downloadUrl is not upstream's release ({expected})")
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            raise BuildError(f"v{version}'s {platform} sha256 is not 64 lowercase hex characters")
        selected.append((version, url, sha256))
    return selected


# ---------------------------------------------------------------------------
# Fetching and checking
# ---------------------------------------------------------------------------


def fetch_verified(url: str, sha256: str, destination: Path) -> int:
    """Writes `url`'s bytes to `destination` (a new file) and returns their
    size, or removes it and raises when their sha256 isn't `sha256` (at
    once) or every attempt failed in transfer (`RETRIED`)."""
    last_error: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        digest = hashlib.sha256()
        size = 0
        try:
            with urllib.request.urlopen(url, timeout=READ_TIMEOUT_SECONDS) as response, destination.open("wb") as out:
                while chunk := response.read(CHUNK_BYTES):
                    digest.update(chunk)
                    out.write(chunk)
                    size += len(chunk)
        except RETRIED as error:
            destination.unlink(missing_ok=True)
            last_error = error
            if attempt < ATTEMPTS:
                print(f"  {url}: {error}; retrying ({attempt} of {ATTEMPTS})", flush=True)
                time.sleep(2 * attempt)
            continue
        if digest.hexdigest() != sha256:
            destination.unlink(missing_ok=True)
            raise BuildError(f"{url}: sha256 {digest.hexdigest()} is not the pinned {sha256}; refusing it")
        return size
    raise BuildError(f"{url}: download failed after {ATTEMPTS} attempts: {last_error}")


def extract_collector(tarball: Path, target: Path) -> int:
    """Copies the tarball's `otelcol-contrib` (a regular file at its top
    level) to `target`, executable, and returns its size."""
    with tarfile.open(tarball, "r:gz") as archive:
        try:
            member = archive.getmember(MEMBER)
        except KeyError:
            raise BuildError(f"{tarball.name} holds no {MEMBER}") from None
        if not member.isreg():
            raise BuildError(f"{tarball.name}'s {MEMBER} is not a regular file")
        source = archive.extractfile(member)
        assert source is not None
        target.parent.mkdir(parents=True, exist_ok=True)
        with source, target.open("wb") as out:
            shutil.copyfileobj(source, out, CHUNK_BYTES)
    target.chmod(0o755)
    return target.stat().st_size


def install_collectors(selected: list[tuple[str, str, str]], dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for version, url, sha256 in selected:
        target = dest / f"v{version}" / MEMBER
        if target.exists():
            raise BuildError(f"{target} already exists")
        started = time.monotonic()
        # The tarball lives only inside this step: in a temporary directory
        # removed before the next version, so no layer ever holds one.
        with tempfile.TemporaryDirectory(dir=dest) as scratch:
            tarball = Path(scratch) / url.rsplit("/", 1)[1]
            downloaded = fetch_verified(url, sha256, tarball)
            size = extract_collector(tarball, target)
        print(
            f"[OK] v{version}: {downloaded / 1e6:.0f} MB, sha256 {sha256} matches; "
            f"{target} ({size / 1e6:.0f} MB) in {time.monotonic() - started:.1f} s",
            flush=True,
        )


# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    collectors = commands.add_parser("collectors", help="the catalogue's collectors")
    collectors.add_argument("--catalog", type=Path, required=True)
    collectors.add_argument("--versions", required=True)
    collectors.add_argument("--arch", required=True)
    collectors.add_argument("--dest", type=Path, required=True)
    one_file = commands.add_parser("file", help="one file with a pinned sha256")
    one_file.add_argument("--url", required=True)
    one_file.add_argument("--sha256", required=True)
    one_file.add_argument("--dest", type=Path, required=True)
    one_file.add_argument("--mode", type=lambda value: int(value, 8), default=0o644)
    args = parser.parse_args(argv)

    try:
        if args.command == "collectors":
            selected = select_versions(load_distribution(args.catalog), args.versions, args.arch)
            print(
                f"OTELCOL_VERSIONS={args.versions}: {', '.join(version for version, _, _ in selected)} "
                f"for linux_{args.arch}",
                flush=True,
            )
            install_collectors(selected, args.dest)
        else:
            if not SHA256_RE.fullmatch(args.sha256):
                raise BuildError("--sha256 is not 64 lowercase hex characters")
            args.dest.parent.mkdir(parents=True, exist_ok=True)
            size = fetch_verified(args.url, args.sha256, args.dest)
            os.chmod(args.dest, args.mode)
            print(f"[OK] {args.url}: {size} bytes, sha256 {args.sha256} matches; {args.dest}", flush=True)
    except BuildError as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
