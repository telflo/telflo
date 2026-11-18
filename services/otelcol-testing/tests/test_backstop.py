"""The backstop (D14a Preflight ruling 3, reimplemented from the validator's
`runner._backstop`): on the exact text a collector is about to read, a text
that no longer reads as one YAML document, or still holds a live non-`env`
reference in a decoded key or value, is refused, and no collector starts.

The run's own order is checked in-process (`app.run.execute`, as the run's
child calls it): a neutraliser that let a reference through, or a mutation
(D14a Task 4's seam) that brought one back, is caught here."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app import run as run_module
from app.neutralise import (
    REFUSED_PROVIDERS_MESSAGE,
    UNCHECKED_MESSAGE,
    Neutralised,
    Refusal,
    backstop,
    neutralise,
)
from app.run import RunRequest, Strategy, execute
from tests.conftest import VERSION, write_collector


def test_a_clean_text_passes() -> None:
    assert backstop("a: ${env:HOME}\nb: $${file:/x}\nc: plain\n", []) is None
    assert backstop("a: otelvalidatorplaceholder00000000\n", ["file"]) is None


@pytest.mark.parametrize(
    "text",
    [
        "a: ${file:/etc/hostname}\n",
        'a: "\\x24{file:/etc/hostname}"\n',
        '"${file:/etc/hostname}": x\n',
        "!!str ${file:/etc/hostname}: x\n",
        "a: &r !!str ${file:/etc/hostname}\nb: *r\n",
        "a: clean\na: ${file:/etc/hostname}\n",
    ],
)
def test_a_surviving_reference_is_refused_naming_its_scheme(text: str) -> None:
    refusal = backstop(text, [])

    assert refusal == Refusal(code="refused", message=REFUSED_PROVIDERS_MESSAGE.format(schemes="file:"))
    assert "/etc/hostname" not in refusal.message


def test_the_refusal_names_the_neutralised_schemes_too() -> None:
    refusal = backstop("a: ${http://x}\n", ["file", "org"])

    assert refusal is not None
    assert refusal.message == REFUSED_PROVIDERS_MESSAGE.format(schemes="file:, http:, org:")


def test_a_text_that_no_longer_reads_as_one_document_is_refused() -> None:
    assert backstop("a: [unclosed\n", ["file"]) == Refusal(
        code="refused", message=REFUSED_PROVIDERS_MESSAGE.format(schemes="file:")
    )
    assert backstop("a: 1\n---\nb: 2\n", []) == Refusal(code="refused", message=UNCHECKED_MESSAGE)
    assert backstop("a: " + "[" * 120 + "]" * 120 + "\n", []) == Refusal(code="refused", message=UNCHECKED_MESSAGE)


def test_neutralise_then_backstop_passes_every_form() -> None:
    for text in (
        "a: ${file:/x}\n",
        'a: "\\u0024{file:/x}"\n',
        'a: "$\\\n  {file:/x}"\n',
        "a: !!str ${file:/x}\n",
        "!!str ${file:/x}: y\n",
        'a: {b: "${file:/x}"}\n',
        "a: &r ${file:/x}\nb: *r\n",
    ):
        neutralised = neutralise(text)
        assert isinstance(neutralised, Neutralised), text
        assert neutralised.schemes == ["file"], text
        assert backstop(neutralised.text, neutralised.schemes) is None, text


# ---------------------------------------------------------------------------
# In the run: nothing starts once the backstop refuses
# ---------------------------------------------------------------------------


def _request(binary: Path, workspace: Path, text: str) -> RunRequest:
    return RunRequest(
        binary=binary,
        yaml=text,
        pipeline="logs",
        signal="logs",
        duration_seconds=1,
        version=VERSION,
        workspace=workspace,
    )


@pytest.fixture
def marked(binary_dir: Path, tmp_path: Path) -> tuple[Path, Path, Path]:
    marker = tmp_path / "collector-ran"
    binary = write_collector(binary_dir, VERSION, f"touch {marker}\nexit 0\n")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    # The service stages the input before the child runs (app/runner.py).
    (workspace / "input.raw").write_bytes(b'{"resourceLogs":[]}')
    return binary, workspace, marker


def test_a_neutraliser_that_lets_a_reference_through_is_caught(
    marked: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    binary, workspace, marker = marked
    text = "a: ${file:/etc/hostname}\n"
    monkeypatch.setattr(run_module, "neutralise", lambda value: Neutralised(text=value, schemes=[], mutations=[]))

    answer = asyncio.run(execute(_request(binary, workspace, text)))

    assert answer["status"] == "failed"
    assert answer["error"] == {"code": "refused", "message": REFUSED_PROVIDERS_MESSAGE.format(schemes="file:")}
    assert answer["mutatedYaml"] is None
    assert not marker.exists()
    assert not (workspace / "config.yaml").exists()


def test_a_mutation_that_brings_a_reference_back_is_caught(
    marked: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Task 4's mutations run between the neutraliser and the backstop; one
    that added a reference (here, the seam returning one) never runs."""
    binary, workspace, marker = marked
    monkeypatch.setattr(
        run_module,
        "_prepare_strategy",
        lambda request, text: Strategy(text=text + "b: ${file:/etc/hostname}\n"),
    )

    answer = asyncio.run(execute(_request(binary, workspace, "a: ${file:/x}\n")))

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert answer["error"]["message"] == REFUSED_PROVIDERS_MESSAGE.format(schemes="file:")
    # R-105's advisory still says what was neutralised.
    assert [m["id"] for m in answer["mutations"]] == ["R-105"]
    assert not marker.exists()


def test_the_backstop_reads_the_exact_text_the_collector_gets(
    marked: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    binary, workspace, _ = marked
    checked: list[str] = []
    real = run_module.backstop

    def recording(text: str, schemes: list[str]):
        checked.append(text)
        return real(text, schemes)

    monkeypatch.setattr(run_module, "backstop", recording)
    monkeypatch.setattr(run_module, "_prepare_strategy", lambda request, text: Strategy(text=text + "# mutated\n"))
    write_collector(binary.parent.parent, VERSION, f'cp "$2" {workspace.parent}/as-read\nexit 0\n')

    answer = asyncio.run(execute(_request(binary, workspace, "a: ${file:/x}\n")))

    assert answer["status"] == "succeeded"
    assert checked == [(workspace.parent / "as-read").read_text()]
    assert checked[0].endswith("# mutated\n")
