"""A smoke check against the real collectors (marked `binary`, deselected by
default): for every offered version whose `otelcol-contrib` is under
OTELCOL_BINARY_DIR, a valid text is valid and an unknown component is refused
with its path. It runs inside the image (`pytest -m binary`); the renames are
test_binary_renames.py's, the palette's defaults test_binary_palette.py's,
the routing and failover cases test_binary_connectors.py's and the component
forms' cases test_binary_handoffs.py's. A version the image was built to hold
must be held (tests/binary_support.py)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.catalog import binary_path
from app.runner import _Prepared, _prepare
from tests.binary_support import BINARY_DIR, OFFERED, check, expected_versions, held

pytestmark = pytest.mark.binary

VALID = """\
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  debug:
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
"""

UNKNOWN = VALID.replace("  debug:\n", "  debug:\n  nosuchexporter/my-exp.v2:\n").replace(
    "exporters: [debug]", "exporters: [debug, nosuchexporter/my-exp.v2]"
)


def test_the_binary_directory_holds_at_least_one_offered_version() -> None:
    assert any(binary_path(BINARY_DIR, version).is_file() for version in OFFERED), BINARY_DIR


def test_every_version_the_image_was_built_with_is_held() -> None:
    """With OTELCOL_EXPECTED_VERSIONS set (the image's `test`
    target sets it to its OTELCOL_VERSIONS), every version it names is
    offered and held, so no binary test skips one silently."""
    expected = expected_versions()
    assert set(expected) <= set(OFFERED), f"not offered: {sorted(set(expected) - set(OFFERED))}"
    assert [version for version in expected if not held(version)] == []


def test_the_expected_versions_are_read_as_the_build_argument_is() -> None:
    assert expected_versions("") == []
    assert expected_versions("all") == OFFERED
    assert expected_versions("default") in ([version] for version in OFFERED)
    assert expected_versions(" 0.161.0, 0.162.0 ") == ["0.161.0", "0.162.0"]


_check = check


@pytest.mark.parametrize("version", OFFERED)
async def test_a_valid_text_is_valid(version: str) -> None:
    result = await _check(version, VALID)

    assert result.errors == []
    assert result.valid is True


@pytest.mark.parametrize("version", OFFERED)
async def test_an_unknown_component_is_refused_with_its_path(version: str) -> None:
    result = await _check(version, UNKNOWN)

    assert result.valid is False
    assert result.errors == [
        {
            "message": 'unknown type: "nosuchexporter" for id: "nosuchexporter/my-exp.v2"',
            "componentPath": "exporters::nosuchexporter/my-exp.v2",
        }
    ]


# A probe on the real collector: a receiver key literally named like a
# requirement is an invalid key (never filed as `Set environment variable X`
# and answered valid).
ECHOED_KEY = VALID.replace(
    "        endpoint: 0.0.0.0:4317\n", "        endpoint: 0.0.0.0:4317\n    'envvar \"X\" is not set': 1\n"
)


@pytest.mark.parametrize("version", OFFERED)
async def test_a_key_named_like_a_requirement_is_an_error(version: str) -> None:
    result = await _check(version, ECHOED_KEY)

    assert result.valid is False
    assert result.errors == [
        {
            "message": "'otlpreceiver.Config' has invalid keys: envvar \"X\" is not set",
            "componentPath": "receivers::otlp",
        }
    ]
    assert result.requirements == []


# Bypasses (a key or value that closes the collector's unescaped '…' early,
# or one it echoes unquoted), end to end on the real collector: each would
# be answered valid, a requirement hiding the only error, without the
# guards.
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "collector-outputs.json").read_text())["cases"]
BYPASSES = (
    "echo-headers-key-stat",
    "echo-headers-key-envvar",
    "echo-headers-key-bracket-stat",
    "echo-start-at-stat",
    "echo-encoding-stat",
    "echo-operator-type-stat",
    "echo-error-mode-stat",
    "echo-detector-envvar",
    "echo-detector-stat",
    # Bypasses through the collector's own substitution, and through texts
    # PyYAML refuses.
    *sorted(case for case in FIXTURES if case.startswith("bypass-")),
)


def _the_texts_own_requirements(text: str) -> list[dict]:
    """What the pre-processing reads from the text itself (`${env:}`,
    providers), never from the collector's output."""
    prepared = _prepare(text)
    return prepared.before + prepared.env_requirements + prepared.scanned_requirements


