"""Fail-closed allowlist for stanza operators in synthesized filelog/syslog
test receivers.

Only known, pure pdata-transform operators may run in the sandbox. Every
operator ``type`` the user wrote must be in ``ALLOWED_OPERATOR_TYPES`` or
the run is refused (compatibility C-004) before any subprocess spawns.

Why an allowlist rather than a denylist: new operators are added to
otelcol-contrib regularly. A denylist would silently let a future
operator with side effects execute. Fail-closed means an unrecognized
type stops the run and forces a human review before it can ever run.

The expression-bearing operators (`filter`, `router`, `add` with
EXPR(...), `recombine` conditions) ARE allowed: stanza's expr engine is
sandboxed to the log entry — no env, filesystem, or exec — and that
engine is the trust boundary, exactly as OTTL is for the `transform`
processor today.
"""

from __future__ import annotations

from typing import Any

# Pure pdata transforms only. Input operators (the file/socket source)
# are never user-supplied here — the sandbox synthesizes the source — so
# they are intentionally absent and would be refused if smuggled in.
ALLOWED_OPERATOR_TYPES: frozenset[str] = frozenset(
    {
        # parsers
        "json_parser",
        "regex_parser",
        "csv_parser",
        "key_value_parser",
        "uri_parser",
        "scope_name_parser",
        "severity_parser",
        "time_parser",
        "trace_parser",
        "syslog_parser",
        "container",
        # transformers
        "add",
        "copy",
        "move",
        "remove",
        "retain",
        "flatten",
        "filter",
        "router",
        "recombine",
        "unquote",
        "assign_keys",
        "noop",
    }
)


def disallowed_operator_reason(operators: Any) -> str | None:
    """Return None if every operator's ``type`` is allowlisted, else a
    short human reason string naming the offending operator.

    Checks **one** operator chain only. Use ``disallowed_operator_in_receiver``
    for filelog/syslog configs — those can also embed an operator chain
    under ``header.metadata_operators`` that this function won't see.

    An empty or absent chain returns None (a no-op receiver is valid;
    other constraints are enforced by the compatibility layer).
    """
    if operators in (None, []):
        return None
    if not isinstance(operators, list):
        return f"operators must be a list, got {type(operators).__name__}"
    for i, op in enumerate(operators):
        if not isinstance(op, dict) or "type" not in op:
            return f"operator #{i} is missing a `type` field"
        op_type = op["type"]
        if not isinstance(op_type, str):
            return f"operator #{i} has a non-string `type`"
        if op_type not in ALLOWED_OPERATOR_TYPES:
            return (
                f"operator #{i} type `{op_type}` is not in the sandbox "
                f"allowlist; this operator cannot be safely tested"
            )
    return None


# Locations within a filelog/syslog receiver config that hold an operator
# chain. The top-level ``operators`` key is the obvious one; ``header`` (on
# filelog) embeds ``metadata_operators`` for parsing the header line. Both
# get executed by the collector against user-controlled bytes, so both need
# allowlist enforcement.
#
# Each entry is the tuple of dict keys to traverse from the receiver root
# down to the operator list. ``synthesize_filelog`` copies ``header`` through
# verbatim (it's in ``_FILELOG_KEEP_KNOBS``), so anything inside ``header``
# reaches the executed config without further filtering. Keep this list in
# sync with anything ``synthesize_filelog`` / ``synthesize_syslog`` pass
# through that can hold an ``operators``-shaped list.
_NESTED_OPERATOR_CHAINS: tuple[tuple[str, ...], ...] = (
    ("header", "metadata_operators"),
)


def disallowed_operator_in_receiver(receiver_cfg: Any) -> str | None:
    """Walk every operator chain in a filelog/syslog receiver config and
    return the first allowlist violation, or None.

    Beyond the top-level ``operators`` chain, this also checks nested
    locations enumerated in ``_NESTED_OPERATOR_CHAINS``. The compatibility
    layer used to only check the top level; user YAML could smuggle a
    disallowed operator type into ``header.metadata_operators`` and bypass
    the allowlist (Finding #1 in the secure-filelog-syslog review).

    The returned reason is prefixed with the nested path (e.g.,
    ``"header.metadata_operators: operator #0 ..."``) so the user-visible
    refusal points at the exact location of the offending operator.
    """
    if not isinstance(receiver_cfg, dict):
        return None

    reason = disallowed_operator_reason(receiver_cfg.get("operators"))
    if reason is not None:
        return reason

    for path in _NESTED_OPERATOR_CHAINS:
        node: Any = receiver_cfg
        for key in path[:-1]:
            if not isinstance(node, dict):
                node = None
                break
            node = node.get(key)
        if not isinstance(node, dict):
            continue
        chain = node.get(path[-1])
        reason = disallowed_operator_reason(chain)
        if reason is not None:
            return f"{'.'.join(path)}: {reason}"

    return None
