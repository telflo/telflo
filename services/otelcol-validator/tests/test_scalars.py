"""A plain scalar of an implicit type whose construction can
fail is a string, and any value that can't be constructed is a YAMLError
(unparseable: the collector judges), never a 500.

The collector's Go YAML reads `2001-13-45`, `=` and `0b_` as strings;
PyYAML's own constructors raise ValueError for the first and the last (the
check's child would fail: 500) and a ConstructorError for `=` (unparseable,
so the submitted text's own words would go unread, a bypass of the
submitted-text guard)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import bounded_yaml
from app.stderr import Submitted
from tests.conftest import VALIDATE_URL, auth_headers, make_settings, write_collector
from app.main import create_app


@pytest.mark.parametrize(
    "scalar",
    ["2001-13-45", "2001-12-14", "2001-12-14t21:59:43.10-05:00", "=", "0b_", "0x_", "-0b_", "._"],
)
def test_an_implicit_scalar_that_cant_be_constructed_is_a_string(scalar: str) -> None:
    assert bounded_yaml.safe_load(f"x: {scalar}\n") == {"x": scalar}


@pytest.mark.parametrize(("scalar", "value"), [("1_000", 1000), ("0x1f", 31), ("1.5", 1.5), ("true", True), ("~", None)])
def test_the_other_implicit_types_are_kept(scalar: str, value: object) -> None:
    assert bounded_yaml.safe_load(f"x: {scalar}\n") == {"x": value}


@pytest.mark.parametrize("text", ["x: !!int abc\n", "x: !!timestamp 2001-13-45\n", "x: !!float x\n"])
def test_an_explicit_tag_that_cant_be_constructed_is_unparseable(text: str) -> None:
    with pytest.raises(bounded_yaml.YAMLError):
        bounded_yaml.safe_load(text)


def test_the_submitted_texts_words_are_read_past_a_date_like_value() -> None:
    """A key spelt with a YAML escape, beside a date-like value, is still
    among the text's words."""
    text = 'headers:\n  "x\\x27: stat /y": 1\n  h: 2001-13-45\n'

    assert Submitted(text).holds("x': stat /y")


@pytest.mark.parametrize("value", ["2001-13-45", "=", "0b_", "!!int abc"])
def test_a_value_that_failed_construction_is_checked_through_the_api(
    binary_dir: Path, tmp_path: Path, value: str
) -> None:
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")
    text = f"receivers:\n  otlp:\n    protocols:\n      grpc: {{}}\nexporters:\n  otlp_http:\n    headers:\n      h: {value}\n"
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": text}, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json()["valid"] is True
    assert marker.exists()  # the collector judged it
