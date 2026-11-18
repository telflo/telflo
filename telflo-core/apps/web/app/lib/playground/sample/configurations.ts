import type { Configuration, ConfigurationCreator, ConfigurationVersion, ConfigurationVersionSummary } from "@telflo/contracts";
import {
  clockAt,
  DAY,
  HOUR,
  SAMPLE_DISTRIBUTION,
  SAMPLE_SECURITY,
  SAMPLE_SRE,
  SAMPLE_VISITOR,
  type SampleClock,
  type SampleConfiguration,
} from "./types.js";

/*
 * The sample's ten configurations (D31-1 decision 10): their names,
 * descriptions, texts and owners, in the platform's shapes. Every
 * one opens on a draft (Ruling 276); each published one also has an older
 * published version, so the editor never opens a sample read-only. The pins
 * spread across the offered Contrib versions, 0.159.0 to 0.162.0
 * (Preflight ruling 7). Hosts in the texts are on `acme.example`
 * (RFC 2606), never a vendor's or an internal one. The graph columns are
 * empty: the editor lays the canvas out from the text.
 */

/** The configurations' fixed ids, lowercase and v4-shaped. */
export const SAMPLE_CONFIGURATION_IDS = {
  gateway: "11111111-0000-4000-8000-000000000001",
  hostMetrics: "11111111-0000-4000-8000-000000000002",
  tailSampling: "11111111-0000-4000-8000-000000000003",
  rum: "11111111-0000-4000-8000-000000000004",
  spanMetrics: "11111111-0000-4000-8000-000000000005",
  k8sNode: "11111111-0000-4000-8000-000000000006",
  pii: "11111111-0000-4000-8000-000000000007",
  cost: "11111111-0000-4000-8000-000000000008",
  migrate: "11111111-0000-4000-8000-000000000009",
  import: "11111111-0000-4000-8000-000000000010",
} as const;

export type SampleConfigurationKey = keyof typeof SAMPLE_CONFIGURATION_IDS;

const GATEWAY_YAML = `# Production gateway: OTLP in from app SDKs + pod logs,
# scrubbed and batched out to the observability backend.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  filelog:
    include:
      - /var/log/pods/*/*/*.log
    start_at: end

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert
  attributes:
    actions:
      - key: user.ssn
        action: delete
  batch:
    timeout: 10s
    send_batch_size: 1024

exporters:
  otlphttp:
    endpoint: https://otlp-gateway.acme.example/otlp
  debug:
    verbosity: basic

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp]
    logs:
      receivers: [otlp, filelog]
      processors: [memory_limiter, resource, attributes, batch]
      exporters: [otlphttp, debug]
`;

const HOSTMETRICS_YAML = `# Linux fleet host metrics, shipped over OTLP/HTTP.
receivers:
  hostmetrics:
    collection_interval: 30s
    scrapers:
      cpu:
        metrics:
          system.cpu.utilization:
            enabled: true
      memory:
      disk:
      network:

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
  resource:
    attributes:
      - key: service.namespace
        value: infra
        action: upsert
  batch:
    timeout: 5s

exporters:
  otlphttp:
    endpoint: https://otlp-gateway.acme.example/otlp
  debug:
    verbosity: basic

service:
  pipelines:
    metrics:
      receivers: [hostmetrics]
      processors: [memory_limiter, resource, batch]
      exporters: [otlphttp, debug]
`;

const TAILSAMPLING_YAML = `# Draft: keep all error traces, sample the rest.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  tail_sampling:
    decision_wait: 30s
    num_traces: 50000
  batch:
    timeout: 10s

exporters:
  otlp:
    endpoint: tempo.acme.example:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp]
`;

const RUM_YAML = `# Browser RUM logs, enriched and forwarded.
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  attributes:
    actions:
      - key: telemetry.source
        value: browser
        action: upsert
  batch:
    timeout: 10s

exporters:
  otlphttp:
    endpoint: https://logs.acme.example/otlp

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [attributes, batch]
      exporters: [otlphttp]
`;

