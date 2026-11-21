"""The check's own directory never reaches an answer, and the placeholder
directories it holds.

- Every hostmetrics root_path in one check is one directory (the collector
  refuses differing root_paths), whether the rerun repointed it or a
  `${env:}` placeholder filled it; file_storage directories get one per
  distinct value.
- Each placeholder directory's name carries the placeholder marker, and a
  check makes at most MAX_PLACEHOLDER_DIRECTORIES of them.
- No answer names the check's directory: every string is scrubbed to
  `<validator>`, and a requirement whose captured value lies under it is not
  emitted (an error, as with a placeholder).
- The check's directory is removed off the event loop; a removal that fails
  is logged by the error's type, naming no path.
- A collector output cut at the cap ends at its last complete line, so no
  fragment of a path the scrub can't recognize survives.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import threading
from pathlib import Path

import pytest
import yaml

from app import runner
from app.placeholders import (
    MAX_PLACEHOLDER_DIRECTORIES,
    PLACEHOLDER_DIRECTORY_PREFIX,
    _build_env_var_placeholders,
    _DEFAULT_PLACEHOLDER,
)
from app.runner import (
    _STDERR_MAX_BYTES,
    _STDERR_TRUNCATION_MARKER,
    PRIVATE_PATH_TOKEN,
    ValidationResult,
    _complete_lines,
    _meet_requirements,
    run_collector,
    run_validation,
    scrubbed,
)
from app.stderr import parse_stderr
from tests import guard
from tests.conftest import write_collector

METRICS = "exporters:\n  debug: {}\nservice:\n  pipelines:\n    metrics:\n      receivers: [%s]\n      exporters: [debug]\n"
TRACES = (
    "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\n"
    "service:\n  extensions: [%s]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n"
)


async def _check(binary: Path, text: str) -> ValidationResult:
    return await run_validation(binary, text, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10)


def _assert_private(result: ValidationResult) -> str:
    """The whole answer, as JSON, naming no check directory."""
    answer = json.dumps({"errors": result.errors, "requirements": result.requirements})
    assert "otelcol-check-" not in answer
    return answer


# ---- one root for hostmetrics ---------------------------------------------------

# Stats every root_path as hostmetrics does on Linux: differing ones are
# refused (the collector's own message), a missing one is a requirement.
ROOT_PATHS_COLLECTOR = r"""cfg="${2#--config=}"
paths=$(sed -n 's/.*root_path: *//p' "$cfg" | tr -d "\"'" | sort -u)
if [ "$(printf '%s\n' "$paths" | wc -l | tr -d ' ')" -gt 1 ]; then
  echo "Error: receivers::hostmetrics/slow: inconsistent root_path configuration detected among components: $(echo $paths)" >&2
  exit 1
fi
if [ ! -d "$paths" ]; then
  echo "Error: receivers::hostmetrics: invalid root_path: stat $paths: no such file or directory" >&2
  exit 1
