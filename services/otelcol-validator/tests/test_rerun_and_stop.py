"""The requirements-only rerun and the reap primitives.

A validate-stage requirement (file_storage's missing directory, a custom
``node_from_env_var``) stops the collector before the build stage and would
hide any build-stage error, so a run that ends with requirements only is run
once more with what the sandbox can meet — a fresh directory, a placeholder
environment variable — and that run's errors are the answer's, the
requirements staying from the first run.

``_stop`` shields the shared futures so a reap canceled midway
doesn't break the next reap; a requirement whose captured variable holds the
validator's placeholder or a line break is not emitted.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
import yaml

from app import runner
from app.runner import _Pipes, _meet_requirements, _env_name_from_title, _stop, run_validation
from app.stderr import classify_cause
from tests import guard
from tests.conftest import write_collector

# A fake collector that stages exactly as the real one does: it reads the
# file_storage directory from the config and, while that directory is missing,
# reports the directory requirement and stops (the validate stage); once the
# directory exists (the rerun repointed it), it reaches the build stage and
# reports the build error.
STAGING_COLLECTOR = r"""cfg="${2#--config=}"
dir=$(sed -n 's/.*directory: *//p' "$cfg" | head -1 | tr -d '"'"'"'"')
if [ -d "$dir" ]; then
  echo 'Error: failed to build pipelines: failed to create "resourcedetection" processor, in pipeline "logs": invalid detector key: no_such_detector' >&2
else
  echo "Error: extensions::file_storage: directory must exist: stat $dir: no such file or directory. You can enable the create_directory option to automatically create it" >&2
fi
exit 1
"""

MASKING_CONFIG = """\
receivers:
  otlp:
    protocols:
      grpc: {}
processors:
  resourcedetection:
    detectors: [no_such_detector]
exporters:
  debug: {}
extensions:
  file_storage:
    directory: /var/lib/otel-nope
service:
  extensions: [file_storage]
  pipelines:
    logs:
      receivers: [otlp]
      processors: [resourcedetection]
      exporters: [debug]
"""


async def _check(binary: Path, text: str):
    return await run_validation(
        binary, text, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10
    )


async def test_a_masked_build_error_is_surfaced_by_the_rerun(binary_dir: Path) -> None:
    """file_storage's missing directory hides the no_such_detector build
    error (valid: true). The rerun meets the directory and the build error
    surfaces, with the directory still a requirement."""
    binary = write_collector(binary_dir, "0.162.0", STAGING_COLLECTOR)

    result = await _check(binary, MASKING_CONFIG)

    assert result.valid is False
    assert [e["message"] for e in result.errors] == [
        'failed to create "resourcedetection" processor, in pipeline "logs": invalid detector key: no_such_detector'
    ]
    assert [r["category"] for r in result.requirements] == ["directory"]
    assert result.requirements[0]["title"] == "Ensure /var/lib/otel-nope exists at runtime"


async def test_without_a_meetable_requirement_there_is_no_rerun(binary_dir: Path) -> None:
    """A requirements-only run with nothing the sandbox can meet (the
    collector only ever reports the directory requirement) stays valid with
    the requirement — the rerun must not invent an error."""
    only_requirement = (
        "cfg=\"${2#--config=}\"\n"
        "echo \"Error: extensions::file_storage: directory must exist: stat /var/lib/otel-nope: "
        "no such file or directory. You can enable the create_directory option to automatically create it\" >&2\n"
        "exit 1\n"
    )
    # No file_storage block in the config, so the directory can't be repointed.
    binary = write_collector(binary_dir, "0.162.0", only_requirement)
    text = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n"

    result = await _check(binary, text)

    assert result.valid is True
    assert [r["category"] for r in result.requirements] == ["directory"]


def test_meet_requirements_reads_the_variable_name_from_a_title() -> None:
    assert _env_name_from_title("Set environment variable MY_TOKEN") == "MY_TOKEN"
    assert _env_name_from_title("Set K8S_NODE_NAME via the Kubernetes downward API") == "K8S_NODE_NAME"
    assert _env_name_from_title("Ensure /var/lib/otel exists at runtime") is None


def test_meet_requirements_sets_named_variables_and_skips_the_unmeetable() -> None:
    requirements = [
        {"category": "env_var", "title": "Set environment variable MY_TOKEN", "description": "", "componentPath": None},
        {"category": "k8s_in_cluster", "title": "Runs inside a Kubernetes cluster", "description": "", "componentPath": None},
    ]
    met = _meet_requirements("receivers: {}\n", requirements, None)
    assert met is not None
    _rewritten, env_additions = met
    assert "MY_TOKEN" in env_additions

    # Nothing the sandbox can meet: no rerun.
    only_cluster = [requirements[1]]
    assert _meet_requirements("receivers: {}\n", only_cluster, None) is None


# The host_filesystem template (hostmetrics' root_path, a validate-stage
# requirement on Linux) is met the same way: the rerun points root_path at a
# fresh directory, so a build error it hid surfaces.
ROOT_PATH_COLLECTOR = r"""cfg="${2#--config=}"
root=$(sed -n 's/.*root_path: *//p' "$cfg" | head -1 | tr -d '"'"'"'"')
if [ -d "$root" ]; then
  echo 'Error: failed to build pipelines: failed to create "resourcedetection" processor, in pipeline "metrics": invalid detector key: no_such_detector' >&2
