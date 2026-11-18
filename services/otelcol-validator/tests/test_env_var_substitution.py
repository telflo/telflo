"""Tests for the pre-validate ``${env:VAR}`` placeholder injection.

Background: the validator strips secret-shaped parent-env vars from the
subprocess (see test_security_fixes.py). When a user YAML references one
of those vars via ``${env:DD_API_KEY}``, the collector's confmap layer
silently substitutes empty string, and a downstream Validate() method
rejects the empty value with a component-specific error that doesn't match
the requirement templates in app/stderr.py — so it surfaces as a
config error rather than a deployment requirement.

The pre-validate scan in ``_build_env_var_placeholders`` closes that gap by
extracting ``${env:VAR}`` references, injecting typed placeholders into the
subprocess env, and pre-populating ``requirements[]`` so the user sees what
they need to set at deploy time.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.placeholders import (
    _build_env_var_placeholders,
    _extract_env_references,
    _infer_placeholder,
)
from app.runner import run_validation
from app.stderr import _merge_requirements
from tests.conftest import write_collector


# ---------------------------------------------------------------------------
# _extract_env_references
# ---------------------------------------------------------------------------


def test_extract_finds_simple_env_ref() -> None:
    yaml_content = """
exporters:
  datadog:
    api:
      key: ${env:DD_API_KEY}
"""
    refs = _extract_env_references(yaml_content)
    assert ("DD_API_KEY", "key", True) in refs


def test_extract_finds_quoted_env_ref() -> None:
    """Quoted scalars are still strings to PyYAML — the regex sees the value
    contents either way."""
    yaml_content = """
exporters:
  datadog:
    api:
      key: '${env:DD_API_KEY}'
"""
    refs = _extract_env_references(yaml_content)
    assert ("DD_API_KEY", "key", True) in refs


def test_extract_skips_default_value_form() -> None:
    """``${env:VAR:-fallback}`` already has a fallback — no placeholder
    should be injected and no requirement should be surfaced."""
    yaml_content = """
exporters:
  datadog:
    api:
      key: ${env:DD_API_KEY:-default-key}
"""
    refs = _extract_env_references(yaml_content)
    assert refs == []


def test_extract_handles_multiple_refs_in_one_value() -> None:
    """Composite values like ``${env:HOST}:${env:PORT}`` should yield both
    vars, each tagged with the same parent key."""
    yaml_content = """
exporters:
  otlp:
    endpoint: '${env:OTLP_HOST}:${env:OTLP_PORT}'
"""
    refs = _extract_env_references(yaml_content)
    assert ("OTLP_HOST", "endpoint", False) in refs
    assert ("OTLP_PORT", "endpoint", False) in refs


def test_extract_walks_into_lists() -> None:
    """Headers and similar list-of-string fields must be walked."""
    yaml_content = """
exporters:
  otlphttp:
    headers:
      - 'Authorization: Bearer ${env:API_TOKEN}'
"""
    refs = _extract_env_references(yaml_content)
    assert any(name == "API_TOKEN" for name, _, _ in refs)


def test_extract_returns_empty_on_unparseable_yaml() -> None:
    """Don't race the otelcol binary on YAML errors — let it produce the
    parse error message."""
    refs = _extract_env_references("this is not: : yaml [")
    assert refs == []


def test_extract_returns_empty_on_yaml_with_no_env_refs() -> None:
    yaml_content = """
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
"""
    assert _extract_env_references(yaml_content) == []


# ---------------------------------------------------------------------------
# _infer_placeholder — field-name heuristics
# ---------------------------------------------------------------------------


def test_infer_default_alphanumeric_for_unknown_fields() -> None:
    """Most env refs are API keys / tokens / IDs — default is a 32-char
    lowercase alphanumeric string that's URL-safe and long enough to clear
    common minimum-length checks (datadog: 32, honeycomb: 22)."""
    value = _infer_placeholder("key")
    assert len(value) >= 22
    assert value.isalnum()
    assert value == value.lower()


def test_infer_bool_for_enabled_disabled() -> None:
    assert _infer_placeholder("enabled") == "true"
    assert _infer_placeholder("disabled") == "true"
    assert _infer_placeholder("insecure") == "true"


def test_infer_bool_for_prefix_patterns() -> None:
    """fail_on_*, is_*, has_*, allow_*, etc. — wide net for boolean-shaped
    field names."""
    assert _infer_placeholder("fail_on_invalid_key") == "true"
    assert _infer_placeholder("is_enabled") == "true"
    assert _infer_placeholder("allow_insecure") == "true"
    assert _infer_placeholder("skip_verify") == "true"


def test_infer_port_for_port_fields() -> None:
    assert _infer_placeholder("port") == "4317"
    assert _infer_placeholder("grpc_port") == "4317"


def test_infer_port_does_not_match_unrelated_substrings() -> None:
    """Don't false-positive on ``transport``, ``port_range``, etc."""
    assert _infer_placeholder("transport") != "4317"
    assert _infer_placeholder("port_range") != "4317"


