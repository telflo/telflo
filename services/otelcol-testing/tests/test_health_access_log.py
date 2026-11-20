"""A probe's health request writes no log line: probes and the platform's
health monitor call it every few seconds.
The filter on `uvicorn.access` drops only uvicorn's line for `GET` on the
health path (its query aside); every other request's line logs as before.
The records here have the shape uvicorn logs each request with: (client,
method, path with query, HTTP version, status). And the health check's own
liveness probe of kwok's apiserver writes nothing either: httpx2's
per-request INFO line is off in the service."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx2
import pytest

from app.executors._shared import _wait_for_pod_listable
from app.kwok import KwokState
from app.kwok_cluster import SEED_NAMESPACE, SEED_POD_NAME
from app.main import HEALTH_PATH, RUNS_PATH, create_app
from tests.conftest import VERSION, make_settings, write_collector

ACCESS_FORMAT = '%s - "%s %s HTTP/%s" %d'


def _access_lines(caplog: pytest.LogCaptureFixture, method: str, path: str) -> list[logging.LogRecord]:
    caplog.set_level(logging.INFO, logger="uvicorn.access")
    caplog.clear()
    logging.getLogger("uvicorn.access").info(ACCESS_FORMAT, "127.0.0.1:1", method, path, "1.1", 200)
    return [record for record in caplog.records if record.name == "uvicorn.access"]


@pytest.mark.parametrize("path", [HEALTH_PATH, f"{HEALTH_PATH}?x=1"])
def test_a_health_probe_writes_no_access_line(caplog: pytest.LogCaptureFixture, path: str) -> None:
    assert _access_lines(caplog, "GET", path) == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", RUNS_PATH),
        ("POST", HEALTH_PATH),
        ("GET", f"{HEALTH_PATH}/"),
        ("GET", "/health"),
        ("GET", f"{HEALTH_PATH}x?x=1"),
    ],
)
def test_every_other_request_still_writes_its_access_line(
    caplog: pytest.LogCaptureFixture, method: str, path: str
) -> None:
    records = _access_lines(caplog, method, path)
    assert [record.getMessage() for record in records] == [f'127.0.0.1:1 - "{method} {path} HTTP/1.1" 200']


def test_another_access_logger_line_still_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="uvicorn.access")
    logging.getLogger("uvicorn.access").info("a line of another shape: %s", HEALTH_PATH)
    assert [record.getMessage() for record in caplog.records] == [f"a line of another shape: {HEALTH_PATH}"]


@pytest.fixture
def apiserver() -> Iterator[tuple[str, list[str]]]:
    """A loopback stand-in for kwok's apiserver: 200 for every GET, each
    path recorded."""
    paths: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server's name
            paths.append(self.path)
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - http.server's name
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", paths
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=30)


class ProbedCluster:
    """A started cluster whose liveness probe is KwokCluster.is_alive's
    (the same client, the same request), over plain HTTP to `apiserver`."""

    def __init__(self, kubeconfig: Path, apiserver_url: str) -> None:
        self.kubeconfig = kubeconfig
        self.apiserver_url = apiserver_url
        self.seed_pod_uid: str | None = None
        self.pki_dir: Path | None = None

    async def is_alive(self) -> bool:
        return await _wait_for_pod_listable(
            self.apiserver_url, SEED_NAMESPACE, SEED_POD_NAME, timeout_seconds=5.0, warn_on_timeout=False
        )

    async def stop(self) -> None:
        pass


async def test_a_health_check_logs_nothing_though_it_probes_kwok(
    binary_dir: Path, tmp_path: Path, caplog: pytest.LogCaptureFixture, apiserver: tuple[str, list[str]]
) -> None:
    url, paths = apiserver
    write_collector(binary_dir, VERSION, "exec sleep 600\n")
    cluster = ProbedCluster(tmp_path / "kwok" / "kubeconfig.yaml", url)

    async def starter() -> ProbedCluster:
        return cluster

    caplog.set_level(logging.INFO)
    app = create_app(make_settings(binary_dir), kwok_starter=starter)
    async with app.router.lifespan_context(app):
        for _ in range(1000):
            if app.state.kwok.state is KwokState.READY:
                break
            await asyncio.sleep(0.001)
        assert app.state.kwok.state is KwokState.READY
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
            # The probe's line exists when httpx2 logs at INFO (the test sees it) ...
            httpx2_logger = logging.getLogger("httpx2")
            service_level = httpx2_logger.level
            httpx2_logger.setLevel(logging.INFO)
            try:
                caplog.clear()
                assert (await http.get(HEALTH_PATH)).status_code == 200
                assert any(url in record.getMessage() for record in caplog.records)
            finally:
                httpx2_logger.setLevel(service_level)
            assert service_level == logging.WARNING

            # ... and the service, as it runs, writes nothing for a health check.
            caplog.clear()
            probes_before = len(paths)
            health = await http.get(HEALTH_PATH)
            assert (health.status_code, health.json()) == (200, {"status": "ok", "kwok": "ready"})
            assert len(paths) > probes_before, "the health check didn't probe the apiserver"
            assert caplog.records == []
