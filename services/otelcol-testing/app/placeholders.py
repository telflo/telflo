"""What the validator substitutes so `validate` can build the components:
placeholder values for `${env:VAR}` (in the collector's environment, never
in the text) and a placeholder `hostname` for Datadog exporters.

Requirement texts follow the platform's language (configuration,
organization).
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Collection

from app import bounded_yaml

# Placeholder env values for components that read env vars at validate time
# (k8sattributes node_from_env_var, resourcedetection k8snode/env detectors,
# generic ${env:...} substitutions, k8s in-cluster API client). These override
# the parent process env so the spawned binary always sees them, regardless
# of what the surrounding orchestrator injects.
#
# Design philosophy: "substitute, don't strip". This service's contract is
# "is this YAML valid"; mutating the YAML to strip components before validate
# would be an inauthentic claim about the original configuration. Instead we
# provide safe placeholder *values* for the env vars components read during
# their construction phase, so components like k8sattributes execute their
# real Validate() methods against plausibly-shaped fake inputs rather than
# failing noisily or dialing the real environment.
#
# Deliberately omitted: names matching *_KEY / *_SECRET / *_TOKEN /
# *_PASSWORD / *_CREDENTIAL. If a YAML references ${env:HONEYCOMB_API_KEY}
# the right UX is to surface a requirement ("set this in your deployment"),
# not to substitute a placeholder that hides the missing-value signal.
VALIDATION_ENV_OVERRIDES = {
    # K8s pod identity. Multiple naming conventions are common (K8S_*, MY_*,
    # bare POD_NAME); we cover the canonical ones so YAMLs validate cleanly
    # regardless of which downward-API convention they follow.
    "K8S_NODE_NAME": "otelcol-validator",
    "K8S_POD_NAME": "otelcol-validator",
    "K8S_POD_UID": "00000000-0000-0000-0000-000000000000",
    "K8S_NAMESPACE": "otelcol-validator",
    "K8S_NAMESPACE_NAME": "otelcol-validator",
    "K8S_CLUSTER_NAME": "otelcol-validator",
    "MY_NODE_NAME": "otelcol-validator",
    "MY_POD_NAME": "otelcol-validator",
    "MY_NAMESPACE": "otelcol-validator",
    "POD_NAME": "otelcol-validator",
    "NODE_NAME": "otelcol-validator",
    "NAMESPACE": "otelcol-validator",
    "HOSTNAME": "otelcol-validator",
    # IP placeholders for receivers that bind to ${env:MY_POD_IP}:4317 or
    # similar. Nothing actually binds during validate; the address just
    # needs to parse as a valid host, which 127.0.0.1 satisfies.
    "MY_POD_IP": "127.0.0.1",
    "POD_IP": "127.0.0.1",
    "HOST_IP": "127.0.0.1",
    # OTel SDK resource attributes — components emitting collector-internal
    # telemetry read this. Static service.name keeps validate-time error
    # messages identifiable as ours.
    "OTEL_RESOURCE_ATTRIBUTES": "service.name=otelcol-validator",
    # In-cluster K8s client routing. Setting these routes k8sattributes etc.
    # down the in-cluster path, which then hits the image's placeholder
    # service-account token and self-signed CA and fails TLS as intended.
    "KUBERNETES_SERVICE_HOST": "kubernetes.default.svc",
    "KUBERNETES_SERVICE_PORT": "443",
}

# ---------------------------------------------------------------------------
# Per-request env-var placeholder injection
#
# Background: the collector substitutes ``${env:VAR}`` at config-load time. If
# VAR is unset, confmap silently expands to empty string, and a component's
# downstream Validate() then rejects the empty value with its own error
# (e.g. "exporters::datadog: api.key is not set"). That message doesn't match
# the env-not-set patterns, so it surfaces as a configuration error rather
# than the deployment requirement it actually is.
#
# Fix: pre-scan the YAML for ``${env:VAR}`` references, and for any VAR not
# already satisfied by VALIDATION_ENV_OVERRIDES, inject a typed placeholder
# value into the subprocess env for this run. The reference also gets
# pre-populated into requirements[] so the user sees what they need to set
# at deploy time.
#
# Why this is safe vs. the env-exfiltration concern that motivated the
# subprocess environment allowlist: the placeholder we inject is *our* value,
# not the parent's secret. The parent env is still filtered first, so even
# YAML referencing ${env:OTELCOL_VALIDATOR_SECRET} would substitute our
# placeholder, not the real secret.
#
# Default-value syntax ${env:VAR:-fallback} is skipped — the collector
# already uses the fallback when VAR is unset, so no placeholder is needed
# and no requirement should be surfaced.
# ---------------------------------------------------------------------------

# The expression `\$\{env:(?P<name>[A-Za-z_][A-Za-z0-9_]*)
# (?P<default>:-[^}]*)?\}` finds the references, but on a value of
# unterminated `${env:A:-` each attempt's `[^}]*` runs to the end of the
# value, so the scan costs the square of its length (236 KB: 47 s). `_env_references` finds the same matches in
# one pass (the differential test in tests/test_linear_scans.py runs the
# expression, kept in tests/verbatim.py).
_ENV_PREFIX = "${env:"

# Names the validator never sets in the collector's environment, neither as a
# first-run placeholder nor on the rerun: Go's runtime and toolchain
# (`GODEBUG`, `GOMEMLIMIT`, `GOMAXPROCS`, `GO111MODULE`, …: `GO` then capitals
# and digits, never an underscore, so `GOOGLE_*` names are ordinary), the
# dynamic loaders (`LD_*`, `DYLD_*`), proxies (`HTTPS_PROXY`, `no_proxy`, …),
# TLS roots (`SSL_CERT_FILE`, `SSL_CERT_DIR`), and the allowlisted process
# basics. A text names them through `${env:NAME}`; a placeholder there could
# change how the collector itself runs, so the collector sees whatever the
# allowlisted environment holds, or nothing, and the reference stays a
# requirement.
_PROTECTED_ENV_NAME_RE = re.compile(
    r"GO[A-Z0-9]*|LD_.*|DYLD_.*|.*_PROXY|.*_proxy|SSL_CERT_.*|PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_.*"
)
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _env_references(value: str) -> list[tuple[str, str | None, str]]:
    """``(name, default, whole)`` for each match that expression
    finds in ``value``, in order: ``default`` is the ``:-…`` part or None,
    ``whole`` the matched text. Each ``${env:`` is tried once: its name, then
    a ``}`` or ``:-`` and the first ``}`` after (what ``[^}]*`` stops at); a
    failed one is retried from the next ``${env:``, as the expression is.
    The ``}`` search only moves forward, so with the name runs (each after
    its own ``${env:``) the whole scan reads each character a bounded number
    of times."""
    found: list[tuple[str, str | None, str]] = []
    n = len(value)
    close = -1  # the first `}` at or after where it was last searched from; n for none
    position = 0
    while True:
        start = value.find(_ENV_PREFIX, position)
        if start == -1:
            return found
        name = _ENV_NAME_RE.match(value, start + len(_ENV_PREFIX))
        if name is not None:
            end = name.end()
            if end < n and value[end] == "}":
                found.append((name.group(), None, value[start : end + 1]))
                position = end + 1
                continue
            if value.startswith(":-", end):
                if close < end:
                    close = value.find("}", end)
                    if close == -1:
                        close = n
                if close < n:
                    found.append((name.group(), value[end:close], value[start : close + 1]))
                    position = close + 1
                    continue
        position = start + 1

# Field-name → placeholder shape. Listed most-specific first; first match wins.
# The shapes are chosen to satisfy the most common Go-side type coercions in
# the collector's component Validate() methods (bool, int, duration, string).
_FIELD_HEURISTICS: list[tuple[re.Pattern, str]] = [
    # Bool-shaped fields. Prefix list covers the dominant naming patterns
    # (fail_on_*, is_*, has_*, enable_*, allow_*, skip_*, use_*) plus the
    # exact-match boolean field names used throughout otelcol-contrib.
    (re.compile(r"^(enabled|disabled|insecure|secure|tls|debug|verbose|compression)$"), "true"),
    (re.compile(r"^(is|has|allow|deny|enable|disable|fail_on|skip|use|with|without|include|exclude|require)_"), "true"),
    # Port. "(_|^)port$" so it matches both `port:` and `grpc_port:` but not
    # `port_range:` or `transport:`.
    (re.compile(r"(^|_)port$"), "4317"),
    # Duration-shaped. "10s" parses as Go's time.Duration for these fields.
    (
        re.compile(
            r"^(timeout|interval|duration|period|delay|frequency|backoff|deadline|expiration|expiry|lifetime|ttl|grace_period|read_timeout|write_timeout|idle_timeout|keepalive)$"
        ),
        "10s",
    ),
    # Numeric counts/sizes/limits. "100" coerces to int for any int field.
    (
        re.compile(
            r"^(size|count|limit|max|min|capacity|concurrency|workers|threads|num_consumers|num_traces|num_metrics|queue_size|batch_size|sending_queue|max_recv_msg_size|max_send_msg_size)$"
        ),
        "100",
    ),
    (re.compile(r"(_size|_count|_limit|_max|_min|_workers|_concurrency|_capacity)$"), "100"),
]

# Generic alphanumeric placeholder for string-shaped fields (API keys, tokens,
# cluster names, endpoints embedded in URLs). 32 chars is comfortably above
# any minimum-length check we've seen (datadog's is 32, honeycomb's is 22).
# Lowercase alphanumeric only so the value is safe to embed inside a URL
# without escaping.
# The substring every placeholder this module injects carries, so a cause the
# collector echoed from a placeholder can be recognized and never filed as a
# deployment requirement: a requirement's title would otherwise name the
# validator's own placeholder, not the user's value.
_PLACEHOLDER_MARKER = "otelvalidatorplaceholder"
_DEFAULT_PLACEHOLDER = "otelvalidatorplaceholder00000000"

# Address-shaped fields. `endpoint: ${env:OTLP_ENDPOINT}` is the single most
# common line in a real configuration, and the generic placeholder above
# breaks it in two different ways: gRPC clients run it through
# net.SplitHostPort and reject it with "missing port in address", while
# URL-based exporters (prometheusremotewrite, otlp_http) reject it as an
# invalid endpoint. Both are reported as hard errors even though the
# configuration is fine and the env var is already surfaced separately as a
# deployment requirement.
#
# A scheme + host + port value satisfies both readings: SplitHostPort finds the
# :4318, and url.Parse gets an absolute URL. .invalid is the RFC 2606 reserved
# TLD, so this can never resolve to a real host if anything ever dials it.
#
# Only applied when the env reference is the ENTIRE value. `${env:HOST}:4317`
# or `https://${env:K8S_NODE_NAME}:10250` supply their own scheme/port around
# the reference, and injecting a URL there would produce nonsense like
# `https://https://x.invalid:4318:10250`.
_ADDRESS_FIELD_RE = re.compile(r"(^|_)(endpoint|url|address|addr|host|uri|dsn)$")
_ADDRESS_PLACEHOLDER = "https://otelvalidatorplaceholder.invalid:4318"


def _extract_env_references(yaml_content: str) -> list[tuple[str, str | None, bool]]:
    """Walk the parsed YAML and return ``${env:VAR}`` references.

    Each entry is ``(var_name, parent_yaml_key, is_whole_value)``. The parent
    key drives the type heuristic in ``_infer_placeholder``; ``is_whole_value``
    says whether the reference is the entire scalar (``endpoint: ${env:URL}``)
    rather than one piece of a composite (``endpoint: https://${env:HOST}:10250``).

    ``${env:VAR:-default}`` forms are skipped — the collector already has a
    fallback. On a YAML parse failure, returns an empty list: the collector
    reports the parse error on its own.
    """
    try:
        parsed = bounded_yaml.safe_load(yaml_content)
    except bounded_yaml.YAMLError:
        return []
    if not isinstance(parsed, (dict, list)):
        return []

    found: list[tuple[str, str | None, bool]] = []

    def walk(node: object, parent_key: str | None) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                next_key = k if isinstance(k, str) else parent_key
                walk(v, next_key)
        elif isinstance(node, list):
            for item in node:
                walk(item, parent_key)
        elif isinstance(node, str):
            stripped = node.strip()
            for name, default, whole in _env_references(node):
                if default is not None:
                    continue
                found.append((name, parent_key, stripped == whole))

    walk(parsed, None)
    return found


def _infer_placeholder(field_key: str | None, is_whole_value: bool = True) -> str:
    """Pick a placeholder value shape from the YAML field name.

    ``is_whole_value`` guards the address heuristic only: an address field
    whose value is *partly* an env reference already has its scheme, host, or
    port supplied by the surrounding literal text, so it gets the generic
    string placeholder (a valid bare hostname) instead of a full URL.
    """
    key = (field_key or "").lower()
    if is_whole_value and _ADDRESS_FIELD_RE.search(key):
        return _ADDRESS_PLACEHOLDER
    for pattern, value in _FIELD_HEURISTICS:
        if pattern.search(key):
            return value
    return _DEFAULT_PLACEHOLDER


# Directory-valued fields: hostmetrics' `root_path` and file_storage's
# `directory` are stat'ed at validate time, so a string placeholder there is
# an error naming the placeholder. When the reference is the whole value, its
# placeholder is an empty directory made inside the check's own directory
# (never anywhere else); with no check directory the generic placeholder
# stays. Any key named `root_path` or `directory` qualifies, whatever its
# component.
_DIRECTORY_FIELD_RE = re.compile(r"^(root_path|directory)$")

# The check's placeholder directories: each named with the placeholder marker,
# so a requirement that captures one is never emitted, and made once per check
# for each key. A check makes at most MAX_PLACEHOLDER_DIRECTORIES of its own,
# one per key; past that, every further key shares one overflow directory, so
# a value past the cap still names an existing directory and a rerun still
# meets it. The hostmetrics root's directory is reserved: it never counts
# towards the cap and is never the overflow.
PLACEHOLDER_DIRECTORY_PREFIX = _PLACEHOLDER_MARKER + "-"
MAX_PLACEHOLDER_DIRECTORIES = 64
# Every hostmetrics root_path in one check is this one directory: the
# collector refuses receivers whose root_paths differ.
HOSTMETRICS_ROOT_KEY = "root_path"
# The overflow's key: no `field:value` key can equal it (it has no colon).
_OVERFLOW_KEY = "overflow"


def directory_key(field: str, value: str) -> str:
    """The placeholder directory's key for a `field` holding `value`: one
    root for every `root_path`, one directory per distinct value otherwise."""
    return HOSTMETRICS_ROOT_KEY if field == "root_path" else f"{field}:{value}"


def _directory_name(key: str) -> str:
    return PLACEHOLDER_DIRECTORY_PREFIX + hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()[:16]


_RESERVED_DIRECTORY_NAMES = frozenset({_directory_name(HOSTMETRICS_ROOT_KEY), _directory_name(_OVERFLOW_KEY)})


def placeholder_directory(directory: str, key: str) -> str:
    """The check's placeholder directory for `key` inside `directory` (the
    check's own), made the first time it is asked for: equal keys get the
    same directory, in the first run and the rerun alike. Once the check
    holds MAX_PLACEHOLDER_DIRECTORIES keys' own directories, every further
    key gets the shared overflow directory; the root's is always its own."""
    path = os.path.join(directory, _directory_name(key))
    if os.path.isdir(path):
        return path
    if key != HOSTMETRICS_ROOT_KEY:
        with os.scandir(directory) as entries:
            made = sum(
                1
                for entry in entries
                if entry.name.startswith(PLACEHOLDER_DIRECTORY_PREFIX) and entry.name not in _RESERVED_DIRECTORY_NAMES
            )
        if made >= MAX_PLACEHOLDER_DIRECTORIES:
            path = os.path.join(directory, _directory_name(_OVERFLOW_KEY))
            if os.path.isdir(path):
                return path
    os.mkdir(path, 0o700)
    return path


def _build_env_var_placeholders(
    yaml_content: str, fixed_names: Collection[str] = frozenset(), directory: str | None = None
) -> tuple[dict[str, str], list[dict]]:
    """Return ``(env_overlay, requirements)`` for ``${env:VAR}`` refs in YAML.

    ``env_overlay`` is merged on top of the subprocess environment so the
    collector sees a non-empty, type-shaped value for each referenced var.
    ``requirements`` is pre-populated for the answer so callers see the
    deployment-time obligation regardless of whether the collector would have
    emitted its own envvar-not-set complaint.

    Vars already covered by ``VALIDATION_ENV_OVERRIDES`` are left alone:
    those placeholders were chosen for specific components (k8sattributes,
    resourcedetection) and a generic overlay would defeat the point.

    A protected name (``_PROTECTED_ENV_NAME_RE``), or one in ``fixed_names``
    (the runner passes every name the collector's fixed environment holds or
    may hold: the parent allowlist and ``_build_subprocess_env()``), gets no
    placeholder but keeps its requirement.

    A whole-value reference under a directory-valued key (any `root_path` or
    `directory`) gets a placeholder directory inside `directory`, the check's
    own (every `root_path` the same one; past MAX_PLACEHOLDER_DIRECTORIES, the
    shared overflow); without one, the generic placeholder. A variable's first
    reference decides its placeholder: one named under a directory key and
    then elsewhere keeps the directory everywhere, and the other way round.
    """
    env_overlay: dict[str, str] = {}
    seen: set[str] = set()
    requirements: list[dict] = []

    for var_name, field_key, is_whole_value in _extract_env_references(yaml_content):
        if var_name in seen or var_name in VALIDATION_ENV_OVERRIDES:
            continue
        seen.add(var_name)
        if var_name not in fixed_names and not _PROTECTED_ENV_NAME_RE.fullmatch(var_name):
            field = (field_key or "").lower()
            if directory is not None and is_whole_value and _DIRECTORY_FIELD_RE.match(field):
                env_overlay[var_name] = placeholder_directory(directory, directory_key(field, f"${{env:{var_name}}}"))
            else:
                env_overlay[var_name] = _infer_placeholder(field_key, is_whole_value)
        requirements.append(
            {
                "category": "env_var",
                "title": f"Set environment variable {var_name}",
                "description": (
                    f"This configuration references {var_name} via "
                    f"${{env:{var_name}}}. Set it in your deployment "
                    f"environment before starting the collector, or provide "
                    f"a default with ${{env:{var_name}:-fallback}}."
                ),
                "componentPath": None,
            }
        )

    return env_overlay, requirements


# ---------------------------------------------------------------------------
# Datadog exporter hostname placeholder
#
# ``otelcol-contrib validate`` is not a config-only check: it runs every
# component constructor. The datadog exporter's constructor performs cloud
# hostname detection (AWS IMDS, Azure and GCP metadata probes) and, when a
# logs pipeline is wired, a connectivity check against the Datadog logs
# intake. Where egress is denied, every one of those dials hangs, so the
# detection chain waits out its ~25s budget and the run trips the validate
# timeout, while the very same YAML validates in ~1s on a laptop (verified
# on contrib 0.147.0 / 0.158.0 / 0.159.0).
#
# The exporter skips detection entirely when ``hostname`` is set, so every
# datadog exporter that doesn't set one gets a placeholder. Nothing else
# shortens the wait: ``hostname_detection_timeout`` and
# ``AWS_EC2_METADATA_DISABLED`` were both tested and don't apply to this path.
#
# The rewrite is textual (no re-serialization, so quoting / key order / YAML
# 1.1-vs-1.2 scalars survive), touches exactly one key, and that key has no
# structural effect -- a configuration is valid with or without it. The
# placeholder exists only in the temporary file the collector reads.
# ---------------------------------------------------------------------------

_DATADOG_HOSTNAME_PLACEHOLDER = "otelcol-validator"

# Block-mapping key line inside the ``exporters:`` section: leading indent,
# ``datadog`` or ``datadog/<instance>``, a colon, then only whitespace or a
# comment. A value on the same line (``datadog: {...}`` flow style) doesn't
# match, on purpose -- there's no block to insert into.
_DATADOG_EXPORTER_KEY_RE = re.compile(r"^(?P<indent>[ ]+)(?P<key>datadog(?:/[^\s:#]+)?):[ \t]*(?:#.*)?$")
_EXPORTERS_SECTION_RE = re.compile(r"^exporters:[ \t]*(?:#.*)?$")


def _datadog_exporters_missing_hostname(yaml_content: str) -> set[str]:
    """Exporter instance keys (``datadog``, ``datadog/eu``) whose block is a
    mapping with no ``hostname`` key. Empty on parse failure or when there is
    no ``exporters`` mapping -- the binary reports those on its own."""
    try:
        parsed = bounded_yaml.safe_load(yaml_content)
    except bounded_yaml.YAMLError:
        return set()
    if not isinstance(parsed, dict):
        return set()
    exporters = parsed.get("exporters")
    if not isinstance(exporters, dict):
        return set()
    missing: set[str] = set()
    for key, cfg in exporters.items():
        if not isinstance(key, str):
            continue
        if key != "datadog" and not key.startswith("datadog/"):
            continue
        # An explicit ``hostname:`` (even an empty one) is the user's call;
        # inserting a second key would only produce a duplicate-key error.
        if isinstance(cfg, dict) and "hostname" not in cfg:
            missing.add(key)
    return missing


def _inject_datadog_hostname_placeholder(yaml_content: str) -> str:
    """Return ``yaml_content`` with ``hostname: <placeholder>`` inserted as the
    first child of every datadog exporter block that doesn't set one.

    Textual, line-based: the parsed document is only consulted to decide
    *which* instances need the key, never re-serialized. Indentation is taken
    from the block's first real child so the inserted line nests correctly;
    the line ending is copied from the key line so CRLF input stays CRLF.
    Anything this scanner can't place safely (flow-style mapping, empty
    block, quoted key, ``exporters`` not written as a block mapping) is left
    untouched -- the configuration then validates the slow way rather than
    wrong.
    """
    targets = _datadog_exporters_missing_hostname(yaml_content)
    if not targets:
        return yaml_content

    lines = yaml_content.splitlines(keepends=True)

    def _indent(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    def _is_blank_or_comment(line: str) -> bool:
        stripped = line.strip()
        return not stripped or stripped.startswith("#")

    # Locate the top-level ``exporters:`` block mapping and where it ends
    # (the next non-blank, non-comment line at column 0).
    # A leading byte-order mark is not part of the first line's key; the
    # line itself keeps it.
    def _section_line(i: int) -> str:
        line = lines[i].rstrip("\r\n")
        return line.removeprefix("\ufeff") if i == 0 else line

    start = next((i for i in range(len(lines)) if _EXPORTERS_SECTION_RE.match(_section_line(i))), None)
    if start is None:
        return yaml_content
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if not _is_blank_or_comment(lines[i]) and _indent(lines[i]) == 0:
            end = i
            break

    # The first real child of ``exporters:`` fixes the indent every exporter
    # key sits at; a deeper ``datadog:`` key belongs to some other exporter.
    child_indent = next(
        (_indent(lines[i]) for i in range(start + 1, end) if not _is_blank_or_comment(lines[i])),
        None,
    )
    if not child_indent:
        return yaml_content

    out: list[str] = []
    for i, line in enumerate(lines):
        out.append(line)
        if not (start < i < end):
            continue
        m = _DATADOG_EXPORTER_KEY_RE.match(line.rstrip("\r\n"))
        if m is None or len(m.group("indent")) != child_indent or m.group("key") not in targets:
            continue
        first_child = next(
            (lines[j] for j in range(i + 1, end) if not _is_blank_or_comment(lines[j])),
            None,
        )
        if first_child is None or _indent(first_child) <= child_indent:
            continue  # empty block; nothing to nest under
        newline = "\r\n" if line.endswith("\r\n") else "\n"
        out.append(" " * _indent(first_child) + f"hostname: {_DATADOG_HOSTNAME_PLACEHOLDER}" + newline)
    return "".join(out)
