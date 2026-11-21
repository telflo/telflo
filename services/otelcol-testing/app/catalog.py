"""The collector catalog, read from `catalog/distributions/*.json`: the
validator's `app/catalog.py`, copied for the tester and changed in its words
only.

The platform's migration step owns the catalog's rules (catalog/README.md);
the tester reads only what it needs, each file's `distribution` and each
version's `version` and `deprecated`, and ignores every other field, so a
field added to the format later (such as `renamedTypes`) changes
nothing here. A version is offered (not deprecated), retired (deprecated) or
unknown; a distribution the catalog doesn't list makes every version
unknown.
"""

from __future__ import annotations

import enum
import json
from dataclasses import dataclass
from pathlib import Path


class CatalogError(ValueError):
    """The catalog directory can't be read as the tester needs it. The
    service refuses to start."""


class VersionState(enum.Enum):
    OFFERED = "offered"
    RETIRED = "retired"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Catalog:
    # distribution -> {version: deprecated}
    distributions: dict[str, dict[str, bool]]

    def state(self, distribution: str, version: str) -> VersionState:
        versions = self.distributions.get(distribution)
        if versions is None or version not in versions:
            return VersionState.UNKNOWN
        return VersionState.RETIRED if versions[version] else VersionState.OFFERED

    def offered_versions(self, distribution: str) -> list[str]:
        return [v for v, deprecated in self.distributions.get(distribution, {}).items() if not deprecated]

    @classmethod
    def load(cls, directory: Path) -> Catalog:
        if not directory.is_dir():
            raise CatalogError(f"The catalogue directory {directory} doesn't exist")
        distributions: dict[str, dict[str, bool]] = {}
        files = sorted(directory.glob("*.json"))
        if not files:
            raise CatalogError(f"The catalogue directory {directory} holds no distribution file")
        for path in files:
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise CatalogError(f"{path.name} can't be read: {type(error).__name__}") from None
            distribution, versions = _read_distribution(path.name, document)
            if distribution in distributions:
                raise CatalogError(f"{path.name}: distribution {distribution} is listed twice")
            distributions[distribution] = versions
        return cls(distributions=distributions)


def _read_distribution(name: str, document: object) -> tuple[str, dict[str, bool]]:
    if not isinstance(document, dict):
        raise CatalogError(f"{name}: not a JSON object")
    distribution = document.get("distribution")
    if not isinstance(distribution, str) or not distribution:
        raise CatalogError(f"{name}: no distribution")
    entries = document.get("versions")
    if not isinstance(entries, list):
        raise CatalogError(f"{name}: no versions list")
    versions: dict[str, bool] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise CatalogError(f"{name}: version entry {index} is not an object")
        version = entry.get("version")
        deprecated = entry.get("deprecated", False)
        if not isinstance(version, str) or not version:
            raise CatalogError(f"{name}: version entry {index} has no version")
        if not isinstance(deprecated, bool):
            raise CatalogError(f"{name}: version {version}'s deprecated is not true or false")
        versions[version] = deprecated
    return distribution, versions


def binary_path(binary_dir: Path, version: str) -> Path:
    """Where the image keeps a version's collector:
    `<OTELCOL_BINARY_DIR>/v<version>/otelcol-contrib`."""
    return binary_dir / f"v{version}" / "otelcol-contrib"
