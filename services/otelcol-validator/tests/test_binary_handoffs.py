"""Configurations the component forms can write, checked against every
offered collector (marked `binary`, run inside the image with
`pytest -m binary`).

Each case has its expected answer per offered version, established on
0.159.0-0.162.0 with the real binaries in the image. Every one is refused on
every offered version but:
- resourcedetection's `client_config.timeout` and Datadog's dropped keys
  (`hostname_source`, `logs.dump_payloads`, `idle_connection_timeout`),
  accepted from 0.160.0: an upstream regression (from 0.160.0 sections
  embedding the HTTP client or server settings accept any unknown key),
  recorded, not worked around; Datadog's `headers` stays refused;
- netflow's `queue_size: 0` and spanmetrics' bare-number buckets, accepted
  (and run); failover's duplicate level is test_binary_connectors.py's F4;
- the controls, accepted, each beside the case it guards.
No redaction case needs the service: `validate` itself refuses each
malformed regex. A case the collector starts accepting (or refusing) fails
here rather than being skipped.

The start-only cases: `validate` accepts each (checked on the raw collector,
so an upstream change is noticed) and the service reports what the host must
provide, from the text.

A tail_sampling OTTL policy with no conditions is an error from the service.
"""

from __future__ import annotations

import re
from collections.abc import Callable

import pytest

from tests.binary_support import OFFERED, check, errors_match, raw_validate, version_key

pytestmark = pytest.mark.binary

# ---- the texts -----------------------------------------------------------------

R = "receivers:\n  otlp:\n    protocols:\n      grpc:\n"


def processor(name: str, body: str, signal: str = "traces") -> str:
    return (
        f"{R}processors:\n  {name}:\n{body}exporters:\n  debug:\nservice:\n  pipelines:\n    {signal}:\n"
        f"      receivers: [otlp]\n      processors: [{name}]\n      exporters: [debug]\n"
    )


def exporter(name: str, body: str, signal: str = "traces") -> str:
    return (
        f"{R}exporters:\n  {name}:\n{body}service:\n  pipelines:\n    {signal}:\n"
        f"      receivers: [otlp]\n      exporters: [{name}]\n"
    )


def receiver(name: str, body: str, signal: str = "logs") -> str:
    return (
        f"receivers:\n  {name}:\n{body}exporters:\n  debug:\nservice:\n  pipelines:\n    {signal}:\n"
        f"      receivers: [{name}]\n      exporters: [debug]\n"
    )


def routing(body: str, pipelines: str) -> str:
    return (
        f"{R}exporters:\n  debug:\nconnectors:\n  routing:\n{body}service:\n  pipelines:\n    traces:\n"
        f"      receivers: [otlp]\n      exporters: [routing]\n{pipelines}"
    )


def failover(body: str, pipelines: str) -> str:
    return (
        f"{R}exporters:\n  debug:\nconnectors:\n  failover:\n{body}service:\n  pipelines:\n    traces:\n"
        f"      receivers: [otlp]\n      exporters: [failover]\n{pipelines}"
    )


FILELOG = "    include: [/tmp/x.log]\n    operators:\n"
TRACES_B = "    traces/b:\n      receivers: [routing]\n      exporters: [debug]\n"
TRACES_A = "    traces/a:\n      receivers: [failover]\n      exporters: [debug]\n"
DATADOG = "    api:\n      key: 0123456789abcdef0123456789abcdef\n    hostname: h\n"

# ---- the answers ---------------------------------------------------------------

Answer = Callable[[str], list[dict]]


def error(message: str | re.Pattern[str], path: str | None) -> dict:
    return {"message": message, "componentPath": path}


def refused(*errors: dict) -> Answer:
    """Refused on every offered version, with these errors."""
    return lambda _version: list(errors)


def accepted() -> Answer:
    return lambda _version: []


def accepted_from(since: str, *errors: dict) -> Answer:
    """Accepted from `since` on, refused before it with these errors."""
    return lambda version: [] if version_key(version) >= version_key(since) else list(errors)


def by_version(since: str, before: list[dict], after: list[dict]) -> Answer:
    """Refused on every version, the message changed at `since`."""
    return lambda version: after if version_key(version) >= version_key(since) else before


def invalid_keys(where: str, keys: str, path: str) -> dict:
    return error(f"'{where}' has invalid keys: {keys}", path)


