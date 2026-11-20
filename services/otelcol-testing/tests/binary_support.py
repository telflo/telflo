"""What the binary and kwok tests share (`tests/test_binary_*.py`, marked
`binary` or `kwok`, run inside the image with `pytest -m "binary or kwok"`
under `--network none`): where the collectors and the catalog are, which
versions the catalog offers, the tester's app over the image's collectors,
and running one test through it.

An offered version the image doesn't hold is skipped, unless the image was
built to hold it (as the validator's): the `test` target sets
`OTELCOL_EXPECTED_VERSIONS` to its `OTELCOL_VERSIONS` build argument (`all`,
`default` or a comma-separated list), and a version it names that isn't held
fails the test instead, so a build that silently baked fewer collectors
can't pass by skipping them.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.catalog import Catalog, binary_path
from app.main import DISTRIBUTION
from app.settings import DEFAULT_BINARY_DIR, DEFAULT_CATALOG_DIR
from tests.conftest import RUNS_URL, auth_headers, make_settings, run_body

BINARY_DIR = Path(os.environ.get("OTELCOL_BINARY_DIR") or DEFAULT_BINARY_DIR)
CATALOG_DIR = Path(os.environ.get("OTELCOL_CATALOG_DIR") or DEFAULT_CATALOG_DIR)
CATALOG = Catalog.load(CATALOG_DIR)
OFFERED = CATALOG.offered_versions(DISTRIBUTION)


def _default_version(catalog_dir: Path = CATALOG_DIR) -> str:
    """The catalog's default offered version, as the image's download
    script picks it (catalog.py reads no default: the service never needs
    one)."""
    for path in sorted(catalog_dir.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("distribution") == DISTRIBUTION:
            [default] = [
                entry["version"] for entry in document["versions"] if entry.get("default") and not entry.get("deprecated")
            ]
            return default
    raise AssertionError(f"{catalog_dir} has no {DISTRIBUTION} file")


def expected_versions(value: str | None = None) -> list[str]:
    """The offered versions the image was built to hold
    (`OTELCOL_EXPECTED_VERSIONS`, as the Dockerfile's `OTELCOL_VERSIONS`), or
    none when unset."""
    value = (os.environ.get("OTELCOL_EXPECTED_VERSIONS", "") if value is None else value).strip()
    if not value:
        return []
    if value == "all":
        return list(OFFERED)
    if value == "default":
        return [_default_version()]
    return [part.strip() for part in value.split(",") if part.strip()]


def held(version: str) -> bool:
    return binary_path(BINARY_DIR, version).is_file()


def require(version: str) -> Path:
    """The version's collector; a version not held fails the test when the
    image was built to hold it, and is skipped otherwise."""
    binary = binary_path(BINARY_DIR, version)
    if not binary.is_file():
        if version in expected_versions():
            pytest.fail(f"{version} should be held in {BINARY_DIR} (OTELCOL_EXPECTED_VERSIONS) but isn't")
        pytest.skip(f"{version} isn't held in {BINARY_DIR}")
    return binary


def image_settings(**overrides: object):
    """The tests' settings (conftest's secret), over the image's collectors
    and catalog."""
    return make_settings(BINARY_DIR, catalog_dir=CATALOG_DIR, **overrides)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decoded(field: dict | None) -> bytes | None:
    return None if field is None else base64.b64decode(field["base64"])


def run(
    client: TestClient,
    version: str,
    text: str,
    data: bytes,
    *,
    signal: str = "logs",
    pipeline: str | None = None,
    duration: int = 1,
) -> dict:
    """One test through the service, on the image's `version`; the 200
    answer's body."""
    require(version)
    resp = client.post(
        RUNS_URL,
        json=run_body(
            yaml=text,
            signal=signal,
            pipeline=pipeline or signal,
            durationSeconds=duration,
            version=version,
            input={"base64": b64(data)},
        ),
        headers=auth_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def output_records(answer: dict) -> list[dict]:
    """The output's records: one record is unwrapped, several are
    `{"records": [...]}`."""
    document = json.loads(decoded(answer["output"]))
    if isinstance(document, dict) and set(document) == {"records"}:
        return document["records"]
    return [document]


def log_bodies(answer: dict) -> list[str]:
    return [
        record["body"]["stringValue"]
        for document in output_records(answer)
        for resource in document.get("resourceLogs", [])
        for scope in resource.get("scopeLogs", [])
        for record in scope.get("logRecords", [])
    ]


def resource_attributes(answer: dict) -> list[dict[str, object]]:
    """Each output resource's attributes, as {key: value}."""
    found = []
    for document in output_records(answer):
        for resource in document.get("resourceLogs", []):
            found.append(
                {
                    attribute["key"]: next(iter(attribute["value"].values()), None)
                    for attribute in resource.get("resource", {}).get("attributes", [])
                }
            )
    return found


def mutation_ids(answer: dict) -> list[str]:
    return [mutation["id"] for mutation in answer["mutations"]]
