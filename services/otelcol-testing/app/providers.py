"""Confmap provider neutralization: every non-`env` provider reference is
replaced with a placeholder before the collector sees the text, with
parity-aware escaping, and the caller refuses to run the collector if one
survives. References are found on the decoded keys and values of a text PyYAML
reads as one document and spliced out by node position; a text it can't read
never reaches here, and there is no raw-text scan or fallback in the service
(an earlier raw-text scan is kept in tests/verbatim.py for the tests that
compare with it).

Brace matching is linear: scanning from each reference to its closing brace
made a text of unbalanced `${a:` cost the square of its length (a 240 KB text
ran for minutes). `_matching_braces` finds every brace's match in one pass, and
`_neutralize_str` looks its references up there; the answers are the same as
the scanning version's (tests/test_linear_scans.py runs it, kept in
tests/verbatim.py, against these on random texts).
"""

from __future__ import annotations

import json
import re

from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

# The bounded loader, bound as `yaml`: every parse here goes through its
# bounds.
from app import bounded_yaml as yaml
from app.placeholders import _infer_placeholder

# ---------------------------------------------------------------------------
# Confmap provider allowlist (secret-exfiltration defense)
# ---------------------------------------------------------------------------
#
# The collector's confmap layer expands ``${scheme:uri}`` in every string value
# of the config at config-load time — including during ``validate``. We scrub
# the ``env:`` provider via ``_ALLOWED_PARENT_ENV`` so secrets never reach the
# subprocess, but confmap also ships ``file:``, ``http:``, ``https:`` and
# ``yaml:`` providers. ``endpoint: "${file:/proc/1/environ}"`` reads the parent
# process env and the substituted value is echoed back through validation error
# messages; ``${http://169.254.169.254/...}`` reaches cloud metadata. Only the
# ``env:`` provider is permitted; any other scheme is replaced with a typed
# placeholder before the collector loads the config (see
# ``neutralize_providers``) so the rest of the config still validates.
#
# Escape handling (SECURITY-CRITICAL): confmap treats ``$$`` as an escape that
# collapses to a single literal ``$`` in one left-to-right pass, then keeps
# scanning. So a run of N ``$`` immediately before ``{`` is a LIVE expansion
# iff N is odd — ``${x}`` (1) and ``$$${x}`` (3) expand; ``$${x}`` (2) and
# ``$$$${x}`` (4) are inert literals. A naive "any ``${`` not preceded by a
# ``$`` is live" check (the old ``(?<!\$)`` regex) mis-classified ``$$${file:}``
# as escaped and let it through — the triple-dollar exfiltration bypass. Both
# detection and neutralization now key off the *parity* of the preceding ``$``
# run via ``_preceding_dollar_run_even`` so every odd-run reference is caught.
_ALLOWED_CONFMAP_SCHEMES: frozenset[str] = frozenset({"env"})
_SCHEME_CHARS_RE = re.compile(r"[A-Za-z][A-Za-z0-9._-]*")

# Telflo-owned pseudo-schemes. These are NOT added to _ALLOWED_CONFMAP_SCHEMES:
# `org` is not a registered confmap provider, so a token that reached the
# collector would fail config load outright. They are still neutralized like
# any other foreign scheme — the difference is purely in reporting: a
# ${org:...} arriving here is reported as an unresolved organization variable
# (the values are filled in before this runs, so one left names a variable with
# no value), which beats the component-level error the placeholder would
# otherwise produce.
_TELFLO_SCHEMES: frozenset[str] = frozenset({"org"})


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


def _matching_braces(s: str) -> dict[int, int]:
    """For every ``{`` in ``s`` that is balanced, the index of its matching
    ``}``; an unbalanced one is absent (-1 where looked up). Counts nesting
    so ``${yaml:{...}}`` is handled. One left-to-right pass with a stack: a
    ``{`` is closed by the first ``}`` after it that leaves as many of each
    between them, which is what a ``_find_matching_brace(s, i)`` scanning
    forward from ``i`` finds."""
    matches: dict[int, int] = {}
    opened: list[int] = []
    for i, char in enumerate(s):
        if char == "{":
            opened.append(i)
        elif char == "}" and opened:
            matches[opened.pop()] = i
    return matches


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
    braces: dict[int, int] | None = None  # found once, at the first reference
    i = 0
    n = len(value)
    while i < n:
        if value[i] == "$" and i + 1 < n and value[i + 1] == "{" and _preceding_dollar_run_even(value, i):
            m = _SCHEME_CHARS_RE.match(value, i + 2)
            if m and m.end() < n and value[m.end()] == ":":
                scheme = m.group(0)
                if scheme.lower() not in _ALLOWED_CONFMAP_SCHEMES:
                    if braces is None:
                        braces = _matching_braces(value)
                    end = braces.get(i + 1, -1)
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