@pytest.mark.parametrize("case", BYPASSES)
@pytest.mark.parametrize("version", OFFERED)
async def test_a_requirement_phrase_from_the_text_never_hides_an_error(version: str, case: str) -> None:
    text = FIXTURES[case]["yaml"]
    prepared = _prepare(text)
    result = await _check(version, text)

    assert result.valid is False
    if not isinstance(prepared, _Prepared):
        # A text PyYAML can't read as one document (a second document the
        # collector would have loaded on its own) is answered invalid without
        # running the collector; no requirement is produced, so no
        # requirement can hide the error.
        assert prepared.outcome == "unreadable"
        assert result.outcome == "unreadable"
        assert len(result.errors) == 1
        assert result.requirements == []
        return
    assert len(result.errors) == 1
    assert result.requirements == _the_texts_own_requirements(text)


# The real requirement outputs the templates are taken from, end to end: each
# is a requirement, and the text is valid. The k8snode detector's
# service-account output is darwin's: in the image (Linux, the service
# account staged) `validate` prints nothing for that text, and its
# requirement is the text's own, "Runs inside a Kubernetes cluster"
# (collector-outputs-linux.json's linux-rd-k8snode-service-account).
# hostmetrics' root_path prints its requirement on Linux only.
LINUX_FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "collector-outputs-linux.json").read_text())[
    "cases"
]
REQUIREMENTS = {
    "req-file-storage-directory": ("directory", "Ensure /var/lib/otelcol-missing/fs exists at runtime"),
    "req-k8sattr-node-env-custom": ("env_var", "Set environment variable MY_CUSTOM_NODE"),
    "req-rd-k8snode-service-account": (
        ("k8s_in_cluster", "Mount a Kubernetes service account")
        if sys.platform == "darwin"
        else ("k8s_in_cluster", "Runs inside a Kubernetes cluster")
    ),
}
LINUX_REQUIREMENTS = {
    "req-hostmetrics-root-path": ("host_filesystem", "Mount the host filesystem at /nonexistent-root"),
}


@pytest.mark.parametrize("case", sorted(REQUIREMENTS))
@pytest.mark.parametrize("version", OFFERED)
async def test_a_real_requirement_is_a_requirement(version: str, case: str) -> None:
    result = await _check(version, FIXTURES[case]["yaml"])

    assert result.errors == []
    assert result.valid is True
    assert REQUIREMENTS[case] in [(r["category"], r["title"]) for r in result.requirements]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("case", sorted(LINUX_REQUIREMENTS))
@pytest.mark.parametrize("version", OFFERED)
async def test_a_real_linux_requirement_is_a_requirement(version: str, case: str) -> None:
    result = await _check(version, LINUX_FIXTURES[case]["yaml"])

    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [LINUX_REQUIREMENTS[case]]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_the_service_account_template_prints_nothing_in_the_image(version: str) -> None:
    """The darwin template's text, in the image: `validate` passes (the
    service account is staged), so the only requirement is the text's own."""
    result = await _check(version, LINUX_FIXTURES["linux-rd-k8snode-service-account"]["yaml"])

    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("k8s_in_cluster", "Runs inside a Kubernetes cluster")
    ]


