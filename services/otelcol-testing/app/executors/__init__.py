"""Strategy-pattern dispatch for a run: OTLP replay, filelog pull, syslog
push.

A text that doesn't read as a mapping takes the OTLP-replay path instead
of raising (D14a Task 4; the run refuses such a text before it gets here,
`app/compatibility.py`). The run's child (`app/run.py`) picks the strategy
and drives it.

To add a new strategy (e.g. ``journald``, ``windowseventlog``, ``tcplog``):
1. Add a new module with a class following ``base.TestStrategy``.
2. Extend ``detect_testable_receiver`` in ``testable_receivers.py`` if the
   strategy is selected by receiver presence.
3. Add a branch in ``pick_strategy`` below.
"""

from __future__ import annotations

from ruamel.yaml import YAML

from app.executors.base import ExecutorContext, TestStrategy
from app.executors.filelog_pull import FilelogPullStrategy
from app.executors.otlp_replay import OtlpReplayStrategy
from app.executors.syslog_push import SyslogPushStrategy
from app.fixture_shape import FILELOG_KIND, OTLP_KIND, SYSLOG_KIND
from app.testable_receivers import InputMode, detect_testable_receiver


def pick_strategy(
    yaml_config: str,
    signal_type: str,
    target_pipeline: str | None = None,
) -> tuple[TestStrategy, str]:
    """Return the right strategy for ``yaml_config`` running against
    ``signal_type``, plus a string ``kind`` identifying which strategy
    branch was taken.

    The ``kind`` is what the fixture-shape detector uses to decide
    whether a F-001/F-002 advisory is warranted; carrying it out of the
    dispatcher keeps the caller free of isinstance() checks against the
    strategy classes.

    Filelog/syslog only win when the receiver is actually used in the
    target-signal pipeline (signal-scoped). Top-level presence alone is
    not enough — e.g. a full collector with otlp-for-traces+filelog-for-logs
    running a TRACES test uses otlp, so OTLP replay is the right path.
    ``target_pipeline`` narrows further to the pipeline the user selected,
    matching what R-005 will actually execute.
    """
    doc = YAML().load(yaml_config) or {}
    tr = (
        detect_testable_receiver(doc, signal_type, target_pipeline=target_pipeline)
        if isinstance(doc, dict)
        else None
    )
    if tr is not None and tr.input_mode is InputMode.PULL:
        return FilelogPullStrategy(), FILELOG_KIND
    if tr is not None and tr.input_mode is InputMode.PUSH:
        return SyslogPushStrategy(), SYSLOG_KIND
    return OtlpReplayStrategy(), OTLP_KIND


__all__ = [
    "ExecutorContext",
    "TestStrategy",
    "pick_strategy",
    "OtlpReplayStrategy",
    "FilelogPullStrategy",
    "SyslogPushStrategy",
]
