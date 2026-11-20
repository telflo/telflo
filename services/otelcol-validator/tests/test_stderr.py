"""The stderr parser, on what the collector really prints:
tests/fixtures/collector-outputs.json holds `otelcol-contrib validate`'s
recorded stderr for each case on 0.147.0 and 0.162.0. A requirement is a
cause that matches a template whole, each template taken from a recorded
output."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

from app import stderr as stderr_module
from app.stderr import (
    COMPONENT_PATH_RE,
    MAX_CLASSIFIED_CHARACTERS,
    TEMPLATES,
    Submitted,
    _echoes_closed,
    classify_cause,
    classify_error,
    parse_stderr,
)
from tests import guard

OUTPUTS = json.loads((Path(__file__).parent / "fixtures" / "collector-outputs.json").read_text())["cases"]
VERSIONS = ("0.147.0", "0.162.0")
# What only Linux prints, recorded in the image on every offered version.
LINUX_OUTPUTS = json.loads((Path(__file__).parent / "fixtures" / "collector-outputs-linux.json").read_text())["cases"]


def _errors(case: str, version: str) -> list[tuple[str, str | None]]:
    run = OUTPUTS[case]["runs"][version]
    assert run["exitCode"] != 0, f"{case} passed on {version}"
    parsed = parse_stderr(run["stderr"])
    assert not parsed.crashed
    return [(error["message"], error["componentPath"]) for error in parsed.errors]


def _requirements(case: str, version: str) -> list[dict]:
    return parse_stderr(OUTPUTS[case]["runs"][version]["stderr"]).requirements


# Each case's errors, the same on both versions unless a version is named.
EXPECTED: dict[str, list[tuple[str, str | None]]] = {
    # ---- resolve: one error, no path
    "yaml-syntax": [("yaml: line 2: did not find expected key", None)],
    "env-badname": [
        ('environment variable "BAD-NAME" has invalid name: must match regex ^[a-zA-Z_][a-zA-Z0-9_]*$', None)
    ],
    "scalar": [("retrieved value (type=string) cannot be used as a Conf", None)],
    # ---- unmarshal: one error per component, its cause
    "one-error": [("'timeout' time: invalid duration", "exporters::otlp_http")],
    "two-unmarshal": [
        ("'otlpreceiver.Config' has invalid keys: bad_one", "receivers::otlp"),
        ("'batchprocessor.Config' has invalid keys: bad_two", "processors::batch/my-batch"),
        ("'debugexporter.Config' has invalid keys: bad_three", "exporters::debug"),
    ],
    "hyphen-decode": [
        (
            "'max_recv_msg_size_mib' expected type 'int', got unconvertible type 'string'",
            "receivers::otlp/my-recv.v2",
        )
    ],
    "unknown-type": [
        ('unknown type: "nosuchreceiver" for id: "nosuchreceiver"', "receivers::nosuchreceiver"),
        ('unknown type: "nosuchexporter" for id: "nosuchexporter/2"', "exporters::nosuchexporter/2"),
    ],
    "unknown-all": [
        ('unknown type: "zz_nosuch" for id: "zz_nosuch"', f"{section}::zz_nosuch")
        for section in ("receivers", "processors", "exporters", "connectors", "extensions")
    ],
    "unknown-hyphen": [
        ('invalid character(s) in type "no-such_exp"', "exporters::no-such_exp/my-exp.v2"),
        ('invalid character(s) in type "no-such_exp"', "service::pipelines::traces"),
    ],
    "uk-service-telemetry": [("'service' has invalid keys: zzz_bad", "service")],
    "uk-top-level": [("'otelcol.configSettings' has invalid keys: zzz_bad", None)],
    "d9d-transform-group-after-flat": [
        (
            "configuring multiple configuration styles is not supported, please use only Basic "
            "configuration or only Advanced configuration",
            "processors::transform",
        )
    ],
    "d9c-syslog-framing-trailer-empty": [
        ("'syslogreceiver.SysLogConfig' has invalid keys: octet_counting", "receivers::syslog")
    ],
    # ---- validate: one error per line, the path as printed
    "pipeline-err": [('references exporter "debug/missing" which is not configured', "service::pipelines::traces/2")],
    "pipeline-empty": [("must have at least one exporter", "service::pipelines::traces/my-pipe")],
    "d9c-time_parser-%s": [
        ("invalid `layout` for `epoch` type", "receivers::filelog::baseconfig::operators::0::builder"),
        ("invalid `layout` for `epoch` type", "receivers::filelog::baseconfig::operators::0::builder::timeparser"),
    ],
    "env-unset": [("at least one endpoint must be specified", "exporters::otlp_http")],
    "empty": [
        ("empty configuration file", None),
        ("service must have at least one pipeline", "service::pipelines"),
    ],
    # ---- build: the first failure only
    "build-hyphen": [
        (
            'failed to create "filelog/my-logs.v2" receiver for data type "logs": \'include\' must be specified',
            "receivers::filelog/my-logs.v2",
        )
    ],
    "connector-misused": [
        (
            'connector "forward/my-fwd" used as exporter in [traces] pipeline but not used in any supported '
            "receiver pipeline",
            "connectors::forward/my-fwd",
        )
    ],
    "k8s-rd": [
        (
            'failed to create "resourcedetection" processor, in pipeline "traces": failed creating detector type '
            '"k8snode": node name can\'t be found. Check the readme on how to set the required env variable',
            "processors::resourcedetection",
        )
    ],
    "d9d-routing-names-deleted-pipeline": [('pipeline not found: missing consumer: "traces/gone"', None)],
    "d9d-failover-names-deleted-pipeline": [("Error registering consumer", None)],
    "d9c-journald-lowercase-match": [
        (
            'failed to create "journald" receiver for data type "logs": journald is only supported on linux; '
            "telemetry type is not supported",
            "receivers::journald",
        )
    ],
    "d9c-filelog-in-metrics-pipeline": [
        (
            'failed to create "filelog" receiver for data type "metrics": telemetry type is not supported',
            "receivers::filelog",
        )
    ],
}


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", sorted(EXPECTED))
def test_each_stage_is_read_into_errors(case: str, version: str) -> None:
    assert _errors(case, version) == EXPECTED[case]


@pytest.mark.parametrize("version", VERSIONS)
def test_validate_stage_keeps_every_line_whatever_its_order(version: str) -> None:
    """0.147.0 and 0.162.0 print the same three errors in different orders."""
    assert sorted(_errors("two-errors", version)) == sorted(
        [
            ("must specify at least one protocol when using the OTLP receiver", "receivers::otlp"),
            ('requires a non-empty "endpoint"', "exporters::otlp_grpc/2"),
            ("at least one endpoint must be specified", "exporters::otlp_http/my-exp"),
        ]
    )


@pytest.mark.parametrize("version", VERSIONS)
def test_build_stage_reports_only_the_collectors_first_failure(version: str) -> None:
    """Two broken receivers; the collector stops at the first it builds
    (which one varies from run to run: one run saw syslog first on 0.147.0,
    this recording filelog), so the answer holds one of them."""
    errors = _errors("two-build", version)

    assert len(errors) == 1
    assert errors[0] in [
        (
            'failed to create "syslog" receiver for data type "logs": failed to resolve syslog config: '
            "unsupported protocol version: nope",
            "receivers::syslog",
        ),
        (
            'failed to create "filelog" receiver for data type "logs": \'include\' must be specified',
            "receivers::filelog",
        ),
    ]


def test_unmarshal_joins_one_components_causes() -> None:
    """Two invalid keys in one Datadog exporter: one error for the component
    (0.147.0; 0.162.0 accepts any unknown key there)."""
    assert _errors("dd-unknown", "0.147.0") == [
        (
            "'logs' has invalid keys: zzz_nor_this; 'config.Config' has invalid keys: zzz_not_a_key",
            "exporters::datadog",
        )
    ]
    assert _errors("rd-unknown", "0.147.0") == [
        ("'ecs' has invalid keys: client_config, zzz_not_a_key", "processors::resourcedetection")
    ]


def test_unknown_type_loses_the_list_of_valid_values() -> None:
    stderr = OUTPUTS["unknown-type"]["runs"]["0.162.0"]["stderr"]
    assert "valid values" in stderr
    for message, _ in _errors("unknown-type", "0.162.0"):
        assert "valid values" not in message


@pytest.mark.parametrize("version", VERSIONS)
def test_a_line_that_is_only_a_requirement_is_a_requirement(version: str) -> None:
    """`directory must exist` (file_storage) is a requirement; the hostmetrics
    line beside it (darwin only) stays an error."""
    assert _errors("reqs", version) == [("root_path is supported on linux only", "receivers::hostmetrics")]
    assert _requirements("reqs", version) == [
        {
            "category": "directory",
            "title": "Ensure /var/lib/does-not-exist/x exists at runtime",
            "description": (
                "This configuration writes to /var/lib/does-not-exist/x. Ensure the directory exists and is "
                "writable by the collector process in your deployment, or enable the component's "
                "`create_directory` option if available."
            ),
            "componentPath": "extensions::file_storage",
        }
    ]


@pytest.mark.parametrize("version", VERSIONS)
def test_the_downward_api_requirement_names_the_variable(version: str) -> None:
    """The description's literal braces are escaped, so the title is never
    `Set {0} via …`."""
    assert _errors("k8sattr-node", version) == []
    [requirement] = _requirements("k8sattr-node", version)
    assert requirement["category"] == "k8s_downward_api"
    assert requirement["title"] == "Set K8S_NODE_NAME via the Kubernetes downward API"
    assert "{0}" not in requirement["description"]
    assert "env: [{ name: K8S_NODE_NAME, valueFrom: { fieldRef: { fieldPath: spec.nodeName } } }]" in (
        requirement["description"]
    )
    assert requirement["componentPath"] == "processors::k8sattributes::filter"


def test_every_recorded_failure_parses_to_at_least_one_error_or_requirement() -> None:
    for case, recorded in OUTPUTS.items():
        for version, run in recorded["runs"].items():
            if run["exitCode"] == 0:
                continue
            parsed = parse_stderr(run["stderr"])
            assert parsed.errors or parsed.requirements, (case, version)


# ---------------------------------------------------------------------------
# A line that carries an error is never a requirement
# ---------------------------------------------------------------------------


def test_an_error_and_a_requirement_on_one_line_is_an_error() -> None:
    stderr = (
        "Error: receivers::otlp: must specify at least one protocol when using the OTLP receiver; "
        "extensions::file_storage: directory must exist: stat /var/lib/otel: no such file or directory\n"
    )

    parsed = parse_stderr(stderr)

    assert parsed.requirements == []
    assert parsed.errors == [
        {
            "message": (
                "must specify at least one protocol when using the OTLP receiver; extensions::file_storage: "
                "directory must exist: stat /var/lib/otel: no such file or directory"
            ),
            "componentPath": "receivers::otlp",
        }
    ]


# Causes the collector really printed (the templates' sources).
DIRECTORY_CAUSE = (
    "directory must exist: stat /var/lib/otel: no such file or directory. "
    "You can enable the create_directory option to automatically create it"
)
ENV_CAUSE = '`node_from_env_var` is configured but envvar "MY_TOKEN" is not set'


def test_classify_error_needs_every_cause_to_be_a_requirement() -> None:
    assert classify_error([ENV_CAUSE, DIRECTORY_CAUSE], None) is not None
    assert classify_error([ENV_CAUSE, "something else broke"], None) is None
    assert classify_error(["something broke"], None) is None
    assert classify_error([], None) is None


def test_log_lines_before_the_error_add_requirements_but_no_errors() -> None:
    stderr = (
        "2026-10-06T10:00:00.000Z\twarn\tsomething noisy happened\n"
        f"{ENV_CAUSE}\n"
        "Error: exporters::otlp_grpc/2: requires a non-empty \"endpoint\"\n"
    )

    parsed = parse_stderr(stderr)

    assert parsed.errors == [{"message": 'requires a non-empty "endpoint"', "componentPath": "exporters::otlp_grpc/2"}]
    assert [r["title"] for r in parsed.requirements] == ["Set environment variable MY_TOKEN"]


def test_a_log_line_that_only_holds_a_requirements_words_adds_nothing() -> None:
    """A requirement is never read anywhere in a log line; a cause must be
    the whole line."""
    parsed = parse_stderr(f"2026/10/06 10:00:00 retrying: {ENV_CAUSE}\nE1006 klog] {DIRECTORY_CAUSE}\n")

    assert parsed.requirements == []
    assert parsed.errors == []


def test_output_with_no_error_line_names_no_error() -> None:
    parsed = parse_stderr("2026-10-06T10:00:00.000Z\tinfo\tstarting\nsomething unexpected\n")

    assert parsed.errors == []
    assert parsed.requirements == []
    assert parsed.crashed is False


def test_a_go_panic_reads_as_a_crash() -> None:
    parsed = parse_stderr("panic: runtime error: invalid memory address\n\ngoroutine 1 [running]:\nmain.main()\n")

    assert parsed.crashed is True
    assert parsed.errors == []


def test_the_truncation_marker_is_not_an_error() -> None:
    parsed = parse_stderr("Error: receivers::otlp: bad\n\n[stderr truncated by validator]\n")

    assert parsed.errors == [{"message": "bad", "componentPath": "receivers::otlp"}]


# ---------------------------------------------------------------------------
# The component path keeps `/name`, hyphens and dots
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line", "path"),
    [
        ("exporters::otlp/2: requires a non-empty endpoint", "exporters::otlp/2"),
        ("exporters::otlp_http/my-exp.v2: bad", "exporters::otlp_http/my-exp.v2"),
        ("service::pipelines::traces/my-pipe: must have at least one exporter", "service::pipelines::traces/my-pipe"),
        ("receivers::k8s-events/a.b: x", "receivers::k8s-events/a.b"),
        ("processors::batch: x", "processors::batch"),
    ],
)
def test_component_path_keeps_the_whole_id(line: str, path: str) -> None:
    match = COMPONENT_PATH_RE.search(line)
    assert match is not None
    assert match.group(1) == path
    # And through the parser's validate stage.
    assert parse_stderr(f"Error: {line}\n").errors[0]["componentPath"] == path


def test_classify_cause_keeps_the_component_path() -> None:
    requirement = classify_cause(ENV_CAUSE, "exporters::otlp_http/my-exp.v2")

    assert requirement is not None
    assert requirement["componentPath"] == "exporters::otlp_http/my-exp.v2"


# ---------------------------------------------------------------------------
# A requirement pattern recognises only the collector's own phrasing, never
# text it echoes from the configuration
# ---------------------------------------------------------------------------

# Recorded outputs (both versions print the same) whose requirement phrasing
# sits where the collector echoes the text. Each, read as a requirement,
# would hide the error, so the text would answer valid.
ECHOED_ERRORS: dict[str, list[tuple[str, str | None]]] = {
    # A receiver key literally named like a cause.
    "echo-invalid-key": [("'otlpreceiver.Config' has invalid keys: envvar \"X\" is not set", "receivers::otlp")],
    "echo-invalid-key-stat": [
        ("'otlpreceiver.Config' has invalid keys: stat /y: no such file or directory", "receivers::otlp")
    ],
    # A map key, in mapstructure's quotes, in an "expected type" error.
    "echo-map-key-type": [
        (
            "'[envvar \"X\" is not set]' expected type 'configopaque.String', got unconvertible type "
            "'map[string]interface {}'",
            "exporters::otlp_http",
        )
    ],
    # A value, in Go's quotes.
    "echo-quoted-stat": [
        ("'compression' unsupported compression type \"stat /y: no such file or directory\"", "exporters::otlp_http")
    ],
    "echo-quoted-tls": [("'level' unrecognized level: \"tls: failed to verify certificate\"", None)],
}

# Echo channels that were errors already (Go escapes the quotes in a quoted
# id or type, so `envvar "` never appears): kept so a change is noticed.
ECHOED_ALREADY_ERRORS = ("echo-id-name", "echo-unknown-type", "echo-pipeline-ref")


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", sorted(ECHOED_ERRORS))
def test_a_requirement_phrase_the_collector_echoes_stays_an_error(case: str, version: str) -> None:
    assert _errors(case, version) == ECHOED_ERRORS[case]
    assert _requirements(case, version) == []


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", ECHOED_ALREADY_ERRORS)
def test_an_echoed_id_or_type_stays_an_error(case: str, version: str) -> None:
    assert _errors(case, version)
    assert _requirements(case, version) == []


@pytest.mark.parametrize(
    "line",
    [
        # Inside a quoted value, whatever quotes it.
        "'endpoint' invalid value \"envvar \\\"X\\\" is not set\"",
        "'compression' unsupported compression type \"directory must exist: stat /x: no such file\"",
        "'[stat /y: no such file or directory]' expected type 'string', got unconvertible type 'int'",
        "invalid `envvar \"X\" is not set` given",
        # An unterminated quote (the collector cut the value) runs to the end.
        "'timeout' time: invalid duration \"tls: failed to verify certificate",
        # In an invalid-keys list, wherever it sits in the list.
        "'otlpreceiver.Config' has invalid keys: bogus, envvar \"X\" is not set",
        "'otlpreceiver.Config' has invalid keys: x509: certificate signed by unknown authority",
        # Mid-sentence, not where a cause starts.
        "listen tcp: address envvar \"X\" is not set: missing port in address",
    ],
)
def test_a_phrase_inside_an_echo_is_not_a_requirement(line: str) -> None:
    assert classify_cause(line, None) is None
    assert classify_error([line], None) is None


def test_a_message_is_never_split_into_causes_after_the_fact() -> None:
    """A `; ` inside a value is part of the value: the parser's causes are
    its lines, never pieces cut out of a joined message."""
    stderr = f"Error: exporters::otlp: 'compression' unsupported \"a; {DIRECTORY_CAUSE}\"\n"
    assert parse_stderr(stderr).requirements == []
    stderr = f"Error: extensions::file_storage: {DIRECTORY_CAUSE}; {DIRECTORY_CAUSE}\n"
    assert parse_stderr(stderr).requirements == []


def test_a_component_is_a_requirement_only_when_every_cause_line_is_one() -> None:
    block = (
        "Error: failed to get config: cannot unmarshal the configuration: decoding failed due to the "
        "following error(s):\n\n'extensions' error reading configuration for \"file_storage\": "
    )
    assert parse_stderr(block + f"{DIRECTORY_CAUSE}\n{ENV_CAUSE}\n").errors == []
    parsed = parse_stderr(block + f"{DIRECTORY_CAUSE}\n'x' has invalid keys: y\n")
    assert parsed.requirements == []
    assert parsed.errors == [
        {"message": f"{DIRECTORY_CAUSE}; 'x' has invalid keys: y", "componentPath": "extensions::file_storage"}
    ]


# ---------------------------------------------------------------------------
# Requirements by template, each from a recorded output
# ---------------------------------------------------------------------------

# Every recorded requirement output: (category, title, componentPath), the
# same on both versions.
RECORDED_REQUIREMENTS: dict[str, tuple[str, str, str]] = {
    "reqs": ("directory", "Ensure /var/lib/does-not-exist/x exists at runtime", "extensions::file_storage"),
    "req-file-storage-directory": (
        "directory",
        "Ensure /var/lib/otelcol-missing/fs exists at runtime",
        "extensions::file_storage",
    ),
    "k8sattr-node": (
        "k8s_downward_api",
        "Set K8S_NODE_NAME via the Kubernetes downward API",
        "processors::k8sattributes::filter",
    ),
    "req-k8sattr-node-env-custom": (
        "env_var",
        "Set environment variable MY_CUSTOM_NODE",
        "processors::k8sattributes::filter",
    ),
    "req-rd-k8snode-service-account": (
        "k8s_in_cluster",
        "Mount a Kubernetes service account",
        "processors::resourcedetection",
    ),
}


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", sorted(RECORDED_REQUIREMENTS))
def test_every_recorded_requirement_is_still_a_requirement(case: str, version: str) -> None:
    run = OUTPUTS[case]["runs"][version]
    for parsed in (parse_stderr(run["stderr"]), parse_stderr(run["stderr"], OUTPUTS[case]["yaml"])):
        assert [
            (r["category"], r["title"], r["componentPath"]) for r in parsed.requirements
        ] == [RECORDED_REQUIREMENTS[case]]


@pytest.mark.parametrize("template", TEMPLATES, ids=[t.source for t in TEMPLATES])
def test_every_template_is_taken_from_a_recorded_output_it_matches(template) -> None:  # noqa: ANN001
    """A template's source is a recorded case, on every version it was
    recorded on, whose requirement is this template's."""
    if template.source in LINUX_RECORDED_REQUIREMENTS:
        category, title, _ = LINUX_RECORDED_REQUIREMENTS[template.source]
        runs = LINUX_OUTPUTS[template.source]["runs"]
    else:
        assert template.source in RECORDED_REQUIREMENTS
        category, title, _ = RECORDED_REQUIREMENTS[template.source]
        runs = {version: OUTPUTS[template.source]["runs"][version] for version in VERSIONS}
    assert template.category == category
    assert runs
    for run in runs.values():
        [requirement] = parse_stderr(run["stderr"]).requirements
        assert requirement["title"] == title


