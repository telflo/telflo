"""The security fixes, as D14a Preflight ruling 6 maps them:

- S3 (5): the Bearer middleware with the secret in a file (ADRs 0026, 0027;
  Task 3), with no opt-out;
- S6 (7), S7 (6) and S8 (2): S6 calls ``scrub_stderr`` (`app/scrub.py`),
  S7 the merged sandbox environment, and S8 reads the modules that wire a
  kubeconfig;
- S9 (8) and the ``org`` scheme test (1), against the validator's
  neutraliser (`app/providers.py`, `app/neutralise.py`);
- none for S5 (storage upserts: the tester stores nothing); S4 (RE2 rules)
  is D15's.

Each test pins a specific guarantee from the security review so the fix
doesn't quietly regress.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.sandbox_env import (
    SANDBOX_ENV_OVERRIDES,
    _ALLOWED_PARENT_ENV,
    build_subprocess_env,
)
from app.scrub import scrub_stderr
from app.settings import SettingsError
from tests.conftest import RUNS_URL, SECRET, auth_headers, make_settings, run_body, write_fake_collector

# ---------------------------------------------------------------------------
# S3 — the shared secret, default-deny (rewritten: Bearer, from a file)
# ---------------------------------------------------------------------------


@pytest.fixture
def started(binary_dir: Path):
    write_fake_collector(binary_dir)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        yield client


def test_s3_the_service_refuses_to_start_without_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no secret configured the tester refuses to start at all (there
    is no unauthenticated mode)."""
    monkeypatch.delenv("OTELCOL_TESTING_SECRET_FILE", raising=False)
    with pytest.raises(SettingsError, match="OTELCOL_TESTING_SECRET_FILE is not set"):
        with TestClient(create_app()):
            pass


def test_s3_a_missing_header_is_401(started: TestClient) -> None:
    resp = started.post(RUNS_URL, json=run_body())
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_s3_a_wrong_secret_is_401(started: TestClient) -> None:
    resp = started.post(RUNS_URL, json=run_body(), headers=auth_headers("not-the-secret-" + "x" * 32))
    assert resp.status_code == 401


def test_s3_the_secret_is_accepted(started: TestClient) -> None:
    resp = started.post(RUNS_URL, json=run_body(), headers=auth_headers())
    assert resp.status_code == 200


