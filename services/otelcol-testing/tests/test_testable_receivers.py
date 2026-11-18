"""Detection and synthesis of the testable receivers. A regex with an
escape Python doesn't know is written with its backslash doubled (the
warning would fail this suite)."""

from __future__ import annotations

import pytest

from app.testable_receivers import (
    FixtureFormat,
    InputMode,
    detect_testable_receiver,
    synthesize_filelog,
    synthesize_syslog,
)


def test_detect_filelog() -> None:
    doc = {"receivers": {"filelog": {"include": ["/var/log/app.log"]}}}
    tr = detect_testable_receiver(doc)
    assert tr is not None
    assert tr.kind == "filelog"
    assert tr.input_mode == InputMode.PULL
    assert tr.fixture_format == FixtureFormat.RAW_LINES


def test_detect_syslog_suffixed_name() -> None:
    doc = {"receivers": {"syslog/in": {"tcp": {"listen_address": "0.0.0.0:514"}}}}
    tr = detect_testable_receiver(doc)
    assert tr is not None
    assert tr.kind == "syslog"
    assert tr.input_mode == InputMode.PUSH
    assert tr.fixture_format == FixtureFormat.SYSLOG_FRAMES


def test_detect_none_for_plain_pipeline() -> None:
    assert detect_testable_receiver({"receivers": {"otlp": {}}}) is None


def test_synthesize_filelog_discards_user_transport() -> None:
    user_cfg = {
        "include": ["/etc/**", "/proc/self/environ"],
        "exclude": ["nothing"],
        "storage": "file_storage",
        "poll_interval": "1s",
        "start_at": "end",
        "multiline": {"line_start_pattern": "^\\d{4}"},
        "operators": [{"type": "regex_parser", "regex": "(?P<a>.*)"}],
    }
    synth = synthesize_filelog(user_cfg, fixture_path="/run/ws/input.log")
    assert synth["include"] == ["/run/ws/input.log"]
    assert synth["start_at"] == "beginning"
    assert "storage" not in synth
    assert "exclude" not in synth
    assert "poll_interval" not in synth
    assert synth["multiline"] == {"line_start_pattern": "^\\d{4}"}
    assert synth["operators"] == user_cfg["operators"]


def test_synthesize_filelog_omits_multiline_when_absent() -> None:
    synth = synthesize_filelog({"operators": []}, fixture_path="/run/ws/input.log")
    assert "multiline" not in synth
    assert synth["operators"] == []


def test_synthesize_syslog_discards_user_transport() -> None:
    user_cfg = {
        "tcp": {"listen_address": "0.0.0.0:601", "tls": {"cert_file": "/x"}},
        "udp": {"listen_address": "0.0.0.0:514"},
        "protocol": "rfc5424",
        "enable_octet_counting": True,
        "location": "UTC",
        "operators": [{"type": "move", "from": "a", "to": "b"}],
    }
    synth = synthesize_syslog(user_cfg, listen_port=34567)
    assert synth["tcp"] == {"listen_address": "127.0.0.1:34567"}
    assert "udp" not in synth
    assert "tls" not in synth["tcp"]
    assert synth["protocol"] == "rfc5424"
    assert synth["enable_octet_counting"] is True
    assert synth["location"] == "UTC"
    assert synth["operators"] == user_cfg["operators"]


def test_synthesize_syslog_defaults_protocol_when_absent() -> None:
    synth = synthesize_syslog({"operators": []}, listen_port=40000)
    assert synth["protocol"] == "rfc5424"


# --- regression: pure parsing/labeling knobs (resource, attributes,
# encoding, include_file_*, etc.) must be carried over from the user.
def test_synthesize_filelog_carries_over_parsing_and_labeling_knobs() -> None:
    user_cfg = {
        "include": ["/etc/passwd"],  # transport — MUST be discarded
        "storage": "file_storage",   # state — MUST be discarded
        "exclude": ["nope"],         # transport — MUST be discarded
        "poll_interval": "1s",       # transport timing — MUST be discarded
        "ordering_criteria": {"regex": "x"},  # file-source — MUST be discarded
        # Labeling/parsing knobs the user expects to test — MUST be kept.
        "resource": {"browser": "chrome", "service.name": "my-app"},
        "attributes": {"env": "prod"},
        "encoding": "utf-8",
        "include_file_name": True,
        "include_file_path": False,
        "include_file_record_number": True,
        "max_log_size": "1MiB",
        "force_flush_period": "500ms",
        "preserve_leading_whitespaces": True,
        "multiline": {"line_start_pattern": "^\\d{4}"},
        "operators": [{"type": "add", "field": "attributes.x", "value": "y"}],
    }
    synth = synthesize_filelog(user_cfg, fixture_path="/run/ws/input.log")
    # transport discarded
    assert synth["include"] == ["/run/ws/input.log"]
    assert "storage" not in synth
    assert "exclude" not in synth
    assert "poll_interval" not in synth
    assert "ordering_criteria" not in synth
    # labeling/parsing knobs preserved verbatim
    assert synth["resource"] == {"browser": "chrome", "service.name": "my-app"}
    assert synth["attributes"] == {"env": "prod"}
    assert synth["encoding"] == "utf-8"
    assert synth["include_file_name"] is True
    assert synth["include_file_path"] is False
    assert synth["include_file_record_number"] is True
    assert synth["max_log_size"] == "1MiB"
    assert synth["force_flush_period"] == "500ms"
    assert synth["preserve_leading_whitespaces"] is True
    assert synth["multiline"] == {"line_start_pattern": "^\\d{4}"}


def test_synthesize_filelog_drops_unknown_keys_fail_closed() -> None:
    """Future filelog knobs the allowlist doesn't know about are dropped.
    Better to drop a benign knob and have the user notice than to leak a
    future path-bearing knob into the executed config."""
    synth = synthesize_filelog(
        {"operators": [], "totally_new_knob": "/etc/shadow"},
        fixture_path="/run/ws/input.log",
    )
    assert "totally_new_knob" not in synth


def test_synthesize_syslog_carries_over_resource_and_attributes() -> None:
    user_cfg = {
        "tcp": {"listen_address": "0.0.0.0:514"},
        "udp": {"listen_address": "0.0.0.0:514"},   # MUST drop
        "protocol": "rfc5424",
        "resource": {"service.name": "edge"},
        "attributes": {"region": "us-east"},
        "location": "UTC",
        "enable_octet_counting": True,
        "operators": [],
    }
    synth = synthesize_syslog(user_cfg, listen_port=40123)
    assert synth["tcp"] == {"listen_address": "127.0.0.1:40123"}
    assert "udp" not in synth
    assert synth["resource"] == {"service.name": "edge"}
    assert synth["attributes"] == {"region": "us-east"}
    assert synth["location"] == "UTC"
    assert synth["enable_octet_counting"] is True
