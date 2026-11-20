"""YAML aliases are bounded, and the pre-processing runs after the slot is
taken (in the check's child process).

A 462-byte text whose aliases nest seven deep expands to ten million nodes;
unbounded walks would visit every one, on the event loop, before a slot and
outside the collector's time limit (3.6 s for one request, everything else
waiting). Timing here is in operation counts and events, never in sleeps."""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app import bounded_yaml, placeholders, providers, requirements, runner
from app.bounded_yaml import ALIASES_MESSAGE, MAX_ALIAS_NODES, TooManyAliases, alias_expansion
from app.main import create_app
from app.runner import SlotUnavailable, run_validation
from tests.conftest import VALIDATE_URL, auth_headers, make_settings, write_collector

SERVICE = Path(__file__).resolve().parents[1]


def bomb(levels: int, width: int = 10) -> str:
    """Each level a list of `width` aliases to the one before, under a real
    receiver."""
    lines = ["a0: &a0 'x'"]
    for i in range(1, levels + 1):
        lines.append(f"a{i}: &a{i} [" + ",".join([f"*a{i - 1}"] * width) + "]")
    body = "\n".join("      " + line for line in lines)
    return "receivers:\n  otlp:\n    protocols: {grpc: {}}\n    j:\n" + body + "\n"


# Six levels: a million nodes from 406 bytes, ten times the bound.
BOMB = bomb(6)

ANCHORED = """\
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        tls: &tls
          cert_file: /etc/otel/server.crt
          key_file: /etc/otel/server.key
      http:
        endpoint: 0.0.0.0:4318
        tls: *tls
processors:
  batch: {}
  memory_limiter: &limits
    check_interval: 1s
    limit_mib: 512
  memory_limiter/2: *limits
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: &chain [memory_limiter, batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: *chain
      exporters: [debug]
"""


async def _check(binary: Path, text: str, slots: asyncio.Semaphore | None = None, wait: float = 1.0):
    return await run_validation(
        binary, text, slots=slots or asyncio.Semaphore(1), slot_wait_seconds=wait, timeout_seconds=10
    )


def _ran_marker(binary_dir: Path, tmp_path: Path) -> tuple[Path, Path]:
    """A collector that records that it ran."""
    marker = tmp_path / "collector-ran"
    return write_collector(binary_dir, "0.162.0", f"touch {marker}\nexit 0\n"), marker


# ---------------------------------------------------------------------------
# The bound
# ---------------------------------------------------------------------------


def test_the_bound_counts_only_what_aliases_add() -> None:
    def added(text: str) -> int:
        return alias_expansion(yaml.compose(text))

    assert added("a: [1, 2, 3]\nb: {c: d}\n") == 0
    # The sequence (1 node + 3 scalars) once more.
    assert added("a: &a [1, 2, 3]\nb: *a\n") == 4
    # A long text with no alias adds nothing, however long.
    assert added("a: [" + ", ".join(str(i) for i in range(200_000)) + "]\n") == 0


