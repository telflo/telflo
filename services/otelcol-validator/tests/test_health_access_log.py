"""A probe's health request writes no access line (D33-1 decision 18):
probes call it every few seconds. The filter on `uvicorn.access` drops only
uvicorn's line for `GET` on the health path (its query aside); every other
request's line logs as before. The records here have the shape uvicorn
logs each request with: (client, method, path with query, HTTP version,
status)."""

from __future__ import annotations

import logging

import pytest

from app.main import HEALTH_PATH

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
        ("GET", "/validator/v1/validate/otelcol-contrib/0.162.0"),
        ("POST", HEALTH_PATH),
        ("GET", f"{HEALTH_PATH}/"),
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