# ---------------------------------------------------------------------------
# Neutralization by splice
#
# The escape bypass: a YAML double-quoted escape (`"\x24{file:…}"`,
# `"${file:…}"`, an escaped line break between `$` and `{`) hides a live
# `${file:…}` from a raw-text scan, yet the collector decodes the escape and
# expands the reference, and the file's contents come back in the error. The
# re-dump bypass: re-serialising the whole document to carry a placeholder
# changed untouched scalars' types (an unquoted date became a quoted string,
# YAML 1.1 `1:30` became 90, `on` became true), so a text answered differently
# from how its raw form does.
#
# The fix detects references on the DECODED keys and scalar values — PyYAML's
# composed nodes, whose `.value` is what the collector's confmap layer reads —
# and neutralizes each by replacing EXACTLY that node's source span with a
# double-quoted rendering of its neutralized value. Every other byte stays
# as sent: no whole-document re-dump, so nothing drifts. An alias (`*a`) is
# not a node of its own in the composed tree (the composer shares the
# anchored node), so the anchor's node is spliced once and the alias follows.
# ---------------------------------------------------------------------------


def _double_quoted(value: str) -> str:
    """A YAML double-quoted scalar for `value`. JSON's double-quoted string is
    a valid YAML 1.1/1.2 double-quoted scalar (`"`, `\\` and control characters
    escaped, the `\\uXXXX` form among YAML's escapes), so `json.dumps` renders
    it; non-ASCII stays literal in the UTF-8 file."""
    return json.dumps(value, ensure_ascii=False)


def _scalar_content_start(text: str, lo: int, hi: int) -> int:
    """Where a scalar's own text starts inside its node span `text[lo:hi]`,
    after any anchor (`&a`), tag (`!…`), comment or whitespace that PyYAML
    counts as part of the node (its `start_mark` sits before them). The
    anchor and tag must stay attached so an alias to the node still resolves,
    so only the scalar from this index on is replaced."""
    i = lo
    while i < hi:
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c == "&":  # an anchor name: to whitespace or a flow indicator
            i += 1
            while i < hi and text[i] not in " \t\r\n,[]{}":
                i += 1
        elif c == "!":  # a tag: to whitespace
            i += 1
            while i < hi and text[i] not in " \t\r\n":
                i += 1
        elif c == "#":  # a comment: to the end of the line
            while i < hi and text[i] not in "\r\n":
                i += 1
        else:
            break
    return i


def scalar_splice(text: str, node: ScalarNode, new_value: str) -> tuple[int, int, str]:
    """A `(start, end, replacement)` that replaces `node`'s scalar with a
    double-quoted `new_value`, keeping any anchor/tag prefix and any trailing
    line break the span held (a block scalar's span ends with its newline, and
    the key after it needs that line break back)."""
    shift = yaml.mark_offset(text)  # libyaml's uncounted leading BOM
    lo = node.start_mark.index + shift
    hi = node.end_mark.index + shift
    content = _scalar_content_start(text, lo, hi)
    end = hi
    while end > content and text[end - 1] in "\r\n":
        end -= 1
    return lo, hi, text[lo:content] + _double_quoted(new_value) + text[end:hi]


def apply_splices(text: str, splices: list[tuple[int, int, str]]) -> str:
    """Apply non-overlapping `(start, end, replacement)` splices (each a
    distinct node's span) in order; everything between them is byte-identical
    to `text`."""
    out: list[str] = []
    position = 0
    for start, end, replacement in sorted(splices):
        out.append(text[position:start])
        out.append(replacement)
        position = end
    out.append(text[position:])
    return "".join(out)