fi
exit 0
"""

TWO_LITERAL_ROOT_PATHS = (
    "receivers:\n  hostmetrics:\n    root_path: /nonexistent-root\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/slow:\n    root_path: /nonexistent-root\n    scrapers:\n      disk: {}\n"
    + METRICS % "hostmetrics, hostmetrics/slow"
)


async def test_two_equal_literal_root_paths_are_repointed_to_one_directory(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", ROOT_PATHS_COLLECTOR)

    result = await _check(binary, TWO_LITERAL_ROOT_PATHS)

    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("host_filesystem", "Mount the host filesystem at /nonexistent-root")
    ]
    _assert_private(result)


# Passes only when both variables hold the same existing directory.
TWO_ROOT_VARIABLES_COLLECTOR = r"""if [ -n "$HOST_A" ] && [ "$HOST_A" = "$HOST_B" ] && [ -d "$HOST_A" ]; then exit 0; fi
echo "Error: receivers::hostmetrics/slow: inconsistent root_path configuration detected among components: \`$HOST_A\` != \`$HOST_B\`" >&2
exit 1
"""

TWO_ROOT_VARIABLES = (
    "receivers:\n  hostmetrics:\n    root_path: ${env:HOST_A}\n    scrapers:\n      cpu: {}\n"
    "  hostmetrics/slow:\n    root_path: ${env:HOST_B}\n    scrapers:\n      disk: {}\n"
    + METRICS % "hostmetrics, hostmetrics/slow"
)


async def test_two_root_path_variables_get_the_same_directory(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", TWO_ROOT_VARIABLES_COLLECTOR)

    result = await _check(binary, TWO_ROOT_VARIABLES)

    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("env_var", "Set environment variable HOST_A"),
        ("env_var", "Set environment variable HOST_B"),
    ]
    _assert_private(result)


def test_every_root_path_and_root_variable_is_one_placeholder_directory(tmp_path: Path) -> None:
    env_overlay, _ = _build_env_var_placeholders(TWO_ROOT_VARIABLES, directory=str(tmp_path))
    requirement = {"category": "host_filesystem", "title": "x", "description": "", "componentPath": None}
    met = _meet_requirements(TWO_LITERAL_ROOT_PATHS.replace("/nonexistent-root", "/a", 1), [requirement], str(tmp_path))

    assert met is not None
    receivers = yaml.safe_load(met[0])["receivers"]
    roots = {env_overlay["HOST_A"], env_overlay["HOST_B"], receivers["hostmetrics"]["root_path"]}
    assert roots == {receivers["hostmetrics/slow"]["root_path"]}
    [root] = roots
    assert Path(root).parent == tmp_path
    assert Path(root).name.startswith(PLACEHOLDER_DIRECTORY_PREFIX)
    assert [entry.name for entry in tmp_path.iterdir()] == [Path(root).name]


def test_file_storage_directories_are_one_per_distinct_value(tmp_path: Path) -> None:
    text = (
        "extensions:\n  file_storage:\n    directory: /a\n  file_storage/2:\n    directory: /a\n"
        "  file_storage/3:\n    directory: /b\n"
    )
    requirement = {"category": "directory", "title": "x", "description": "", "componentPath": None}

    met = _meet_requirements(text, [requirement], str(tmp_path))

    assert met is not None
    extensions = yaml.safe_load(met[0])["extensions"]
    first, second, third = (extensions[name]["directory"] for name in ("file_storage", "file_storage/2", "file_storage/3"))
    assert first == second != third
    assert {Path(path).parent for path in (first, third)} == {tmp_path}
    assert all(Path(path).name.startswith(PLACEHOLDER_DIRECTORY_PREFIX) for path in (first, third))


# ---- at most MAX_PLACEHOLDER_DIRECTORIES -------------------------------------------


def test_past_the_bound_directory_references_share_the_overflow_directory(tmp_path: Path) -> None:
    """Past the cap a directory reference still names an existing
    directory (one shared by every further key), never a string the
    collector's stat refuses."""
    count = MAX_PLACEHOLDER_DIRECTORIES + 2
    text = "extensions:\n" + "".join(
        f"  file_storage/{n}:\n    directory: ${{env:STORE_{n}}}\n" for n in range(count)
    )

    env_overlay, requirements = _build_env_var_placeholders(text, directory=str(tmp_path))

    assert MAX_PLACEHOLDER_DIRECTORIES == 64
    made = [env_overlay[f"STORE_{n}"] for n in range(count)]
    assert all(Path(path).parent == tmp_path and Path(path).is_dir() for path in made)
    assert all(Path(path).name.startswith(PLACEHOLDER_DIRECTORY_PREFIX) for path in made)
    own, overflow = made[:MAX_PLACEHOLDER_DIRECTORIES], made[MAX_PLACEHOLDER_DIRECTORIES:]
    assert len(set(own)) == MAX_PLACEHOLDER_DIRECTORIES
    assert len(set(overflow)) == 1 and overflow[0] not in own
    assert len(list(tmp_path.iterdir())) == MAX_PLACEHOLDER_DIRECTORIES + 1
    assert len(requirements) == count