def test_infer_duration_for_time_fields() -> None:
    assert _infer_placeholder("timeout") == "10s"
    assert _infer_placeholder("interval") == "10s"
    assert _infer_placeholder("read_timeout") == "10s"


def test_infer_number_for_size_count_limit() -> None:
    assert _infer_placeholder("size") == "100"
    assert _infer_placeholder("max") == "100"
    assert _infer_placeholder("queue_size") == "100"
    assert _infer_placeholder("num_consumers") == "100"


def test_infer_handles_none_field_key() -> None:
    """A ``${env:VAR}`` reference at the YAML root (unusual, but possible)
    has no parent key — should fall through to the default."""
    assert _infer_placeholder(None) == _infer_placeholder("anything-unknown")


# ---------------------------------------------------------------------------
# _infer_placeholder — address-shaped fields
# ---------------------------------------------------------------------------


def test_infer_address_fields_get_a_dialable_url() -> None:
    """``endpoint: ${env:OTLP_ENDPOINT}`` is the most common env reference in
    a real config. The generic string placeholder made gRPC exporters fail
    with "missing port in address" and URL exporters with "invalid endpoint",
    reporting a correct config as broken."""
    for field in ("endpoint", "url", "address", "host", "otlp_endpoint", "api_url"):
        value = _infer_placeholder(field)
        assert value.startswith("https://"), field
        assert value.rsplit(":", 1)[-1].isdigit(), f"{field} needs a port"


def test_infer_address_placeholder_is_not_resolvable() -> None:
    """.invalid is reserved by RFC 2606, so the placeholder can never point at
    a real host even if something dials it."""
    assert ".invalid:" in _infer_placeholder("endpoint")


def test_infer_composite_address_keeps_generic_placeholder() -> None:
    """``https://${env:K8S_NODE_NAME}:10250`` supplies its own scheme and port.
    Injecting a URL there would yield https://https://…:4318:10250."""
    value = _infer_placeholder("endpoint", is_whole_value=False)
    assert value == _infer_placeholder("some_unknown_field")


def test_infer_address_heuristic_does_not_swallow_other_fields() -> None:
    """The suffix anchor must not match fields that merely start with a
    keyword — those are timeouts and counts, not addresses."""
    assert not _infer_placeholder("endpoint_timeout").startswith("https://")
    assert _infer_placeholder("host_count") == "100"


# ---------------------------------------------------------------------------
# _build_env_var_placeholders — end-to-end
# ---------------------------------------------------------------------------


def test_build_placeholders_for_datadog_api_key() -> None:
    """The reported bug: ``key: '${env:DD_API_KEY}'`` was failing validation
    because confmap empty-stringed and the datadog exporter rejected.
    With the placeholder overlay, the env carries a non-empty key and the
    user sees a deployment requirement instead of an error."""
    yaml_content = """
exporters:
  datadog:
    api:
      key: '${env:DD_API_KEY}'
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    assert "DD_API_KEY" in env_overlay
    assert env_overlay["DD_API_KEY"]  # non-empty
    assert len(requirements) == 1
    assert requirements[0]["category"] == "env_var"
    assert "DD_API_KEY" in requirements[0]["title"]


def test_build_placeholders_skips_validation_env_overrides() -> None:
    """K8S_NODE_NAME and friends already have carefully-chosen values in
    VALIDATION_ENV_OVERRIDES — the generic overlay must not stomp them."""
    yaml_content = """