else
  echo "Error: receivers::hostmetrics: invalid root_path: stat $root: no such file or directory" >&2
fi
exit 1
"""

ROOT_PATH_MASKING_CONFIG = """\
receivers:
  hostmetrics:
    root_path: /nonexistent-root
    scrapers:
      cpu: {}
processors:
  resourcedetection:
    detectors: [no_such_detector]
exporters:
  debug: {}
service:
  pipelines:
    metrics:
      receivers: [hostmetrics]
      processors: [resourcedetection]
      exporters: [debug]
"""


async def test_a_build_error_masked_by_root_path_is_surfaced_by_the_rerun(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", ROOT_PATH_COLLECTOR)

    result = await _check(binary, ROOT_PATH_MASKING_CONFIG)

    assert result.valid is False
    assert [e["message"] for e in result.errors] == [
        'failed to create "resourcedetection" processor, in pipeline "metrics": invalid detector key: no_such_detector'
    ]
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("host_filesystem", "Mount the host filesystem at /nonexistent-root")
    ]


def test_meet_requirements_repoints_every_hostmetrics_root_path(tmp_path: Path) -> None:
    text = (
        "receivers:\n"
        "  hostmetrics:\n    root_path: /a\n"
        "  host_metrics/2:\n    root_path: '/b'\n"
        "  otlp:\n    root_path: /c\n"
        "exporters:\n  hostmetrics:\n    root_path: /d\n"
    )
    requirement = {
        "category": "host_filesystem",
        "title": "Mount the host filesystem at /a",
        "description": "",
        "componentPath": "receivers::hostmetrics",
    }

    met = _meet_requirements(text, [requirement], str(tmp_path))

    assert met is not None
    rewritten, env_additions = met
    assert env_additions == {}
    document = yaml.safe_load(rewritten)
    for name in ("hostmetrics", "host_metrics/2"):
        repointed = Path(document["receivers"][name]["root_path"])
        assert repointed.parent == tmp_path and repointed.is_dir()
    # Another type, another section: untouched.
    assert document["receivers"]["otlp"]["root_path"] == "/c"
    assert document["exporters"]["hostmetrics"]["root_path"] == "/d"
    # Nothing to repoint: no rerun.
    assert _meet_requirements("receivers:\n  otlp: {}\n", [requirement], str(tmp_path)) is None


# Components that reach one directory through an anchor get one splice (two
# splices of one span would leave the text unreadable, refused as "could not
# be checked safely"). The fake collectors pass once no component
# names the missing directory.
SHARED_ROOT_PATH = """\
receivers:
  hostmetrics:
    root_path: &root /nonexistent-root
    scrapers:
      cpu: {}
  hostmetrics/slow:
    root_path: *root
    scrapers:
      disk: {}
exporters:
  debug: {}
service:
  pipelines:
    metrics:
      receivers: [hostmetrics, hostmetrics/slow]
      exporters: [debug]
"""

SHARED_STORAGE_DIRECTORY = """\
receivers:
  otlp:
    protocols:
      grpc: {}
exporters:
  debug: {}