def test_the_root_is_never_past_the_bound(tmp_path: Path) -> None:
    """The hostmetrics root's directory is reserved: after the cap's worth
    of other keys it is still its own, never the overflow."""
    stores = "".join(f"  file_storage/{n}:\n    directory: ${{env:STORE_{n}}}\n" for n in range(MAX_PLACEHOLDER_DIRECTORIES + 1))
    text = "extensions:\n" + stores + "receivers:\n  hostmetrics:\n    root_path: ${env:HOST_ROOT}\n"

    env_overlay, _ = _build_env_var_placeholders(text, directory=str(tmp_path))
    first_overlay, _ = _build_env_var_placeholders(TWO_ROOT_VARIABLES, directory=str(tmp_path))

    root, overflow = env_overlay["HOST_ROOT"], env_overlay[f"STORE_{MAX_PLACEHOLDER_DIRECTORIES}"]
    assert Path(root).is_dir() and Path(overflow).is_dir()
    assert root != overflow
    assert root not in [env_overlay[f"STORE_{n}"] for n in range(MAX_PLACEHOLDER_DIRECTORIES)]
    assert first_overlay["HOST_A"] == first_overlay["HOST_B"] == root
    assert len(list(tmp_path.iterdir())) == MAX_PLACEHOLDER_DIRECTORIES + 2


# Stats every file_storage directory and hostmetrics root_path as the real
# collector's validate stage does: while any is missing, its requirement
# (one line per kind, `Error: ` on the first only, as validate prints them)
# and a stop; once all exist, the build stage's error.
EVERY_DIRECTORY_COLLECTOR = r"""cfg="${2#--config=}"
prefix="Error: "
for dir in $(sed -n 's/^ *directory: *//p' "$cfg" | tr -d "\"'"); do
  if [ ! -d "$dir" ]; then
    echo "${prefix}extensions::file_storage: directory must exist: stat $dir: no such file or directory. You can enable the create_directory option to automatically create it" >&2
    prefix=""
    break
  fi
done
for root in $(sed -n 's/^ *root_path: *//p' "$cfg" | tr -d "\"'"); do
  if [ ! -d "$root" ]; then
    echo "${prefix}receivers::hostmetrics: invalid root_path: stat $root: no such file or directory" >&2
    prefix=""
    break
  fi
done
if [ -n "$prefix" ]; then
  echo 'Error: failed to build pipelines: failed to create "resourcedetection" processor, in pipeline "metrics": invalid detector key: no_such_detector' >&2
fi
exit 1
"""


def _masking(stores: int, root_path: bool) -> str:
    extensions = "".join(f"  file_storage/{n}:\n    directory: /var/lib/otel-nope-{n}\n" for n in range(stores))
    receivers = "  hostmetrics:\n    root_path: /nonexistent-root\n    scrapers:\n      cpu: {}\n" if root_path else ""
    return (
        "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n" + receivers
        + "processors:\n  resourcedetection:\n    detectors: [no_such_detector]\n"
        + "exporters:\n  debug: {}\nextensions:\n" + extensions
        + "service:\n  extensions: [" + ", ".join(f"file_storage/{n}" for n in range(stores)) + "]\n"
        + "  pipelines:\n    metrics:\n      receivers: [otlp" + (", hostmetrics" if root_path else "") + "]\n"
        + "      processors: [resourcedetection]\n      exporters: [debug]\n"
    )


@pytest.mark.parametrize(
    ("stores", "root_path"),
    [(MAX_PLACEHOLDER_DIRECTORIES + 1, False), (MAX_PLACEHOLDER_DIRECTORIES, True)],
    ids=["past-the-cap", "cap-then-root"],
)
async def test_past_the_bound_the_rerun_still_surfaces_the_build_error(binary_dir: Path, stores: int, root_path: bool) -> None:
    """Past the cap, a value the rerun left as written would stop it at the
    same requirement and keep the build error hidden (valid: true). Every
    value names a directory, so the build error is the answer's."""
    binary = write_collector(binary_dir, "0.162.0", EVERY_DIRECTORY_COLLECTOR)

    result = await _check(binary, _masking(stores, root_path))

    _assert_private(result)
    assert result.valid is False
    assert [e["message"] for e in result.errors] == [
        'failed to create "resourcedetection" processor, in pipeline "metrics": invalid detector key: no_such_detector'
    ]
    expected = [("directory", "Ensure /var/lib/otel-nope-0 exists at runtime")]
    if root_path:
        expected.append(("host_filesystem", "Mount the host filesystem at /nonexistent-root"))
    assert [(r["category"], r["title"]) for r in result.requirements] == expected


# ---- the check's directory never in an answer ---------------------------------------

STORAGE_COLLECTOR = r"""for value in "$BASE/queue" "$BASE/compaction"; do
  if grep -q "$(basename "$value")" "${2#--config=}" && [ ! -d "$value" ]; then
    echo "Error: extensions::file_storage: directory must exist: stat $value: no such file or directory. You can enable the create_directory option to automatically create it" >&2
    exit 1
  fi
done
exit 0
"""

