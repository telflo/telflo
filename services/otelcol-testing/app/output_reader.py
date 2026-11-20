"""Read the collector's captured output (the ``file/test_out`` exporter
target) into the shape the run answers, with a hard byte cap.

- **The answer's form** (``encode_output``): a single record unwrapped,
  several as ``{"records": [...]}``, serialised compact
  (``ensure_ascii=False``, no spaces; the default separators add 8%, and
  escaping non-ASCII makes it two to three times longer). Past the 10 MiB
  cap, trailing records are dropped until it fits, and R-006 is added.
- The file is opened without following a symlink and read only if it is a
  regular file, decoded leniently (bytes that aren't UTF-8 never raise).
- An unparseable line is skipped silently: output never reaches a log line.

Why the cap: a pipeline that
produces 10 GB of output (transform setting 1 MB attributes on every record,
fan-out connector misconfigured, etc.) would pull the whole file into memory
and OOM the testing container. Capping the read keeps the blast radius
bounded while still letting downstream rules evaluate against partial data —
the user just sees an R-006 advisory so they know the result is incomplete.
(The run's output watchdog also stops a collector whose file passes 16 MiB,
`app/run.py`.)
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from app.yaml_mutations import MutationAdvisory

# R-006: the most of a run's output an answer carries.
MAX_OUTPUT_BYTES = 10 * 1024 * 1024


def _read_capped(path: Path, max_bytes: int) -> tuple[bytes, int] | None:
    """At most ``max_bytes`` of ``path`` and its size on disk; None when it
    is missing, a symlink or not a regular file."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    with os.fdopen(descriptor, "rb") as file:
        details = os.fstat(file.fileno())
        if not stat.S_ISREG(details.st_mode):
            return None
        return file.read(max_bytes), details.st_size


def read_output(
    path: Path,
    max_bytes: int,
) -> tuple[dict, MutationAdvisory | None]:
    """Read ``path`` (the collector's output file) into the answer's dict
    shape, capped at ``max_bytes``.

    Returns ``(output_dict, advisory_or_None)``. The advisory is set iff the
    file's on-disk size exceeded ``max_bytes``.

    If the file doesn't exist (collector never wrote anything, e.g. filter
    dropped everything) or is empty, returns ``({}, None)``.
    """
    records, on_disk = _records(path, max_bytes)
    truncated = on_disk > max_bytes
    advisory = _truncation_advisory(on_disk, max_bytes) if truncated else None
    if not records:
        return {}, advisory
    if len(records) == 1:
        return records[0], advisory
    return {"records": records}, advisory


def _records(path: Path, max_bytes: int) -> tuple[list, int]:
    """The JSON lines in the first ``max_bytes`` of ``path`` (a truncated or
    unparseable line skipped), and the file's size on disk."""
    found = _read_capped(path, max_bytes)
    if found is None:
        return [], 0
    raw, on_disk = found
    # If the cap falls mid-multibyte-char, ``errors=replace`` keeps us from
    # crashing on the truncated suffix.
    text = raw.decode("utf-8", errors="replace").strip()
    records: list = []
    # When truncation lands mid-line, the last JSON object on disk may be
    # incomplete and won't parse; it is skipped, as any unparseable line.
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except (ValueError, RecursionError):
            continue
    return records, on_disk


def _compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")


@dataclass(frozen=True)
class EncodedOutput:
    """The output as the answer carries it (None when there were no
    records), its file's size on disk, whether anything was left out, and
    R-006 when something was."""

    data: bytes | None
    bytes_on_disk: int
    truncated: bool
    advisory: MutationAdvisory | None


_WRAPPER_BYTES = len(b'{"records":[]}')


def encode_output(path: Path, cap: int = MAX_OUTPUT_BYTES) -> EncodedOutput:
    """The collector's output in the answer's form: one record
    unwrapped, several as ``{"records":[…]}``, compact. At most ``cap``
    bytes of the file are read, and trailing records are dropped until the
    form fits in ``cap`` bytes; either way, R-006."""
    records, on_disk = _records(path, cap)
    encoded = [_compact(record) for record in records]
    if len(encoded) == 1:
        size = len(encoded[0])
    else:
        size = _WRAPPER_BYTES + sum(len(item) for item in encoded) + max(len(encoded) - 1, 0)
    form_size = size
    dropped = False
    while encoded and size > cap:
        last = encoded.pop()
        dropped = True
        if not encoded:
            size = 0
        elif len(encoded) == 1:
            size = len(encoded[0])
        else:
            size -= len(last) + 1
    truncated = on_disk > cap or dropped
    # What the pipeline produced: the file, or its form when that was the
    # larger (a file just under the cap whose form isn't).
    advisory = _truncation_advisory(max(on_disk, form_size), cap) if truncated else None
    if not encoded:
        return EncodedOutput(None, on_disk, truncated, advisory)
    if len(encoded) == 1:
        data = encoded[0]
    else:
        data = b'{"records":[' + b",".join(encoded) + b"]}"
    return EncodedOutput(data, on_disk, truncated, advisory)


def _truncation_advisory(on_disk_bytes: int, cap_bytes: int) -> MutationAdvisory:
    """User-facing advisory for R-006 (output exceeded the read cap).

    Its ID and wording are stable (the service's README lists the IDs).
    """
    return MutationAdvisory(
        id="R-006",
        severity="warn",
        message=(
            f"Your pipeline produced {_format_bytes(on_disk_bytes)} of output, "
            f"which exceeds the test runner's {_format_bytes(cap_bytes)} cap. "
            f"Validation rules evaluated against the first {_format_bytes(cap_bytes)} "
            f"only — results may not reflect the full pipeline output. Consider "
            f"adding a filter to your pipeline, or reducing fixture size."
        ),
        details={
            "on_disk_bytes": on_disk_bytes,
            "cap_bytes": cap_bytes,
        },
    )


def _format_bytes(n: int) -> str:
    """Compact, human-readable byte size. We render the advisory message to
    the user so MB / GB beats raw byte counts."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.1f} GB"
