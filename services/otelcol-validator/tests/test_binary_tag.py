"""A `!!binary` value is refused and never reaches a collector.

PyYAML composes a `!!binary` scalar's value as its base64 text, but the
collector's YAML decoder decodes it to a string and confmap expands the
references in what it decodes: `endpoint: !!binary <base64 of ${file:…}>`
reads the file, and the collector quotes it back in its error. No scan of
the composed values sees the reference, so a text holding one is refused
(providers.BINARY_TAG), in every spelling of the tag, in keys as well as
values, behind aliases. The `binary`-marked tests show, with the real
collectors, that the attack works on the text as written and that the
service refuses it.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from app import bounded_yaml, runner
from app.providers import BINARY_MESSAGE, has_binary_node
from app.runner import _prepare
from tests.binary_support import OFFERED, check, raw_validate

FAKE_BINARY = Path("/fake/otelcol-contrib")


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


REFERENCE = _b64("${file:/etc/canary}")

CONFIG = """\
receivers:
  otlp:
    protocols: {{grpc: {{}}}}
exporters:
  otlp:
    endpoint: {endpoint}
service:
  pipelines:
    traces: {{receivers: [otlp], exporters: [otlp]}}
"""

SPELLINGS = {
    "shorthand": CONFIG.format(endpoint=f"!!binary {REFERENCE}"),
    "verbatim": CONFIG.format(endpoint=f"!<tag:yaml.org,2002:binary> {REFERENCE}"),
    "tag_directive": "%TAG !y! tag:yaml.org,2002:\n---\n" + CONFIG.format(endpoint=f"!y!binary {REFERENCE}"),
    "quoted": CONFIG.format(endpoint=f'!!binary "{REFERENCE}"'),
    "block": CONFIG.format(endpoint=f"!!binary |\n      {REFERENCE}"),
    "in_a_key": f"receivers: {{}}\nprocessors:\n  attributes:\n    actions:\n      - {{? !!binary {REFERENCE} : x}}\n",
    "behind_an_alias": f"x-anchor: &ref !!binary {REFERENCE}\n" + CONFIG.format(endpoint="*ref"),
    "in_a_sequence": f"receivers: {{}}\nextensions: [!!binary {REFERENCE}]\n",
    # Not a reference at all: refused all the same, the tag alone.
    "harmless": CONFIG.format(endpoint=f"!!binary {_b64('localhost:4317')}"),
}

NOT_BINARY = {
    "plain": CONFIG.format(endpoint="localhost:4317"),
    "the_word": CONFIG.format(endpoint='"!!binary"'),
    "str_tag": CONFIG.format(endpoint="!!str localhost:4317"),
    "base64_text": CONFIG.format(endpoint=REFERENCE),
}


@pytest.mark.parametrize("case", sorted(SPELLINGS))
def test_a_binary_node_is_found_in_every_spelling_and_place(case: str) -> None:
    assert has_binary_node(bounded_yaml.single_node(SPELLINGS[case])) is True


@pytest.mark.parametrize("case", sorted(NOT_BINARY))
def test_a_text_with_no_binary_node_is_left_alone(case: str) -> None:
    assert has_binary_node(bounded_yaml.single_node(NOT_BINARY[case])) is False


def test_an_empty_document_holds_no_binary_node() -> None:
    assert has_binary_node(None) is False


@pytest.mark.parametrize("case", sorted(SPELLINGS))
def test_the_pre_processing_refuses_a_binary_value(case: str) -> None:
    prepared = _prepare(SPELLINGS[case])

    assert isinstance(prepared, runner.ValidationResult)
    assert prepared.valid is False
    assert prepared.outcome == "refused"
    assert prepared.errors == [{"message": BINARY_MESSAGE, "componentPath": None}]


def test_an_organization_variable_cannot_add_a_binary_value() -> None:
    """The values are filled in before the text is read, so a value that adds
    the tag is refused like one written in the text."""
    text = CONFIG.format(endpoint="${org:ENDPOINT}")

    prepared = _prepare(text, organization_variables={"ENDPOINT": f"!!binary {REFERENCE}"})

    assert isinstance(prepared, runner.ValidationResult)
    assert prepared.outcome == "refused"
    assert prepared.errors == [{"message": BINARY_MESSAGE, "componentPath": None}]


async def test_a_binary_value_never_reaches_the_collector(monkeypatch: pytest.MonkeyPatch) -> None:
    ran: list[str] = []

    async def collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):  # noqa: ANN001
        ran.append(yaml_content)
        raise AssertionError("the collector ran")

    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(FAKE_BINARY, SPELLINGS["shorthand"], timeout_seconds=10)

    assert ran == []
    assert result.valid is False
    assert result.outcome == "refused"
    assert result.errors == [{"message": BINARY_MESSAGE, "componentPath": None}]


def test_the_backstop_refuses_a_binary_value() -> None:
    """Defense in depth: the backstop, on the exact text a run reads,
    refuses one too (should a rewrite ever add it)."""
    assert runner._still_references(SPELLINGS["harmless"]) is True


@pytest.mark.binary
@pytest.mark.parametrize("version", OFFERED)
async def test_the_real_collector_expands_a_binary_reference_and_the_service_refuses_it(
    version: str, tmp_path: Path
) -> None:
    canary = f"binary-canary-{version}"
    secret = tmp_path / "secret"
    secret.write_text(canary)
    text = CONFIG.format(endpoint=f"!!binary {_b64('${file:' + str(secret) + '}')}")

    # The attack, on the text as written: the collector decodes the value,
    # reads the file and quotes it.
    outcome = await raw_validate(version, text)
    assert canary in outcome.stderr

    # The service: refused, the collector never run, the file never read.
    result = await check(version, text)
    assert result.valid is False
    assert result.outcome == "refused"
    assert result.errors == [{"message": BINARY_MESSAGE, "componentPath": None}]
    assert canary not in repr(result)
