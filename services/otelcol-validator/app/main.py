"""The validator's HTTP API (`openapi.yaml` is its contract):

  GET  /health                                         — liveness, no secret
  POST /validator/v1/validate/{distribution}/{version} — check a text

Every other request needs `Authorization: Bearer <secret>`, checked before
anything else (before routing, before the body is read), so without it every
path answers the same 401. Errors answer the platform's envelope
`{"error": {"code", "message"}}`; a message never quotes the request.

Run it with `uvicorn app.main:app --host 0.0.0.0 --port 8001` from the
service's directory. It refuses to start without OTELCOL_VALIDATOR_SECRET.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from app.catalog import Catalog, VersionState, binary_path
from app.runner import CheckFailed, ChildNotStarted, SlotUnavailable, run_validation
from app.settings import Settings
from telemetry import setup_telemetry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HEALTH_PATH = "/health"
VALIDATE_PATH = "/validator/v1/validate/{distribution}/{version}"


class _HealthAccessFilter(logging.Filter):
    """Drops uvicorn's access line for a probe's `GET /health`: probes call
    it every few seconds. uvicorn logs each request as
    `'%s - "%s %s HTTP/%s" %d'` with (client, method, path with query, HTTP
    version, status); every other line, and every other request's, logs as
    before."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            method, path = args[1], args[2]
            if method == "GET" and isinstance(path, str) and path.split("?", 1)[0] == HEALTH_PATH:
                return False
        return True


# Here, not in create_app(), which tests call many times: one filter per
# process. uvicorn configures its loggers before it imports the app, so the
# filter stays.
logging.getLogger("uvicorn.access").addFilter(_HealthAccessFilter())
# 2 MiB, enforced while the body is read. The longest body these limits allow
# is about 1.61 MiB (the platform's own is about 1.4 MB: its limit counts
# UTF-16 units, at most 3 bytes each): the text at most 262,144 characters,
# 1 MiB as four-byte ones; 150 values of 1,024 four-byte characters, 600 KiB;
# 150 names of 128, 18.75 KiB; and the JSON around them. JSON.stringify
# writes every character as itself: only `"`, `\` and a tab, line feed or
# carriage return are escaped, in 2 bytes, fewer than a four-byte character's
# (the text holds no other control character, a value none at all).
MAX_BODY_BYTES = 2 * 1024 * 1024
# The platform's limit on a configuration's text
# (CONFIGURATION_YAML_MAXIMUM_LENGTH), in characters.
MAX_YAML_CHARACTERS = 262_144
# The opamp-server's bounds on an organization's variables
# (`store/orgvariables`): at most 150, a name of the grammar of at most 128
# characters, a value of at most 1,024 characters on one line (no C0, DEL,
# C1, U+2028 or U+2029, written here as escapes).
MAX_ORGANIZATION_VARIABLES = 150
MAX_VARIABLE_NAME_CHARACTERS = 128
MAX_VARIABLE_VALUE_CHARACTERS = 1024
_VARIABLE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_VALUE_REFUSED_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")

# Matched whole (fullmatch: `$` would let a trailing line break through) and
# ASCII only (`[0-9]`, not `\d`, which takes any Unicode digit), as
# openapi.yaml's patterns read.
_DISTRIBUTION_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
_MAX_PATH_PART = 64

