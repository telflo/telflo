import type { Flow } from "@telflo/contracts";

/*
 * Flows as the signed-in API answers them, for the web's tests: a
 * tail-sampling flow (a real multi-pipeline configuration, so a copy's
 * canvas is populated end to end), on Contrib 0.162.0, the catalogue
 * fixture's default (`~/test/collector-distributions`).
 */

/** A tail-sampling configuration: three pipelines and two connectors. */
export const TAIL_SAMPLING_YAML = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 1536
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: keep-all-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
  batch:
    send_batch_size: 8192
connectors:
  spanmetrics:
    metrics_flush_interval: 60s
  forward:
exporters:
  otlp_grpc:
    endpoint: \${env:TRACES_BACKEND_ENDPOINT}
  prometheusremotewrite:
    endpoint: \${env:PROM_REMOTE_WRITE_URL}
    headers:
      X-Scope-OrgID: \${org:TENANT_ID}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter]
      exporters: [spanmetrics, forward]
    traces/sampled:
      receivers: [forward]
      processors: [tail_sampling, batch]
      exporters: [otlp_grpc]
    metrics/spanmetrics:
      receivers: [spanmetrics]
      processors: [batch]
      exporters: [prometheusremotewrite]
`;

export function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: "0199b000-0000-7000-8000-000000000001",
    slug: "tail-sampling-keep-errors",
    name: "Tail Sampling: Keep Every Error",
    summary: "Keeps error and slow traces, samples the rest.",
    description: "Sampling at the head throws away the errors.\n\nThis flow decides after the trace is complete.",
    source: "telflo",
    authorName: null,
    authorUrl: null,
    signals: ["traces", "metrics"],
    tags: ["sampling", "cost"],
    yaml: TAIL_SAMPLING_YAML,
    collectorDistribution: "otelcol-contrib",
    collectorVersion: "0.162.0",
    sourceUrl: null,
    published: true,
    sortOrder: 30,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    ...overrides,
  };
}

export const TAIL_SAMPLING = makeFlow();

export const PII_REDACTION = makeFlow({
  id: "0199b000-0000-7000-8000-000000000002",
  slug: "pii-redaction-gateway",
  name: "PII Redaction Gateway",
  summary: "Strips emails and card numbers before anything leaves the network.",
  description: "One paragraph.",
  signals: ["logs"],
  tags: ["privacy"],
  yaml: "receivers:\n  otlp:\n    protocols:\n      grpc:\nexporters:\n  debug:\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n",
  sortOrder: 70,
});

/** A flow a product admin has hidden: only a product admin's list holds it. */
export const HIDDEN = makeFlow({
  id: "0199b000-0000-7000-8000-000000000003",
  slug: "hidden-draft-flow",
  name: "Hidden Draft Flow",
  summary: "Not yet in the gallery.",
  signals: ["metrics"],
  tags: ["draft"],
  published: false,
  sortOrder: 200,
});
