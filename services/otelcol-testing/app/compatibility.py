"""Pre-flight compatibility checks for user-submitted pipelines.

Its codes and messages are stable:

- **C-002 checks a mapping only:** a processor whose value isn't a mapping
  is skipped, so an integer never crashes the check and a string never
  matches as a substring.
- **C-000 never quotes the text:** ruamel's whole error prints the
  offending lines, so the message is ruamel's problem and its line only (the
  validator's rule, as `app/neutralise.py` words PyYAML's C-000), and a
  duplicate key is named by its line, never by its value. The service's
  bounded reader (PyYAML) has already read the text; ruamel
  refuses what PyYAML accepts in a few cases, duplicate keys above all
  (the collector refuses those too).
- **The configuration's shape** (`configuration_shape_problem`): a text that
  reads as YAML but isn't shaped as a collector configuration (a list at the
  top, a pipeline that's a string, a component named by a number) would make
  the rules and mutations raise. It is refused as C-000, with a message
  naming the misshapen field.
- **C-005**: a ``geoip`` processor is refused, since it reads a database file
  the sandbox doesn't have (and a path the text names could be another run's
  file).
- **C-006**: any setting of a processor whose key ends in ``_file`` or
  ``_path`` and holds a value, anywhere in its configuration (``tls`` blocks
  and lists included), is refused: the sandbox can't give a run access to
  files. Those C-002 and C-005 already refuse are left to them; R-106's
  settings are refused too. The same check runs on the exact text each
  collector reads, walking the node graph the backstop's own reader composes
  (``final_file_settings``).
- **C-005 refuses ``schema`` and ``remotetap``** too, each with
  its own message.
- `check_compatibility_doc` takes an already-parsed document, so the run
  parses once for the shape check and the rules (`check_compatibility`, the
  text form, stays for the tests and its callers).

Walks the parsed YAML *before* the test runner spawns ``otelcol-contrib``
and returns any reasons we should refuse to run, plus any informational
advisories the frontend should surface. The runner short-circuits on
refusals (``severity="refuse"``) and stuffs them into the run record so
the user sees a clear "we can't test this because…" message instead of
a confusing collector failure.

Each ``CompatibilityIssue.id`` is a stable code (the service's README lists
them). The catalog of refused/advisory components lives at the top of this
file so both the docstring and the registry stay in sync.

Note that *advisories about mutations we performed* live separately as
:class:`app.yaml_mutations.MutationAdvisory` (R-001…R-105). This module is
for issues with the user's input, before any rewriting; the mutator owns
issues introduced by our rewrites. The two kinds may both be attached to a
run.
"""

from __future__ import annotations

import math
import re
from typing import Any, Literal

from pydantic import BaseModel, Field
from ruamel.yaml import YAML
from ruamel.yaml.comments import TaggedScalar
from ruamel.yaml.error import MarkedYAMLError
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from app.operator_allowlist import disallowed_operator_in_receiver
from app import bounded_yaml
from app.testable_receivers import TESTABLE_RECEIVER_KINDS

CompatibilitySeverity = Literal["refuse", "advisory"]

# C-000's prefix.
UNPARSEABLE_PREFIX = "could not parse YAML: "


class CompatibilityIssue(BaseModel):
    """A single problem found during pre-flight inspection of the user's
    YAML. ``id`` is its stable code (e.g. ``"C-001"``);
    ``severity="refuse"`` blocks the run, ``severity="advisory"`` lets it
    proceed with a warning attached.
    """

    id: str
    severity: CompatibilitySeverity
    component: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Refusal / advisory rules
# ---------------------------------------------------------------------------
#
# Each rule is a small function ``(doc, issues) -> None`` that appends to
# ``issues`` when the user's YAML triggers it. New rules go here; the
# top-level :func:`check_compatibility` walks the list, in the codes'
# order.

