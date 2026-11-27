/**
 * Four more seeded flows: Ship OTel data to Gigapipe, Ship OTel data to Loki,
 * Ship OTel data to Kafka and Ship OTel data to S3.
 *
 *   * Migration 026's seeding, again: the flows are held below as
 *     `seededFlows`, each text a JSON-escaped string, each YAML kept byte for
 *     byte, and written by migration 026's own `flowsInsert` (dollar quoting,
 *     so no text is ever escaped for SQL), on conflict (slug) do nothing:
 *     an admin's flow of the same slug stands, and later changes go through
 *     the admin screen or a new migration. Their timestamps are the
 *     migration's time to the millisecond. This migration reads no file.
 *   * Every flow is telflo's, published, credited to no author (Built by
 *     Telflo), on otelcol-contrib pinned at 0.159.0, the release each was
 *     checked on with the real collector, and sorted after migration 045's
 *     three (210, 220, 230 and 240).
 *   * The flows table's comment counts the seeded flows, so it names this
 *     migration's four too.
 *   * `seededFlows` and `seededFlowsInsert` are exported for the tests and
 *     their fixtures, as migrations 026's and 045's are (@telflo/db/testing's
 *     insertSeededFlows and seeded-flows-migrations.ts), which reach them by
 *     a dynamic import of this module.
 *
 * down deletes the four flows by slug, whatever an admin has made of them
 * since, and puts back migration 045's comment on the table exactly.
 */

import { flowsInsert } from "./1700000000026_flows.js";

