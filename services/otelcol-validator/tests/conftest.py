"""Shared fixtures: settings with a known secret, the test catalog, and a
fake collector (a shell script standing in for `otelcol-contrib`)."""

from __future__ import annotations

import stat
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Secrets, Settings

SECRET = "current-secret-0123456789abcdefghijklmnopq"
PREVIOUS_SECRET = "previous-secret-0123456789abcdefghijklmno"
FIXTURES = Path(__file__).parent / "fixtures"
CATALOG_DIR = FIXTURES / "catalog" / "distributions"
VALIDATE_URL = "/validator/v1/validate/otelcol-contrib/0.162.0"

# A collector that accepts everything.
PASSING_COLLECTOR = "exit 0\n"


def auth_headers(secret: str = SECRET) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def write_collector(binary_dir: Path, version: str, script: str) -> Path:
    """A fake `otelcol-contrib` for `version`: a POSIX shell script run as
    `<path> validate --config=<file>`, so `$2` is `--config=<file>`."""
    path = binary_dir / f"v{version}" / "otelcol-contrib"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + script)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def make_settings(binary_dir: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "secrets": Secrets(SECRET, [PREVIOUS_SECRET]),
        "binary_dir": binary_dir,
        "catalog_dir": CATALOG_DIR,
        "slot_wait_seconds": 5.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


@pytest.fixture
def binary_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "otelcol"
    directory.mkdir()
    return directory


@pytest.fixture
def client(binary_dir: Path) -> Iterator[TestClient]:
    """A client over a started app (the lifespan has run) whose 0.162.0 is a
    collector that accepts everything; 0.161.0 is offered but not held."""
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as test_client:
        yield test_client


class AsgiResult:
    def __init__(self) -> None:
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.body = b""
        self.chunks_read = 0

    def json(self) -> object:
        import json

        return json.loads(self.body)


async def call_asgi(
    app,
    method: str,
    path: str,
    headers: dict[str, str],
    chunks: list[bytes],
    *,
    forbid_body: bool = False,
) -> AsgiResult:
    """Drive the app as a server would, one body chunk per `receive`, and
    count how many chunks it asked for. With `forbid_body`, asking for any
    fails the test. The app's lifespan runs around the call."""
    result = AsgiResult()

    async def receive() -> dict:
        if forbid_body:
            raise AssertionError("the body was read")
        if result.chunks_read < len(chunks):
            chunk = chunks[result.chunks_read]
            result.chunks_read += 1
            return {"type": "http.request", "body": chunk, "more_body": result.chunks_read < len(chunks)}
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
