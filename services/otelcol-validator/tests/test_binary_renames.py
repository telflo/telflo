"""The collector's renames against the real collectors (D13b decision 6,
Preflight ruling 5; marked `binary`, deselected by default, run inside the
image with `pytest -m binary`).

For every offered version whose `otelcol-contrib` is under
OTELCOL_BINARY_DIR, and every rename the catalogue's `renamedTypes` lists
(read from the catalogue itself, never a copy): the current name passes from
`since` on and fails as an unknown type before it (only where an offered
version predates `since`: today the aws_s3 receiver on 0.159.0-0.161.0); the
old name passes on every offered version. Each text is the smallest one the
preflight found the collector accepts for that component.

A rename the catalogue gains needs its configuration below
(`test_every_rename_has_a_configuration` says which), and its `since`
checked: catalog/README.md, "Adding a collector version".
"""

from __future__ import annotations

import json

import pytest

from tests.binary_support import CATALOG_DIR, DISTRIBUTION, OFFERED, check, version_key

pytestmark = pytest.mark.binary


def _renamed_types() -> list[dict]:
    """Contrib's `renamedTypes`, as its catalogue file lists them."""
    for path in sorted(CATALOG_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("distribution") == DISTRIBUTION:
            return list(document["renamedTypes"])
    raise AssertionError(f"{CATALOG_DIR} has no {DISTRIBUTION} file")


RENAMES = _renamed_types()

# (kind, deprecated name) -> (the pipeline's signal, the component's body):
# Preflight A's minimal configurations (kubeletstats needs `auth_type: none`
# outside a cluster; aws_s3 needs a time range and a bucket).
CONFIGURATIONS: dict[tuple[str, str], tuple[str, str]] = {
    ("receiver", "filelog"): ("logs", "include: [/tmp/x.log]"),
    ("receiver", "fluentforward"): ("logs", "endpoint: 0.0.0.0:8006"),
    ("receiver", "k8sobjects"): ("logs", "objects:\n      - name: pods\n        mode: pull"),
    ("receiver", "kubeletstats"): ("metrics", "auth_type: none"),
    ("receiver", "hostmetrics"): ("metrics", "scrapers:\n      cpu: {}"),
    (
        "receiver",
        "awss3",
    ): (
        "traces",
        'starttime: "2024-01-01 00:00"\n    endtime: "2024-01-02 00:00"\n'
        "    s3downloader:\n      s3_bucket: b\n      region: us-east-1",
    ),
    ("processor", "k8sattributes"): ("traces", "{}"),
    ("processor", "resourcedetection"): ("traces", "detectors: [env]"),
    ("processor", "logdedup"): ("logs", "{}"),
    (
        "processor",
        "metricstransform",
    ): ("metrics", "transforms:\n      - include: a\n        action: update\n        new_name: b"),
    ("processor", "cumulativetodelta"): ("metrics", "{}"),
    (
        "exporter",
        "loadbalancing",
    ): ("traces", "protocol:\n      otlp: {}\n    resolver:\n      static:\n        hostnames: [a:4317]"),
    ("exporter", "otlp"): ("traces", "endpoint: localhost:4317"),
    ("exporter", "otlphttp"): ("traces", "endpoint: http://localhost:4318"),
    ("exporter", "prometheusremotewrite"): ("metrics", "endpoint: http://localhost:9090/api/v1/write"),
    ("connector", "spanmetrics"): ("traces", "{}"),
}

OTLP_RECEIVER = "receivers:\n  otlp:\n    protocols:\n      grpc:\n"


def configuration(kind: str, name: str, signal: str, body: str) -> str:
    """The smallest configuration holding a `kind` component of type `name`
    (preflight A's renames.py, unchanged)."""
    component = " {}" if body == "{}" else "\n    " + body
    if kind == "receiver":
        return (
            f"receivers:\n  {name}:{component}\nexporters:\n  debug:\nservice:\n  pipelines:\n"
            f"    {signal}:\n      receivers: [{name}]\n      exporters: [debug]\n"
        )
    if kind == "processor":
        return (
            f"{OTLP_RECEIVER}processors:\n  {name}:{component}\nexporters:\n  debug:\nservice:\n  pipelines:\n"
            f"    {signal}:\n      receivers: [otlp]\n      processors: [{name}]\n      exporters: [debug]\n"
        )
    if kind == "exporter":
        return (
            f"{OTLP_RECEIVER}exporters:\n  {name}:{component}\nservice:\n  pipelines:\n"
            f"    {signal}:\n      receivers: [otlp]\n      exporters: [{name}]\n"
        )
    if kind == "connector":
        return (
            f"{OTLP_RECEIVER}connectors:\n  {name}:{component}\nexporters:\n  debug:\nservice:\n  pipelines:\n"
            f"    traces:\n      receivers: [otlp]\n      exporters: [{name}]\n"
            f"    metrics:\n      receivers: [{name}]\n      exporters: [debug]\n"
        )
    raise AssertionError(f"no configuration for a {kind}")


_check = check


def _text(rename: dict, name: str) -> str:
    signal, body = CONFIGURATIONS[(rename["kind"], rename["deprecatedName"])]
    return configuration(rename["kind"], name, signal, body)


def test_the_catalogue_lists_renames_and_offers_versions() -> None:
    assert RENAMES, CATALOG_DIR
    assert OFFERED, CATALOG_DIR


def test_every_rename_has_a_configuration() -> None:
    missing = [
        f"{rename['kind']} {rename['deprecatedName']}"
        for rename in RENAMES
        if (rename["kind"], rename["deprecatedName"]) not in CONFIGURATIONS
    ]
    assert missing == [], f"add a minimal configuration to CONFIGURATIONS for: {', '.join(missing)}"


CASES = [
    pytest.param(version, rename, id=f"{version}-{rename['kind']}-{rename['name']}")
    for version in OFFERED
    for rename in RENAMES
]


@pytest.mark.parametrize(("version", "rename"), CASES)
async def test_the_current_name_passes_from_since_and_is_unknown_before(version: str, rename: dict) -> None:
    result = await _check(version, _text(rename, rename["name"]))

    if version_key(version) >= version_key(rename["since"]):
        assert result.errors == []
        assert result.valid is True
    else:
        section = f"{rename['kind']}s"
        assert result.valid is False
        assert result.errors == [
            {
                "message": f'unknown type: "{rename["name"]}" for id: "{rename["name"]}"',
                "componentPath": f"{section}::{rename['name']}",
            }
        ]


@pytest.mark.parametrize(("version", "rename"), CASES)
async def test_the_deprecated_name_passes_on_every_offered_version(version: str, rename: dict) -> None:
    result = await _check(version, _text(rename, rename["deprecatedName"]))

    assert result.errors == []
    assert result.valid is True
