"""Fixture-vs-strategy shape mismatch detection.

Its detection, IDs and messages are held to the parity corpus (the web runs
the same check). The filelog receiver is named `file_log`, with its old
spelling (D14a Ruling 49). ``run_advisory`` (D14a Task 4) sniffs a run's
input once and picks the strategy kind for the run's own target pipeline,
as the run itself does (``pick_strategy`` with the target), so a filelog in
a sibling pipeline can't change which advisory fires.

The test runner picks a strategy (OTLP replay / filelog pull / syslog push)
from the user's YAML alone (see ``executors/__init__.py:pick_strategy``).
The fixture they uploaded is independent — and the two can disagree in
ways that produce surprising results:

* An OTLP-JSON envelope fed to a ``filelog`` pipeline. filelog reads
  line-by-line, so the whole envelope becomes a single record whose
  body is the raw JSON string. The user expected N structured records
  and got 1 opaque string.
* Raw text log lines fed to an ``otlp`` pipeline. The OTLP/HTTP receiver
  rejects every line as invalid JSON, so the pipeline produces no output
  and the run looks broken when actually the fixture is just wrong shape.

This module sniffs the fixture once and produces a ``warn``-severity
``MutationAdvisory`` (F-001 / F-002 / F-003, listed in the service's
README) so the user sees the mismatch in the same
advisories panel that already explains R-001, R-008, etc. The test still
proceeds — users sometimes feed deliberately mis-shapen fixtures to
exercise edge behavior — but they aren't left wondering why.

The platform's web app re-implements this logic to drive its pre-run "Run
anyway?" dialog (D14a Task 9). The two are kept in lock-step by one parity
corpus, ``services/otelcol-testing/tests/fixtures/fixture-shape-corpus.json``:
this package's ``tests/test_fixture_shape_parity.py`` and the web app's
parity test both assert against it, so any divergence in detection,
message text, or strategy picking fails on both sides at once.
"""

from __future__ import annotations

import json
from enum import Enum

from app.yaml_mutations import MutationAdvisory

# Cap on bytes the detector looks at. Fixtures can be tens of MB; we only
# need enough to identify the top-level structure. 64 KB comfortably covers
# even a pretty-printed multi-resource OTLP envelope.
SNIFF_BYTES = 64 * 1024

# Number of leading non-blank lines we attempt to JSON-decode when deciding
# whether a file is NDJSON. Bounded so a 10M-line fixture doesn't pay full
# JSON-parsing cost in the dispatcher.
_NDJSON_SAMPLE_LINES = 50

# Resource keys that identify a payload as an OTLP wire-format envelope.
# Same set the OTLP/HTTP receiver expects at the top level.
_OTLP_ENVELOPE_KEYS = ("resourceLogs", "resourceMetrics", "resourceSpans")

# Which OTLP envelope key carries which signal — used by F-003 to compare the
# fixture's signal against the pipeline's target signal. The OTLP/HTTP receiver
# decodes a payload as the signal of the endpoint it was POSTed to, so a
# `resourceLogs` body sent to /v1/traces yields zero spans (and no output).
_ENVELOPE_KEY_TO_SIGNAL = {
    "resourceSpans": "traces",
    "resourceMetrics": "metrics",
    "resourceLogs": "logs",
}
_SIGNAL_TO_ENVELOPE_KEY = {v: k for k, v in _ENVELOPE_KEY_TO_SIGNAL.items()}

# Strategy kind discriminators. Kept as plain strings so the detector
# doesn't have to import the strategy classes (which would pull in
# subprocess + httpx + the whole executor package just to name them).
OTLP_KIND = "otlp"
FILELOG_KIND = "filelog"
SYSLOG_KIND = "syslog"

# How the advisories name a strategy's receiver: the name, and its first
# mention. The filelog strategy's receiver is `file_log` on every collector
# the platform offers (renamed from `filelog` in 0.149.0, which still works),
# so its words give both (D14a Ruling 49).
_RECEIVER_WORDS = {
    FILELOG_KIND: ("file_log", "`file_log` (or `filelog`)"),
    SYSLOG_KIND: ("syslog", "`syslog`"),
}


class FixtureShape(str, Enum):
    """What the fixture file *looks like* at the top level.

    Distinguishing OTLP_ENVELOPE / OTLP_ARRAY from NDJSON matters because
    the OTLP-replay path splits arrays into separate POSTs (see
    ``otlp_replay._iter_payloads``) while filelog reads everything as
    lines — so the same file produces wildly different run shapes.
    """

    EMPTY = "empty"
    OTLP_ENVELOPE = "otlp_envelope"  # single dict with resourceLogs/Metrics/Spans
    OTLP_ARRAY = "otlp_array"        # JSON array of OTLP envelopes
    NDJSON = "ndjson"                # >1 line, every sampled line parses as JSON
    SINGLE_JSON = "single_json"      # one valid JSON doc that's not OTLP-shaped
    RAW_LINES = "raw_lines"          # multi-line text, lines don't parse as JSON
    SINGLE_LINE = "single_line"      # exactly one non-blank line, not JSON