# The Linux recordings that are requirements (collector-outputs-linux.json),
# the same on every offered version.
LINUX_RECORDED_REQUIREMENTS: dict[str, tuple[str, str, str]] = {
    "req-hostmetrics-root-path": (
        "host_filesystem",
        "Mount the host filesystem at /nonexistent-root",
        "receivers::hostmetrics",
    ),
}


@pytest.mark.parametrize("case", sorted(LINUX_OUTPUTS))
def test_every_linux_recording_reads_as_recorded(case: str) -> None:
    """Each Linux recording, on every version: the requirement it is the
    source of, with no error; an error that stays an error; or nothing
    printed (validate passed: no output to take a template from)."""
    runs = LINUX_OUTPUTS[case]["runs"]
    assert sorted(runs) == ["0.159.0", "0.160.0", "0.161.0", "0.162.0"]
    for version, run in runs.items():
        for parsed in (parse_stderr(run["stderr"]), parse_stderr(run["stderr"], LINUX_OUTPUTS[case]["yaml"])):
            if case in LINUX_RECORDED_REQUIREMENTS:
                assert parsed.errors == [], version
                assert [(r["category"], r["title"], r["componentPath"]) for r in parsed.requirements] == [
                    LINUX_RECORDED_REQUIREMENTS[case]
                ], version
            elif run["exitCode"] == 0:
                assert run["stderr"] == "", version
                assert parsed.errors == [] and parsed.requirements == [], version
            else:
                assert parsed.requirements == [], version
                assert parsed.errors == [LINUX_RECORDED_ERRORS[case]], version


