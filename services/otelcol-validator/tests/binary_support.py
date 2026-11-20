"""What the binary tests share (marked `binary`, run inside the image with
`pytest -m binary`): where the collectors and the catalogue are, which
versions the catalogue offers, and running a check on one of them.

An offered version the image doesn't hold is skipped, unless the image was
built to hold it: the `test` target sets `OTELCOL_EXPECTED_VERSIONS` to its
`OTELCOL_VERSIONS` build argument (`all`, `default` or a comma-separated
list), and a version it names that isn't held fails the test instead, so a
build that silently baked fewer collectors can't pass by skipping them. Run
outside the image (no variable), every version not held is skipped.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import pytest

from app.catalog import Catalog, binary_path
from app.runner import RunOutcome, ValidationResult, run_collector, run_validation
from app.settings import DEFAULT_BINARY_DIR, DEFAULT_CATALOG_DIR

DISTRIBUTION = "otelcol-contrib"
BINARY_DIR = Path(os.environ.get("OTELCOL_BINARY_DIR") or DEFAULT_BINARY_DIR)
CATALOG_DIR = Path(os.environ.get("OTELCOL_CATALOG_DIR") or DEFAULT_CATALOG_DIR)
CATALOG = Catalog.load(CATALOG_DIR)
OFFERED = CATALOG.offered_versions(DISTRIBUTION)


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def _default_version(catalog_dir: Path = CATALOG_DIR) -> str:
    """The catalogue's default version of the distribution among its offered
    rows, as the image's download script picks it (never a deprecated row;
    catalog.py reads no default: the service never needs one)."""
    for path in sorted(catalog_dir.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("distribution") == DISTRIBUTION:
            [default] = [
                entry["version"]
                for entry in document["versions"]
                if entry.get("default") and not entry.get("deprecated")
            ]
            return default
    raise AssertionError(f"{catalog_dir} has no {DISTRIBUTION} file")


def expected_versions(value: str | None = None) -> list[str]:
    """The offered versions the image was built to hold (`OTELCOL_EXPECTED_VERSIONS`,
    as the Dockerfile's `OTELCOL_VERSIONS`), or none when unset."""
    value = os.environ.get("OTELCOL_EXPECTED_VERSIONS", "") if value is None else value
    value = value.strip()
    if not value:
        return []
    if value == "all":
        return list(OFFERED)
    if value == "default":
        return [_default_version()]
    return [part.strip() for part in value.split(",") if part.strip()]


def held(version: str) -> bool:
    return binary_path(BINARY_DIR, version).is_file()


def binary_for(version: str) -> Path:
    """The version's collector; a version not held fails the test when the
    image was built to hold it, and is skipped otherwise."""
    binary = binary_path(BINARY_DIR, version)
    if not binary.is_file():
        if version in expected_versions():
            pytest.fail(f"{version} should be held in {BINARY_DIR} (OTELCOL_EXPECTED_VERSIONS) but isn't")
        pytest.skip(f"{version} isn't held in {BINARY_DIR}")
    return binary


async def check(version: str, text: str) -> ValidationResult:
    """The service's own check of `text` (placeholders, Datadog's hostname,
    the text's requirements, the rerun)."""
    return await run_validation(
        binary_for(version), text, slots=asyncio.Semaphore(1), slot_wait_seconds=5.0, timeout_seconds=30
    )


async def raw_validate(version: str, text: str) -> RunOutcome:
    """`otelcol-contrib validate` alone on `text` as given, in the
    collector's environment (the allowlist and the fixed overrides)."""
    return await run_collector(binary_for(version), text, {}, timeout_seconds=30)


def errors_match(errors: list[dict], expected: list[dict]) -> bool:
    """Whether `errors` are `expected`, in order: each message equal to the
    expected one, or matching it whole when it is a pattern (for a message
    whose list the collector prints in Go's map order, which varies from run
    to run)."""
    if len(errors) != len(expected):
        return False
    for error, wanted in zip(errors, expected, strict=True):
        if error["componentPath"] != wanted["componentPath"]:
            return False
        message = wanted["message"]
        if isinstance(message, re.Pattern):
            if message.fullmatch(error["message"]) is None:
                return False
        elif error["message"] != message:
            return False
    return True
