"""Fixture-shape detection and its F-001 to F-003 advisories."""

from __future__ import annotations

import json

import pytest

from app.fixture_shape import (
    FILELOG_KIND,
    OTLP_KIND,
    SNIFF_BYTES,
    SYSLOG_KIND,
    FixtureShape,
    detect_fixture_shape,
    fixture_strategy_mismatch_advisory,
)


def _big_envelope_head(*, indent: int | None) -> bytes:
    """A valid OTLP envelope padded past the sniff cap, then sliced to the
    head the executor would actually pass — i.e. a *truncated* prefix that
    json.loads can no longer parse. ``indent=None`` gives the minified
    (single-line) form; an int gives pretty-printed (multi-line)."""
    payload = json.dumps(
        {
            "resourceLogs": [
                {"resource": {}, "scopeLogs": [
                    {"logRecords": [{"body": {"stringValue": "x" * 200_000}}]}
                ]}
            ]
        },
        indent=indent,
    ).encode()
    assert len(payload) > SNIFF_BYTES
    return payload[:SNIFF_BYTES]


# ---------------------------------------------------------------------------
# detect_fixture_shape
# ---------------------------------------------------------------------------


def test_empty_bytes_classify_as_empty() -> None:
    assert detect_fixture_shape(b"") is FixtureShape.EMPTY


def test_whitespace_only_classifies_as_empty() -> None:
    assert detect_fixture_shape(b"   \n\t\r\n  ") is FixtureShape.EMPTY


def test_otlp_envelope_logs() -> None:
    payload = json.dumps(
        {"resourceLogs": [{"resource": {}, "scopeLogs": []}]}
    ).encode()
    assert detect_fixture_shape(payload) is FixtureShape.OTLP_ENVELOPE


def test_otlp_envelope_metrics_and_traces() -> None:
    metrics = json.dumps({"resourceMetrics": []}).encode()
    traces = json.dumps({"resourceSpans": []}).encode()
    assert detect_fixture_shape(metrics) is FixtureShape.OTLP_ENVELOPE
    assert detect_fixture_shape(traces) is FixtureShape.OTLP_ENVELOPE


def test_otlp_envelope_with_utf8_bom() -> None:
    payload = b"\xef\xbb\xbf" + json.dumps({"resourceLogs": []}).encode()
    assert detect_fixture_shape(payload) is FixtureShape.OTLP_ENVELOPE


def test_otlp_envelope_pretty_printed_across_lines() -> None:
    payload = (
        b"{\n"
        b'  "resourceLogs": [\n'
        b"    { \"resource\": {}, \"scopeLogs\": [] }\n"
        b"  ]\n"
        b"}\n"
    )
    assert detect_fixture_shape(payload) is FixtureShape.OTLP_ENVELOPE


def test_otlp_array_of_envelopes() -> None:
    payload = json.dumps(
        [{"resourceLogs": []}, {"resourceLogs": []}]
    ).encode()
    assert detect_fixture_shape(payload) is FixtureShape.OTLP_ARRAY


def test_array_of_non_otlp_dicts_is_single_json_not_otlp_array() -> None:
    # An array whose elements lack resourceLogs/Metrics/Spans must NOT
    # classify as OTLP_ARRAY — otherwise the otlp strategy would silently
    # accept it as a valid shape and surprise the user when the receiver
    # rejects every element at runtime.
    payload = json.dumps([{"foo": 1}, {"bar": 2}]).encode()
    assert detect_fixture_shape(payload) is FixtureShape.SINGLE_JSON


def test_single_non_otlp_json_object() -> None:
    payload = json.dumps({"msg": "hello", "level": "info"}).encode()
    assert detect_fixture_shape(payload) is FixtureShape.SINGLE_JSON


def test_ndjson_when_all_lines_parse() -> None:
    payload = (
        b'{"msg":"a","level":"info"}\n'
        b'{"msg":"b","level":"warn"}\n'
        b'{"msg":"c","level":"error"}\n'
    )
    assert detect_fixture_shape(payload) is FixtureShape.NDJSON


