"""D13b ruling 37: the `${env:` reference scan and the brace matching are
linear, and answer exactly as the scanning versions (tests/verbatim.py) do.

The scanning versions cost the square of the text's length on
unterminated references: `_ENV_REF_RE`'s `[^}]*` ran to the end of the value
from every `${env:A:-` (236 KB: 47 s), and `_find_matching_brace` scanned to
the end from every unbalanced `${org:` (225 KB: 568 s) or `${a:`. Each was
bounded only by the check's deadline, holding a slot 12 s.

Two kinds of test: a differential fuzz (seeded, a fixed number of texts)
that the service's versions answer as the scanning ones on every text, and
metered runs at the reviewer's sizes that count what is scanned (characters
read by the string operations and the regexes, or Python lines run) and stop
the moment the count passes a budget linear in the text's length. Neither
measures time.
"""

from __future__ import annotations

import random
import re
import sys
from pathlib import Path

import pytest

from app import placeholders, providers, requirements, runner
from tests import verbatim

# ---------------------------------------------------------------------------
# The differential fuzz
# ---------------------------------------------------------------------------

# Pieces that make references, escapes, defaults and braces likely.
PIECES = ["$", "$$", "{", "}", "}}", ":", ":-", "-", "${", "${env:", "${org:", "${file:", "${ORG:", "env", "org",
          "a", "A", "_", "9", ".", " ", "\n", "x", "${env:A}", "${org:B}"]
SEED = 20261006
TEXTS = 20_000


def _texts(count: int = TEXTS, longest: int = 40) -> list[str]:
    rng = random.Random(SEED)
    return ["".join(rng.choice(PIECES) for _ in range(rng.randint(0, longest))) for _ in range(count)]


def _original_env_references(value: str) -> list[tuple[str, str | None, str]]:
    return [(m.group("name"), m.group("default"), m.group(0)) for m in verbatim._ENV_REF_RE.finditer(value)]


def test_the_fuzz_reaches_every_branch() -> None:
    """The texts hold balanced and unbalanced references of each kind."""
    texts = _texts()
    assert sum("${org:" in t and t.count("{") > t.count("}") for t in texts) > 1_000
    assert sum(bool(_original_env_references(t)) for t in texts) > 1_000
    assert sum(any(d is not None for _, d, _ in _original_env_references(t)) for t in texts) > 100
    assert sum(bool(verbatim._neutralize_str(t, "PH")[1]) for t in texts) > 1_000


def test_neutralize_str_answers_as_telflo_apps() -> None:
    for text in _texts():
        assert providers._neutralize_str(text, "PH") == verbatim._neutralize_str(text, "PH"), text


def test_matching_braces_finds_what_telflo_apps_scan_finds() -> None:
    for text in _texts():
        matches = providers._matching_braces(text)
        for i, char in enumerate(text):
            if char == "{":
                assert matches.get(i, -1) == verbatim._find_matching_brace(text, i), (text, i)


def test_live_organization_references_answers_as_telflo_apps() -> None:
    for text in _texts():
        assert requirements.live_organization_references(text) == verbatim.live_organization_references(text), text


def test_env_references_find_what_telflo_apps_expression_finds() -> None:
    for text in _texts():
        assert placeholders._env_references(text) == _original_env_references(text), text


# ---------------------------------------------------------------------------
# Metered at the reviewer's sizes
# ---------------------------------------------------------------------------

ENV_TEXT = 'x: "' + "${env:A:-" * 26_214 + '"\n'  # 235,932 characters
ORGANIZATION_TEXT = 'x: "' + "${org:" * 37_450 + '"\n'  # 224,706 characters
UNBALANCED_TEXT = 'x: "' + "${a:" * 65_534 + '"\n'  # 262,142 characters
# Characters scanned per character of the text, at most.
PER_CHARACTER = 8


class Overrun(AssertionError):
    pass


class _Meter:
    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.scanned = 0

    def add(self, characters: int) -> None:
        self.scanned += characters
        if self.scanned > self.budget:
            raise Overrun(f"scanned more than {self.budget} characters")


