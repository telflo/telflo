"""Datadog exporter hostname placeholder injection.

Background: ``otelcol-contrib validate`` builds the full component graph, so
every exporter's constructor runs. The datadog exporter's constructor performs
cloud hostname detection (AWS IMDS / Azure / GCP metadata probes) and, with a
logs pipeline, a connectivity check against the Datadog intake. The validator
pod's NetworkPolicy silently DROPs all egress except DNS, so those probes hang
for ~25s and every datadog-exporter config trips the 10s validate timeout.

Setting ``hostname`` on the exporter short-circuits detection entirely. The
validator injects a placeholder hostname into datadog exporters that don't set
one — a "substitute, don't strip" rewrite in the same spirit as the env-var
placeholders, scoped to the one key that changes nothing about what the config
means structurally.
"""

from pathlib import Path

import yaml

from app import runner
from app.placeholders import _DATADOG_HOSTNAME_PLACEHOLDER, _inject_datadog_hostname_placeholder

# A Datadog bridge flow (a Datadog receiver and exporter beside an
# OTLP/HTTP exporter), trimmed to the
# parts that matter. Quoting mirrors what the frontend's YAML generator emits.
BRIDGE = """\
receivers:
  datadog:
    endpoint: '0.0.0.0:8126'
    read_timeout: '60s'
  otlp:
    protocols:
      grpc:
        endpoint: '0.0.0.0:4317'
exporters:
  datadog:
    api:
      key: '${env:DD_API_KEY}'
      site: '${env:DD_SITE}'
    retry_on_failure:
      enabled: true
  otlp_http:
    endpoint: '${env:CLICKSTACK_OTLP_ENDPOINT}'
service:
  pipelines:
    traces:
      receivers: [datadog, otlp]
      exporters: [datadog, otlp_http]
"""


def test_injects_hostname_into_datadog_exporter_lacking_one() -> None:
    out = _inject_datadog_hostname_placeholder(BRIDGE)

    parsed = yaml.safe_load(out)
    assert parsed["exporters"]["datadog"]["hostname"] == _DATADOG_HOSTNAME_PLACEHOLDER


def test_rewrite_changes_nothing_but_the_hostname() -> None:
    """The rewrite is textual (no re-serialization), so everything the user
    wrote must survive: quoting, env references, key order, the receiver
    block that shares the ``datadog`` name."""
    out = _inject_datadog_hostname_placeholder(BRIDGE)

    before = yaml.safe_load(BRIDGE)
    after = yaml.safe_load(out)
    del after["exporters"]["datadog"]["hostname"]
    assert after == before
    # Every original line is still present, in order, untouched.
    original_lines = BRIDGE.splitlines()
    rewritten_lines = out.splitlines()
    assert [ln for ln in rewritten_lines if ln in original_lines] == original_lines


def test_keeps_a_hostname_the_user_set() -> None:
    text = BRIDGE.replace(
        "  datadog:\n    api:",
        "  datadog:\n    hostname: prod-gateway-1\n    api:",
    )

    assert _inject_datadog_hostname_placeholder(text) == text


def test_injects_into_each_named_datadog_instance_that_needs_it() -> None:
    text = """\
exporters:
  datadog/us:
    api:
      key: '${env:DD_API_KEY_US}'
  datadog/eu:
    hostname: eu-gateway
    api:
      key: '${env:DD_API_KEY_EU}'
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [datadog/us, datadog/eu]
"""
    out = _inject_datadog_hostname_placeholder(text)

    parsed = yaml.safe_load(out)
    assert parsed["exporters"]["datadog/us"]["hostname"] == _DATADOG_HOSTNAME_PLACEHOLDER
    assert parsed["exporters"]["datadog/eu"]["hostname"] == "eu-gateway"


def test_leaves_the_datadog_receiver_alone() -> None:
    out = _inject_datadog_hostname_placeholder(BRIDGE)

    parsed = yaml.safe_load(out)
    assert "hostname" not in parsed["receivers"]["datadog"]


def test_config_without_datadog_exporter_is_byte_identical() -> None:
    text = """\
receivers:
  datadog:
    endpoint: 0.0.0.0:8126
exporters:
  otlp_http:
    endpoint: '${env:OTLP_ENDPOINT}'
service:
  pipelines:
    traces:
      receivers: [datadog]
      exporters: [otlp_http]
"""

    assert _inject_datadog_hostname_placeholder(text) == text


def test_invalid_yaml_is_returned_unchanged() -> None:
    text = "exporters:\n  datadog:\n    api: [unclosed\n"

    assert _inject_datadog_hostname_placeholder(text) == text


def test_flow_style_datadog_block_is_left_for_the_binary() -> None:
    """A one-line ``datadog: {…}`` mapping has no block to insert into. Leave
    it alone rather than risk a corrupt rewrite; the binary still validates
    it (slowly, in the sandbox) instead of the validator inventing errors."""
    text = "exporters:\n  datadog: {api: {key: '${env:DD_API_KEY}'}}\n"

    assert _inject_datadog_hostname_placeholder(text) == text


def test_preserves_crlf_line_endings() -> None:
    text = BRIDGE.replace("\n", "\r\n")

    out = _inject_datadog_hostname_placeholder(text)

    assert "\r\n" in out
    assert "\n" not in out.replace("\r\n", "")
    assert yaml.safe_load(out)["exporters"]["datadog"]["hostname"] == _DATADOG_HOSTNAME_PLACEHOLDER


async def test_validate_contrib_hands_the_injected_yaml_to_the_binary(monkeypatch) -> None:
    """Through the check's orchestration (`check_text`, what the check's
    child runs, here in-process so the collector can be stubbed): what
    reaches the collector subprocess carries the placeholder hostname."""
    captured: dict[str, str] = {}

    async def _fake_run_collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):
        captured["yaml"] = yaml_content
        return runner.RunOutcome(kind="passed", returncode=0)

    monkeypatch.setattr(runner, "run_collector", _fake_run_collector)

    result = await runner.check_text(Path("/fake/otelcol-contrib"), BRIDGE, timeout_seconds=10)

    assert result.valid is True
    assert yaml.safe_load(captured["yaml"])["exporters"]["datadog"]["hostname"] == _DATADOG_HOSTNAME_PLACEHOLDER