def _looks_like_otlp_envelope(obj: object) -> bool:
    return isinstance(obj, dict) and any(k in obj for k in _OTLP_ENVELOPE_KEYS)


def _is_json_line(line: str) -> bool:
    try:
        json.loads(line)
        return True
    except json.JSONDecodeError:
        return False


def _classify_truncated_json(stripped: str) -> FixtureShape:
    """Classify a sniff buffer that filled the cap and opens like JSON but
    didn't parse as a whole — its closing tail is past the window.

    We can't fully parse it, so we look for the OTLP envelope keys in the
    visible prefix (they sit at the top of the structure, so they're almost
    always inside the first 64 KB). Finding one means this is the head of a
    large OTLP fixture: returning OTLP_ENVELOPE / OTLP_ARRAY keeps F-002
    firing against filelog/syslog while *not* firing a bogus F-001 against
    an OTLP pipeline. No key found → SINGLE_JSON, which warns for neither
    strategy (a false negative we accept over the false positive of calling
    a truncated structure RAW_LINES).
    """
    has_envelope_key = any(k in stripped for k in _OTLP_ENVELOPE_KEYS)
    if stripped[0] == "[":
        return FixtureShape.OTLP_ARRAY if has_envelope_key else FixtureShape.SINGLE_JSON
    return FixtureShape.OTLP_ENVELOPE if has_envelope_key else FixtureShape.SINGLE_JSON


def _decode_sniff(data: bytes) -> str:
    """Best-effort decode of a sniff buffer.

    Strips the UTF-8 BOM (which the OTLP receiver also tolerates via
    ``utf-8-sig``) so a BOM-prefixed envelope still classifies as
    OTLP_ENVELOPE rather than degrading to RAW_LINES on a failed
    ``json.loads``. UTF-16 isn't handled here — fixtures with NUL
    padding are degenerate enough that the run-time replay decoder in
    ``otlp_replay._decode_fixture`` is the right place to deal with them.
    """
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode("utf-8", errors="replace")


def detect_fixture_shape(data: bytes) -> FixtureShape:
    """Classify the top-level shape of a fixture.

    Caller is responsible for bounding ``data`` — pass at most
    :data:`SNIFF_BYTES` so we don't pay full parsing cost on huge files.

    A large OTLP envelope outgrows the sniff window: ``json.loads`` on the
    truncated prefix raises, so we can't whole-parse it. Rather than fall
    through to line-based detection (which would label it RAW_LINES or
    SINGLE_LINE and fire a bogus F-001 against an OTLP pipeline), a buffer
    that filled the cap *and* opens like a JSON object/array is handed to
    :func:`_classify_truncated_json`. NDJSON is checked first so a >64 KB
    NDJSON file — which also opens with ``{`` — keeps its NDJSON shape
    instead of being mistaken for one giant envelope.
    """
    if not data:
        return FixtureShape.EMPTY
    text = _decode_sniff(data)
    stripped = text.strip()
    if not stripped:
        return FixtureShape.EMPTY

    # Try the whole sniff as one JSON document first. This catches the
    # common case of an OTLP envelope (single dict) or a JSON array of
    # envelopes that's small enough to fit in the sniff buffer.
    try:
        doc = json.loads(stripped)
    except json.JSONDecodeError:
        doc = None
    if doc is not None:
        if _looks_like_otlp_envelope(doc):
            return FixtureShape.OTLP_ENVELOPE
        if isinstance(doc, list) and doc and all(
            _looks_like_otlp_envelope(d) for d in doc
        ):
            return FixtureShape.OTLP_ARRAY
        # Some other JSON shape — treat as single-doc for advisory purposes.
        return FixtureShape.SINGLE_JSON

    # Not a single JSON doc. Look at lines.
    nonblank = [ln for ln in text.splitlines() if ln.strip()]
    if not nonblank:
        return FixtureShape.EMPTY

    # NDJSON first: a multi-line file whose every sampled line is itself a
    # valid JSON document. Checked ahead of the truncated-JSON guard below
    # so a >64 KB NDJSON file (which also opens with ``{``) keeps its NDJSON
    # classification instead of being swallowed as one giant envelope.
    sample = nonblank[:_NDJSON_SAMPLE_LINES]
    json_lines = sum(_is_json_line(ln) for ln in sample)
    # Strict: NDJSON only if every sampled line parses. A mix of JSON and
    # text is more confusing to call NDJSON than to call RAW_LINES — the
    # filelog operator chain handling will be the same either way (the
    # user needs a json_parser on the JSON lines).
    if len(nonblank) > 1 and json_lines == len(sample):
        return FixtureShape.NDJSON

    # Truncated structural JSON. The whole buffer didn't parse and it isn't
    # NDJSON, but we only saw a bounded prefix (it filled the sniff cap) and
    # that prefix opens like a JSON object/array — the head of a large OTLP
    # envelope (minified on one line OR pretty-printed across many) once its
    # closing braces fall outside the window. Reclassify so a valid OTLP
    # fixture doesn't trip a bogus F-001 against an OTLP pipeline.
    if len(data) >= SNIFF_BYTES and stripped[:1] in ("{", "["):
        return _classify_truncated_json(stripped)

    if len(nonblank) == 1:
        return FixtureShape.SINGLE_LINE
    return FixtureShape.RAW_LINES