extensions:
  file_storage:
    directory: &storage /nonexistent-storage
  file_storage/2:
    directory: *storage
service:
  extensions: [file_storage, file_storage/2]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
"""

_MISSING_ROOT_COLLECTOR = r"""cfg="${2#--config=}"
if grep -q /nonexistent-root "$cfg"; then
  echo "Error: receivers::hostmetrics: invalid root_path: stat /nonexistent-root: no such file or directory" >&2
  exit 1
fi
exit 0
"""

_MISSING_STORAGE_COLLECTOR = r"""cfg="${2#--config=}"
if grep -q /nonexistent-storage "$cfg"; then
  echo "Error: extensions::file_storage: directory must exist: stat /nonexistent-storage: no such file or directory. You can enable the create_directory option to automatically create it" >&2
  exit 1
fi
exit 0
"""


@pytest.mark.parametrize(
    ("collector", "text", "requirement"),
    [
        (_MISSING_ROOT_COLLECTOR, SHARED_ROOT_PATH, ("host_filesystem", "Mount the host filesystem at /nonexistent-root")),
        (_MISSING_STORAGE_COLLECTOR, SHARED_STORAGE_DIRECTORY, ("directory", "Ensure /nonexistent-storage exists at runtime")),
    ],
    ids=["root_path", "file_storage"],
)
async def test_one_directory_shared_through_an_anchor_is_repointed_once(
    binary_dir: Path, collector: str, text: str, requirement: tuple[str, str]
) -> None:
    binary = write_collector(binary_dir, "0.162.0", collector)

    result = await _check(binary, text)

    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [requirement]


def test_meet_requirements_splices_an_anchored_directory_once(tmp_path: Path) -> None:
    requirement = {"category": "host_filesystem", "title": "x", "description": "", "componentPath": None}

    met = _meet_requirements(SHARED_ROOT_PATH, [requirement], str(tmp_path))

    assert met is not None
    document = yaml.safe_load(met[0])
    repointed = document["receivers"]["hostmetrics"]["root_path"]
    assert document["receivers"]["hostmetrics/slow"]["root_path"] == repointed
    assert Path(repointed).parent == tmp_path
    assert len(list(tmp_path.iterdir())) == 1


# ---------------------------------------------------------------------------
# The reap shields its shared futures.
# ---------------------------------------------------------------------------


def test_stop_cancelled_once_still_ends_when_called_again() -> None:
    """A reap canceled while it awaits the shared `exited`/`finished` futures
    must not cancel the futures themselves, so a second reap of the same
    process still reaps and closes it. Under a hang guard: a broken shield
    leaves the second `_stop` hung."""

    async def scenario() -> tuple[bool, bool, bool]:
        transport, pipes = await asyncio.get_running_loop().subprocess_exec(
            lambda: _Pipes({1: 1024}),
            sys.executable,
            "-c",
            "import time; time.sleep(600)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        first = asyncio.ensure_future(_stop(transport, pipes))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        exited_cancelled = pipes.exited.cancelled()
        # The kill already landed; a second reap must complete and close it.
        await _stop(transport, pipes)
        closing = transport.get_pipe_transport(1)
        return exited_cancelled, transport.is_closing(), closing is None or closing.is_closing()

    exited_cancelled, transport_closed, pipe_closing = guard.in_thread(scenario)
    assert exited_cancelled is False  # the shield kept the shared future alive
    assert transport_closed is True  # the second reap closed it
    assert pipe_closing is True


# ---------------------------------------------------------------------------
# A placeholder-filled cause is never a requirement.
# ---------------------------------------------------------------------------

_DIRECTORY_CAUSE = (
    "directory must exist: stat {path}: no such file or directory. "
    "You can enable the create_directory option to automatically create it"
)


def test_a_cause_filled_by_the_validators_placeholder_is_not_a_requirement() -> None:
    cause = _DIRECTORY_CAUSE.format(path="/otelvalidatorplaceholder00000000")
    assert classify_cause(cause, "extensions::file_storage") is None


def test_a_cause_with_a_real_path_is_still_a_requirement() -> None:
    cause = _DIRECTORY_CAUSE.format(path="/var/lib/otel")
    requirement = classify_cause(cause, "extensions::file_storage")
    assert requirement is not None
    assert requirement["category"] == "directory"