const SPANMETRICS_YAML = `# RED metrics from the spans you already emit — rate, errors, and
# duration for every service, derived in the collector. Span names are
# sanitized BEFORE the connector taps the stream, and the connector's
# cardinality dials are all bounded.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  transform/sanitize_spans:
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - set_semconv_span_name("1.37.0")
  batch:
    timeout: 10s

connectors:
  spanmetrics:
    histogram:
      explicit:
        buckets: [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s]
    dimensions:
      - name: http.request.method
        default: GET
      - name: http.response.status_code
    exclude_dimensions: [span.kind]
    exemplars:
      enabled: true
    aggregation_cardinality_limit: 10000
    metrics_flush_interval: 15s
    resource_metrics_key_attributes:
      - service.name
      - service.namespace
      - telemetry.sdk.language

exporters:
  otlp:
    endpoint: tempo.acme.example:4317
    tls:
      insecure: true
  otlphttp:
    endpoint: https://otlp-gateway.acme.example/otlp

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, transform/sanitize_spans, batch]
      exporters: [otlp, spanmetrics]
    metrics:
      receivers: [spanmetrics]
      processors: [batch]
      exporters: [otlphttp]
`;

const K8SNODE_YAML = `# Node agent (DaemonSet): kubelet, host, and container-log collection
# from every node, enriched with k8s metadata and forwarded to the
# in-cluster gateway.
receivers:
  kubeletstats:
    auth_type: serviceAccount
    endpoint: \${env:K8S_NODE_NAME}:10250
    insecure_skip_verify: true
    collection_interval: 30s
    metric_groups: [container, pod, node, volume]
  hostmetrics:
    collection_interval: 30s
    root_path: /hostfs
    scrapers:
      cpu:
      memory:
      load:
      disk:
      network:
      filesystem:
  filelog:
    include: [/var/log/pods/*/*/*.log]
    include_file_path: true
    start_at: end
    storage: file_storage
    operators:
      - id: container-parser
        type: container
        max_log_size: 102400
    retry_on_failure:
      enabled: true

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 85
    spike_limit_percentage: 20
  k8sattributes:
    passthrough: false
    filter:
      node_from_env_var: K8S_NODE_NAME
    extract:
      otel_annotations: true
      metadata:
        - k8s.namespace.name
        - k8s.deployment.name
        - k8s.node.name
        - k8s.pod.name
        - k8s.pod.uid
        - k8s.container.name
    pod_association:
      - sources:
          - from: connection
      - sources:
          - from: resource_attribute
            name: k8s.pod.uid
  batch:
    timeout: 10s

exporters:
  otlp:
    endpoint: otel-gateway.observability.svc.cluster.local:4317
    tls:
      insecure: true

extensions:
  file_storage:
    directory: /var/lib/otelcol
    create_directory: true

service:
  extensions: [file_storage]
  pipelines:
    metrics:
      receivers: [kubeletstats, hostmetrics]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlp]
    logs:
      receivers: [filelog]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlp]
`;

const PII_YAML = `# Mask PII in the pipeline, before data ever leaves your network.
# Secret-looking keys are blocked outright; emails, card numbers, and
# SSNs are masked wherever they appear as attribute values.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
  redaction:
    allow_all_keys: true
    blocked_key_patterns:
      - (?i).*password.*
      - (?i).*token.*
      - (?i)authorization
    blocked_values:
      - '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'
      - '\\b(?:\\d[ -]?){13,16}\\b'
      - '\\b\\d{3}-\\d{2}-\\d{4}\\b'
    summary: debug
  batch:
    timeout: 10s

exporters:
  otlphttp:
    endpoint: https://otlp-gateway.acme.example/otlp

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, redaction, batch]
      exporters: [otlphttp]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, redaction, batch]
      exporters: [otlphttp]
`;

const COST_YAML = `# Cut the data nobody looks at: OTTL filters delete known noise at the
# edge — health-check spans, sub-10ms 200s on the hottest endpoint, and
# debug-level logs — before any of it hits the bill.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
  filter/ottl:
    error_mode: ignore
    traces:
      span:
        - attributes["http.route"] == "/healthz"
        - attributes["http.route"] == "/readyz"
        - attributes["http.route"] == "/livez"
        - name == "/api/v1/users" and status.code == STATUS_CODE_OK and (end_time_unix_nano - start_time_unix_nano) < 10000000
    logs:
      log_record:
        - severity_number < SEVERITY_NUMBER_INFO
  batch:
    timeout: 10s

exporters:
  otlphttp:
    endpoint: https://otlp-gateway.acme.example/otlp

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, filter/ottl, batch]
      exporters: [otlphttp]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, filter/ottl, batch]
      exporters: [otlphttp]
`;