# Receivers we refuse to test because the sandbox can't make the test
# meaningful even after the receiver swap. Currently empty: receivers that
# "reach out" (kubeletstats, prometheus, k8s_cluster, ...) are fine because
# the mutator replaces them with our OTLP-replay source — the user feeds
# captured fixture data through their processor chain. The receiver's own
# config is dropped before any subprocess starts: a test exercises the
# processors, never the receivers.
_REFUSED_RECEIVERS: dict[str, str] = {}


def _check_refused_receivers(doc: dict, issues: list[CompatibilityIssue]) -> None:
    if not _REFUSED_RECEIVERS:
        return
    receivers = doc.get("receivers") or {}
    for name in receivers.keys():
        base = name.split("/", 1)[0]
        if base in _REFUSED_RECEIVERS:
            issues.append(
                CompatibilityIssue(
                    id="C-001",
                    severity="refuse",
                    component=name,
                    message=_REFUSED_RECEIVERS[base],
                    details={"receiver": name, "base": base},
                )
            )


# Processors with explicit kube_config_path are unsafe to silently rewrite —
# the user pinned a path and we'd be lying to them if we redirected to our
# kwok kubeconfig. Note that as of k8sattributes v0.146 there is no
# kube_config_path field, so this is defensive in case the upstream config
# surface changes; if it does, this rule will start firing and we'll want to
# add proper handling rather than silent rewrite.
def _check_pinned_kube_config_path(
    doc: dict, issues: list[CompatibilityIssue]
) -> None:
    processors = doc.get("processors") or {}
    for name, cfg in processors.items():
        # Only a mapping can set a field (an integer would raise, and a
        # string would match as a substring).
        if not isinstance(cfg, dict) or "kube_config_path" not in cfg:
            continue
        issues.append(
            CompatibilityIssue(
                id="C-002",
                severity="refuse",
                component=name,
                message=(
                    f"{name} sets `kube_config_path`, which would conflict "
                    f"with the sandbox's injected kubeconfig. We refuse "
                    f"rather than silently override your pinned path."
                ),
                details={"processor": name, "field": "kube_config_path"},
            )
        )


# C-005: processors that can't run in the sandbox, each with its own message.
# `geoip` looks every address up in a MaxMind database at
# `providers.maxmind.database_path`: the sandbox has no such database, and
# every run's collector shares one user and one disk, so a path there could
# name another run's files or the tester's. `schema` fetches schema files
# from URLs, `file://` included, which the sandbox can neither reach nor let
# it open. `remotetap` starts its own server, on a port or a unix socket
# path, which the sandbox doesn't run. The catalogue knows each by one
# spelling (no rename; a test fails if that changes). Refused wherever
# they're defined, as C-002 is, not only in the pipeline under test.
_REFUSED_PROCESSORS: dict[str, str] = {
    "geoip": (
        "{name} looks addresses up in a GeoIP database file, and the sandbox "
        "has no such database (a test can't read files from the sandbox). "
        "Test this processor in a real collector deployment."
    ),
    "schema": (
        "{name} fetches schema files from URLs (file:// included), which the "
        "sandbox can't reach or open (a test can't read files or reach the "
        "network from the sandbox). Test this processor in a real collector "
        "deployment."
    ),
    "remotetap": (
        "{name} starts its own server (on a port or a unix socket path), "
        "which the sandbox doesn't run. Test this processor in a real "
        "collector deployment."
    ),
}


def _check_refused_processors(doc: dict, issues: list[CompatibilityIssue]) -> None:
    processors = doc.get("processors") or {}
    for name in processors.keys():
        base = name.split("/", 1)[0]
        if base not in _REFUSED_PROCESSORS:
            continue
        issues.append(
            CompatibilityIssue(
                id="C-005",
                severity="refuse",
                component=name,
                message=_REFUSED_PROCESSORS[base].format(name=name),
                details={"processor": name, "base": base},
            )
        )


