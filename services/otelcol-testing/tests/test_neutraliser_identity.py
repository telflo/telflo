"""The neutralizer's modules are the validator's, byte for byte:
`providers.py`, `bounded_yaml.py` and `placeholders.py` are copied unchanged
(both services' packages are named `app`, so their imports hold). A change
to either copy fails here until the other is made the same. Unmarked: it
runs in the repository's suite."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

TESTER_APP = Path(__file__).resolve().parents[1] / "app"
VALIDATOR_APP = Path(__file__).resolve().parents[2] / "otelcol-validator" / "app"
COPIED = ("providers.py", "bounded_yaml.py", "placeholders.py")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", COPIED)
def test_the_copy_is_the_validators(name: str) -> None:
    assert VALIDATOR_APP.is_dir(), "the validator's app/ is where this test expects it"
    assert _sha256(TESTER_APP / name) == _sha256(VALIDATOR_APP / name)
