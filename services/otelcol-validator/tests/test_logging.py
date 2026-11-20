"""Nothing logged holds the text or what the collector printed: the
collector's messages echo configuration values.
Every log record of every logger is captured while the validator checks a
text whose collector echoes it back, fails unexpectedly, and refuses."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import runner
from app.main import create_app
from tests.conftest import SECRET, VALIDATE_URL, auth_headers, make_settings, write_collector

TEXT_MARKER = "text-marker-8a1f6c"
OUTPUT_MARKER = "output-marker-5d02e9"


def _logged(caplog: pytest.LogCaptureFixture) -> str:
    parts: list[str] = []
    for record in caplog.records:
        parts.append(record.getMessage())
        parts.append(repr(record.args))
        if record.exc_info:
            parts.append(logging.Formatter().formatException(record.exc_info))
        if record.exc_text:
            parts.append(record.exc_text)
    return "\n".join(parts)


@pytest.fixture
def capture_everything(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG)
    for name in ("app", "app.main", "app.runner", "uvicorn", "fastapi", "httpx2"):
        caplog.set_level(logging.DEBUG, logger=name)
    return caplog


def test_neither_the_text_nor_the_collectors_output_is_logged(
    binary_dir: Path, capture_everything: pytest.LogCaptureFixture
) -> None:
    write_collector(
        binary_dir,
        "0.162.0",
        f'sed "s/^/Error: /" "${{2#--config=}}" >&2\necho "exporters::otlp: {OUTPUT_MARKER}" >&2\nexit 1\n',
    )
    text = (
        f"# {TEXT_MARKER}\n"
        "exporters:\n"
        "  otlp:\n"
        f'    endpoint: "{TEXT_MARKER}"\n'
        f'    headers: {{x: "${{file:/{TEXT_MARKER}}}"}}\n'
        f"  tail_sampling/{TEXT_MARKER}:\n"
    )
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": text}, headers=auth_headers())

    # The answer does carry them (the test isn't vacuous) ...
    assert resp.status_code == 200
    assert TEXT_MARKER in resp.text and OUTPUT_MARKER in resp.text
    # ... the logs never do, nor the secret.
    logged = _logged(capture_everything)
    assert capture_everything.records, "nothing was logged at all"
    assert "otelcol-contrib validate finished: outcome=failed" in logged
    assert TEXT_MARKER not in logged
    assert OUTPUT_MARKER not in logged
    assert SECRET not in logged


# The check's child with its collector run broken: it raises an error whose
# message quotes the text.
_BROKEN_CHILD = f"""
import sys
from app import check, runner

async def broken(*args, **kwargs):
    raise ValueError("something about {TEXT_MARKER}")

runner.run_collector = broken
sys.exit(check.main())
"""


def test_an_unexpected_failure_logs_its_type_only(
    binary_dir: Path, capture_everything: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The failure happens in the check's child: only its type crosses to
    the service and its log."""
    monkeypatch.setattr(runner, "CHECK_COMMAND", (*runner.CHECK_COMMAND[:3], "-c", _BROKEN_CHILD))
    write_collector(binary_dir, "0.162.0", "exit 0\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": f"a: {TEXT_MARKER}\n"}, headers=auth_headers())

    assert resp.status_code == 500
    logged = _logged(capture_everything)
    assert "validation failed unexpectedly: ValueError" in logged
    assert TEXT_MARKER not in logged
    assert TEXT_MARKER not in resp.text


def test_a_refused_or_timed_out_check_logs_no_text(
    binary_dir: Path, capture_everything: pytest.LogCaptureFixture
) -> None:
    write_collector(binary_dir, "0.162.0", "exec sleep 30\n")
    settings = make_settings(binary_dir, validate_timeout=1)
    with TestClient(create_app(settings)) as client:
        client.post(VALIDATE_URL, json={"yaml": f"a: {TEXT_MARKER}\n"}, headers=auth_headers())
        client.post(VALIDATE_URL, json=[TEXT_MARKER], headers=auth_headers())
        client.post(VALIDATE_URL, json={"yaml": TEXT_MARKER, TEXT_MARKER: 1}, headers=auth_headers())
        client.post(VALIDATE_URL, json={"yaml": "a: 1"}, headers=auth_headers(TEXT_MARKER * 3))

    logged = _logged(capture_everything)
    assert "outcome=timeout" in logged
    assert TEXT_MARKER not in logged


def test_startup_logs_counts_never_the_secret(binary_dir: Path, capture_everything: pytest.LogCaptureFixture) -> None:
    with TestClient(create_app(make_settings(binary_dir))):
        pass

    logged = _logged(capture_everything)
    assert "otelcol-validator ready" in logged
    assert SECRET not in logged