WHOLE_THEN_PARTIAL = (
    "extensions:\n  file_storage:\n    directory: ${env:BASE}\n  file_storage/2:\n    directory: ${env:BASE}/queue\n"
    + TRACES % "file_storage, file_storage/2"
)
COMPACTION = (
    "extensions:\n  file_storage:\n    directory: ${env:BASE}\n    compaction:\n      on_start: true\n"
    "      directory: ${env:BASE}/compaction\n" + TRACES % "file_storage"
)


@pytest.mark.parametrize(("text", "tail"), [(WHOLE_THEN_PARTIAL, "queue"), (COMPACTION, "compaction")], ids=["partial", "compaction"])
async def test_a_path_under_a_placeholder_directory_is_an_error_naming_no_check_directory(
    binary_dir: Path, text: str, tail: str
) -> None:
    binary = write_collector(binary_dir, "0.162.0", STORAGE_COLLECTOR)

    result = await _check(binary, text)

    _assert_private(result)
    assert result.valid is False
    [error] = result.errors
    assert error["componentPath"] == "extensions::file_storage"
    assert error["message"].startswith(f"directory must exist: stat {PRIVATE_PATH_TOKEN}/{PLACEHOLDER_DIRECTORY_PREFIX}")
    assert f"/{tail}: no such file or directory" in error["message"]
    assert [(r["category"], r["title"]) for r in result.requirements] == [("env_var", "Set environment variable BASE")]


DIRECTORY_CAUSE = (
    "Error: extensions::file_storage: directory must exist: stat {path}: no such file or directory. "
    "You can enable the create_directory option to automatically create it\n"
)


def test_a_requirement_under_a_private_path_is_not_emitted() -> None:
    parsed = parse_stderr(DIRECTORY_CAUSE.format(path="/tmp/otelcol-check-abc/x"), None, ("/tmp/otelcol-check-abc",))

    assert parsed.requirements == []
    assert [error["componentPath"] for error in parsed.errors] == ["extensions::file_storage"]
    # Elsewhere, the same cause is still a requirement.
    assert [r["title"] for r in parse_stderr(DIRECTORY_CAUSE.format(path="/var/lib/x"), None, ("/tmp/otelcol-check-abc",)).requirements] == [
        "Ensure /var/lib/x exists at runtime"
    ]


def test_every_string_of_an_answer_is_scrubbed(tmp_path: Path) -> None:
    directory = str(tmp_path / "otelcol-check-x")
    resolved = str(Path(directory).resolve())
    result = ValidationResult(
        valid=False,
        errors=[{"message": f"a {directory}/b and {resolved}/c", "componentPath": f"x::{directory}"}],
        requirements=[{"category": "c", "title": directory, "description": f"{resolved}", "componentPath": None}],
        outcome="failed",
    )

    clean = scrubbed(result, directory)

    assert clean.errors == [
        {"message": f"a {PRIVATE_PATH_TOKEN}/b and {PRIVATE_PATH_TOKEN}/c", "componentPath": f"x::{PRIVATE_PATH_TOKEN}"}
    ]
    assert clean.requirements == [
        {"category": "c", "title": PRIVATE_PATH_TOKEN, "description": PRIVATE_PATH_TOKEN, "componentPath": None}
    ]
    assert (clean.valid, clean.outcome) == (False, "failed")
    assert scrubbed(result, None) is result


# ---- the directory is removed off the event loop ------------------------------------


