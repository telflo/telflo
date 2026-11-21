"""One check end to end with a fake collector (a shell script): the run's
failures and the protections a real subprocess exercises."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import signal
from pathlib import Path

import pytest

from app import runner
from app.runner import STOPPED_MESSAGE, exit_code, run_validation
from tests import guard
from tests.conftest import SECRET, write_collector


async def _check(binary: Path, yaml_content: str, *, timeout_seconds: int = 10):
    return await run_validation(
        binary,
        yaml_content,
        slots=asyncio.Semaphore(1),
        slot_wait_seconds=1.0,
        timeout_seconds=timeout_seconds,
    )


YAML = "receivers:\n  otlp:\n    protocols:\n      grpc:\n"


@pytest.mark.parametrize(("returncode", "expected"), [(-9, 137), (-15, 143), (-6, 134), (1, 1), (2, 2), (0, 0)])
def test_a_signal_is_reported_as_128_plus_n(returncode: int, expected: int) -> None:
    assert exit_code(returncode) == expected


async def test_a_sigkilled_collector_is_invalid_with_its_message(binary_dir: Path) -> None:
    """A crash's empty stderr is never no errors and valid."""
    binary = write_collector(binary_dir, "0.162.0", "kill -9 $$\n")

    result = await _check(binary, YAML)

    assert result.valid is False
    assert result.errors == [
        {"message": "The collector stopped without saying why (exit 137).", "componentPath": None}
    ]
    assert result.outcome == "crashed"


