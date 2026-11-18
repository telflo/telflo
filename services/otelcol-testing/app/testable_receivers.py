"""Detection + synthesis for receivers whose user-authored stanza operator
chain we test instead of stripping.

`detect_testable_receiver` and
`has_container_operator` skip a pipeline, a receivers list or a receiver
configuration that isn't of its expected shape (a mapping or a list)
instead of raising, so a malformed text is refused or left to the
collector rather than failing the run's child (D14a Task 4; the run checks
the configuration's shape first, `app/compatibility.py`'s
`configuration_shape_problem`).

`filelog` (`file_log` from collector 0.149.0, either spelling; D14a Ruling
49) and `syslog` both embed an operator chain. The sandbox keeps the
chain but **synthesizes a fresh receiver shell from scratch** — no user
transport/source value (`include`, `storage`, `listen_address`, `tls`, …)
ever reaches the executed config. That makes arbitrary file read and
listener abuse structurally absent rather than mitigated.

Only the parsing knobs that are pure behavior (filelog `multiline`; syslog
`protocol`/framing/`location`) are carried over, plus the operator chain
(which is separately allowlisted in operator_allowlist.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

# The receiver types the tester feeds through their own operator chain, by
# every name they go by, each to its strategy's kind. The catalogue renamed
# `filelog` to `file_log` from collector 0.149.0
# (catalog/distributions/otelcol-contrib.json's `renamedTypes`; the old name
# still works, deprecated), so a text may spell it either way and both take
# the same pull strategy, synthesis and checks (D14a Ruling 49). `syslog` has
# no rename.
_KIND_BY_TYPE = {
    "filelog": "filelog",
    "file_log": "filelog",
    "syslog": "syslog",
}
TESTABLE_RECEIVER_KINDS = tuple(_KIND_BY_TYPE)


class InputMode(str, Enum):
    PULL = "pull"  # collector reads a staged file (filelog)
    PUSH = "push"  # we replay raw bytes to a loopback socket (syslog)


class FixtureFormat(str, Enum):
    RAW_LINES = "raw_lines"  # newline-delimited log lines (filelog)
    SYSLOG_FRAMES = "syslog_frames"  # RFC3164/RFC5424 messages (syslog)


@dataclass(frozen=True)
class TestableReceiver:
    kind: str  # "filelog" (for `filelog` and `file_log`) | "syslog"
    name: str  # the receiver key as it appears in the user's YAML
    input_mode: InputMode
    fixture_format: FixtureFormat


_BY_KIND = {
    "filelog": (InputMode.PULL, FixtureFormat.RAW_LINES),
    "syslog": (InputMode.PUSH, FixtureFormat.SYSLOG_FRAMES),
}


def _receiver_base(name: str) -> str:
    """`syslog/in` -> `syslog`. Pipeline keys may be suffixed with `/foo`."""
    return name.split("/", 1)[0]


def kind_of_receiver(name: str) -> str | None:
    """The strategy kind of a receiver key (`file_log/app` -> `filelog`),
    or None when the tester doesn't feed that receiver type itself."""
    return _KIND_BY_TYPE.get(_receiver_base(name))


def _names(value: Any) -> list[str]:
    """A pipeline's receivers list, its string entries only."""
    if not isinstance(value, list):
        return []
    return [name for name in value if isinstance(name, str)]


def has_container_operator(user_cfg: dict | None) -> bool:
    """True if the receiver's operator chain includes a ``container``
    operator. Its ``add_metadata_from_filepath`` (on by default) derives pod
    identity from the log file's path, so runs with one must stage the
    fixture at a container-runtime-shaped path (see
    ``RunWorkspace.container_log_path``)."""
    if not isinstance(user_cfg, dict):
        return False
    operators = user_cfg.get("operators") or []
    if not isinstance(operators, list):
        return False
    for op in operators:
        if isinstance(op, dict) and op.get("type") == "container":
            return True
    return False


