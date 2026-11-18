"""In-cluster requirement phrasings (7), never filed as `k8s_in_cluster`
requirements by a phrase found anywhere in a line.

D13b ruling 34 classifies with templates, each taken from an output the
collector really printed and matched against a whole cause: none of these phrasings
has a recorded output yet (the image's placeholder CA and blocked apiserver
are Linux, in-image cases; Task 7 records them and may add templates), so
each is an error for now.
"""
from __future__ import annotations

import pytest

from app.stderr import classify_cause, parse_stderr

# The phrasings: (line, component path).
IN_CLUSTER_LINES = [
    # x509 unknown authority (the image's self-signed placeholder CA).
    (
        'failed to fetch namespaces: Get "https://kubernetes.default.svc:443/'
        'api/v1/namespaces?timeout=10s": tls: failed to verify certificate: '
        "x509: certificate signed by unknown authority",
        "processors::k8sattributes",
    ),
    # client-go's shorter phrasing.
    ("failed to list pods: tls: failed to verify certificate: something specific here", None),
    # The apiserver unreachable: a timeout, a refusal, no route.
    (
        'failed to fetch namespaces: Get "https://kubernetes.default.svc:443/'
        'api/v1/namespaces?timeout=10s": dial tcp 10.96.0.1:443: i/o timeout',
        "processors::k8sattributes",
    ),
    (
        'failed to create informer: Get "https://kubernetes.default:443/api": '
        "dial tcp 10.96.0.1:443: connect: connection refused",
        None,
    ),
    ("dial https://kubernetes.default.svc:443: dial tcp 10.96.0.1:443: connect: no route to host", None),
    # A user's exporter certificate failing.
    (
        "failed to connect to honeycomb: tls: failed to verify certificate: "
        "x509: certificate signed by unknown authority",
        "exporters::otlphttp",
    ),
]


@pytest.mark.parametrize(("line", "path"), IN_CLUSTER_LINES)
def test_an_in_cluster_phrasing_with_no_recorded_output_is_an_error(line: str, path: str | None) -> None:
    assert classify_cause(line, path) is None
    parsed = parse_stderr(f"Error: {path or 'receivers::x'}: {line}\n")
    assert parsed.requirements == []
    assert len(parsed.errors) == 1


def test_user_otlp_endpoint_dial_tcp_failure_is_not_misclassified() -> None:
    """A user's OTLP exporter pointed at a private endpoint can produce a
    'dial tcp' error during validate. That's an actual config / network
    problem, not a k8s-in-cluster requirement — must fall through to
    errors[]."""
    line = (
        'failed to ping endpoint: Post "https://otel-collector.internal:4317/'
        'v1/traces": dial tcp 10.0.5.42:4317: i/o timeout'
    )
    assert classify_cause(line, "exporters::otlphttp") is None