def _signal_of_envelope(obj: object) -> str | None:
    """The signal an OTLP envelope dict carries, or None when it's not a
    single-signal envelope (no key, or — degenerately — more than one)."""
    if not isinstance(obj, dict):
        return None
    present = [k for k in _OTLP_ENVELOPE_KEYS if k in obj]
    if len(present) == 1:
        return _ENVELOPE_KEY_TO_SIGNAL[present[0]]
    return None


def detect_otlp_signal(data: bytes) -> str | None:
    """The OTLP signal (``traces`` / ``metrics`` / ``logs``) a fixture carries,
    or ``None`` when it isn't a determinable single-signal OTLP envelope/array.

    Mirrors :func:`detect_fixture_shape`'s parsing so the two agree on what an
    "OTLP envelope" is. Used by F-003 to compare the fixture's signal against
    the pipeline's target signal. Caller bounds ``data`` to
    :data:`SNIFF_BYTES`; a large envelope whose body is past the window falls
    back to scanning the visible prefix for exactly one envelope key.
    """
    if not data:
        return None
    text = _decode_sniff(data)
    stripped = text.strip()
    if not stripped:
        return None

    try:
        doc = json.loads(stripped)
    except json.JSONDecodeError:
        doc = None
    if doc is not None:
        if isinstance(doc, dict):
            return _signal_of_envelope(doc)
        if isinstance(doc, list) and doc:
            return _signal_of_envelope(doc[0])
        return None

    # Truncated envelope: the closing braces fell outside the window. Scan the
    # visible prefix; require exactly one envelope key so a stray attribute
    # name can't flip the verdict.
    if len(data) >= SNIFF_BYTES and stripped[:1] in ("{", "["):
        present = [k for k in _OTLP_ENVELOPE_KEYS if k in stripped]
        if len(present) == 1:
            return _ENVELOPE_KEY_TO_SIGNAL[present[0]]
    return None


def _signal_mismatch_message(fixture_signal: str, signal_type: str) -> str:
    """F-003 body. Kept byte-identical to the TS mirror in fixture-shape.ts —
    the corpus asserts exact equality on both sides."""
    key = _SIGNAL_TO_ENVELOPE_KEY[signal_type]
    return (
        f"Your fixture contains OTLP {fixture_signal} data, but the target "
        f"pipeline handles {signal_type}. The sandbox POSTs the fixture to the "
        f"OTLP/HTTP {signal_type} endpoint, which decodes {fixture_signal} data "
        f"as zero {signal_type} records — so the run is likely to produce no "
        f"output. Select a {signal_type} fixture (an OTLP envelope with "
        f"`{key}`), or run this fixture against a {fixture_signal} pipeline."
    )