# ---------------------------------------------------------------------------
# C-003: timing windows that affect output even on graceful shutdown
# ---------------------------------------------------------------------------
#
# Originally this rule also flagged `batch.timeout` exceeding the run
# duration, on the assumption that buffered records would be lost when the
# collector got SIGTERM. That assumption was wrong: the collector's graceful
# shutdown calls each processor's Shutdown() method, and `batch.Shutdown()`
# drains its buffer to the next stage. So `batch.timeout` doesn't actually
# affect whether records reach the exporter inside the test window —
# duration_seconds is a no-op for batch alone.
#
# The remaining genuine case is `tail_sampling`: if `decision_wait` hasn't
# elapsed for a trace by SIGTERM, the sampling decision either falls back
# to a default policy or the in-flight trace is dropped. The output is
# non-deterministic in a way the user wouldn't expect from their config.
# This is the case C-003 still covers.
#
# Other timing-windowed processors that flush on shutdown (groupbytrace's
# wait_duration drains, similar story for groupbyattrs) are NOT in this
# table for the same reason — graceful shutdown handles them. Add an entry
# here only when a processor's timing window genuinely changes the output
# in a way duration can fix.
#
# Each entry is (processor_base_name, ((path_segments, knob_label, default), …))
# — a list of dot-separated paths into the processor config that hold a
# duration string ("10s", "30m", …). `default` is what the processor uses if
# the field is absent.
_TIMING_KNOBS: dict[str, list[tuple[tuple[str, ...], str, str | None]]] = {
    "tail_sampling": [
        (("decision_wait",), "tail_sampling.decision_wait", "30s"),
    ],
}


# Upper bound on a single test run's hold window. Mirrors the platform's
# check on test_runs.duration_seconds, the tester's contract and the run
# dialog's maximum — keep them in lockstep. C-003's recommended duration is
# clamped to this so the advisory never suggests a value the run dialog
# would reject.
_MAX_RUN_DURATION_SECONDS = 60


def _recommended_duration_for_window(window_seconds: float) -> int:
    """Smallest integer run duration that fully covers ``window_seconds``,
    clamped to the allowed run-duration range.

    +1s of slack so the decision window has actually elapsed (not merely
    equalled) before SIGTERM. When the window itself exceeds the max run
    duration, this returns the cap — the message that uses it states plainly
    that even the longest allowed run won't fully cover the window, rather
    than silently recommending an impossible value.
    """
    return min(
        int(math.ceil(window_seconds)) + 1,
        _MAX_RUN_DURATION_SECONDS,
    )


_DURATION_TOKEN_RE = re.compile(r"(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)")
_UNIT_TO_SECONDS = {
    "ns": 1e-9,
    "us": 1e-6,
    "µs": 1e-6,
    "ms": 1e-3,
    "s": 1.0,
    "m": 60.0,
    "h": 3600.0,
}


def _parse_duration_seconds(raw: Any) -> float | None:
    """Parse a Go-style duration into seconds.

    Handles bare numbers (``5``, ``"5"``), single-token strings (``"30s"``,
    ``"1.5h"``), and compound forms (``"1m30s"``, ``"2h15m500ms"``) — the
    same shape ``time.ParseDuration`` accepts in the collector. Negative
    durations and signs aren't supported; they don't appear in collector
    configs.

    Returns ``None`` when the value isn't a recognized shape so callers
    don't emit advisories on garbage. Bare numbers are treated as seconds
    (the collector accepts both ``timeout: 5`` and ``timeout: "5s"``).
    """
    if raw is None:
        return None
    if isinstance(raw, bool):  # bool is a subclass of int; reject explicitly
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    # Bare number string -> seconds (collector accepts both timeout: 5 and "5").
    try:
        return float(s)
    except ValueError:
        pass
    total = 0.0
    pos = 0
    while pos < len(s):
        m = _DURATION_TOKEN_RE.match(s, pos)
        if not m:
            return None
        total += float(m.group(1)) * _UNIT_TO_SECONDS[m.group(2)]
        pos = m.end()
    return total if pos == len(s) else None