def test_the_bound_is_inclusive_and_one_more_node_is_refused() -> None:
    """A 1,000-node block aliased 100 times adds exactly the bound; one more
    alias to a scalar takes it over."""
    block = "block: &b [" + ", ".join("x" for _ in range(999)) + "]\n"
    uses = "uses: [" + ", ".join("*b" for _ in range(MAX_ALIAS_NODES // 1000)) + "]\n"

    loaded = bounded_yaml.safe_load(block + uses)
    assert isinstance(loaded, dict) and len(loaded["uses"]) == 100

    with pytest.raises(TooManyAliases):
        bounded_yaml.safe_load(block + "one: &one y\n" + uses + "more: *one\n")


def test_a_node_that_contains_itself_is_refused() -> None:
    with pytest.raises(TooManyAliases):
        bounded_yaml.safe_load("a: &a [1, *a]\n")


def test_the_bomb_is_refused_by_the_loader_and_is_not_a_yaml_error() -> None:
    """Not a YAMLError: the call sites would wave that through as
    unparseable and let the collector judge."""
    with pytest.raises(TooManyAliases) as raised:
        bounded_yaml.safe_load(BOMB)
    assert not isinstance(raised.value, bounded_yaml.YAMLError)


def test_what_one_caller_changes_no_other_caller_sees() -> None:
    """The last texts' documents are kept for the check's other steps;
    each caller gets its own copy, so one step changing its document in place
    (the provider neutralisation does) can't change what the next step
    reads."""
    first = bounded_yaml.safe_load(ANCHORED)
    first["processors"]["memory_limiter"]["limit_mib"] = 1
    first["service"]["pipelines"]["traces"]["processors"].append("changed")
    first["exporters"].clear()

    second = bounded_yaml.safe_load(ANCHORED)

    assert second == yaml.safe_load(ANCHORED)
    assert second["processors"]["memory_limiter"]["limit_mib"] == 512
    assert second["exporters"] == {"debug": {}}


# ---------------------------------------------------------------------------
# Every parse goes through the loader
# ---------------------------------------------------------------------------


def test_no_module_but_the_loader_imports_yaml() -> None:
    """Scanned: a module that imports PyYAML's parser could parse without the
    bound. `import yaml` (any form) and `from yaml import …` (the package
    root, which exposes `load` / `safe_load`) are forbidden; the node *types*
    `from yaml.nodes import …` carry no parser and are allowed, as the
    neutraliser walks composed nodes. providers.py binds the loader as `yaml`
    (its functions stay verbatim)."""
    allowed_from = {"yaml.nodes", "yaml.events", "yaml.constructor"}
    offenders = []
    for path in sorted([*(SERVICE / "app").glob("*.py"), SERVICE / "telemetry.py"]):
        if path.name == "bounded_yaml.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import) and any(alias.name.split(".")[0] == "yaml" for alias in node.names):
                offenders.append(path.name)
            if isinstance(node, ast.ImportFrom) and (node.module or "") == "yaml":
                offenders.append(path.name)
            if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "yaml":
                assert node.module in allowed_from, f"{path.name} imports from {node.module}"
    assert offenders == []
    assert providers.yaml is bounded_yaml


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
def test_every_entry_point_that_parses_refuses_the_bomb(entry) -> None:
    with pytest.raises(TooManyAliases):
        entry(BOMB)


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------


async def test_the_bomb_is_invalid_without_walking_it_or_running_the_collector(
    binary_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary, marker = _ran_marker(binary_dir, tmp_path)
    visits = 0
    walk = requirements._tls_files

    def counted(*args):
        nonlocal visits
        visits += 1
        return walk(*args)

    monkeypatch.setattr(requirements, "_tls_files", counted)

    # In-process (what the check's child runs), so the walk can be counted.
    result = await runner.check_text(binary, BOMB, timeout_seconds=10)

    assert result.valid is False
    assert result.errors == [{"message": ALIASES_MESSAGE, "componentPath": None}]
    assert result.requirements == []
    assert result.outcome == "aliases"
    assert visits == 0  # refused at the parse: nothing walked the expansion
    assert not marker.exists()


def test_the_bomb_answers_invalid_through_the_api(binary_dir: Path, tmp_path: Path) -> None:
    _, marker = _ran_marker(binary_dir, tmp_path)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, json={"yaml": bomb(7)}, headers=auth_headers())

    assert resp.status_code == 200
    assert resp.json() == {
        "valid": False,
        "errors": [{"message": "The configuration expands too many YAML aliases.", "componentPath": None}],
        "requirements": [],
        "distribution": "otelcol-contrib",
        "version": "0.162.0",
    }
    assert not marker.exists()


async def test_a_configuration_with_a_few_anchors_still_works(binary_dir: Path, tmp_path: Path) -> None:
    binary, marker = _ran_marker(binary_dir, tmp_path)

    result = await _check(binary, ANCHORED)

    assert result.valid is True
    assert result.errors == []
    # The aliased TLS block was read: one requirement per file.
    assert [r["title"] for r in result.requirements] == [
        "Provide /etc/otel/server.crt on the host",
        "Provide /etc/otel/server.key on the host",
    ]
    assert marker.exists()


# ---------------------------------------------------------------------------
# After the slot (the work runs in the check's child:
# tests/test_check_process.py)
# ---------------------------------------------------------------------------


async def test_the_pre_processing_waits_for_a_slot(binary_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """With every slot taken, the text isn't touched: 503 without starting
    the check's child, the only place the text is read."""
    binary = write_collector(binary_dir, "0.162.0", "exit 0\n")
    calls = 0
    run_child = runner._run_child

    async def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await run_child(*args, **kwargs)

    monkeypatch.setattr(runner, "_run_child", counted)

    with pytest.raises(SlotUnavailable):
        await _check(binary, ANCHORED, slots=asyncio.Semaphore(0), wait=0.05)
    assert calls == 0

    # The same check with a free slot does start it.
    await _check(binary, ANCHORED)
    assert calls == 1
