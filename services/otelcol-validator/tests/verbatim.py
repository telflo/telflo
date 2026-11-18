"""The scanning functions as 207bc02 held them (D13b Preflight rulings 1
and 11): the reference the service's linear versions are compared with
(D13b ruling 37, tests/test_linear_scans.py). Not used by the service: each
costs the square of its input's length on unbalanced or unterminated
references.

`_disallowed_confmap_schemes` is the raw-text scan, as 4a66e26 held it in
providers.py: the service never scans the raw text (references are found on
the decoded nodes, and a text PyYAML can't read never reaches the
neutraliser), so it is kept here for the tests that compare with it (D13b
ruling 44).
"""

from __future__ import annotations

import re

from app.placeholders import _DEFAULT_PLACEHOLDER

_ALLOWED_CONFMAP_SCHEMES: frozenset[str] = frozenset({"env"})


_SCHEME_CHARS_RE = re.compile(r"[A-Za-z][A-Za-z0-9._-]*")


def _preceding_dollar_run_even(value: str, i: int) -> bool:
    """True if an even number of ``$`` immediately precede index ``i``.

    An even preceding run means the ``$`` at ``i`` opens a total ``$``-run of
    odd length, which confmap expands as a live ``${...}`` reference. An odd
    preceding run means the ``$`` at ``i`` is the trailing half of a ``$$``
    escape pair and the reference it opens is inert.
    """
    k = i - 1
    count = 0
    while k >= 0 and value[k] == "$":
        count += 1
        k -= 1
    return count % 2 == 0


def _find_matching_brace(s: str, open_idx: int) -> int:
    """Index of the ``}`` matching the ``{`` at ``open_idx``, or -1 if the
    braces are unbalanced. Counts nesting so ``${yaml:{...}}`` is handled."""
    depth = 0
    for i in range(open_idx, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _neutralize_str(value: str, placeholder: str) -> tuple[str, list[str]]:
    """Replace every non-``env`` ``${scheme:...}`` reference in ``value`` with
    ``placeholder``. Returns ``(new_value, schemes_neutralized)``.

    ``env:`` references and confmap-escaped ``$${...}`` forms (an even run of
    ``$`` before ``{``) are left intact. A reference with unbalanced braces
    (no findable end) is neutralized by escaping its ``$`` to ``$$`` so confmap
    treats it as a literal. By construction no disallowed provider reference
    survives this transform.
    """
    out: list[str] = []
    schemes: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        if value[i] == "$" and i + 1 < n and value[i + 1] == "{" and _preceding_dollar_run_even(value, i):
            m = _SCHEME_CHARS_RE.match(value, i + 2)
            if m and m.end() < n and value[m.end()] == ":":
                scheme = m.group(0)
                if scheme.lower() not in _ALLOWED_CONFMAP_SCHEMES:
                    end = _find_matching_brace(value, i + 1)
                    if end != -1:
                        out.append(placeholder)
                        schemes.append(scheme)
                        i = end + 1
                        continue
                    # Unbalanced braces: escape the "$" (append an extra "$"
                    # then fall through to copy the original) → literal "$${..".
                    out.append("$")
                    schemes.append(scheme)
        out.append(value[i])
        i += 1
    return "".join(out), schemes


def _disallowed_confmap_schemes(yaml_content: str) -> list[str]:
    """Return the sorted, de-duplicated non-``env`` confmap provider schemes
    that would be *live-expanded* anywhere in ``yaml_content``. Empty list
    means the config only uses the permitted ``env:`` provider (or no live
    providers at all).

    Detection is delegated to ``_neutralize_str`` so it can never diverge from
    what neutralization actually rewrites: any scheme the neutralizer records
    is a scheme this reports, and vice versa. Scans the raw text rather than
    the parsed doc so a config that fails to parse — or hides a reference in a
    mapping key the parsed walk doesn't visit — still can't smuggle a live
    provider reference past this check.
    """
    _, schemes = _neutralize_str(yaml_content, _DEFAULT_PLACEHOLDER)
    return sorted(set(schemes))


def live_organization_references(text: str) -> list[str]:
    """Bodies of live ``${org:...}`` references, in first-seen order, deduped.

    Returns the text between ``${org:`` and its matching ``}`` — normally a
    bare variable name, but ``HOST:-fallback`` when the author reached for
    confmap's ``:-`` default syntax, which organization variables do not
    support.

    Case-sensitive on the ``${org:`` prefix: ``${ORG:X}`` is not an
    organization variable, even though the neutraliser still classifies it as
    a foreign scheme via ``scheme.lower()`` — that is a separate, correct
    concern (nothing not `env:` reaches the collector).

    Deliberately separate from ``_neutralize_str``: that function is
    security-critical and total, and this only reads.
    """
    found: dict[str, None] = {}
    i = 0
    n = len(text)
    prefix = "${org:"
    while i < n:
        if text.startswith(prefix, i) and _preceding_dollar_run_even(text, i):
            end = _find_matching_brace(text, i + 1)
            if end != -1:
                found.setdefault(text[i + len(prefix) : end])
                i = end + 1
                continue
        i += 1
    return list(found)


_ENV_REF_RE = re.compile(r"\$\{env:(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<default>:-[^}]*)?\}")