# The Linux recordings that stay errors: kubeletstats' own TLS files
# (`auth_type: tls`) aren't under a `tls:` key, so the text's TLS-files
# requirement doesn't see them, and no template takes them.
LINUX_RECORDED_ERRORS: dict[str, dict] = {
    "linux-kubeletstats-tls-files": {
        "message": 'failed to create "kubeletstats" receiver for data type "metrics": cert path '
        "/etc/otel/missing-ca.pem could not be read: open /etc/otel/missing-ca.pem: no such file or directory",
        "componentPath": "receivers::kubeletstats",
    },
}


ROOT_PATH_CAUSE = "invalid root_path: stat /host: no such file or directory"


def test_hostmetrics_root_path_is_a_host_filesystem_requirement() -> None:
    requirement = classify_cause(ROOT_PATH_CAUSE, "receivers::hostmetrics")

    assert requirement == {
        "category": "host_filesystem",
        "title": "Mount the host filesystem at /host",
        "description": (
            "The hostmetrics receiver scrapes from /host. Mount the host's root filesystem as a hostPath "
            "volume at /host in your pod spec so the collector can read host-level metrics."
        ),
        "componentPath": "receivers::hostmetrics",
    }


@pytest.mark.parametrize(
    "cause",
    [
        "x" + ROOT_PATH_CAUSE,
        ROOT_PATH_CAUSE + ".",
        ROOT_PATH_CAUSE.replace("/host", "host"),
        ROOT_PATH_CAUSE.replace("/host", "/a b"),
        ROOT_PATH_CAUSE.replace("/host", "/x'y"),
        ROOT_PATH_CAUSE.replace("/host", "/${y}"),
        ROOT_PATH_CAUSE.replace("/host", "/a: b"),
        ROOT_PATH_CAUSE.replace("no such file or directory", "permission denied"),
        "'hostmetricsreceiver.Config' has invalid keys: " + ROOT_PATH_CAUSE,
    ],
)
def test_the_root_path_template_takes_only_the_whole_recorded_phrasing(cause: str) -> None:
    assert classify_cause(cause, "receivers::hostmetrics") is None


