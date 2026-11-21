"""The contract test: `openapi.yaml` is what the platform's client and its
test double are written against, so every route's real answers, every
status the file documents, are produced here through the real app and
validated against the file (jsonschema), as are the requests sent. A route
the app has that the file doesn't document (or the reverse) fails too."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import quote

import pytest
import yaml
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from app import main as main_module
from app.kwok import KwokState
from app.main import MAX_BODY_BYTES, MAX_INPUT_BYTES, create_app
from tests.conftest import RUNS_URL, VERSION, auth_headers, call_asgi, make_settings, run_body, write_fake_collector

SPEC_PATH = Path(__file__).resolve().parents[1] / "openapi.yaml"
SPEC = yaml.safe_load(SPEC_PATH.read_text())
SPEC_URI = "urn:telflo:otelcol-testing:openapi"
REGISTRY = Registry().with_resource(SPEC_URI, Resource(contents=SPEC, specification=DRAFT202012))
RUNS = "/testing/v1/runs"
HEALTH = "/testing/v1/health"


def _pointer(*parts: str) -> str:
    return "/".join(quote(part.replace("~", "~0").replace("/", "~1"), safe="~") for part in parts)


def _check(schema_pointer: str, instance: object) -> None:
    validator = Draft202012Validator({"$ref": f"{SPEC_URI}#/{schema_pointer}"}, registry=REGISTRY)
    errors = sorted(validator.iter_errors(instance), key=str)
    assert not errors, [error.message for error in errors]


def _response(path: str, method: str, status: int) -> tuple[dict, list[str]]:
    operation = SPEC["paths"][path][method]
    response = operation["responses"][str(status)]
    pointer = ["paths", path, method, "responses", str(status)]
    if "$ref" in response:
        name = response["$ref"].rsplit("/", 1)[-1]
        response = SPEC["components"]["responses"][name]
        pointer = ["components", "responses", name]
    return response, pointer


def check_answer(path: str, method: str, status: int, headers: dict[str, str], body: object) -> None:
    response, pointer = _response(path, method, status)
    assert "application/json" in response["content"], (path, method, status)
    assert headers.get("content-type", "").startswith("application/json")
    _check(_pointer(*pointer, "content", "application/json", "schema"), body)
    for name, header in response.get("headers", {}).items():
        value = headers.get(name.lower())
        assert value is not None, name
        if "const" in header.get("schema", {}):
            assert value == header["schema"]["const"]


def check_request(body: object) -> None:
    _check(_pointer("paths", RUNS, "post", "requestBody", "content", "application/json", "schema"), body)


EXERCISED: set[tuple[str, str, int]] = set()


@pytest.fixture
def started(binary_dir: Path) -> Iterator[TestClient]:
    write_fake_collector(
        binary_dir,
        VERSION,
        prelude=(
            "sys.stderr.write('collector starting\\n')\n"
            "if 'crash' in open(CONFIG, encoding='utf-8').read():\n"
            "    sys.stderr.flush()\n"
            "    os._exit(3)\n"
        ),
    )
    with TestClient(create_app(make_settings(binary_dir, slot_wait_seconds=0.1))) as client:
        yield client


def _post(client: TestClient, body: object, *, headers: dict[str, str] | None = None):
    return client.post(RUNS, json=body, headers=auth_headers() if headers is None else headers)


def _record(path: str, method: str, resp) -> None:  # noqa: ANN001
    EXERCISED.add((path, method, resp.status_code))
    check_answer(path, method, resp.status_code, dict(resp.headers), resp.json())


def test_every_documented_answer_is_produced_and_conforms(started: TestClient, monkeypatch) -> None:  # noqa: ANN001
    client = started

    # GET /testing/v1/health: 200, then 503 starting and failed
    _record(HEALTH, "get", client.get(HEALTH))
    supervisor = client.app.state.kwok
    for state in (KwokState.STARTING, KwokState.FAILED):
        supervisor.state = state
        _record(HEALTH, "get", client.get(HEALTH))

    # 503 tester_starting, and tester_unavailable once kwok has failed
    supervisor.state = KwokState.STARTING
    starting = _post(client, run_body())
    assert starting.json()["error"]["code"] == "tester_starting"
    _record(RUNS, "post", starting)
    supervisor.state = KwokState.FAILED
    unavailable = _post(client, run_body())
    assert unavailable.json()["error"]["code"] == "tester_unavailable"
    _record(RUNS, "post", unavailable)
    supervisor.state = KwokState.READY

    # 200 succeeded, with R-105 and an output
    body = run_body(yaml="processors:\n  attributes:\n    actions:\n      - value: ${file:/etc/hostname}\n")
    check_request(body)
    resp = _post(client, body)
    assert resp.json()["status"] == "succeeded"
    assert [m["id"] for m in resp.json()["mutations"]] == ["R-105"]
    assert base64.b64decode(resp.json()["output"]["base64"]) == b'{"resourceLogs":[]}'
    _record(RUNS, "post", resp)

    # 200 failed: C-000 (unreadable), and a collector that failed
    for text, code in (("a: [unclosed\n", "unreadable"), ("crash: true\n", "collector_failed")):
        body = run_body(yaml=text)
        check_request(body)
        resp = _post(client, body)
        assert resp.json()["status"] == "failed"
        assert resp.json()["error"]["code"] == code
        _record(RUNS, "post", resp)

    # 400
    for bad in (
        _post(client, ["a list"]),
        _post(client, run_body(signal="profiles")),
        _post(client, run_body(version="0.100.0")),
        client.post(RUNS, content=b"{ not json", headers=auth_headers()),
    ):
        assert bad.status_code == 400
        _record(RUNS, "post", bad)

    # 401
    _record(RUNS, "post", _post(client, run_body(), headers={}))

    # 409
    _record(RUNS, "post", _post(client, run_body(version="0.155.0")))

    # 413: the body, the text and the input
    big = client.post(RUNS, content=b"x" * (MAX_BODY_BYTES + 1), headers=auth_headers())
    assert big.json()["error"]["code"] == "payload_too_large"
    _record(RUNS, "post", big)
    _record(RUNS, "post", _post(client, run_body(yaml="#" * 262_145)))
    too_much = base64.b64encode(b"\0" * (MAX_INPUT_BYTES + 1)).decode("ascii")
    large_input = _post(client, run_body(input={"base64": too_much}))
    assert large_input.json()["error"]["code"] == "input_too_large"
    _record(RUNS, "post", large_input)

    # 503: not held, and busy
    _record(RUNS, "post", _post(client, run_body(version="0.161.0")))
    client.app.state.slots = asyncio.Semaphore(0)
    busy = _post(client, run_body())
    assert busy.json()["error"]["code"] == "tester_busy"
    _record(RUNS, "post", busy)
    client.app.state.slots = asyncio.Semaphore(1)

    # 500
    async def broken(*args, **kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(main_module, "run_test", broken)
    _record(RUNS, "post", _post(client, run_body()))

    documented = {
        (path, method, int(status))
        for path, item in SPEC["paths"].items()
        for method, operation in item.items()
        if method in {"get", "post", "put", "patch", "delete"}
        for status in operation["responses"]
    }
    assert EXERCISED == documented


def test_a_path_no_route_has_answers_the_documented_envelope(started: TestClient) -> None:
    for resp in (
        started.get("/nothing-here", headers=auth_headers()),
        started.get("/nothing-here"),
        started.get(RUNS, headers=auth_headers()),
    ):
        _check("components/schemas/Error", resp.json())
    assert started.get("/nothing-here", headers=auth_headers()).status_code == 404
    assert started.get(RUNS, headers=auth_headers()).status_code == 404
    assert started.get("/nothing-here").status_code == 401


async def test_a_streamed_413_conforms(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", RUNS_URL, auth_headers(), [b"x" * (9 * 1024 * 1024)] * 2)

    assert result.status == 413
    check_answer(RUNS, "post", 413, result.headers, result.json())


def test_the_app_has_exactly_the_documented_routes() -> None:
    app = create_app()
    routes = {
        (route.path, method.lower())
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in route.methods
        if method != "HEAD"
    }
    documented = {
        (path, method)
        for path, item in SPEC["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    assert routes == documented


def test_the_documents_examples_conform() -> None:
    for path, item in SPEC["paths"].items():
        for method, operation in item.items():
            if method not in {"get", "post"}:
                continue
            for status in operation["responses"]:
                response, pointer = _response(path, method, int(status))
                media = response["content"]["application/json"]
                schema_pointer = _pointer(*pointer, "content", "application/json", "schema")
                if "example" in media:
                    _check(schema_pointer, media["example"])
                for example in media.get("examples", {}).values():
                    _check(schema_pointer, example["value"])


def test_the_document_is_openapi_3_1_with_bearer_security_and_bounded_files() -> None:
    assert SPEC["openapi"] == "3.1.0"
    assert SPEC["components"]["securitySchemes"]["bearerAuth"]["scheme"] == "bearer"
    assert SPEC["security"] == [{"bearerAuth": []}]
    assert SPEC["paths"][HEALTH]["get"]["security"] == []
    for schema in SPEC["components"]["schemas"].values():
        Draft202012Validator.check_schema(schema)
    schemas = SPEC["components"]["schemas"]
    files = [
        schemas["RunRequest"]["properties"]["input"]["properties"]["base64"],
        schemas["RunAnswer"]["properties"]["output"]["oneOf"][1]["properties"]["base64"],
        schemas["RunAnswer"]["properties"]["decodedInput"]["oneOf"][1]["properties"]["base64"],
    ]
    for field in files:
        assert field["contentEncoding"] == "base64"
        # 10 MiB, base64: 4 × ⌈10,485,760 / 3⌉.
        assert field["maxLength"] == 4 * ((MAX_INPUT_BYTES + 2) // 3) == 13_981_016


def test_the_schema_refuses_what_the_tester_never_answers() -> None:
    """The contract is strict enough to catch a regression: a failure
    without an error, a success with one, an unknown code or strategy, a
    snake_case field, a file name."""
    base = {
        "status": "succeeded",
        "strategy": None,
        "kwokEnabled": False,
        "collectorVersion": VERSION,
        "logs": "",
        "mutatedYaml": None,
        "mutations": [],
        "compatibility": [],
        "output": None,
        "decodedInput": None,
        "timings": {"totalMs": 1, "readyMs": None, "informerMs": None, "replayMs": None, "holdMs": None, "stopMs": None},
    }
    pointer = "components/schemas/RunAnswer"
    _check(pointer, base)
    _check(pointer, {**base, "status": "failed", "error": {"code": "timed_out", "message": "m"}})
    # The sandbox's mutations (R-*) and the fixture-shape advisories (F-*).
    for mutation_id in ("R-001", "R-105", "R-106", "F-001", "F-003"):
        _check(pointer, {**base, "mutations": [{"id": mutation_id, "severity": "warn", "message": "m", "details": {}}]})
    # The compatibility checks, C-005 included.
    for issue_id in ("C-000", "C-004", "C-005"):
        issue = {"id": issue_id, "severity": "refuse", "component": "geoip", "message": "m", "details": {}}
        _check(pointer, {**base, "status": "failed", "error": {"code": "refused", "message": "m"}, "compatibility": [issue]})
    for broken in (
        {**base, "status": "failed"},
        {**base, "error": {"code": "timed_out", "message": "m"}},
        {**base, "status": "failed", "error": {"code": "exploded", "message": "m"}},
        {**base, "strategy": "journald"},
        {**base, "kwok_enabled": False},
        {**base, "output": {"base64": "", "bytesOnDisk": 0, "truncated": False, "fileName": "out.json"}},
        {**base, "timings": {"totalMs": -1, **{k: None for k in ("readyMs", "informerMs", "replayMs", "holdMs", "stopMs")}}},
        {**base, "mutations": [{"id": "R-105", "severity": "fatal", "message": "m", "details": {}}]},
        {**base, "mutations": [{"id": "C-003", "severity": "warn", "message": "m", "details": {}}]},
        {**base, "compatibility": [{"id": "F-001", "severity": "advisory", "component": "c", "message": "m", "details": {}}]},
    ):
        with pytest.raises(AssertionError):
            _check(pointer, broken)


def test_the_request_schema_refuses_what_the_tester_refuses() -> None:
    check_request(run_body())
    for broken in (
        run_body(fileName="x"),
        run_body(signal="profiles"),
        run_body(distribution="clickstack"),
        run_body(durationSeconds=0),
        run_body(durationSeconds=61),
        run_body(runId="not-a-uuid"),
        run_body(input={"base64": "aGk=", "name": "x"}),
    ):
        with pytest.raises(AssertionError):
            check_request(broken)