def _metered(text: str, meter: _Meter) -> str:
    """`text` as a str that counts the characters its operations read."""

    class Metered(str):
        def __getitem__(self, key):  # noqa: ANN001
            value = str.__getitem__(self, key)
            meter.add(len(value) if isinstance(key, slice) else 1)
            return value

        def __iter__(self):
            for char in str.__iter__(self):
                meter.add(1)
                yield char

        def find(self, sub, start=0, end=None):  # noqa: ANN001
            stop = len(self) if end is None else end
            found = str.find(self, sub, start, stop)
            meter.add(max(1, (stop if found == -1 else found + len(sub)) - start))
            return found

        def startswith(self, prefix, start=0, end=None):  # noqa: ANN001
            stop = len(self) if end is None else end
            common = 0
            while common < len(prefix) and start + common < stop and str.__getitem__(self, start + common) == prefix[common]:
                common += 1
            meter.add(min(len(prefix), common + 1))
            return common == len(prefix)

    return Metered(text)


class _MeteredPattern:
    """A one-class pattern (`[…][…]*`): a match reads its run and the
    character after it."""

    def __init__(self, pattern: re.Pattern, meter: _Meter) -> None:
        self.pattern, self.meter = pattern, meter

    def match(self, string: str, pos: int = 0):  # noqa: ANN201
        found = self.pattern.match(str(string), pos)
        self.meter.add((found.end() if found else pos) - pos + 1)
        return found


@pytest.fixture
def meter(monkeypatch: pytest.MonkeyPatch) -> _Meter:
    meter = _Meter(budget=0)
    monkeypatch.setattr(providers, "_SCHEME_CHARS_RE", _MeteredPattern(providers._SCHEME_CHARS_RE, meter))
    if hasattr(placeholders, "_ENV_NAME_RE"):
        monkeypatch.setattr(placeholders, "_ENV_NAME_RE", _MeteredPattern(placeholders._ENV_NAME_RE, meter))
    return meter


def _value(text: str) -> str:
    """The scalar the walks see (between the quotes)."""
    return text[len('x: "') : -len('"\n')]


@pytest.mark.parametrize("size", [0.5, 1.0])
def test_the_env_reference_scan_reads_each_character_a_bounded_number_of_times(meter: _Meter, size: float) -> None:
    value = _value(ENV_TEXT)[: int(len(ENV_TEXT) * size)]
    meter.budget = PER_CHARACTER * len(value)

    assert placeholders._env_references(_metered(value, meter)) == []  # within the budget, or Overrun


@pytest.mark.parametrize("size", [0.5, 1.0])
def test_the_organization_scan_reads_each_character_a_bounded_number_of_times(meter: _Meter, size: float) -> None:
    text = ORGANIZATION_TEXT[: int(len(ORGANIZATION_TEXT) * size)]
    meter.budget = PER_CHARACTER * len(text)

    assert requirements.live_organization_references(_metered(text, meter)) == []


@pytest.mark.parametrize("text", [UNBALANCED_TEXT, ORGANIZATION_TEXT], ids=["unbalanced-a", "unbalanced-org"])
def test_the_neutralisation_reads_each_character_a_bounded_number_of_times(meter: _Meter, text: str) -> None:
    meter.budget = PER_CHARACTER * len(text)

    rewritten, schemes = providers._neutralize_str(_metered(text, meter), "PH")

    assert len(schemes) == text.count("${")  # each escaped, none left live
    assert rewritten.count("$${") == text.count("${")


# The whole pre-processing, in Python lines run in app/ (each regex and
# string operation it calls is metered above, or is the YAML parser's). It
# reads the text several times over (the organization variables, the
# neutralisation's check, then the neutralisation, both over the brace
# table): about 30 lines a character for the `${org:` and `${a:` texts.
APP = str(Path(providers.__file__).parent)
PER_CHARACTER_LINES = 40


def _lines_run(function, *args, budget: int) -> int:  # noqa: ANN001
    count = 0

    def tracer(frame, event, arg):  # noqa: ANN001 - sys.settrace's signature
        nonlocal count
        if not frame.f_code.co_filename.startswith(APP):
            return None
        if event == "line":
            count += 1
            if count > budget:
                raise Overrun(f"ran more than {budget} lines")
        return tracer

    previous = sys.gettrace()
    sys.settrace(tracer)
    try:
        function(*args)
    finally:
        sys.settrace(previous)
    return count


@pytest.mark.parametrize("text", [ENV_TEXT, ORGANIZATION_TEXT, UNBALANCED_TEXT], ids=["env", "org", "a"])
def test_the_reviewers_texts_pre_process_in_work_linear_in_their_size(text: str) -> None:
    half = text[: len(text) // 2] + '"\n'

    lines_half = _lines_run(runner._prepare, half, budget=PER_CHARACTER_LINES * len(half))
    lines_whole = _lines_run(runner._prepare, text, budget=PER_CHARACTER_LINES * len(text))

    assert lines_whole <= 2.2 * lines_half