def fixture_strategy_mismatch_advisory(
    shape: FixtureShape,
    strategy_kind: str,
    *,
    signal_type: str | None = None,
    fixture_signal: str | None = None,
) -> MutationAdvisory | None:
    """Return a warn-severity advisory when the fixture's shape doesn't
    fit the strategy that ``pick_strategy`` chose. ``None`` means the
    pair is compatible (or indeterminate enough that we shouldn't second-
    guess the user).

    Three IDs:

    * **F-001** — strategy is OTLP-replay, fixture is non-OTLP text/NDJSON.
      The OTLP/HTTP receiver will reject every payload and the run will
      produce no output.
    * **F-002** — strategy is filelog/syslog, fixture is an OTLP-JSON
      envelope or array. filelog/syslog read line-by-line, so the entire
      envelope arrives as a single record with the raw JSON string in
      ``body`` — not the records nested inside.
    * **F-003** — strategy is OTLP-replay, fixture is a valid OTLP envelope
      but for the *wrong signal* (e.g. ``resourceLogs`` against a traces
      pipeline). The receiver decodes it as zero records of the target
      signal, so the run silently produces no output. Requires both
      ``signal_type`` (the pipeline's target) and ``fixture_signal`` (from
      :func:`detect_otlp_signal`); when either is unknown F-003 can't fire.
    """
    if strategy_kind == OTLP_KIND:
        if shape is FixtureShape.RAW_LINES or shape is FixtureShape.SINGLE_LINE:
            return MutationAdvisory(
                id="F-001",
                severity="warn",
                message=(
                    "Your fixture looks like raw text log lines, but the "
                    "target pipeline uses an OTLP receiver. The sandbox "
                    "OTLP/HTTP endpoint will reject each line as invalid "
                    "JSON, so the run is likely to produce no output. "
                    "Convert the fixture to OTLP-JSON to test this "
                    "pipeline, or test a `file_log` (or `filelog`) receiver "
                    "pipeline against this fixture as-is."
                ),
                details={
                    "fixture_shape": shape.value,
                    "strategy": strategy_kind,
                },
            )
        if shape is FixtureShape.NDJSON:
            return MutationAdvisory(
                id="F-001",
                severity="warn",
                message=(
                    "Your fixture is NDJSON, but the target pipeline uses "
                    "an OTLP receiver. Each line is POSTed to the sandbox "
                    "OTLP/HTTP endpoint and will be rejected unless every "
                    "line is itself a valid OTLP document (a JSON object "
                    "containing `resourceLogs`, `resourceMetrics`, or "
                    "`resourceSpans`). If these are app log records, run "
                    "the test on a `file_log` (or `filelog`) pipeline with a "
                    "`json_parser` operator instead."
                ),
                details={
                    "fixture_shape": shape.value,
                    "strategy": strategy_kind,
                },
            )
        if shape is FixtureShape.OTLP_ENVELOPE or shape is FixtureShape.OTLP_ARRAY:
            # Right shape, possibly wrong signal: an OTLP envelope for a
            # different signal than the pipeline. Only fire when we can
            # name both signals and they disagree — an indeterminate
            # fixture_signal (None) stays silent rather than guess.
            if (
                signal_type in _SIGNAL_TO_ENVELOPE_KEY
                and fixture_signal is not None
                and fixture_signal != signal_type
            ):
                return MutationAdvisory(
                    id="F-003",
                    severity="warn",
                    message=_signal_mismatch_message(fixture_signal, signal_type),
                    details={
                        "fixture_shape": shape.value,
                        "strategy": strategy_kind,
                        "fixture_signal": fixture_signal,
                        "target_signal": signal_type,
                    },
                )
        return None

    if strategy_kind in (FILELOG_KIND, SYSLOG_KIND):
        if shape is FixtureShape.OTLP_ENVELOPE or shape is FixtureShape.OTLP_ARRAY:
            shape_label = (
                "an OTLP-JSON envelope"
                if shape is FixtureShape.OTLP_ENVELOPE
                else "a JSON array of OTLP envelopes"
            )
            receiver, first_mention = _RECEIVER_WORDS[strategy_kind]
            return MutationAdvisory(
                id="F-002",
                severity="warn",
                message=(
                    f"Your fixture looks like {shape_label}, but the "
                    f"target pipeline uses a {first_mention} receiver. "
                    f"`{receiver}` reads input line by line, so the "
                    "whole envelope arrives as a single record with the "
                    "raw JSON string in `body` — your operator chain "
                    "runs against that one line, not the records nested "
                    "inside. To test the records as OTLP, run on an "
                    f"otlp-receiver pipeline. To test `{receiver}` "
                    "operators, supply a fixture with one log per line."
                ),
                details={
                    "fixture_shape": shape.value,
                    "strategy": strategy_kind,
                },
            )
        return None

    return None


def run_advisory(
    data: bytes,
    yaml_config: str,
    signal_type: str,
    target_pipeline: str | None = None,
) -> MutationAdvisory | None:
    """F-001/F-002/F-003 for a run (D14a Task 4): the first
    :data:`SNIFF_BYTES` of its input against the strategy its target
    pipeline takes."""
    from app.executors import pick_strategy  # the executors import this module

    _strategy, kind = pick_strategy(yaml_config, signal_type, target_pipeline=target_pipeline)
    sniff = data[:SNIFF_BYTES]
    return fixture_strategy_mismatch_advisory(
        detect_fixture_shape(sniff),
        kind,
        signal_type=signal_type,
        fixture_signal=detect_otlp_signal(sniff),
    )


__all__ = [
    "SNIFF_BYTES",
    "OTLP_KIND",
    "FILELOG_KIND",
    "SYSLOG_KIND",
    "FixtureShape",
    "detect_fixture_shape",
    "detect_otlp_signal",
    "fixture_strategy_mismatch_advisory",
    "run_advisory",
]
