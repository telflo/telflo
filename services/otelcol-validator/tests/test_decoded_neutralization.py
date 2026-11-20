"""References are found where the collector finds them, and spliced, not
re-dumped.

A YAML escape (``"\\x24{file:…}"``, ``"\\u0024{file:…}"``, an escaped line
break between ``$`` and ``{``, …) hides a live ``${file:…}`` from a raw-text
scan, yet the collector decodes the escape and expands the reference and the
file's contents come back in the error; and neutralizing by re-dumping the
whole document would change untouched scalars' types (``1:30`` → 90, ``on`` →
true), so a text would answer differently from how its raw form does.

These tests exercise the pre-processing (`_prepare`) over the stable surface:
detection is on the decoded keys and values (every escape form, in
plain/single/double/block scalars, behind anchors and aliases and tags, in
keys as well as values), a text PyYAML can't read as one document is answered
invalid, and every byte outside a spliced reference is unchanged.
"""

from __future__ import annotations

import pytest

from app import bounded_yaml
from app.providers import _neutralize_str
from app.runner import _Prepared, _prepare

# The five escape forms, each rendering a literal ``$`` that a
# raw ``${`` scan misses but PyYAML decodes to a live reference.
ESCAPES = {
    "x24": r"\x24{file:/etc/canary}",
    "u0024": r"\u0024{file:/etc/canary}",
    "U00000024": r"\U00000024{file:/etc/canary}",
    "x7b_brace": r"$\x7bfile:/etc/canary}",
    "escaped_linebreak": "$\\\n  {file:/etc/canary}",
}


def _decoded_strings(text: str) -> list[str]:
    """Every decoded key and scalar value, as the collector's confmap layer
    reads them (cross-version: uses only the bounded loader)."""
    strings: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(key, str):
                    strings.append(key)
                walk(key)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            strings.append(node)

    walk(bounded_yaml.safe_load(text))
    return strings


def _holds_live_reference(text: str) -> bool:
    """True when any decoded key or value still holds a live non-env reference
    (the engine both versions ship, `_neutralize_str`, reports it)."""
    return any(_neutralize_str(decoded, "PH")[1] for decoded in _decoded_strings(text))


def _prepared_text(text: str) -> str:
    prepared = _prepare(text)
    assert isinstance(prepared, _Prepared), f"the collector would not run: {prepared}"
    return prepared.yaml_content


# ---------------------------------------------------------------------------
# Every escape form, in every scalar style, is detected and neutralized.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("escape", ESCAPES.values(), ids=list(ESCAPES))
def test_a_double_quoted_escape_in_a_value_is_neutralised(escape: str) -> None:
    text = f'exporters:\n  otlp:\n    endpoint: "{escape}"\n'
    assert _holds_live_reference(text)  # the collector would expand it
    assert not _holds_live_reference(_prepared_text(text))


# The escaped line break makes a multi-line key that YAML then can't follow
# with `: value`; it is a value-only form.
_KEY_ESCAPES = {name: form for name, form in ESCAPES.items() if name != "escaped_linebreak"}


@pytest.mark.parametrize("escape", _KEY_ESCAPES.values(), ids=list(_KEY_ESCAPES))
def test_a_double_quoted_escape_in_a_key_is_neutralised(escape: str) -> None:
    text = f'exporters:\n  otlp:\n    "{escape}": value\n'
    assert _holds_live_reference(text)
    assert not _holds_live_reference(_prepared_text(text))


def test_plain_single_and_double_scalars_are_all_neutralised() -> None:
    for scalar in ('"${file:/etc/canary}"', "'${file:/etc/canary}'", "${file:/etc/canary}"):
        text = f"exporters:\n  otlp:\n    endpoint: {scalar}\n"
        assert _holds_live_reference(text)
        assert not _holds_live_reference(_prepared_text(text))


