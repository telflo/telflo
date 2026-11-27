"""The seeded flows against their collectors (marked `binary`, run inside
the image with `pytest -m binary`).

`fixtures/seeded-flows.json` holds each of the 20 seeded flows' slug, pin
and YAML, from the `seededFlows` of migrations 1700000000026,
1700000000045 and 1700000000046. The db workspace
writes it (`npm run fixture:seeded-flows --workspace @telflo/db`,
telflo-core/packages/db/src/seeded-flows-fixture.ts) and its suite fails
when it is stale. Each flow must pass the service's check on its checked
version (below) with no error, its requirements exactly the ones listed
below (every one an unset `${env:…}` but kubernetes-telemetry-stack's
in-cluster one), each asserted in the service's and the collector's words
(category, title, componentPath), so an upstream change is noticed.

Two flows are published with one known error each, listed below
(EXPECTED_ERRORS): the check fills an unset `${env:…}` with a string
placeholder, which ship-otel-data-to-kafka's SASL `mechanism` (one of a
fixed set) and ship-otel-data-to-s3's `s3_force_path_style` (a bool)
refuse. Once the variables are set the collector takes them; a copy shows
the error until then.

Each flow is checked on the version a copy of it gets: its pin while the
catalog offers it, else the distribution's default, the rule "Use this
flow" follows (the web's `flowCopyPin`).
So retiring a seeded pin moves its flow's check to the default, as it
moves the copies, and nothing here needs editing; the fixture still holds
the old pin, which must stay a version of the catalog (offered or
deprecated: the catalog never deletes one). A version the image was
built to hold but doesn't fails rather than skips (binary_support's
rule), and every checked version is an offered one, so a flow
is never skipped because its pin was retired.
"""

from __future__ import annotations

import json
import re
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
# check lists them (recorded from a run of the image, the same on 0.159.0
# and 0.162.0).
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
    "monitor-supabase": [
        env("SUPABASE_SECRET_KEY"),
        env("SUPABASE_HOST"),
        env("SUPABASE_PROJECT_REF"),
        env("OTLP_ENDPOINT"),
        env("OTLP_AUTH_HEADER"),
        env("SUPABASE_DRAIN_TOKEN"),
    ],
    "ship-otel-data-to-greptimedb": [
        env("DEPLOYMENT_ENVIRONMENT"),
        env("GREPTIMEDB_ENDPOINT"),
        env("GREPTIMEDB_DATABASE"),
        env("GREPTIMEDB_USERNAME"),
        env("GREPTIMEDB_PASSWORD"),
    ],
    "otel-to-serenedb": [
        env("SERENEDB_OTLP_ENDPOINT"),
        env("OTLP_ENDPOINT"),
        env("OTLP_AUTH_HEADER"),
        env("SERENEDB_USERNAME"),
        env("SERENEDB_PASSWORD"),
    ],
    "ship-otel-data-to-gigapipe": [env("GIGAPIPE_ENDPOINT"), env("GIGAPIPE_USERNAME"), env("GIGAPIPE_PASSWORD")],
    "ship-otel-data-to-loki": [env("LOKI_OTLP_ENDPOINT"), env("LOKI_TENANT_ID")],
    "ship-otel-data-to-kafka": [
        env("KAFKA_BROKERS"),
        env("KAFKA_SASL_MECHANISM"),
        env("KAFKA_USERNAME"),
        env("KAFKA_PASSWORD"),
    ],
    "ship-otel-data-to-s3": [env("S3_REGION"), env("S3_BUCKET"), env("S3_ENDPOINT"), env("S3_FORCE_PATH_STYLE")],
}

# The flows the check answers with one error, a placeholder's: the
# componentPaths it may name and its message, as a pattern. Kafka's list of
# mechanisms grows between versions (0.162.0 adds OAUTHBEARER), so the
# pattern takes any list; S3's error names whichever of its three exporters
# the collector decodes first, which varies from run to run.
EXPECTED_ERRORS: dict[str, tuple[frozenset[str], re.Pattern[str]]] = {
    "ship-otel-data-to-kafka": (
        frozenset({"exporters::kafka::clientconfig::auth::sasl"}),
        re.compile(r"mechanism should be one of 'PLAIN', .*\. configured value otelvalidatorplaceholder0+"),
    ),
    "ship-otel-data-to-s3": (
        frozenset({f"exporters::awss3/{signal}" for signal in ("logs", "metrics", "traces")}),
        re.compile(r"'s3uploader\.s3_force_path_style' expected type 'bool', got unconvertible type 'string'"),
    ),
}


def test_the_fixture_holds_every_listed_flow_once() -> None:
    slugs = [flow["slug"] for flow in FLOWS]
    assert len(slugs) == 20
    assert sorted(slugs) == sorted(EXPECTED_REQUIREMENTS)
    assert set(EXPECTED_ERRORS) <= set(slugs)


def checked_version(flow: dict) -> str:
    """The version `flow` is checked on: its pin while the catalog offers
    it, else the distribution's default, where a copy of it is created."""
    pin = flow["collectorVersion"]
    return pin if pin in OFFERED else _default_version()


def test_every_pin_is_a_catalogue_version_and_every_checked_version_is_offered() -> None:
    """A pin is the catalog's, offered or deprecated (one it never listed is
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

    if flow["slug"] in EXPECTED_ERRORS:
        paths, message = EXPECTED_ERRORS[flow["slug"]]
        assert result.valid is False
        assert [error["componentPath"] in paths for error in result.errors] == [True]
        assert message.fullmatch(result.errors[0]["message"]), result.errors[0]["message"]
    else:
        assert result.errors == []
        assert result.valid is True
    requirements = [
        (requirement["category"], requirement["title"], requirement["componentPath"])
        for requirement in result.requirements
    ]
    assert requirements == EXPECTED_REQUIREMENTS[flow["slug"]]
