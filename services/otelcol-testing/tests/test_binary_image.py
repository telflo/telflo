"""The image itself (marked `binary`): run inside the image's `test` target.

- Its catalogue is catalog/'s: the image mirrors the repository's layout, so
  the service's default catalogue directory is the copy it carries, and the
  collectors it holds are exactly the versions it was built for
  (`OTELCOL_EXPECTED_VERSIONS`: every offered version for `all`), never a
  retired or unknown one, each saying its own version.
- kwok's five binaries are where kwokctl's configuration names them, at the
  manifest's versions.
- Every binary is root's and read-only to the service's user (uid 10001),
  which runs everything here; tini is PID 1.
- `PR_SET_DUMPABLE` 0 takes effect here (Linux): another process of the same
  uid is refused the service's /proc environment, and `exec` makes a
  process dumpable again, which is why the secret is in no environment.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from app.catalog import binary_path
from app.kwok_cluster import kwok_binary_dir, kwokctl_config
from app.settings import DEFAULT_CATALOG_DIR
from tests.binary_support import BINARY_DIR, CATALOG_DIR, OFFERED, expected_versions

pytestmark = pytest.mark.binary

SERVICE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((SERVICE_ROOT / "kwok" / "binaries.json").read_text(encoding="utf-8"))


def test_the_service_reads_the_catalogue_the_image_carries() -> None:
    """The image mirrors the repository (/app/services/otelcol-testing beside
    /app/catalog), so the service's default catalogue is the copy of
    catalog/distributions, and OTELCOL_CATALOG_DIR names that same copy."""
    assert CATALOG_DIR.resolve() == DEFAULT_CATALOG_DIR.resolve()
    assert (CATALOG_DIR / "otelcol-contrib.json").is_file()


def test_the_images_catalogue_is_catalog_s_file_for_file() -> None:
    """Not only its versions: every file of the catalogue the
    service reads is catalog/'s (the build context's copy, kept apart in the
    test target), byte for byte, and there is no other."""
    context = Path(os.environ.get("OTELCOL_CONTEXT_CATALOG_DIR", ""))
    assert context.is_dir(), "OTELCOL_CONTEXT_CATALOG_DIR is unset: run this in the image's test target"

    def files(root: Path) -> dict[str, bytes]:
        return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}

    image, expected = files(CATALOG_DIR), files(context)
    assert expected, "the build context's catalogue is empty"
    assert sorted(image) == sorted(expected)
    assert [name for name in expected if image[name] != expected[name]] == []


def test_the_image_holds_exactly_the_versions_it_was_built_for() -> None:
    expected = expected_versions()
    assert expected, "OTELCOL_EXPECTED_VERSIONS is unset: run this in the image's test target"
    assert set(expected) <= set(OFFERED), f"not offered: {sorted(set(expected) - set(OFFERED))}"
    held = sorted(path.name for path in BINARY_DIR.iterdir())

    assert held == sorted(f"v{version}" for version in expected)
    assert all(binary_path(BINARY_DIR, version).is_file() for version in expected)


def test_the_expected_versions_are_read_as_the_build_argument_is() -> None:
    assert expected_versions("") == []
    assert expected_versions("all") == OFFERED
    assert expected_versions("default") in ([version] for version in OFFERED)
    assert expected_versions(" 0.161.0, 0.162.0 ") == ["0.161.0", "0.162.0"]


@pytest.mark.parametrize("version", OFFERED)
def test_each_collector_says_its_own_version(version: str) -> None:
    binary = binary_path(BINARY_DIR, version)
    if not binary.is_file():
        assert version not in expected_versions()
        pytest.skip(f"{version} isn't held")

    ran = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=30, check=True)

    assert f" {version}" in ran.stdout


def test_kwoks_binaries_are_where_kwokctls_configuration_names_them() -> None:
    options = yaml.safe_load(kwokctl_config().read_text(encoding="utf-8"))["options"]
    directory = kwok_binary_dir() / f"v{MANIFEST['kwokVersion']}"
    names = sorted(path.name for path in directory.iterdir())

    assert names == sorted(entry["name"] for entry in MANIFEST["binaries"])
    for key, name in (
        ("kubectlBinary", "kubectl"),
        ("kubeApiserverBinary", "kube-apiserver"),
        ("etcdBinary", "etcd"),
        ("kwokControllerBinary", "kwok"),
    ):
        assert Path(options[key]) == directory / name


@pytest.mark.parametrize(
    ("name", "arguments", "says"),
    [
        ("kwok", ["--version"], "v0.7.0"),
        ("kwokctl", ["--version"], "v0.7.0"),
        ("kubectl", ["version", "--client"], "v1.31.6"),
        ("kube-apiserver", ["--version"], "v1.31.6"),
        ("etcd", ["--version"], "3.5.21"),
    ],
)
def test_each_kwok_binary_runs_at_the_manifests_version(name: str, arguments: list[str], says: str) -> None:
    [entry] = [e for e in MANIFEST["binaries"] if e["name"] == name]
    assert says.lstrip("v") in entry["version"]
    binary = kwok_binary_dir() / f"v{MANIFEST['kwokVersion']}" / name

    ran = subprocess.run([str(binary), *arguments], capture_output=True, text=True, timeout=30, check=True)

    assert says in ran.stdout + ran.stderr


def test_every_binary_is_roots_and_read_only_to_the_service() -> None:
    assert os.getuid() == 10001
    binaries = [*BINARY_DIR.rglob("*"), *kwok_binary_dir().rglob("*"), Path("/usr/local/bin/tini")]
    assert len(binaries) > 6

    for path in binaries:
        status = path.stat()
        assert status.st_uid == 0, path
        assert not os.access(path, os.W_OK), path
        assert not status.st_mode & 0o022, path


def test_tini_is_pid_1() -> None:
    command = Path("/proc/1/cmdline").read_bytes().split(b"\0")

    assert command[0] == b"/usr/local/bin/tini"


def _child(source: str) -> subprocess.Popen:
    """A Python process of the service's user that says `ready` once it has
    done `source`, then waits; its environment carries a marker."""
    process = subprocess.Popen(
        [sys.executable, "-c", f"{source}\nimport sys, time\nprint('ready', flush=True)\ntime.sleep(60)\n"],
        cwd=SERVICE_ROOT,
        env={**os.environ, "DUMPABLE_PROBE_MARKER": "marker-value"},
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "ready"
    return process


def _end(process: subprocess.Popen) -> None:
    process.kill()
    process.wait()
    assert process.stdout is not None
    process.stdout.close()


def _environ(pid: int) -> bytes | None:
    """The process's /proc environment, or None when it is refused."""
    try:
        return Path(f"/proc/{pid}/environ").read_bytes()
    except PermissionError:
        return None


