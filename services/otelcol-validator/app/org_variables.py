"""The organization's values filled in before every check (D20 decisions 8,
13, 16, 27 and 36; Preflight rulings 12 and 30).

The validator's port of the opamp-server's fill-in (`store/orgvariables`,
`render.go`), held to it by the shared corpus
(`vendor/opamp-server/org-token-corpus.json`, the pinned release's, read by
`tests/test_org_variables.py`):

- a live reference is `${org:NAME}`, NAME the grammar
  `[A-Za-z_][A-Za-z0-9_]*` of any length, opened by a `$` that an EVEN run
  of `$` precedes (`_preceding_dollar_run_even`: an odd run makes it the
  trailing half of a `$$` escape, inert);
- the legacy `$orgvar:NAME` form is plain text, filled in by nothing
  (decision 16), and so is `${org:NAME:-default}`;
- a known NAME's value is written with every `$` doubled, so the
  collector's own confmap pass, which collapses `$$` to `$`, reads the value
  exactly: a value `${env:X}` stays that text, and a value's `${org:X}` is
  never filled in again;
- an unknown NAME is left as written;
- there is no YAML round trip: the text around each reference is the text
  sent.

One scanner (`_scan`) serves `references`, `rendered_length` and `render`,
so they can't disagree. The length comes first (Preflight ruling 12): a
text of about 100,000 references to a value of 1,024 `$` fills in to about
200 MB, so the caller measures it and refuses it over `MAX_RENDERED_BYTES`
without building it.

Values are configuration text (ADR 0024, Q88): nothing here logs.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping

from app.providers import _preceding_dollar_run_even

_OPENER = "${org:"
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# The opamp-server's bounds (`store/orgvariables`): a variable's name is at
# most 128 characters, so a longer live reference is never filled in, and a
# filled-in text over 1 MiB of UTF-8 is never served.
MAX_NAME_LENGTH = 128
MAX_RENDERED_BYTES = 1 << 20


def _scan(text: str) -> Iterator[tuple[int, int, str]]:
    """(start, end, NAME) of each live reference in `text`, in order. Each
    `${org:` is found once (`str.find`), so the scan is linear in the text."""
    i = 0
    n = len(text)
    while True:
        start = text.find(_OPENER, i)
        if start < 0:
            return
        name = _NAME_RE.match(text, start + len(_OPENER))
        if name is None or name.end() >= n or text[name.end()] != "}":
            i = start + 1
            continue
        end = name.end() + 1
        if _preceding_dollar_run_even(text, start):
            yield start, end, name.group()
        i = end


def escape(value: str) -> str:
    """`value` with every `$` written `$$` (decision 8)."""
    return value.replace("$", "$$")


def references(text: str) -> list[str]:
    """Every live reference's NAME in `text`, defined or not, each once, in
    the order first seen: the opamp-server's `References`."""
    return list(dict.fromkeys(name for _, _, name in _scan(text)))


def _utf8_length(value: str) -> int:
    return len(value.encode("utf-8"))


def rendered_length(text: str, values: Mapping[str, str]) -> tuple[int, list[str]]:
    """The length in bytes of UTF-8 of `text` filled in with `values`,
    counted without building it, and `references(text)`. Each name's value
    is measured once, however often the text references it."""
    n = _utf8_length(text)
    names: dict[str, int] = {}  # each name's escaped value's length, -1 with no value
    for start, end, name in _scan(text):
        length = names.get(name)
        if length is None:
            value = values.get(name)
            length = -1 if value is None else _utf8_length(value) + value.count("$")
            names[name] = length
        if length >= 0:
            n += length - (end - start)  # a reference is ASCII: its characters are its bytes
    return n, list(names)


def render(text: str, values: Mapping[str, str]) -> tuple[str, list[str]]:
    """`text` filled in with `values`, and `references(text)`. A text in
    which nothing is filled in comes back as it is. The caller measures
    first (`rendered_length`): this builds whatever length the fill-in comes
    to."""
    names: list[str] = []
    seen: set[str] = set()
    escaped: dict[str, str] = {}
    pieces: list[str] = []
    cursor = 0
    for start, end, name in _scan(text):
        if name not in seen:
            seen.add(name)
            names.append(name)
            if name in values:
                escaped[name] = escape(values[name])
        filled = escaped.get(name)
        if filled is None:
            continue  # an unknown name is left as written
        pieces.append(text[cursor:start])
        pieces.append(filled)
        cursor = end
    if not pieces:
        return text, names
    pieces.append(text[cursor:])
    return "".join(pieces), names
