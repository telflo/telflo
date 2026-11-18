"""The image's download script (`scripts/download-binaries.py`, D13b Task 2):
which versions `OTELCOL_VERSIONS` picks, that a file whose sha256 isn't the
pinned one is refused at once and never left behind, and that a failed
transfer is retried up to the limit. The image build runs it for
real (README.md, "The image"); these run it on local files."""

from __future__ import annotations

import copy
import hashlib
import http.client
import importlib.util
import io
import json
import tarfile
import urllib.error
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "download-binaries.py"
_spec = importlib.util.spec_from_file_location("download_binaries", SCRIPT)
assert _spec is not None and _spec.loader is not None
download = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(download)

REPOSITORY_CATALOG = Path(__file__).resolve().parents[3] / "catalog" / "distributions"
BuildError = download.BuildError


def _entry(version: str, *, default: bool = False, deprecated: bool = False) -> dict:
    assets = {
        platform: {
            "downloadUrl": f"{download.UPSTREAM}v{version}/otelcol-contrib_{version}_{platform}.tar.gz",
            "sha256": hashlib.sha256(f"{version}-{platform}".encode()).hexdigest(),
        }
        for platform in ("linux_amd64", "linux_arm64")
    }
    return {"version": version, "default": default, "deprecated": deprecated, "otelcolContrib": assets}


DOCUMENT = {
    "distribution": "otelcol-contrib",
    "versions": [
        _entry("0.162.0", default=True),
        _entry("0.161.0"),
        _entry("0.155.0", deprecated=True),
        _entry("0.147.0"),
    ],
}


def _versions(spec: str, arch: str = "arm64") -> list[str]:
    return [version for version, _, _ in download.select_versions(DOCUMENT, spec, arch)]


def test_all_is_every_offered_version_in_the_catalogues_order() -> None:
    assert _versions("all") == ["0.162.0", "0.161.0", "0.147.0"]


def test_default_is_the_catalogues_default() -> None:
    assert _versions("default") == ["0.162.0"]
    assert _versions(" default ") == ["0.162.0"]


def test_a_list_names_those_versions_once_each_in_its_order() -> None:
    assert _versions("0.147.0, 0.162.0,0.147.0") == ["0.147.0", "0.162.0"]


@pytest.mark.parametrize(
    "spec",
    ["9.9.9", "0.162.0,9.9.9", "0.155.0", "v0.162.0", "ALL", "latest"],
    ids=["unknown", "one-unknown", "deprecated", "with-v", "upper-case", "latest"],
)
def test_a_name_the_catalogue_doesnt_offer_stops_the_build(spec: str) -> None:
    with pytest.raises(BuildError, match="doesn't offer"):
        _versions(spec)


@pytest.mark.parametrize("spec", ["", " ", "0.162.0,", ",0.162.0", "0.162.0,,0.161.0"])
def test_an_empty_entry_stops_the_build(spec: str) -> None:
    with pytest.raises(BuildError, match="empty entry"):
        _versions(spec)


def test_the_platform_is_linux_and_the_target_architecture() -> None:
    [(_, url, sha256)] = download.select_versions(DOCUMENT, "default", "amd64")
    assert url.endswith("/v0.162.0/otelcol-contrib_0.162.0_linux_amd64.tar.gz")
    assert sha256 == DOCUMENT["versions"][0]["otelcolContrib"]["linux_amd64"]["sha256"]
    with pytest.raises(BuildError, match="no collector for linux/riscv64"):
        _versions("default", "riscv64")


def test_a_url_that_isnt_upstreams_release_of_that_version_stops_the_build() -> None:
    document = copy.deepcopy(DOCUMENT)
    asset = document["versions"][0]["otelcolContrib"]["linux_arm64"]
    asset["downloadUrl"] = asset["downloadUrl"].replace("0.162.0_linux", "0.161.0_linux")
    with pytest.raises(BuildError, match="not upstream's release"):
        download.select_versions(document, "default", "arm64")


def test_a_malformed_sha256_stops_the_build() -> None:
    document = copy.deepcopy(DOCUMENT)
    document["versions"][0]["otelcolContrib"]["linux_arm64"]["sha256"] = "ABC"
    with pytest.raises(BuildError, match="sha256"):
        download.select_versions(document, "default", "arm64")


def test_the_repository_catalogue_offers_a_default_with_both_linux_collectors() -> None:
    document = download.load_distribution(REPOSITORY_CATALOG)
    for arch in download.ARCHITECTURES:
        assert len(download.select_versions(document, "default", arch)) == 1
        assert len(download.select_versions(document, "all", arch)) >= 1


def test_a_catalogue_without_the_distribution_stops_the_build(tmp_path: Path) -> None:
    (tmp_path / "other.json").write_text(json.dumps({"distribution": "other", "versions": []}))
    with pytest.raises(BuildError, match="no otelcol-contrib"):
        download.load_distribution(tmp_path)


# ---------------------------------------------------------------------------
# Fetching and extracting, on file:// URLs.
# ---------------------------------------------------------------------------


def _tarball(path: Path, members: dict[str, bytes]) -> str:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_a_file_whose_sha256_differs_is_refused_and_removed(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"not what was pinned")
    destination = tmp_path / "out"
    with pytest.raises(BuildError, match="is not the pinned"):
        download.fetch_verified(source.as_uri(), "0" * 64, destination)
    assert not destination.exists()


def test_a_file_whose_sha256_matches_is_kept(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"tini")
    destination = tmp_path / "out"
    assert download.fetch_verified(source.as_uri(), hashlib.sha256(b"tini").hexdigest(), destination) == 4
    assert destination.read_bytes() == b"tini"


