"""The compatibility checks; D14a Task 4's rules (C-002 with a non-mapping
processor, C-000 never quoting the text, the configuration's shape) are
tested at the end."""

from __future__ import annotations

from textwrap import dedent

from app.compatibility import (
    CompatibilityIssue,
    check_compatibility,
    has_refusal,
)


# ---------------------------------------------------------------------------
# Receivers that "reach out" are intentionally NOT refused: the mutator
# swaps them for our OTLP-replay source before the collector ever starts,
# so the user's kubeletstats / prometheus / etc. config never executes.
# Tests here pin the contract that we let those YAMLs through.
# ---------------------------------------------------------------------------


def test_kubeletstats_receiver_is_not_refused() -> None:
    """The receiver gets swapped (R-001) before the run, so its kubelet
    dependency is irrelevant. Users with captured kubeletstats fixtures
    should be able to test their processor chains against that data."""
    src = dedent(
        """
        receivers:
          kubeletstats:
            endpoint: localhost:10250
        processors: {batch: {}}
        exporters: {debug: {}}
        service: {pipelines: {metrics: {receivers: [kubeletstats], exporters: [debug]}}}
        """
    )
    issues = check_compatibility(src)
    assert issues == []
    assert has_refusal(issues) is False


# ---------------------------------------------------------------------------
# Refusal: pinned kube_config_path (C-002 — defensive)
# ---------------------------------------------------------------------------


def test_refuses_pinned_kube_config_path() -> None:
    """Defensive rule: if a future processor surfaces this field, refuse
    rather than silently override."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          k8sattributes:
            auth_type: kubeConfig
            kube_config_path: /etc/k8s/config
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src)
    assert any(i.id == "C-002" for i in issues)
    assert has_refusal(issues) is True


# ---------------------------------------------------------------------------
# Pass-through: clean YAML returns no issues
# ---------------------------------------------------------------------------


def test_clean_yaml_returns_no_issues() -> None:
    src = dedent(
        """
        receivers:
          otlp: {protocols: {http: {endpoint: 0.0.0.0:4318}}}
        processors:
          k8sattributes: {auth_type: serviceAccount}
          batch: {}
        exporters:
          otlphttp: {endpoint: http://example.com}
        service:
          pipelines:
            logs:
              receivers: [otlp]
              processors: [k8sattributes, batch]
              exporters: [otlphttp]
        """
    )
    issues = check_compatibility(src)
    assert issues == []
    assert has_refusal(issues) is False


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_unparseable_yaml_returns_c000_refusal() -> None:
    """Parser errors must produce a structured issue, not a 500."""
    issues = check_compatibility("this is: not: valid: yaml: at all: : :")
    assert len(issues) == 1
    assert issues[0].id == "C-000"
    assert issues[0].severity == "refuse"


def test_empty_yaml_is_acceptable() -> None:
    """Empty YAML is degenerate but parseable; no rule should fire."""
    issues = check_compatibility("")
    assert issues == []


# ---------------------------------------------------------------------------
# C-003: tail_sampling decision_wait > duration. Advisory only — the run
# still proceeds; in-flight traces may get default-policy decisions or be
# dropped at SIGTERM. Batch is intentionally NOT covered here: batch flushes
# on graceful shutdown so its window doesn't actually affect output.
# ---------------------------------------------------------------------------


def test_c003_fires_when_tail_sampling_decision_wait_exceeds_duration() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: 30s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    c003 = [i for i in issues if i.id == "C-003"]
    assert len(c003) == 1
    assert c003[0].severity == "advisory"
    assert c003[0].component == "tail_sampling"
    assert c003[0].details["window_seconds"] == 30.0
    assert c003[0].details["duration_seconds"] == 5
    # 30s window + 1s slack = 31s, well under the 60s cap, so it fully covers.
    assert c003[0].details["recommended_duration_seconds"] == 31
    assert c003[0].details["recommended_covers_window"] is True
    assert "at least 31s" in c003[0].message
    assert has_refusal(issues) is False


def test_c003_recommended_duration_clamped_when_window_exceeds_max() -> None:
    """A decision_wait beyond the 60s run-duration ceiling can't be fully
    covered. The recommendation clamps to the cap, flags that it doesn't
    cover the window, and the message says so instead of suggesting an
    impossible duration."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: 120s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    c003 = [i for i in issues if i.id == "C-003"]
    assert len(c003) == 1
    assert c003[0].details["window_seconds"] == 120.0
    assert c003[0].details["recommended_duration_seconds"] == 60
    assert c003[0].details["recommended_covers_window"] is False
    assert "maximum run duration of 60s" in c003[0].message


def test_c003_silent_when_tail_sampling_within_duration() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: 1s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert not any(i.id == "C-003" for i in issues)


def test_c003_default_tail_sampling_decision_wait_fires() -> None:
    """tail_sampling defaults decision_wait to 30s — most users hit this."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert any(i.id == "C-003" for i in issues)


def test_c003_walks_instance_suffixed_processors() -> None:
    """`tail_sampling/critical` should be matched by the same rule."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling/critical: {decision_wait: 60s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    c003 = [i for i in issues if i.id == "C-003"]
    assert len(c003) == 1
    assert c003[0].component == "tail_sampling/critical"


def test_c003_does_not_fire_for_batch_at_all() -> None:
    """Pinned: batch flushes on graceful shutdown, so its timeout doesn't
    affect output and shouldn't trigger an advisory regardless of duration."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          batch: {timeout: 60s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert not any(i.id == "C-003" for i in issues)


def test_c003_respects_custom_duration() -> None:
    """If the user dialed duration up to 60, decision_wait=30 is fine."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: 30s}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=60)
    assert not any(i.id == "C-003" for i in issues)


def test_c003_parses_bare_numeric_window() -> None:
    """OTel accepts `decision_wait: 30` (bare number = seconds)."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: 30}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert any(i.id == "C-003" for i in issues)


def test_c003_skips_unparseable_duration() -> None:
    """Garbage value: don't guess, don't fire — let the collector reject it."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "not-a-duration"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert not any(i.id == "C-003" for i in issues)


# ---------------------------------------------------------------------------
# Compound Go durations. Pre-fix the parser only matched a single token, so
# `1m30s` / `2h15m` returned None and C-003 was silently skipped. The
# collector itself accepts compound durations, so this is a real user shape.
# ---------------------------------------------------------------------------


def test_c003_fires_for_compound_duration_minute_seconds() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "1m30s"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=30)
    c003 = [i for i in issues if i.id == "C-003"]
    assert len(c003) == 1
    assert c003[0].details["window_seconds"] == 90.0