def test_a_non_dumpable_process_refuses_its_environment_to_the_same_user() -> None:
    """The service's own call (app/hardening.py) takes effect in the image:
    the same uid can read a dumpable process's environment and is refused a
    non-dumpable one's."""
    dumpable = _child("pass")
    hardened = _child("from app.hardening import make_not_dumpable\nassert make_not_dumpable() is True")
    try:
        assert b"DUMPABLE_PROBE_MARKER=marker-value" in (_environ(dumpable.pid) or b"")
        assert _environ(hardened.pid) is None
        for name in ("fd", "cwd"):
            with pytest.raises(PermissionError):
                os.listdir(f"/proc/{hardened.pid}/{name}")
    finally:
        for process in (dumpable, hardened):
            _end(process)


def test_exec_makes_a_process_dumpable_again() -> None:
    """Why the secret must be in no environment: a collector the
    non-dumpable service starts is an exec, readable again."""
    execed = _child(
        "from app.hardening import make_not_dumpable\n"
        "import os, sys\n"
        "if len(sys.argv) < 2:\n"
        "    make_not_dumpable()\n"
        "    os.execv(sys.executable, [sys.executable, '-c', open('/proc/self/cmdline').read().split(chr(0))[2], 'again'])"
    )
    try:
        # `ready` comes from the exec'd program, after the exec.
        assert b"DUMPABLE_PROBE_MARKER=marker-value" in (_environ(execed.pid) or b"")
    finally:
        _end(execed)
