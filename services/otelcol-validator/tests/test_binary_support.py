"""The binary tests' helpers (tests/binary_support.py), without a collector."""

from __future__ import annotations

import json
from pathlib import Path

from tests.binary_support import _default_version


def _catalogue(directory: Path, versions: list[dict]) -> Path:
    directory.mkdir()
    (directory / "otelcol-contrib.json").write_text(
        json.dumps({"distribution": "otelcol-contrib", "versions": versions}), encoding="utf-8"
    )
    return directory


def test_the_default_version_is_never_a_deprecated_row(tmp_path: Path) -> None:
    """D13b ruling 63: `OTELCOL_VERSIONS=default` bakes the offered default
    (scripts/download-binaries.py), so a retired row still marked default
    isn't the version the image is expected to hold."""
    catalogue = _catalogue(
        tmp_path / "catalog",
        [
            {"version": "0.2.0", "default": True, "deprecated": False},
            {"version": "0.1.0", "default": True, "deprecated": True},
        ],
    )

    assert _default_version(catalogue) == "0.2.0"
