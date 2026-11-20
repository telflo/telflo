"""The validate route and the catalogue: a distribution or version the
catalogue doesn't list is 404, a deprecated version 409 `version_retired`, an
offered version the validator doesn't hold 503, each before the body is read.
There is no contrib-only route, no `/versions` and no `/distributions`.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.catalog import Catalog, CatalogError, VersionState, binary_path
from app.main import create_app
from app.settings import DEFAULT_CATALOG_DIR
from tests.conftest import (
    CATALOG_DIR,
    PASSING_COLLECTOR,
    VALIDATE_URL,
    auth_headers,
    call_asgi,
    make_settings,
    write_collector,
)

BODY = {"yaml": "receivers:\n  otlp:\n"}


# ---------------------------------------------------------------------------
# The catalogue (was: the manifests' loading)
# ---------------------------------------------------------------------------


def test_catalog_load_refuses_a_missing_directory(tmp_path: Path) -> None:
    """The catalogue is required: the service refuses to start without it,
    never starting knowing no version."""
    with pytest.raises(CatalogError):
        Catalog.load(tmp_path / "does-not-exist")


def test_catalog_loads_the_repository_catalogue() -> None:
    """Run from the checkout, the default directory is the repository's
    `catalog/distributions`: its offered versions are offered and a version
    it retired is retired."""
    catalog = Catalog.load(DEFAULT_CATALOG_DIR)

    assert catalog.state("otelcol-contrib", "0.162.0") is VersionState.OFFERED
    assert catalog.state("otelcol-contrib", "0.159.0") is VersionState.OFFERED
    assert catalog.state("otelcol-contrib", "0.147.0") is VersionState.RETIRED
    assert catalog.state("otelcol-contrib", "9.9.9") is VersionState.UNKNOWN


def test_catalog_ignores_fields_it_does_not_use() -> None:
    """The test catalogue carries `renamedTypes` and a made-up field; the
    reader takes only distribution, version and deprecated."""
    catalog = Catalog.load(CATALOG_DIR)

    assert catalog.state("otelcol-contrib", "0.162.0") is VersionState.OFFERED
    assert catalog.state("otelcol-contrib", "0.155.0") is VersionState.RETIRED
    assert catalog.state("clickstack", "2.36.0") is VersionState.UNKNOWN
    assert catalog.offered_versions("otelcol-contrib") == ["0.162.0", "0.161.0"]


def test_catalog_refuses_an_unreadable_file(tmp_path: Path) -> None:
    (tmp_path / "broken.json").write_text("{ not json")
    with pytest.raises(CatalogError):
        Catalog.load(tmp_path)


def test_binary_layout_is_telflo_apps(tmp_path: Path) -> None:
    assert binary_path(tmp_path, "0.162.0") == tmp_path / "v0.162.0" / "otelcol-contrib"


# ---------------------------------------------------------------------------
# The answer (was: validate_contrib's shape and its 404 / 503)
# ---------------------------------------------------------------------------


def test_validate_contrib_still_returns_expected_shape(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json() == {
        "valid": True,
        "errors": [],
        "requirements": [],
        "distribution": "otelcol-contrib",
        "version": "0.162.0",
    }


def test_validate_contrib_raises_404_for_unknown_version(client: TestClient) -> None:
    resp = client.post("/validator/v1/validate/otelcol-contrib/0.159.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_validate_contrib_raises_503_when_binary_missing(client: TestClient) -> None:
    """0.161.0 is offered by the test catalogue but not held."""
    resp = client.post("/validator/v1/validate/otelcol-contrib/0.161.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "version_unavailable"


def test_retired_version_answers_409_version_retired(client: TestClient) -> None:
    """A version pinned to a deprecated one is never checked against another
    version."""
    resp = client.post("/validator/v1/validate/otelcol-contrib/0.155.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "version_retired"


def test_retired_version_is_409_even_when_its_binary_is_present(binary_dir: Path) -> None:
    write_collector(binary_dir, "0.155.0", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post("/validator/v1/validate/otelcol-contrib/0.155.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 409


def test_a_second_catalogue_distribution_is_reached_through_the_same_route(binary_dir: Path) -> None:
    """Any distribution the catalogue lists is routed; the binary layout is
    `v<version>/otelcol-contrib`."""
    write_collector(binary_dir, "1.2.3", PASSING_COLLECTOR)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post("/validator/v1/validate/acme-collector/1.2.3", json=BODY, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json()["distribution"] == "acme-collector"


# ---------------------------------------------------------------------------
# Check order: the path and the catalogue before the body
# ---------------------------------------------------------------------------


async def test_unknown_version_wins_over_malformed_json_body(binary_dir: Path) -> None:
    """Unknown version + unparseable JSON body -> 404, not 400, and the body
    is never read."""
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(
        app,
        "POST",
        "/validator/v1/validate/otelcol-contrib/0.159.0",
        auth_headers(),
        [b"{ not json"],
        forbid_body=True,
    )

    assert result.status == 404


async def test_bad_version_format_wins_over_body_issues(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(
        app,
        "POST",
        "/validator/v1/validate/otelcol-contrib/not-a-version",
        auth_headers(),
        [b"[]"],
        forbid_body=True,
    )

    assert result.status == 400
    assert result.json() == {
        "error": {"code": "invalid_request", "message": "The version must be major.minor.patch."}
    }


async def test_version_known_but_binary_missing_wins_over_body_issues(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(
        app,
        "POST",
        "/validator/v1/validate/otelcol-contrib/0.161.0",
        auth_headers(),
        [b"[]"],
        forbid_body=True,
    )

    assert result.status == 503


async def test_retired_version_wins_over_body_issues(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(
        app,
        "POST",
        "/validator/v1/validate/otelcol-contrib/0.155.0",
        auth_headers(),
        [b"[]"],
        forbid_body=True,
    )

    assert result.status == 409


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def test_clickstack_is_a_distribution_the_catalogue_does_not_list(client: TestClient) -> None:
    """Was test_new_route_dispatches_clickstack: ClickStack isn't ported."""
    resp = client.post("/validator/v1/validate/clickstack/2.36.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 404


def test_new_route_dispatches_otelcol_contrib(binary_dir: Path, tmp_path: Path) -> None:
    """The collector run is the version's own: it records the path it was
    run as (the check runs in a child process, so nothing is stubbed)."""
    seen = tmp_path / "ran-as"
    write_collector(binary_dir, "0.162.0", f'echo "$0" > {seen}\nexit 0\n')
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "0.162.0"
    assert body["distribution"] == "otelcol-contrib"
    assert body["valid"] is True
    assert Path(seen.read_text().strip()) == binary_dir / "v0.162.0" / "otelcol-contrib"


def test_legacy_route_is_not_ported(client: TestClient) -> None:
    """There is no contrib-only `/validate/{version}`: it answers 404 like
    any path no route has."""
    resp = client.post("/validator/v1/validate/0.162.0", json=BODY, headers=auth_headers())

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_new_route_unknown_distribution_404(client: TestClient) -> None:
    resp = client.post("/validator/v1/validate/bogus/1.2.3", json=BODY, headers=auth_headers())

    assert resp.status_code == 404
    assert resp.json()["error"] == {
        "code": "not_found",
        "message": "The catalogue lists no such distribution.",
    }
    # A message never quotes the request.
    assert "bogus" not in resp.text


def test_new_route_rejects_malformed_distribution_slug(client: TestClient) -> None:
    resp = client.post("/validator/v1/validate/Not_Valid!/1.2.3", json=BODY, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json()["error"]["message"] == "The distribution must be lowercase words joined by single hyphens."


def test_new_route_rejects_malformed_version_before_dispatch(client: TestClient) -> None:
    resp = client.post("/validator/v1/validate/otelcol-contrib/not-a-version", json=BODY, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json()["error"]["message"] == "The version must be major.minor.patch."


def test_new_route_requires_the_secret(client: TestClient) -> None:
    """The route requires the shared secret."""
    resp = client.post(VALIDATE_URL, json=BODY)

    assert resp.status_code == 401


def test_distributions_and_versions_routes_are_not_ported(client: TestClient) -> None:
    """Rewritten: `/versions` and `/distributions` (which listed checksums
    and availability) are not ported; the platform reads the catalogue."""
    for path in ("/validator/v1/distributions", "/validator/v1/versions", "/validator/v1/health"):
        resp = client.get(path, headers=auth_headers())
        assert resp.status_code == 404, path