const MIGRATE_YAML = `# Draft: migrate backends without getting stuck halfway. Dual-ship
# every signal to the legacy and the new backend until dashboards and
# alerts are proven on the new one, then drop the legacy exporter.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert
  batch:
    timeout: 10s

exporters:
  otlp/legacy:
    endpoint: legacy-agent.acme.example:4317
    tls:
      insecure: true
  otlphttp/new:
    endpoint: https://otlp-gateway.acme.example/otlp

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlp/legacy, otlphttp/new]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlp/legacy, otlphttp/new]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [otlp/legacy, otlphttp/new]
`;

const IMPORT_YAML = `# Adopted as-is from the collector already running on the edge boxes.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
  filelog:
    include: [/var/log/nginx/access.log]
    start_at: end

processors:
  batch:
    timeout: 10s

exporters:
  otlphttp:
    endpoint: https://collector.edge.acme.example/otlp

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp]
    logs:
      receivers: [otlp, filelog]
      processors: [batch]
      exporters: [otlphttp]
`;

/** A published version under the draft: its fixed id, number, label, pin and when it was published. */
interface PublishedSpec {
  id: string;
  versionNumber: number;
  label: string | null;
  collectorVersion: string;
  publishedAgo: number;
}

/** One sample configuration, as the sample describes it. */
interface Spec {
  key: SampleConfigurationKey;
  name: string;
  description: string;
  createdBy: ConfigurationCreator;
  createdAgo: number;
  updatedAgo: number;
  yaml: string;
  /** The draft it opens: its fixed id and pin. Its number follows the published one's, else 1. */
  draft: { id: string; collectorVersion: string };
  /** The older published version, for a published configuration; null for one never published. */
  published: PublishedSpec | null;
}

const SPECS: readonly Spec[] = [
  {
    key: "gateway",
    name: "K8s Production Gateway",
    description: "Traces, metrics, and pod logs from the production cluster — scrubbed and shipped to the observability backend",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 45 * DAY,
    updatedAgo: 2 * HOUR,
    yaml: GATEWAY_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000004", collectorVersion: "0.162.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000003",
      versionNumber: 3,
      label: "Add PII scrub for user.ssn",
      collectorVersion: "0.161.0",
      publishedAgo: 3 * DAY,
    },
  },
  {
    key: "hostMetrics",
    name: "Host Metrics — Linux Fleet",
    description: "CPU, memory, disk, and network from every Linux box",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 30 * DAY,
    updatedAgo: 9 * DAY,
    yaml: HOSTMETRICS_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000016", collectorVersion: "0.161.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000015",
      versionNumber: 5,
      label: "Drop process scraper noise",
      collectorVersion: "0.160.0",
      publishedAgo: 9 * DAY,
    },
  },
  {
    key: "tailSampling",
    name: "Tail Sampling — Traces",
    description: "Keep every error trace, probabilistically sample the rest",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 5 * DAY,
    updatedAgo: 26 * HOUR,
    yaml: TAILSAMPLING_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000021", collectorVersion: "0.160.0" },
    published: null,
  },
  {
    key: "rum",
    name: "Frontend RUM Logs",
    description: "Browser session logs from the web storefront",
    createdBy: SAMPLE_SRE,
    createdAgo: 20 * DAY,
    updatedAgo: 6 * DAY,
    yaml: RUM_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000032", collectorVersion: "0.159.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000031",
      versionNumber: 1,
      label: null,
      collectorVersion: "0.159.0",
      publishedAgo: 6 * DAY,
    },
  },
  {
    key: "spanMetrics",
    name: "Span Metrics — RED",
    description:
      "Rate, errors, and duration for every service, derived from spans you already collect — with the cardinality guardrails",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 12 * DAY,
    updatedAgo: 4 * DAY,
    yaml: SPANMETRICS_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000043", collectorVersion: "0.162.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000042",
      versionNumber: 2,
      label: "Cap series with aggregation_cardinality_limit",
      collectorVersion: "0.162.0",
      publishedAgo: 4 * DAY,
    },
  },
  {
    key: "k8sNode",
    name: "K8s Node Agent",
    description: "Kubelet, host, and container-log collection from every node, enriched with k8s metadata",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 21 * DAY,
    updatedAgo: 8 * DAY,
    yaml: K8SNODE_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000053", collectorVersion: "0.161.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000052",
      versionNumber: 2,
      label: "Checkpoint filelog offsets in file_storage",
      collectorVersion: "0.161.0",
      publishedAgo: 8 * DAY,
    },
  },
  {
    key: "pii",
    name: "PII Masking — Redaction",
    description: "Mask emails, card numbers, and secret-looking keys in the pipeline — before data leaves your network",
    createdBy: SAMPLE_SECURITY,
    createdAgo: 15 * DAY,
    updatedAgo: 7 * DAY,
    yaml: PII_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000062", collectorVersion: "0.160.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000061",
      versionNumber: 1,
      label: null,
      collectorVersion: "0.160.0",
      publishedAgo: 7 * DAY,
    },
  },
  {
    key: "cost",
    name: "Cost Filters — OTTL",
    description: "Delete health-check spans, fast 200s, and debug logs at the edge, before they hit the bill",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 9 * DAY,
    updatedAgo: 2 * DAY,
    yaml: COST_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000072", collectorVersion: "0.162.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000071",
      versionNumber: 1,
      label: null,
      collectorVersion: "0.161.0",
      publishedAgo: 2 * DAY,
    },
  },
  {
    key: "migrate",
    name: "Backend Migration — Dual Ship",
    description: "Every signal to the legacy and the new backend until the cutover is proven",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 3 * DAY,
    updatedAgo: 5 * HOUR,
    yaml: MIGRATE_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000081", collectorVersion: "0.159.0" },
    published: null,
  },
  {
    key: "import",
    name: "edge-import-pilot (imported)",
    description: "Imported from collector rustic-pond",
    createdBy: SAMPLE_VISITOR,
    createdAgo: 2 * HOUR,
    updatedAgo: 2 * HOUR,
    yaml: IMPORT_YAML,
    draft: { id: "33333333-0000-4000-8000-000000000092", collectorVersion: "0.162.0" },
    published: {
      id: "33333333-0000-4000-8000-000000000091",
      versionNumber: 1,
      label: "Imported from collector rustic-pond",
      collectorVersion: "0.162.0",
      publishedAgo: 2 * HOUR,
    },
  },
];