def _read_path(cfg: dict | None, path: tuple[str, ...]) -> Any:
    """Walk a tuple-path through nested dicts. Missing keys → None."""
    cur: Any = cfg
    for segment in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(segment)
    return cur


def _check_timing_windows(
    doc: dict,
    issues: list[CompatibilityIssue],
    duration_seconds: int,
) -> None:
    """C-003: flag processors whose decision/sampling windows exceed
    ``duration_seconds``.

    Only fires for processors whose output actually depends on a wall-clock
    decision being made before SIGTERM (currently just ``tail_sampling``).
    Buffering processors like ``batch`` flush on graceful shutdown so they
    don't belong here — see the comment on _TIMING_KNOBS for why.

    Always advisory, never a refusal — the run will execute, the user just
    needs to know that some traces may not get a deliberate sampling
    decision before the collector exits.
    """
    processors = doc.get("processors") or {}
    if not isinstance(processors, dict):
        return
    for name, cfg in processors.items():
        base = name.split("/", 1)[0] if isinstance(name, str) else None
        if base is None or base not in _TIMING_KNOBS:
            continue
        for path, label, default in _TIMING_KNOBS[base]:
            raw = _read_path(cfg, path)
            if raw is None:
                raw = default
            window = _parse_duration_seconds(raw)
            if window is None:
                continue
            if window <= duration_seconds:
                continue
            recommended = _recommended_duration_for_window(window)
            covers_fully = recommended > window
            if covers_fully:
                remedy = (
                    f"Raise the run duration to at least {recommended}s "
                    f"for a faithful test."
                )
            else:
                remedy = (
                    f"Even the maximum run duration of "
                    f"{_MAX_RUN_DURATION_SECONDS}s won't fully cover this "
                    f"window — lower {label} to test this pipeline faithfully."
                )
            issues.append(
                CompatibilityIssue(
                    id="C-003",
                    severity="advisory",
                    component=name,
                    message=(
                        f"{label} is {window:g}s but the test runs for "
                        f"{duration_seconds}s — traces in flight when the "
                        f"collector receives SIGTERM may be sampled with the "
                        f"default policy or dropped, not the decision your "
                        f"config intends. {remedy}"
                    ),
                    details={
                        "processor": name,
                        "knob": label,
                        "window_seconds": window,
                        "duration_seconds": duration_seconds,
                        # Structured form of the remedy so the frontend can
                        # offer a one-click "re-run at Ns" without parsing the
                        # message. Clamped to the allowed range; when
                        # window > max, this equals the cap and
                        # ``recommended_covers_window`` is False so the UI can
                        # phrase it as "best effort" rather than a fix.
                        "recommended_duration_seconds": recommended,
                        "recommended_covers_window": covers_fully,
                    },
                )
            )