def test_the_collector_is_extracted_executable_and_the_tarball_is_gone(tmp_path: Path) -> None:
    tarball = tmp_path / "otelcol-contrib_0.162.0_linux_arm64.tar.gz"
    sha256 = _tarball(tarball, {"otelcol-contrib": b"#!/bin/sh\n", "README.md": b"x"})
    dest = tmp_path / "otelcol"

    download.install_collectors([("0.162.0", tarball.as_uri(), sha256)], dest)

    binary = dest / "v0.162.0" / "otelcol-contrib"
    assert binary.read_bytes() == b"#!/bin/sh\n"
    assert binary.stat().st_mode & 0o777 == 0o755
    assert sorted(path.relative_to(dest).as_posix() for path in dest.rglob("*")) == [
        "v0.162.0",
        "v0.162.0/otelcol-contrib",
    ]


def test_a_mismatched_collector_leaves_nothing_behind(tmp_path: Path) -> None:
    tarball = tmp_path / "otelcol-contrib_0.162.0_linux_arm64.tar.gz"
    _tarball(tarball, {"otelcol-contrib": b"#!/bin/sh\n"})
    dest = tmp_path / "otelcol"

    with pytest.raises(BuildError, match="is not the pinned"):
        download.install_collectors([("0.162.0", tarball.as_uri(), "f" * 64)], dest)

    assert list(dest.rglob("*")) == []


def test_a_tarball_without_the_collector_stops_the_build(tmp_path: Path) -> None:
    tarball = tmp_path / "otelcol-contrib_0.162.0_linux_arm64.tar.gz"
    sha256 = _tarball(tarball, {"something-else": b"x"})
    with pytest.raises(BuildError, match="holds no otelcol-contrib"):
        download.install_collectors([("0.162.0", tarball.as_uri(), sha256)], tmp_path / "otelcol")


# ---------------------------------------------------------------------------
# Retrying (D13b ruling 50): a transfer that fails is retried up to ATTEMPTS
# downloads in all; a sha256 mismatch is attempted once.
# ---------------------------------------------------------------------------


class _Response:
    """What `urlopen` answers: `chunks` read in turn, then `error` raised
    (a transfer cut short) or the end of the body."""

    def __init__(self, chunks: list[bytes], error: Exception | None = None) -> None:
        self._chunks = list(chunks)
        self._error = error

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, _size: int) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        if self._error is not None:
            raise self._error
        return b""


class _Urlopen:
    """Stands in for `urlopen`: answers the queued `outcomes` in turn (a
    `_Response`, or an exception it raises) and records each URL asked."""

    def __init__(self) -> None:
        self.outcomes: list[object] = []
        self.calls: list[str] = []

    def __call__(self, url: str, timeout: float) -> _Response:
        self.calls.append(url)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        assert isinstance(outcome, _Response)
        return outcome


@pytest.fixture
def opened(monkeypatch: pytest.MonkeyPatch) -> _Urlopen:
    """The script's `urlopen`, replaced; the pause between attempts skipped."""
    fake = _Urlopen()
    monkeypatch.setattr(download.urllib.request, "urlopen", fake)
    monkeypatch.setattr(download.time, "sleep", lambda _seconds: None)
    return fake


URL = "https://example.invalid/tini"
DATA = b"tini, all of it"


def test_a_sha256_mismatch_is_attempted_once(tmp_path: Path, opened: _Urlopen) -> None:
    opened.outcomes.extend([_Response([b"not what was pinned"]), _Response([DATA])])
    destination = tmp_path / "out"
    with pytest.raises(BuildError, match="is not the pinned"):
        download.fetch_verified(URL, hashlib.sha256(DATA).hexdigest(), destination)
    assert len(opened.calls) == 1
    assert not destination.exists()


@pytest.mark.parametrize(
    "failure",
    [
        urllib.error.URLError("connection refused"),
        ConnectionResetError("reset by peer"),
        TimeoutError("timed out"),
        "truncated",
    ],
    ids=["url-error", "reset", "timeout", "incomplete-read"],
)
def test_a_failed_transfer_is_retried_and_the_next_good_one_kept(
    tmp_path: Path, opened: _Urlopen, failure: object
) -> None:
    # A truncated transfer: some bytes arrive, then the connection closes
    # before Content-Length's worth (http.client's IncompleteRead).
    first = _Response([DATA[:4]], http.client.IncompleteRead(DATA[:4], len(DATA) - 4)) if failure == "truncated" else failure
    opened.outcomes.extend([first, _Response([DATA])])
    destination = tmp_path / "out"
    assert download.fetch_verified(URL, hashlib.sha256(DATA).hexdigest(), destination) == len(DATA)
    assert len(opened.calls) == 2
    assert destination.read_bytes() == DATA


@pytest.mark.parametrize(
    "failure",
    [lambda: urllib.error.URLError("unreachable"), lambda: _Response([b"tin"], http.client.IncompleteRead(b"tin", 12))],
    ids=["network", "incomplete-read"],
)
def test_a_transfer_failing_every_time_stops_the_build_after_the_limit(
    tmp_path: Path, opened: _Urlopen, failure
) -> None:
    opened.outcomes.extend(failure() for _ in range(download.ATTEMPTS + 1))
    destination = tmp_path / "out"
    with pytest.raises(BuildError, match=f"download failed after {download.ATTEMPTS} attempts"):
        download.fetch_verified(URL, hashlib.sha256(DATA).hexdigest(), destination)
    assert len(opened.calls) == download.ATTEMPTS
    assert not destination.exists()
