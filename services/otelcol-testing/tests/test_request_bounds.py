"""The request's contract: a 16 MiB body refused (413) while it streams, a
262,144-character text, a 10 MiB input, and 400 `invalid_request` for
anything else the contract refuses, with nothing run.
The catalogue's answers: an unknown version 400, a retired one 409, one this
tester doesn't hold 503."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import MAX_BODY_BYTES, MAX_INPUT_BYTES, create_app
from tests.conftest import RUNS_URL, VERSION, auth_headers, call_asgi, make_settings, run_body, write_fake_collector


@pytest.fixture
def marked(binary_dir: Path, tmp_path: Path):
    """A started app whose collector leaves a mark when it runs."""
    marker = tmp_path / "collector-ran"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(marker)!r}, 'w').close()\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        yield client, marker


def _post(client: TestClient, body: object):
    """The body as JSON with ASCII escapes, so a lone surrogate travels as
    `\\ud800` (httpx2's own encoder refuses it)."""
    return client.post(
        RUNS_URL,
        content=json.dumps(body).encode("ascii"),
        headers={**auth_headers(), "Content-Type": "application/json"},
    )


def _error(resp) -> tuple[int, str, str]:  # noqa: ANN001
    error = resp.json()["error"]
    return resp.status_code, error["code"], error["message"]


# ---------------------------------------------------------------------------
# Sizes
# ---------------------------------------------------------------------------


async def test_a_body_over_16_mib_is_413_while_it_streams(binary_dir: Path) -> None:
    """No Content-Length: the body is refused at the chunk that takes it
    past 16 MiB, and the rest is never asked for."""
    app = create_app(make_settings(binary_dir))
    chunk = b"x" * (4 * 1024 * 1024)

    result = await call_asgi(app, "POST", RUNS_URL, auth_headers(), [chunk] * 6)

    assert result.status == 413
    assert result.json() == {
        "error": {"code": "payload_too_large", "message": "The request body is larger than 16 MiB."}
    }
    assert result.chunks_read == 5  # 20 MiB read at most; the sixth chunk never


async def test_a_declared_length_over_16_mib_is_413_before_any_of_it_is_read(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))
    headers = {**auth_headers(), "Content-Length": str(MAX_BODY_BYTES + 1)}

    result = await call_asgi(app, "POST", RUNS_URL, headers, [b"{}"], forbid_body=True)

    assert result.status == 413