def _check_testable_receiver_constraints(
    doc: dict,
    issues: list[CompatibilityIssue],
    signal_type: str | None = None,
    target_pipeline: str | None = None,
) -> None:
    """C-004: only fires when the **target-signal pipeline actually uses**
    a filelog/syslog receiver (`filelog` spelt either way: `file_log` is its
    name from collector 0.149.0). A filelog defined at the top level but
    referenced only by a sibling pipeline (e.g., the logs pipeline while
    the user runs a traces test) is irrelevant — the test takes the
    OTLP-replay path for the target signal and the unused filelog is
    dropped along with the logs pipeline.

    Within the target-signal pipeline, refuses when:
      - more than one filelog/syslog is used, or
      - filelog/syslog is mixed with another receiver type, or
      - the testable receiver only emits logs but the requested signal
        isn't logs (upstream-malformed config), or
      - an operator ``type`` isn't allowlisted.

    ``target_pipeline`` is the exact ``service.pipelines`` key the user
    picked in the Run dialog. When set and present in the config, the check
    narrows to that single pipeline — the same view the sandbox executes
    after ``drop_non_target_pipelines`` (R-005) removes the siblings — so a
    filelog in a *sibling* same-signal pipeline can't trigger a refusal.
    When unset or stale (pipeline no longer in the config), fall back to
    the signal-type union, mirroring R-005's fallback.

    Legacy static callers (no ``signal_type``) get a conservative
    ``logs``-default so existing checks still catch misuses.
    """
    receivers = doc.get("receivers") or {}
    pipelines = ((doc.get("service") or {}).get("pipelines")) or {}
    target_signal = signal_type or "logs"

    if target_pipeline is not None and target_pipeline in pipelines:
        target_pipelines = {target_pipeline: pipelines[target_pipeline]}
    else:
        target_pipelines = {
            pname: p for pname, p in pipelines.items()
            if pname.split("/", 1)[0] == target_signal
        }
    used_in_target: set[str] = set()
    for p in target_pipelines.values():
        for rname in ((p or {}).get("receivers") or []):
            used_in_target.add(rname)

    testable_in_target = sorted(
        rn for rn in used_in_target
        if rn.split("/", 1)[0] in TESTABLE_RECEIVER_KINDS
    )
    if not testable_in_target:
        # No filelog/syslog used in the target pipeline. The OTLP-replay
        # path handles this run (or there's no target pipeline at all,
        # which the runner surfaces as empty output) — nothing for C-004
        # to enforce.
        return

    def refuse(component: str, message: str) -> None:
        issues.append(
            CompatibilityIssue(
                id="C-004",
                severity="refuse",
                component=component,
                message=message,
                details={"testable_receivers": testable_in_target},
            )
        )

    if len(testable_in_target) > 1:
        refuse(
            ", ".join(testable_in_target),
            f"Operator testing supports a single file_log (filelog) or syslog receiver "
            f"per pipeline; the {target_signal} pipeline uses "
            f"{len(testable_in_target)} ({', '.join(testable_in_target)}).",
        )
        return

    other_in_target = sorted({
        r.split("/", 1)[0] for r in used_in_target
        if r.split("/", 1)[0] not in TESTABLE_RECEIVER_KINDS
    })
    only_full = testable_in_target[0]
    if other_in_target:
        refuse(
            only_full,
            f"The {target_signal} pipeline must use only the "
            f"file_log (filelog) or syslog receiver for operator testing. Found other "
            f"receivers in the {target_signal} pipeline "
            f"({', '.join(other_in_target)}); remove them from the "
            "pipeline or test in a separate pipeline.",
        )
        return

    if target_signal != "logs":
        refuse(
            only_full,
            f"`{only_full}` only emits logs but appears in the "
            f"{target_signal} pipeline being tested. Remove it from the "
            f"{target_signal} pipeline.",
        )
        return

    reason = disallowed_operator_in_receiver(receivers.get(only_full) or {})
    if reason is not None:
        refuse(only_full, f"{only_full}: {reason}.")


# C-006: any processor setting that names a file is refused, found by a walk
# over every processor's configuration, not a list of processors: a key
# ending in `_file` or `_path` holding a value (TLS's ca_file, cert_file and
# key_file, a token_file, a database_path, ...), at any depth, in mappings
# and lists alike. Every run's collector shares one user and one disk, so
# such a path could name another run's files or the tester's.
# resourcedetection's consul, openshift and docker settings are refused too,
# though R-106 would strip them (defence in depth), and the same rule runs
# again on the exact text each collector reads, over the node graph the
# backstop's own reader composes (``final_file_settings``). Left to the
# others here: a processor C-005 refuses outright (it keeps its own message)
# and C-002's `kube_config_path`. The message names the processor and the
# key, never the value.
_FILE_KEY_SUFFIXES = ("_file", "_path")
_LEFT_TO_C002 = "kube_config_path"


