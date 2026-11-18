"""The stanza operators' allowlist (C-004)."""

from __future__ import annotations

from app.operator_allowlist import (
    ALLOWED_OPERATOR_TYPES,
    disallowed_operator_in_receiver,
    disallowed_operator_reason,
)


def test_all_allowlisted_types_pass() -> None:
    ops = [{"type": t} for t in sorted(ALLOWED_OPERATOR_TYPES)]
    assert disallowed_operator_reason(ops) is None


def test_unknown_type_refused() -> None:
    reason = disallowed_operator_reason([{"type": "regex_parser"}, {"type": "exec"}])
    assert reason is not None
    assert "exec" in reason


def test_missing_type_refused() -> None:
    reason = disallowed_operator_reason([{"id": "p1"}])
    assert reason is not None
    assert "missing" in reason.lower()


def test_non_string_type_refused() -> None:
    assert disallowed_operator_reason([{"type": 123}]) is not None


def test_empty_chain_is_allowed() -> None:
    assert disallowed_operator_reason([]) is None


def test_non_list_input_refused() -> None:
    assert disallowed_operator_reason({"type": "regex_parser"}) is not None


# ---------------------------------------------------------------------------
# disallowed_operator_in_receiver: walks every operator chain in a
# filelog/syslog receiver config. Critical because synthesize_filelog
# passes `header` through verbatim, and `header.metadata_operators` is an
# operator chain the collector executes against user-controlled bytes.
# Without this walk, a user could smuggle a non-allowlisted operator type
# into header.metadata_operators and bypass C-004.
# ---------------------------------------------------------------------------


def test_in_receiver_top_level_clean_passes() -> None:
    cfg = {"operators": [{"type": "regex_parser"}, {"type": "add"}]}
    assert disallowed_operator_in_receiver(cfg) is None


def test_in_receiver_top_level_violation_returned_unprefixed() -> None:
    """Top-level chain violations keep the existing message shape so the
    user-facing wording (and existing C-004 tests) don't change."""
    cfg = {"operators": [{"type": "exec"}]}
    reason = disallowed_operator_in_receiver(cfg)
    assert reason is not None
    assert "exec" in reason
    assert not reason.startswith("header.")


def test_in_receiver_header_metadata_operators_bypass_caught() -> None:
    """THE bug: a non-allowlisted operator hidden inside
    header.metadata_operators used to pass C-004 because the old check
    only looked at top-level `operators`. It must now refuse."""
    cfg = {
        "operators": [{"type": "regex_parser"}],  # clean top-level
        "header": {
            "pattern": "^#",
            "metadata_operators": [{"type": "exec"}],  # smuggled
        },
    }
    reason = disallowed_operator_in_receiver(cfg)
    assert reason is not None
    assert "exec" in reason


def test_in_receiver_nested_violation_message_names_the_location() -> None:
    """Refusal must tell the user exactly which chain has the bad op so
    they can find it without grepping their config."""
    cfg = {
        "header": {
            "metadata_operators": [{"type": "totally_unknown"}],
        },
    }
    reason = disallowed_operator_in_receiver(cfg)
    assert reason is not None
    assert reason.startswith("header.metadata_operators:")
    assert "totally_unknown" in reason


def test_in_receiver_clean_header_metadata_operators_passes() -> None:
    cfg = {
        "operators": [{"type": "noop"}],
        "header": {
            "pattern": "^#",
            "metadata_operators": [
                {"type": "regex_parser"},
                {"type": "add"},
            ],
        },
    }
    assert disallowed_operator_in_receiver(cfg) is None


def test_in_receiver_no_header_key_is_fine() -> None:
    cfg = {"operators": [{"type": "regex_parser"}]}
    assert disallowed_operator_in_receiver(cfg) is None


def test_in_receiver_header_without_metadata_operators_is_fine() -> None:
    """A header block with only `pattern` (no operator chain) is valid."""
    cfg = {
        "operators": [{"type": "noop"}],
        "header": {"pattern": "^#"},
    }
    assert disallowed_operator_in_receiver(cfg) is None


def test_in_receiver_non_dict_returns_none() -> None:
    """Defensive against malformed YAML that parses to a non-dict — the
    compatibility layer's other rules will catch the structural issue."""
    assert disallowed_operator_in_receiver(None) is None
    assert disallowed_operator_in_receiver([]) is None
    assert disallowed_operator_in_receiver("not a dict") is None


def test_in_receiver_top_level_takes_precedence_over_nested() -> None:
    """Two violations: top-level wins so the user fixes the most visible
    one first. Either ordering is defensible — pin the current behavior."""
    cfg = {
        "operators": [{"type": "top_level_bad"}],
        "header": {"metadata_operators": [{"type": "nested_bad"}]},
    }
    reason = disallowed_operator_in_receiver(cfg)
    assert reason is not None
    assert "top_level_bad" in reason
    assert "nested_bad" not in reason


def test_in_receiver_malformed_header_does_not_crash() -> None:
    """If `header` parses as a non-dict (e.g. user wrote a string),
    treat it as no header. Don't AttributeError."""
    cfg = {"operators": [{"type": "noop"}], "header": "garbage"}
    assert disallowed_operator_in_receiver(cfg) is None