def test_a_root_path_phrase_the_text_holds_is_an_error() -> None:
    """The submitted-text guard holds for this template: a key the collector
    echoes, spelled as the cause, is the text's own words."""
    text = f"receivers:\n  hostmetrics:\n    '{ROOT_PATH_CAUSE}': 1\n"
    stderr = f"Error: receivers::hostmetrics: {ROOT_PATH_CAUSE}\n"

    parsed = parse_stderr(stderr, text)

    assert parsed.requirements == []
    assert parsed.errors == [{"message": ROOT_PATH_CAUSE, "componentPath": "receivers::hostmetrics"}]


# Bypasses, recorded on both real collectors: the collector's own
# substitution (`$${y}` printed as `${y}`, `${env:Y}` and a neutralised
# `${file:}` printed as the validator's placeholder), and texts PyYAML
# refused that the collector reads (a second document, a `=` or date-like
# value) with the phrase spelt by a YAML escape. Each would answer valid
# unguarded; each is the collector's error, with or without the text.
BYPASSES = sorted(case for case in OUTPUTS if case.startswith("bypass-"))


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", BYPASSES)
def test_every_reviewers_bypass_is_an_error(case: str, version: str) -> None:
    run = OUTPUTS[case]["runs"][version]
    assert run["exitCode"] != 0
    for parsed in (parse_stderr(run["stderr"]), parse_stderr(run["stderr"], OUTPUTS[case]["yaml"])):
        assert parsed.requirements == []
        assert len(parsed.errors) == 1


