"""The palette's defaults against every offered collector (D13b decision 9,
Preflight rulings 3 and 22; marked `binary`, run inside the image with
`pytest -m binary`).

`fixtures/palette-defaults.json` holds what a drop of each palette entry
writes, spelled as each offered version's pin knows it, in the smallest
configuration around it. The web writes it (`npm run fixture:palette-defaults
--workspace @telflo/web`, telflo-core/apps/web/scripts/palette-defaults.ts)
and its suite fails when it is stale. Each text must pass the service's check
on every version it is for (requirements allowed), but for the refusals the
owner accepted (Preflight ruling 3: the palette is left as it is), each
asserted with the collector's answer, so an upstream change is noticed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.binary_support import DISTRIBUTION, OFFERED, check, version_key

pytestmark = pytest.mark.binary

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "palette-defaults.json").read_text())
CASES = FIXTURE["cases"]

# The owner's accepted refusals (Preflight ruling 3): palette id -> (why, the
# collector's answer on every offered version).
EXPECTED_REFUSALS: dict[str, tuple[str, list[dict]]] = {
    "memory-limiter-extension": (
        "Contrib has no memory_limiter extension (the processor is the component); the entry's help says so.",
        [
            {
                "message": 'unknown type: "memory_limiter" for id: "memory_limiter"',
                "componentPath": "extensions::memory_limiter",
            }
        ],
    ),
    "routing-connector": (
        "Its table is empty until its routes are chosen on the canvas.",
        [{"message": "invalid routing table: the routing table is empty", "componentPath": "connectors::routing"}],
    ),
    "failover-connector": (
        "Its priority levels are empty until its pipelines are chosen on the canvas.",
        [{"message": "No pipelines are defined in the priority list", "componentPath": "connectors::failover"}],
    ),
}


def test_the_fixture_is_for_the_offered_versions() -> None:
    """The fixture's versions are the catalogue's offered ones (the web's
    test checks it against the catalogue too: a stale fixture is refreshed
    there)."""
    for case in CASES:
        assert case["distribution"] == DISTRIBUTION
    versions = sorted({version for case in CASES for version in case["versions"]}, key=version_key)
    assert versions == sorted(OFFERED, key=version_key)


def test_every_expected_refusal_is_a_palette_entry() -> None:
    assert set(EXPECTED_REFUSALS) <= {case["paletteId"] for case in CASES}


PARAMS = [
    pytest.param(case, version, id=f"{case['paletteId']}-{case['type']}-{version}")
    for case in CASES
    for version in case["versions"]
]


@pytest.mark.parametrize(("case", "version"), PARAMS)
async def test_a_palette_default_passes_its_collector(case: dict, version: str) -> None:
    result = await check(version, case["yaml"])

    if case["paletteId"] in EXPECTED_REFUSALS:
        _why, errors = EXPECTED_REFUSALS[case["paletteId"]]
        assert result.valid is False
        assert result.errors == errors
    else:
        assert result.errors == [], case["yaml"]
        assert result.valid is True
