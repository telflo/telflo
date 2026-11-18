"""Regression tests for the validator's hardened pre-spawn primitives.

The subprocess environment allowlist, the confmap provider neutralisation
(its triple-dollar bypass fix), and the `${org:…}` pseudo-scheme's reporting
(D13b Preflight ruling 1).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import runner
from app.placeholders import VALIDATION_ENV_OVERRIDES
from app.providers import (
    _neutralize_disallowed_providers,
    _neutralize_str,
    _preceding_dollar_run_even,
)
from app.requirements import live_organization_references, organization_variable_requirements
from app.runner import _ALLOWED_PARENT_ENV, _build_subprocess_env

# The raw-text scan: not in the service (D13b ruling 44), kept as the
# reference these tests compare with.
from tests.verbatim import _disallowed_confmap_schemes


async def _passing_run_collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):
    return runner.RunOutcome(kind="passed", returncode=0)


async def _check(yaml_content: str) -> runner.ValidationResult:
    """The check's orchestration as its child process runs it
    (`check_text`), in-process so the collector can be stubbed."""
    return await runner.check_text(Path("/fake/otelcol-contrib"), yaml_content, timeout_seconds=10)


# ---------------------------------------------------------------------------
# Subprocess env allowlist — closes the ${env:VAR} exfiltration vector.
#
# A spawned otelcol-contrib that inherited the full parent env would let a
# submitted YAML exfiltrate the validator's own secret by
# interpolating ``${env:<name>}`` into a typed field; the parser's failure to
# coerce the substituted value emitted it back in the error response. The fix
# replaces the wholesale copy with an explicit allowlist.
# ---------------------------------------------------------------------------


def test_build_subprocess_env_drops_the_validator_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The validator's own secret (current and previous) must never reach
    the subprocess — it's the one secret the deployment injects.
    """
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRET", "canary-do-not-leak-0123456789abcdef")
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRETS_PREVIOUS", "canary-previous-0123456789abcdefgh")
    monkeypatch.setenv("VALIDATOR_API_KEY", "canary-do-not-leak")

    env = _build_subprocess_env()

    assert "OTELCOL_VALIDATOR_SECRET" not in env
    assert "OTELCOL_VALIDATOR_SECRETS_PREVIOUS" not in env
    assert "VALIDATOR_API_KEY" not in env
    assert not any("canary" in value for value in env.values())