# hostmetrics' root_path, a validate-stage requirement, stopped the collector
# before the build stage; the rerun points it at a fresh directory and the
# build error it hid surfaces.
ROOT_PATH_MASKING = """\
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


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_a_build_error_root_path_masked_surfaces_with_its_requirement(version: str) -> None:
    result = await _check(version, ROOT_PATH_MASKING)

    assert result.valid is False
    assert result.errors == [
        {
            "message": 'failed to create "resourcedetection" processor, in pipeline "metrics": '
            "invalid detector key: no_such_detector",
            "componentPath": "processors::resourcedetection",
        }
    ]
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("host_filesystem", "Mount the host filesystem at /nonexistent-root")
    ]


# Past the nesting bound the collector isn't run.
async def test_a_text_nested_too_deep_is_invalid_without_the_collector() -> None:
    held_versions = [version for version in OFFERED if held(version)]
    if not held_versions:
        pytest.skip(f"no offered version is held in {BINARY_DIR}")
    result = await _check(held_versions[0], VALID + "x: " + "[" * 1_000 + "]" * 1_000 + "\n")

    assert result.errors == [{"message": "The configuration nests too deeply.", "componentPath": None}]
    assert result.outcome == "too_deep"


# One directory reached through an anchor is repointed once (two splices of
# its span would answer "could not be checked safely"), and a
# directory-valued `${env:}` reference gets a fresh directory inside the
# check's own (a string placeholder would be an error naming it).
METRICS_TO_DEBUG = "exporters:\n  debug: {}\nservice:\n  pipelines:\n    metrics:\n      receivers: [%s]\n      exporters: [debug]\n"
SHARED_ROOT_PATH = (
    "receivers:\n  hostmetrics:\n    root_path: &root /nonexistent-root\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/slow:\n    root_path: *root\n    collection_interval: 5m\n    scrapers:\n      disk: {}\n"
    + METRICS_TO_DEBUG % "hostmetrics, hostmetrics/slow"
)
ROOT_PATH_FROM_ENV = (
    "receivers:\n  hostmetrics:\n    root_path: ${env:HOST_ROOT}\n    scrapers:\n      cpu: {}\n"
    + METRICS_TO_DEBUG % "hostmetrics"
)
TRACES_TO_DEBUG = (
    "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\n"
    "service:\n  extensions: [%s]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n"
)
SHARED_STORAGE_DIRECTORY = (
    "extensions:\n  file_storage:\n    directory: &storage /var/lib/otelcol/not-created-by-the-image\n"
    "  file_storage/2:\n    directory: *storage\n" + TRACES_TO_DEBUG % "file_storage, file_storage/2"
)
STORAGE_DIRECTORY_FROM_ENV = "extensions:\n  file_storage:\n    directory: ${env:STORAGE_DIR}\n" + TRACES_TO_DEBUG % "file_storage"


def _summary(result) -> list[tuple[str, str]]:  # noqa: ANN001
    assert "otelvalidatorplaceholder" not in json.dumps(result.errors + result.requirements)
    return [(r["category"], r["title"]) for r in result.requirements]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_hostmetrics_sharing_a_root_path_anchor_is_valid_with_its_requirement(version: str) -> None:
    result = await _check(version, SHARED_ROOT_PATH)

    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [("host_filesystem", "Mount the host filesystem at /nonexistent-root")]


@pytest.mark.parametrize("version", OFFERED)
async def test_file_storage_sharing_a_directory_anchor_is_valid_with_its_requirement(version: str) -> None:
    result = await _check(version, SHARED_STORAGE_DIRECTORY)

    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [("directory", "Ensure /var/lib/otelcol/not-created-by-the-image exists at runtime")]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_a_root_path_from_an_env_reference_is_valid_with_its_requirement(version: str) -> None:
    result = await _check(version, ROOT_PATH_FROM_ENV)

    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [("env_var", "Set environment variable HOST_ROOT")]


@pytest.mark.parametrize("version", OFFERED)
async def test_a_storage_directory_from_an_env_reference_is_valid_with_its_requirement(version: str) -> None:
    result = await _check(version, STORAGE_DIRECTORY_FROM_ENV)

    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [("env_var", "Set environment variable STORAGE_DIR")]


# Every hostmetrics root_path in a check is one directory, and no answer
# names the check's own directory (its strings scrubbed to `<validator>`; a
# requirement under it not emitted).
TWO_LITERAL_ROOT_PATHS = (
    "receivers:\n  hostmetrics:\n    root_path: /nonexistent-root\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/slow:\n    root_path: /nonexistent-root\n    scrapers:\n      disk: {}\n"
    + METRICS_TO_DEBUG % "hostmetrics, hostmetrics/slow"
)
TWO_ROOT_VARIABLES = (
    "receivers:\n  hostmetrics:\n    root_path: ${env:HOST_A}\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/slow:\n    root_path: ${env:HOST_B}\n    scrapers:\n      disk: {}\n"
    + METRICS_TO_DEBUG % "hostmetrics, hostmetrics/slow"
)
ROOT_WHOLE_THEN_PARTIAL = (
    "receivers:\n  hostmetrics:\n    root_path: ${env:R}\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/2:\n    root_path: ${env:R}/host\n    scrapers:\n      cpu: {}\n"
    + METRICS_TO_DEBUG % "hostmetrics, hostmetrics/2"
)
STORAGE_WHOLE_THEN_PARTIAL = (
    "extensions:\n  file_storage:\n    directory: ${env:BASE}\n  file_storage/2:\n    directory: ${env:BASE}/queue\n"
    + TRACES_TO_DEBUG % "file_storage, file_storage/2"
)
STORAGE_COMPACTION = (
    "extensions:\n  file_storage:\n    directory: ${env:BASE}\n    compaction:\n      on_start: true\n"
    "      directory: ${env:BASE}/compaction\n" + TRACES_TO_DEBUG % "file_storage"
)


def _private(result) -> None:  # noqa: ANN001
    """No string of the answer names the check's directory, and every error
    naming a placeholder directory names it as `<validator>/…`."""
    answer = json.dumps({"errors": result.errors, "requirements": result.requirements})
    assert "otelcol-check-" not in answer
    assert "/tmp/" not in answer
    for error in result.errors:
        message = error["message"]
        named = message.count("otelvalidatorplaceholder-")
        assert message.count("<validator>/otelvalidatorplaceholder-") == named, message


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_two_equal_literal_root_paths_are_valid_with_their_requirement(version: str) -> None:
    result = await _check(version, TWO_LITERAL_ROOT_PATHS)

    _private(result)
    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [("host_filesystem", "Mount the host filesystem at /nonexistent-root")]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_two_root_path_variables_are_valid_with_both_requirements(version: str) -> None:
    result = await _check(version, TWO_ROOT_VARIABLES)

    _private(result)
    assert result.errors == []
    assert result.valid is True
    assert _summary(result) == [
        ("env_var", "Set environment variable HOST_A"),
        ("env_var", "Set environment variable HOST_B"),
    ]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
@pytest.mark.parametrize("version", OFFERED)
async def test_a_root_path_under_the_root_placeholder_names_no_check_directory(version: str) -> None:
    """`${env:R}` and `${env:R}/host` differ, as the collector says at start
    too: an error, its paths `<validator>/…`, and no requirement for them."""
    result = await _check(version, ROOT_WHOLE_THEN_PARTIAL)

    _private(result)
    assert result.valid is False
    assert any("inconsistent root_path configuration" in error["message"] for error in result.errors)
    assert [(r["category"], r["title"]) for r in result.requirements] == [("env_var", "Set environment variable R")]


@pytest.mark.parametrize("case", ["partial", "compaction"])
@pytest.mark.parametrize("version", OFFERED)
async def test_a_storage_path_under_a_placeholder_names_no_check_directory(version: str, case: str) -> None:
    text, tail, path = {
        "partial": (STORAGE_WHOLE_THEN_PARTIAL, "queue", "extensions::file_storage/2"),
        "compaction": (STORAGE_COMPACTION, "compaction", "extensions::file_storage"),
    }[case]

    result = await _check(version, text)

    _private(result)
    assert result.valid is False
    [error] = result.errors
    assert error["componentPath"] == path
    assert error["message"].startswith("directory must exist: stat <validator>/otelvalidatorplaceholder-")
    assert f"/{tail}: no such file or directory" in error["message"]
    assert [(r["category"], r["title"]) for r in result.requirements] == [("env_var", "Set environment variable BASE")]


# Past the cap on placeholder directories, every further value shares the
# overflow directory and the root keeps its own, so the rerun still meets
# every directory and the build error the validate stage hid surfaces (past
# the cap it was left as written: valid, the error hidden).
def _past_the_cap(stores: int, root_path: bool) -> str:
    extensions = "".join(f"  file_storage/{n}:\n    directory: /var/lib/otel-nope-{n}\n" for n in range(stores))
    hostmetrics = "  hostmetrics:\n    root_path: /nonexistent-root\n    scrapers:\n      cpu: {}\n" if root_path else ""
    return (
        "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n" + hostmetrics
        + "processors:\n  resourcedetection:\n    detectors: [no_such_detector]\n"
        + "exporters:\n  debug: {}\nextensions:\n" + extensions
        + "service:\n  extensions: [" + ", ".join(f"file_storage/{n}" for n in range(stores)) + "]\n"
        + "  pipelines:\n    metrics:\n      receivers: [otlp" + (", hostmetrics" if root_path else "") + "]\n"
        + "      processors: [resourcedetection]\n      exporters: [debug]\n"
    )


@pytest.mark.parametrize(
    ("stores", "root_path"),
    [
        (65, False),
        pytest.param(
            64, True, marks=pytest.mark.skipif(sys.platform != "linux", reason="Linux's outputs (the image)")
        ),
    ],
    ids=["past-the-cap", "cap-then-root"],
)
@pytest.mark.parametrize("version", OFFERED)
async def test_past_the_cap_a_masked_build_error_still_surfaces(version: str, stores: int, root_path: bool) -> None:
    result = await _check(version, _past_the_cap(stores, root_path))

    _private(result)
    assert result.valid is False
    assert result.errors == [
        {
            "message": 'failed to create "resourcedetection" processor, in pipeline "metrics": '
            "invalid detector key: no_such_detector",
            "componentPath": "processors::resourcedetection",
        }
    ]
    categories = {r["category"] for r in result.requirements}
    assert categories == ({"directory", "host_filesystem"} if root_path else {"directory"})


def _aliased_multiline_key(lines: int, pipelines: int) -> str:
    """A probe: a pipeline with a key of `lines` lines, aliased into
    `pipelines` pipelines; the collector echoes the key per pipeline, a line
    each."""
    key = '"zz' + "\\nq" * lines + '"'
    text = [
        "receivers:",
        "  otlp:",
        "    protocols:",
        "      grpc:",
        "exporters:",
        "  debug:",
        "service:",
        "  pipelines:",
        "    traces: &p",
        "      receivers: [otlp]",
        "      exporters: [debug]",
        f"      ? {key}",
        "      : 1",
    ]
    text += [f"    traces/{index}: *p" for index in range(1, pipelines)]
    return "\n".join(text) + "\n"


@pytest.mark.parametrize("version", OFFERED)
async def test_a_key_echoed_per_pipeline_answers_at_most_201_errors(version: str) -> None:
    """Unbounded, 0.162.0 printed 130,746 errors (4.61 MiB) for this text."""
    from app.runner import MORE_ERRORS_MESSAGE

    result = await check(version, _aliased_multiline_key(12_000, 12))

    assert result.valid is False
    assert len(result.errors) == 201
    assert result.errors[-1] == {"message": MORE_ERRORS_MESSAGE, "componentPath": None}
    assert all(len(error["message"]) <= 4_096 for error in result.errors)