def test_the_bypasses_are_recorded() -> None:
    assert len(BYPASSES) == 11


# Requirement phrasings that no recorded output matches don't fire from
# the output: each is an error. Of the image's recorded Linux outputs, only
# hostmetrics' root_path printed one (the host_filesystem template, below).
DROPPED_PHRASINGS = [
    # k8s_in_cluster: no in-cluster configuration (the service sets the variables).
    "error creating client: unable to load k8s config, KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT "
    "must be defined",
    # k8s_in_cluster: the service account, other than resourcedetection's k8snode detector.
    "failed to create K8s API client: open /var/run/secrets/kubernetes.io/serviceaccount/token: "
    "no such file or directory",
    # k8s_in_cluster: the image's placeholder CA (Linux, in the image).
    'failed to fetch namespaces: Get "https://kubernetes.default.svc:443/api/v1/namespaces": '
    "tls: failed to verify certificate: x509: certificate signed by unknown authority",
    # k8s_in_cluster: the apiserver unreachable.
    'failed to list *v1.Pod: Get "https://kubernetes.default.svc:443/api/v1/pods": dial tcp 10.96.0.1:443: '
    "i/o timeout",
    # env_var: an unset variable, without k8sattributes' lead.
    'envvar "MY_TOKEN" is not set',
    'failed to resolve: environment variable "API_KEY" not found',
    # tls_files: `validate` never loads TLS files (the service reads them
    # from the text).
    'failed to create "otlp" receiver: failed to load TLS config: open /etc/tls/a.crt: no such file or directory',
    # missing_path: no component prints a bare stat as its whole cause.
    "stat /data/queue: no such file or directory",
]


