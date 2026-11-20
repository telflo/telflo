"""Shared fixtures: settings with a known secret (from a file, as the service
reads it), the test catalogue, fake collectors (scripts standing in for
`otelcol-contrib`, as the validator's conftest has), and a request body.

`write_fake_collector` writes the fake that behaves as a collector does for the
run: it reads the configuration the run wrote, listens where the sandbox's
receiver says (the OTLP/HTTP receiver, accepting an OTLP document of the right
signal and refusing anything else with 400; the syslog TCP listener), reads the
filelog receiver's staged file, writes what it received to the file exporter's
path one JSON line per document, prints the collector's "Everything is ready"
line, and exits 0 on SIGTERM. Code a test gives runs before it reads anything
(``prelude``) and once it is ready (``after_ready``). `write_collector` writes
a shell script for the tests whose fake never becomes ready (the kill
tests)."""

from __future__ import annotations

import base64
import json
import stat
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Redactions, Secrets, Settings

SECRET = "current-secret-0123456789abcdefghijklmnopq"
PREVIOUS_SECRET = "previous-secret-0123456789abcdefghijklmno"
FIXTURES = Path(__file__).parent / "fixtures"
CATALOG_DIR = FIXTURES / "catalog" / "distributions"
RUNS_URL = "/testing/v1/runs"
HEALTH_URL = "/testing/v1/health"
VERSION = "0.162.0"
RUN_ID = "0192a4b8-7c3d-7e5f-8a9b-0c1d2e3f4a5b"
TEXT = "receivers:\n  otlp:\n    protocols:\n      http:\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n"

# A collector that runs until it is stopped (SIGTERM ends `sleep`, so it
# exits as a stopped collector does: 143). It never listens, so a run that
# waits for it to be ready gives up after the readiness limit.
WAITING_COLLECTOR = "exec sleep 600\n"

READY_LINE = "Everything is ready. Begin running and processing data."

FAKE_COLLECTOR = r'''
import json, os, signal, socket, sys, threading, time
import yaml

CONFIG = sys.argv[2]

# --- the test's prelude ---
{prelude}
# ---

config = yaml.safe_load(open(CONFIG, encoding="utf-8")) or {{}}
receivers = config.get("receivers") or {{}}
exporters = config.get("exporters") or {{}}
output_path = (exporters.get("file/test_out") or {{}}).get("path")
output_lock = threading.Lock()
# How many payloads the OTLP receiver has answered (for a test's after_ready).
answered = [0]
KEYS = {{"/v1/logs": "resourceLogs", "/v1/metrics": "resourceMetrics", "/v1/traces": "resourceSpans"}}


def emit(document):
    if output_path is None:
        return
    with output_lock, open(output_path, "a", encoding="utf-8") as file:
        file.write(json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n")


def record(body):
    return {{"resourceLogs": [{{"resource": {{}}, "scopeLogs": [{{"scope": {{}}, "logRecords": [{{"body": {{"stringValue": body}}}}]}}]}}]}}


for name, settings in receivers.items():
    settings = settings or {{}}
    kind = name.split("/", 1)[0]
    if kind == "otlp":
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                key = KEYS.get(self.path)
                try:
                    document = json.loads(body)
                except ValueError:
                    document = None
                if key is None or not isinstance(document, dict) or key not in document:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{{"code":3,"message":"the payload is not an OTLP document of this signal"}}')
                    return
                emit(document)
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b"{{}}")
                self.wfile.flush()
                answered[0] += 1

            def log_message(self, *args):
                pass

        host, port = settings["protocols"]["http"]["endpoint"].rsplit(":", 1)
        server = ThreadingHTTPServer((host, int(port)), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    elif kind == "syslog":
        host, port = settings["tcp"]["listen_address"].rsplit(":", 1)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((host, int(port)))
        listener.listen()

        def serve(listener=listener):
            while True:
                connection, _ = listener.accept()
                data = b""
                while True:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                connection.close()
                for line in data.decode("utf-8", "replace").splitlines():
                    if line.strip():
                        emit(record(line))

        threading.Thread(target=serve, daemon=True).start()
    elif kind == "filelog":
        # As filelog polls: a file staged after the start (a run with a
        # Kubernetes processor stages it once the informer wait is over) is
        # read once it appears.
        def tail(paths=list(settings.get("include") or [])):
            for path in paths:
                while not os.path.exists(path):
                    time.sleep(0.02)
                with open(path, encoding="utf-8", errors="replace") as file:
                    for line in file:
                        if line.strip():
                            emit(record(line.rstrip("\n")))

        if all(os.path.exists(path) for path in settings.get("include") or []):
            tail()
        else:
            threading.Thread(target=tail, daemon=True).start()


def stop(*_):
    sys.stderr.write("Shutdown complete.\n")
    sys.stderr.flush()
    os._exit(0)


signal.signal(signal.SIGTERM, stop)
sys.stderr.write("{ready}\n")
sys.stderr.flush()

# --- the test's code once ready ---
{after_ready}
# ---

# Short sleeps: Linux may hand SIGTERM to the server's thread, and Python runs
# the handler only on the main thread, at its next wake. A long sleep outlives
# the watchdog's 5 s grace, which then kills this fake (exit 137).
while True:
    time.sleep(0.05)
'''