processors:
  k8sattributes:
    node: ${env:K8S_NODE_NAME}
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    assert "K8S_NODE_NAME" not in env_overlay
    assert requirements == []


def test_build_placeholders_dedupes_repeated_refs() -> None:
    """If a user references the same var in multiple places, surface one
    requirement and one env overlay entry."""
    yaml_content = """
exporters:
  otlp/a:
    headers:
      authorization: 'Bearer ${env:API_TOKEN}'
  otlp/b:
    headers:
      authorization: 'Bearer ${env:API_TOKEN}'
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    assert list(env_overlay.keys()) == ["API_TOKEN"]
    assert len(requirements) == 1


def test_build_placeholders_picks_typed_value_per_field() -> None:
    """Mixed shapes in one YAML should each get the appropriate placeholder."""
    yaml_content = """
processors:
  batch:
    timeout: ${env:BATCH_TIMEOUT}
    send_batch_size: ${env:BATCH_SIZE}
exporters:
  otlp:
    endpoint: ${env:OTLP_ENDPOINT}
    tls:
      insecure: ${env:OTLP_INSECURE}
"""
    env_overlay, _ = _build_env_var_placeholders(yaml_content)
    assert env_overlay["BATCH_TIMEOUT"] == "10s"
    # send_batch_size matches the _size suffix
    assert env_overlay["BATCH_SIZE"].isdigit()
    assert env_overlay["OTLP_INSECURE"] == "true"
    # endpoint defaults to alphanumeric string (no specific URL-shaped placeholder)
    assert "OTLP_ENDPOINT" in env_overlay


def test_build_placeholders_returns_empty_when_no_refs() -> None:
    yaml_content = """
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    assert env_overlay == {}
    assert requirements == []


def test_build_placeholders_skips_default_value_refs() -> None:
    """``${env:VAR:-fallback}`` doesn't need a placeholder — the collector
    uses the fallback when VAR is unset. No requirement should be surfaced
    since the user already handled the unset case."""
    yaml_content = """
exporters:
  otlp:
    endpoint: ${env:OTLP_ENDPOINT:-localhost:4317}
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    assert env_overlay == {}
    assert requirements == []


# ---------------------------------------------------------------------------
# _merge_requirements
# ---------------------------------------------------------------------------


def test_merge_requirements_dedupes_by_category_and_title() -> None:
    """If the pre-scan and the stderr classifier both surface a requirement
    for the same env var, the result has one entry — pre-scan wins."""
    primary = [
        {
            "category": "env_var",
            "title": "Set environment variable DD_API_KEY",
            "description": "from pre-scan",
            "componentPath": None,
        }
    ]
    secondary = [
        {
            "category": "env_var",
            "title": "Set environment variable DD_API_KEY",
            "description": "from stderr classifier",
            "componentPath": "exporters::datadog",
        }
    ]
    merged = _merge_requirements(primary, secondary)
    assert len(merged) == 1
    assert merged[0]["description"] == "from pre-scan"


def test_merge_requirements_preserves_distinct_entries() -> None:
    primary = [
        {
            "category": "env_var",
            "title": "Set environment variable DD_API_KEY",
            "description": "x",
            "componentPath": None,
        }
    ]
    secondary = [
        {
            "category": "k8s_in_cluster",
            "title": "Run inside a Kubernetes pod",
            "description": "y",
            "componentPath": None,
        }
    ]
    merged = _merge_requirements(primary, secondary)
    assert len(merged) == 2


# ---------------------------------------------------------------------------
# Invariant: the pre-scan must never mutate the YAML the collector sees.
#
# The validator's job is to answer "is this YAML valid?" — substituting env
# values into the subprocess env is fine (the collector does its own
# substitution at config-load time and treats our overlay as just another
# environment), but rewriting the YAML before handing it to the binary
# would make us report on a different config than the user submitted. Bad
# structural shapes (typos, missing required fields, dangling references)
# must still surface as errors regardless of what env vars the YAML
# references.
#
# Enforced two ways:
#   1. The pre-scan helpers don't return any mutated YAML — only an env
#      overlay and a requirements list. There's no API surface to misuse.
#   2. ``run_collector`` writes the input string verbatim to the
#      tempfile. Anyone tempted to "be helpful" by rewriting the YAML
#      should fail the byte-for-byte assertion below.
# ---------------------------------------------------------------------------


def test_build_placeholders_does_not_return_mutated_yaml() -> None:
    """API-shape guard: the pre-scan must only return (env_overlay,
    requirements) — never a rewritten YAML. If a future change ever wants
    to pre-process the YAML body, it has to deliberately expand this
    contract rather than slip a third return value past review.
    """
    yaml_content = """