@pytest.mark.parametrize("phrasing", DROPPED_PHRASINGS)
def test_a_dropped_patterns_phrasing_is_an_error(phrasing: str) -> None:
    assert classify_cause(phrasing, None) is None
    assert parse_stderr(f"Error: receivers::x: {phrasing}\n").requirements == []


@pytest.mark.parametrize(
    "cause",
    [
        # A template's words with something before or after: not whole.
        "x" + DIRECTORY_CAUSE,
        DIRECTORY_CAUSE + ".",
        "invalid detector key: " + ENV_CAUSE,
        # A variable part outside its class.
        DIRECTORY_CAUSE.replace("/var/lib/otel", "/var/lib/${y}"),
        DIRECTORY_CAUSE.replace("/var/lib/otel", "/var/lib/a b"),
        DIRECTORY_CAUSE.replace("/var/lib/otel", "var/lib/otel"),
        DIRECTORY_CAUSE.replace("/var/lib/otel", "/x'y"),
        DIRECTORY_CAUSE.replace("/var/lib/otel", "/x]y"),
        DIRECTORY_CAUSE.replace("/var/lib/otel", "/x: y"),
        ENV_CAUSE.replace("MY_TOKEN", "MY-TOKEN"),
        ENV_CAUSE.replace("MY_TOKEN", 'X\\" y'),
    ],
)
def test_a_cause_matches_a_template_whole_or_not_at_all(cause: str) -> None:
    assert classify_cause(cause, None) is None


def test_a_cause_whose_quotes_are_left_open_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """The span rule, kept on top of the templates (no template lets a quote
    open today: a template that did would still be refused)."""
    template = TEMPLATES[0]
    monkeypatch.setattr(
        stderr_module,
        "TEMPLATES",
        (type(template)(template.source, re.compile(r'open "(?P<path>.*)'), "directory", "{path}", "{path}"),),
    )

    assert classify_cause('open "/x', None) is None
    assert classify_cause('open "/x"', None)["title"] == '/x"'
    assert _echoes_closed("'a' has invalid keys: b") is False


# ---------------------------------------------------------------------------
# A phrase the submitted text holds is never a requirement
# ---------------------------------------------------------------------------

