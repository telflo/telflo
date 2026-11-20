"""The contract test: `openapi.yaml` is what the platform's client and its
test double are written against, so every route's real answers, every status
the file documents, are produced here through the real app and validated
against the file, as are the requests sent. A route the app has that the file
doesn't document (or the reverse) fails too."""

from __future__ import annotations

import asyncio
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
from app.main import MAX_BODY_BYTES, create_app
from tests.conftest import PASSING_COLLECTOR, auth_headers, call_asgi, make_settings, write_collector

SPEC_PATH = Path(__file__).resolve().parents[1] / "openapi.yaml"
SPEC = yaml.safe_load(SPEC_PATH.read_text())
SPEC_URI = "urn:telflo:otelcol-validator:openapi"
REGISTRY = Registry().with_resource(SPEC_URI, Resource(contents=SPEC, specification=DRAFT202012))
VALIDATE = "/validator/v1/validate/{distribution}/{version}"
HEALTH = "/health"


def _pointer(*parts: str) -> str:
    return "/".join(quote(part.replace("~", "~0").replace("/", "~1"), safe="~") for part in parts)


def _check(schema_pointer: str, instance: object) -> None:
    validator = Draft202012Validator({"$ref": f"{SPEC_URI}#/{schema_pointer}"}, registry=REGISTRY)
    errors = sorted(validator.iter_errors(instance), key=str)
    assert not errors, [error.message for error in errors]


def _response(path: str, method: str, status: int) -> tuple[dict, list[str]]:
    """The documented response, its `$ref` followed, and the pointer to it."""
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
    _check(_pointer("paths", VALIDATE, "post", "requestBody", "content", "application/json", "schema"), body)


EXERCISED: set[tuple[str, str, int]] = set()


@pytest.fixture
def started(binary_dir: Path) -> Iterator[TestClient]:
    write_collector(
        binary_dir,
        "0.162.0",
        'if grep -q nosuchexporter "${2#--config=}"; then\n'
        "  echo 'Error: failed to get config: cannot unmarshal the configuration: decoding failed due to the "
        "following error(s):' >&2\n"
        "  echo '' >&2\n"
        '  echo \'\'"\'"\'exporters\'"\'"\' unknown type: "nosuchexporter" for id: "nosuchexporter/2" '
        "(valid values: [otlp debug])' >&2\n"
        "  exit 1\n"
        "fi\nexit 0\n",
    )
    with TestClient(create_app(make_settings(binary_dir, slot_wait_seconds=0.1))) as client:
        yield client


def _post(client: TestClient, url: str, body: object, *, headers: dict[str, str] | None = None):
    return client.post(url, json=body, headers=auth_headers() if headers is None else headers)


def _record(path: str, method: str, resp) -> None:  # noqa: ANN001
    EXERCISED.add((path, method, resp.status_code))
    check_answer(path, method, resp.status_code, dict(resp.headers), resp.json())