def test_c003_fires_for_compound_duration_hours_minutes() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "2h15m"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=60)
    c003 = [i for i in issues if i.id == "C-003"]
    assert len(c003) == 1
    assert c003[0].details["window_seconds"] == 2 * 3600 + 15 * 60


def test_c003_silent_for_subsecond_window_under_duration() -> None:
    """500ms < 5s, so no advisory."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "500ms"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert not any(i.id == "C-003" for i in issues)


def test_c003_silent_for_garbage_compound_value() -> None:
    """Mid-token garbage shouldn't crash and shouldn't fire."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "1m30sjunk"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    assert not any(i.id == "C-003" for i in issues)


def test_c003_compound_with_milliseconds_tail() -> None:
    """`1s500ms` is a real Go duration (1.5s)."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          tail_sampling: {decision_wait: "1s500ms"}
        exporters: {debug: {}}
        """
    )
    issues = check_compatibility(src, duration_seconds=5)
    # 1.5s < 5s — should NOT fire.
    assert not any(i.id == "C-003" for i in issues)


def test_compatibility_issue_serializes_to_jsonable_dict() -> None:
    """Pydantic round-trip — needed because TestRun.compatibility_issues
    persists as jsonb."""
    issue = CompatibilityIssue(
        id="C-001",
        severity="refuse",
        component="kubeletstats",
        message="test",
        details={"key": "value"},
    )
    payload = issue.model_dump(mode="json")
    assert payload == {
        "id": "C-001",
        "severity": "refuse",
        "component": "kubeletstats",
        "message": "test",
        "details": {"key": "value"},
    }


