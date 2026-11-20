"""The tester's HTTP API (`openapi.yaml` is its contract):

  GET  /testing/v1/health — the service and kwok, no secret
  POST /testing/v1/runs   — run one test: its text, settings and input in,
                            what came out back (JSON both ways, files base64)

Every other request needs `Authorization: Bearer <secret>`, checked before
anything else (before routing, before the body is read), so without it every
path answers the same 401. Errors answer the platform's envelope
`{"error": {"code", "message"}}`; a message never quotes the request.

At start, before the secret's file is read, the process makes itself
non-dumpable (app/hardening.py). It refuses to start without a readable
secret of 32 bytes or more, or with the secret in its environment. It then
listens and starts kwok's cluster in the background (three attempts; a run is
refused 503 while kwok starts or after it failed, and once every attempt has
failed the process exits with status 1, so its restart policy starts it
afresh). Once up, the cluster's liveness is re-checked on health and before
each run; a cluster that stopped answering is failed the same way.

Run it with `uvicorn app.main:app --host 0.0.0.0 --port 8002` from the
service's directory.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import signal
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from app import hardening
from app.catalog import Catalog, VersionState, binary_path
from app.kwok import KwokState, KwokSupervisor, Starter, no_cluster
from app.kwok_cluster import start_from_environment
from app.runner import (
    SERVICE_ROOT,
    ChildNotStarted,
    CollectorUnavailable,
    Job,
    RunFailed,
    SlotUnavailable,
    finish_answer,
    run_test,
    timed_out_answer,
)
from app.scrub import Scrub
from app.settings import Settings
from telemetry import setup_telemetry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HEALTH_PATH = "/testing/v1/health"
RUNS_PATH = "/testing/v1/runs"


class _HealthAccessFilter(logging.Filter):
    """Drops uvicorn's access line for a probe's `GET /testing/v1/health`:
    probes call it every few seconds. uvicorn logs each request as
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
# httpx2 logs every request at INFO ("HTTP Request: GET https://…"). In this
# process its one caller is kwok's liveness probe (KwokCluster.is_alive), on
# every health check and before each run: a line per probe, every few
# seconds. Its warnings and errors still log. (The executors' calls
# run in the run's child, whose stderr goes nowhere.)
logging.getLogger("httpx2").setLevel(logging.WARNING)
# A request is at most 16 MiB, refused (413) as soon as it is
# declared or read past that.
MAX_BODY_BYTES = 16 * 1024 * 1024
# The platform's limit on a configuration's text, in characters.
MAX_YAML_CHARACTERS = 262_144
# A run's input, decoded, at most (the platform's uploads are 10 MB), and its
# base64 spelling's length.
MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_INPUT_BASE64_CHARACTERS = 4 * ((MAX_INPUT_BYTES + 2) // 3)
MAX_PIPELINE_CHARACTERS = 200
DISTRIBUTION = "otelcol-contrib"
SIGNALS = ("traces", "metrics", "logs")
MIN_DURATION_SECONDS = 1
MAX_DURATION_SECONDS = 60
REQUEST_FIELDS = frozenset(
    {"runId", "yaml", "pipeline", "signal", "durationSeconds", "distribution", "version", "input"}
)

# Matched whole and ASCII only, as openapi.yaml's patterns read.
_RUN_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
_BASE64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_MAX_VERSION_CHARACTERS = 64

MESSAGES = {
    "unauthorized": "Missing or invalid credentials.",
    "not_found": "Not found.",
    "payload_too_large": "The request body is larger than 16 MiB.",
    "yaml_too_long": "`yaml` is longer than 262,144 characters.",
    "input_too_large": "The input is larger than 10 MiB.",
    "body_unreadable": "The request body isn't JSON.",
    "body_not_object": "The request body must be a JSON object.",
    "body_fields": (
        "The request body must hold exactly runId, yaml, pipeline, signal, durationSeconds, "
        "distribution, version and input."
    ),
    "run_id": "`runId` must be a lower-case UUID.",
    "yaml_missing": "`yaml` must be a non-empty string.",
    "yaml_not_unicode": "`yaml` must be Unicode text.",
    "pipeline": "`pipeline` must be a string of 1 to 200 characters.",
    "signal": "`signal` must be traces, metrics or logs.",
    "duration": "`durationSeconds` must be a whole number from 1 to 60.",
    "distribution": "`distribution` must be otelcol-contrib.",
    "version_format": "`version` must be major.minor.patch.",
    "version_unknown": "The catalogue lists no such version of otelcol-contrib.",
    "input": "`input` must be an object holding only `base64`.",
    "input_base64": "`input.base64` must be standard base64.",
    "version_retired": "This collector version is retired: pick an offered version to run this test.",
    "version_unavailable": "This tester doesn't hold this collector version.",
    "tester_busy": "Every run slot is busy. Retry shortly.",
    "tester_starting": "The tester is starting. Retry shortly.",
    "tester_unavailable": "The tester is unavailable: its fake Kubernetes cluster isn't running.",
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
    """Every HTTP request but health must carry an accepted secret. It runs
    before routing and before the body is read, so an unauthenticated caller
    makes the tester read nothing and learn nothing about its routes."""

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
    header = values[0].decode("latin-1")
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


def _invalid(key: str) -> ApiError:
    return ApiError(400, "invalid_request", MESSAGES[key])


def _unicode(value: str) -> bool:
    """JSON can spell a lone surrogate (`"\\ud800"`), which no text holds."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _decoded_length(encoded: str) -> int:
    return len(encoded) // 4 * 3 - (len(encoded) - len(encoded.rstrip("=")))


def parse_request(body: bytes) -> dict:
    """The body's fields, each checked: 400 `invalid_request` for
    anything the contract refuses, 413 for a text or an input past its
    limit. The input stays base64 here (`decode_input` decodes it)."""
    try:
        document = json.loads(body)
    except Exception:
        # Bad JSON or encoding (ValueError), nesting deeper than the parser
        # recurses (RecursionError): unreadable, never a 500.
        raise _invalid("body_unreadable") from None
    if not isinstance(document, dict):
        raise _invalid("body_not_object")
    if set(document) != REQUEST_FIELDS:
        raise _invalid("body_fields")
    run_id = document["runId"]
    if not isinstance(run_id, str) or not _RUN_ID_RE.fullmatch(run_id):
        raise _invalid("run_id")
    yaml_content = document["yaml"]
    if not isinstance(yaml_content, str) or not yaml_content:
        raise _invalid("yaml_missing")
    if len(yaml_content) > MAX_YAML_CHARACTERS:
        raise ApiError(413, "payload_too_large", MESSAGES["yaml_too_long"])
    if not _unicode(yaml_content):
        raise _invalid("yaml_not_unicode")
    pipeline = document["pipeline"]
    if (
        not isinstance(pipeline, str)
        or not 1 <= len(pipeline) <= MAX_PIPELINE_CHARACTERS
        or not _unicode(pipeline)
    ):
        raise _invalid("pipeline")
    if document["signal"] not in SIGNALS:
        raise _invalid("signal")
    duration = document["durationSeconds"]
    if (
        not isinstance(duration, int)
        or isinstance(duration, bool)
        or not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS
    ):
        raise _invalid("duration")
    if document["distribution"] != DISTRIBUTION:
        raise _invalid("distribution")
    version = document["version"]
    if not isinstance(version, str) or len(version) > _MAX_VERSION_CHARACTERS or not _VERSION_RE.fullmatch(version):
        raise _invalid("version_format")
    carried = document["input"]
    if not isinstance(carried, dict) or set(carried) != {"base64"} or not isinstance(carried["base64"], str):
        raise _invalid("input")
    encoded = carried["base64"]
    if len(encoded) % 4 != 0 or not _BASE64_RE.fullmatch(encoded):
        raise _invalid("input_base64")
    if len(encoded) > MAX_INPUT_BASE64_CHARACTERS or _decoded_length(encoded) > MAX_INPUT_BYTES:
        raise ApiError(413, "input_too_large", MESSAGES["input_too_large"])
    return document


def decode_input(encoded: str) -> bytes:
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise _invalid("input_base64") from None


async def _watch_disconnect(receive: Receive, handler: asyncio.Task) -> bool:
    """Once the body is read, the next message a server sends is the
    client's disconnect (or nothing until the answer is sent). On one, the
    request's handler is canceled, which kills the run's group."""
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            handler.cancel()
            return True


# The process's exit status when kwok failed for good: compose's
# restart policy starts the tester afresh.
EXIT_KWOK_FAILED = 1


def _exit_for_kwok(app: FastAPI) -> None:
    """kwok failed every attempt, or its cluster stopped answering (Ruling
    29): shut the server down (SIGTERM to itself,
    uvicorn's graceful path) and, once the lifespan has stopped everything,
    exit with ``EXIT_KWOK_FAILED``."""
    app.state.exit_status = EXIT_KWOK_FAILED
    os.kill(os.getpid(), signal.SIGTERM)


def create_app(
    settings: Settings | None = None,
    *,
    kwok_starter: Starter | None = None,
    exit_on_kwok_failure: bool = False,
) -> FastAPI:
    """The application. Settings are read from the environment at startup
    unless given (the tests give them); a missing, unreadable or short
    secret, or an unreadable catalog, stops the startup.

    ``kwok_starter`` brings kwok's cluster up (none by default: the tests'
    app); with ``exit_on_kwok_failure``, a cluster that fails every attempt
    ends the process with a non-zero status. The service's own
    app (``app`` below) has both."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Before the secret's file is read.
        hardening.make_not_dumpable()
        loaded = settings if settings is not None else Settings.from_environment(os.environ)
        catalog = Catalog.load(loaded.catalog_dir)
        app.state.settings = loaded
        app.state.catalog = catalog
        app.state.slots = asyncio.Semaphore(loaded.max_concurrency)
        app.state.service_dirs = tuple(
            directory
            for directory in (
                str(SERVICE_ROOT),
                str(loaded.binary_dir),
                str(loaded.catalog_dir),
                os.environ.get("HOME", ""),
            )
            if directory
        )
        app.state.exit_status = None
        supervisor = KwokSupervisor(
            kwok_starter or no_cluster,
            attempts=loaded.kwok_start_attempts,
            backoff_seconds=loaded.kwok_retry_backoff_seconds,
            on_gave_up=(lambda: _exit_for_kwok(app)) if exit_on_kwok_failure else None,
        )
        app.state.kwok = supervisor
        supervisor.start()
        # One turn of the loop: a starter with nothing to wait for (the
        # tests' no_cluster) is done before the first request; kwok's own
        # start takes seconds, answered `starting` meanwhile.
        await asyncio.sleep(0)
        held = sum(
            1 for version in catalog.offered_versions(DISTRIBUTION) if binary_path(loaded.binary_dir, version).is_file()
        )
        logger.info(
            "otelcol-testing ready: %d offered version(s) held, %d run slot(s), %d secret(s) accepted",
            held,
            loaded.max_concurrency,
            len(loaded.secrets),
        )
        try:
            yield
        finally:
            await supervisor.stop()
            if app.state.exit_status is not None:
                # Everything is stopped: end the process with kwok's status
                # (uvicorn would otherwise exit by the SIGTERM it caught).
                logging.shutdown()
                sys.stdout.flush()
                os._exit(app.state.exit_status)

    app = FastAPI(
        title="telflo otelcol-testing",
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

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, error: Exception) -> JSONResponse:
        # Anything no handler expected: the envelope too, never a traceback
        # or a plain-text 500. The type only is logged.
        logger.error("a request failed unexpectedly: %s", type(error).__name__)
        return error_response(500, "internal_error", MESSAGES["internal_error"])

    @app.get(HEALTH_PATH)
    async def health(request: Request) -> JSONResponse:
        # A ready cluster's liveness is re-checked.
        state: KwokState = await request.app.state.kwok.check_alive()
        if state is KwokState.READY:
            return JSONResponse({"status": "ok", "kwok": "ready"})
        if state is KwokState.STARTING:
            return JSONResponse({"status": "starting", "kwok": "starting"}, status_code=503)
        return JSONResponse({"status": "unavailable", "kwok": "failed"}, status_code=503)

    @app.post(RUNS_PATH)
    async def run(request: Request) -> Response:
        loaded: Settings = request.app.state.settings
        catalog: Catalog = request.app.state.catalog
        supervisor: KwokSupervisor = request.app.state.kwok
        # Refusals before the body is read. A run is never served without
        # kwok, and a ready cluster's liveness is re-checked before each run:
        # one that stopped answering is `failed`, and the service exits.
        state = await supervisor.check_alive()
        if state is KwokState.STARTING:
            raise ApiError(503, "tester_starting", MESSAGES["tester_starting"])
        if state is KwokState.FAILED:
            raise ApiError(503, "tester_unavailable", MESSAGES["tester_unavailable"])
        body = await read_body_limited(request)
        document = await asyncio.to_thread(parse_request, body)
        version = document["version"]
        state = catalog.state(DISTRIBUTION, version)
        if state is VersionState.UNKNOWN:
            # Its own code: the platform ends the run as version_retired, not
            # as a request it got wrong.
            raise ApiError(400, "version_unknown", MESSAGES["version_unknown"])
        if state is VersionState.RETIRED:
            raise ApiError(409, "version_retired", MESSAGES["version_retired"])
        collector = binary_path(loaded.binary_dir, version)
        if not collector.is_file():
            raise ApiError(503, "version_unavailable", MESSAGES["version_unavailable"])
        job = Job(
            run_id=document["runId"],
            binary=collector,
            yaml=document["yaml"],
            pipeline=document["pipeline"],
            signal=document["signal"],
            duration_seconds=document["durationSeconds"],
            version=version,
            input=await asyncio.to_thread(decode_input, document["input"]["base64"]),
        )
        del body, document
        cluster = supervisor.endpoint
        # The run's workspace, as the runner makes it: the answer's every
        # field is scrubbed of it, not only what the child scrubs.
        workspaces: list[str] = []

        handler = asyncio.current_task()
        assert handler is not None
        watcher = asyncio.create_task(_watch_disconnect(request.receive, handler), name="disconnect watch")
        started = time.monotonic()
        budget = loaded.request_budget_seconds(job.duration_seconds)
        try:
            try:
                async with asyncio.timeout(budget):
                    answer = await run_test(
                        job,
                        slots=request.app.state.slots,
                        slot_wait_seconds=loaded.slot_wait_seconds,
                        deadline_seconds=loaded.run_deadline_seconds(job.duration_seconds),
                        service_dirs=request.app.state.service_dirs,
                        cluster=cluster,
                        record_workspace=workspaces.append,
                    )
            except TimeoutError:
                # The request's budget ran out: the run's group is dead and
                # its workspace gone (run_test's cleanup ran on the way out).
                answer = timed_out_answer(job, budget, int((time.monotonic() - started) * 1000))
        except asyncio.CancelledError:
            if watcher.done() and not watcher.cancelled() and watcher.result():
                # The client went away: the run is ended; nobody reads this.
                handler.uncancel()
                logger.warning("run %s: the client went away; the run was stopped", job.run_id)
                return error_response(500, "internal_error", MESSAGES["internal_error"])
            raise
        except SlotUnavailable:
            logger.warning("run %s refused: every slot stayed busy", job.run_id)
            raise ApiError(503, "tester_busy", MESSAGES["tester_busy"]) from None
        except ChildNotStarted as error:
            # The tester's own trouble, not the version's.
            logger.error("run %s: the run's child process could not be started: %s", job.run_id, error.kind)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        except CollectorUnavailable as error:
            # Only the collector's exec failing with an exec errno (Rulings
            # 27, 29): the version isn't available.
            logger.error("run %s: otelcol-contrib could not be run: %s", job.run_id, error)
            raise ApiError(503, "version_unavailable", MESSAGES["version_unavailable"]) from None
        except RunFailed as error:  # how the child failed, never the text
            logger.error("run %s failed unexpectedly: %s", job.run_id, error.kind)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        except Exception as error:  # never the text: the type only
            logger.error("run %s failed unexpectedly: %s", job.run_id, type(error).__name__)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        finally:
            watcher.cancel()

        scrub = Scrub.for_run(
            workspace=workspaces[0] if workspaces else None,
            kubeconfig=cluster.kubeconfig if cluster else None,
            service_dirs=request.app.state.service_dirs,
            secrets=loaded.redactions.values(),
        )
        try:
            rendered = await asyncio.to_thread(finish_answer, answer, scrub)
        except RunFailed as error:
            logger.error("run %s failed unexpectedly: %s", job.run_id, error.kind)
            raise ApiError(500, "internal_error", MESSAGES["internal_error"]) from None
        logger.info(
            "run %s finished: status=%s error=%s elapsed_ms=%d",
            job.run_id,
            answer["status"],
            answer.get("error", {}).get("code", "none"),
            int((time.monotonic() - started) * 1000),
        )
        return Response(rendered, media_type="application/json")

    # Self-instrumentation: a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    # (so it is inert in the tests). Health probes are not traced.
    setup_telemetry(app, default_service_name="telflo-otelcol-testing", excluded_urls="testing/v1/health")
    return app


# The service: kwok's cluster started from the image.
app = create_app(kwok_starter=start_from_environment, exit_on_kwok_failure=True)