def _collect_provider_splices(text: str, root: Node) -> tuple[list[tuple[int, int, str]], list[str]]:
    """Every splice that neutralizes a live non-`env` reference in a decoded
    key or scalar value under `root`, and the schemes neutralized. Splices are
    deduped by their start index, so a node reached through several aliases is
    spliced once; a container reached through several aliases is walked once."""
    splices: dict[int, tuple[int, int, str]] = {}
    schemes: list[str] = []
    walked: set[int] = set()

    def consider(node: Node, parent_key: str | None) -> None:
        if not isinstance(node, ScalarNode) or not isinstance(node.value, str):
            return
        new, found = _neutralize_str(node.value, _infer_placeholder(parent_key))
        if not found:
            return
        start = node.start_mark.index
        if start in splices:
            return
        splices[start] = scalar_splice(text, node, new)
        schemes.extend(found)

    def walk(node: Node, parent_key: str | None) -> None:
        if not isinstance(node, (MappingNode, SequenceNode)):
            return
        if id(node) in walked:
            return
        walked.add(id(node))
        if isinstance(node, MappingNode):
            for key_node, value_node in node.value:
                consider(key_node, None)  # a key gets the default placeholder
                walk(key_node, None)
                key = key_node.value if isinstance(key_node, ScalarNode) and isinstance(key_node.value, str) else parent_key
                consider(value_node, key)
                walk(value_node, key)
        else:
            for item in node.value:
                consider(item, parent_key)
                walk(item, parent_key)

    consider(root, None)
    walk(root, None)
    return list(splices.values()), schemes


def neutralize_providers(text: str, root: Node | None) -> tuple[str, list[str]]:
    """Replace every live non-`env` confmap reference in a decoded key or
    scalar value with a type-shaped placeholder, by splicing the node's source
    span. Returns `(rewritten_text, schemes_neutralized)`; `root` is the
    composed document (`bounded_yaml.single_node`), or `None` for an empty
    document (nothing to neutralize)."""
    if root is None:
        return text, []
    splices, schemes = _collect_provider_splices(text, root)
    if not splices:
        return text, []
    return apply_splices(text, splices), sorted(set(schemes))


def live_nonenv_schemes(text: str, root: Node | None) -> list[str]:
    """The sorted, de-duplicated non-`env` schemes a decoded key or scalar
    value still holds (the fail-closed backstop re-scans, with this, the exact
    text each collector run reads; empty means nothing live survived)."""
    if root is None:
        return []
    _, schemes = _collect_provider_splices(text, root)
    return sorted(set(schemes))


# A `!!binary` node (SECURITY-CRITICAL). PyYAML composes its scalar's value as
# the base64 text, but the collector's YAML decoder decodes it to a string
# and confmap expands the references in what it decodes: `!!binary
# JHtmaWxlOi9wcm9jLzEvZW52aXJvbn0=` is `${file:/proc/1/environ}`, which no
# scan of the composed values sees. A text holding one is refused, never
# run. The tag is matched as resolved, so every spelling is caught:
# `!!binary`, `!<tag:yaml.org,2002:binary>` and a `%TAG` handle.
BINARY_TAG = "tag:yaml.org,2002:binary"
BINARY_MESSAGE = (
    "The configuration holds a '!!binary' value, which can't be checked safely, "
    "so it isn't run. Write the value as plain text."
)


def has_binary_node(root: Node | None) -> bool:
    """True when any node under `root` (keys as well as values, each node
    reached through aliases walked once) is tagged `!!binary`."""
    if root is None:
        return False
    seen: set[int] = set()
    stack: list[Node] = [root]
    while stack:
        node = stack.pop()
        if id(node) in seen:
            continue
        seen.add(id(node))
        if node.tag == BINARY_TAG:
            return True
        if isinstance(node, SequenceNode):
            stack.extend(node.value)
        elif isinstance(node, MappingNode):
            for key_node, value_node in node.value:
                stack.append(key_node)
                stack.append(value_node)
    return False


def _neutralize_disallowed_providers(yaml_content: str) -> tuple[str, list[str]]:
    """Compose `yaml_content` and neutralize it (`neutralize_providers`) in
    one call; the tests' entry point (the runner composes once and calls
    `neutralize_providers` itself). Returns `(rewritten_yaml,
    schemes_neutralized)`.

    There is no raw-text fallback: a text PyYAML can't read as one document
    raises `YAMLError` here, and the runner answers such a text invalid before
    anything is neutralized, so it never reaches the collector. `TooDeep` /
    `TooManyAliases` propagate, as every parsing entry point's do."""
    return neutralize_providers(yaml_content, yaml.single_node(yaml_content))