# Bypasses, recorded on both real collectors: a key or value that closes the
# collector's unescaped '…' early, or one it echoes unquoted. Each would
# answer valid (a requirement hiding the only error) unguarded; each message
# is the collector's own, the path its component.
SUBMITTED_ECHOES: dict[str, tuple[str, str]] = {
    "echo-headers-key-stat": (
        "'[x': stat /y: no such file or directory]' expected type 'configopaque.String', got unconvertible "
        "type 'map[string]interface {}'",
        "exporters::otlp_http",
    ),
    "echo-headers-key-envvar": (
        "'[x': envvar \"X\" is not set]' expected type 'configopaque.String', got unconvertible type "
        "'map[string]interface {}'",
        "exporters::otlp_http",
    ),
    "echo-headers-key-bracket-stat": (
        "'[x'] stat /y: no such file or directory]' expected type 'configopaque.String', got unconvertible "
        "type 'map[string]interface {}'",
        "exporters::otlp_http",
    ),
    "echo-start-at-stat": (
        'failed to create "filelog" receiver for data type "logs": invalid start_at location '
        "'x': stat /y: no such file or directory'",
        "receivers::filelog",
    ),
    "echo-encoding-stat": (
        'failed to create "filelog" receiver for data type "logs": unsupported encoding '
        "'x': stat /y: no such file or directory'",
        "receivers::filelog",
    ),
    "echo-operator-type-stat": (
        "'operators[0]' unsupported type 'x': stat /y: no such file or directory'",
        "receivers::filelog",
    ),
    "echo-error-mode-stat": (
        "'error_mode' unknown error mode x: stat /y: no such file or directory",
        "processors::transform",
    ),
    "echo-detector-envvar": (
        'failed to create "resourcedetection" processor, in pipeline "logs": invalid detector key: '
        'x: envvar "HOME_DIR" is not set',
        "processors::resourcedetection",
    ),
    "echo-detector-stat": (
        'failed to create "resourcedetection" processor, in pipeline "logs": invalid detector key: '
        "stat /y: no such file or directory",
        "processors::resourcedetection",
    ),
}


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", sorted(SUBMITTED_ECHOES))
def test_a_requirement_phrase_the_submitted_text_holds_stays_an_error(case: str, version: str) -> None:
    run = OUTPUTS[case]["runs"][version]

    parsed = parse_stderr(run["stderr"], OUTPUTS[case]["yaml"])

    assert parsed.errors == [{"message": SUBMITTED_ECHOES[case][0], "componentPath": SUBMITTED_ECHOES[case][1]}]
    assert parsed.requirements == []


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("case", sorted(SUBMITTED_ECHOES))
def test_the_templates_alone_make_these_echoes_errors(case: str, version: str) -> None:
    """Without the submitted text (the guard above), the quote rules alone
    read each of these as a requirement that hid the error; no template
    matches any of them whole."""
    parsed = parse_stderr(OUTPUTS[case]["runs"][version]["stderr"])

    assert parsed.errors == [{"message": SUBMITTED_ECHOES[case][0], "componentPath": SUBMITTED_ECHOES[case][1]}]
    assert parsed.requirements == []


@pytest.mark.parametrize(
    ("case", "version"),
    [
        (case, version)
        for case in sorted(set(OUTPUTS) - set(SUBMITTED_ECHOES))
        for version in VERSIONS
        if OUTPUTS[case]["runs"][version]["exitCode"] != 0
    ],
)
def test_every_other_recorded_output_reads_the_same_with_its_text(case: str, version: str) -> None:
    """The submitted text changes nothing else: the recorded requirements
    (`reqs`, `k8sattr-node`) are still requirements."""
    run = OUTPUTS[case]["runs"][version]

    assert parse_stderr(run["stderr"], OUTPUTS[case]["yaml"]) == parse_stderr(run["stderr"])


def test_the_recorded_requirements_survive_their_own_text() -> None:
    requirements = [
        requirement["title"]
        for case in ("reqs", "k8sattr-node")
        for version in VERSIONS
        for requirement in parse_stderr(OUTPUTS[case]["runs"][version]["stderr"], OUTPUTS[case]["yaml"]).requirements
    ]

    assert requirements == [
        "Ensure /var/lib/does-not-exist/x exists at runtime",
        "Ensure /var/lib/does-not-exist/x exists at runtime",
        "Set K8S_NODE_NAME via the Kubernetes downward API",
        "Set K8S_NODE_NAME via the Kubernetes downward API",
    ]


_Y_CAUSE = DIRECTORY_CAUSE.replace("/var/lib/otel", "/y")
# The same cause spelt with a YAML escape: the raw text doesn't hold it.
_Y_ESCAPED = _Y_CAUSE.replace("/y", "\\x2fy")


@pytest.mark.parametrize(
    ("text", "requirement"),
    [
        # A decoded key: the raw text never holds the cause, its decoding does.
        (f'exporters:\n  otlp_http:\n    headers:\n      "{_Y_ESCAPED}": 1\n', None),
        # ... in a text with a date-like value, which plain PyYAML refuses.
        (
            f'exporters:\n  otlp_http:\n    headers:\n      "{_Y_ESCAPED}": 1\n'
            "      h: 2001-13-45\n",
            None,
        ),
        # A scalar value, and a value inside a list.
        (f"receivers:\n  filelog:\n    encoding: '{_Y_CAUSE}'\n", None),
        (f"processors:\n  resourcedetection:\n    detectors: ['{_Y_CAUSE}']\n", None),
        # Text that doesn't parse: its raw words count.
        (f"receivers: [\n  {_Y_CAUSE}\n", None),
        # A text that holds only part of the cause: the collector said it.
        ("extensions:\n  file_storage:\n    directory: /y\n", "Ensure /y exists at runtime"),
    ],
)
def test_the_submitted_texts_keys_values_and_raw_words_count(text: str, requirement: str | None) -> None:
    found = classify_error([_Y_CAUSE], None, Submitted(text))

    assert (found["title"] if found else None) == requirement


