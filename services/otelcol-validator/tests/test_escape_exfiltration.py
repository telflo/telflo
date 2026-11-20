"""The exfiltration defense and the requirements-only rerun, against the real
collectors (marked `binary`, deselected by default; run inside the image with
`pytest -m binary`).

- A canary file's contents never appear in any answer, for every YAML-escape
  form: the collector decodes the escape and would expand the hidden
  `${file:…}`, but the validator detects the reference on the decoded value and
  splices it out first.
- The re-dump drift cases (`1:30`, `on`, a date in a string field) answer
  exactly as the raw text does, because only the reference's own span changes
  (no whole-document re-dump).
- The masking case (file_storage's missing directory hiding a build-stage
  error) answers invalid with the build-stage error and the directory
  requirement.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.binary_support import OFFERED, check

pytestmark = pytest.mark.binary

CANARY = "CANARYLEAKMARKER0123456789"

# Each escape renders a literal `$` (or `{`) that a raw `${` scan misses but
# the collector's confmap decodes to a live `${file:…}`.
def _escapes(path: str) -> dict[str, str]:
    return {
        "x24": f"\\x24{{file:{path}}}",
        "u0024": f"\\u0024{{file:{path}}}",
        "U00000024": f"\\U00000024{{file:{path}}}",
        "x7b_brace": f"$\\x7bfile:{path}}}",
        "escaped_linebreak": f"$\\\n      {{file:{path}}}",
    }


def _config(compression_value: str) -> str:
    return (
        "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n"
        "exporters:\n  otlp_http:\n    endpoint: https://example.com\n"
        f"    compression: {compression_value}\n"
        "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp_http]\n"
    )


_run = check


@pytest.fixture
def canary_file(tmp_path: Path) -> str:
    path = tmp_path / "canary.txt"
    path.write_text(CANARY)
    return str(path)


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("form", list(_escapes("x")))
async def test_a_canary_file_never_leaks_through_any_escape(version: str, form: str, canary_file: str) -> None:
    escape = _escapes(canary_file)[form]
    result = await _run(version, _config(f'"{escape}"'))
    blob = repr(result.errors) + repr(result.requirements)
    assert CANARY not in blob, (form, blob)


@pytest.mark.parametrize("version", OFFERED)
@pytest.mark.parametrize("scalar", ["1:30", "on", "2001-12-14"])
async def test_a_drift_scalar_answers_as_the_raw_text_does(version: str, scalar: str, canary_file: str) -> None:
    """With a reference spliced elsewhere, a sibling scalar the YAML 1.1 loader
    would have re-typed on a re-dump (`1:30` → 90, `on` → true, a date → a
    quoted string) answers exactly as the untouched raw text does."""
    base = (
        "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n"
        "exporters:\n  otlp_http:\n    endpoint: https://example.com\n"
        "    headers:\n      z: __Z__\n"
        f"    timeout: {scalar}\n"
        "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp_http]\n"
    )
    raw = await _run(version, base.replace("__Z__", '"x"'))
    forced = await _run(version, base.replace("__Z__", f'"${{file:{canary_file}}}"'))
    assert [e["message"] for e in raw.errors] == [e["message"] for e in forced.errors]
    assert raw.valid == forced.valid
    assert CANARY not in repr(forced.errors) + repr(forced.requirements)


# file_storage's directory is one no stage of the image creates (the image
# pre-creates /var/lib/otelcol/file_storage), so the requirement fires in the
# image as on macOS.
MASKING_CONFIG = """\
receivers:
  otlp:
    protocols:
      grpc: {}
  filelog:
    include: [/tmp/otelcol-validator-x.log]
    start_at: middle
processors:
  resourcedetection:
    detectors: [no_such_detector]
exporters:
  debug: {}
extensions:
  file_storage:
    directory: /var/lib/otelcol/not-created-by-the-image
service:
  extensions: [file_storage]
  pipelines:
    logs:
      receivers: [otlp, filelog]
      processors: [resourcedetection]
      exporters: [debug]
"""


@pytest.mark.parametrize("version", OFFERED)
async def test_a_masked_build_error_surfaces_with_the_directory_requirement(version: str) -> None:
    """file_storage's missing directory stopped the collector before the build
    stage, hiding the no_such_detector error (valid: true). The rerun meets the
    directory, so the build error surfaces while the directory stays a
    requirement."""
    result = await _run(version, MASKING_CONFIG)

    assert result.valid is False
    assert any("invalid detector key: no_such_detector" in e["message"] for e in result.errors)
    assert [(r["category"], r["title"], r["componentPath"]) for r in result.requirements] == [
        (
            "directory",
            "Ensure /var/lib/otelcol/not-created-by-the-image exists at runtime",
            "extensions::file_storage",
        )
    ]


# A `GOOGLE_*` variable is an ordinary one (protected Go names are `GO` then
# capitals and digits): the collector gets its placeholder and the
# configuration answers valid, with the requirement.
GOOGLE_ENDPOINT_CONFIG = """\
receivers:
  otlp:
    protocols:
      grpc: {}
exporters:
  otlphttp:
    endpoint: ${env:GOOGLE_OTLP_ENDPOINT}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
"""


@pytest.mark.parametrize("version", OFFERED)
async def test_a_google_endpoint_variable_answers_valid_with_its_requirement(version: str) -> None:
    result = await _run(version, GOOGLE_ENDPOINT_CONFIG)

    assert result.errors == []
    assert result.valid is True
    assert "Set environment variable GOOGLE_OTLP_ENDPOINT" in [r["title"] for r in result.requirements]