def _c004(yaml_str: str):
    issues = check_compatibility(yaml_str)
    return [i for i in issues if i.id == "C-004"]


def test_c004_mixed_receiver_types_refused() -> None:
    src = """
receivers:
  filelog:
    include: [/var/log/a.log]
  otlp:
    protocols: {http: {}}
service:
  pipelines:
    logs:
      receivers: [filelog, otlp]
      exporters: [debug]
"""
    hits = _c004(src)
    assert hits and hits[0].severity == "refuse"


def test_c004_multiple_filelog_refused() -> None:
    src = """
receivers:
  filelog/a: {include: [/a.log]}
  filelog/b: {include: [/b.log]}
service:
  pipelines:
    logs: {receivers: [filelog/a, filelog/b], exporters: [debug]}
"""
    assert _c004(src)


def test_c004_filelog_in_non_logs_pipeline_refused() -> None:
    # filelog placed inside a metrics pipeline is a malformed config —
    # filelog can't emit metrics. Refuse so otelcol doesn't fail with a
    # cryptic startup error.
    src = """
receivers:
  filelog: {include: [/a.log]}
service:
  pipelines:
    metrics: {receivers: [filelog], exporters: [debug]}
"""
    assert [i for i in check_compatibility(src, signal_type="metrics") if i.id == "C-004"]


def test_c004_disallowed_operator_refused() -> None:
    src = """
receivers:
  filelog:
    include: [/a.log]
    operators:
      - type: totally_unknown_operator
service:
  pipelines:
    logs: {receivers: [filelog], exporters: [debug]}
"""
    hits = _c004(src)
    assert hits and "totally_unknown_operator" in hits[0].message


def test_c004_disallowed_operator_in_header_metadata_operators_refused() -> None:
    """The header.metadata_operators chain is also subject to the allowlist
    — synthesize_filelog copies `header` through verbatim, so a smuggled
    non-allowlisted operator inside it would otherwise execute. Refusal
    message must include the chain location so the user can find it."""
    src = """
receivers:
  filelog:
    include: [/a.log]
    operators:
      - type: regex_parser
        regex: '(?P<x>.*)'
    header:
      pattern: '^#'
      metadata_operators:
        - type: totally_unknown_operator
service:
  pipelines:
    logs: {receivers: [filelog], exporters: [debug]}
"""
    hits = _c004(src)
    assert hits, "header.metadata_operators bypass must be refused"
    assert "totally_unknown_operator" in hits[0].message
    assert "header.metadata_operators" in hits[0].message


def test_c004_clean_single_filelog_logs_passes() -> None:
    src = """
receivers:
  filelog:
    include: [/a.log]
    operators:
      - type: regex_parser
        regex: '(?P<x>.*)'
service:
  pipelines:
    logs: {receivers: [filelog], exporters: [debug]}
"""
    assert not _c004(src)


# --- regression: real-world full-collector config (otlp for traces+metrics
# + filelog for logs) must NOT be refused when running a logs-signal test.
def test_c004_full_collector_otlp_plus_filelog_logs_test_passes() -> None:
    src = """
receivers:
  otlp:
    protocols: {grpc: {endpoint: '0.0.0.0:4317'}, http: {endpoint: '0.0.0.0:4318'}}
  filelog:
    include: [/var/log/*.log]
    operators:
      - type: add
        field: attributes.new_field
        value: test
processors:
  batch: {}
exporters:
  otlp: {endpoint: otelcol:4317}
service:
  pipelines:
    traces:  {receivers: [otlp],    processors: [batch], exporters: [otlp]}
    metrics: {receivers: [otlp],    processors: [batch], exporters: [otlp]}
    logs:    {receivers: [filelog], processors: [batch], exporters: [otlp]}
"""
    # Without signal_type the legacy default ("logs") applies — must pass.
    assert not [i for i in check_compatibility(src) if i.id == "C-004"]
    # With explicit signal_type="logs" — same, must pass.
    assert not [i for i in check_compatibility(src, signal_type="logs") if i.id == "C-004"]