def build(component: str, kind: str, where: str, cause: str, path: str) -> dict:
    """A build-stage failure: `where` is `, in pipeline "p"` or ` for data type "t"`."""
    return error(f'failed to create "{component}" {kind}{where}: {cause}', path)


def filelog_refusal(cause: str) -> dict:
    return build("filelog", "receiver", ' for data type "logs"', cause, "receivers::filelog")


def redaction_refusal(cause: str) -> dict:
    return build(
        "redaction",
        "processor",
        ', in pipeline "traces"',
        f"error creating a redaction processor: {cause}",
        "processors::redaction",
    )


# The transform processor's context list is printed in Go's map order, which
# varies from run to run; its syntax error changed shape at 0.160.0.
CONTEXTS = r'\[(?:"\w+")(?: "\w+")*\]'


def transform_refusal(statements: str, before: str, after: str) -> Answer:
    def message(tail: str) -> re.Pattern[str]:
        return re.compile(
            rf"unable to infer a valid context \({CONTEXTS}\) from statements {re.escape(statements)} "
            rf"and conditions \[\]: statement has invalid syntax{re.escape(tail)}"
        )

    return by_version(
        "0.160.0",
        [error(message(before), "processors::transform")],
        [error(message(after), "processors::transform")],
    )


CASES: dict[str, tuple[str, Answer]] = {
    # ---- keys the collector refuses
    "attributes' top-level cacheenabled": (
        processor("attributes", "    cacheenabled: true\n    actions:\n      - key: a\n        value: b\n        action: insert\n"),
        refused(invalid_keys("attributesprocessor.Config", "cacheenabled", "processors::attributes")),
    ),
    "client_ca_file on an exporter": (
        exporter("otlp", "    endpoint: localhost:4317\n    tls:\n      client_ca_file: /tmp/ca.pem\n"),
        refused(invalid_keys("tls", "client_ca_file", "exporters::otlp")),
    ),
    "client_ca_file_reload on an exporter": (
        exporter("otlp", "    endpoint: localhost:4317\n    tls:\n      client_ca_file_reload: true\n"),
        refused(invalid_keys("tls", "client_ca_file_reload", "exporters::otlp")),
    ),
    # ---- keys already in a text
    "a per-object include_initial_state": (
        receiver(
            "k8sobjects",
            "    auth_type: none\n    objects:\n      - name: pods\n        mode: watch\n        include_initial_state: true\n",
        ),
        refused(invalid_keys("objects[0]", "include_initial_state", "receivers::k8sobjects")),
    ),
    "control: a top-level include_initial_state": (
        receiver(
            "k8sobjects", "    auth_type: none\n    include_initial_state: true\n    objects:\n      - name: pods\n        mode: watch\n"
        ),
        accepted(),
    ),
    "deployment_name_from_replicaset": (
        processor("k8sattributes", "    auth_type: none\n    deployment_name_from_replicaset: true\n"),
        refused(
            invalid_keys("k8sattributesprocessor.Config", "deployment_name_from_replicaset", "processors::k8sattributes")
        ),
    ),
    "resourcedetection ecs client_config.timeout": (
        processor("resourcedetection", "    detectors: [ecs]\n    ecs:\n      client_config:\n        timeout: 5s\n"),
        accepted_from("0.160.0", invalid_keys("ecs", "client_config", "processors::resourcedetection")),
    ),
    "resourcedetection gcp client_config.timeout": (
        processor("resourcedetection", "    detectors: [gcp]\n    gcp:\n      client_config:\n        timeout: 5s\n"),
        accepted_from("0.160.0", invalid_keys("gcp", "client_config", "processors::resourcedetection")),
    ),
    "resourcedetection's openstack detector": (
        processor("resourcedetection", "    detectors: [openstack]\n"),
        refused(
            build(
                "resourcedetection",
                "processor",
                ', in pipeline "traces"',
                "invalid detector key: openstack",
                "processors::resourcedetection",
            )
        ),
    ),
    "control: resourcedetection's nova detector": (
        processor("resourcedetection", "    detectors: [nova]\n"),
        accepted(),
    ),
    "filelog in a metrics pipeline": (
        receiver("filelog", "    include: [/tmp/x.log]\n", "metrics"),
        refused(
            build("filelog", "receiver", ' for data type "metrics"', "telemetry type is not supported", "receivers::filelog")
        ),
    ),
    "syslog in a metrics pipeline": (
        receiver("syslog", "    tcp:\n      listen_address: 0.0.0.0:54526\n    protocol: rfc5424\n", "metrics"),
        refused(
            build("syslog", "receiver", ' for data type "metrics"', "telemetry type is not supported", "receivers::syslog")
        ),
    ),
    # ---- refused values the forms write as typed
    "a regex_parser without named groups": (
        receiver("filelog", FILELOG + "      - type: regex_parser\n        regex: '^\\d+ .*$'\n"),
        refused(filelog_refusal("no named capture groups in regex pattern")),
    ),
    "a csv_parser header of one column": (
        receiver("filelog", FILELOG + "      - type: csv_parser\n        header: a\n"),
        refused(filelog_refusal("missing field delimiter in header")),
    ),
    "a key_value_parser with equal delimiters": (
        receiver("filelog", FILELOG + "      - type: key_value_parser\n        delimiter: ','\n        pair_delimiter: ','\n"),
        refused(filelog_refusal("delimiter and pair_delimiter cannot be the same value")),
    ),
    "netflow's queue_size 0": (
        receiver("netflow", "    scheme: netflow\n    port: 2055\n    queue_size: 0\n"),
        accepted(),
    ),
    "a lowercase journald match": (
        receiver("journald", "    matches:\n      - _systemd_unit: ssh.service\n"),
        refused(
            build(
                "journald",
                "receiver",
                ' for data type "logs"',
                "'_systemd_unit' is not a valid Systemd field name",
                "receivers::journald",
            )
        ),
    ),
    "a duplicate operator id": (
        receiver(
            "filelog",
            FILELOG + "      - type: move\n        id: m\n        from: body\n        to: attributes.x\n"
            "      - type: move\n        id: m\n        from: attributes.x\n        to: body\n",
        ),
        refused(filelog_refusal("operator with id 'm' already exists in pipeline")),
    ),
    "filelog's empty include": (
        receiver("filelog", "    include: []\n"),
        refused(filelog_refusal("'include' must be specified")),
    ),
    "an operator's on_error silent": (
        receiver("filelog", FILELOG + "      - type: json_parser\n        on_error: silent\n"),
        refused(filelog_refusal('operator config has an invalid `on_error` field.: {"on_error":"silent"}')),
    ),
    "hostmetrics' process include without match_type": (
        receiver("hostmetrics", "    scrapers:\n      process:\n        include:\n          names: [nginx]\n", "metrics"),
        refused(
            build(
                "hostmetrics",
                "receiver",
                ' for data type "metrics"',
                "error creating process include filters: unrecognized match_type: '', valid types are: [regexp strict]",
                "receivers::hostmetrics",
            )
        ),
    ),
    "a time_parser epoch layout of %s": (
        receiver(
            "filelog",
            FILELOG + "      - type: time_parser\n        parse_from: body\n        layout_type: epoch\n        layout: '%s'\n",
        ),
        refused(
            error("invalid `layout` for `epoch` type", "receivers::filelog::baseconfig::operators::0::builder"),
            error("invalid `layout` for `epoch` type", "receivers::filelog::baseconfig::operators::0::builder::timeparser"),
        ),
    ),
    "a regex_replace with an empty regex": (
        receiver(
            "filelog", FILELOG + "      - type: regex_replace\n        regex: ''\n        replace_with: x\n        field: body\n"
        ),
        refused(filelog_refusal("either regex or regex_name must be set")),
    ),
    "syslog's octet_counting and an empty framing trailer": (
        receiver(
            "syslog",
            "    tcp:\n      listen_address: 0.0.0.0:54526\n    protocol: rfc5424\n"
            "    octet_counting: false\n    non_transparent_framing_trailer: ''\n",
        ),
        refused(invalid_keys("syslogreceiver.SysLogConfig", "octet_counting", "receivers::syslog")),
    ),
    # ---- structural
    "a routing table naming a deleted pipeline": (
        routing(
            "    default_pipelines: [traces/b]\n    table:\n      - condition: 'attributes[\"x\"] == \"y\"'\n"
            "        pipelines: [traces/gone]\n",
            TRACES_B,
        ),
        refused(error('pipeline not found: missing consumer: "traces/gone"', None)),
    ),
    "a routing target whose receivers disagree": (
        routing(
            "    default_pipelines: [traces/b]\n    table:\n      - condition: 'attributes[\"x\"] == \"y\"'\n"
            "        pipelines: [traces/c]\n",
            TRACES_B + "    traces/c:\n      receivers: [otlp]\n      exporters: [debug]\n",
        ),
        refused(error('pipeline not found: missing consumer: "traces/c"', None)),
    ),
    "a held route's pipelines before its expression": (
        routing("    default_pipelines: [traces/b]\n    table:\n      - pipelines: [traces/b]\n", TRACES_B),
        refused(error("invalid route: no condition or statement provided", "connectors::routing")),
    ),
    "control: a request condition request[name] == value": (
        routing(
            "    default_pipelines: [traces/b]\n    table:\n      - context: request\n"
            "        condition: 'request[\"X-Tenant\"] == \"acme\"'\n        pipelines: [traces/b]\n",
            TRACES_B,
        ),
        accepted(),
    ),
    "a request condition other than ==|!=": (
        routing(
            "    default_pipelines: [traces/b]\n    table:\n      - context: request\n"
            "        condition: 'IsMatch(request[\"X-Tenant\"], \"ac.*\")'\n        pipelines: [traces/b]\n",
            TRACES_B,
        ),
        refused(error("condition does not contain a valid comparator", "connectors::routing")),
    ),
    "a request condition against nil": (
        routing(
            "    default_pipelines: [traces/b]\n    table:\n      - context: request\n"
            "        condition: 'request[\"X-Tenant\"] != nil'\n        pipelines: [traces/b]\n",
            TRACES_B,
        ),
        refused(
            error("condition must have format 'request[\"<name>\"] <comparator> \"<value>\"'", "connectors::routing")
        ),
    ),
    "an empty route": (
        routing("    default_pipelines: [traces/b]\n    table:\n      - condition: ''\n        pipelines: []\n", TRACES_B),
        refused(error("invalid route: no condition or statement provided", "connectors::routing")),
    ),
    "a failover level naming a deleted pipeline": (
        failover("    priority_levels:\n      - [traces/a]\n      - [traces/gone]\n", TRACES_A),
        refused(error("Error registering consumer", None)),
    ),
    "a failover target whose receivers disagree": (
        failover(
            "    priority_levels:\n      - [traces/a]\n      - [traces/c]\n",
            TRACES_A + "    traces/c:\n      receivers: [otlp]\n      exporters: [debug]\n",
        ),
        refused(error("Error registering consumer", None)),
    ),
    "an empty failover level": (
        failover("    priority_levels:\n      - [traces/a]\n      - []\n", TRACES_A),
        refused(error("Error registering consumer", None)),
    ),
    # ---- keys already in a text
    "prometheus' report_extra_scrape_metrics": (
        receiver(
            "prometheus",
            "    report_extra_scrape_metrics: true\n    config:\n      scrape_configs:\n        - job_name: a\n"
            "          static_configs:\n            - targets: ['localhost:8888']\n",
            "metrics",
        ),
        refused(invalid_keys("prometheusreceiver.Config", "report_extra_scrape_metrics", "receivers::prometheus")),
    ),
    "cumulativetodelta's max_streams": (
        processor("cumulativetodelta", "    max_streams: 10\n", "metrics"),
        refused(invalid_keys("cumulativetodeltaprocessor.Config", "max_streams", "processors::cumulativetodelta")),
    ),
    "Datadog's top-level hostname_source": (
        exporter("datadog", DATADOG + "    hostname_source: first_resource\n"),
        accepted_from("0.160.0", invalid_keys("config.Config", "hostname_source", "exporters::datadog")),
    ),
    "Datadog's logs.dump_payloads": (
        exporter("datadog", DATADOG + "    logs:\n      dump_payloads: true\n", "logs"),
        accepted_from("0.160.0", invalid_keys("logs", "dump_payloads", "exporters::datadog")),
    ),
    "Datadog's headers": (
        exporter("datadog", DATADOG + "    headers:\n      x-a: b\n"),
        refused(
            error("these confighttp client configs are currently not respected by Datadog exporter: headers", "exporters::datadog")
        ),
    ),
    "Datadog's idle_connection_timeout": (
        exporter("datadog", DATADOG + "    idle_connection_timeout: 30s\n"),
        accepted_from("0.160.0", invalid_keys("config.Config", "idle_connection_timeout", "exporters::datadog")),
    ),
    "a v2 protobuf_message without its feature gate": (
        exporter(
            "prometheusremotewrite",
            "    endpoint: http://localhost:9090/api/v1/write\n    protobuf_message: io.prometheus.write.v2.Request\n",
            "metrics",
        ),
        refused(
            error(
                "remote write v2 is only supported with the feature gate "
                "exporter.prometheusremotewritexporter.enableSendingRW2",
                "exporters::prometheusremotewrite",
            )
        ),
    ),
    "a redaction regex unclosed": (
        processor("redaction", "    allow_all_keys: true\n    blocked_values: ['(unclosed']\n"),
        refused(
            redaction_refusal(
                "failed to process block list: error compiling regex in list: error parsing regexp: "
                "missing closing ): `(unclosed`"
            )
        ),
    ),
    "a redaction regex with a lookahead": (
        processor("redaction", "    allow_all_keys: true\n    blocked_values: ['(?=x)abc']\n"),
        refused(
            redaction_refusal(
                "failed to process block list: error compiling regex in list: error parsing regexp: "
                "invalid or unsupported Perl syntax: `(?=`"
            )
        ),
    ),
    "a redaction blocked_key_pattern unclosed": (
        processor("redaction", "    allow_all_keys: true\n    blocked_key_patterns: ['[bad']\n"),
        refused(
            redaction_refusal(
                "failed to process block keys list: error compiling regex in list: error parsing regexp: "
                "missing closing ]: `[bad`"
            )
        ),
    ),
    "a redaction allowed_values regex": (
        processor("redaction", "    allow_all_keys: true\n    allowed_values: ['*bad']\n"),
        refused(
            redaction_refusal(
                "failed to process allow list: error compiling regex in list: error parsing regexp: "
                "missing argument to repetition operator: `*`"
            )
        ),
    ),
    "redaction's hash_function sha256": (
        processor("redaction", "    allow_all_keys: true\n    blocked_values: ['4[0-9]{12}']\n    hash_function: sha256\n"),
        refused(
            error(
                "'hash_function' unknown HashFunction sha256, allowed functions are sha1, sha3, md5, "
                "hmac-sha256 and hmac-sha512",
                "processors::redaction",
            )
        ),
    ),
    # ---- refused values the forms write as typed
    "metricstransform's empty include": (
        processor("metricstransform", "    transforms:\n      - include: ''\n        action: update\n        new_name: b\n", "metrics"),
        refused(
            build(
                "metricstransform",
                "processor",
                ', in pipeline "metrics"',
                'missing required field "include"',
                "processors::metricstransform",
            )
        ),
    ),
    "metricstransform's add_label without new_label": (
        processor(
            "metricstransform",
            "    transforms:\n      - include: a\n        action: update\n        operations:\n          - action: add_label\n",
            "metrics",
        ),
        refused(
            build(
                "metricstransform",
                "processor",
                ', in pipeline "metrics"',
                'operation 1: missing required field "new_label" while "action" is add_label',
                "processors::metricstransform",
            )
        ),
    ),
    "cumulativetodelta's include without match_type": (
        processor("cumulativetodelta", "    include:\n      metrics: [a]\n", "metrics"),
        refused(error("match_type must be set if metrics are supplied", "processors::cumulativetodelta")),
    ),
    "filter's spans without match_type": (
        processor("filter", "    spans:\n      include:\n        services: [a]\n"),
        refused(
            build(
                "filter",
                "processor",
                ', in pipeline "traces"',
                "error creating service name filters: unrecognized match_type: '', valid types are: [regexp strict]",
                "processors::filter",
            )
        ),
    ),
    "transform's empty statement": (
        processor("transform", "    trace_statements:\n      - ''\n"),
        transform_refusal('[""]', ': 1:1: unexpected token "<EOF>"', " at 1:1:"),
    ),
    "transform's group after a flat statement": (
        processor(
            "transform",
            '    trace_statements:\n      - set(span.name, "a")\n      - statements:\n          - set(span.name, "b")\n',
        ),
        refused(
            error(
                "configuring multiple configuration styles is not supported, please use only Basic configuration "
                "or only Advanced configuration",
                "processors::transform",
            )
        ),
    ),
    "transform's contains()": (
        processor(
            "transform", '    log_statements:\n      - set(log.severity_text, "ERROR") where contains(log.body, "error")\n', "logs"
        ),
        transform_refusal(
            '["set(log.severity_text, \\"ERROR\\") where contains(log.body, \\"error\\")"]',
            ': 1:66: unexpected token "<EOF>" (expected <opcomparison> Value)',
            " at 1:66: (expected <opcomparison> Value)",
        ),
    ),
    "loadbalancing's routing_key attributes alone": (
        exporter(
            "loadbalancing",
            "    routing_key: attributes\n    protocol:\n      otlp: {}\n    resolver:\n      static:\n        hostnames: [a:4317]\n",
        ),
        refused(error('routing_attributes must be specified when routing_key is "attributes"', "exporters::loadbalancing")),
    ),
    "loadbalancing's traceID in a metrics pipeline": (
        exporter(
            "loadbalancing",
            "    routing_key: traceID\n    protocol:\n      otlp: {}\n    resolver:\n      static:\n        hostnames: [a:4317]\n",
            "metrics",
        ),
        refused(
            build(
                "loadbalancing",
                "exporter",
                ' for data type "metrics"',
                'cannot configure loadbalancing metrics exporter: unsupported routing_key: "traceID"',
                "exporters::loadbalancing",
            )
        ),
    ),
    "the awss3 receiver without a mode": (
        receiver("awss3", "    s3downloader:\n      s3_bucket: b\n      region: us-east-1\n", "traces"),
        refused(error("either starttime/endtime or sqs configuration must be provided", "receivers::awss3")),
    ),
    "statsd's socket_permissions quoted": (
        receiver(
            "statsd", "    endpoint: /tmp/statsd.sock\n    transport: unixgram\n    socket_permissions: '622'\n", "metrics"
        ),
        refused(error("'socket_permissions' expected type 'fs.FileMode', got unconvertible type 'string'", "receivers::statsd")),
    ),
    "a prometheus scrape TLS version 1.2": (
        receiver(
            "prometheus",
            "    config:\n      scrape_configs:\n        - job_name: a\n          tls_config:\n            min_version: '1.2'\n"
            "          static_configs:\n            - targets: ['localhost:8888']\n",
            "metrics",
        ),
        refused(
            error(
                "'config' prometheus receiver: failed to unmarshal yaml to prometheus config object: "
                "unknown TLS version: 1.2",
                "receivers::prometheus",
            )
        ),
    ),
    "spanmetrics' bare-number buckets": (
        f"{R}exporters:\n  debug:\nconnectors:\n  spanmetrics:\n    histogram:\n      explicit:\n"
        "        buckets: [2, 4, 6]\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n"
        "      exporters: [spanmetrics]\n    metrics:\n      receivers: [spanmetrics]\n      exporters: [debug]\n",
        accepted(),
    ),
}


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("version", OFFERED)
async def test_the_collector_answers_a_handoff_case(version: str, name: str) -> None:
    text, answer = CASES[name]
    expected = answer(version)

    result = await check(version, text)

    assert errors_match(result.errors, expected), result.errors
    assert result.valid is (expected == [])


