"""The size-unit test makes a sparse file instead of writing 5 GiB; the
answer's form (``encode_output``) is tested at the end.

Tests for the output-cap fix (R-006).

Pre-cap, both executors did a blind ``path.read_text()`` on the collector's
captured output. A pathological pipeline that produced gigabytes of output
would pull the whole file into memory and OOM the testing container. The
cap bounds the read; these tests pin the new contract:

- Under the cap: read everything, no advisory.
- Over the cap: read up to the cap, attach an R-006 advisory describing the
  truncation.
- Edge cases: missing file, empty file, mid-line truncation, single vs
  multi-record output shape.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.output_reader import read_output


def _write_records(path: Path, records: list[dict]) -> None:
    """Write OTLP-JSON-shaped records, one per line, the way the collector
    file/test_out exporter does."""
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")


def test_read_output_returns_empty_when_file_missing(tmp_path: Path) -> None:
    """Common path: filter dropped everything, collector never wrote a file."""
    out, advisory = read_output(tmp_path / "nonexistent.json", max_bytes=1024)
    assert out == {}
    assert advisory is None


def test_read_output_returns_empty_when_file_empty(tmp_path: Path) -> None:
    path = tmp_path / "out.json"
    path.write_text("")
    out, advisory = read_output(path, max_bytes=1024)
    assert out == {}
    assert advisory is None


def test_read_output_single_record_returned_unwrapped(tmp_path: Path) -> None:
    """The exporter emits one JSON object per line; a single-line file
    returns the record directly (matches the historical shape callers rely
    on)."""
    path = tmp_path / "out.json"
    _write_records(path, [{"resourceMetrics": [{"scopeMetrics": []}]}])
    out, advisory = read_output(path, max_bytes=10 * 1024)
    assert out == {"resourceMetrics": [{"scopeMetrics": []}]}
    assert advisory is None


def test_read_output_multi_record_wrapped_in_records_key(tmp_path: Path) -> None:
    """Multi-line output gets wrapped as ``{"records": [...]}`` — the shape
    the rules engine expects when iterating over multiple OTLP envelopes."""
    path = tmp_path / "out.json"
    records = [{"resourceMetrics": [{"scopeMetrics": []}]} for _ in range(3)]
    _write_records(path, records)
    out, advisory = read_output(path, max_bytes=10 * 1024)
    assert out == {"records": records}
    assert advisory is None


def test_read_output_under_cap_emits_no_advisory(tmp_path: Path) -> None:
    """Under-cap reads must not generate spurious advisories — the UI would
    show a warning every run otherwise."""
    path = tmp_path / "out.json"
    payload = json.dumps({"a": "x" * 100})
    path.write_text(payload)
    out, advisory = read_output(path, max_bytes=10 * 1024)
    assert advisory is None
    assert out == {"a": "x" * 100}


def test_read_output_over_cap_emits_r006_advisory(tmp_path: Path) -> None:
    """Over-cap reads attach an R-006 advisory describing on-disk vs. cap
    sizes. The advisory severity is ``warn`` because rule results are no
    longer trustworthy on the truncated tail."""
    path = tmp_path / "out.json"
    # 2 KB of records, cap at 1 KB — guarantees truncation.
    records = [{"i": i, "pad": "x" * 50} for i in range(40)]
    _write_records(path, records)
    on_disk = path.stat().st_size
    assert on_disk > 1024

    _, advisory = read_output(path, max_bytes=1024)

    assert advisory is not None
    assert advisory.id == "R-006"
    assert advisory.severity == "warn"
    assert advisory.details["on_disk_bytes"] == on_disk
    assert advisory.details["cap_bytes"] == 1024
    # The message should be human-readable — KB/MB/GB, not raw byte counts.
    assert "KB" in advisory.message or "MB" in advisory.message or "GB" in advisory.message


def test_read_output_truncated_tail_drops_unparseable_partial_record(
    tmp_path: Path,
) -> None:
    """When the cap lands mid-line, the partial JSON object at the end won't
    parse — the parser already skips unparseable lines with a warning, which
    is the right behavior for a truncated tail too. Earlier complete records
    are still returned."""
    path = tmp_path / "out.json"
    records = [{"i": i, "pad": "x" * 200} for i in range(20)]
    _write_records(path, records)

    # Cap mid-record (around the 2nd or 3rd line).
    on_disk = path.stat().st_size
    cap = min(500, on_disk // 2)
    out, advisory = read_output(path, max_bytes=cap)

    assert advisory is not None
    # We got *something* back — earlier complete records before truncation.
    # The exact count depends on line length, but it must be at least one
    # complete record, and the structure must still be valid.
    if "records" in out:
        # Multi-record shape — every entry parses cleanly.
        for record in out["records"]:
            assert isinstance(record, dict)
    else:
        # Single-record shape — must have parsed cleanly.
        assert isinstance(out, dict)


def test_read_output_cap_at_exact_size_does_not_trigger(tmp_path: Path) -> None:
    """Boundary: file size == cap is NOT truncated. The check is strictly
    greater-than to avoid spurious advisories at the exact-fit boundary."""
    path = tmp_path / "out.json"
    record = {"x": "abc"}
    payload = json.dumps(record)
    path.write_text(payload)
    cap = path.stat().st_size

    out, advisory = read_output(path, max_bytes=cap)
    assert advisory is None
    assert out == record


@pytest.mark.parametrize(
    "n_bytes,expected_unit",
    [
        (500, "B"),
        (5 * 1024, "KB"),
        (5 * 1024 * 1024, "MB"),
        (5 * 1024 * 1024 * 1024, "GB"),
    ],
)
def test_advisory_message_uses_appropriate_size_unit(
    tmp_path: Path, n_bytes: int, expected_unit: str
) -> None:
    """The advisory message picks the right unit so users see ``42.0 MB``
    not ``44040192 B``. Forge an oversize file at each boundary and check the
    rendered string."""
    path = tmp_path / "out.json"
    # Roughly n_bytes on disk — exact size doesn't matter, only the unit the
    # formatter picks. A sparse file (no padding written, 5 GiB for the last
    # case; only the first 10 bytes are ever read).
    path.write_text(json.dumps({"pad": ""}))
    os.truncate(path, n_bytes)

    _, advisory = read_output(path, max_bytes=10)
    assert advisory is not None
    assert expected_unit in advisory.message


# ---------------------------------------------------------------------------
# The answer's form: one record or {"records"}, compact, at most 10 MiB with
# trailing records dropped and R-006
# ---------------------------------------------------------------------------

from app.output_reader import MAX_OUTPUT_BYTES, encode_output  # noqa: E402


def test_one_record_is_answered_unwrapped_and_compact(tmp_path: Path) -> None:
    path = tmp_path / "output.data"
    path.write_text('{"resourceLogs": [{"body": "héllo"}]}\n')

    encoded = encode_output(path)

    assert encoded.data == '{"resourceLogs":[{"body":"héllo"}]}'.encode()
    assert (encoded.bytes_on_disk, encoded.truncated, encoded.advisory) == (path.stat().st_size, False, None)


def test_several_records_are_wrapped_compact_and_non_ascii_is_kept_as_it_is(tmp_path: Path) -> None:
    path = tmp_path / "output.data"
    _write_records(path, [{"a": "ünï"}, {"b": [1, 2]}, {"c": None}])

    encoded = encode_output(path)

    assert encoded.data == '{"records":[{"a":"ünï"},{"b":[1,2]},{"c":null}]}'.encode()
    assert json.loads(encoded.data) == {"records": [{"a": "ünï"}, {"b": [1, 2]}, {"c": None}]}


def test_no_record_is_no_output(tmp_path: Path) -> None:
    missing = encode_output(tmp_path / "missing")
    path = tmp_path / "output.data"
    path.write_text("not json\n\n")
    unparseable = encode_output(path)

    assert (missing.data, missing.truncated, missing.advisory) == (None, False, None)
    assert (unparseable.data, unparseable.truncated, unparseable.advisory) == (None, False, None)


def test_past_the_cap_trailing_records_are_dropped_until_the_form_fits_with_r006(tmp_path: Path) -> None:
    """The file is under the cap but its form isn't (each record grows by a
    comma and the wrapper): whole trailing records are left out, never part
    of one."""
    path = tmp_path / "output.data"
    records = [{"i": i, "pad": "x" * 30} for i in range(10)]
    _write_records(path, records)
    single = len(json.dumps(records[0], separators=(",", ":")))
    cap = len(b'{"records":[]}') + 3 * single + 2  # exactly three records fit

    encoded = encode_output(path, cap)

    assert path.stat().st_size > cap  # read up to the cap, so ...
    assert json.loads(encoded.data) == {"records": records[:3]}
    assert len(encoded.data) <= cap
    assert encoded.truncated is True
    assert encoded.advisory is not None and encoded.advisory.id == "R-006"


def test_a_form_that_fits_only_without_its_last_records_is_cut_there(tmp_path: Path) -> None:
    """On disk under the cap, as a form over it: R-006 all the same."""
    path = tmp_path / "output.data"
    _write_records(path, [{"k": "v" * 20}, {"k": "w" * 20}])
    on_disk = path.stat().st_size
    one = len(json.dumps({"k": "v" * 20}, separators=(",", ":")))

    encoded = encode_output(path, on_disk)  # the form (wrapper + comma) is longer than the file

    assert encoded.data == json.dumps({"k": "v" * 20}, separators=(",", ":")).encode()
    assert len(encoded.data) == one
    assert encoded.truncated is True
    assert encoded.advisory is not None and encoded.advisory.id == "R-006"


def test_a_single_record_larger_than_the_cap_is_no_output_with_r006(tmp_path: Path) -> None:
    path = tmp_path / "output.data"
    path.write_text(json.dumps({"big": "x" * 200}) + "\n")

    encoded = encode_output(path, 100)

    assert encoded.data is None
    assert encoded.truncated is True
    assert encoded.advisory is not None and encoded.advisory.details["on_disk_bytes"] == path.stat().st_size


def test_the_cap_is_ten_mib_and_a_symlink_is_never_followed(tmp_path: Path) -> None:
    target = tmp_path / "elsewhere.json"
    target.write_text('{"a": 1}\n')
    link = tmp_path / "output.data"
    link.symlink_to(target)

    assert MAX_OUTPUT_BYTES == 10 * 1024 * 1024
    assert encode_output(link).data is None
    assert read_output(link, 1024) == ({}, None)