/** The four seeded flows, in their sort order. */
export const seededFlows = Object.freeze([
  Object.freeze({
    slug: "ship-otel-data-to-gigapipe",
    name: "Ship OTel data to Gigapipe",
    summary: "Ships logs, metrics, and traces over plain OTLP to Gigapipe, an open-source backend that stores them in ClickHouse and answers Loki, Prometheus, and Tempo queries.",
    description: "Use this flow if you run Gigapipe, or if you're on Loki, Mimir, and Tempo and want one store instead of three. Gigapipe keeps logs, metrics, and traces in ClickHouse and answers the Loki, Prometheus, and Tempo APIs, so you point Grafana's built-in datasources at it and your dashboards keep working.\n\nGigapipe serves the same OTLP paths the `otlphttp` exporter uses and maps the data into its own storage, so the collector only needs `memory_limiter` and `batch` in front of the exporter.\n\nSet `GIGAPIPE_ENDPOINT` to the base URL (port 3100 by default) and `GIGAPIPE_USERNAME` and `GIGAPIPE_PASSWORD` to the server's login. This pipeline runs in our demo environment, shipping the OpenTelemetry demo app into a self-hosted Gigapipe.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs", "traces", "metrics"]),
    tags: Object.freeze(["gigapipe", "otlp", "backend"]),
    yaml_content: "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  batch:\n    send_batch_size: 8192\n    send_batch_max_size: 16384\n    timeout: 5s\n\nexporters:\n  otlphttp/gigapipe:\n    endpoint: ${env:GIGAPIPE_ENDPOINT}\n    auth:\n      authenticator: basicauth/gigapipe\n    encoding: proto\n    compression: gzip\n    timeout: 30s\n    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n      max_interval: 30s\n      max_elapsed_time: 300s\n    sending_queue:\n      enabled: true\n      num_consumers: 4\n      sizer: items\n      queue_size: 100000\n      storage: file_storage\n\nextensions:\n  basicauth/gigapipe:\n    client_auth:\n      username: ${env:GIGAPIPE_USERNAME}\n      password: ${env:GIGAPIPE_PASSWORD}\n\n  file_storage:\n    directory: /var/lib/otelcol/file_storage\n    create_directory: true\n\nservice:\n  extensions: [basicauth/gigapipe, file_storage]\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/gigapipe]\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/gigapipe]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlphttp/gigapipe]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.159.0",
    source_url: null,
    published: true,
    sort_order: 210,
  }),
  Object.freeze({
    slug: "ship-otel-data-to-loki",
    name: "Ship OTel data to Loki",
    summary: "A logs gateway for Loki's native OTLP endpoint that keeps pod names and instance ids out of the index and sets the tenant header from an environment variable.",
    description: "Sends OpenTelemetry logs to Loki 3.x on its native OTLP endpoint with the otlphttp exporter, since the loki exporter was removed in v0.131.0. Keeps k8s.pod.name and service.instance.id out of the index as structured metadata. Set LOKI_OTLP_ENDPOINT, plus LOKI_TENANT_ID if Loki runs with auth_enabled true.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs"]),
    tags: Object.freeze(["loki", "logs", "otlp"]),
    yaml_content: "# Ship OTel data to Loki\n# Built by Telflo. otelcol-contrib 0.159.0 to Loki 3.x over native OTLP/HTTP.\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 1600 # sized for a 2 GiB gateway; scale both values with the host\n    spike_limit_mib: 320\n  transform/loki_labels:\n    error_mode: ignore\n    log_statements:\n      # Loki indexes k8s.pod.name and service.instance.id by default and its docs\n      # advise new installs against it. Copy both onto each record, where Loki\n      # stores them as structured metadata...\n      - context: log\n        statements:\n          - set(log.attributes[\"k8s.pod.name\"], resource.attributes[\"k8s.pod.name\"]) where resource.attributes[\"k8s.pod.name\"] != nil\n          - set(log.attributes[\"service.instance.id\"], resource.attributes[\"service.instance.id\"]) where resource.attributes[\"service.instance.id\"] != nil\n      # ...then remove them from the resource so they never become index labels.\n      - context: resource\n        statements:\n          - delete_key(resource.attributes, \"k8s.pod.name\")\n          - delete_key(resource.attributes, \"service.instance.id\")\n  batch:\n    send_batch_size: 2048 # keeps one push under Loki's 6 MB default burst limit\n    send_batch_max_size: 2048\n\nexporters:\n  otlphttp/loki:\n    endpoint: ${env:LOKI_OTLP_ENDPOINT} # e.g. http://loki:3100/otlp, the exporter appends /v1/logs\n    headers:\n      X-Scope-OrgID: ${env:LOKI_TENANT_ID} # leave unset when Loki runs with auth_enabled false\n    sending_queue:\n      sizer: items\n      queue_size: 100000\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n\nservice:\n  extensions: [health_check]\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, transform/loki_labels, batch]\n      exporters: [otlphttp/loki]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.159.0",
    source_url: null,
    published: true,
    sort_order: 220,
  }),
  Object.freeze({
    slug: "ship-otel-data-to-kafka",
    name: "Ship OTel data to Kafka",
    summary: "Writes logs, metrics, and traces as OTLP protobuf to three Kafka topics that gateway collectors or other consumers read.",
    description: "Writes logs, metrics, and traces as OTLP protobuf to the otlp_logs, otlp_metrics, and otlp_spans topics with the kafka exporter, over SASL and TLS. Collectors with the kafka receiver read them with no topic settings. Create the topics first, then set KAFKA_BROKERS (comma-separated, no spaces), KAFKA_SASL_MECHANISM, KAFKA_USERNAME, and KAFKA_PASSWORD.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs", "metrics", "traces"]),
    tags: Object.freeze(["kafka", "buffer", "otlp", "logs", "metrics", "traces"]),
    yaml_content: "# Ship OTel data to Kafka\n# Built by Telflo\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: '0.0.0.0:4317'\n      http:\n        endpoint: '0.0.0.0:4318'\nprocessors:\n  memory_limiter:\n    check_interval: '1s'\n    limit_mib: 1600\n    spike_limit_mib: 400\n  batch:\n    send_batch_size: 256\n    send_batch_max_size: 500\n    timeout: '1s'\nexporters:\n  kafka:\n    brokers: '${env:KAFKA_BROKERS}'\n    client_id: 'otel-collector'\n    tls:\n      insecure: false\n    auth:\n      sasl:\n        mechanism: '${env:KAFKA_SASL_MECHANISM}'\n        username: '${env:KAFKA_USERNAME}'\n        password: '${env:KAFKA_PASSWORD}'\n    traces:\n      topic: 'otlp_spans'\n      encoding: 'otlp_proto'\n    metrics:\n      topic: 'otlp_metrics'\n      encoding: 'otlp_proto'\n    logs:\n      topic: 'otlp_logs'\n      encoding: 'otlp_proto'\n    partition_traces_by_id: true\n    partition_metrics_by_resource_attributes: true\n    partition_logs_by_resource_attributes: true\n    producer:\n      required_acks: -1\n      compression: 'lz4'\n      max_message_bytes: 1000000\n      allow_auto_topic_creation: false\n    timeout: '5s'\n    retry_on_failure:\n      enabled: true\n      initial_interval: '5s'\n      max_interval: '30s'\n      max_elapsed_time: '300s'\n    sending_queue:\n      enabled: true\n      num_consumers: 10\n      queue_size: 1000\n      storage: 'file_storage'\nextensions:\n  health_check:\n    endpoint: '0.0.0.0:13133'\n  file_storage:\n    directory: '/var/lib/otelcol/file_storage'\n    create_directory: true\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [kafka]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [kafka]\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [kafka]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.159.0",
    source_url: null,
    published: true,
    sort_order: 230,
  }),
  Object.freeze({
    slug: "ship-otel-data-to-s3",
    name: "Ship OTel data to S3",
    summary: "Writes logs, metrics, and traces to S3 as gzipped OTLP JSON, one prefix per signal, with disk-backed queues.",
    description: "Writes logs, metrics, and traces to one S3 bucket as gzipped OTLP JSON with the awss3 exporter, one prefix per signal. Disk-backed queues hold data through restarts and S3 outages. Set S3_REGION and S3_BUCKET, plus S3_ENDPOINT and S3_FORCE_PATH_STYLE for an S3-compatible store.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs", "metrics", "traces"]),
    tags: Object.freeze(["s3", "object-storage", "archive", "otlp"]),
    yaml_content: "# Ship OTel data to S3\n# Writes logs, metrics, and traces to one S3 bucket as gzipped OTLP JSON,\n# one prefix per signal, partitioned by minute in UTC. Each exporter keeps\n# its queue on disk, so queued data survives a restart and waits out an S3 outage.\n# otelcol-contrib v0.159.0.\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317 # the default binds to localhost\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 512\n    spike_limit_mib: 128\n  batch:\n    send_batch_size: 8192\n    timeout: 60s # each flush is one S3 object, so a long timeout means fewer, larger objects\n\nexporters:\n  awss3/logs:\n    marshaler: otlp_json # the default, written out; otlp_proto writes .binpb.gz objects instead\n    s3uploader:\n      region: ${env:S3_REGION}\n      s3_bucket: ${env:S3_BUCKET}\n      s3_prefix: logs # one prefix per signal\n      s3_partition_timezone: UTC # the default is the collector's local time zone\n      compression: gzip # keys end in .json.gz\n      endpoint: ${env:S3_ENDPOINT} # leave unset for AWS; set for an S3-compatible store\n      s3_force_path_style: ${env:S3_FORCE_PATH_STYLE} # true for stores that want the bucket in the path\n    timeout: 30s # the default is 5s\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 0 # keep retrying; the disk queue holds the backlog\n    sending_queue:\n      enabled: true # off by default on this exporter\n      storage: file_storage\n  awss3/metrics:\n    marshaler: otlp_json\n    s3uploader:\n      region: ${env:S3_REGION}\n      s3_bucket: ${env:S3_BUCKET}\n      s3_prefix: metrics\n      s3_partition_timezone: UTC\n      compression: gzip\n      endpoint: ${env:S3_ENDPOINT}\n      s3_force_path_style: ${env:S3_FORCE_PATH_STYLE}\n    timeout: 30s\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 0\n    sending_queue:\n      enabled: true\n      storage: file_storage\n  awss3/traces:\n    marshaler: otlp_json\n    s3uploader:\n      region: ${env:S3_REGION}\n      s3_bucket: ${env:S3_BUCKET}\n      s3_prefix: traces\n      s3_partition_timezone: UTC\n      compression: gzip\n      endpoint: ${env:S3_ENDPOINT}\n      s3_force_path_style: ${env:S3_FORCE_PATH_STYLE}\n    timeout: 30s\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 0\n    sending_queue:\n      enabled: true\n      storage: file_storage\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n    directory: /var/lib/otelcol/file_storage\n    create_directory: true # the default expects the directory to exist\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [awss3/logs]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [awss3/metrics]\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [awss3/traces]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.159.0",
    source_url: null,
    published: true,
    sort_order: 240,
  }),
]);

/** The four seeded flows' insert, as up runs it. */
export const seededFlowsInsert = () => flowsInsert(seededFlows);

/** The seeded flows' slugs, as SQL, for down. */
const slugs = seededFlows.map((flow) => `'${flow.slug}'`).join(", ");

export const up = (pgm) => {
  pgm.sql(seededFlowsInsert());
  pgm.sql(`
    comment on table flows is
      'prebuilt collector configurations, each solving one problem: one row
       per flow, no history, an edit overwrites it and a delete removes it
       for good. Global: no organization column, no row-level security.
       Anyone reads the published ones through the API; only a product admin
       (users.is_product_admin) writes them, which the API decides. Seeded
       with 13 flows by migration 1700000000026, 3 more by migration
       1700000000045 and 4 more by migration 1700000000046.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    delete from flows where slug in (${slugs});

    comment on table flows is
      'prebuilt collector configurations, each solving one problem: one row
       per flow, no history, an edit overwrites it and a delete removes it
       for good. Global: no organization column, no row-level security.
       Anyone reads the published ones through the API; only a product admin
       (users.is_product_admin) writes them, which the API decides. Seeded
       with 13 flows by migration 1700000000026 and 3 more by migration
       1700000000045.';
  `);
};