def detect_testable_receiver(
    doc: dict,
    signal_type: str | None = None,
    target_pipeline: str | None = None,
) -> TestableReceiver | None:
    """Return the testable receiver to use for an operator-test run, or None.

    When ``target_pipeline`` is provided and names a pipeline in the
    config, only that pipeline's receivers are considered — the same
    narrowed view ``drop_non_target_pipelines`` (R-005) executes. Without
    it, a config with two filelog receivers in sibling same-signal
    pipelines resolves to whichever is defined first in the receivers
    map, and the run silently tests the wrong operator chain.

    When ``signal_type`` is provided (and ``target_pipeline`` is unset or
    stale), only consider receivers actually USED in pipelines of that
    signal. A filelog defined at the top level but referenced only by the
    logs pipeline does NOT make a traces test take the operator-test
    path — the traces pipeline uses its own receivers (e.g. otlp) and
    goes through OTLP-replay; filelog is dropped along with the logs
    pipeline by ``drop_non_target_pipelines``.

    When both are None, falls back to the legacy "first testable receiver
    in the top-level receivers map" behavior so static-check callers
    (tests, ad-hoc lints) keep working.
    """
    receivers = doc.get("receivers") or {}
    if not isinstance(receivers, dict):
        return None
    service = doc.get("service") or {}
    pipelines = (service.get("pipelines") if isinstance(service, dict) else None) or {}
    if not isinstance(pipelines, dict):
        pipelines = {}
    if target_pipeline is not None and target_pipeline in pipelines:
        target = pipelines[target_pipeline] or {}
        candidate_names = set(_names(target.get("receivers"))) if isinstance(target, dict) else set()
    elif signal_type is not None:
        candidate_names = set()
        for pname, p in pipelines.items():
            if isinstance(pname, str) and pname.split("/", 1)[0] == signal_type and isinstance(p, dict):
                for rname in _names(p.get("receivers")):
                    candidate_names.add(rname)
    else:
        candidate_names = set(receivers.keys())

    for name in receivers:
        if name not in candidate_names or not isinstance(name, str):
            continue
        kind = kind_of_receiver(name)
        if kind is not None:
            mode, fmt = _BY_KIND[kind]
            return TestableReceiver(
                kind=kind, name=name, input_mode=mode, fixture_format=fmt
            )
    return None


# Fail-closed allowlist of filelog config keys we carry over from the
# user. The set is intentionally explicit: anything not here is dropped
# (transport/source/state fields like ``include``, ``exclude``, ``storage``,
# ``poll_interval``, ``start_at``, ``ordering_criteria``, ``delete_after_read``,
# ``acquire_fs_lock``, ``retry_on_failure`` must NEVER reach the executed
# config). All keys below are pure parsing/labeling/limits — no path,
# endpoint, or persisted state escapes through them.
_FILELOG_KEEP_KNOBS: tuple[str, ...] = (
    "multiline",
    # User-defined resource/record attribute labelers — the user authored
    # these to label every emitted record; dropping them defeats the point
    # of operator-testing the receiver.
    "resource",
    "attributes",
    # Pure parsing behavior.
    "encoding",
    "force_flush_period",
    "max_log_size",
    "preserve_leading_whitespaces",
    "preserve_trailing_whitespaces",
    "header",
    # File-derived attributes the receiver attaches to records. They label
    # output (no transport read), so the user's choice to include them
    # changes what their downstream rules see and should be honored.
    "include_file_name",
    "include_file_path",
    "include_file_name_resolved",
    "include_file_path_resolved",
    "include_file_record_number",
    "include_file_owner_name",
    "include_file_owner_group_name",
)


def synthesize_filelog(user_cfg: dict, *, fixture_path: str) -> dict:
    """Build a fresh filelog receiver. ``operators`` and a closed set of
    pure parsing/labeling knobs (see ``_FILELOG_KEEP_KNOBS``) are carried
    over from the user; transport/source/state fields are discarded.
    """
    user_cfg = user_cfg if isinstance(user_cfg, dict) else {}
    synth: dict[str, Any] = {
        "include": [fixture_path],
        "start_at": "beginning",
        "operators": user_cfg.get("operators") or [],
    }
    for knob in _FILELOG_KEEP_KNOBS:
        if knob in user_cfg:
            synth[knob] = user_cfg[knob]
    return synth


# Same fail-closed posture for syslog: transport (``tcp``/``udp``/``tls``)
# is synthesized; only parsing/labeling knobs pass through.
_SYSLOG_KEEP_KNOBS: tuple[str, ...] = (
    "enable_octet_counting",
    "non_transparent_framing_trailer",
    "location",
    "resource",
    "attributes",
)


def synthesize_syslog(user_cfg: dict, *, listen_port: int) -> dict:
    """Build a fresh syslog receiver bound to loopback. ``operators``,
    ``protocol``, and a closed set of pure parsing/labeling knobs (see
    ``_SYSLOG_KEEP_KNOBS``) are carried over from the user; transport is
    synthesized.
    """
    user_cfg = user_cfg if isinstance(user_cfg, dict) else {}
    synth: dict[str, Any] = {
        "tcp": {"listen_address": f"127.0.0.1:{listen_port}"},
        "protocol": user_cfg.get("protocol") or "rfc5424",
        "operators": user_cfg.get("operators") or [],
    }
    for knob in _SYSLOG_KEEP_KNOBS:
        if knob in user_cfg:
            synth[knob] = user_cfg[knob]
    return synth
