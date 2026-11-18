"""The seeded flows against their collectors (D12 decisions 4 and 15,
Preflight rulings 2 and 20, Ruling 37; marked `binary`, run inside the
image with `pytest -m binary`).

`fixtures/seeded-flows.json` holds each of the 13 seeded flows' slug, pin
and YAML, from migration 1700000000026's `seededFlows`. The db workspace
writes it (`npm run fixture:seeded-flows --workspace @telflo/db`,
telflo-core/packages/db/src/seeded-flows-fixture.ts) and its suite fails
when it is stale. Each flow must pass the service's check on its checked
version (below) with no error, its requirements exactly the ones listed
below (Ruling 2: every one an unset `${env:…}` but
kubernetes-telemetry-stack's in-cluster one), each asserted in the
service's and the collector's words (category, title, componentPath), so
an upstream change is noticed.

Each flow is checked on the version a copy of it gets (D12 Ruling 37):
its pin while the catalogue offers it, else the distribution's default,
the rule "Use this flow" follows (the web's `flowCopyPin`, decision 16).
So retiring a seeded pin moves its flow's check to the default, as it
moves the copies, and nothing here needs editing; the fixture still holds
the old pin, which must stay a version of the catalogue (offered or
deprecated: the catalogue never deletes one). A version the image was
built to hold but doesn't fails rather than skips (binary_support's rule,
D13b ruling 53), and every checked version is an offered one, so a flow
is never skipped because its pin was retired.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.catalog import VersionState
from tests.binary_support import CATALOG, DISTRIBUTION, OFFERED, _default_version, check

pytestmark = pytest.mark.binary

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "seeded-flows.json").read_text(encoding="utf-8"))
FLOWS = FIXTURE["flows"]


def env(name: str) -> tuple[str, str, None]:
    """An unset `${env:NAME}` requirement, as the service words it."""
    return ("env_var", f"Set environment variable {name}", None)


# Each seeded flow's requirements on its checked version, in the order the
# check lists them (Preflight ruling 2: the preflight's run of this branch's
# image, the same on 0.159.0 and 0.162.0).
EXPECTED_REQUIREMENTS: dict[str, list[tuple[str, str, str | None]]] = {
    "log-volume-cost-control": [env("OTLP_LOGS_ENDPOINT")],
    "kubernetes-telemetry-stack": [
        env("OTLP_ENDPOINT"),
        ("k8s_in_cluster", "Runs inside a Kubernetes cluster", "receivers::kubeletstats"),
    ],
    "tail-sampling-keep-errors": [env("TRACES_BACKEND_ENDPOINT"), env("PROM_REMOTE_WRITE_URL")],
    "metric-cardinality-firewall": [env("PROMETHEUS_REMOTE_WRITE_ENDPOINT"), env("CLUSTER_NAME")],
    "host-fleet-monitoring": [env("DEPLOY_ENV"), env("OTLP_ENDPOINT")],
    "dual-ship-migration-bridge": [env("DD_API_KEY"), env("NEW_BACKEND_OTLP_ENDPOINT"), env("NEW_BACKEND_TOKEN")],
    "pii-redaction-gateway": [env("OTLP_BACKEND_ENDPOINT")],
    "outage-proof-pipeline": [env("BACKEND_OTLP_ENDPOINT"), env("BACKEND_API_KEY")],
    "otel-to-clickstack": [
        env("CLICKHOUSE_DATABASE"),
        env("CLICKHOUSE_ENDPOINT"),
        env("CLICKHOUSE_PASSWORD"),
        env("CLICKHOUSE_USER"),
    ],
    "llm-telemetry-gateway": [env("LANGFUSE_BASIC_AUTH"), env("APM_OTLP_ENDPOINT")],
    "datadog-to-elastic-migration-bridge": [
        env("DD_API_KEY"),
        env("DD_SITE"),
        env("ELASTIC_OTLP_ENDPOINT"),
        env("ELASTIC_API_KEY"),
    ],
    "datadog-to-clickstack-migration-bridge": [
        env("DD_API_KEY"),
        env("DD_SITE"),
        env("CLICKHOUSE_ENDPOINT"),
        env("CLICKHOUSE_DATABASE"),
        env("CLICKHOUSE_USER"),
        env("CLICKHOUSE_PASSWORD"),
    ],
    "clickhouse-failover-gateway-s3-overflow": [
        env("CLICKHOUSE_ENDPOINT"),
        env("CLICKHOUSE_DATABASE"),
        env("CLICKHOUSE_USER"),
        env("CLICKHOUSE_PASSWORD"),
        env("AWS_REGION"),
        env("OVERFLOW_S3_BUCKET"),
    ],
}


def test_the_fixture_holds_every_listed_flow_once() -> None:
    slugs = [flow["slug"] for flow in FLOWS]
    assert len(slugs) == 13
    assert sorted(slugs) == sorted(EXPECTED_REQUIREMENTS)


def checked_version(flow: dict) -> str:
    """The version `flow` is checked on (Ruling 37): its pin while the
    catalogue offers it, else the distribution's default, where a copy of
    it is created (decision 16)."""
    pin = flow["collectorVersion"]
    return pin if pin in OFFERED else _default_version()


def test_every_pin_is_a_catalogue_version_and_every_checked_version_is_offered() -> None:
    """A pin is the catalogue's, offered or deprecated (one it never listed is
    a broken seed, not a retirement); the version checked is offered, so the
    image holds it and nothing is skipped for a retired pin."""
    for flow in FLOWS:
        assert flow["collectorDistribution"] == DISTRIBUTION, flow["slug"]
        state = CATALOG.state(DISTRIBUTION, flow["collectorVersion"])
        assert state in (VersionState.OFFERED, VersionState.RETIRED), flow["slug"]
        assert checked_version(flow) in OFFERED, flow["slug"]


PARAMS = [pytest.param(flow, id=f"{flow['slug']}-{checked_version(flow)}") for flow in FLOWS]


@pytest.mark.parametrize("flow", PARAMS)
async def test_a_seeded_flow_passes_the_collector_a_copy_of_it_gets(flow: dict) -> None:
    result = await check(checked_version(flow), flow["yaml"])

    assert result.errors == []
    assert result.valid is True
    requirements = [
        (requirement["category"], requirement["title"], requirement["componentPath"])
        for requirement in result.requirements
    ]
    assert requirements == EXPECTED_REQUIREMENTS[flow["slug"]]