def test_the_check_directory_is_removed_off_the_event_loop(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """While the removal is under way, the loop still serves (here: the
    health check); the removal finishes only once the loop has answered. On
    the loop, the removal would wait for an answer the blocked loop can't
    give: the release never comes and the test fails (a guard, not a timing
    assertion)."""
    from app.main import create_app
    from tests.conftest import call_asgi, make_settings

    directory = tmp_path / "otelcol-check-big"
    directory.mkdir()
    started = threading.Event()
    released = threading.Event()
    outcome: dict[str, bool] = {}
    real_rmtree = shutil.rmtree

    def slow_rmtree(path: str, **options: object) -> None:
        started.set()
        outcome["released"] = released.wait(10)
        real_rmtree(path, **options)  # type: ignore[arg-type]

    monkeypatch.setattr(runner.shutil, "rmtree", slow_rmtree)
    app = create_app(make_settings(tmp_path))

    async def scenario() -> int | None:
        ending = asyncio.ensure_future(runner._end_check(None, str(directory)))
        while not started.is_set() and not ending.done():
            await asyncio.sleep(0)
        health = await call_asgi(app, "GET", "/health", {}, [])
        released.set()
        await ending
        return health.status

    status = guard.in_thread(scenario)

    assert status == 200
    assert outcome == {"released": True}
    assert not directory.exists()


def test_a_failed_removal_is_logged_naming_no_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = str(tmp_path / "otelcol-check-stuck")

    def refusing_rmtree(path: str, **_options: object) -> None:
        raise PermissionError(13, "Permission denied", path)

    monkeypatch.setattr(runner.shutil, "rmtree", refusing_rmtree)

    with caplog.at_level(logging.WARNING, logger="app.runner"):
        cancelled = guard.in_thread(lambda: runner._end_check(None, directory))

    assert cancelled is False
    assert [record.getMessage() for record in caplog.records] == [
        "a check's directory could not be removed (PermissionError)"
    ]
    assert "otelcol-check" not in caplog.text


def test_a_directory_already_gone_is_no_failure(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    directory = tmp_path / "otelcol-check-gone"

    with caplog.at_level(logging.WARNING, logger="app.runner"):
        guard.in_thread(lambda: runner._end_check(None, str(directory)))

    assert caplog.records == []


# ---- a cut output keeps complete lines only -----------------------------------------


def test_complete_lines_drops_a_partial_last_line() -> None:
    assert _complete_lines(b"one\ntwo\nthr") == b"one\ntwo\n"
    assert _complete_lines(b"one\ntwo\n") == b"one\ntwo\n"
    assert _complete_lines(b"no line break") == b""
    assert _complete_lines(b"") == b""


async def test_a_cut_output_ends_at_its_last_complete_line(binary_dir: Path) -> None:
    """A first line of 100 bytes, then lines of 7: the cap falls inside a
    line, which is dropped before the marker."""
    assert (_STDERR_MAX_BYTES - 100) % 7 != 0
    script = (
        "{ head -c 99 /dev/zero | tr '\\0' '#'; echo; yes abcdef | head -c %d; } >&2\nexit 1\n"
        % (_STDERR_MAX_BYTES + 70_000)
    )
    binary = write_collector(binary_dir, "0.162.0", script)

    outcome = await run_collector(binary, "x: 1\n", {}, timeout_seconds=10)

    marker = _STDERR_TRUNCATION_MARKER.decode()
    assert outcome.stderr.endswith(marker)
    kept = outcome.stderr[: -len(marker)]
    first, *rest = kept.split("\n")
    assert first == "#" * 99
    assert rest[-1] == ""  # it ended with a line break
    assert set(rest[:-1]) == {"abcdef"}
    assert len(kept) == 100 + 7 * ((_STDERR_MAX_BYTES - 100) // 7)


# Floods stderr with lines naming its working directory (the check's own),
# padded so that the cap falls in the middle of that path.
CUT_PATH_COLLECTOR = r"""prefix="Error: extensions::file_storage: directory must exist: stat "
line="${prefix}$PWD/queue: no such file or directory"
length=$((${#line} + 1))
target=$((${#prefix} + ${#PWD} / 2))
pad=$(( (CAP - target) % length ))
{
  if [ "$pad" -gt 0 ]; then head -c $((pad - 1)) /dev/zero | tr '\0' '#'; echo; fi
  i=0
  while [ $i -lt $((CAP / length + 3)) ]; do echo "$line"; i=$((i + 1)); done
} >&2
exit 1
""".replace("CAP", str(_STDERR_MAX_BYTES))


async def test_no_fragment_of_the_check_directory_survives_a_cut(binary_dir: Path) -> None:
    """The cap can cut a line inside the check's path, and the scrub, which
    replaces whole paths only, would leave its start in the answer. Every
    path left in the answer is the token's."""
    binary = write_collector(binary_dir, "0.162.0", CUT_PATH_COLLECTOR)

    result = await _check(binary, "x: 1\n")

    answer = _assert_private(result)
    assert result.valid is False
    assert PRIVATE_PATH_TOKEN in answer
    assert "/" not in re.sub(re.escape(PRIVATE_PATH_TOKEN) + r"/queue", "", answer)
