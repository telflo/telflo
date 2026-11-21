"""What the answer bounds: an answer's requirements (each once, at most 200),
the path parts (matched whole, ASCII digits only, as openapi.yaml's patterns
read) and the removal of a check's directory (carried on past a failure, logged
by the errors' types only)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import runner
from app.main import create_app
from app.runner import MAX_REQUIREMENTS, ValidationResult, bounded, run_validation
from tests import guard
from tests.conftest import PASSING_COLLECTOR, auth_headers, make_settings, write_collector


def requirement(title: str, component_path: str | None = None, category: str = "env_var") -> dict:
    return {"category": category, "title": title, "description": "d", "componentPath": component_path}


# ---- requirements: each once, at most 200 --------------------------------------------


def test_bounded_keeps_each_requirement_once_by_category_title_and_component_path() -> None:
    first = requirement("Set environment variable A", "exporters::otlp")
    again = {**first, "description": "another description"}
    elsewhere = requirement("Set environment variable A", "receivers::otlp")
    unplaced = requirement("Set environment variable A")
    other_category = requirement("Set environment variable A", "exporters::otlp", category="secret")
    result = ValidationResult(valid=True, requirements=[first, again, elsewhere, unplaced, other_category, first])

    assert bounded(result).requirements == [first, elsewhere, unplaced, other_category]


def test_bounded_keeps_the_first_200_and_leaves_the_rest_of_the_answer() -> None:
    errors = [{"message": "m", "componentPath": None}]
    many = [requirement(f"Set environment variable V{index}") for index in range(450)]
    result = ValidationResult(valid=False, errors=errors, requirements=many, outcome="failed")

    answer = bounded(result)

    assert MAX_REQUIREMENTS == 200
    assert answer.requirements == many[:200]
    assert (answer.valid, answer.errors, answer.outcome) == (False, errors, "failed")


def org_references(count: int) -> str:
    """A text whose one value names `count` organization variables: each its
    own requirement (an amplification probe)."""
    references = "".join(f"${{org:v{index}}}" for index in range(count))
    return f"receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: {references}\n"


def test_a_text_naming_thousands_of_variables_answers_200_requirements(binary_dir: Path) -> None:
    """20,000 `${org:}` references would answer 5.1 MiB unbounded, over the
    platform's 4 MiB; bounded, 200 requirements, the first ones named."""
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    text = org_references(18_000)
    assert len(text) <= 262_144

    with TestClient(create_app(make_settings(binary_dir))) as client:
        response = client.post("/validator/v1/validate/otelcol-contrib/0.162.0", json={"yaml": text}, headers=auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert len(body["requirements"]) == 200
    assert body["requirements"][0]["title"] == "Unresolved organization variable: v0"
    assert body["requirements"][-1]["title"] == "Unresolved organization variable: v199"
    assert len(response.content) < 256 * 1024


async def test_the_service_bounds_the_childs_answer_too(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The child bounds its answer; the service bounds whatever the child
    answered as well (as it scrubs it twice)."""
    binary = write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    many = [requirement(f"Set environment variable V{index}") for index in range(300)]
    real_decode = runner._decode_answer

    def decode_with_more(answer: bytes, returncode: int | None) -> ValidationResult:
        decoded = real_decode(answer, returncode)
        return ValidationResult(valid=decoded.valid, errors=decoded.errors, requirements=many + many, outcome=decoded.outcome)

    monkeypatch.setattr(runner, "_decode_answer", decode_with_more)

    result = await run_validation(
        binary, "receivers: {}\n", slots=asyncio.Semaphore(1), slot_wait_seconds=5.0, timeout_seconds=10
    )

    assert result.requirements == many[:200]


# ---- the path's parts: whole, ASCII ---------------------------------------------------


@pytest.mark.parametrize(
    ("path", "message"),
    [
        ("/validator/v1/validate/otelcol-contrib/0.162.0%0A", "The version must be major.minor.patch."),
        ("/validator/v1/validate/otelcol-contrib/%D9%A0.162.0", "The version must be major.minor.patch."),
        ("/validator/v1/validate/otelcol-contrib/0.%EF%BC%91%EF%BC%96%EF%BC%92.0", "The version must be major.minor.patch."),
        (
            "/validator/v1/validate/otelcol-contrib%0A/0.162.0",
            "The distribution must be lowercase words joined by single hyphens.",
        ),
    ],
    ids=["trailing-line-break", "arabic-indic-digit", "fullwidth-digits", "distribution-line-break"],
)
def test_a_path_part_with_a_line_break_or_a_non_ascii_digit_is_invalid(binary_dir: Path, path: str, message: str) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        response = client.post(path, json={"yaml": "a: 1\n"}, headers=auth_headers())

    assert response.status_code == 400
    assert response.json() == {"error": {"code": "invalid_request", "message": message}}


# ---- removing a check's directory carries on past a failure ---------------------------


def test_a_failed_entry_doesnt_stop_the_removal_and_is_logged_by_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A removal that stopped at the first entry it couldn't remove would
    leave whatever came after it (the configuration's file included). The first
    unlink fails here, whichever entry it is; every other entry is still
    removed, and the log names the error's type."""
    directory = tmp_path / "otelcol-check-partial"
    directory.mkdir()
    for name in ("config.yaml", "a.txt", "b.txt", "c.txt"):
        (directory / name).write_text("x")
    real_unlink = os.unlink
    refused: list[str] = []

    def unlink_refusing_the_first(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003 - os.unlink's signature
        if not refused:
            refused.append(str(path))
            raise PermissionError(13, "Permission denied", path)
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(runner.shutil.os, "unlink", unlink_refusing_the_first)

    with caplog.at_level(logging.WARNING, logger="app.runner"):
        cancelled = guard.in_thread(lambda: runner._end_check(None, str(directory)))
    monkeypatch.undo()

    assert cancelled is False
    assert len(refused) == 1
    left = sorted(entry.name for entry in directory.iterdir())
    assert left == [Path(refused[0]).name]
    assert [record.getMessage() for record in caplog.records] == [
        "a check's directory could not be removed (OSError, PermissionError)"
    ]
    assert "otelcol-check" not in caplog.text


def test_remove_directory_returns_each_failures_type_and_removes_the_rest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    directory = tmp_path / "otelcol-check-types"
    (directory / "nested").mkdir(parents=True)
    (directory / "nested" / "queue").write_text("x")
    (directory / "config.yaml").write_text("x")
    real_unlink = os.unlink

    def refusing_queue(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003 - os.unlink's signature
        if str(path).endswith("queue"):
            raise PermissionError(13, "Permission denied", path)
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(runner.shutil.os, "unlink", refusing_queue)
    failures = runner._remove_directory(str(directory))
    monkeypatch.undo()

    assert not (directory / "config.yaml").exists()
    assert (directory / "nested" / "queue").exists()
    # The file, then its directory and the check's (not empty): every failure's type, in order.
    assert failures[0] == "PermissionError"
    assert set(failures[1:]) == {"OSError"}
    assert json.dumps(failures).count("otelcol-check") == 0


# ---- errors: at most 200, each string within its budget -------------------

from app import runner as _runner  # noqa: E402 - the bounds' constants, read where they are defined


def answer_bytes(result: ValidationResult, distribution: str = "otelcol-contrib", version: str = "0.162.0") -> int:
    """The size of the answer the service renders for `result` (Starlette's
    JSONResponse, as `app/main.py` answers)."""
    from fastapi.responses import JSONResponse

    body = {
        "valid": result.valid,
        "errors": result.errors,
        "requirements": result.requirements,
        "distribution": distribution,
        "version": version,
    }
    return len(JSONResponse(body).body)


def error(message: str, path: str | None = None) -> dict:
    return {"message": message, "componentPath": path}


def test_bounded_keeps_200_errors_then_says_more_were_reported() -> None:
    errors = [error(f"bad {index}", f"receivers::otlp/{index}") for index in range(5_000)]

    answer = bounded(ValidationResult(valid=False, errors=errors, outcome="failed"))

    assert len(answer.errors) == 201
    assert answer.errors[:200] == errors[:200]
    assert answer.errors[200] == {"message": "The collector reported more errors than shown.", "componentPath": None}
    assert answer.valid is False
    # Bounding a bounded answer changes nothing (the child bounds, then the service).
    assert bounded(answer).errors == answer.errors


def test_bounded_leaves_200_errors_as_they_are() -> None:
    errors = [error(f"bad {index}") for index in range(200)]

    assert bounded(ValidationResult(valid=False, errors=errors)).errors == errors


@pytest.mark.parametrize("character", ["x", "é", "😀", "\u0001", '"'], ids=["ascii", "two-bytes", "four-bytes", "control", "quote"])
def test_a_message_over_4_kib_is_cut_with_an_ellipsis_within_its_budget(character: str) -> None:
    long = character * 20_000
    answer = bounded(ValidationResult(valid=False, errors=[error(long, "x" * 5_000)]))

    [cut] = answer.errors
    assert cut["message"].endswith("…")
    assert long.startswith(cut["message"][:-1])
    assert 4_096 - 6 - 3 < _runner._json_bytes(cut["message"]) <= 4_096
    assert _runner._json_bytes(cut["componentPath"]) <= 1_024
    assert cut["componentPath"].endswith("…")


def test_a_message_within_4_kib_is_kept_whole() -> None:
    exact = "é" * 2_048  # 4,096 bytes
    assert bounded(ValidationResult(valid=False, errors=[error(exact)])).errors == [error(exact)]


def test_every_requirement_field_is_cut_to_its_budget_before_the_duplicates_go() -> None:
    long_title = "Provide /" + "a" * 5_000 + " on the host"
    items = [requirement(long_title + suffix, "exporters::otlp") for suffix in ("1", "2")]
    items[0]["description"] = "d" * 10_000

    answer = bounded(ValidationResult(valid=True, requirements=items))

    # Cut, the two titles are the same: one requirement.
    [kept] = answer.requirements
    assert _runner._json_bytes(kept["title"]) <= 1_024
    assert _runner._json_bytes(kept["description"]) <= 4_096
    assert kept["title"].endswith("…") and kept["description"].endswith("…")


def test_the_largest_possible_answer_is_the_documented_bound_and_fits_the_platforms_4_mib() -> None:
    """Every field over its budget, in 6-byte escaped characters: the
    rendered answer stays within MAX_ANSWER_BYTES (2,290,356 bytes), under the
    platform client's 4 MiB. Not the exact worst case (an ASCII-filled answer
    is a few KB larger, still under the bound, which is a slightly loose upper
    bound: the 201st error is always the short marker)."""
    worst = "\u0001" * 30_000
    # Each distinct where the cut keeps it: its number first.
    errors = [error(str(index) + worst, str(index) + worst) for index in range(1_000)]
    items = [
        {"category": worst, "title": str(index) + worst, "description": worst, "componentPath": str(index) + worst}
        for index in range(1_000)
    ]

    answer = bounded(ValidationResult(valid=False, errors=errors, requirements=items))
    size = answer_bytes(answer, "a" * 64, "9" * 64)

    assert (len(answer.errors), len(answer.requirements)) == (201, 200)
    assert size <= _runner.MAX_ANSWER_BYTES < 4 * 1024 * 1024
    assert _runner.MAX_ANSWER_BYTES == 2_290_356


# A collector that prints this shape: one error per pipeline, many
# pipelines (an aliased multi-line key printed 130,746 errors on 0.162.0).
MANY_ERRORS_COLLECTOR = """echo 'Error: invalid configuration: receivers::otlp/0: must specify at least one protocol' >&2
i=1
while [ $i -lt 6000 ]; do echo "receivers::otlp/$i: must specify at least one protocol"; i=$((i + 1)); done >&2
exit 1
"""

LONG_ERROR_COLLECTOR = """printf 'Error: receivers::otlp: ' >&2
head -c 50000 /dev/zero | tr '\\0' 'q' >&2
echo >&2
exit 1
"""


def test_a_collector_printing_thousands_of_errors_answers_201(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", MANY_ERRORS_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        response = client.post("/validator/v1/validate/otelcol-contrib/0.162.0", json={"yaml": "a: 1\n"}, headers=auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert len(body["errors"]) == 201
    assert body["errors"][1] == {"message": "must specify at least one protocol", "componentPath": "receivers::otlp/1"}
    assert body["errors"][-1] == {"message": "The collector reported more errors than shown.", "componentPath": None}
    assert len(response.content) <= _runner.MAX_ANSWER_BYTES


def test_a_collector_error_longer_than_4_kib_is_cut(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", LONG_ERROR_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        response = client.post("/validator/v1/validate/otelcol-contrib/0.162.0", json={"yaml": "a: 1\n"}, headers=auth_headers())

    [cut] = response.json()["errors"]
    assert cut["message"] == "q" * (4_096 - 3) + "…"


# ---- requirements: the collector's first, then the text's -----------------

COLLECTOR_REQUIREMENT = """echo 'Error: extensions::file_storage: directory must exist: stat /var/lib/otel: no such file or directory. You can enable the create_directory option to automatically create it' >&2
exit 1
"""


def test_the_collectors_requirements_and_the_providers_come_before_the_texts_own(binary_dir: Path) -> None:
    """300 organization variables in the text, a provider, and one
    requirement the collector printed: the collector's and the provider's are
    kept ahead of the cut, the text's fill the rest."""
    write_collector(binary_dir, "0.162.0", COLLECTOR_REQUIREMENT)
    references = "".join(f"${{org:v{index}}}" for index in range(300))
    text = (
        "receivers:\n  otlp:\n    protocols:\n      grpc:\n"
        f"        endpoint: {references}\n"
        '        auth: "${vault:secret/x}"\n'
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        response = client.post("/validator/v1/validate/otelcol-contrib/0.162.0", json={"yaml": text}, headers=auth_headers())

    requirements = response.json()["requirements"]
    assert len(requirements) == 200
    categories = [item["category"] for item in requirements]
    first = sorted(categories[:2])
    assert first == ["confmap_provider", "directory"]
    assert requirements[categories.index("directory")]["title"] == "Ensure /var/lib/otel exists at runtime"
    assert set(categories[2:]) == {"organization_variable"}
    assert requirements[2]["title"] == "Unresolved organization variable: v0"


def test_a_bounded_answer_at_every_limit_conforms_to_openapi_yaml() -> None:
    """The file's maxItems and maxLength agree with the bounds (a length in
    characters is never more than one in bytes)."""
    from tests.test_openapi import _check

    long = "é" * 20_000
    errors = [error(str(index) + long, str(index) + long) for index in range(300)]
    items = [
        {"category": "env_var", "title": str(index) + long, "description": long, "componentPath": str(index) + long}
        for index in range(300)
    ]
    answer = bounded(ValidationResult(valid=False, errors=errors, requirements=items))

    _check(
        "components/schemas/ValidateResponse",
        {
            "valid": answer.valid,
            "errors": answer.errors,
            "requirements": answer.requirements,
            "distribution": "otelcol-contrib",
            "version": "0.162.0",
        },
    )
    with pytest.raises(AssertionError):
        _check(
            "components/schemas/ValidationError",
            {"message": "x" * 4_097, "componentPath": None},
        )
