"""Runs with kwok's fake cluster on the real collectors (marked `kwok`; D14a
Task 5, Preflight ruling 6's binary tests 3 and 5), on every offered version
the image holds, under `--network none`: the service starts kwok's cluster
from the image's binaries and `kwok/kwokctl.yaml` (as it does in compose),
and a run whose pipeline has `k8sattributes` reaches it through `KUBECONFIG`.

- `from: connection`: an OTLP replay from 127.0.0.1 (the seeded pod's
  address) is enriched with the pod's name, namespace, node and container.
- A filelog receiver with a `container` operator: the input is staged at the
  seeded pod's container-log path, the operator derives the pod's identity
  from it, and `k8sattributes` adds what only the cluster knows (the
  deployment and the node), associated by the pod's live uid.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.kwok import KwokState
from app.kwok_cluster import start_from_environment
from app.main import create_app
from tests.binary_support import OFFERED, image_settings, log_bodies, mutation_ids, resource_attributes, run

pytestmark = pytest.mark.kwok


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    """The service with kwok's cluster, started once for the module."""
    with TestClient(create_app(image_settings(), kwok_starter=start_from_environment)) as test_client:
        for _ in range(1_800):  # kwok starts in seconds; a hang guard of about 3 minutes
            if test_client.app.state.kwok.state is not KwokState.STARTING:
                break
            time.sleep(0.1)
        assert test_client.app.state.kwok.state is KwokState.READY
        assert test_client.get("/testing/v1/health").json() == {"status": "ok", "kwok": "ready"}
        yield test_client


FROM_CONNECTION = """\
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.pod.name
        - k8s.node.name
        - k8s.deployment.name
    pod_association:
      - sources:
          - from: connection
  batch:
    timeout: 200ms
exporters:
  otlphttp:
    endpoint: https://collector.example.invalid
service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [k8sattributes, batch]
      exporters: [otlphttp]
"""
LOG = {
    "resourceLogs": [
        {
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "checkout"}}]},
            "scopeLogs": [
                {
                    "scope": {"name": "kwok-test"},
                    "logRecords": [{"timeUnixNano": "1700000000000000000", "body": {"stringValue": "order placed"}}],
                }
            ],
        }
    ]
}


@pytest.mark.parametrize("version", OFFERED)
def test_from_connection_enriches_a_replay_from_the_seeded_pod(client: TestClient, version: str) -> None:
    answer = run(client, version, FROM_CONNECTION, json.dumps(LOG).encode())

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["kwokEnabled"] is True
    assert answer["timings"]["informerMs"] is not None
    assert "R-100" in mutation_ids(answer)
    assert "auth_type: kubeConfig" in answer["mutatedYaml"]
    [attributes] = resource_attributes(answer)
    assert attributes["service.name"] == "checkout"
    assert attributes["k8s.namespace.name"] == "demo"
    assert attributes["k8s.pod.name"] == "telflo-test-pod"
    assert attributes["k8s.node.name"] == "kwok-node-0"
    assert attributes["k8s.deployment.name"] == "telflo-test-deployment"
    assert log_bodies(answer) == ["order placed"]
    # The kubeconfig's path never reaches the answer.
    assert ".kwok" not in json.dumps(answer)


CONTAINER_OPERATOR = """\
receivers:
  filelog:
    include: [/var/log/pods/*/*/*.log]
    include_file_path: true
    operators:
      - type: container
        add_metadata_from_filepath: true
processors:
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    extract:
      metadata:
        - k8s.node.name
        - k8s.deployment.name
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.uid
exporters:
  otlphttp:
    endpoint: https://collector.example.invalid
service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [k8sattributes]
      exporters: [otlphttp]
"""
CRI_LINES = (
    b"2026-04-24T00:00:00.000000000Z stdout F order placed\n"
    b"2026-04-24T00:00:01.000000000Z stderr F payment declined\n"
)


@pytest.mark.parametrize("version", OFFERED)
def test_a_container_operator_and_k8sattributes_resolve_the_seeded_pod(client: TestClient, version: str) -> None:
    answer = run(client, version, CONTAINER_OPERATOR, CRI_LINES)

    assert answer["status"] == "succeeded", answer.get("error")
    assert answer["strategy"] == "filelog"
    assert answer["kwokEnabled"] is True
    assert sorted(log_bodies(answer)) == ["order placed", "payment declined"]
    resources = resource_attributes(answer)
    assert resources, answer["logs"]
    for attributes in resources:
        # From the file's path, by the container operator.
        assert attributes["k8s.namespace.name"] == "demo"
        assert attributes["k8s.pod.name"] == "telflo-test-pod"
        assert attributes["k8s.container.name"] == "app"
        # From the cluster, by k8sattributes, associated by the pod's live uid.
        assert attributes["k8s.node.name"] == "kwok-node-0"
        assert attributes["k8s.deployment.name"] == "telflo-test-deployment"
    assert "otelcol-run-" not in json.dumps(answer)