def auth_headers(secret: str = SECRET) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def write_collector(binary_dir: Path, version: str, script: str) -> Path:
    """A fake `otelcol-contrib` for `version`: a POSIX shell script run as
    `<path> --config <file>` in the run's workspace, so `$2` is the
    configuration's path and the working directory is the workspace."""
    path = binary_dir / f"v{version}" / "otelcol-contrib"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + script)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def write_python_collector(binary_dir: Path, version: str, source: str) -> Path:
    """A fake `otelcol-contrib` written in Python, run by this interpreter
    (which has PyYAML): `sys.argv[2]` is the configuration's path."""
    path = binary_dir / f"v{version}" / "otelcol-contrib"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!{sys.executable}\n{source}")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def write_fake_collector(binary_dir: Path, version: str = VERSION, *, prelude: str = "", after_ready: str = "") -> Path:
    """The fake collector (see the module's docstring), run by this
    interpreter (which has PyYAML). ``prelude`` and ``after_ready`` are
    Python, at the top level (``CONFIG`` is the configuration's path)."""
    source = FAKE_COLLECTOR.format(prelude=prelude, after_ready=after_ready, ready=READY_LINE)
    return write_python_collector(binary_dir, version, source)


def make_settings(binary_dir: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "secrets": Secrets(SECRET, [PREVIOUS_SECRET]),
        "redactions": Redactions([SECRET, PREVIOUS_SECRET]),
        "binary_dir": binary_dir,
        "catalog_dir": CATALOG_DIR,
        "slot_wait_seconds": 5.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def run_body(**overrides: object) -> dict:
    """A request the contract accepts: TEXT on the `logs` pipeline for one
    second, with a small input."""
    body: dict[str, object] = {
        "runId": RUN_ID,
        "yaml": TEXT,
        "pipeline": "logs",
        "signal": "logs",
        "durationSeconds": 1,
        "distribution": "otelcol-contrib",
        "version": VERSION,
        "input": {"base64": base64.b64encode(b'{"resourceLogs":[]}').decode("ascii")},
    }
    body.update(overrides)
    return body


@pytest.fixture
def binary_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "otelcol"
    directory.mkdir()
    return directory


@pytest.fixture
def secret_file(tmp_path: Path) -> Path:
    path = tmp_path / "secrets" / "otelcol_testing_secret"
    path.parent.mkdir()
    path.write_text(SECRET + "\n")
    return path


@pytest.fixture
def client(binary_dir: Path) -> Iterator[TestClient]:
    """A client over a started app (the lifespan has run) whose 0.162.0 is the
    fake collector; 0.161.0 is offered but not held."""
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app(make_settings(binary_dir))) as test_client:
        yield test_client


class AsgiResult:
    def __init__(self) -> None:
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.body = b""
        self.chunks_read = 0

    def json(self) -> object:
        return json.loads(self.body)


async def call_asgi(
    app,
    method: str,
    path: str,
    headers: dict[str, str],
    chunks: list[bytes],
    *,
    forbid_body: bool = False,
    disconnect=None,
) -> AsgiResult:
    """Drive the app as a server would, one body chunk per `receive`, and
    count how many chunks it asked for. With `forbid_body`, asking for any
    fails the test. Once the body is read, `receive` waits for `disconnect`
    (an asyncio.Event) when given, then says the client went away. The
    app's lifespan runs around the call."""
    import asyncio

    result = AsgiResult()
    gone = disconnect if disconnect is not None else asyncio.Event()

    async def receive() -> dict:
        if forbid_body:
            raise AssertionError("the body was read")
        if result.chunks_read < len(chunks):
            chunk = chunks[result.chunks_read]
            result.chunks_read += 1
            return {"type": "http.request", "body": chunk, "more_body": result.chunks_read < len(chunks)}
        await gone.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            result.status = message["status"]
            result.headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in message.get("headers", [])}
        elif message["type"] == "http.response.body":
            result.body += message.get("body", b"")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    async with app.router.lifespan_context(app):
        await app(scope, receive, send)
    return result
