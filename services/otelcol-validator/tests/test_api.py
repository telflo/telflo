"""The validate route's body, limits and failures (D13b spec decisions 10 and
11): a body that isn't a JSON object is 400 (a list too,
never a 500), the 2 MiB limit is enforced while the body is read, the wait for a
slot is bounded."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.main import MAX_BODY_BYTES, MAX_YAML_CHARACTERS, create_app
from tests.conftest import PASSING_COLLECTOR, VALIDATE_URL, auth_headers, call_asgi, make_settings, write_collector

YAML = "receivers:\n  otlp:\n"


@pytest.mark.parametrize(
    "body",
    [
        b'["receivers:"]',  # a list: 400, never a 500
        b'"receivers:"',
        b"42",
        b"null",
        b"true",
    ],
)
def test_a_body_that_is_not_a_json_object_is_400(client: TestClient, body: bytes) -> None:
    resp = client.post(VALIDATE_URL, content=body, headers={**auth_headers(), "Content-Type": "application/json"})

    assert resp.status_code == 400
    assert resp.json() == {"error": {"code": "invalid_request", "message": "The request body must be a JSON object."}}


@pytest.mark.parametrize("body", [b"", b"{ not json", b"\xff\xfe\x00", b'{"yaml": "x"'])
def test_a_body_that_is_not_json_is_400(client: TestClient, body: bytes) -> None:
    resp = client.post(VALIDATE_URL, content=body, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "document",
    [{}, {"yaml": ""}, {"yaml": 3}, {"yaml": None}, {"yaml": ["a"]}, {"yaml": YAML, "version": "0.147.0"}],
)
def test_a_body_without_exactly_a_non_empty_yaml_string_is_400(client: TestClient, document: dict) -> None:
    resp = client.post(VALIDATE_URL, json=document, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "body",
    [
        b'{"yaml":' + b"[" * 100_000 + b"]" * 100_000 + b"}",  # the reviewer's probe
        b"[" * 100_000,
        b'{"a":' * 50_000 + b"1" + b"}" * 50_000,
    ],
    ids=["deep-list-in-yaml", "deep-unclosed-list", "deep-objects"],
)
def test_a_body_nested_deeper_than_the_decoder_recurses_is_400(binary_dir: Path, body: bytes) -> None:
    """D13b ruling 26: `json.loads` raises RecursionError, not ValueError,
    and the answer was a plain-text 500 outside the Error envelope."""
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir)), raise_server_exceptions=False) as client:
        resp = client.post(VALIDATE_URL, content=body, headers={**auth_headers(), "Content-Type": "application/json"})

    assert resp.status_code == 400
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == {"error": {"code": "invalid_request", "message": "The request body isn't JSON."}}


@pytest.mark.parametrize("escaped", [b"\\ud800", b"x\\udfff", b"\\udc80\\ud800y"])
def test_a_yaml_holding_a_lone_surrogate_is_400(binary_dir: Path, tmp_path: Path, escaped: bytes) -> None:
    """D13b ruling 38: JSON can spell a lone surrogate, which no file can
    hold; 207bc02 answered 500 (the child couldn't write the text)."""
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")
    with TestClient(create_app(make_settings(binary_dir)), raise_server_exceptions=False) as client:
        resp = client.post(
            VALIDATE_URL,
            content=b'{"yaml": "receivers:\\n  ' + escaped + b': 1\\n"}',
            headers={**auth_headers(), "Content-Type": "application/json"},
        )

    assert resp.status_code == 400
    assert resp.json() == {"error": {"code": "invalid_request", "message": "`yaml` must be Unicode text."}}
    assert not marker.exists()


def test_a_400_never_quotes_the_body(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json={"yaml": YAML, "marker-in-a-key": 1}, headers=auth_headers())

    assert resp.status_code == 400
    assert "marker" not in resp.text


# ---------------------------------------------------------------------------
# 2 MiB, while the body is read (D20 Preflight ruling 30, re-derived on Q104)
# ---------------------------------------------------------------------------


def _body_of_exactly(size: int) -> bytes:
    """A body of `size` bytes whose text is a short valid one: JSON's own
    whitespace pads it (no text or value is that long)."""
    prefix, suffix = b'{"yaml": "receivers: {}\\n"', b"}"
    return prefix + b" " * (size - len(prefix) - len(suffix)) + suffix


async def test_a_declared_length_over_2_mib_is_refused_before_the_body_is_read(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    app = create_app(make_settings(binary_dir))
    assert MAX_BODY_BYTES == 2 * 1024 * 1024

    result = await call_asgi(
        app,
        "POST",
        VALIDATE_URL,
        {**auth_headers(), "Content-Length": str(MAX_BODY_BYTES + 1)},
        [b"x" * 1024],
        forbid_body=True,
    )

    assert result.status == 413
    assert result.json() == {
        "error": {"code": "payload_too_large", "message": "The request body is larger than 2 MiB."}
    }


async def test_a_streamed_body_over_2_mib_is_refused_at_the_chunk_that_passes_it(binary_dir: Path) -> None:
    """No Content-Length (chunked): the reader stops at the first chunk that
    takes it past 2 MiB, never reading the rest."""
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    app = create_app(make_settings(binary_dir))
    chunk = b"x" * (256 * 1024)
    chunks = [chunk] * 12  # 3 MiB offered

    result = await call_asgi(app, "POST", VALIDATE_URL, auth_headers(), chunks)

    assert result.status == 413
    assert result.chunks_read == 9  # 8 chunks are exactly 2 MiB; the 9th passes it


async def test_a_body_of_exactly_2_mib_is_read_and_checked(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    app = create_app(make_settings(binary_dir))
    body = _body_of_exactly(MAX_BODY_BYTES)
    assert len(body) == MAX_BODY_BYTES

    result = await call_asgi(app, "POST", VALIDATE_URL, auth_headers(), [body[:1_000_000], body[1_000_000:]])

    assert result.status == 200
    assert result.json()["valid"] is True


async def test_a_malformed_content_length_is_400(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", VALIDATE_URL, {**auth_headers(), "Content-Length": "lots"}, [b"{}"])

    assert result.status == 400


# ---------------------------------------------------------------------------
# Slots: a bounded wait
# ---------------------------------------------------------------------------


def test_a_request_that_waits_past_the_bound_for_a_slot_is_503(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir, slot_wait_seconds=0.2))) as client:
        # Every slot taken: a semaphore with none free.
        client.app.state.slots = asyncio.Semaphore(0)
        resp = client.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers())

    assert resp.status_code == 503
    assert resp.json() == {
        "error": {"code": "validator_busy", "message": "Every validation slot is busy. Retry shortly."}
    }


def test_a_queued_request_runs_once_a_slot_frees_within_the_bound(binary_dir: Path) -> None:
    """Two slots' worth of slow collectors and a third request: it waits,
    then runs (the bound is a cap, not a refusal)."""
    write_collector(binary_dir, "0.162.0", "sleep 0.3\nexit 0\n")
    settings = make_settings(binary_dir, max_concurrency=1, slot_wait_seconds=5.0)
    with TestClient(create_app(settings)) as client:

        async def three() -> list[int]:
            import httpx2

            transport = httpx2.ASGITransport(app=client.app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
                answers = await asyncio.gather(
                    *[http.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers()) for _ in range(3)]
                )
            return [answer.status_code for answer in answers]

        statuses = client.portal.call(three)

    assert statuses == [200, 200, 200]


def test_a_queued_request_past_the_bound_is_503_while_others_run(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", "sleep 1\nexit 0\n")
    settings = make_settings(binary_dir, max_concurrency=1, slot_wait_seconds=0.2)
    with TestClient(create_app(settings)) as client:

        async def two() -> list[int]:
            import httpx2

            transport = httpx2.ASGITransport(app=client.app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
                answers = await asyncio.gather(
                    *[http.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers()) for _ in range(2)]
                )
            return sorted(answer.status_code for answer in answers)

        statuses = client.portal.call(two)

    assert statuses == [200, 503]


# ---------------------------------------------------------------------------
# Other failures
# ---------------------------------------------------------------------------


def test_an_unknown_path_with_the_secret_is_404(client: TestClient) -> None:
    for resp in (
        client.get("/nothing-here", headers=auth_headers()),
        client.get(VALIDATE_URL, headers=auth_headers()),
        client.post("/health", headers=auth_headers()),
    ):
        assert resp.status_code == 404
        assert resp.json() == {"error": {"code": "not_found", "message": "Not found."}}


def test_no_generated_documentation_routes(client: TestClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path, headers=auth_headers()).status_code == 404


def test_a_collector_that_cannot_be_run_is_503(binary_dir: Path) -> None:
    """The file is there but isn't executable: the version isn't available."""
    path = write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    path.chmod(0o644)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers())

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "version_unavailable"


def test_an_unexpected_failure_is_500_without_details(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(*args, **kwargs):
        raise RuntimeError("detail that must not reach the answer")

    monkeypatch.setattr(main_module, "run_validation", broken)
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": YAML}, headers=auth_headers())

    assert resp.status_code == 500
    assert resp.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_the_answer_is_camel_case_without_raw(binary_dir: Path) -> None:
    """Decision 11's shape: `componentPath`, and no `raw`."""
    write_collector(
        binary_dir,
        "0.162.0",
        "echo 'Error: exporters::otlp_http/my-exp.v2: at least one endpoint must be specified' >&2\nexit 1\n",
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(
            VALIDATE_URL,
            content=json.dumps({"yaml": "exporters:\n  otlp_http/my-exp.v2:\n    endpoint: ${env:EXPORT_URL}\n"}),
            headers=auth_headers(),
        )

    body = resp.json()
    assert body["valid"] is False
    assert body["errors"] == [
        {"message": "at least one endpoint must be specified", "componentPath": "exporters::otlp_http/my-exp.v2"}
    ]
    assert body["requirements"][0]["title"] == "Set environment variable EXPORT_URL"
    assert set(body["requirements"][0]) == {"category", "title", "description", "componentPath"}