def _names_a_file(value: Any) -> bool:
    """Whether a constructed value is set: not null, and not an empty
    string, bytes value, list or mapping. Its tag never matters, as in the
    final check's ``_node_names_a_file``: ruamel builds `!foo ''` or
    `!!str ''` as a TaggedScalar holding '', and `!!binary ''` as b'', each
    empty."""
    if isinstance(value, TaggedScalar):
        value = value.value
    if value is None or isinstance(value, (str, bytes, list, dict)):
        return bool(value)
    return True


def _file_settings(value: Any, prefix: str) -> list[str]:
    """The dotted keys (``tls.ca_file``, ``list[0].token_file``) under
    ``value`` that end in ``_file`` or ``_path`` and hold a value."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            name = key if isinstance(key, str) else str(key)
            path = f"{prefix}.{name}" if prefix else name
            if name.endswith(_FILE_KEY_SUFFIXES) and _names_a_file(item):
                found.append(path)
            else:
                found.extend(_file_settings(item, path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_file_settings(item, f"{prefix}[{index}]"))
    return found


def _file_setting_issue(name: str, key: str) -> CompatibilityIssue:
    return CompatibilityIssue(
        id="C-006",
        severity="refuse",
        component=name,
        message=(
            f"{name} sets `{key}`, which names a file, and the sandbox can't "
            f"give a test run access to files. Remove it to test this "
            f"processor here, or test it in a real collector deployment."
        ),
        details={"processor": name, "key": key},
    )


def _file_setting_issues(processors: object, *, leave_to_others: bool) -> list[CompatibilityIssue]:
    if not isinstance(processors, dict):
        return []
    issues: list[CompatibilityIssue] = []
    for raw_name, cfg in processors.items():
        name = raw_name if isinstance(raw_name, str) else str(raw_name)
        if leave_to_others and name.split("/", 1)[0] in _REFUSED_PROCESSORS:
            continue
        for key in _file_settings(cfg, ""):
            if leave_to_others and key == _LEFT_TO_C002:
                continue
            issues.append(_file_setting_issue(name, key))
    return issues


def _check_processor_file_settings(doc: dict, issues: list[CompatibilityIssue]) -> None:
    issues.extend(_file_setting_issues(doc.get("processors"), leave_to_others=True))


# What the final check calls a text it can't compose (C-000).
FINAL_UNREADABLE_MESSAGE = (
    f"{UNPARSEABLE_PREFIX}the text the collector would read couldn't be "
    "checked for processor settings that name files"
)
_NULL_TAG = "tag:yaml.org,2002:null"
_MERGE_KEY = "<<"


def _node_names_a_file(node: Node) -> bool:
    """Whether a composed value is set: a scalar that isn't empty or the
    implicit null, a collection with an item. Its tag never matters."""
    if isinstance(node, ScalarNode):
        return node.value != "" and node.tag != _NULL_TAG
    return bool(node.value)


def _node_key_name(node: Node) -> str:
    return node.value if isinstance(node, ScalarNode) else "?"


def _node_file_settings(node: Node, prefix: str) -> list[str]:
    """``_file_settings`` on the composed graph: the dotted keys under
    ``node`` ending in ``_file`` or ``_path`` that hold a value, whatever
    tag a key or a value carries; mapping keys that aren't scalars, and
    sequence items, are walked too. (The reader bounds depth and aliases, and
    refuses a node inside itself.)"""
    found: list[str] = []
    if isinstance(node, MappingNode):
        for key, value in node.value:
            name = _node_key_name(key)
            path = f"{prefix}.{name}" if prefix else name
            if not isinstance(key, ScalarNode):
                found.extend(_node_file_settings(key, path))
            if name.endswith(_FILE_KEY_SUFFIXES) and _node_names_a_file(value):
                found.append(path)
            else:
                found.extend(_node_file_settings(value, path))
    elif isinstance(node, SequenceNode):
        for index, item in enumerate(node.value):
            found.extend(_node_file_settings(item, f"{prefix}[{index}]"))
    return found


def _processors_nodes(node: Node) -> list[Node]:
    """The values of the document's ``processors`` keys, those merged in
    (``<<``) included."""
    found: list[Node] = []
    if not isinstance(node, MappingNode):
        return found
    for key, value in node.value:
        name = _node_key_name(key)
        if name == "processors":
            found.append(value)
        elif name == _MERGE_KEY:
            for merged in value.value if isinstance(value, SequenceNode) else [value]:
                found.extend(_processors_nodes(merged))
    return found


def _processor_entries(node: Node) -> list[tuple[str, Node]]:
    """Each processor (name, configuration) of a ``processors`` mapping,
    those merged in (``<<``) included; anything else is walked whole as one
    entry."""
    if not isinstance(node, MappingNode):
        return [("processors", node)]
    entries: list[tuple[str, Node]] = []
    for key, value in node.value:
        name = _node_key_name(key)
        if name == _MERGE_KEY:
            for merged in value.value if isinstance(value, SequenceNode) else [value]:
                entries.extend(_processor_entries(merged))
            continue
        if not isinstance(key, ScalarNode):
            entries.append((name, key))
        entries.append((name, value))
    return entries


def final_file_settings(text: str) -> list[CompatibilityIssue]:
    """C-006 on the exact text a collector is about to read, beside the
    backstop and read by the backstop's own reader
    (`bounded_yaml.single_node`, which composes and never constructs): every
    processor's file-naming setting that survived, found on the composed node
    graph, through any tag (a custom tag, an unhashable key or an ill-fitting
    explicit tag, which the collector reads all the same), with nothing left
    to another rule. A text it can't compose is refused (C-000), never
    passed."""
    try:
        root = bounded_yaml.single_node(text)
    except Exception as error:  # noqa: BLE001 - any read failure refuses the run
        return [unparseable_issue(FINAL_UNREADABLE_MESSAGE, type(error).__name__)]
    if root is None:
        return []
    issues: list[CompatibilityIssue] = []
    for processors in _processors_nodes(root):
        for name, cfg in _processor_entries(processors):
            issues.extend(_file_setting_issue(name, key) for key in _node_file_settings(cfg, ""))
    return issues


_RULES = (
    _check_refused_receivers,
    _check_pinned_kube_config_path,
    _check_refused_processors,
    _check_processor_file_settings,
)


# ---------------------------------------------------------------------------
# The configuration's shape
# ---------------------------------------------------------------------------

# The top-level sections that hold components, each a mapping of names.
_COMPONENT_SECTIONS = ("receivers", "processors", "exporters", "connectors", "extensions")
# A pipeline's lists of component names.
_PIPELINE_LISTS = ("receivers", "processors", "exporters")


def configuration_shape_problem(doc: Any) -> str | None:
    """None when ``doc`` is shaped as the rules and mutations read a
    collector configuration; otherwise what isn't, naming the field (never
    its value):

    - the document is a mapping (or empty);
    - each component section, ``service`` and ``service.pipelines`` is a
      mapping (or empty), and every component and pipeline is named by a
      string;
    - each pipeline is a mapping (or empty), and its receivers, processors
      and exporters are lists of names (or empty).

    What a component's own configuration holds is the collector's to judge.
    """
    if doc is None:
        return None
    if not isinstance(doc, dict):
        return "the configuration must be a mapping at the top level"
    for section in _COMPONENT_SECTIONS:
        value = doc.get(section)
        if value is None:
            continue
        if not isinstance(value, dict):
            return f"`{section}` must be a mapping of component names"
        if not all(isinstance(name, str) for name in value):
            return f"every name in `{section}` must be a string"
    service = doc.get("service")
    if service is None:
        return None
    if not isinstance(service, dict):
        return "`service` must be a mapping"
    pipelines = service.get("pipelines")
    if pipelines is None:
        return None
    if not isinstance(pipelines, dict):
        return "`service.pipelines` must be a mapping of pipeline names"
    for name, pipeline in pipelines.items():
        if not isinstance(name, str):
            return "every pipeline's name must be a string"
        if pipeline is None:
            continue
        if not isinstance(pipeline, dict):
            return f"pipeline `{name}` must be a mapping"
        for field in _PIPELINE_LISTS:
            names = pipeline.get(field)
            if names is None:
                continue
            if not isinstance(names, list) or not all(isinstance(item, str) for item in names):
                return f"pipeline `{name}`'s `{field}` must be a list of names"
    return None


def unparseable_message(error: Exception) -> str:
    """C-000's message for a text ruamel can't read: its problem and line,
    never the text (a duplicate key's problem would quote its value)."""
    if isinstance(error, MarkedYAMLError):
        mark = error.problem_mark
        line = f" (line {mark.line + 1})" if mark is not None else ""
        problem = error.problem or "the document is not valid YAML"
        if "duplicate key" in problem:
            problem = "found a duplicate key"
        return f"{UNPARSEABLE_PREFIX}{problem}{line}"
    return f"{UNPARSEABLE_PREFIX}the document is not valid YAML"


def unparseable_issue(message: str, error_type: str) -> CompatibilityIssue:
    return CompatibilityIssue(
        id="C-000",
        severity="refuse",
        component="<yaml>",
        message=message,
        details={"error_type": error_type},
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse(yaml_str: str) -> Any:
    """The text as the checks read it (ruamel's round-trip loader); an
    empty text is an empty mapping."""
    return YAML().load(yaml_str) or {}


def check_compatibility_doc(
    doc: Any,
    duration_seconds: int = 5,
    signal_type: str | None = None,
    target_pipeline: str | None = None,
) -> list[CompatibilityIssue]:
    """The rules on an already-parsed document (`parse`). A document of the
    wrong shape (`configuration_shape_problem`) is C-000."""
    problem = configuration_shape_problem(doc)
    if problem is not None:
        return [unparseable_issue(f"{UNPARSEABLE_PREFIX}{problem}", "ShapeError")]
    doc = doc or {}
    issues: list[CompatibilityIssue] = []
    for rule in _RULES:
        rule(doc, issues)
    _check_testable_receiver_constraints(
        doc, issues, signal_type=signal_type, target_pipeline=target_pipeline
    )
    _check_timing_windows(doc, issues, duration_seconds)
    return issues


def check_compatibility(
    yaml_str: str,
    duration_seconds: int = 5,
    signal_type: str | None = None,
    target_pipeline: str | None = None,
) -> list[CompatibilityIssue]:
    """Parse ``yaml_str`` and return any compatibility issues. Empty list
    means the YAML passes pre-flight and the runner can proceed.

    ``duration_seconds`` is the run's per-row duration. Pass it through so
    timing-window rules (C-003) can compare each processor's flush window
    against the actual test wall time.

    ``signal_type`` is the target signal of the test run. Passed through
    to rules that scope their checks to the pipelines that will actually
    be executed (e.g. C-004 narrows its receiver-mix check to pipelines
    of the target signal so a normal full-collector config with `otlp`
    feeding traces/metrics and `filelog` feeding logs isn't refused).

    ``target_pipeline`` is the exact pipeline key the user selected in the
    Run dialog, when any. Rules that scope by pipeline (C-004) narrow to
    it so pre-flight judges the same config the sandbox will actually run
    after R-005 drops the non-target pipelines.

    Failing to parse the YAML is itself an issue — surfaced as a refusal
    so the run record carries a structured reason rather than a 500.
    """
    try:
        doc = parse(yaml_str)
    except Exception as e:
        return [unparseable_issue(unparseable_message(e), type(e).__name__)]
    return check_compatibility_doc(
        doc,
        duration_seconds=duration_seconds,
        signal_type=signal_type,
        target_pipeline=target_pipeline,
    )


def has_refusal(issues: list[CompatibilityIssue]) -> bool:
    """Convenience for the run: True if any issue would block the run. Used
    to decide between short-circuit and proceed."""
    return any(i.severity == "refuse" for i in issues)