def test_raw_lines_when_lines_are_plain_text() -> None:
    payload = (
        b"2026-05-26 10:14:03 INFO order placed\n"
        b"2026-05-26 10:14:05 WARN payment declined\n"
        b"2026-05-26 10:14:08 ERROR chargeback initiated\n"
    )
    assert detect_fixture_shape(payload) is FixtureShape.RAW_LINES


def test_mixed_json_and_text_lines_is_raw_lines_not_ndjson() -> None:
    # Strict NDJSON detection: a single non-JSON line in the sample is
    # enough to demote the file out of NDJSON. The filelog operator chain
    # the user authored has to handle every line the same way, so calling
    # this NDJSON would imply json_parser-on-everything works when it
    # would actually crash on the text line.
    payload = (
        b'{"msg":"json"}\n'
        b"plain text line\n"
        b'{"msg":"more json"}\n'
    )
    assert detect_fixture_shape(payload) is FixtureShape.RAW_LINES


def test_single_text_line_no_newline() -> None:
    assert detect_fixture_shape(b"just one line of text") is FixtureShape.SINGLE_LINE


def test_single_text_line_with_trailing_newline() -> None:
    assert (
        detect_fixture_shape(b"just one line of text\n") is FixtureShape.SINGLE_LINE
    )


# --- Truncated fixtures: a large OTLP envelope outgrows the 64 KB sniff
# window and must NOT degrade to RAW_LINES/SINGLE_LINE (which would fire a
# bogus F-001 against an OTLP pipeline). See _classify_truncated_json.


def test_truncated_minified_otlp_envelope_is_envelope_not_single_line() -> None:
    assert (
        detect_fixture_shape(_big_envelope_head(indent=None))
        is FixtureShape.OTLP_ENVELOPE
    )


def test_truncated_pretty_otlp_envelope_is_envelope_not_raw_lines() -> None:
    assert (
        detect_fixture_shape(_big_envelope_head(indent=2))
        is FixtureShape.OTLP_ENVELOPE
    )


def test_truncated_otlp_array_is_array_not_raw_lines() -> None:
    payload = json.dumps(
        [{"resourceLogs": [{"body": {"stringValue": "x" * 200_000}}]}]
    ).encode()
    assert len(payload) > SNIFF_BYTES
    assert detect_fixture_shape(payload[:SNIFF_BYTES]) is FixtureShape.OTLP_ARRAY


def test_truncated_ndjson_still_classifies_as_ndjson() -> None:
    # NDJSON is checked before the truncated-JSON guard, so a >64 KB NDJSON
    # file (which also opens with '{') keeps its NDJSON shape — the F-001
    # ndjson→otlp warning must still be reachable for large files.
    line = (json.dumps({"msg": "x" * 80}) + "\n").encode()
    payload = line * 2000
    assert len(payload) > SNIFF_BYTES
    assert detect_fixture_shape(payload[:SNIFF_BYTES]) is FixtureShape.NDJSON


def test_truncated_non_otlp_json_blob_is_single_json_not_raw_lines() -> None:
    # A large non-OTLP JSON object: we shouldn't warn (no envelope keys), but
    # we also shouldn't mislabel it RAW_LINES and fire F-001.
    payload = json.dumps({"data": "y" * 200_000}).encode()
    assert len(payload) > SNIFF_BYTES
    assert detect_fixture_shape(payload[:SNIFF_BYTES]) is FixtureShape.SINGLE_JSON


def test_truncated_raw_text_is_still_raw_lines() -> None:
    # Plain text that merely happens to be huge must stay RAW_LINES — the
    # guard only reclassifies buffers that open with '{' or '['.
    payload = b"2026-05-26 10:14:03 INFO order placed\n" * 5000
    assert len(payload) > SNIFF_BYTES
    assert detect_fixture_shape(payload[:SNIFF_BYTES]) is FixtureShape.RAW_LINES


def test_large_envelope_that_fits_in_window_parses_directly() -> None:
    # Sanity: when the whole envelope fits under the cap, the fast path parses
    # it — the truncation guard only exists for the overflow case.
    payload = json.dumps({"resourceLogs": [{"body": "x" * 1000}]}).encode()
    assert len(payload) < SNIFF_BYTES
    assert detect_fixture_shape(payload) is FixtureShape.OTLP_ENVELOPE