# ---------------------------------------------------------------------------
# Classifying is linear in the output (operation counts, not time: every
# Python line the classifier runs is counted)
# ---------------------------------------------------------------------------


def _lines_run(function, *args) -> int:
    """How many lines of app/stderr.py run during `function(*args)`."""
    count = 0
    target = stderr_module.__file__

    def tracer(frame, event, arg):  # noqa: ANN001 - sys.settrace's signature
        nonlocal count
        if frame.f_code.co_filename != target:
            return None
        if event == "line":
            count += 1
        return tracer

    previous = sys.gettrace()
    sys.settrace(tracer)
    try:
        function(*args)
    finally:
        sys.settrace(previous)
    return count


def _quoted_encoding_message(units: int) -> str:
    """A probe, recorded (`echo-encoding-quotes`): filelog's
    `unsupported encoding '<value>'` echoes the value in unescaped '…'; a
    value of repeated `': 'b` gives a span and a cause start every 5
    characters. Scaled from the recorded output."""
    recorded = OUTPUTS["echo-encoding-quotes"]["runs"]["0.162.0"]["stderr"]
    small = "a" + "': 'b" * 3
    assert small in recorded
    return recorded.replace(small, "a" + "': 'b" * units).strip()[len("Error: failed to build pipelines: ") :]


def test_the_span_rule_is_linear_in_the_cause() -> None:
    """The first fix rescanned the echoes per quote and per cause start:
    doubling this message nearly quadrupled the work (3.4x), and an 80 KB
    output froze the event loop for 12 s."""
    short, long = _quoted_encoding_message(400), _quoted_encoding_message(800)

    work_short = _lines_run(_echoes_closed, short)
    work_long = _lines_run(_echoes_closed, long)

    assert work_long <= 2.2 * work_short
    assert work_long <= 20 * len(long)


def test_a_cause_longer_than_4_kib_is_an_error_without_any_template_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    tried = _count_template_attempts(monkeypatch)
    at_limit = DIRECTORY_CAUSE.replace("/var/lib/otel", "/" + "x" * (MAX_CLASSIFIED_CHARACTERS - len(DIRECTORY_CAUSE) + 12))
    over = at_limit.replace("/x", "/xx", 1)

    assert len(at_limit) == MAX_CLASSIFIED_CHARACTERS
    assert classify_cause(at_limit, None)["category"] == "directory"
    tried.clear()
    assert classify_cause(over, None) is None
    assert classify_error([over], None) is None
    assert tried == []


def test_the_reviewers_80_kb_output_is_read_in_linear_work() -> None:
    """One 80 KB message (the probe that froze the loop): an error, read
    without classifying it."""
    stderr = "Error: failed to build pipelines: " + _quoted_encoding_message(16_000) + "\n"
    assert len(stderr) > 80_000

    work = _lines_run(parse_stderr, stderr)

    assert parse_stderr(stderr).errors[0]["componentPath"] == "receivers::filelog"
    assert work <= len(stderr)


def test_a_whole_output_is_read_in_work_linear_in_its_size() -> None:
    def output(messages: int) -> str:
        cause = "'b': " * 100 + 'envvar "X" is not set'
        return (
            "Error: failed to get config: cannot unmarshal the configuration: decoding failed due to the "
            "following error(s):\n\n"
            + "".join(f"'receivers' error reading configuration for \"r{i}\": {cause}\n" for i in range(messages))
        )

    work_short, work_long = _lines_run(parse_stderr, output(200)), _lines_run(parse_stderr, output(400))

    assert work_long <= 2.2 * work_short
    assert work_long <= 20 * len(output(400))


def test_each_template_is_tried_once_per_cause(monkeypatch: pytest.MonkeyPatch) -> None:
    """A cause is tried against each template once, from its start (a full
    match), never from each of its positions."""
    tried = _count_template_attempts(monkeypatch)
    cause = ": dial tcp " * 300

    assert classify_cause(cause, None) is None
    assert len(tried) == len(TEMPLATES)


def _count_template_attempts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Wrap every template's pattern so each attempt is recorded (its
    source)."""
    tried: list[str] = []

    class Counted:
        def __init__(self, pattern: re.Pattern, source: str) -> None:
            self.pattern, self.source = pattern, source

        def fullmatch(self, *args):  # noqa: ANN002
            tried.append(self.source)
            return self.pattern.fullmatch(*args)

    templates = tuple(
        type(t)(t.source, Counted(t.pattern, t.source), t.category, t.title, t.description) for t in TEMPLATES
    )
    monkeypatch.setattr(stderr_module, "TEMPLATES", templates)
    return tried


# The old validate-line expression, `(?:::\S+?)*` before `: `, backtracked
# exponentially on a line of `::a` groups with no `: ` (22 groups: 0.5 s,
# each one more doubling it): run where a hang can be stopped.
_LONG_PATH_LINE = (
    "import json\n"
    "from app import stderr\n"
    "line = 'receivers' + '::a' * 2000 + ':x'\n"
    "parsed = stderr.parse_stderr(f'Error: {line}\\n')\n"
    "print(json.dumps([parsed.errors, line]))\n"
)


def test_a_long_path_line_is_matched_without_backtracking() -> None:
    errors, line = guard.in_subprocess(_LONG_PATH_LINE)

    assert errors == [{"message": line, "componentPath": None}]