function build(spec: Spec, clock: SampleClock): SampleConfiguration {
  const id = SAMPLE_CONFIGURATION_IDS[spec.key];
  const configuration: Configuration = {
    id,
    name: spec.name,
    description: spec.description,
    createdAt: clock.ago(spec.createdAgo),
    updatedAt: clock.ago(spec.updatedAgo),
    createdBy: spec.createdBy,
    published: spec.published !== null,
    collectorDistribution: SAMPLE_DISTRIBUTION,
  };
  const draftNumber = (spec.published?.versionNumber ?? 0) + 1;
  const draftSummary: ConfigurationVersionSummary = {
    id: spec.draft.id,
    versionNumber: draftNumber,
    label: null,
    createdBy: spec.createdBy,
    createdAt: clock.ago(spec.updatedAgo),
    updatedAt: clock.ago(spec.updatedAgo),
    publishedAt: null,
    publishedBy: null,
    collectorVersion: spec.draft.collectorVersion,
    collectorVersionDeprecated: false,
    collectorVersionDeprecatedNote: null,
  };
  const version: ConfigurationVersion = {
    ...draftSummary,
    configurationId: id,
    yamlContent: spec.yaml,
    nodes: [],
    edges: [],
    pipelines: [],
  };
  const versions: ConfigurationVersionSummary[] = [draftSummary];
  if (spec.published !== null) {
    const { publishedAgo } = spec.published;
    // Made a little before it was published, at most when the configuration was.
    const madeAgo = Math.min(spec.createdAgo, publishedAgo + HOUR);
    versions.push({
      id: spec.published.id,
      versionNumber: spec.published.versionNumber,
      label: spec.published.label,
      createdBy: spec.createdBy,
      createdAt: clock.ago(madeAgo),
      updatedAt: clock.ago(publishedAgo),
      publishedAt: clock.ago(publishedAgo),
      publishedBy: spec.createdBy,
      collectorVersion: spec.published.collectorVersion,
      collectorVersionDeprecated: false,
      collectorVersionDeprecatedNote: null,
    });
  }
  return { configuration, version, versions };
}

/** The ten configurations, in the sample's order, with times relative to `now`. */
export function sampleConfigurations(now: number = Date.now()): SampleConfiguration[] {
  const clock = clockAt(now);
  return SPECS.map((spec) => build(spec, clock));
}

/** One sample configuration by its id, or undefined for an id the sample doesn't hold. */
export function sampleConfiguration(configurationId: string, now: number = Date.now()): SampleConfiguration | undefined {
  return sampleConfigurations(now).find((sample) => sample.configuration.id === configurationId.toLowerCase());
}