def test_c004_filelog_mixed_with_otlp_in_logs_pipeline_refused() -> None:
    # In contrast, if the LOGS pipeline itself mixes filelog with otlp,
    # the test would actually have to handle two receiver types — refuse.
    src = """
receivers:
  otlp: {protocols: {http: {}}}
  filelog: {include: [/a.log]}
service:
  pipelines:
    logs: {receivers: [filelog, otlp], exporters: [debug]}
"""
    assert [i for i in check_compatibility(src, signal_type="logs") if i.id == "C-004"]


def test_c004_traces_test_with_unused_filelog_passes() -> None:
    # User's case: full collector config, user runs a TRACES test. The
    # traces pipeline uses only otlp; filelog exists for the logs pipeline
    # but is dropped along with that pipeline by drop_non_target_pipelines.
    # No C-004 — the traces pipeline takes the OTLP-replay path.
    src = """
receivers:
  otlp:
    protocols: {grpc: {}, http: {}}
  filelog:
    include: [/var/log/*.log]
    operators:
      - type: add
        field: attributes.x
        value: y
service:
  pipelines:
    traces:  {receivers: [otlp],    exporters: [debug]}
    metrics: {receivers: [otlp],    exporters: [debug]}
    logs:    {receivers: [filelog], exporters: [debug]}
"""
    assert not [i for i in check_compatibility(src, signal_type="traces") if i.id == "C-004"]
    assert not [i for i in check_compatibility(src, signal_type="metrics") if i.id == "C-004"]


def test_c004_metrics_request_with_logs_only_config_no_refusal() -> None:
    # If the user requests a metrics test but the config only has a logs
    # pipeline, the metrics pipeline simply doesn't exist — the runner
    # produces no output for that signal. This isn't a C-004 concern.
    src = """
receivers:
  filelog: {include: [/a.log]}
service:
  pipelines:
    logs: {receivers: [filelog], exporters: [debug]}
"""
    assert not [i for i in check_compatibility(src, signal_type="metrics") if i.id == "C-004"]


# Two logs pipelines, each with its own filelog. What C-004 should see
# depends on whether the user picked a specific pipeline in the Run dialog
# (target_pipeline), mirroring drop_non_target_pipelines (R-005) semantics.
_TWO_LOGS_PIPELINES = """
receivers:
  filelog:   {include: [/a.log]}
  filelog/2: {include: [/b.log]}
service:
  pipelines:
    logs:               {receivers: [filelog],   exporters: [debug]}
    logs/withoutRedact: {receivers: [filelog/2], exporters: [debug]}
"""


def test_c004_target_pipeline_scopes_to_selected_pipeline() -> None:
    # Issue: user selected `logs/withoutRedact` in the Run dialog; the
    # sandbox drops the sibling `logs` pipeline (R-005), so only one
    # filelog will actually run. C-004 must judge the same narrowed view.
    issues = check_compatibility(
        _TWO_LOGS_PIPELINES,
        signal_type="logs",
        target_pipeline="logs/withoutRedact",
    )
    assert not [i for i in issues if i.id == "C-004"]


def test_c004_without_target_pipeline_still_unions_same_signal() -> None:
    # No pipeline selection (saved test definitions, suite play-all):
    # legacy signal-type union applies and two filelogs are refused.
    issues = check_compatibility(_TWO_LOGS_PIPELINES, signal_type="logs")
    assert [i for i in issues if i.id == "C-004" and i.severity == "refuse"]


def test_c004_stale_target_pipeline_falls_back_to_signal_filter() -> None:
    # target_pipeline names a pipeline missing from the config (stale
    # selection): fall back to the signal filter, same as R-005 does.
    issues = check_compatibility(
        _TWO_LOGS_PIPELINES,
        signal_type="logs",
        target_pipeline="logs/deleted",
    )
    assert [i for i in issues if i.id == "C-004" and i.severity == "refuse"]


