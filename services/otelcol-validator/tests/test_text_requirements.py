"""What `validate` passes but the collector refuses at start, read from the
text: TLS files, the file exporter's directory and the cluster's API become
requirements; a tail_sampling OTTL policy with no conditions is an error.
Nothing is opened."""

from __future__ import annotations

import pytest

from app.requirements import text_errors, text_requirements


def _titles(text: str) -> list[tuple[str, str, str | None]]:
    return [(r["category"], r["title"], r["componentPath"]) for r in text_requirements(text)]


def test_tls_files_under_any_tls_are_requirements() -> None:
    text = """
receivers:
  otlp:
    protocols:
      grpc:
        tls:
          cert_file: /etc/otel/server.crt
          key_file: /etc/otel/server.key
          client_ca_file: /etc/otel/clients.pem
exporters:
  otlp_grpc/2:
    endpoint: collector:4317
    tls:
      ca_file: /etc/otel/ca.pem
extensions:
  health_check:
    tls:
      cert_file: /etc/otel/health.crt
"""
    assert _titles(text) == [
        ("tls_files", "Provide /etc/otel/server.crt on the host", "receivers::otlp"),
        ("tls_files", "Provide /etc/otel/server.key on the host", "receivers::otlp"),
        ("tls_files", "Provide /etc/otel/clients.pem on the host", "receivers::otlp"),
        ("tls_files", "Provide /etc/otel/ca.pem on the host", "exporters::otlp_grpc/2"),
        ("tls_files", "Provide /etc/otel/health.crt on the host", "extensions::health_check"),
    ]
    [first, *_] = text_requirements(text)
    assert first["description"] == (
        "otlp reads its TLS certificate (cert_file) from /etc/otel/server.crt when the collector starts. "
        "Validation doesn't open it; the file must exist at this path wherever the collector runs."
    )


def test_a_file_key_outside_tls_is_not_a_tls_requirement() -> None:
    text = """
receivers:
  filelog:
    include: [/var/log/*.log]
    ca_file: /not/under/tls.pem
"""
    assert _titles(text) == []


def test_the_file_exporters_directory_is_a_requirement() -> None:
    text = """
exporters:
  file:
    path: /var/log/otel/traces.json
  file/metrics:
    path: /data/metrics/out.json
  file/here:
    path: out.json
  file/dot:
    path: ./out.json
"""
    assert _titles(text) == [
        ("directory", "Directory /var/log/otel must exist", "exporters::file"),
        ("directory", "Directory /data/metrics must exist", "exporters::file/metrics"),
    ]


def test_a_relative_directory_is_quoted_and_said_to_be_relative() -> None:
    """`path: 'stat /y: no such file or directory'` (a relative path whose
    directory is `stat `) must not read `Directory stat  must exist`."""
    text = """
exporters:
  file:
    path: 'stat /y: no such file or directory'
  file/logs:
    path: logs/out.json
"""
    requirements = text_requirements(text)

    assert [r["title"] for r in requirements] == [
        'Directory "stat " must exist',
        'Directory "logs" must exist',
    ]
    assert requirements[1]["description"] == (
        "file/logs writes to logs/out.json and the collector refuses to start if \"logs\" doesn't exist "
        "in the collector's working directory. Create it where the collector runs, writable by the "
        "collector's user."
    )


@pytest.mark.parametrize(
    ("section", "component"),
    [
        ("receivers", "k8s_cluster"),
        ("receivers", "k8s_events"),
        ("receivers", "k8sobjects"),
        ("receivers", "k8s_objects"),
        ("receivers", "kubeletstats"),
        ("receivers", "kubelet_stats/node"),
        ("processors", "k8sattributes"),
        ("processors", "k8s_attributes/2"),
        ("extensions", "k8s_observer"),
    ],
)
def test_components_that_need_the_clusters_api_are_a_requirement(section: str, component: str) -> None:
    text = f"{section}:\n  {component}:\n"

    assert _titles(text) == [("k8s_in_cluster", "Runs inside a Kubernetes cluster", f"{section}::{component}")]


def test_resource_detections_k8snode_detector_needs_the_cluster() -> None:
    assert _titles("processors:\n  resourcedetection:\n    detectors: [env, k8snode]\n") == [
        ("k8s_in_cluster", "Runs inside a Kubernetes cluster", "processors::resourcedetection")
    ]
    assert _titles("processors:\n  resource_detection:\n    detectors: [env, system]\n") == []


def test_several_in_cluster_components_make_one_requirement_naming_them() -> None:
    [requirement] = text_requirements("receivers:\n  k8s_cluster:\n  k8s_events:\nprocessors:\n  k8sattributes:\n")

    assert requirement["componentPath"] == "receivers::k8s_cluster"
    assert requirement["description"].startswith("k8s_cluster, k8s_events, k8sattributes call the Kubernetes API")


def test_text_that_does_not_parse_has_no_text_requirements() -> None:
    assert text_requirements("receivers: [unclosed\n") == []
    assert text_requirements("just a string") == []
    assert text_errors("receivers: [unclosed\n") == []


# ---------------------------------------------------------------------------
# tail_sampling: an OTTL policy with no conditions
# ---------------------------------------------------------------------------


def test_an_ottl_policy_with_no_conditions_is_an_error() -> None:
    text = """
processors:
  tail_sampling/my-sampler:
    policies:
      - name: keep-errors
        type: ottl_condition
        ottl_condition:
          error_mode: ignore
          span: []
"""
    assert text_errors(text) == [
        {
            "message": 'policy "keep-errors": expected at least one OTTL condition to filter on',
            "componentPath": "processors::tail_sampling/my-sampler",
        }
    ]


def test_an_ottl_policy_with_a_condition_is_not_an_error() -> None:
    for conditions in ("span: ['attributes[\"x\"] == 1']", "spanevent: ['name == \"e\"']"):
        text = f"""
processors:
  tail_sampling:
    policies:
      - name: p
        type: ottl_condition
        ottl_condition:
          {conditions}
"""
        assert text_errors(text) == [], conditions


def test_an_ottl_sub_policy_with_no_conditions_is_an_error() -> None:
    text = """
processors:
  tail_sampling:
    policies:
      - name: both
        type: and
        and:
          and_sub_policy:
            - name: inner
              type: ottl_condition
"""
    assert [e["message"] for e in text_errors(text)] == [
        'policy "inner": expected at least one OTTL condition to filter on'
    ]


def test_other_policies_are_not_errors() -> None:
    text = """
processors:
  tail_sampling:
    policies:
      - name: p
        type: probabilistic
        probabilistic: {sampling_percentage: 10}
"""
    assert text_errors(text) == []