def test_s3_there_is_no_switch_that_turns_the_secret_off(started: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """An escape hatch (``REQUIRE_API_KEY=false``) and an ``X-API-Key``
    header do nothing here: an unset key never opens the endpoint."""
    monkeypatch.setenv("REQUIRE_API_KEY", "false")
    for headers in ({}, {"X-API-Key": SECRET}):
        resp = started.post(RUNS_URL, json=run_body(), headers=headers)
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# S6 — stderr scrubber redacts sandbox internals.
# ---------------------------------------------------------------------------


def test_scrub_stderr_redacts_workspace_paths() -> None:
    workspace = Path("/tmp/otelcol-runs/abcd-1234")
    stderr = (
        "error: could not load /tmp/otelcol-runs/abcd-1234/config.yaml\n"
        "input file: /tmp/otelcol-runs/abcd-1234/input.data\n"
        "output file: /tmp/otelcol-runs/abcd-1234/output.data\n"
    )
    scrubbed = scrub_stderr(stderr, workspace_root=workspace)
    assert "/tmp/otelcol-runs" not in scrubbed
    assert "<sandbox/config>" in scrubbed
    assert "<sandbox/input>" in scrubbed
    assert "<sandbox/output>" in scrubbed


def test_scrub_stderr_redacts_bare_workspace_root_mentions() -> None:
    workspace = Path("/tmp/otelcol-runs/abcd-1234")
    stderr = "tried to create /tmp/otelcol-runs/abcd-1234 but it already exists"
    scrubbed = scrub_stderr(stderr, workspace_root=workspace)
    assert "abcd-1234" not in scrubbed
    assert "<sandbox>" in scrubbed


def test_scrub_stderr_redacts_kubeconfig_path() -> None:
    kubeconfig = Path("/home/kwok/.kube/config")
    stderr = "Loading kubeconfig from /home/kwok/.kube/config\n"
    scrubbed = scrub_stderr(stderr, kubeconfig_path=kubeconfig)
    assert "/home/kwok" not in scrubbed
    assert "<kubeconfig>" in scrubbed


def test_scrub_stderr_handles_none_args() -> None:
    """None on either arg skips that group — used by file mode runs that
    didn't wire kwok in."""
    stderr = "some error mentioning /tmp/otelcol-runs/abcd-1234/config.yaml"
    scrubbed = scrub_stderr(stderr, workspace_root=None, kubeconfig_path=None)
    # No redaction args supplied → stderr unchanged.
    assert scrubbed == stderr


def test_scrub_stderr_passes_through_empty_string() -> None:
    assert scrub_stderr("", workspace_root=Path("/x")) == ""


def test_scrub_stderr_redacts_input_log_path() -> None:
    """input.log (filelog pull-mode fixture) must be redacted to <sandbox/input>
    just like input.data.  Test is separator-agnostic: the stderr text is built
    using the same f"{root}/{suffix}" pattern the scrubber uses internally so
    the string always matches on both Linux and Windows, and the assertion
    normalises the output so the placeholder is always expressed with a forward
    slash."""
    workspace = Path("/tmp/otelcol-runs/abcd-1234")
    root = str(workspace)
    # Mirror the scrubber's own substitution key: f"{root}/{suffix}"
    stderr = f"failed reading {root}/input.log\n"
    scrubbed = scrub_stderr(stderr, workspace_root=workspace)
    assert "<sandbox/input>" in scrubbed.replace("\\", "/")


def test_scrub_stderr_does_not_redact_user_payloads_with_similar_strings() -> None:
    """Stress: the redaction is substring-based on the SPECIFIC workspace
    path the run used, not a broad pattern, so user payloads that happen
    to contain `/tmp/...` are left alone."""
    workspace = Path("/tmp/otelcol-runs/abcd-1234")
    stderr = (
        "rejecting record body: /tmp/legitimate-user-data.json\n"
        "failed to read /tmp/otelcol-runs/abcd-1234/config.yaml\n"
    )
    scrubbed = scrub_stderr(stderr, workspace_root=workspace)
    assert "/tmp/legitimate-user-data.json" in scrubbed
    assert "<sandbox/config>" in scrubbed


# ---------------------------------------------------------------------------
# S7 — subprocess env allowlist.
#
# Pre-fix, the spawned otelcol-contrib inherited the full parent env via
# ``dict(os.environ)``. A user YAML could then exfiltrate any secret by
# interpolating it into a processor field (``${env:DATABASE_SERVICE_KEY}``).
# The fix replaces the wholesale copy with an explicit allowlist.
# ---------------------------------------------------------------------------


def test_build_subprocess_env_drops_secret_shaped_parent_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    """A database service key in the testing service's env must not reach
    the subprocess. Same story for OPENAI_API_KEY and any other unknown var.
    """
    monkeypatch.setenv("DATABASE_SERVICE_KEY", "super-secret-jwt")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prod-token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-token")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "deadbeef")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_xyz")

    env = build_subprocess_env()

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
    binary can't resolve its own libraries on most systems."""
    monkeypatch.setenv("PATH", "/usr/local/bin:/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/home/runner")
    monkeypatch.setenv("LANG", "en_US.UTF-8")

    env = build_subprocess_env()

    assert env["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert env["HOME"] == "/home/runner"
    assert env["LANG"] == "en_US.UTF-8"


def test_build_subprocess_env_static_overrides_always_present() -> None:
    """k8sattributes and friends rely on K8S_* env placeholders being set
    even when the parent env doesn't have them. The static overrides survive
    the allowlist filter."""
    env = build_subprocess_env()
    for key, value in SANDBOX_ENV_OVERRIDES.items():
        assert env[key] == value


def test_build_subprocess_env_extra_wins_over_overrides() -> None:
    """``extra`` (e.g. KUBECONFIG from kwok wiring) is highest precedence so
    callers can force a specific value when needed."""
    env = build_subprocess_env(extra={"KUBECONFIG": "/tmp/kwok/kubeconfig"})
    assert env["KUBECONFIG"] == "/tmp/kwok/kubeconfig"


def test_subprocess_env_does_not_inject_otel_service_identity() -> None:
    """Regression guard: the sandbox must NOT set OTEL_SERVICE_NAME or
    OTEL_RESOURCE_ATTRIBUTES on the spawned otelcol-contrib subprocess.

    The resourcedetection processor's ``env`` detector reads exactly those
    two env vars and emits them as resource attributes — with the default
    ``override: true`` clobbering whatever ``service.name`` the user's
    records already carried. A previous version of SANDBOX_ENV_OVERRIDES
    set OTEL_RESOURCE_ATTRIBUTES=service.name=otelcol-testing, which made
    every test run that used the env detector report
    ``service.name=otelcol-testing`` regardless of input — defeating the
    sandbox's whole purpose. Keep both keys absent from the subprocess env.

    Note this also covers an indirect leak: even if neither key is
    explicitly set in SANDBOX_ENV_OVERRIDES, both names are excluded from
    _ALLOWED_PARENT_ENV so a value happening to be present in the testing
    service's own environment can't slip through either.
    """
    env = build_subprocess_env()
    assert "OTEL_SERVICE_NAME" not in env
    assert "OTEL_RESOURCE_ATTRIBUTES" not in env


def test_allowlist_is_intentionally_narrow() -> None:
    """A guard-rail test: the allowlist should stay tight. If someone adds
    a permissive entry (anything containing KEY, TOKEN, SECRET, PASSWORD)
    that's almost certainly a regression — surface it here rather than in
    a post-incident review.
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
# S8 — KUBECONFIG path not interpolated into the service's own logger.
#
# The S6 fix (stderr_scrubber) covers the COLLECTOR's stderr that flows back
# to the user via the API. The testing service's own Python logger is a
# SEPARATE channel — pod stdout, CloudWatch, k8s pod-log RBAC — typically
# accessible to a wider audience than the API itself (contractors,
# observability vendors, junior ops). Pre-fix, both replay executors emitted
# `logger.info("test run uses k8s processors; KUBECONFIG=%s", path)` per
# k8s-using run, interpolating the full kubeconfig path. The path reveals
# the container's OS user (via the home directory in the path) and the
# kwok cluster's naming convention. Drop the path from the format string.
# ---------------------------------------------------------------------------


import inspect  # noqa: E402

from app import run as run_module  # noqa: E402
from app.executors import _shared, filelog_pull, otlp_replay, syslog_push  # noqa: E402

# The run's child and the strategies are what spawn a collector with a
# kubeconfig.
_KWOK_WIRING_MODULES = (_shared, otlp_replay, filelog_pull, syslog_push, run_module)


def test_executors_do_not_log_kubeconfig_path() -> None:
    """Neither replay executor may interpolate the kubeconfig path into a
    logger format string. Catches the most likely regression — someone
    re-adding ``%s`` "for debugging" — by inspecting the module source.
    """
    forbidden_format = "KUBECONFIG=%s"
    for module in _KWOK_WIRING_MODULES:
        src = inspect.getsource(module)
        assert forbidden_format not in src, (
            f"{module.__name__} interpolates the kubeconfig path into a "
            f"logger format string ({forbidden_format!r}). The application "
            "logger lands in operational log channels (pod stdout, "
            "CloudWatch, etc.) with a wider audience than the API — "
            "the path leaks the container's OS user and kwok cluster "
            "naming. See OTELCOL_TESTING_SECURITY_REVIEW.md finding #4."
        )


def test_executors_do_not_log_kubeconfig_path_via_dict_access() -> None:
    """Defense-in-depth against a sneakier regression where someone reads
    the path back out of extra_env or self._kwok_cluster.kubeconfig_path
    inside a logger.info call rather than interpolating directly. We grep
    for the conjunction of ``logger.info`` and ``kubeconfig`` on lines
    near each other.
    """
    for module in _KWOK_WIRING_MODULES:
        src = inspect.getsource(module).splitlines()
        for idx, line in enumerate(src):
            stripped = line.strip()
            # Each logger.info call may span multiple lines; look at the
            # whole logger.info(...) form by scanning ahead until the
            # paren count balances. Cheap parser.
            if not stripped.startswith("logger.info"):
                continue
            block_start = idx
            depth = 0
            block_lines: list[str] = []
            for j in range(block_start, min(block_start + 10, len(src))):
                block_lines.append(src[j])
                depth += src[j].count("(") - src[j].count(")")
                if depth == 0 and "(" in "".join(block_lines):
                    break
            block = "\n".join(block_lines).lower()
            assert "kubeconfig" not in block or "configured from kwok" in block, (
                f"{module.__name__} line ~{block_start + 1}: a logger.info "
                f"call references 'kubeconfig' but doesn't match the safe "
                f"path-free format. Block:\n{chr(10).join(block_lines)}"
            )


# ---------------------------------------------------------------------------
# S9 — confmap provider neutralization: the ``$$${scheme:...}`` triple-dollar
# bypass (rewritten against the validator's neutraliser). confmap collapses
# each ``$$`` to a literal ``$`` in one pass, so an ODD run of ``$`` before
# ``{`` is a live expansion.
# ---------------------------------------------------------------------------

from app.neutralise import Neutralised, neutralise  # noqa: E402
from app.providers import _preceding_dollar_run_even  # noqa: E402
from app.yaml_mutations import MutationContext, force_telemetry_off, mutate_for_otlp_replay  # noqa: E402


def _neutralised(text: str) -> Neutralised:
    result = neutralise(text)
    assert isinstance(result, Neutralised), text
    return result


def test_s9_preceding_dollar_run_even_parity() -> None:
    assert _preceding_dollar_run_even("${x}", 0) is True
    assert _preceding_dollar_run_even("$${x}", 1) is False
    assert _preceding_dollar_run_even("$$${x}", 2) is True
    assert _preceding_dollar_run_even("$$$${x}", 3) is False


def test_s9_triple_dollar_file_provider_is_neutralized() -> None:
    result = _neutralised('a: "$$${file:/proc/1/environ}"\n')
    assert result.schemes == ["file"]
    assert "file:" not in result.text


def test_s9_triple_dollar_http_provider_is_neutralized() -> None:
    result = _neutralised('a: "$$${http://169.254.169.254/latest/meta-data/}"\n')
    assert result.schemes == ["http"]
    assert "http:" not in result.text


def test_s9_even_dollar_runs_are_left_intact() -> None:
    for escaped in ("$${file:/x}", "$$$${file:/x}"):
        text = f'a: "{escaped}"\n'
        result = _neutralised(text)
        assert result.schemes == [], f"{escaped} was wrongly neutralized"
        assert result.text == text


def test_s9_env_provider_passes_through_at_any_parity() -> None:
    for form in ("${env:X}", "$$${env:X}"):
        result = _neutralised(f'a: "{form}"\n')
        assert result.schemes == []


def test_s9_triple_dollar_in_processor_is_neutralized_end_to_end() -> None:
    """A processor carrying the bypass has it neutralised in the mutated
    config the collector actually runs, with an R-105 advisory raised."""
    yaml_config = (
        "receivers:\n"
        "  otlp:\n"
        "    protocols: {http: {}}\n"
        "processors:\n"
        "  transform:\n"
        "    log_statements:\n"
        "      - context: log\n"
        "        statements:\n"
        '          - set(attributes["leak"], "$$${file:/proc/1/environ}")\n'
        "exporters:\n"
        '  otlp: {endpoint: "example:4317"}\n'
        "service:\n"
        "  pipelines:\n"
        "    logs: {receivers: [otlp], processors: [transform], exporters: [otlp]}\n"
    )
    result = _neutralised(yaml_config)
    mutated, _advisories = mutate_for_otlp_replay(result.text, "logs", Path("/tmp/out.data"), 24318)
    assert "file:/proc" not in mutated
    assert [m["id"] for m in result.mutations] == ["R-105"]


def test_s9_disallowed_provider_under_service_telemetry_is_neutralized() -> None:
    """A ``file:`` provider hidden in the collector's self-telemetry is
    neutralised like any other; a same-block ``${env:...}`` survives."""
    text = (
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
    result = _neutralised(text)
    assert result.schemes == ["file"]
    assert "file:" not in result.text
    assert '"${env:MY_TOKEN}"' in result.text


def test_s9_force_telemetry_off_removes_any_provider_defense_in_depth() -> None:
    """Defense in depth: R-004 replaces service.telemetry wholesale with
    ``metrics: {level: none}`` in the sandbox, so a provider hidden there never
    reaches the collector even before the neutraliser's backstop."""
    doc = {
        "service": {
            "telemetry": {
                "metrics": {
                    "readers": [
                        {
                            "periodic": {
                                "exporter": {
                                    "otlp": {"endpoint": "${file:/proc/1/environ}"}
                                }
                            }
                        }
                    ]
                }
            },
            "pipelines": {},
        }
    }
    ctx = MutationContext(signal_type="logs", output_path=Path("/tmp/out.data"))
    advisories: list = []
    force_telemetry_off(doc, ctx, advisories)
    assert doc["service"]["telemetry"] == {"metrics": {"level": "none"}}
    assert "file:" not in str(doc["service"]["telemetry"])
    assert any(a.id == "R-004" for a in advisories)


# ---------------------------------------------------------------------------
# `org` pseudo-scheme (rewritten). `${org:NAME}` is telflo's own token,
# substituted by the platform before a run is queued (D14a Preflight ruling
# 12); one that reaches the tester is neutralised like any foreign scheme.
# ---------------------------------------------------------------------------


def test_org_scheme_is_neutralized_not_allowed() -> None:
    result = _neutralised('endpoint: "${org:HOST}"\n')
    assert result.schemes == ["org"]
    assert "org:" not in result.text