@pytest.mark.parametrize("indicator", ["|", ">"])
def test_a_block_scalar_reference_is_neutralised_and_the_next_key_survives(indicator: str) -> None:
    text = f"exporters:\n  otlp:\n    endpoint: {indicator}\n      ${{file:/etc/canary}}\n    timeout: 10s\n"
    prepared = _prepared_text(text)
    assert not _holds_live_reference(prepared)
    # The key after the block keeps its own line (the block's trailing newline
    # is preserved by the splice).
    assert bounded_yaml.safe_load(prepared)["exporters"]["otlp"]["timeout"] == "10s"


def test_an_anchor_is_kept_so_the_alias_still_resolves() -> None:
    text = 'exporters:\n  a:\n    endpoint: &e "\\x24{file:/etc/canary}"\n  b:\n    endpoint: *e\n'
    prepared = _prepared_text(text)
    assert not _holds_live_reference(prepared)
    loaded = bounded_yaml.safe_load(prepared)
    # The alias resolved to the spliced value (the anchor stayed attached).
    assert loaded["exporters"]["a"]["endpoint"] == loaded["exporters"]["b"]["endpoint"]
    assert "canary" not in loaded["exporters"]["b"]["endpoint"]


def test_a_tag_is_kept_in_front_of_the_spliced_scalar() -> None:
    text = 'exporters:\n  otlp:\n    endpoint: !!str "\\x24{file:/etc/canary}"\n'
    prepared = _prepared_text(text)
    assert not _holds_live_reference(prepared)
    assert "!!str" in prepared  # the tag survived the splice


# ---------------------------------------------------------------------------
# A text PyYAML can't read as one document never reaches the collector.
# ---------------------------------------------------------------------------


def test_a_second_document_is_answered_invalid_without_running() -> None:
    text = 'exporters:\n  otlp:\n    endpoint: "\\x24{file:/etc/canary}"\n---\nx: 1\n'
    prepared = _prepare(text)
    assert not isinstance(prepared, _Prepared)
    assert prepared.valid is False
    assert prepared.outcome == "unreadable"
    assert "can't be read as YAML" in prepared.errors[0]["message"]
    assert prepared.errors[0]["componentPath"] is None
    assert "canary" not in prepared.errors[0]["message"]


def test_a_text_that_is_not_yaml_is_answered_invalid_without_running() -> None:
    prepared = _prepare("a: [1, 2\n")  # an unclosed flow sequence
    assert not isinstance(prepared, _Prepared)
    assert prepared.outcome == "unreadable"


# ---------------------------------------------------------------------------
# No re-dump: the drift cases now match the raw text, and bytes outside a
# spliced reference are unchanged (the differential the re-dump failed).
# ---------------------------------------------------------------------------

DRIFT_SCALARS = ["2001-12-14", "1:30", "on", "017", "1_000"]


@pytest.mark.parametrize("scalar", DRIFT_SCALARS)
def test_a_sibling_scalar_is_byte_identical_when_a_reference_is_spliced(scalar: str) -> None:
    """A re-dump rewrote ``1:30`` to 90, ``on`` to true, a date to a quoted
    string; the splice leaves every untouched scalar exactly as sent."""
    text = f'exporters:\n  otlp:\n    endpoint: "${{file:/etc/canary}}"\n    timeout: {scalar}\n'
    prepared = _prepared_text(text)
    assert f"timeout: {scalar}\n" in prepared, prepared
    assert not _holds_live_reference(prepared)


def test_a_text_without_any_reference_is_returned_byte_for_byte() -> None:
    texts = [
        "receivers:\n  otlp:\n    protocols:\n      grpc:\n",
        "a:\n  - 1\n  - two\n  - 2001-12-14\nb: {c: 1:30, d: on}\n",
        "x: '${env:KEEP}'\ny: $${file:/escaped-inert}\n",  # env and an inert even-run escape
    ]
    for text in texts:
        assert _prepared_text(text) == text, text