MESSAGES = {
    "unauthorized": "Missing or invalid credentials.",
    "not_found": "Not found.",
    "distribution_format": "The distribution must be lowercase words joined by single hyphens.",
    "version_format": "The version must be major.minor.patch.",
    "distribution_unknown": "The catalogue lists no such distribution.",
    "version_unknown": "The catalogue lists no such version of this distribution.",
    "version_retired": "This collector version is retired: pick an offered version to check this configuration.",
    "version_unavailable": "This validator doesn't hold this collector version.",
    "validator_busy": "Every validation slot is busy. Retry shortly.",
    "payload_too_large": "The request body is larger than 2 MiB.",
    "yaml_too_long": "`yaml` is longer than 262,144 characters.",
    "body_unreadable": "The request body isn't JSON.",
    "body_not_object": "The request body must be a JSON object.",
    "body_fields": "The request body must hold only `yaml` and `organizationVariables`.",
    "organization_variables": (
        "`organizationVariables` must map at most 150 variable names to values of at most 1,024 characters on one line."
    ),
    "yaml_missing": "`yaml` must be a non-empty string.",
    "yaml_not_unicode": "`yaml` must be Unicode text.",
    "content_length": "Content-Length must be a whole number.",
    "malformed": "The request is malformed.",
    "internal_error": "Internal server error.",
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


def error_response(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=headers)


def _unauthorized() -> JSONResponse:
    return error_response(401, "unauthorized", MESSAGES["unauthorized"], {"WWW-Authenticate": "Bearer"})


class BearerAuthMiddleware:
    """Every HTTP request but `/health` must carry an accepted secret. It runs
    before routing and before the body is read, so an unauthenticated caller
    makes the validator read nothing and learn nothing about its routes."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") == HEALTH_PATH:
            await self.app(scope, receive, send)
            return
        settings: Settings | None = getattr(scope["app"].state, "settings", None)
        token = _bearer_token(scope)
        if settings is None or token is None or not settings.secrets.accepts(token):
            await _unauthorized()(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _bearer_token(scope: Scope) -> str | None:
    values = [value for name, value in scope.get("headers", []) if name == b"authorization"]
    if len(values) != 1:
        return None
    try:
        header = values[0].decode("latin-1")
    except UnicodeDecodeError:  # pragma: no cover - latin-1 decodes every byte
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


async def read_body_limited(request: Request, limit: int = MAX_BODY_BYTES) -> bytes:
    """Read the body, refusing it (413) as soon as it passes `limit` bytes:
    a declared Content-Length over the limit before any of it is read, and a
    streamed body at the first chunk that takes it over."""
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.strip().isdigit():
            raise ApiError(400, "invalid_request", MESSAGES["content_length"])
        if int(declared) > limit:
            raise ApiError(413, "payload_too_large", MESSAGES["payload_too_large"])
    received = bytearray()
    async for chunk in request.stream():
        received.extend(chunk)
        if len(received) > limit:
            raise ApiError(413, "payload_too_large", MESSAGES["payload_too_large"])
    return bytes(received)


def parse_body(body: bytes) -> tuple[str, dict[str, str]]:
    """The body's `yaml` and its `organizationVariables` (none when left
    out): 400 for anything but `{"yaml": "<non-empty>"}` with an optional
    name-to-value object within the opamp-server's bounds (a text or a value
    that isn't Unicode included), 413 for a text longer than the platform
    allows. No message quotes a name or a value."""
    try:
        document = json.loads(body)
    except Exception:
        # Whatever stops the decoding (bad JSON or encoding: ValueError;
        # nesting deeper than the parser recurses: RecursionError), the
        # body is unreadable, never a 500.
        raise ApiError(400, "invalid_request", MESSAGES["body_unreadable"]) from None
    if not isinstance(document, dict):
        raise ApiError(400, "invalid_request", MESSAGES["body_not_object"])
    if set(document) - {"yaml", "organizationVariables"}:
        raise ApiError(400, "invalid_request", MESSAGES["body_fields"])
    yaml_content = document.get("yaml")
    if not isinstance(yaml_content, str) or not yaml_content:
        raise ApiError(400, "invalid_request", MESSAGES["yaml_missing"])
    if len(yaml_content) > MAX_YAML_CHARACTERS:
        raise ApiError(413, "payload_too_large", MESSAGES["yaml_too_long"])
    try:
        # JSON can spell a lone surrogate (`"\ud800"`), which no file holds
        # (a 400, never a 500).
        yaml_content.encode("utf-8")
    except UnicodeEncodeError:
        raise ApiError(400, "invalid_request", MESSAGES["yaml_not_unicode"]) from None
    values = document.get("organizationVariables", {})
    if not _valid_organization_variables(values):
        raise ApiError(400, "invalid_request", MESSAGES["organization_variables"])
    return yaml_content, values


def _valid_organization_variables(values: object) -> bool:
    """Whether `values` is a name-to-value object within the opamp-server's
    bounds (openapi.yaml's ValidateRequest.organizationVariables)."""
    if not isinstance(values, dict) or len(values) > MAX_ORGANIZATION_VARIABLES:
        return False
    for name, value in values.items():
        if len(name) > MAX_VARIABLE_NAME_CHARACTERS or not _VARIABLE_NAME_RE.fullmatch(name):
            return False
        if not isinstance(value, str) or len(value) > MAX_VARIABLE_VALUE_CHARACTERS or _VALUE_REFUSED_RE.search(value):
            return False
        try:
            value.encode("utf-8")  # a lone surrogate, which JSON can spell
        except UnicodeEncodeError:
            return False
    return True


def create_app(settings: Settings | None = None) -> FastAPI:
    """The application. Settings are read from the environment at startup
    unless given (the tests give them); a missing or short secret, or an
    unreadable catalogue, stops the startup."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        loaded = settings if settings is not None else Settings.from_environment(os.environ)
        catalog = Catalog.load(loaded.catalog_dir)
        app.state.settings = loaded
        app.state.catalog = catalog
        app.state.slots = asyncio.Semaphore(loaded.max_concurrency)
        held = sum(
            1
            for distribution in catalog.distributions
            for version in catalog.offered_versions(distribution)
            if binary_path(loaded.binary_dir, version).is_file()
        )
        logger.info(
            "otelcol-validator ready: %d distribution(s), %d offered version(s) held, %d secret(s) accepted",
            len(catalog.distributions),
            held,
            len(loaded.secrets),
        )
        yield

    app = FastAPI(
        title="telflo otelcol-validator",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(BearerAuthMiddleware)

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, error: ApiError) -> JSONResponse:
        return error_response(error.status, error.code, error.message)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, error: StarletteHTTPException) -> JSONResponse:
        # A path or method no route has (404, 405): one answer for both.
        if error.status_code in (404, 405):
            return error_response(404, "not_found", MESSAGES["not_found"])
        return error_response(error.status_code, "invalid_request", MESSAGES["malformed"])

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        # Never echo the request (FastAPI's default would).
        return error_response(400, "invalid_request", MESSAGES["body_unreadable"])

    @app.get(HEALTH_PATH)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(VALIDATE_PATH)
    async def validate(distribution: str, version: str, request: Request) -> JSONResponse:
        # Cheap refusals first, before the body is read.
        if len(distribution) > _MAX_PATH_PART or not _DISTRIBUTION_RE.fullmatch(distribution):
            raise ApiError(400, "invalid_request", MESSAGES["distribution_format"])
        if len(version) > _MAX_PATH_PART or not _VERSION_RE.fullmatch(version):
            raise ApiError(400, "invalid_request", MESSAGES["version_format"])
        catalog: Catalog = request.app.state.catalog
        loaded: Settings = request.app.state.settings
        if distribution not in catalog.distributions:
            raise ApiError(404, "not_found", MESSAGES["distribution_unknown"])
        state = catalog.state(distribution, version)
        if state is VersionState.UNKNOWN:
            raise ApiError(404, "not_found", MESSAGES["version_unknown"])
        if state is VersionState.RETIRED:
            raise ApiError(409, "version_retired", MESSAGES["version_retired"])
        collector = binary_path(loaded.binary_dir, version)
        if not collector.is_file():
            raise ApiError(503, "version_unavailable", MESSAGES["version_unavailable"])

        yaml_content, organization_variables = parse_body(await read_body_limited(request))
        try:
            result = await run_validation(
                collector,
                yaml_content,
                slots=request.app.state.slots,
                slot_wait_seconds=loaded.slot_wait_seconds,
                timeout_seconds=loaded.validate_timeout,
                deadline_seconds=loaded.check_deadline_seconds,
                organization_variables=organization_variables,
            )
        except SlotUnavailable:
            logger.warning("validation refused: every slot stayed busy")
            raise ApiError(503, "validator_busy", MESSAGES["validator_busy"]) from None
        except ChildNotStarted as error:
            # The service's own interpreter or directory is unusable: not the
            # collector's fault, but nothing is checked either.
            logger.error("the check's child process could not be started: %s", error.kind)
            raise ApiError(503, "version_unavailable", MESSAGES["version_unavailable"]) from None
        except OSError as error:
            # The binary vanished or can't be run: the version isn't available.
            logger.error("otelcol-contrib could not be run: %s", type(error).__name__)
            raise ApiError(503, "version_unavailable", MESSAGES["version_unavailable"]) from None
        except CheckFailed as error:  # how the check's child failed, never the text
            logger.error("validation failed unexpectedly: %s", error.kind)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        except Exception as error:  # never the text: the type only
            logger.error("validation failed unexpectedly: %s", type(error).__name__)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        return JSONResponse(
            {
                "valid": result.valid,
                "errors": result.errors,
                "requirements": result.requirements,
                "distribution": distribution,
                "version": version,
            }
        )

    # Self-instrumentation: a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    # (so it is inert in the tests). Health probes are not traced.
    setup_telemetry(app, default_service_name="telflo-otelcol-validator", excluded_urls="health")
    return app


app = create_app()