async def test_a_non_zero_exit_with_no_output_is_invalid(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", "exit 3\n")

    result = await _check(binary, YAML)

    assert result.valid is False
    assert result.errors == [{"message": STOPPED_MESSAGE.format(code=3), "componentPath": None}]


async def test_a_non_zero_exit_whose_output_names_no_error_is_invalid(binary_dir: Path) -> None:
    """Output that isn't an `Error:` block (log lines) names no error: never
    valid, and none of it reaches the answer."""
    binary = write_collector(
        binary_dir,
        "0.162.0",
        "echo '2026-10-06T10:00:00.000Z\tinfo\tsomething printed' >&2\nexit 1\n",
    )

    result = await _check(binary, YAML)

    assert result.valid is False
    assert result.errors == [{"message": STOPPED_MESSAGE.format(code=1), "componentPath": None}]


async def test_a_go_panic_is_invalid_with_the_stopped_message(binary_dir: Path) -> None:
    binary = write_collector(
        binary_dir,
        "0.162.0",
        "echo 'panic: runtime error: index out of range' >&2\necho 'goroutine 1 [running]:' >&2\nexit 2\n",
    )

    result = await _check(binary, YAML)

    assert result.valid is False
    assert result.errors == [{"message": STOPPED_MESSAGE.format(code=2), "componentPath": None}]


async def test_a_collector_past_the_time_limit_is_killed_and_reported(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", "exec sleep 30\n")

    # A hang guard, not a timing assertion: if the collector past its limit
    # were not killed, the check would hold the slot's task and `_check`
    # would never return; the generous bound's expiry is the failure, and
    # nothing asserts how fast the kill was.
    try:
        result = await asyncio.wait_for(_check(binary, YAML, timeout_seconds=1), timeout=guard.GUARD_SECONDS)
    except TimeoutError:
        pytest.fail("the check did not return: a collector past its limit was not killed")

    assert result.valid is False
    assert result.errors == [{"message": "Validation timed out after 1s", "componentPath": None}]


async def test_a_failure_that_is_only_requirements_is_valid_with_them(binary_dir: Path) -> None:
    """Every complaint a deployment
    requirement means a valid configuration with a checklist."""
    binary = write_collector(
        binary_dir,
        "0.162.0",
        "echo 'Error: extensions::file_storage: directory must exist: stat /var/lib/otel: "
        "no such file or directory. You can enable the create_directory option to automatically create it' >&2\n"
        "exit 1\n",
    )

    result = await _check(binary, YAML)

    assert result.valid is True
    assert result.errors == []
    assert [r["title"] for r in result.requirements] == ["Ensure /var/lib/otel exists at runtime"]


async def test_an_error_and_a_requirement_on_one_line_is_invalid(binary_dir: Path) -> None:
    binary = write_collector(
        binary_dir,
        "0.162.0",
        "echo 'Error: receivers::otlp: must specify at least one protocol; extensions::file_storage: "
        "directory must exist: stat /var/lib/otel: no such file or directory' >&2\nexit 1\n",
    )

    result = await _check(binary, YAML)

    assert result.valid is False
    assert [e["componentPath"] for e in result.errors] == ["receivers::otlp"]
    assert result.requirements == []


async def test_the_collector_never_sees_the_validators_secret(
    binary_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The collector prints its whole environment and the value it got for
    `${env:OTELCOL_VALIDATOR_SECRET}`: neither holds the secret."""
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRET", SECRET)
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRETS_PREVIOUS", "previous-" + SECRET)
    binary = write_collector(
        binary_dir,
        "0.162.0",
        'printf "Error: exporters::otlp: secret=%s\\n" "$OTELCOL_VALIDATOR_SECRET" >&2\n'
        "env | sed 's/^/exporters::otlp: env /' >&2\nexit 1\n",
    )

    result = await _check(binary, 'exporters:\n  otlp:\n    endpoint: "${env:OTELCOL_VALIDATOR_SECRET}"\n')

    answer = repr(result.errors) + repr(result.requirements)
    assert SECRET not in answer
    assert "secret=https://otelvalidatorplaceholder.invalid:4318" in answer
    assert "env PATH=" in answer  # the environment really was printed


async def test_a_file_provider_never_reaches_the_collector(binary_dir: Path) -> None:
    """The collector echoes the file it was given: no `${file:` survives,
    whatever the dollar run (the neutralization)."""
    binary = write_collector(binary_dir, "0.162.0", 'sed "s/^/Error: /" "${2#--config=}" >&2\nexit 1\n')
    text = (
        "exporters:\n"
        "  otlp:\n"
        '    endpoint: "${file:/etc/passwd}"\n'
        '    compression: "$$${file:/proc/1/environ}"\n'
        "    headers:\n"
        '      x: "${http://169.254.169.254/latest/meta-data/}"\n'
    )

    result = await _check(binary, text)

    echoed = " ".join(e["message"] for e in result.errors)
    assert "exporters:" in echoed  # the collector really echoed its file
    assert "file:" not in echoed
    assert "http:" not in echoed
    assert "/etc/passwd" not in echoed
    assert any(r["category"] == "confmap_provider" for r in result.requirements)


async def test_the_collector_is_run_without_a_shell_on_a_temporary_file_it_cannot_keep(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", 'echo "Error: $# $1 $2" >&2\nexit 1\n')

    result = await _check(binary, YAML)

    [error] = result.errors
    count, subcommand, config = error["message"].split(" ")
    assert (count, subcommand) == ("2", "validate")
    assert config.startswith("--config=") and config.endswith(".yaml")
    assert not Path(config[len("--config=") :]).exists()


async def test_a_tail_sampling_policy_without_conditions_is_an_error_even_when_validate_passes(
    binary_dir: Path,
) -> None:
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")
    text = (
        "processors:\n"
        "  tail_sampling:\n"
        "    policies:\n"
        "      - name: p\n"
        "        type: ottl_condition\n"
        "        ottl_condition:\n"
        "          error_mode: ignore\n"
    )

    result = await _check(binary, text)

    assert result.valid is False
    assert result.errors == [
        {
            "message": 'policy "p": expected at least one OTTL condition to filter on',
            "componentPath": "processors::tail_sampling",
        }
    ]


async def test_the_texts_requirements_reach_the_answer(binary_dir: Path) -> None:
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")
    text = (
        "receivers:\n"
        "  otlp:\n"
        "    protocols:\n"
        "      grpc:\n"
        "        tls:\n"
        "          cert_file: /etc/otel/server.crt\n"
        "  k8s_cluster:\n"
        "exporters:\n"
        "  file/out:\n"
        "    path: /var/log/otel/out.json\n"
        "    headers:\n"
        "      x: ${env:EXPORT_TOKEN}\n"
        "  otlp:\n"
        '    endpoint: "${org:COLLECTOR_HOST}"\n'
    )

    result = await _check(binary, text)

    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("organization_variable", "Unresolved organization variable: COLLECTOR_HOST"),
        ("env_var", "Set environment variable EXPORT_TOKEN"),
        ("tls_files", "Provide /etc/otel/server.crt on the host"),
        ("directory", "Directory /var/log/otel must exist"),
        ("k8s_in_cluster", "Runs inside a Kubernetes cluster"),
    ]


# ---------------------------------------------------------------------------
# A requirement never hides an error the collector echoes
# ---------------------------------------------------------------------------


async def test_a_key_named_like_a_requirement_is_an_error_end_to_end(binary_dir: Path) -> None:
    """The collector's recorded refusal of a receiver key named
    `envvar "X" is not set` is an error, never filed as
    `Set environment variable X` and answered valid."""
    case = json.loads((Path(__file__).parent / "fixtures" / "collector-outputs.json").read_text())["cases"][
        "echo-invalid-key"
    ]
    stderr = case["runs"]["0.162.0"]["stderr"]
    binary = write_collector(binary_dir, "0.162.0", f"printf '%s' {shlex.quote(stderr)} >&2\nexit 1\n")

    result = await _check(binary, case["yaml"])

    assert result.valid is False
    assert result.errors == [
        {
            "message": "'otlpreceiver.Config' has invalid keys: envvar \"X\" is not set",
            "componentPath": "receivers::otlp",
        }
    ]
    assert result.requirements == []


# ---------------------------------------------------------------------------
# A canceled check kills and reaps its collector
# ---------------------------------------------------------------------------


def _alive(pid: int) -> bool:
    """True while `pid` exists, a zombie (not yet reaped) included."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class _RecordingSlots(asyncio.Semaphore):
    """A one-slot semaphore that records, when the slot is released, what
    `probe()` returns then."""

    def __init__(self, probe) -> None:
        super().__init__(1)
        self.probe = probe
        self.at_release: list[object] = []

    def release(self) -> None:
        self.at_release.append(self.probe())
        super().release()


def test_a_cancelled_check_kills_and_reaps_its_collector_before_it_lets_go(
    binary_dir: Path, tmp_path: Path
) -> None:
    """The collector writes its pid and its config path, then runs (`exec`,
    so the pid is the collector's own) until killed. Canceling the check
    (a server shutdown, a dropped request) must leave no collector behind:
    it is killed and reaped before its temporary file goes and before the
    slot is released, not only on its time limit. Run
    under a hang guard."""
    pid_file = tmp_path / "collector.pid"
    config_file = tmp_path / "collector.config"
    binary = write_collector(
        binary_dir,
        "0.162.0",
        f'echo "${{2#--config=}}" > {config_file}\necho $$ > {pid_file}.part\n'
        f"mv {pid_file}.part {pid_file}\nexec sleep 30\n",
    )

    def state() -> tuple[bool, bool]:
        pid = int(pid_file.read_text())
        return _alive(pid), Path(config_file.read_text().strip()).exists()

    def cleanup() -> None:
        if pid_file.exists() and _alive(int(pid_file.read_text())):
            os.kill(int(pid_file.read_text()), signal.SIGKILL)  # never leave one behind

    async def scenario():
        slots = _RecordingSlots(state)
        check = asyncio.create_task(
            run_validation(binary, YAML, slots=slots, slot_wait_seconds=1.0, timeout_seconds=30)
        )
        for _ in range(2000):  # until the collector is running (polling, not a timing assertion)
            if pid_file.exists():
                break
            await asyncio.sleep(0.005)
        pid = int(pid_file.read_text())
        alive_before = _alive(pid)
        check.cancel()
        with pytest.raises(asyncio.CancelledError):
            await check
        return pid, alive_before, slots.at_release, slots.locked()

    try:
        pid, alive_before, at_release, locked = guard.in_thread(scenario, cleanup=cleanup)
    finally:
        cleanup()

    assert alive_before
    assert not _alive(pid)  # killed and reaped: not even a zombie
    # At the moment the slot was released: no collector, no file.
    assert at_release == [(False, False)]
    assert not locked


# ---------------------------------------------------------------------------
# The child's answer is checked, never trusted
# ---------------------------------------------------------------------------

_GOOD_ANSWER = {
    "valid": False,
    "errors": [{"message": "m", "componentPath": None}],
    "requirements": [{"category": "c", "title": "t", "description": "d", "componentPath": "receivers::x"}],
    "outcome": "failed",
}


def test_a_well_formed_answer_is_read() -> None:
    result = runner._decode_answer(json.dumps(_GOOD_ANSWER).encode(), 0)

    assert (result.valid, result.errors, result.requirements, result.outcome) == (
        False,
        _GOOD_ANSWER["errors"],
        _GOOD_ANSWER["requirements"],
        "failed",
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"valid": "yes"},
        {"valid": 1},
        {"errors": "m"},
        {"errors": [["m", None]]},
        {"errors": [{"message": 3, "componentPath": None}]},
        {"errors": [{"message": "m"}]},
        {"errors": [{"message": "m", "componentPath": None, "extra": 1}]},
        {"requirements": [{"category": "c", "title": "t", "description": None, "componentPath": None}]},
        {"requirements": {"category": "c"}},
        {"outcome": 7},
        {"outcome": "a line\nwith text"},
        {"extra": True},
    ],
    ids=lambda changes: ",".join(changes),
)
def test_an_answer_of_the_wrong_shape_is_a_check_failure(changes: dict) -> None:
    with pytest.raises(runner.CheckFailed) as raised:
        runner._decode_answer(json.dumps({**_GOOD_ANSWER, **changes}).encode(), 0)
    assert raised.value.kind == "malformed_answer"


@pytest.mark.parametrize(
    "answer",
    [
        b"[" * 100_000 + b"]" * 100_000,  # deeper than the decoder recurses
        b'{"errors": ' + b"[" * 100_000,
        b"not json",
        b"",
        b'"a string"',
    ],
    ids=["deep", "deep-unclosed", "not-json", "nothing", "not-an-object"],
)
def test_an_answer_that_isnt_one_is_a_check_failure(answer: bytes) -> None:
    with pytest.raises(runner.CheckFailed) as raised:
        runner._decode_answer(answer, -9)
    assert raised.value.kind == "child_exit_137"


def test_a_childs_failure_names_only_a_type() -> None:
    with pytest.raises(runner.CheckFailed) as raised:
        runner._decode_answer(b'{"failure": "ValueError"}', 0)
    assert raised.value.kind == "ValueError"
    with pytest.raises(runner.CheckFailed) as raised:
        runner._decode_answer(b'{"failure": "quoted text: x"}', 0)
    assert raised.value.kind == "unknown"
    with pytest.raises(runner.CollectorUnavailable):
        runner._decode_answer(b'{"failure": "FileNotFoundError", "unavailable": true}', 0)
