"""The forward-connector validation cases (2) and the complex
configuration's (3), against every offered collector (D13b ruling 68;
marked `binary`, run inside the image with `pytest -m binary`). D9a deferred
them to D13b; decision 9's cases didn't include them.

The collector answers whether the builder's wiring bridges signals (there is
no client-side `validatePipeline`, decision 18), and the complex
configuration's text is checked with every offered version, through the
service's check and through its HTTP API.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.binary_support import BINARY_DIR, CATALOG_DIR, DISTRIBUTION, OFFERED, binary_for, check
from tests.builder_texts import COMPLEX_CONFIG, forward_scenario
from tests.conftest import auth_headers, make_settings

pytestmark = pytest.mark.binary


# ---- the forward connector ----------------------------------------------------------


@pytest.mark.parametrize("version", OFFERED)
async def test_a_forward_connector_between_pipelines_of_one_signal_is_valid(version: str) -> None:
    """Same-signal wiring: no signal-bridging error."""
    result = await check(version, forward_scenario("traces", "traces"))

    assert result.errors == []
    assert result.valid is True
    assert result.requirements == []


@pytest.mark.parametrize("version", OFFERED)
async def test_a_forward_connector_bridging_signals_is_refused_by_the_collector(version: str) -> None:
    """Cross-signal wiring (traces → logs) is refused: the
    collector refuses it as a connector with no receiver pipeline of its
    signal, naming the connector."""
    result = await check(version, forward_scenario("traces", "logs"))

    assert result.valid is False
    assert result.errors == [
        {
            "message": 'connector "forward" used as exporter in [traces/in] pipeline '
            "but not used in any supported receiver pipeline",
            "componentPath": "connectors::forward",
        }
    ]


# ---- the complex configuration ------------------------------------------------------

# What every offered collector answers about the complex configuration: valid,
# with its otlp exporter's TLS files as requirements (the text scan's).
COMPLEX_REQUIREMENTS = [
    {
        "category": "tls_files",
        "title": f"Provide {path} on the host",
        "description": f"otlp reads its TLS {what} ({key}) from {path} when the collector starts. "
        "Validation doesn't open it; the file must exist at this path wherever the collector runs.",
        "componentPath": "exporters::otlp",
    }
    for path, what, key in (
        ("/certs/client.crt", "certificate", "cert_file"),
        ("/certs/client.key", "private key", "key_file"),
        ("/certs/ca.crt", "CA certificate", "ca_file"),
    )
]


@pytest.mark.parametrize("version", OFFERED)
async def test_the_complex_config_is_valid(version: str) -> None:
    """Valid, no errors."""
    result = await check(version, COMPLEX_CONFIG)

    assert result.errors == []
    assert result.valid is True


@pytest.mark.parametrize("version", OFFERED)
async def test_the_complex_config_answers_its_tls_files_as_requirements(version: str) -> None:
    """On every version, the whole answer, its requirements included."""
    result = await check(version, COMPLEX_CONFIG)

    assert (result.valid, result.errors, result.requirements) == (True, [], COMPLEX_REQUIREMENTS)


@pytest.mark.parametrize("version", OFFERED)
def test_the_complex_configs_answer_names_its_version(version: str) -> None:
    """Through the HTTP API, the answer names the distribution and the version asked for."""
    binary_for(version)  # fails or skips as every binary test does for a version not held
    settings = make_settings(BINARY_DIR, catalog_dir=CATALOG_DIR, validate_timeout=30)
    with TestClient(create_app(settings)) as client:
        response = client.post(
            f"/validator/v1/validate/{DISTRIBUTION}/{version}", json={"yaml": COMPLEX_CONFIG}, headers=auth_headers()
        )

    assert response.status_code == 200
    body = response.json()
    assert (body["distribution"], body["version"]) == (DISTRIBUTION, version)
    assert (body["valid"], body["errors"], body["requirements"]) == (True, [], COMPLEX_REQUIREMENTS)