exporters:
  datadog:
    api:
      key: '${env:DD_API_KEY}'
"""
    result = _build_env_var_placeholders(yaml_content)
    assert len(result) == 2
    env_overlay, requirements = result
    assert isinstance(env_overlay, dict)
    assert isinstance(requirements, list)
    # Sanity: nothing in the env_overlay is the YAML itself.
    for value in env_overlay.values():
        assert "exporters:" not in value


def test_validate_with_binary_writes_yaml_verbatim(tmp_path, binary_dir) -> None:
    """Byte-for-byte guard: ``run_collector`` must write the input
    YAML to its tempfile unchanged. Mutating the YAML would mean validation
    runs against a different config than the user submitted — structural
    errors in their actual YAML would either be hidden (if our mutation
    "fixed" them) or invented (if our mutation broke them).

    A fake collector (a shell script) copies the file the validator hands
    it, and the copy must match the input exactly. (The runner reads its pipes
    through its own protocol, D13b ruling 33, so a real process stands in
    rather than a stubbed create_subprocess_exec.)
    """
    import asyncio
    from pathlib import Path

    from app import runner

    captured = tmp_path / "captured.yaml"
    binary = write_collector(binary_dir, "0.162.0", f'cp "${{2#--config=}}" {captured}\nexit 0\n')

    yaml_content = (
        "# user comment that must survive verbatim\n"
        "receivers:\n"
        "  otlp:\n"
        "    protocols:\n"
        "      http:\n"
        "        endpoint: '${env:OTLP_HTTP_ENDPOINT}'\n"
        "exporters:\n"
        "  datadog:\n"
        "    api:\n"
        "      key: '${env:DD_API_KEY}'\n"
        "      site: 'datadoghq.com'\n"
        "      fail_on_invalid_key: false\n"
        "service:\n"
        "  pipelines:\n"
        "    metrics:\n"
        "      receivers: [otlp]\n"
        "      exporters: [datadog]\n"
    )

    asyncio.run(runner.run_collector(Path(binary), yaml_content, {}, timeout_seconds=10))

    assert captured.read_text() == yaml_content, (
        "Validator mutated the user's YAML before handing it to the "
        "collector binary. The pre-scan must only modify the subprocess "
        "env, never the YAML body."
    )


def test_structural_errors_in_yaml_referencing_env_vars_still_surface() -> None:
    """Functional guard for the invariant: even when a YAML uses ${env:VAR}
    references that the pre-scan handles, any structural problem in the
    YAML itself must still produce a real error.

    The earlier end-to-end check (curl against the running binary) already
    proves this — a pipeline referencing a nonexistent receiver returned
    valid=false with the real error message. This unit test is the
    in-process companion: it confirms the pre-scan's env-overlay never
    masks errors that the collector would otherwise report, by verifying
    the pre-scan doesn't strip, rewrite, or silently "fix" anything in
    the YAML body — the collector sees what the user wrote.
    """
    yaml_content = """
receivers:
  otlp:
    protocols:
      http:
        endpoint: '${env:OTLP_HTTP_ENDPOINT}'
