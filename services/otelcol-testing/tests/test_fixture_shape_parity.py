"""Cross-implementation parity: the Python fixture-shape module must agree
with the shared corpus that the platform web app's mirror is
also tested against. If detection rules, advisory message text, or
strategy-picking drift between the two modules, the offending corpus row
fails here AND in the web app's suite — that's the whole point of the
shared file.

The corpus is ``tests/fixtures/fixture-shape-corpus.json``, the one copy
both suites read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.executors import pick_strategy
from app.fixture_shape import (
    FixtureShape,
    detect_fixture_shape,
    detect_otlp_signal,
    fixture_strategy_mismatch_advisory,
)

_CORPUS_PATH = Path(__file__).resolve().parent / "fixtures" / "fixture-shape-corpus.json"
_CORPUS = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "case", _CORPUS["detection"], ids=lambda c: c["name"]
)
def test_detection_matches_corpus(case: dict) -> None:
    actual = detect_fixture_shape(case["text"].encode("utf-8"))
    assert actual is FixtureShape(case["expected"]), (
        f"{case['name']}: expected {case['expected']}, got {actual.value}"
    )


@pytest.mark.parametrize(
    "case", _CORPUS["signals"], ids=lambda c: c["name"]
)
def test_signal_matches_corpus(case: dict) -> None:
    actual = detect_otlp_signal(case["text"].encode("utf-8"))
    assert actual == case["expected"], (
        f"{case['name']}: expected {case['expected']}, got {actual}"
    )


@pytest.mark.parametrize(
    "case", _CORPUS["advisories"], ids=lambda c: c["name"]
)
def test_advisory_matches_corpus(case: dict) -> None:
    advisory = fixture_strategy_mismatch_advisory(
        FixtureShape(case["shape"]),
        case["strategy"],
        signal_type=case.get("signal_type"),
        fixture_signal=case.get("fixture_signal"),
    )
    if case["expected_id"] is None:
        assert advisory is None, f"{case['name']}: expected no advisory"
        return
    assert advisory is not None, f"{case['name']}: expected an advisory"
    assert advisory.id == case["expected_id"]
    # Exact message match — this is the highest-drift surface (the F-001/F-002
    # strings are duplicated verbatim across the Python and TS modules).
    assert advisory.message == case["expected_message"]


@pytest.mark.parametrize(
    "case", _CORPUS["strategies"], ids=lambda c: c["name"]
)
def test_strategy_kind_matches_corpus(case: dict) -> None:
    _strategy, kind = pick_strategy(case["yaml"], case["signal_type"])
    assert kind == case["expected_kind"], (
        f"{case['name']}: expected {case['expected_kind']}, got {kind}"
    )


@pytest.mark.parametrize(
    "case", _CORPUS["target_strategies"], ids=lambda c: c["name"]
)
def test_target_strategy_kind_matches_corpus(case: dict) -> None:
    # The run's target pipeline decides the strategy: the web's mirror
    # reads the same section, so both sides check it.
    _strategy, kind = pick_strategy(
        case["yaml"], case["signal_type"], target_pipeline=case["target_pipeline"]
    )
    assert kind == case["expected_kind"], (
        f"{case['name']}: expected {case['expected_kind']}, got {kind}"
    )


def test_corpus_sections_are_all_checked() -> None:
    # A section added to the shared corpus must be read here too.
    checked = {"detection", "signals", "advisories", "strategies", "target_strategies"}
    assert set(_CORPUS) - {"_comment"} == checked
    assert len(_CORPUS["target_strategies"]) > 0


def test_pick_strategy_target_pipeline_overrides_sibling_filelog() -> None:
    # The selected pipeline uses otlp; a sibling logs pipeline uses
    # filelog. R-005 will drop the sibling, so the run must take the
    # OTLP-replay path — filelog's mere presence in another same-signal
    # pipeline must not win.
    src = """
receivers:
  otlp: {protocols: {http: {}}}
  filelog: {include: [/a.log]}
service:
  pipelines:
    logs:      {receivers: [filelog], exporters: [debug]}
    logs/otlp: {receivers: [otlp],    exporters: [debug]}
"""
    _strategy, kind = pick_strategy(src, "logs", target_pipeline="logs/otlp")
    assert kind == "otlp"