# ---- what `validate` passes but a start refuses --------------------------------

IN_CLUSTER = ("k8s_in_cluster", "Runs inside a Kubernetes cluster")


def extension(name: str, body: str) -> str:
    return (
        f"{R}exporters:\n  debug:\nextensions:\n  {name}:\n{body}service:\n  extensions: [{name}]\n"
        "  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n"
    )


# name -> (text, the service's requirements as (category, title, componentPath))
START_ONLY: dict[str, tuple[str, list[tuple[str, str, str]]]] = {
    "TLS files on a receiver": (
        "receivers:\n  otlp:\n    protocols:\n      grpc:\n        tls:\n          cert_file: /etc/otel/server.crt\n"
        "          key_file: /etc/otel/server.key\n          client_ca_file: /etc/otel/ca.crt\n"
        "exporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n",
        [
            ("tls_files", "Provide /etc/otel/server.crt on the host", "receivers::otlp"),
            ("tls_files", "Provide /etc/otel/server.key on the host", "receivers::otlp"),
            ("tls_files", "Provide /etc/otel/ca.crt on the host", "receivers::otlp"),
        ],
    ),
    "a TLS CA file on an exporter": (
        exporter("otlp", "    endpoint: localhost:4317\n    tls:\n      ca_file: /etc/otel/missing-ca.pem\n"),
        [("tls_files", "Provide /etc/otel/missing-ca.pem on the host", "exporters::otlp")],
    ),
    "the file exporter's directory": (
        exporter("file", "    path: /var/log/otel/out.json\n"),
        [("directory", "Directory /var/log/otel must exist", "exporters::file")],
    ),
    "k8s_cluster": (
        receiver("k8s_cluster", "    auth_type: serviceAccount\n", "metrics"),
        [(*IN_CLUSTER, "receivers::k8s_cluster")],
    ),
    "k8s_events": (receiver("k8s_events", "    auth_type: serviceAccount\n"), [(*IN_CLUSTER, "receivers::k8s_events")]),
    "k8sobjects": (
        receiver("k8sobjects", "    auth_type: serviceAccount\n    objects:\n      - name: pods\n        mode: pull\n"),
        [(*IN_CLUSTER, "receivers::k8sobjects")],
    ),
    "k8s_objects": (
        receiver("k8s_objects", "    auth_type: serviceAccount\n    objects:\n      - name: pods\n        mode: pull\n"),
        [(*IN_CLUSTER, "receivers::k8s_objects")],
    ),
    "kubeletstats": (
        receiver("kubeletstats", "    auth_type: serviceAccount\n    endpoint: https://${env:K8S_NODE_NAME}:10250\n", "metrics"),
        [(*IN_CLUSTER, "receivers::kubeletstats")],
    ),
    "kubelet_stats": (
        receiver("kubelet_stats", "    auth_type: serviceAccount\n    endpoint: https://${env:K8S_NODE_NAME}:10250\n", "metrics"),
        [(*IN_CLUSTER, "receivers::kubelet_stats")],
    ),
    "k8sattributes": (
        processor("k8sattributes", "    auth_type: serviceAccount\n"),
        [(*IN_CLUSTER, "processors::k8sattributes")],
    ),
    "k8s_attributes": (
        processor("k8s_attributes", "    auth_type: serviceAccount\n"),
        [(*IN_CLUSTER, "processors::k8s_attributes")],
    ),
    "k8s_observer": (
        extension("k8s_observer", "    auth_type: serviceAccount\n"),
        [(*IN_CLUSTER, "extensions::k8s_observer")],
    ),
    "resourcedetection's k8snode detector": (
        processor("resourcedetection", "    detectors: [k8snode]\n"),
        [(*IN_CLUSTER, "processors::resourcedetection")],
    ),
}