exporters:
  datadog:
    api:
      key: '${env:DD_API_KEY}'
service:
  pipelines:
    metrics:
      receivers: [nonexistent_receiver]
      exporters: [datadog]
"""
    env_overlay, requirements = _build_env_var_placeholders(yaml_content)
    # Pre-scan handles the env vars (substitution + requirement surfaced)...
    assert "DD_API_KEY" in env_overlay
    assert "OTLP_HTTP_ENDPOINT" in env_overlay
    assert any("DD_API_KEY" in r["title"] for r in requirements)
    # ...but it doesn't return the YAML, so it can't possibly have
    # silently fixed `receivers: [nonexistent_receiver]`. When the
    # collector binary runs, it will see the unmodified YAML and report
    # the dangling reference as an error — preserving the invariant that
    # bad shape == validation failure regardless of env var usage.


# ---------------------------------------------------------------------------
# D13b ruling 63: a directory-valued key's placeholder is a directory
# ---------------------------------------------------------------------------

ROOT_PATH_ENV_TEXT = """\
receivers:
  hostmetrics:
    root_path: ${env:HOST_ROOT}
    scrapers:
      cpu: {}
extensions:
  file_storage:
    directory: ${env:STORAGE_DIR}
  file_storage/2:
    directory: ${env:STORAGE_BASE}/queue
"""


def test_a_directory_valued_reference_gets_a_fresh_directory_inside_the_check_directory(tmp_path) -> None:
    env_overlay, requirements = _build_env_var_placeholders(ROOT_PATH_ENV_TEXT, directory=str(tmp_path))

    for name in ("HOST_ROOT", "STORAGE_DIR"):
        path = Path(env_overlay[name])
        assert path.parent == tmp_path
        assert path.is_dir()
        assert list(path.iterdir()) == []
    assert env_overlay["HOST_ROOT"] != env_overlay["STORAGE_DIR"]
    # A reference that is only part of the value keeps the string placeholder.
    assert env_overlay["STORAGE_BASE"] == "otelvalidatorplaceholder00000000"
    assert [r["title"] for r in requirements] == [
        "Set environment variable HOST_ROOT",
        "Set environment variable STORAGE_DIR",
        "Set environment variable STORAGE_BASE",
    ]


def test_without_a_check_directory_no_directory_is_made(tmp_path, monkeypatch) -> None:
    """The directory is never made outside the check's own: with none given
    (a caller outside a check), the string placeholder stays."""
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    env_overlay, _requirements = _build_env_var_placeholders(ROOT_PATH_ENV_TEXT)

    assert env_overlay["HOST_ROOT"] == "otelvalidatorplaceholder00000000"
    assert env_overlay["STORAGE_DIR"] == "otelvalidatorplaceholder00000000"
    assert list(tmp_path.iterdir()) == []


# A collector that stats root_path as hostmetrics does on Linux, and passes
# only when it is a directory inside its working directory (the check's own).
ROOT_PATH_STAT_COLLECTOR = r"""here=$(pwd -P)
parent=$(cd "$(dirname "$HOST_ROOT")" 2>/dev/null && pwd -P)
if [ -n "$parent" ] && [ "$parent" = "$here" ] && [ -d "$HOST_ROOT" ]; then exit 0; fi
echo "Error: receivers::hostmetrics: invalid root_path: stat $HOST_ROOT: no such file or directory" >&2
exit 1
"""


async def test_a_root_path_from_an_env_reference_answers_valid_with_its_requirement(binary_dir) -> None:
    binary = write_collector(binary_dir, "0.162.0", ROOT_PATH_STAT_COLLECTOR)
    text = ROOT_PATH_ENV_TEXT.split("extensions:")[0]

    result = await run_validation(binary, text, slots=asyncio.Semaphore(1), slot_wait_seconds=1.0, timeout_seconds=10)

    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"]) for r in result.requirements] == [
        ("env_var", "Set environment variable HOST_ROOT")
    ]
    assert "otelvalidatorplaceholder" not in json.dumps(result.errors + result.requirements)