def test_build_subprocess_env_drops_other_secret_shaped_parent_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defense-in-depth: any future operator-injected secret should also be
    stripped, even if the deployment doesn't expose it today.
    """
    monkeypatch.setenv("DATABASE_SERVICE_KEY", "super-secret-jwt")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prod-token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-token")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "deadbeef")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_xyz")

    env = _build_subprocess_env()

    for leaked in (
        "DATABASE_SERVICE_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "STRIPE_SECRET_KEY",
    ):
        assert leaked not in env, f"{leaked} leaked into subprocess env"


def test_build_subprocess_env_keeps_allowlisted_parent_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    """PATH and friends must still pass through — without PATH the collector
    binary can't resolve its own libraries on most systems.
    """
    monkeypatch.setenv("PATH", "/usr/local/bin:/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/home/runner")
    monkeypatch.setenv("LANG", "en_US.UTF-8")

    env = _build_subprocess_env()

    assert env["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert env["HOME"] == "/home/runner"
    assert env["LANG"] == "en_US.UTF-8"


def test_build_subprocess_env_static_overrides_always_present() -> None:
    """k8sattributes and friends rely on K8S_* env placeholders being set
    even when the parent env doesn't have them. The static overrides survive
    the allowlist filter.
    """
    env = _build_subprocess_env()
    for key, value in VALIDATION_ENV_OVERRIDES.items():
        assert env[key] == value


def test_validation_env_overrides_are_not_secret_shaped() -> None:
    """Paste-fail guard for the substitute-not-strip surface.

    ``VALIDATION_ENV_OVERRIDES`` is the dict of placeholder values that
    user YAML's ``${env:VAR}`` references substitute against. If a real
    secret value ever lands in here (operator paste-fail), the validator
    becomes an oracle: any user can reference the key from a config field
    whose parsing fails, and the secret round-trips out in the error
    message.

    Two checks: the key name must not look secret-shaped (`*_KEY`,
    `*_TOKEN`, etc. — defense against accidentally adding e.g. an alias
    for `HONEYCOMB_API_KEY` to "be helpful"), and the value must be short
    (defense against a JWT-shaped string getting pasted in).
    """
    forbidden_substrings = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
    for name, value in VALIDATION_ENV_OVERRIDES.items():
        upper_name = name.upper()
        for needle in forbidden_substrings:
            assert needle not in upper_name, (
                f"{name} in VALIDATION_ENV_OVERRIDES looks secret-shaped; "
                f"if this is intentional, update this test deliberately"
            )
        # Long values are a soft signal that something real was pasted in
        # by accident. Our placeholders top out around 35 chars
        # (OTEL_RESOURCE_ATTRIBUTES). 100 leaves comfortable headroom.
        assert len(value) < 100, (
            f"{name}={value!r} is unusually long for a placeholder; "
            f"if this is intentional, update this test deliberately"
        )


def test_allowlist_is_intentionally_narrow() -> None:
    """Guard-rail: the allowlist should stay tight. If someone adds a
    permissive entry (anything containing KEY, TOKEN, SECRET, PASSWORD,
    CREDENTIAL) that's almost certainly a regression — surface it here
    rather than in a post-incident review.
    """
    forbidden_substrings = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
    for name in _ALLOWED_PARENT_ENV:
        upper = name.upper()
        for needle in forbidden_substrings:
            assert needle not in upper, (
                f"{name} in _ALLOWED_PARENT_ENV looks secret-shaped; "
                f"if this is intentional, update this test deliberately"
            )


# ---------------------------------------------------------------------------
# Confmap provider neutralization — the ``$$${scheme:...}`` triple-dollar
# bypass. confmap collapses each ``$$`` to a literal ``$`` in one pass, so an
# ODD run of ``$`` before ``{`` is a live expansion. The pre-fix code treated
# any ``${`` preceded by a ``$`` as escaped, so ``$$${file:/proc/1/environ}``
# slipped past detection AND neutralization AND the fail-closed re-scan,
# reading host files / secrets and reaching cloud metadata (SSRF). Detection
# and neutralization now key off the parity of the preceding ``$`` run.
# ---------------------------------------------------------------------------


def test_preceding_dollar_run_even_parity():
    # index 1 is the char after the first "$": even/odd runs before it.
    assert _preceding_dollar_run_even("${x}", 0) is True   # run before idx0 = 0 (even)
    assert _preceding_dollar_run_even("$${x}", 1) is False  # run before idx1 = 1 (odd)
    assert _preceding_dollar_run_even("$$${x}", 2) is True  # run before idx2 = 2 (even)
    assert _preceding_dollar_run_even("$$$${x}", 3) is False  # run = 3 (odd)


def test_triple_dollar_file_provider_is_neutralized():
    """The exfiltration payload: 3 dollars => live ${file:...} expansion."""
    out, schemes = _neutralize_str("$$${file:/proc/1/environ}", "PH")
    assert schemes == ["file"]
    assert "file:" not in out
    assert _disallowed_confmap_schemes("$$${file:/proc/1/environ}") == ["file"]


def test_triple_dollar_http_provider_is_neutralized():
    """SSRF variant: 3 dollars => live ${http://...} expansion."""
    payload = "$$${http://169.254.169.254/latest/meta-data/}"
    out, schemes = _neutralize_str(payload, "PH")
    assert schemes == ["http"]
    assert "http:" not in out
    assert _disallowed_confmap_schemes(payload) == ["http"]


def test_single_dollar_file_provider_still_neutralized():
    """Baseline: the original single-dollar form must remain covered."""
    assert _disallowed_confmap_schemes("${file:/etc/passwd}") == ["file"]


def test_even_dollar_runs_are_left_intact():
    """Genuinely-escaped even runs are inert to confmap and must NOT be
    neutralized (over-neutralizing would corrupt a literal the user wanted)."""
    for escaped in ("$${file:/x}", "$$$${file:/x}", "$$$$$${file:/x}"):
        out, schemes = _neutralize_str(escaped, "PH")
        assert schemes == [], f"{escaped} was wrongly neutralized"
        assert out == escaped
        assert _disallowed_confmap_schemes(escaped) == []


def test_env_provider_passes_through_at_any_parity():
    """``env:`` is the one allowed scheme — live or escaped, never flagged."""
    for form in ("${env:X}", "$$${env:X}", "$$$$$${env:X}"):
        _, schemes = _neutralize_str(form, "PH")
        assert schemes == []
        assert _disallowed_confmap_schemes(form) == []


def test_end_to_end_triple_dollar_is_neutralized_and_rescan_is_clean():
    """Full endpoint path: pre-scan flags it, neutralizer rewrites it, and the
    fail-closed re-scan confirms nothing live survives."""
    yaml_content = (
        'exporters:\n'
        '  otlp:\n'
        '    endpoint: "$$${file:/proc/1/environ}"\n'
    )
    assert _disallowed_confmap_schemes(yaml_content) == ["file"]
    rewritten, neutralized = _neutralize_disallowed_providers(yaml_content)
    assert neutralized == ["file"]
    assert _disallowed_confmap_schemes(rewritten) == []
    assert "file:/proc" not in rewritten


def test_disallowed_provider_under_service_telemetry_is_neutralized():
    """The neutralizer walks the whole config, so a ``file:`` provider hidden in
    the collector's self-telemetry (service.telemetry — not a receiver/exporter
    section) is caught like any other. Guards the telemetry round-trip: the
    editor now preserves service.telemetry and sends it here, so its
    exfiltration surface must be covered. A same-block ``${env:...}`` survives."""
    yaml_content = (
        "service:\n"
        "  telemetry:\n"
        "    metrics:\n"
        "      readers:\n"
        "        - periodic:\n"
        "            exporter:\n"
        "              otlp:\n"
        '                endpoint: "${file:/proc/1/environ}"\n'
        "                headers:\n"
        "                  - name: Authorization\n"
        '                    value: "${env:MY_TOKEN}"\n'
    )
    assert _disallowed_confmap_schemes(yaml_content) == ["file"]
    rewritten, neutralized = _neutralize_disallowed_providers(yaml_content)
    assert neutralized == ["file"]
    assert _disallowed_confmap_schemes(rewritten) == []
    assert "file:/proc" not in rewritten
    # The permitted env provider is left intact.
    assert "${env:MY_TOKEN}" in rewritten


# ---------------------------------------------------------------------------
# `org` pseudo-scheme
#
# `${org:NAME}` is telflo's own token. Until D20 resolves values on the
# server, every LIVE `${org:...}` reaching the validator is unresolved. `org`
# is NOT added to `_ALLOWED_CONFMAP_SCHEMES` — it isn't a registered confmap
# provider, so an unrendered token would fail collector config load outright.
# It is still neutralized like any foreign scheme; only the *reporting*
# changes: instead of a generic "non-env provider" message, the validator
# names the organization variable.
# ---------------------------------------------------------------------------


def test_organization_scheme_is_neutralized_not_allowed():
    """`org` must never reach the collector: it is not a registered confmap
    provider, so an unrendered token would fail config load."""
    assert "org" in _disallowed_confmap_schemes('endpoint: "${org:HOST}"')


def test_live_organization_references_reports_names():
    assert live_organization_references("a: ${org:HOST}\nb: ${org:PORT}\n") == ["HOST", "PORT"]


def test_live_organization_references_ignores_escaped():
    assert live_organization_references("a: $${org:HOST}\n") == []


def test_live_organization_references_reports_unsupported_default_syntax():
    assert live_organization_references("a: ${org:HOST:-fallback}\n") == ["HOST:-fallback"]


def test_live_organization_references_is_case_sensitive_on_prefix():
    """``${ORG:X}`` is not an organization-variable token; the neutralizer
    still classifies it as a foreign scheme via ``scheme.lower()``, but
    ``live_organization_references`` must not lowercase — that would
    misreport a token that isn't actually telflo's."""
    assert live_organization_references("a: ${ORG:X}\n") == []


def test_live_organization_references_dedupes_repeated_names():
    assert live_organization_references("a: ${org:HOST}\nb: ${org:HOST}\n") == ["HOST"]


def test_organization_variable_requirements_reports_unresolved_name():
    """Pure unit test of the extracted helper — no subprocess involved."""
    reqs = organization_variable_requirements('endpoint: "${org:MISSING_HOST}"\n')

    assert len(reqs) == 1
    assert reqs[0]["category"] == "organization_variable"
    assert reqs[0]["title"] == "Unresolved organization variable: MISSING_HOST"


def test_organization_variable_requirements_flags_unsupported_default_syntax():
    reqs = organization_variable_requirements('endpoint: "${org:HOST:-fallback}"\n')

    assert len(reqs) == 1
    assert reqs[0]["category"] == "organization_variable"
    assert "HOST:-fallback" in reqs[0]["title"]


def test_organization_variable_requirements_empty_when_no_organization_refs():
    assert organization_variable_requirements('endpoint: "${env:HOST}"\n') == []


async def test_validate_contrib_reports_unresolved_organization_variable_not_confmap_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end wiring check: the check must actually call
    ``organization_variable_requirements`` and fold its output into the
    returned ``requirements`` list — an extracted-but-never-called helper
    would pass every other test here and do nothing in production. The
    collector itself is stubbed out; this only exercises the neutralization +
    requirement wiring.

    Also pins the double-report fix: a configuration whose only disallowed
    scheme is ``org`` must NOT also produce a generic ``confmap_provider``
    requirement.
    """
    monkeypatch.setattr(runner, "run_collector", _passing_run_collector)

    result = await _check('exporters:\n  otlp:\n    endpoint: "${org:MISSING_HOST}"\n')

    titles = [r["title"] for r in result.requirements]
    assert "Unresolved organization variable: MISSING_HOST" in titles
    assert not any(r["category"] == "confmap_provider" for r in result.requirements)


async def test_fail_closed_refusal_still_reports_unresolved_organization_variables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fail-closed branch is a backstop for "the neutralizer somehow
    wasn't total" — if it ever fires, it fires on a configuration that's
    already behaving unexpectedly, which is the worst moment to silently drop
    the diagnostic explaining that an organization variable didn't resolve.

    The real neutralizer is total, so this branch is unreachable through
    normal input — reached here by monkeypatching the fail-closed re-scan
    (``_still_references``) to report a surviving reference even after the
    splice ran (D13b ruling 39(c)). The collector must never run.
    """
    async def _must_not_run(*args, **kwargs):
        raise AssertionError("the collector ran despite a surviving provider")

    monkeypatch.setattr(runner, "run_collector", _must_not_run)
    # The fail-closed re-scan reports a surviving reference, so the refusal
    # branch fires though the splice itself was total.
    monkeypatch.setattr(runner, "_still_references", lambda yaml_content: True)

    result = await _check(
        'exporters:\n  otlp:\n    endpoint: "${org:MISSING_HOST}"\n    other: "${file:/etc/passwd}"\n',
    )

    assert result.valid is False
    assert result.outcome == "refused"
    titles = [r["title"] for r in result.requirements]
    assert any("MISSING_HOST" in t for t in titles)


async def test_organization_and_foreign_scheme_combination_preserves_both_requirements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configuration mixing an organization variable with a genuinely
    foreign provider must keep the ``confmap_provider`` warning for the
    foreign scheme while still reporting the organization variable by name.
    """
    monkeypatch.setattr(runner, "run_collector", _passing_run_collector)

    result = await _check(
        'exporters:\n  otlp:\n    endpoint: "${org:X}"\n  file_exp:\n    path: "${file:/etc/passwd}"\n',
    )

    provider_reqs = [r for r in result.requirements if r["category"] == "confmap_provider"]
    assert len(provider_reqs) == 1
    assert "file:" in provider_reqs[0]["description"]

    organization_reqs = [r for r in result.requirements if r["category"] == "organization_variable"]
    assert len(organization_reqs) == 1
    assert "X" in organization_reqs[0]["title"]


async def test_uppercase_organization_scheme_reports_confmap_provider_not_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``${ORG:X}`` is not a real organization-variable token — only lowercase
    ``org`` is. The telflo-scheme exclusion is case-sensitive, so ``${ORG:X}``
    falls through to the accurate "non-env configuration provider" message:
    ``ORG`` is not a registered confmap provider and will genuinely fail at
    real config load.
    """
    monkeypatch.setattr(runner, "run_collector", _passing_run_collector)

    result = await _check('exporters:\n  otlp:\n    endpoint: "${ORG:X}"\n')

    provider_reqs = [r for r in result.requirements if r["category"] == "confmap_provider"]
    assert len(provider_reqs) == 1
    assert "ORG:" in provider_reqs[0]["description"]

    # And it must NOT be silently folded into the organization variable
    # channel — ${ORG:X} was never a live organization-variable reference.
    assert not any(r["category"] == "organization_variable" for r in result.requirements)