TAIL_SAMPLING_WITHOUT_CONDITIONS = processor(
    "tail_sampling",
    "    policies:\n      - name: p\n        type: ottl_condition\n        ottl_condition:\n          error_mode: ignore\n",
)


@pytest.mark.parametrize("name", list(START_ONLY))
@pytest.mark.parametrize("version", OFFERED)
async def test_validate_accepts_a_start_only_case_and_the_service_says_what_to_provide(version: str, name: str) -> None:
    text, requirements = START_ONLY[name]

    raw = await raw_validate(version, text)
    result = await check(version, text)

    assert (raw.kind, raw.stderr) == ("passed", "")
    assert result.errors == []
    assert result.valid is True
    assert [(r["category"], r["title"], r["componentPath"]) for r in result.requirements] == requirements


@pytest.mark.parametrize("version", OFFERED)
async def test_a_tail_sampling_policy_without_conditions_is_the_services_error(version: str) -> None:
    raw = await raw_validate(version, TAIL_SAMPLING_WITHOUT_CONDITIONS)
    result = await check(version, TAIL_SAMPLING_WITHOUT_CONDITIONS)

    assert (raw.kind, raw.stderr) == ("passed", "")
    assert result.valid is False
    assert result.errors == [
        {"message": 'policy "p": expected at least one OTTL condition to filter on', "componentPath": "processors::tail_sampling"}
    ]