def test_c004_target_pipeline_scopes_mixed_receiver_check() -> None:
    # The mixed-receiver-type refusal must also respect the selection:
    # the otlp+filelog mix lives in the sibling pipeline, not the target.
    src = """
receivers:
  filelog:   {include: [/a.log]}
  filelog/2: {include: [/b.log]}
  otlp:      {protocols: {http: {}}}
service:
  pipelines:
    logs:       {receivers: [filelog, otlp], exporters: [debug]}
    logs/clean: {receivers: [filelog/2],     exporters: [debug]}
"""
    issues = check_compatibility(
        src, signal_type="logs", target_pipeline="logs/clean"
    )
    assert not [i for i in issues if i.id == "C-004"]


# ---------------------------------------------------------------------------
# D14a Task 4's fixes
# ---------------------------------------------------------------------------

import pytest  # noqa: E402

from app.compatibility import check_compatibility_doc, configuration_shape_problem, parse  # noqa: E402


@pytest.mark.parametrize("value", ["5", "kube_config_path: in a string", "[kube_config_path]", "true", "~"])
def test_c002_skips_a_processor_that_is_not_a_mapping(value: str) -> None:
    """Testing `"kube_config_path" in cfg` on any value would raise on an
    integer (the run failing with a 500) and match a string as a substring
    (a refusal for nothing). Only a mapping can set the field."""
    src = f"processors:\n  k8sattributes: {value}\n"

    issues = check_compatibility(src)

    assert not [i for i in issues if i.id == "C-002"]


def test_c002_still_refuses_a_mapping_that_pins_the_path() -> None:
    issues = check_compatibility("processors:\n  k8sattributes/x: {kube_config_path: /k}\n  batch: 5\n")

    assert [(i.id, i.component) for i in issues] == [("C-002", "k8sattributes/x")]


def test_c000_names_the_problem_and_line_but_never_quotes_the_text() -> None:
    issues = check_compatibility("processors:\n  batch: {}\n  batch: {secret-looking: value-1234}\n")

    [c000] = issues
    assert c000.message == "could not parse YAML: found a duplicate key (line 3)"
    assert c000.details == {"error_type": "DuplicateKeyError"}
    assert "value-1234" not in c000.message and "batch" not in c000.message


@pytest.mark.parametrize(
    ("src", "problem"),
    [
        ("- a\n- b\n", "the configuration must be a mapping at the top level"),
        ("just a string\n", "the configuration must be a mapping at the top level"),
        ("receivers: [otlp]\n", "`receivers` must be a mapping of component names"),
        ("processors: 5\n", "`processors` must be a mapping of component names"),
        ("exporters:\n  1: {}\n", "every name in `exporters` must be a string"),
        ("service: [pipelines]\n", "`service` must be a mapping"),
        ("service:\n  pipelines: [logs]\n", "`service.pipelines` must be a mapping of pipeline names"),
        ("service:\n  pipelines:\n    7: {}\n", "every pipeline's name must be a string"),
        ("service:\n  pipelines:\n    logs: just text\n", "pipeline `logs` must be a mapping"),
        ("service:\n  pipelines:\n    logs: {receivers: otlp}\n", "pipeline `logs`'s `receivers` must be a list of names"),
        ("service:\n  pipelines:\n    logs: {exporters: [1]}\n", "pipeline `logs`'s `exporters` must be a list of names"),
    ],
)
def test_a_text_not_shaped_as_a_collector_configuration_is_c000(src: str, problem: str) -> None:
    """Such a text would make the rules and mutations raise; it is refused
    with a message naming the field (never its value)."""
    assert configuration_shape_problem(parse(src)) == problem

    [c000] = check_compatibility(src)

    assert (c000.id, c000.severity, c000.component) == ("C-000", "refuse", "<yaml>")
    assert c000.message == f"could not parse YAML: {problem}"
    assert c000.details == {"error_type": "ShapeError"}


@pytest.mark.parametrize(
    "src",
    [
        "",
        "receivers:\nprocessors:\nservice:\n",
        "service:\n  pipelines:\n    logs:\n",
        "service:\n  pipelines:\n    logs: {receivers: , processors: [], exporters: [debug]}\n",
    ],
)
def test_empty_sections_and_pipelines_are_shaped_well(src: str) -> None:
    assert configuration_shape_problem(parse(src)) is None
    assert check_compatibility_doc(parse(src), signal_type="logs", target_pipeline="logs") == []