async def test_a_malformed_content_length_is_400(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", RUNS_URL, {**auth_headers(), "Content-Length": "12x"}, [b"{}"])

    assert result.status == 400


def test_a_text_of_262_144_characters_runs_and_one_more_is_413(marked) -> None:  # noqa: ANN001
    client, marker = marked
    at_limit = "#" + "x" * (262_144 - 2) + "\n"
    assert len(at_limit) == 262_144

    over = _post(client, run_body(yaml=at_limit + "#"))
    assert not marker.exists()
    ran = _post(client, run_body(yaml=at_limit))

    assert _error(over) == (413, "payload_too_large", "`yaml` is longer than 262,144 characters.")
    assert ran.status_code == 200
    assert marker.exists()


def test_an_input_of_10_mib_runs_and_one_byte_more_is_413(marked) -> None:  # noqa: ANN001
    client, marker = marked
    at_limit = base64.b64encode(b"\0" * MAX_INPUT_BYTES).decode("ascii")
    over = base64.b64encode(b"\0" * (MAX_INPUT_BYTES + 1)).decode("ascii")

    refused = _post(client, run_body(input={"base64": over}))
    assert not marker.exists()
    ran = _post(client, run_body(input={"base64": at_limit}))

    assert _error(refused) == (413, "input_too_large", "The input is larger than 10 MiB.")
    assert ran.status_code == 200
    assert marker.exists()


def test_an_empty_input_runs(marked) -> None:  # noqa: ANN001
    client, _ = marked

    assert _post(client, run_body(input={"base64": ""})).status_code == 200


# ---------------------------------------------------------------------------
# The contract's refusals: 400, nothing run
# ---------------------------------------------------------------------------

REFUSED: list[tuple[str, object, str]] = [
    ("a list", ["a list"], "The request body must be a JSON object."),
    ("a string", "yaml", "The request body must be a JSON object."),
    ("an extra property", run_body(fileName="app.log"), "The request body must hold exactly"),
    ("a missing property", {k: v for k, v in run_body().items() if k != "pipeline"}, "The request body must hold exactly"),
    ("an upper-case run id", run_body(runId="0192A4B8-7C3D-7E5F-8A9B-0C1D2E3F4A5B"), "`runId`"),
    ("a run id that names a path", run_body(runId="../../etc/passwd"), "`runId`"),
    ("an empty text", run_body(yaml=""), "`yaml` must be a non-empty string."),
    ("a text that isn't a string", run_body(yaml={"receivers": {}}), "`yaml` must be a non-empty string."),
    ("a lone surrogate in the text", run_body(yaml="a: \ud800\n"), "`yaml` must be Unicode text."),
    ("an empty pipeline", run_body(pipeline=""), "`pipeline`"),
    ("a pipeline over 200 characters", run_body(pipeline="l" * 201), "`pipeline`"),
    ("a pipeline that isn't a string", run_body(pipeline=["logs"]), "`pipeline`"),
    ("an unknown signal", run_body(signal="profiles"), "`signal` must be traces, metrics or logs."),
    ("a signal in capitals", run_body(signal="Logs"), "`signal`"),
    ("a null signal", run_body(signal=None), "`signal`"),
    ("a duration of 0", run_body(durationSeconds=0), "`durationSeconds`"),
    ("a duration of 61", run_body(durationSeconds=61), "`durationSeconds`"),
    ("a fractional duration", run_body(durationSeconds=1.5), "`durationSeconds`"),
    ("a duration as a string", run_body(durationSeconds="5"), "`durationSeconds`"),
    ("a duration of true", run_body(durationSeconds=True), "`durationSeconds`"),
    ("the ClickStack distribution", run_body(distribution="clickstack"), "`distribution` must be otelcol-contrib."),
    ("an unknown distribution", run_body(distribution="otelcol-other"), "`distribution`"),
    ("a version that isn't major.minor.patch", run_body(version="latest"), "`version` must be major.minor.patch."),
    ("a version with a path", run_body(version="../0.162.0"), "`version`"),
    ("a version with a trailing line break", run_body(version="0.162.0\n"), "`version`"),
    ("an input that isn't an object", run_body(input="aGVsbG8="), "`input` must be an object"),
    ("an input with a file name", run_body(input={"base64": "aGVsbG8=", "name": "x.log"}), "`input` must be an object"),
    ("an input without base64", run_body(input={}), "`input` must be an object"),
    ("an input that isn't base64", run_body(input={"base64": "not base64!"}), "`input.base64` must be standard base64."),
    ("url-safe base64", run_body(input={"base64": "a-_b"}), "`input.base64`"),
    ("unpadded base64", run_body(input={"base64": "aGVsbG8"}), "`input.base64`"),
    ("base64 with a line break", run_body(input={"base64": "aGVs\nbG8="}), "`input.base64`"),
]


@pytest.mark.parametrize(("body", "message"), [(body, message) for _, body, message in REFUSED], ids=[name for name, _, _ in REFUSED])
def test_the_contract_refuses_with_400_invalid_request_and_runs_nothing(marked, body: object, message: str) -> None:  # noqa: ANN001
    client, marker = marked

    resp = _post(client, body)

    status, code, said = _error(resp)
    assert (status, code) == (400, "invalid_request")
    assert said.startswith(message)
    assert not marker.exists()


def test_a_body_that_isnt_json_is_400(marked) -> None:  # noqa: ANN001
    client, marker = marked
    for raw in (b"{ not json", b"\xff\xfe", b"[" * 100_000):
        resp = client.post(RUNS_URL, content=raw, headers=auth_headers())
        assert _error(resp) == (400, "invalid_request", "The request body isn't JSON."), raw[:10]
    assert not marker.exists()


def test_a_message_never_quotes_the_request(marked) -> None:  # noqa: ANN001
    client, _ = marked
    canary = "canary-0123456789"
    for body in (
        run_body(signal=canary),
        run_body(version=canary),
        run_body(pipeline=canary * 20),
        run_body(**{canary: 1}),
        run_body(input={"base64": canary + "!"}),
    ):
        resp = _post(client, body)
        assert resp.status_code == 400
        assert canary not in resp.text


def test_an_unknown_version_is_400_version_unknown_a_retired_one_409_and_one_not_held_503(marked) -> None:  # noqa: ANN001
    client, marker = marked

    unknown = _post(client, run_body(version="0.100.0"))
    retired = _post(client, run_body(version="0.155.0"))
    missing = _post(client, run_body(version="0.161.0"))

    # Its own code, so the platform can tell it from a request it got wrong.
    assert _error(unknown) == (400, "version_unknown", "The catalogue lists no such version of otelcol-contrib.")
    assert _error(retired) == (
        409,
        "version_retired",
        "This collector version is retired: pick an offered version to run this test.",
    )
    assert _error(missing) == (503, "version_unavailable", "This tester doesn't hold this collector version.")
    assert not marker.exists()


def test_every_signal_and_the_durations_bounds_are_accepted(marked) -> None:  # noqa: ANN001
    client, _ = marked
    for signal in ("traces", "metrics", "logs"):
        assert _post(client, run_body(signal=signal)).status_code == 200, signal
    assert _post(client, run_body(durationSeconds=1)).status_code == 200


def test_the_contracts_fields_are_exactly_the_documents() -> None:
    from app.main import REQUEST_FIELDS
    from tests.test_openapi import SPEC

    schema = SPEC["components"]["schemas"]["RunRequest"]
    assert set(schema["properties"]) == REQUEST_FIELDS
    assert set(schema["required"]) == REQUEST_FIELDS
    assert schema["additionalProperties"] is False
    assert json.loads(json.dumps(run_body()))  # the test body is plain JSON
