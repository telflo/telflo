import type { ComponentType, PaletteComponent } from "./types.js";

/*
 * The component palette: 57 entries, each with its id, label, icon name, help
 * text, default config and connector signals, in the toolbox's order (D9a
 * decision 10). The entries are frozen, so a node takes a copy of a default
 * (`paletteDefaultConfig`).
 */

// Component palette data
const entries: PaletteComponent[] = [
  // Receivers
  {
    id: "otlp-receiver",
    type: "receiver",
    subType: "otlp",
    label: "OTLP",
    icon: "Database",
    helpText:
      "Accepts OpenTelemetry data over gRPC (4317) and HTTP (4318) from instrumented apps and other collectors. This is the default ingestion path for OTel.",
    defaultConfig: {
      protocols: {
        grpc: { endpoint: "localhost:4317" },
        http: { endpoint: "localhost:4318" },
      },
    },
  },
  {
    id: "prometheus-receiver",
    type: "receiver",
    subType: "prometheus",
    label: "Prometheus",
    icon: "Activity",
    helpText:
      "Scrapes Prometheus-format `/metrics` endpoints on a configured interval. Use this to pull metrics from existing Prometheus targets into the collector.",
    // D9d decision 9: no `report_extra_scrape_metrics`; the collector removed it in v0.149.0 and refuses it
    // (contrib CHANGELOG.md:3911-3912 at v0.162.0; not in receiver/prometheusreceiver/config.go).
    defaultConfig: {
      trim_metric_suffixes: false,
      config: {
        scrape_configs: [
          {
            job_name: "otel-collector",
            scrape_interval: "10s",
            static_configs: [{ targets: ["localhost:8888"] }],
          },
        ],
      },
    },
  },
  {
    id: "filelog-receiver",
    type: "receiver",
    subType: "filelog",
    label: "File Log",
    icon: "FileText",
    helpText:
      "Tails files on disk and emits each line as a log record, with multiline parsing and offset tracking. Use for apps that write logs to files instead of stdout.",
    defaultConfig: {
      include: ["/var/log/*.log"],
      start_at: "end",
      encoding: "utf-8",
      poll_interval: "200ms",
      max_concurrent_files: 1024,
      fingerprint_size: "1kb",
      max_log_size: "1MiB",
      force_flush_period: "500ms",
      include_file_name: true,
    },
  },
  {
    id: "fluentforward-receiver",
    type: "receiver",
    subType: "fluentforward",
    label: "Fluent Forward",
    icon: "Forward",
    helpText:
      "Runs a TCP server speaking the Fluent Forward protocol, so Fluent Bit and Fluentd `forward` outputs can ship logs straight to the collector. Logs pipelines only; also accepts `unix://` socket endpoints.",
    defaultConfig: {
      endpoint: "0.0.0.0:8006",
    },
  },
  {
    id: "docker-stats-receiver",
    type: "receiver",
    subType: "docker_stats",
    label: "Docker Stats",
    icon: "Container",
    helpText:
      "Scrapes CPU, memory, network, and block-IO stats for running containers from the Docker daemon's stats API. Metrics pipelines only, Linux only; the collector needs read access to the Docker socket (mount `/var/run/docker.sock`).",
    defaultConfig: {
      endpoint: "unix:///var/run/docker.sock",
      collection_interval: "10s",
      timeout: "5s",
    },
  },
  {
    id: "hostmetrics-receiver",
    type: "receiver",
    subType: "hostmetrics",
    label: "Host Metrics",
    icon: "Server",
    helpText:
      "Scrapes CPU, memory, disk, filesystem, network, and process metrics from the host the collector runs on. Configure individual scrapers to control what's collected.",
    defaultConfig: {
      collection_interval: "10s",
      initial_delay: "1s",
      scrapers: {
        cpu: {},
        memory: {},
        disk: {},
        filesystem: {},
      },
    },
  },
  {
    id: "jaeger-receiver",
    type: "receiver",
    subType: "jaeger",
    label: "Jaeger",
    icon: "Radar",
    helpText:
      "Accepts traces in legacy Jaeger formats (gRPC, Thrift HTTP, Thrift compact). Use only for apps still emitting Jaeger; new apps should send OTLP instead.",
    defaultConfig: {
      protocols: {
        grpc: { endpoint: "0.0.0.0:14250" },
        thrift_http: { endpoint: "0.0.0.0:14268" },
        thrift_compact: { endpoint: "0.0.0.0:6831" },
      },
    },
  },
  {
    id: "zipkin-receiver",
    type: "receiver",
    subType: "zipkin",
    label: "Zipkin",
    icon: "Zap",
    helpText:
      "Accepts traces in Zipkin v1/v2 JSON over HTTP on port 9411. Use only for legacy Zipkin senders; new apps should send OTLP instead.",
    defaultConfig: {
      endpoint: "0.0.0.0:9411",
      parse_string_tags: false,
    },
  },
  {
    id: "datadog-receiver",
    type: "receiver",
    subType: "datadog",
    label: "Datadog",
    icon: "Dog",
    helpText:
      "Accepts traces, metrics, and logs from Datadog Agents over HTTP (default port 8126). Use to migrate off Datadog-instrumented apps without re-instrumenting them.",
    defaultConfig: {
      endpoint: "localhost:8126",
      read_timeout: "60s",
      trace_id_cache_size: 100,
      idle_series_cleanup_interval: "5m",
    },
  },
  {
    id: "k8s-cluster-receiver",
    type: "receiver",
    subType: "k8s_cluster",
    label: "K8s Cluster",
    icon: "Hexagon",
    helpText:
      "Pulls cluster-level metrics (node, pod, deployment counts and conditions) from the Kubernetes API server. Run one instance per cluster, typically a Deployment with leader election.",
    defaultConfig: {
      auth_type: "serviceAccount",
      collection_interval: "10s",
      distribution: "kubernetes",
      node_conditions_to_report: ["Ready"],
      allocatable_types_to_report: [],
      metadata_collection_interval: "5m",
    },
  },
  {
    id: "k8s-events-receiver",
    type: "receiver",
    subType: "k8s_events",
    label: "K8s Events",
    icon: "Hexagon",
    helpText:
      "Streams Kubernetes events from the API server as log records. Use to capture cluster activity such as pod restarts, scheduling decisions, and image pull failures.",
    defaultConfig: {
      auth_type: "serviceAccount",
    },
  },
  {
    id: "k8s-objects-receiver",
    type: "receiver",
    subType: "k8sobjects",
    label: "K8s Objects",
    icon: "Hexagon",
    helpText:
      "Pulls or watches arbitrary Kubernetes objects (configmaps, secrets, CRDs) and emits them as logs. Use to track configuration drift or custom resource state over time.",
    defaultConfig: {
      auth_type: "serviceAccount",
      error_mode: "propagate",
      objects: [],
    },
  },
  {
    id: "kubeletstats-receiver",
    type: "receiver",
    subType: "kubeletstats",
    label: "Kubelet Stats",
    icon: "Hexagon",
    helpText:
      "Scrapes the kubelet's `/stats/summary` endpoint on each node for pod, container, node, and volume metrics. Run as a DaemonSet so every node has its own scraper.",
    defaultConfig: {
      auth_type: "serviceAccount",
      collection_interval: "10s",
      initial_delay: "1s",
      endpoint: "https://${env:K8S_NODE_NAME}:10250",
      insecure_skip_verify: false,
      metric_groups: ["container", "pod", "node", "volume"],
      extra_metadata_labels: [],
    },
  },
  {
    id: "netflow-receiver",
    type: "receiver",
    subType: "netflow",
    label: "Netflow",
    icon: "Network",
    helpText:
      "Receives NetFlow, IPFIX, and sFlow network flow records on a UDP port and converts them to logs. Use to ingest network telemetry from routers and switches.",
    defaultConfig: {
      scheme: "netflow",
      hostname: "0.0.0.0",
      port: 2055,
      sockets: 1,
      workers: 2,
      queue_size: 1000,
      send_raw: false,
    },
  },
  {
    id: "journald-receiver",
    type: "receiver",
    subType: "journald",
    label: "Journald",
    icon: "ScrollText",
    helpText:
      "Reads the systemd journal by shelling out to `journalctl` and emits each entry as a log record. Linux only - the collector needs the `journalctl` binary and read access to the journal (mount `/var/log/journal` and `/run/log/journal` when containerized).",
    defaultConfig: {
      start_at: "end",
      priority: "info",
    },
  },
  {
    id: "syslog-receiver",
    type: "receiver",
    subType: "syslog",
    label: "Syslog",
    icon: "FileText",
    helpText:
      "Accepts syslog messages over TCP or UDP in RFC5424 or RFC3164 format. Use to ingest logs from network devices, legacy systems, or syslog-forwarding daemons.",
    defaultConfig: {
      tcp: {
        listen_address: "0.0.0.0:54526",
        max_log_size: 1048576,
      },
      protocol: "rfc5424",
      location: "UTC",
      enable_octet_counting: false,
      max_octets: 8192,
      allow_skip_pri_header: false,
    },
  },
  {
    id: "statsd-receiver",
    type: "receiver",
    subType: "statsd",
    label: "StatsD",
    icon: "ChartBar",
    helpText:
      "Receives StatsD metrics over UDP/TCP and converts counters, gauges, timers, and histograms to OTLP. Use to ingest metrics from apps that still emit StatsD.",
    defaultConfig: {
      endpoint: "localhost:8125",
      transport: "udp",
      aggregation_interval: "60s",
      enable_ip_only_aggregation: false,
      enable_metric_type: false,
      is_monotonic_counter: false,
      enable_simple_tags: false,
      timer_histogram_mapping: [
        {
          statsd_type: "histogram",
          observer_type: "histogram",
          histogram: {
            max_size: 100,
          },
        },
        {
          statsd_type: "timing",
          observer_type: "summary",
          summary: {
            percentiles: [0, 10, 50, 90, 95, 100],
          },
        },
      ],
    },
  },
  {
    id: "awss3-receiver",
    type: "receiver",
    subType: "awss3",
    label: "AWS S3",
    icon: "CloudDownload",
    helpText:
      "Replays telemetry archived in S3 (typically by the AWS S3 exporter) as traces, metrics, or logs. Either ingest continuously from S3 event notifications on an SQS queue, or walk a fixed time range with `starttime`/`endtime`. Credentials come from the AWS SDK default chain, never from this config.",
    defaultConfig: {
      s3downloader: {
        region: "us-east-1",
        s3_bucket: "${env:AWS_S3_BUCKET}",
        s3_prefix: "telemetry",
      },
      // SQS mode is the steady-state shape (a time range is a one-shot
      // replay and would go stale as a default).
      sqs: {
        queue_url: "${env:AWS_SQS_QUEUE_URL}",
        region: "us-east-1",
      },
    },
  },
  // Processors
  {
    id: "batch-processor",
    type: "processor",
    subType: "batch",
    label: "Batch",
    icon: "Package",
    helpText:
      "Buffers telemetry and flushes in batches by size or timeout. Add it to every pipeline to reduce per-export overhead and improve throughput.",
    defaultConfig: {
      timeout: "200ms",
      send_batch_size: 8192,
      send_batch_max_size: 0,
      metadata_keys: [],
      metadata_cardinality_limit: 1000,
    },
  },
  {
    id: "memory-limiter-processor",
    type: "processor",
    subType: "memory_limiter",
    label: "Memory Limiter",
    icon: "Gauge",
    helpText:
      "Drops or refuses incoming data when the collector's memory exceeds a threshold so the process doesn't OOM. Should be the first processor on every pipeline.",
    defaultConfig: {
      check_interval: "1s",
      limit_mib: 512,
    },
  },
  {
    id: "resource-processor",
    type: "processor",
    subType: "resource",
    label: "Resource",
    icon: "Tag",
    helpText:
      "Adds, updates, or deletes attributes on the Resource, the identity of the telemetry source (`service.name`, `deployment.environment`). Applies to every signal that flows through.",
    defaultConfig: {
      attributes: [
        {
          key: "environment",
          value: "production",
          action: "insert",
        },
      ],
    },
  },
  {
    id: "attributes-processor",
    type: "processor",
    subType: "attributes",
    label: "Attributes",
    icon: "Tags",
    helpText:
      "Adds, updates, hashes, or deletes attributes on individual spans, metrics, and logs. Use for per-record enrichment or scrubbing fields like passwords or PII.",
    defaultConfig: {
      actions: [
        {
          key: "environment",
          action: "insert",
          value: "production",
        },
        {
          key: "db.password",
          action: "delete",
        },
      ],
    },
  },
  {
    id: "filter-processor",
    type: "processor",
    subType: "filter",
    label: "Filter",
    icon: "Filter",
    helpText:
      "Drops spans, metrics, or logs that match OTTL conditions. Use to trim noise (health checks, internal traffic, debug-level logs) before it is exported.",
    defaultConfig: {
      error_mode: "ignore",
      traces: {
        span: ['attributes["container.name"] == "app"'],
      },
    },
  },
  {
    id: "probabilistic-sampler-processor",
    type: "processor",
    subType: "probabilistic_sampler",
    label: "Probabilistic Sampler",
    icon: "Percent",
    helpText:
      "Keeps a fixed percentage of traces using a hash of the trace ID so all spans of a kept trace land together. Head-based and low-overhead; span content is not inspected.",
    defaultConfig: {
      mode: "proportional",
      sampling_percentage: 10,
      fail_closed: true,
      sampling_precision: 4,
    },
  },
  {
    id: "tail-sampling-processor",
    type: "processor",
    subType: "tail_sampling",
    label: "Tail Sampling",
    icon: "GitBranch",
    helpText:
      "Buffers complete traces and samples based on policies (errors, latency, attributes). More accurate than probabilistic sampling but uses memory and adds decision-wait latency.",
    defaultConfig: {
      decision_wait: "30s",
      num_traces: 50000,
      expected_new_traces_per_sec: 0,
      policies: [
        {
          name: "sample-errors",
          type: "status_code",
          status_code: {
            status_codes: ["ERROR"],
          },
        },
        {
          name: "sample-10-percent",
          type: "probabilistic",
          probabilistic: {
            sampling_percentage: 10,
          },
        },
      ],
    },
  },
  {
    id: "k8sattributes-processor",
    type: "processor",
    subType: "k8sattributes",
    label: "Kubernetes Attributes",
    icon: "Cloud",
    helpText:
      "Enriches telemetry with Kubernetes metadata (pod, namespace, deployment, node) by associating each record with its originating pod. Requires RBAC to watch pods.",
    defaultConfig: {
      auth_type: "serviceAccount",
      passthrough: false,
      extract: {
        metadata: [
          "k8s.namespace.name",
          "k8s.pod.name",
          "k8s.pod.uid",
          "k8s.deployment.name",
          "k8s.node.name",
        ],
      },
      pod_association: [
        {
          sources: [
            {
              from: "connection",
            },
          ],
        },
      ],
    },
  },
  {
    id: "redaction-processor",
    type: "processor",
    subType: "redaction",
    label: "Redaction",
    icon: "ShieldCheck",
    helpText:
      "Removes or masks attribute values that don't match an allow-list or that match a deny-pattern. Use to scrub PII, secrets, or tokens before data leaves your environment.",
    defaultConfig: {
      allow_all_keys: false,
      summary: "info",
      url_sanitizer: {
        enabled: true,
        attributes: ["http.url", "url"],
      },
    },
  },
  {
    id: "cumulativetodelta-processor",
    type: "processor",
    subType: "cumulativetodelta",
    label: "Cumulative to Delta",
    icon: "TrendingUp",
    helpText:
      "Converts cumulative-temporality metrics to delta temporality. Required for backends (e.g. some cloud vendors, Datadog) that only accept delta metrics.",
    defaultConfig: {
      initial_value: "auto",
      max_staleness: "5m",
    },
  },
  {
    id: "resourcedetection-processor",
    type: "processor",
    subType: "resourcedetection",
    label: "Resource Detection",
    icon: "CloudCog",
    helpText:
      "Auto-detects environment attributes (cloud provider, region, instance ID, host) and attaches them as Resource attributes. Saves you from hardcoding host/cloud metadata.",
    defaultConfig: {
      detectors: ["env", "system"],
      timeout: "5s",
      override: true,
    },
  },
  {
    id: "transform-processor",
    type: "processor",
    subType: "transform",
    label: "Transform",
    icon: "Wand2",
    helpText:
      "Rewrites telemetry using OTTL statements: rename fields, convert types, parse strings, derive new attributes. Use when no specialized processor covers the change you need.",
    defaultConfig: {
      error_mode: "propagate",
      trace_statements: [],
      metric_statements: [],
      log_statements: [],
    },
  },
  {
    id: "logdedup-processor",
    type: "processor",
    subType: "logdedup",
    label: "Log DeDuplication",
    icon: "CopyMinus",
    helpText:
      "Aggregates identical log records within an interval and emits one record with a duplicate count. Use to collapse noisy, repetitive logs before export. Logs pipelines only.",
    defaultConfig: {
      interval: "10s",
      log_count_attribute: "log_count",
      timezone: "UTC",
    },
  },
  {
    id: "span-processor",
    type: "processor",
    subType: "span",
    label: "Span",
    icon: "PenLine",
    helpText:
      "Renames spans from attribute values, extracts attributes from span names with regex capture groups (e.g. templating URL paths), or overrides span status. Traces pipelines only.",
    defaultConfig: {
      name: {
        to_attributes: {
          rules: ["^\\/api\\/v1\\/document\\/(?P<documentId>.*)\\/update$"],
        },
      },
    },
  },
  {
    id: "groupbyattrs-processor",
    type: "processor",
    subType: "groupbyattrs",
    label: "Group by Attributes",
    icon: "Group",
    helpText:
      "Regroups spans, metrics, and logs into resources keyed by the listed attribute values — e.g. turn a flat Prometheus or Fluent Bit stream into per-host resources. With no keys it compacts records sharing a resource. Pair with a `batch` processor as the next step.",
    defaultConfig: {
      keys: ["host.name"],
    },
  },
  {
    id: "metricstransform-processor",
    type: "processor",
    subType: "metricstransform",
    label: "Metrics Transform",
    icon: "Combine",
    helpText:
      "Renames metrics, adds or renames labels, scales values, and aggregates across labels or label values. Operates within a batch only — it never aggregates across batches or sources. Metrics pipelines only.",
    defaultConfig: {
      transforms: [
        {
          include: "system.cpu.usage",
          match_type: "strict",
          action: "update",
          new_name: "system.cpu.usage_time",
        },
      ],
    },
  },
  // Exporters
  {
    id: "otlp-exporter",
    type: "exporter",
    subType: "otlp",
    label: "OTLP",
    icon: "Send",
    helpText:
      "Sends telemetry to another OTLP gRPC endpoint (downstream collector, vendor backend). The default export path for OpenTelemetry data.",
    defaultConfig: {
      endpoint: "otelcol:4317",
      timeout: "5s",
      compression: "gzip",
      tls: {
        insecure: true,
      },
    },
  },
  {
    id: "otlphttp-exporter",
    type: "exporter",
    subType: "otlphttp",
    label: "OTLP/HTTP",
    icon: "Globe",
    helpText:
      "Sends telemetry to an OTLP/HTTP endpoint. Use when gRPC is blocked by a firewall or load balancer, or when the backend only supports the HTTP variant.",
    defaultConfig: {
      endpoint: "http://localhost:4318",
      timeout: "30s",
      encoding: "proto",
      compression: "gzip",
    },
  },
  {
    id: "loadbalancing-exporter",
    type: "exporter",
    subType: "loadbalancing",
    label: "Load Balancing",
    icon: "Network",
    helpText:
      "Spreads traces across a backend pool by hashing on trace ID so all spans of a trace land on the same instance. Required upstream of tail sampling when running it at scale.",
    // D9d decision 9: no `routing_key`; `traceID` is refused in a metrics pipeline, and unset is each
    // signal's own default: traceID for traces (exporter/loadbalancingexporter/trace_exporter.go:70, 83),
    // service for metrics (metrics_exporter.go:70-72) and logs (log_exporter.go:74-75), at v0.162.0.
    defaultConfig: {
      protocol: {
        otlp: {
          timeout: "10s",
          compression: "gzip",
          retry_on_failure: {
            enabled: true,
            initial_interval: "5s",
            max_interval: "30s",
            max_elapsed_time: "300s",
          },
          sending_queue: {
            enabled: true,
            num_consumers: 10,
            queue_size: 1000,
          },
        },
      },
      resolver: {
        static: {
          hostnames: ["localhost:4317"],
        },
      },
    },
  },
  {
    id: "zipkin-exporter",
    type: "exporter",
    subType: "zipkin",
    label: "Zipkin",
    icon: "Zap",
    helpText:
      "Sends traces to a Zipkin server in v2 JSON format. Use when the destination backend speaks Zipkin; prefer OTLP exporters for everything else.",
    defaultConfig: {
      endpoint: "http://zipkin:9411/api/v2/spans",
    },
  },
  {
    id: "prometheus-exporter",
    type: "exporter",
    subType: "prometheus",
    label: "Prometheus",
    icon: "Activity",
    helpText:
      "Exposes pipeline metrics at a `/metrics` endpoint in Prometheus format for a Prometheus server to scrape. Pull-based — nothing is pushed; point your Prometheus scrape config at the collector.",
    defaultConfig: {
      endpoint: "0.0.0.0:8889",
      metric_expiration: "5m",
    },
  },
  {
    id: "prometheusremotewrite-exporter",
    type: "exporter",
    subType: "prometheusremotewrite",
    label: "Prometheus Remote Write",
    icon: "Activity",
    helpText:
      "Pushes metrics to a Prometheus remote-write endpoint (Prometheus, Cortex, Mimir, Thanos, ClickStack's PromQL ingest). Push-based counterpart to the pull-based Prometheus exporter; metrics only.",
    defaultConfig: {
      endpoint: "https://prometheus.example.com/api/v1/write",
    },
  },
  {
    id: "datadog-exporter",
    type: "exporter",
    subType: "datadog",
    label: "Datadog",
    icon: "Dog",
    helpText:
      "Sends traces, metrics, and logs to Datadog. Requires a Datadog API key and intake site; use `sending_queue.batch` instead of the batch processor to avoid 413 payload-too-large errors.",
    defaultConfig: {
      api: {
        key: "${env:DD_API_KEY}",
        site: "datadoghq.com",
      },
      host_metadata: {
        enabled: true,
      },
    },
  },
  {
    id: "clickhouse-exporter",
    type: "exporter",
    subType: "clickhouse",
    label: "ClickHouse",
    icon: "Database",
    helpText:
      "Sends traces, metrics, and logs to ClickHouse tables. ClickHouse performs best with large batched inserts — keep `async_insert` on or add a batch processor upstream.",
    defaultConfig: {
      endpoint: "tcp://localhost:9000?dial_timeout=10s",
      database: "otel",
      ttl: "72h",
      compress: "lz4",
      async_insert: true,
      create_schema: true,
      timeout: "5s",
      retry_on_failure: {
        enabled: true,
        initial_interval: "5s",
        max_interval: "30s",
        max_elapsed_time: "300s",
      },
    },
  },
  {
    id: "debug-exporter",
    type: "exporter",
    subType: "debug",
    label: "Debug",
    icon: "Terminal",
    helpText:
      "Prints telemetry summaries to the collector's own logs. Use to troubleshoot pipeline plumbing, and turn it off in production.",
    defaultConfig: {
      verbosity: "basic",
      sampling_initial: 2,
      sampling_thereafter: 1,
      use_internal_logger: true,
    },
  },
  {
    id: "file-exporter",
    type: "exporter",
    subType: "file",
    label: "File",
    icon: "FileOutput",
    helpText:
      "Writes telemetry to a local file as JSON. Use for offline inspection, golden-file tests, or capturing a sample of production data for replay.",
    defaultConfig: {
      path: "./output.json",
    },
  },
  {
    id: "awss3-exporter",
    type: "exporter",
    subType: "awss3",
    label: "AWS S3",
    icon: "CloudUpload",
    helpText:
      "Archives traces, metrics, and logs to S3 objects under a time-partitioned key (`year=/month=/day=/hour=/minute=`), as OTLP JSON by default. Use for long-term retention, data-lake ingestion, or later replay through the AWS S3 receiver. Credentials come from the AWS SDK default chain (env vars, instance role, IRSA), never from this config.",
    defaultConfig: {
      s3uploader: {
        region: "us-east-1",
        s3_bucket: "${env:AWS_S3_BUCKET}",
        s3_prefix: "telemetry",
      },
      marshaler: "otlp_json",
    },
  },
  // Extensions
  {
    id: "health-check-extension",
    type: "extension",
    subType: "health_check",
    label: "Health Check",
    icon: "HeartPulse",
    helpText:
      "Exposes an HTTP endpoint for liveness and readiness probes. Wire this up so Kubernetes or load balancers can tell when the collector is healthy.",
    defaultConfig: {
      endpoint: "0.0.0.0:13133",
      path: "/",
    },
  },
  {
    id: "pprof-extension",
    type: "extension",
    subType: "pprof",
    label: "pprof",
    icon: "Bug",
    helpText:
      "Exposes Go pprof endpoints for CPU and memory profiling of the collector process itself. Diagnostic only; keep the endpoint off the public network.",
    defaultConfig: {
      endpoint: "0.0.0.0:1777",
    },
  },
  {
    id: "zpages-extension",
    type: "extension",
    subType: "zpages",
    label: "zPages",
    icon: "PanelTop",
    helpText:
      "Exposes in-process HTML pages showing live pipeline state, recent spans, and component diagnostics. Use for debugging without leaving the collector.",
    defaultConfig: {
      endpoint: "0.0.0.0:55679",
    },
  },
  {
    id: "file-storage-extension",
    type: "extension",
    subType: "file_storage",
    label: "File Storage",
    icon: "HardDrive",
    helpText:
      "Persists queues and checkpoints to disk so receivers (e.g. filelog offsets) and exporter retry queues survive collector restarts without data loss.",
    defaultConfig: {
      directory: "/var/lib/otelcol/file_storage",
      timeout: "1s",
      create_directory: true,
    },
  },
  {
    id: "opamp-extension",
    type: "extension",
    subType: "opamp",
    label: "OpAMP",
    icon: "RadioTower",
    helpText:
      "Connects the collector to an OpAMP server for remote management: it reports effective config and health, and can accept restart commands. Configure exactly one transport — websocket (`ws`) or `http`.",
    defaultConfig: {
      server: {
        ws: {
          endpoint: "wss://opamp-server:4320/v1/opamp",
        },
      },
    },
  },
  {
    id: "memory-limiter-extension",
    type: "extension",
    subType: "memory_limiter",
    label: "Memory Limiter",
    icon: "Gauge",
    helpText:
      "Same limits as the `memory_limiter` processor, applied as receiver middleware so requests are refused before decoding. Not in the stock contrib collector — only custom builds (e.g. the ClickStack collector) include it, so validation against contrib reports it as unknown.",
    defaultConfig: {
      check_interval: "1s",
      limit_mib: 512,
    },
  },
  {
    id: "bearertokenauth-extension",
    type: "extension",
    subType: "bearertokenauth",
    label: "Bearer Token Auth",
    icon: "KeyRound",
    helpText:
      "Static bearer-token authenticator. Reference it from a receiver or exporter via `auth.authenticator: bearertokenauth` — receivers then require the token on every request; exporters attach it. Provide a `token`, a `tokens` list, or a `filename`.",
    defaultConfig: {
      tokens: ["${env:OTLP_AUTH_TOKEN}"],
    },
  },
  {
    id: "oidc-extension",
    type: "extension",
    subType: "oidc",
    label: "OIDC Auth",
    icon: "ShieldCheck",
    helpText:
      "Verifies incoming bearer JWTs against OIDC providers: signature via the issuer's JWKS plus issuer and audience claims. Reference it from a receiver via `auth.authenticator: oidc`. Incoming tokens are matched to a provider by their `iss` claim.",
    defaultConfig: {
      providers: [
        {
          issuer_url: "${env:OIDC_ISSUER_URL}",
          audience: "${env:OIDC_AUDIENCE}",
        },
      ],
    },
  },
  // Connectors
  {
    id: "spanmetrics-connector",
    type: "connector",
    subType: "spanmetrics",
    label: "Spanmetrics",
    icon: "ArrowRightLeft",
    helpText:
      "Aggregates RED metrics (request rate, errors, duration histogram) from spans and emits them as metrics. Connect a traces pipeline to a metrics pipeline through it.",
    connectorSignals: {
      inputSignal: "traces",
      outputSignal: "metrics",
    },
    defaultConfig: {
      histogram: {
        unit: 'ms',
        explicit: {
          // D9d decision 9: durations, the collector's own defaults (connector/spanmetricsconnector/config.go:25-27);
          // the buckets are `[]time.Duration` (config.go:139-144), so a bare number is nanoseconds.
          buckets: ["2ms", "4ms", "6ms", "8ms", "10ms", "50ms", "100ms", "200ms", "400ms", "800ms", "1s", "1400ms", "2s", "5s", "10s", "15s"],
        },
      },
      dimensions: [],
      aggregation_temporality: 'CUMULATIVE',
    },
  },
  {
    id: "forward-connector",
    type: "connector",
    subType: "forward",
    label: "Forward",
    icon: "ArrowRightLeft",
    helpText:
      "Forwards telemetry between pipelines that carry the same signal type; use it to merge several pipelines into one or fan one out into many. Has no configuration.",
    // No fixed connectorSignals: forward is signal-agnostic. The validator
    // enforces that every pipeline wired to it shares one signal type.
    defaultConfig: {},
  },
  {
    id: "routing-connector",
    type: "connector",
    subType: "routing",
    label: "Routing",
    icon: "Split",
    helpText:
      "Routes telemetry to different pipelines of the same signal type using OTTL conditions — split by tenant, environment, or severity. Telemetry that matches no route goes to the default pipelines, or is dropped if none are set.",
    // No fixed connectorSignals: routing is signal-agnostic (same-signal
    // in/out). The validator enforces one signal type across its wiring.
    defaultConfig: {
      // The collector's default error_mode is `ignore` since v0.155.0's beta
      // gate `connector.routing.defaultErrorModeIgnore` (on by default;
      // connector/routingconnector/metadata.yaml:14-18, factory.go:19-23 at
      // v0.162.0); with the gate off it is `propagate`, which drops the whole
      // payload on any OTTL evaluation error. The seed writes `ignore` so the
      // text says so whatever the gate.
      error_mode: "ignore",
      table: [],
    },
  },
  {
    id: "failover-connector",
    type: "connector",
    subType: "failover",
    label: "Failover",
    icon: "LifeBuoy",
    helpText:
      "Health-based failover between pipelines of the same signal type: telemetry goes to the highest-priority level whose exporters are healthy, drops to the next level when one fails, and fails back once the higher level recovers (probed every `retry_interval`). Several pipelines at one level fan out together. Keep the sending queue on this connector rather than on the downstream exporters, so queued data is not stranded when an exporter fails.",
    // No fixed connectorSignals: failover is signal-agnostic (same-signal
    // in/out). The validator enforces one signal type across its wiring.
    defaultConfig: {
      priority_levels: [],
    },
  },
];

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const componentPalette: readonly PaletteComponent[] = deepFreeze(entries);

/** The palette entry for a kind and the palette's spelling of a type. */
export function findPaletteEntry(type: ComponentType, subType: string): PaletteComponent | undefined {
  return componentPalette.find((entry) => entry.type === type && entry.subType === subType);
}

/** A copy of an entry's default config, for a new node to own (decision 8). */
export function paletteDefaultConfig(entry: PaletteComponent): unknown {
  return structuredClone(entry.defaultConfig);
}
