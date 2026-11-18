"""``RunOutcome`` (`app/executors/base.py`)."""

from __future__ import annotations

from app.executors.base import RunOutcome


def test_run_outcome_defaults_decoded_input_to_empty() -> None:
    outcome = RunOutcome(collector_ok=True)
    assert outcome.decoded_input == ""


def test_run_outcome_carries_decoded_input_when_set() -> None:
    outcome = RunOutcome(collector_ok=True, decoded_input='{"resourceMetrics": []}')
    assert outcome.decoded_input == '{"resourceMetrics": []}'
