"""D13b ruling 30: a text nested deeper than `MAX_DEPTH` is answered invalid,
`The configuration nests too deeply.`, without running the collector.

The composer recursed once or twice per level (libyaml's in C, past Python's
recursion check), and the walks over the result too: a few hundred levels
answered 500 (RecursionError)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import bounded_yaml, placeholders, providers, requirements, runner
from app.bounded_yaml import DEPTH_MESSAGE, MAX_DEPTH, TooDeep
from app.main import create_app
from tests.conftest import VALIDATE_URL, auth_headers, make_settings, write_collector

HEAD = (
    "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\n"
    "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n"
)


def flow(depth: int) -> str:
    """The top mapping, then `depth - 1` sequences inside one another."""
    return HEAD + "x: " + "[" * (depth - 1) + "]" * (depth - 1) + "\n"


def block(depth: int) -> str:
    """The top mapping, then `depth - 1` block mappings inside one another."""
    return HEAD + "x:\n" + "".join(" " * (i + 1) + f"k{i}:\n" for i in range(depth - 2)) + " " * (depth - 1) + "v: 1\n"


@pytest.mark.parametrize("shape", [flow, block], ids=["flow", "block"])
def test_the_bound_is_inclusive(shape) -> None:
    bounded_yaml.check_depth(shape(MAX_DEPTH))
    assert isinstance(bounded_yaml.safe_load(shape(MAX_DEPTH)), dict)

    with pytest.raises(TooDeep):
        bounded_yaml.safe_load(shape(MAX_DEPTH + 1))


# Far past the bound: a block mapping's indentation grows with its depth, so
# 700 is about the deepest that fits in 262,144 characters.
DEEP = [(flow, MAX_DEPTH + 1), (flow, 1_000), (flow, 20_000), (block, MAX_DEPTH + 1), (block, 700)]
DEEP_IDS = [f"{shape.__name__}-{depth}" for shape, depth in DEEP]


@pytest.mark.parametrize(("shape", "depth"), DEEP, ids=DEEP_IDS)
def test_past_the_bound_is_refused_without_recursing(shape, depth: int) -> None:
    with pytest.raises(TooDeep) as raised:
        bounded_yaml.safe_load(shape(depth))
    assert not isinstance(raised.value, bounded_yaml.YAMLError)


@pytest.mark.parametrize(
    "entry",
    [
        requirements.text_requirements,
        requirements.text_errors,
        placeholders._build_env_var_placeholders,
        placeholders._inject_datadog_hostname_placeholder,
        providers._neutralize_disallowed_providers,
    ],
    ids=lambda entry: entry.__name__,
)
def test_every_entry_point_that_parses_refuses_it(entry) -> None:
    with pytest.raises(TooDeep):
        entry(flow(5_000))


@pytest.mark.parametrize(("shape", "depth"), DEEP, ids=DEEP_IDS)
def test_too_deep_answers_invalid_through_the_api_without_the_collector(
    binary_dir: Path, tmp_path: Path, shape, depth: int
) -> None:
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")
    text = shape(depth)
    assert len(text) <= 262_144
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": text}, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json() == {
        "valid": False,
        "errors": [{"message": "The configuration nests too deeply.", "componentPath": None}],
        "requirements": [],
        "distribution": "otelcol-contrib",
        "version": "0.162.0",
    }
    assert not marker.exists()


@pytest.mark.parametrize("shape", [flow, block], ids=["flow", "block"])
async def test_at_the_bound_the_collector_judges(binary_dir: Path, tmp_path: Path, shape) -> None:
    marker = tmp_path / "collector-ran"
    binary = write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")

    result = await runner.check_text(binary, shape(MAX_DEPTH), timeout_seconds=10)

    assert result.valid is True
    assert result.outcome == "passed"
    assert marker.exists()
    assert DEPTH_MESSAGE == "The configuration nests too deeply."


# ---------------------------------------------------------------------------
# What aliases nest (the review of 207bc02's alias-chain note)
# ---------------------------------------------------------------------------


def alias_chain(links: int, depth: int = 95) -> str:
    """Anchors each `depth` lists deep around an alias of the one before:
    under the bound in the text, `links × depth` deep once expanded, and
    well under the alias bound (the expansions add few nodes)."""
    lines = ["a0: &a0 " + "[" * depth + "x" + "]" * depth]
    lines += [f"a{i}: &a{i} " + "[" * depth + f"*a{i - 1}" + "]" * depth for i in range(1, links)]
    return HEAD + "\n".join(lines) + "\n"


def test_an_alias_chain_is_as_deep_as_it_expands() -> None:
    """207bc02 counted only the text's own nesting: forty links of 95 were
    3,800 levels once expanded, and the walks raised RecursionError (500)."""
    text = alias_chain(40)
    bounded_yaml.check_depth(text)  # the text itself is within the bound

    with pytest.raises(TooDeep):
        bounded_yaml.safe_load(text)
    # One link is within the bound; two expand past it.
    assert isinstance(bounded_yaml.safe_load(alias_chain(1)), dict)
    with pytest.raises(TooDeep):
        bounded_yaml.safe_load(alias_chain(2))


def test_an_alias_chain_answers_invalid_through_the_api_without_the_collector(
    binary_dir: Path, tmp_path: Path
) -> None:
    marker = tmp_path / "collector-ran"
    write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": alias_chain(40)}, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json()["errors"] == [{"message": "The configuration nests too deeply.", "componentPath": None}]
    assert not marker.exists()