def test_every_documented_answer_is_produced_and_conforms(started: TestClient, monkeypatch) -> None:
    client = started
    url = "/validator/v1/validate/otelcol-contrib/0.162.0"

    # GET /health 200
    _record(HEALTH, "get", client.get(HEALTH))

    # 200 valid, with a requirement
    body = {"yaml": "exporters:\n  otlp_http:\n    endpoint: ${env:EXPORT_URL}\n"}
    check_request(body)
    resp = _post(client, url, body)
    assert resp.json()["valid"] is True and resp.json()["requirements"]
    _record(VALIDATE, "post", resp)

    # 200 invalid
    body = {"yaml": "exporters:\n  nosuchexporter/2:\n"}
    check_request(body)
    resp = _post(client, url, body)
    assert resp.json()["valid"] is False
    assert resp.json()["errors"] == [
        {
            "message": 'unknown type: "nosuchexporter" for id: "nosuchexporter/2"',
            "componentPath": "exporters::nosuchexporter/2",
        }
    ]
    _record(VALIDATE, "post", resp)

    # 400: path and body
    for bad in (
        _post(client, "/validator/v1/validate/Not_Valid/0.162.0", {"yaml": "a: 1"}),
        _post(client, "/validator/v1/validate/otelcol-contrib/latest", {"yaml": "a: 1"}),
        _post(client, url, ["a list"]),
        _post(client, url, {"yaml": ""}),
        client.post(url, content=b"{ not json", headers=auth_headers()),
    ):
        assert bad.status_code == 400
        _record(VALIDATE, "post", bad)

    # 401
    _record(VALIDATE, "post", _post(client, url, {"yaml": "a: 1"}, headers={}))

    # 404: distribution and version
    _record(VALIDATE, "post", _post(client, "/validator/v1/validate/clickstack/2.36.0", {"yaml": "a: 1"}))
    _record(VALIDATE, "post", _post(client, "/validator/v1/validate/otelcol-contrib/0.100.0", {"yaml": "a: 1"}))

    # 409
    _record(VALIDATE, "post", _post(client, "/validator/v1/validate/otelcol-contrib/0.155.0", {"yaml": "a: 1"}))

    # 413
    big = client.post(url, content=b"x" * (MAX_BODY_BYTES + 1), headers=auth_headers())
    assert big.status_code == 413
    _record(VALIDATE, "post", big)

    # 503: not held, and busy
    _record(VALIDATE, "post", _post(client, "/validator/v1/validate/otelcol-contrib/0.161.0", {"yaml": "a: 1"}))
    client.app.state.slots = asyncio.Semaphore(0)
    busy = _post(client, url, {"yaml": "a: 1"})
    assert busy.json()["error"]["code"] == "validator_busy"
    _record(VALIDATE, "post", busy)
    client.app.state.slots = asyncio.Semaphore(1)

    # 500
    async def broken(*args, **kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(main_module, "run_validation", broken)
    _record(VALIDATE, "post", _post(client, url, {"yaml": "a: 1"}))

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
    ):
        _check("components/schemas/Error", resp.json())
    assert started.get("/nothing-here", headers=auth_headers()).status_code == 404
    assert started.get("/nothing-here").status_code == 401


async def test_a_streamed_413_conforms(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(
        app, "POST", "/validator/v1/validate/otelcol-contrib/0.162.0", auth_headers(), [b"x" * 6_000_000] * 2
    )

    assert result.status == 413
    check_answer(VALIDATE, "post", 413, result.headers, result.json())


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


def test_the_document_is_openapi_3_1_with_bearer_security() -> None:
    assert SPEC["openapi"] == "3.1.0"
    assert SPEC["components"]["securitySchemes"]["bearerAuth"] == {
        "type": "http",
        "scheme": "bearer",
        "description": SPEC["components"]["securitySchemes"]["bearerAuth"]["description"],
    }
    assert SPEC["security"] == [{"bearerAuth": []}]
    assert SPEC["paths"][HEALTH]["get"]["security"] == []
    for schema in SPEC["components"]["schemas"].values():
        Draft202012Validator.check_schema(schema)


def test_the_schema_refuses_what_the_validator_never_answers() -> None:
    """The contract is strict enough to catch a regression: `raw`, a
    snake_case path, `valid` with errors, or `invalid` without any."""
    base = {"valid": True, "errors": [], "requirements": [], "distribution": "otelcol-contrib", "version": "0.162.0"}
    pointer = "components/schemas/ValidateResponse"
    _check(pointer, base)
    for broken in (
        {**base, "valid": False},
        {**base, "errors": [{"message": "x", "componentPath": None}]},
        {**base, "requirements": [{"category": "env_var", "title": "t", "description": "d", "componentPath": None, "raw": "x"}]},
        {**base, "errors": [{"message": "x", "component_path": None}], "valid": False},
        {**base, "requirements": [{"category": "org_variable", "title": "t", "description": "d", "componentPath": None}]},
    ):
        with pytest.raises(AssertionError):
            _check(pointer, broken)
