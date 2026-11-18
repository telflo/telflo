"""The routing and failover cases against every offered collector (D13b
decision 9, Preflight ruling 8; marked `binary`, run inside the image with
`pytest -m binary`).

The collector answers these 11 (there is no client-side `validatePipeline`,
decision 18). Each text
is the preflight's (an otlp receiver into the connector's pipeline, its
targets each a pipeline to debug).
"""

from __future__ import annotations

import re

import pytest
import yaml

from tests.binary_support import OFFERED, check, errors_match

pytestmark = pytest.mark.binary


def configuration(name: str, body: dict, signal: str, targets: list[str], incoming: bool = True) -> str:
    """The connector `name` fed by a `signal` pipeline (unless not
    `incoming`), each of `targets` a pipeline it feeds into debug."""
    pipelines = {signal: {"receivers": ["otlp"], "exporters": [name] if incoming else ["debug"]}}
    for target in targets:
        pipelines[target] = {"receivers": [name], "exporters": ["debug"]}
    return yaml.safe_dump(
        {
            "receivers": {"otlp": {"protocols": {"grpc": {"endpoint": "localhost:4317"}}}},
            "exporters": {"debug": {}},
            "connectors": {name: body},
            "service": {"pipelines": pipelines},
        },
        sort_keys=False,
    )


CONDITION = 'attributes["a"] == "b"'


def used_as(connector: str, role: str, pipelines: list[str], other: str) -> dict:
    """The collector's refusal of a connector used on one side only; the
    pipelines in its brackets in either order (Go's map order)."""
    names = "|".join(re.escape(" ".join(order)) for order in (pipelines, pipelines[::-1]))
    return {
        "message": re.compile(
            rf'connector "{connector}" used as {role} in \[(?:{names})\] pipeline '
            rf"but not used in any supported {other} pipeline"
        ),
        "componentPath": f"connectors::{connector}",
    }


# name -> (text, the collector's errors on every offered version; [] accepted)
CASES: dict[str, tuple[str, list[dict]]] = {
    "R1 a complete route, its targets in config only": (
        configuration(
            "routing",
            {
                "error_mode": "ignore",
                "default_pipelines": ["traces/a"],
                "table": [{"context": "resource", "condition": CONDITION, "pipelines": ["traces/b"]}],
            },
            "traces",
            ["traces/a", "traces/b"],
        ),
        [],
    ),
    "R2 traces in, a logs target": (
        configuration(
            "routing",
            {"table": [{"context": "resource", "condition": CONDITION, "pipelines": ["logs/a"]}]},
            "traces",
            ["logs/a"],
        ),
        [used_as("routing", "exporter", ["traces"], "receiver")],
    ),
    "R3 a route to a pipeline that doesn't exist": (
        configuration(
            "routing",
            {
                "error_mode": "ignore",
                "table": [{"context": "resource", "condition": CONDITION, "pipelines": ["traces/nope"]}],
            },
            "traces",
            ["traces/a"],
        ),
        [{"message": 'pipeline not found: missing consumer: "traces/nope"', "componentPath": None}],
    ),
    "R4 an empty routing table": (
        configuration("routing", {"error_mode": "ignore", "table": []}, "traces", ["traces/a"]),
        [{"message": "invalid routing table: the routing table is empty", "componentPath": "connectors::routing"}],
    ),
    "R5 a route with a condition and a statement, and no pipelines": (
        configuration(
            "routing",
            {"table": [{"condition": CONDITION, "statement": f"route() where {CONDITION}", "pipelines": []}]},
            "traces",
            ["traces/a"],
        ),
        [{"message": "invalid route: both condition and statement provided", "componentPath": "connectors::routing"}],
    ),
    "F1 two levels, same signal": (
        configuration(
            "failover",
            {"priority_levels": [["traces/primary"], ["traces/secondary"]]},
            "traces",
            ["traces/primary", "traces/secondary"],
        ),
        [],
    ),
    "F2 no priority levels": (
        configuration("failover", {"priority_levels": []}, "traces", ["traces/primary"]),
        [{"message": "No pipelines are defined in the priority list", "componentPath": "connectors::failover"}],
    ),
    "F3 an empty level and a target that doesn't exist": (
        configuration(
            "failover",
            {"priority_levels": [["traces/primary"], [], ["traces/ghost"]]},
            "traces",
            ["traces/primary", "traces/secondary"],
        ),
        [{"message": "Error registering consumer", "componentPath": None}],
    ),
    "F4 one pipeline at two levels": (
        configuration("failover", {"priority_levels": [["traces/primary"], ["traces/primary"]]}, "traces", ["traces/primary"]),
        [],
    ),
    "F5 traces in, metrics targets": (
        configuration(
            "failover",
            {"priority_levels": [["metrics/primary"], ["metrics/secondary"]]},
            "traces",
            ["metrics/primary", "metrics/secondary"],
        ),
        [used_as("failover", "exporter", ["traces"], "receiver")],
    ),
    "F6 no incoming edge (an exporter nowhere)": (
        configuration(
            "failover",
            {"priority_levels": [["traces/primary"], ["traces/secondary"]]},
            "traces",
            ["traces/primary", "traces/secondary"],
            incoming=False,
        ),
        [used_as("failover", "receiver", ["traces/primary", "traces/secondary"], "exporter")],
    ),
}


def test_telflo_apps_eleven_cases_are_here() -> None:
    assert len(CASES) == 11


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("version", OFFERED)
async def test_the_collector_answers_a_routing_or_failover_case(version: str, name: str) -> None:
    text, errors = CASES[name]

    result = await check(version, text)

    assert errors_match(result.errors, errors), result.errors
    assert result.valid is (errors == [])