# ---------------------------------------------------------------------------
# fixture_strategy_mismatch_advisory — the full shape × strategy matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "shape",
    [
        FixtureShape.OTLP_ENVELOPE,
        FixtureShape.OTLP_ARRAY,
    ],
)
def test_otlp_strategy_no_advisory_for_otlp_shaped_fixture(shape) -> None:
    assert fixture_strategy_mismatch_advisory(shape, OTLP_KIND) is None


@pytest.mark.parametrize(
    "shape",
    [
        FixtureShape.RAW_LINES,
        FixtureShape.SINGLE_LINE,
    ],
)
def test_otlp_strategy_warns_on_text_fixture(shape) -> None:
    advisory = fixture_strategy_mismatch_advisory(shape, OTLP_KIND)
    assert advisory is not None
    assert advisory.id == "F-001"
    assert advisory.severity == "warn"
    assert advisory.details["fixture_shape"] == shape.value
    assert advisory.details["strategy"] == OTLP_KIND


def test_otlp_strategy_warns_on_ndjson_fixture() -> None:
    advisory = fixture_strategy_mismatch_advisory(FixtureShape.NDJSON, OTLP_KIND)
    assert advisory is not None
    assert advisory.id == "F-001"
    assert "NDJSON" in advisory.message
    assert "filelog" in advisory.message  # nudge toward the right pipeline


@pytest.mark.parametrize("strategy_kind", [FILELOG_KIND, SYSLOG_KIND])
def test_filelog_syslog_warn_on_otlp_envelope_fixture(strategy_kind) -> None:
    advisory = fixture_strategy_mismatch_advisory(
        FixtureShape.OTLP_ENVELOPE, strategy_kind
    )
    assert advisory is not None
    assert advisory.id == "F-002"
    assert advisory.severity == "warn"
    assert strategy_kind in advisory.message
    # Critical hint — without this users don't know why they got 1 record.
    assert "line" in advisory.message.lower()


@pytest.mark.parametrize("strategy_kind", [FILELOG_KIND, SYSLOG_KIND])
def test_filelog_syslog_warn_on_otlp_array_fixture(strategy_kind) -> None:
    advisory = fixture_strategy_mismatch_advisory(
        FixtureShape.OTLP_ARRAY, strategy_kind
    )
    assert advisory is not None
    assert advisory.id == "F-002"
    assert "array" in advisory.message.lower()


@pytest.mark.parametrize(
    "shape",
    [
        FixtureShape.RAW_LINES,
        FixtureShape.NDJSON,
        FixtureShape.SINGLE_LINE,
        FixtureShape.SINGLE_JSON,
    ],
)
@pytest.mark.parametrize("strategy_kind", [FILELOG_KIND, SYSLOG_KIND])
def test_filelog_syslog_no_advisory_for_line_shaped_fixtures(
    shape, strategy_kind
) -> None:
    # filelog/syslog accept lines (raw or NDJSON) and a single-line/single-
    # JSON file — those are exactly what these strategies are designed for,
    # so no warning.
    assert fixture_strategy_mismatch_advisory(shape, strategy_kind) is None


@pytest.mark.parametrize(
    "strategy_kind", [OTLP_KIND, FILELOG_KIND, SYSLOG_KIND]
)
def test_empty_fixture_emits_no_advisory(strategy_kind) -> None:
    # Empty fixtures are independently a problem (the run will produce
    # nothing useful), but the empty-output path of the test runner is
    # the right surface for that — adding a shape advisory on top would
    # be noise.
    assert (
        fixture_strategy_mismatch_advisory(FixtureShape.EMPTY, strategy_kind)
        is None
    )


def test_unknown_strategy_kind_is_silent() -> None:
    # Defensive: if a future strategy is added without updating the
    # advisory mapping, we don't want a fixture-mismatch warning to
    # spuriously fire (or crash) — return None and let the new strategy's
    # PR add its own clauses.
    assert (
        fixture_strategy_mismatch_advisory(
            FixtureShape.OTLP_ENVELOPE, "newkind"
        )
        is None
    )
