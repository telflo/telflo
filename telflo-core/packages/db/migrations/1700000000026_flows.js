/**
 * Flows, the product-admin flag and the seeded flows.
 *
 *   * flows: prebuilt collector configurations, each solving one problem: one
 *     row per flow, no history (an edit overwrites the row; a delete removes
 *     it for good), a published switch. Global: no organization column and no
 *     row-level security, since every organization reads the same flows.
 *     Migration 009's default privileges give telflo_platform_runtime select,
 *     insert, update and delete, which the API needs: anyone reads the
 *     published flows through it, and only a product admin writes them, which
 *     the API decides.
 *   * The checks: the slug is kebab-case and unique (the public URL
 *     /flows/<slug>), and at most 80 characters (the admin dialog's slugify's
 *     limit); source is telflo or community; source_url is null or http(s)://
 *     (it is rendered into an href on a public page); the collector version is
 *     not blank. collector_distribution references the catalog, so no flow
 *     can name a distribution the platform doesn't offer (ClickStack). The
 *     version has no foreign key: the API checks it against the catalog on
 *     every write, and a pin deprecated since still reads.
 *   * created_at and updated_at have no default, as configurations' have none
 *     (migration 015): the API writes both from its injected clock, so they
 *     hold whole milliseconds as a JavaScript Date does. Nor does
 *     collector_distribution: there is one default distribution, the
 *     catalog's, not a second one here.
 *   * users.is_product_admin, false by default, set and cleared only by an
 *     operator's SQL, as the tables' owner. A trigger,
 *     users_product_admin_owner_only, refuses an insert with the flag true and
 *     an update that changes it unless current_user is a member of the users
 *     table's owner, with SQLSTATE 42501 and a message naming only the user's
 *     id. The API's role is not, so it can neither grant nor revoke the flag,
 *     while every write it makes to users today (which never names the flag)
 *     still works. Not SECURITY DEFINER: it must see the role that runs the
 *     write. Its limits are operator-level (ALTER TABLE … DISABLE TRIGGER,
 *     session_replication_role = replica, dropping or replacing it), which the
 *     API's role can do none of. An insert that sets the flag to NULL is
 *     refused by the column's NOT NULL constraint (23502), not by the trigger.
 *     A later BEFORE trigger on users must not change the flag, since this one
 *     runs before it only by alphabetical order of the triggers' names.
 *   * configurations.source_flow_slug: the flow a configuration was created
 *     from, or null. No foreign key and no check: a flow may be deleted, and
 *     the configuration keeps its copy; the API checks the slug's format on
 *     create and returns it nowhere.
 *   * The 13 seeded flows, pinned: every flow on otelcol-contrib, at 0.159.0
 *     for clickhouse-failover-gateway-s3-overflow and 0.162.0 for the rest,
 *     each YAML kept byte for byte. They are held below as `seededFlows`, each
 *     text a JSON-escaped string, and written with dollar quoting
 *     (seededFlowsInsert), so no text is ever escaped for SQL. This migration
 *     reads no file. The insert is on conflict (slug) do nothing: it runs once
 *     on every database, a developer's own included; later changes go through
 *     the admin screen or a new migration. Their timestamps are the
 *     migration's time to the millisecond, as the API's clock would write
 *     them. `seededFlows` and `seededFlowsInsert` are exported for the tests
 *     and their fixtures (@telflo/db/testing's insertSeededFlows), which reach
 *     them by a dynamic import of this module.
 *
 * down drops exactly what up added: the column on configurations, the
 * trigger and its function, the flag, and the flows table with its rows.
 */

/** The 13 seeded flows, in their sort order. */
export const seededFlows = Object.freeze([
  Object.freeze({
    slug: "log-volume-cost-control",
    name: "Log Volume Cost Control",
    summary: "Drops DEBUG and TRACE records from services you name, filters health-check and probe traffic by URL path, user agent, and body, and truncates oversized attributes.",
    description: "Most log bills are paid for records nobody reads. This flow puts three cuts in front of the exporter: a filter processor that drops sub-INFO records from services you list by name, removes health-check and probe traffic matched by URL path, user agent, and raw body, and a transform that truncates runaway attribute values and deletes cookie and command-line keys outright. A logdedup processor then collapses WARN-and-above storms into a single record with a count.\n\nThe severity filter guards on `severity_number > 0` so unparsed records (UNSPECIFIED) are not swept up with the debug noise. logdedup buffers for its interval, so it adds that much delivery latency — the memory_limiter is sized with headroom for that buffer. Point the filelog receiver at your own paths, or drop it from the pipeline if everything arrives over OTLP.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs"]),
    tags: Object.freeze(["cost", "filtering", "logs"]),
    yaml_content: "# Log Volume Cost Control\n# Drop debug noise, health-check spam, and duplicate storms before they\n# reach a per-GB vendor bill. Collector contrib v0.146.0.\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317 # default binds localhost only; open up for remote agents\n      http:\n        endpoint: 0.0.0.0:4318\n  filelog:\n    include: [/var/log/app/*.log] # point at your own paths, or remove from the pipeline\n    start_at: end # do not re-ingest (and re-pay for) history on first start\n    storage: file_storage # checkpoint offsets so restarts do not resend files\n\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 512\n    spike_limit_mib: 128 # logdedup buffers records for its interval; keep headroom\n  filter/drop-noise:\n    error_mode: ignore # a bad condition logs an error instead of dropping the payload\n    logs:\n      log_record:\n        # DEBUG/TRACE from named chatty services only. The severity_number > 0\n        # guard keeps unparsed logs (UNSPECIFIED = 0) from being dropped too.\n        - severity_number > 0 and severity_number < SEVERITY_NUMBER_INFO and IsMatch(resource.attributes[\"service.name\"], \"^(checkout|cart|payments)$\")\n        # health-check endpoints by attribute...\n        - attributes[\"url.path\"] != nil and IsMatch(attributes[\"url.path\"], \"^/(healthz?|livez|readyz|ping|status)$\")\n        # ...k8s probes by user agent...\n        - attributes[\"user_agent.original\"] != nil and IsMatch(attributes[\"user_agent.original\"], \"^kube-probe/\")\n        # ...and plain-text access-log lines for the same endpoints\n        - IsMatch(body, \"\\\"(GET|HEAD) /(healthz?|livez|readyz|ping)[\\\" ]\")\n  transform/trim:\n    error_mode: ignore\n    log_statements:\n      - truncate_all(log.attributes, 1024) # cap runaway attribute values\n      - delete_key(log.attributes, \"http.request.header.cookie\")\n      - delete_key(log.attributes, \"process.command_line\")\n  logdedup:\n    interval: 30s # holds matching records up to 30s; adds that much delivery latency\n    log_count_attribute: log_count\n    conditions:\n      # collapse WARN-and-above storms only; delete this block to dedup all logs\n      - severity_number >= SEVERITY_NUMBER_WARN\n  batch: {} # defaults (8192 items / 200ms); last, so it batches what survived\n\nexporters:\n  otlp_http: # renamed from `otlphttp` in core v0.144.0; any OTLP/HTTP backend works\n    endpoint: ${env:OTLP_LOGS_ENDPOINT} # e.g. https://otlp.your-vendor.com:4318\n    headers:\n      Authorization: \"Bearer <YOUR_API_KEY>\"\n    compression: gzip\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 300s\n    sending_queue:\n      sizer: items # size the queue in log records, not opaque requests\n      queue_size: 5000\n      storage: file_storage # queue survives collector restarts\n  # Shipping to Datadog or Splunk instead? Replace otlp_http with the\n  # `datadog` or `splunk_hec` exporter and update the pipeline below.\n\nextensions:\n  file_storage:\n    directory: /var/lib/otelcol/file_storage\n    create_directory: true # default dir must exist otherwise\n  health_check:\n    endpoint: 0.0.0.0:13133\n\nservice:\n  extensions: [file_storage, health_check]\n  pipelines:\n    logs:\n      receivers: [otlp, filelog]\n      processors: [memory_limiter, filter/drop-noise, transform/trim, logdedup, batch]\n      exporters: [otlp_http]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 10,
  }),
  Object.freeze({
    slug: "kubernetes-telemetry-stack",
    name: "Kubernetes Telemetry Stack",
    summary: "Collects container logs, kubelet metrics, cluster-state metrics, and Kubernetes events in one config, split into DaemonSet and single-replica pipelines so cluster data is not duplicated per node.",
    description: "One config covering two collector roles. The DaemonSet pipelines (`logs/pods`, `metrics/node`) read container logs off every node and scrape kubeletstats locally. The singleton pipelines (`metrics/cluster`, `logs/events`) run in a one-replica Deployment, because `k8s_cluster` and `k8s_events` report cluster-wide state — running them in the DaemonSet duplicates every cluster metric once per node.\n\nThe filelog receiver uses the `container` operator to auto-detect docker, containerd, and CRI-O formats and recombine partial CRI lines, and explicitly excludes the collector's own logs to avoid a feedback loop. `k8s_attributes` enriches with namespace, pod, deployment, and node metadata, with pod association falling back from UID to name+namespace to connection so both the metrics and logs paths resolve. Offsets and the export queue are checkpointed to file_storage so a pod restart doesn't replay or drop.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["metrics", "logs"]),
    tags: Object.freeze(["kubernetes", "collection", "daemonset"]),
    yaml_content: "# Kubernetes Telemetry Stack -- one config, two collector roles:\n#   DAEMONSET (every node): filelog + kubeletstats -> pipelines logs/pods, metrics/node\n#   SINGLETON (one-replica Deployment): k8s_cluster + k8s_events -> metrics/cluster, logs/events\n# Cluster receivers in the DaemonSet duplicate cluster-wide data once per node.\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133  # liveness/readiness probes; do not use check_collector_pipeline (broken per README)\n  file_storage:\n    directory: /var/lib/otelcol/file_storage  # hostPath on the DaemonSet\n    create_directory: true\n\nreceivers:\n  filelog:\n    include:\n      - /var/log/pods/*/*/*.log\n    exclude:\n      - /var/log/pods/*/otel-collector/*.log  # never ingest the collector's own logs (feedback loop)\n    start_at: beginning  # safe: offsets checkpoint to file_storage, no replay on restart\n    storage: file_storage\n    include_file_path: true  # required for add_metadata_from_filepath\n    retry_on_failure:\n      enabled: true\n    operators:\n      - type: container  # auto-detects docker/containerd/cri-o; recombines CRI partial lines\n        add_metadata_from_filepath: true\n\n  kubeletstats:\n    collection_interval: 30s\n    auth_type: serviceAccount\n    endpoint: https://${env:K8S_NODE_NAME}:10250  # K8S_NODE_NAME via downward API (spec.nodeName)\n    node: ${env:K8S_NODE_NAME}\n    insecure_skip_verify: true  # kubelet serving certs are usually self-signed\n    metric_groups: [container, pod, node]\n\n  k8s_cluster:  # SINGLETON only\n    auth_type: serviceAccount\n    collection_interval: 30s\n    node_conditions_to_report: [Ready, MemoryPressure]\n    allocatable_types_to_report: [cpu, memory]\n\n  k8s_events:  # SINGLETON only\n    auth_type: serviceAccount\n\nprocessors:\n  memory_limiter:  # first in every pipeline so backpressure reaches receivers\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  k8s_attributes:  # renamed from k8sattributes in contrib v0.146.0; must run before batch\n    auth_type: serviceAccount\n    passthrough: false\n    extract:\n      metadata:\n        - k8s.namespace.name\n        - k8s.pod.name\n        - k8s.pod.uid\n        - k8s.deployment.name\n        - k8s.node.name\n    pod_association:\n      - sources:\n          - from: resource_attribute\n            name: k8s.pod.uid  # kubeletstats metrics carry the pod UID\n      - sources:\n          - from: resource_attribute\n            name: k8s.pod.name  # set by the container operator from the file path\n          - from: resource_attribute\n            name: k8s.namespace.name\n      - sources:\n          - from: connection\n\n  resourcedetection:\n    detectors: [env, system]  # env reads OTEL_RESOURCE_ATTRIBUTES, e.g. deployment.environment\n    timeout: 2s\n    override: false\n\n  batch:  # last before export\n    send_batch_size: 8192\n    timeout: 200ms\n\nexporters:\n  otlp_grpc:  # renamed from otlp in core v0.144.0\n    endpoint: ${env:OTLP_ENDPOINT}  # e.g. gateway-collector.observability.svc:4317\n    tls:\n      insecure: false\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      enabled: true\n      storage: file_storage  # persistent queue survives pod restarts\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    logs/pods:  # DAEMONSET\n      receivers: [filelog]\n      processors: [memory_limiter, k8s_attributes, resourcedetection, batch]\n      exporters: [otlp_grpc]\n    metrics/node:  # DAEMONSET\n      receivers: [kubeletstats]\n      processors: [memory_limiter, k8s_attributes, resourcedetection, batch]\n      exporters: [otlp_grpc]\n    metrics/cluster:  # SINGLETON, one replica or cluster metrics duplicate per node\n      receivers: [k8s_cluster]\n      processors: [memory_limiter, batch]\n      exporters: [otlp_grpc]\n    logs/events:  # SINGLETON\n      receivers: [k8s_events]\n      processors: [memory_limiter, batch]\n      exporters: [otlp_grpc]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 20,
  }),
  Object.freeze({
    slug: "tail-sampling-keep-errors",
    name: "Tail Sampling: Keep Every Error",
    summary: "Buffers whole traces, keeps every trace with an error status or latency over one second, and samples 10% of the rest.",
    description: "Head sampling throws away traces before it knows whether they were interesting. This flow buffers spans until a trace is complete, then applies three OR'd policies: keep anything with an ERROR status, keep anything slower than a second, and take 10% of what remains. A decision cache remembers keep decisions so late-arriving spans aren't treated as a fresh trace and probabilistically dropped.\n\nThe spanmetrics connector is deliberately fed from the pre-sampling pipeline, so RED metrics are computed on 100% of traffic — moving it downstream of the sampler skews your error rate by exactly the sampling ratio. A forward connector replicates the unsampled stream into the sampling pipeline. Set `decision_wait` just above your longest expected trace duration; every in-flight span is held in memory for that window.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "metrics"]),
    tags: Object.freeze(["sampling", "cost", "traces"]),
    yaml_content: "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  # First processor in every pipeline so backpressure reaches the receiver\n  # before the collector OOMs. Also set GOMEMLIMIT to ~80% of limit_mib.\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 1536\n    spike_limit_mib: 384\n\n  tail_sampling:\n    # Every in-flight span is buffered for decision_wait. Set it just above\n    # your longest expected trace duration (default is 30s).\n    decision_wait: 10s\n    num_traces: 50000            # max traces held in memory at once\n    decision_cache:\n      # Remembers \"keep\" decisions so spans arriving after the decision are\n      # not treated as a new trace and probabilistically dropped.\n      sampled_cache_size: 100000\n    # Policies are OR'd: a trace matching any policy is kept whole.\n    policies:\n      - name: keep-all-errors\n        type: status_code\n        status_code:\n          status_codes: [ERROR]\n      - name: keep-slow-traces\n        type: latency\n        latency:\n          threshold_ms: 1000\n      - name: sample-10-percent-of-the-rest\n        type: probabilistic\n        probabilistic:\n          sampling_percentage: 10\n\n  # After tail_sampling per the batch README: batch after any data drops.\n  batch:\n    send_batch_size: 8192\n    timeout: 200ms\n\nconnectors:\n  # Fed from the pipeline BEFORE tail_sampling so RED metrics are computed\n  # on 100% of traffic. Moving it after the sampler skews your error rate.\n  spanmetrics:\n    histogram:\n      explicit:\n        buckets: [5ms, 25ms, 100ms, 250ms, 1s, 5s]\n    aggregation_cardinality_limit: 2000   # hard cap on metric series\n    metrics_flush_interval: 60s\n\n  # Replicates the pre-sampling trace stream into the sampling pipeline.\n  forward:\n\nexporters:\n  # 'otlp' was renamed 'otlp_grpc' in collector core v0.144.0.\n  # retry_on_failure and sending_queue are enabled by default.\n  otlp_grpc:\n    endpoint: ${env:TRACES_BACKEND_ENDPOINT}   # e.g. tempo.example.com:4317\n    tls:\n      insecure: false\n\n  prometheusremotewrite:\n    endpoint: ${env:PROM_REMOTE_WRITE_URL}   # e.g. https://mimir.example.com/api/v1/push\n\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter]\n      exporters: [spanmetrics, forward]\n    traces/sampled:\n      receivers: [forward]\n      processors: [tail_sampling, batch]\n      exporters: [otlp_grpc]\n    metrics/spanmetrics:\n      receivers: [spanmetrics]\n      processors: [batch]\n      exporters: [prometheusremotewrite]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 30,
  }),
  Object.freeze({
    slug: "metric-cardinality-firewall",
    name: "Metric Cardinality Firewall",
    summary: "Drops metrics nobody queries, deletes high-cardinality labels like pod UIDs and raw URL paths, then re-aggregates the affected series with sum so totals stay correct.",
    description: "Cardinality blowups are usually a handful of labels, not a handful of metrics. This flow cuts in three stages: a filter drops whole metric families you never query, a transform deletes the offending labels (pod UIDs, raw URL paths, and similar unbounded values), and `metricstransform` re-aggregates what's left with `sum` so removing a label doesn't leave you with several partial series reporting the same thing.\n\nOrder matters here — dropping a label without re-aggregating produces duplicate series that most backends will either reject or silently last-write-wins. The prometheus receiver is included so you can point this at exporters you already run and cut cardinality before it reaches remote write.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["metrics"]),
    tags: Object.freeze(["cost", "cardinality", "metrics"]),
    yaml_content: "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n  # Scrape the Prometheus exporters you already run; full scrape_config support.\n  prometheus:\n    config:\n      scrape_configs:\n        - job_name: existing-exporters\n          scrape_interval: 30s\n          static_configs:\n            - targets: [\"<EXPORTER_HOST:PORT>\"]\n\nprocessors:\n  # First processor so backpressure reaches the receivers instead of OOM.\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 512\n    spike_limit_mib: 128\n\n  # Stage 1: drop whole metrics nobody queries. Cheapest win: no series at all.\n  filter/unused:\n    error_mode: ignore\n    metrics:\n      metric:\n        # Go runtime internals exposed by every client_golang exporter\n        - 'IsMatch(name, \"^go_(gc|memstats|threads|goroutines).*\")'\n        # promhttp self-metrics from each scrape target\n        - 'IsMatch(name, \"^promhttp_.*\")'\n      datapoint:\n        # Datapoints for health-check routes\n        - 'attributes[\"http.route\"] != nil and IsMatch(attributes[\"http.route\"], \"^/(healthz|readyz|livez)\")'\n\n  # Stage 2: delete the labels that explode series counts.\n  # Deleting alone is NOT safe: formerly distinct series now collide.\n  # Stage 4 merges them, so these deletes are scoped to the same metrics\n  # stage 4 re-aggregates. Widen both together: every metric you strip\n  # labels from needs a matching aggregate_labels transform below.\n  transform/delete_labels:\n    error_mode: ignore\n    metric_statements:\n      - delete_key(datapoint.attributes, \"k8s.pod.uid\") where IsMatch(metric.name, \"^http\\\\.server\\\\..*\")\n      - delete_key(datapoint.attributes, \"container.id\") where IsMatch(metric.name, \"^http\\\\.server\\\\..*\")\n      - delete_key(datapoint.attributes, \"net.sock.peer.addr\") where IsMatch(metric.name, \"^http\\\\.server\\\\..*\")\n      # unbounded raw URLs; the bounded http.route label survives\n      - delete_key(datapoint.attributes, \"http.url\") where IsMatch(metric.name, \"^http\\\\.server\\\\..*\")\n      - delete_matching_keys(datapoint.attributes, \"^(request_id|trace_id|span_id)$\") where IsMatch(metric.name, \"^http\\\\.server\\\\..*\")\n\n  # Stage 3: empty keys = compact resources that became identical, so stage 4\n  # sees the collided datapoints under one resource.\n  groupbyattrs/compact:\n    keys: []\n\n  # Stage 4: re-aggregate every metric whose labels were deleted above.\n  # label_set lists the labels to KEEP; everything else is summed away,\n  # merging collided series into one correct total. Histograms support sum only.\n  metricstransform/reaggregate:\n    transforms:\n      - include: ^http\\.server\\..*\n        match_type: regexp\n        action: update\n        operations:\n          - action: aggregate_labels\n            label_set: [http.route, http.request.method, http.response.status_code]\n            aggregation_type: sum\n\n  # Optional: emit chatty cumulative sums/gauges once per 60s. Alpha + stateful;\n  # remove it if you run multiple collector replicas without sticky routing.\n  interval:\n    interval: 60s\n    pass_through:\n      gauge: false\n      summary: false\n\n  # After the memory_limiter and all data-dropping processors, as the batch\n  # README advises; putting it last before the exporter satisfies that.\n  batch:\n    send_batch_size: 8192\n    timeout: 200ms\n\nexporters:\n  prometheusremotewrite:\n    # Prometheus / Mimir / Thanos / VictoriaMetrics push endpoint\n    endpoint: ${env:PROMETHEUS_REMOTE_WRITE_ENDPOINT}\n    external_labels:\n      cluster: ${env:CLUSTER_NAME}\n    # This exporter has its own remote_write_queue; it does not use sending_queue.\n    remote_write_queue:\n      enabled: true\n      queue_size: 10000\n      num_consumers: 1  # with the EnableMultipleWorkers feature gate, >1 needs out-of-order support in the backend TSDB\n    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n      max_interval: 30s\n      max_elapsed_time: 300s\n\nservice:\n  pipelines:\n    metrics:\n      receivers: [otlp, prometheus]\n      processors:\n        - memory_limiter\n        - filter/unused\n        - transform/delete_labels\n        - groupbyattrs/compact\n        - metricstransform/reaggregate\n        - interval\n        - batch\n      exporters: [prometheusremotewrite]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 40,
  }),
  Object.freeze({
    slug: "host-fleet-monitoring",
    name: "Host Fleet Monitoring",
    summary: "Scrapes CPU, memory, load, disk, filesystem, and network metrics plus system and application logs on every VM.",
    description: "A baseline agent config for a fleet of VMs, meant to be rolled out unchanged over OpAMP and specialized with environment variables. hostmetrics covers CPU, memory, load, disk, network, and filesystem, with container and snap mount points excluded so you aren't paying for series about the overlay filesystem. The process scraper is present but commented out — it is per-PID, high cardinality, and needs elevated permissions, so it should be enabled deliberately with include filters.\n\nLogs come from two sources: filelog for application logs and journald for a named set of system units. `resourcedetection` runs env first so `OTEL_RESOURCE_ATTRIBUTES` can pin values that would otherwise be guessed, then falls through to system and the cloud detectors. The resource processor carries the fleet tags (environment, team, cost center) you'll want to templatize per host group before rollout.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["metrics", "logs"]),
    tags: Object.freeze(["hosts", "collection", "fleet"]),
    yaml_content: "# Host Fleet Monitoring: one config for every VM, rolled out over OpAMP.\n# Target: otelcol-contrib v0.146.0\n\nextensions:\n  health_check:\n    endpoint: localhost:13133      # liveness probe; leave check_collector_pipeline off (README: broken)\n  file_storage:\n    directory: /var/lib/otelcol/file_storage\n    create_directory: true         # extension fails to start if the directory is missing\n\nreceivers:\n  hostmetrics:\n    collection_interval: 60s\n    scrapers:\n      cpu:\n      memory:\n      load:\n      disk:\n      network:\n      filesystem:\n        exclude_mount_points:\n          mount_points: [\"^/var/lib/docker/.*\", \"^/run/.*\", \"^/snap/.*\"]\n          match_type: regexp\n        exclude_fs_types:\n          fs_types: [tmpfs, squashfs, overlay, autofs, devtmpfs]\n          match_type: strict\n      # process:                   # per-PID CPU/mem/disk series: high cardinality and needs\n      #                            # elevated permissions. Enable deliberately with include filters.\n\n  filelog:\n    include: [\"/var/log/app/*.log\"]   # application logs; set your paths\n    exclude: [\"/var/log/app/*.gz\"]\n    start_at: end\n    include_file_path: true\n    storage: file_storage             # checkpoint offsets across restarts\n\n  journald:                           # Linux-only; needs journalctl and journal read access\n    priority: info\n    units: [sshd, docker, containerd] # system units only; app logs come via filelog\n    storage: file_storage             # cursor survives restarts\n\nprocessors:\n  memory_limiter:                  # first in every pipeline so backpressure reaches receivers\n    check_interval: 1s\n    limit_mib: 400                 # pair with GOMEMLIMIT at ~80% of this value\n    spike_limit_mib: 100\n\n  resourcedetection:\n    detectors: [env, system, ec2, gcp, azure]  # first detector to set an attribute wins;\n    timeout: 2s                                # env first so OTEL_RESOURCE_ATTRIBUTES can pin values\n    override: false\n    system:\n      hostname_sources: [os]       # kernel hostname; the dns default can stall or mislabel VMs\n\n  resource:                        # fleet tags: templatize per host group before rollout\n    attributes:\n      - key: deployment.environment\n        value: ${env:DEPLOY_ENV}\n        action: upsert\n      - key: team\n        value: <YOUR_TEAM>\n        action: upsert\n      - key: cost.center\n        value: <YOUR_COST_CENTER>\n        action: upsert\n\n  batch: {}                        # defaults (8192 items / 200ms); keep last before the exporter\n\nexporters:\n  otlp_grpc:\n    endpoint: ${env:OTLP_ENDPOINT} # host:port of any OTLP backend or gateway collector\n    tls:\n      insecure: false\n    sending_queue:\n      sizer: items                 # predictable sizing vs the default \"requests\"\n      queue_size: 10000\n      storage: file_storage        # persistent queue: survives reboots and backend outages\n    retry_on_failure:\n      enabled: true                # defaults: 5s initial, 30s max, 300s max_elapsed\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    metrics:\n      receivers: [hostmetrics]\n      processors: [memory_limiter, resourcedetection, resource, batch]\n      exporters: [otlp_grpc]\n    logs:\n      receivers: [filelog, journald]\n      processors: [memory_limiter, resourcedetection, resource, batch]\n      exporters: [otlp_grpc]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 50,
  }),
  Object.freeze({
    slug: "dual-ship-migration-bridge",
    name: "Dual-Ship Migration Bridge",
    summary: "Accepts traffic from existing Datadog Agents and OTel SDKs, then exports every trace, metric, and log to both Datadog and any OTLP backend.",
    description: "The config you run while migrating off a proprietary agent. The datadog receiver accepts traffic from Datadog Agents that are already deployed — you re-point their `dd_url` at this collector rather than reinstrumenting anything — and the OTLP receiver takes traffic from services you have already moved. Everything then fans out to both backends so you can compare them on identical data before cutting over.\n\nMetrics split into two pipelines because Datadog expects delta temporality: only the Datadog path runs `cumulativetodelta`, so the new backend still receives the original cumulative series. Each exporter has its own queue and retry backed by file_storage, so an outage on one backend never blocks delivery to the other. The datadog receiver is an alpha component — replay recorded agent traffic through it before a fleet rollout.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["migration", "datadog", "dual-ship"]),
    yaml_content: "# Dual-Ship Migration Bridge\n# Fans the same telemetry out to Datadog (current backend) and any OTLP backend (new one).\n# Datadog Agents keep running: re-point their dd_url / apm dd_url at this collector.\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n    # Directory must exist and be writable by the collector before start.\n    directory: /var/lib/otelcol/file_storage\n\nreceivers:\n  datadog:\n    # Accepts existing Datadog Agent traffic (traces, metrics, logs).\n    # Alpha component: replay recorded agent traffic through this before fleet rollout.\n    endpoint: 0.0.0.0:8126\n    read_timeout: 60s\n  otlp:\n    # Entry point for services already re-instrumented with OTel SDKs.\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    # First in every pipeline so overload becomes backpressure, not an OOM kill.\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  # Normalize attribute names so both backends see the same data. The example maps\n  # the Datadog \"env\" tag onto semconv when it is present; extend for your tag scheme.\n  transform:\n    error_mode: ignore\n    trace_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    metric_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    log_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n\n  # Datadog counts are delta-based; convert cumulative OTLP series on the Datadog\n  # path only, so the new backend still receives the original cumulative data.\n  cumulativetodelta:\n    max_staleness: 1h  # forget idle series after 1h to bound state\n\n  batch:\n    # Last processor before export. Datadog trace intake rejects payloads over\n    # 3.2 MB with HTTP 413; lower these sizes if you see that error.\n    send_batch_size: 8192\n    send_batch_max_size: 8192\n    timeout: 200ms\n\nexporters:\n  datadog:\n    api:\n      key: ${env:DD_API_KEY}\n      site: datadoghq.com  # or datadoghq.eu, us3.datadoghq.com, ...\n    # Each exporter has its own queue and retry, so a Datadog outage\n    # never blocks delivery to the new backend (and vice versa).\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      queue_size: 1000\n      storage: file_storage  # persistent queue, survives restarts\n\n  otlp_http:\n    # Any OTLP/HTTP backend. For ClickStack, swap this for the clickhouse exporter.\n    # Note: renamed from `otlphttp` in collector v0.144.0; use the old id on older versions.\n    endpoint: ${env:NEW_BACKEND_OTLP_ENDPOINT}  # e.g. https://otlp.example.com:4318\n    headers:\n      Authorization: \"Bearer ${env:NEW_BACKEND_TOKEN}\"\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      queue_size: 1000\n      storage: file_storage\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    traces:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, otlp_http]\n    # Metrics split into two pipelines: only the Datadog copy is converted to delta.\n    metrics/datadog:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, cumulativetodelta, batch]\n      exporters: [datadog]\n    metrics/new_backend:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [otlp_http]\n    logs:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, otlp_http]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 60,
  }),
  Object.freeze({
    slug: "pii-redaction-gateway",
    name: "PII Redaction Gateway",
    summary: "Masks emails, card numbers, SSNs, bearer tokens, AWS keys, and IPs in log bodies and span attributes at a central gateway, before telemetry leaves your network.",
    description: "Redaction is a compliance control, so this flow is written for a central gateway tier that all egress telemetry transits — not for per-node agents, where the policy would be enforced in as many places as you have hosts and drift immediately.\n\nIt masks the usual categories (email addresses, card numbers, SSNs, bearer tokens, AWS access keys, IP addresses) across both log bodies and span attributes, combining OTTL replacement patterns with the redaction processor as a backstop for values that pattern-match but weren't anticipated. Review the patterns against your own data before trusting them: redaction that silently misses a field is worse than no redaction, because it reads as a control that passed.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["logs", "traces"]),
    tags: Object.freeze(["security", "compliance", "redaction"]),
    yaml_content: "# PII Redaction Gateway\n# Run this on a central gateway tier that all egress telemetry transits,\n# not on per-node agents: redaction is a compliance control and must be\n# enforced in one auditable place.\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  # First processor in every pipeline so backpressure reaches receivers\n  # (memory_limiter README best practice).\n  memory_limiter:\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  # Masks attribute values on spans and logs, and also scans log bodies\n  # (string and map) against blocked_values. transform/scrub_bodies below\n  # adds body-specific patterns and readable placeholders.\n  redaction:\n    allow_all_keys: true   # blocked-pattern mode; set false + allowed_keys for a strict allowlist\n    blocked_key_patterns:\n      - '(?i).*password.*'\n      - '(?i).*token.*'\n      - '(?i).*api_key.*'\n      - '(?i).*secret.*'\n      - '(?i)authorization'\n    blocked_values:\n      - '4[0-9]{12}(?:[0-9]{3})?'                          # Visa\n      - '5[1-5][0-9]{14}'                                  # Mastercard\n      - '\\b\\d{3}-\\d{2}-\\d{4}\\b'                            # US SSN\n      - 'AKIA[0-9A-Z]{16}'                                 # AWS access key id\n      - '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'   # email\n    summary: debug   # stamps redaction.* attributes (e.g. redaction.masked.count); handy in test runs, set silent in prod\n\n  # Scrubs string LOG BODIES with OTTL regexes: readable placeholders plus\n  # token/JWT/IP patterns that are not in redaction's blocked_values.\n  transform/scrub_bodies:\n    error_mode: ignore   # replace_pattern errors on map bodies; skip the statement, keep the record\n    log_statements:\n      - replace_pattern(log.body, \"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}\", \"***EMAIL***\")\n      - replace_pattern(log.body, \"(?i)bearer +[a-z0-9._\\\\-]+\", \"***TOKEN***\")\n      - replace_pattern(log.body, \"eyJ[A-Za-z0-9_-]{8,}\\\\.[A-Za-z0-9_-]+\\\\.[A-Za-z0-9_-]+\", \"***JWT***\")\n      - replace_pattern(log.body, \"AKIA[0-9A-Z]{16}\", \"***AWS_KEY***\")\n      # 13-16 digit runs incl. spaces/dashes; also matches order ids and ms timestamps. Test first.\n      - replace_pattern(log.body, \"\\\\b(?:\\\\d[ -]?){13,16}\\\\b\", \"***CARD***\")\n      - replace_pattern(log.body, \"\\\\b(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}\\\\b\", \"***IP***\")\n\n  # Hash (SHA-1) identifiers you still need for correlation; delete the rest.\n  attributes/pii:\n    actions:\n      - key: user.email\n        action: hash\n      - key: user.id\n        action: hash\n      - key: enduser.id\n        action: hash\n      - key: user.full_name\n        action: delete\n      - key: user.phone_number\n        action: delete\n\n  # Last before export, after all masking and drops (batch README).\n  batch:\n    send_batch_size: 8192\n    timeout: 200ms\n\nexporters:\n  otlp_grpc:   # renamed from `otlp` in core v0.144.0; old id is a deprecated alias\n    endpoint: ${env:OTLP_BACKEND_ENDPOINT}   # e.g. backend.example.com:4317\n    headers:\n      authorization: <YOUR_API_KEY>\n    sending_queue:\n      storage: file_storage   # persistent queue; survives gateway restarts\n    # retry_on_failure is enabled by default (5s initial, 30s max, 300s max elapsed)\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n    directory: /var/lib/otelcol/file_storage   # must exist and be writable by the collector\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, redaction, transform/scrub_bodies, attributes/pii, batch]\n      exporters: [otlp_grpc]\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, redaction, attributes/pii, batch]\n      exporters: [otlp_grpc]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 70,
  }),
  Object.freeze({
    slug: "outage-proof-pipeline",
    name: "Outage-Proof Pipeline",
    summary: "Replaces the default in-memory exporter queue with a disk-backed queue that survives collector restarts, sized in items instead of opaque requests.",
    description: "By default the collector's sending queue lives in memory and is sized in requests, which means a restart loses whatever was buffered and the queue size doesn't map to anything you can reason about. This flow points the queue at a file_storage extension so it survives restarts and OOM kills, sizes it in items so the number means something, and extends retry so a backend outage measured in minutes doesn't turn into dropped data.\n\nIt is not zero-loss, and the config says so: if the disk fills or the volume dies, the buffered data is gone. Size the volume against your throughput and outage tolerance before deploying this — a persistent queue with nowhere to persist is just a slower in-memory queue.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["reliability", "queueing", "resilience"]),
    yaml_content: "# Outage-Proof Pipeline: disk-backed exporter queue + never-expiring retries.\n# Survives backend outages, collector restarts, and OOM kills. Not zero-loss:\n# if the disk fills or the volume dies, data is lost. Size the volume first.\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  # First in every pipeline (per README) so refusal reaches the receiver and\n  # becomes backpressure to SDKs instead of an OOM kill. Pair with\n  # GOMEMLIMIT set to ~80% of limit_mib in the deployment env.\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 1600\n    spike_limit_mib: 400\n\n  # Last before export: fewer, larger requests in the persistent queue means\n  # fewer disk writes and fewer retry round-trips.\n  batch:\n    send_batch_size: 8192\n    timeout: 200ms\n\nexporters:\n  otlp_grpc:\n    endpoint: ${env:BACKEND_OTLP_ENDPOINT}   # e.g. otlp.vendor.example:4317\n    headers:\n      api-key: ${env:BACKEND_API_KEY}         # rename header to your vendor's\n    # tls: { insecure: true }                 # only for local/plaintext targets\n    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n      max_interval: 30s\n      max_elapsed_time: 0    # default 300s gives up after 5 min; 0 = retry until\n                             # delivered. The queue absorbs the backlog on disk.\n    sending_queue:\n      enabled: true\n      storage: file_storage  # replaces the in-memory queue entirely; queued\n                             # data survives restarts and OOM kills\n      sizer: items           # default 'requests' makes queue_size unpredictable\n                             # (a request can be 1 span or 10k); items = records\n      queue_size: 2000000    # ~2M spans/datapoints/records. Size it: sustained\n                             # items/sec x outage budget in seconds.\n      num_consumers: 10\n      block_on_overflow: true  # full queue blocks the pipeline (backpressure to\n                               # SDKs) instead of silently dropping new data\n\nextensions:\n  file_storage:\n    directory: /var/lib/otelcol/file_storage\n    create_directory: true   # dir must exist and be writable; on K8s mount a\n                             # PVC here (emptyDir defeats restart persistence)\n    timeout: 1s\n    compaction:\n      on_start: true         # bbolt never shrinks its file on its own; compact\n      on_rebound: true       # after drain or disk stays at high-water mark\n      directory: /var/lib/otelcol/file_storage\n\n  health_check:\n    endpoint: 0.0.0.0:13133\n    # do not use check_collector_pipeline: README marks it broken\n\nservice:\n  extensions: [file_storage, health_check]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlp_grpc]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlp_grpc]\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [otlp_grpc]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 80,
  }),
  Object.freeze({
    slug: "otel-to-clickstack",
    name: "OTel to ClickStack",
    summary: "The ClickStack (HyperDX) ingestion collector as upstream ships it: parses JSON log bodies into attributes, infers severity from level fields or the body text, and routes browser session-replay events to their own ClickHouse table.",
    description: "The collector configuration the ClickStack distribution runs, merged from HyperDX's base and standalone halves so it works on a stock contrib build. The `otlp/hyperdx` receiver takes all three signals over gRPC and HTTP with CORS open for the browser SDK, `memory_limiter` and a 10,000-item, 5-second `batch` shape inserts the way ClickHouse wants them, and the `clickhouse` exporter writes the `otel_*` tables HyperDX reads, creating them on first start.\n\nLogs are split by the `routing/logs` connector: records carrying an `rr-web.event` attribute (HyperDX session replay) go straight to a second `clickhouse/rrweb` exporter and the `hyperdx_sessions` table. Everything else runs through one `transform` processor that parses JSON bodies into attributes, fills `severity_text` and `severity_number` from whichever `level`/`severity` spelling a library used or from the first severity word in the body, and lowercases the result so HyperDX's severity filter matches.\n\nSet `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD`. The exporter timeout and the JSON column switch read the same `HYPERDX_OTEL_*` variables as upstream, with upstream's defaults, so a ClickStack `.env` drops in unchanged. Nothing here masks or drops data: put the PII Redaction Gateway flow in front of it if you need that.",
    source: "telflo",
    author_name: "ClickStack",
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["clickhouse", "parsing", "backend"]),
    yaml_content: "# OpenTelemetry Collector Configuration\n# Generated by Telflo\n\nreceivers:\n  otlp/hyperdx:\n    protocols:\n      grpc:\n        endpoint: '0.0.0.0:4317'\n        include_metadata: true\n      http:\n        cors:\n          allowed_headers:\n            - '*'\n          allowed_origins:\n            - '*'\n        endpoint: '0.0.0.0:4318'\n        include_metadata: true\nprocessors:\n  memory_limiter:\n    limit_mib: 1500\n    check_interval: '5s'\n    spike_limit_mib: 512\n  batch:\n    timeout: '5s'\n    send_batch_size: 10000\n    send_batch_max_size: 0\n  transform:\n    log_statements:\n      - context: 'log'\n        error_mode: 'ignore'\n        statements:\n          - 'set(log.cache, ExtractPatterns(log.body, \"(?P<0>(\\\\{.*\\\\}))\")) where IsString(log.body)'\n          - 'merge_maps(log.attributes, ParseJSON(log.cache[\"0\"]), \"upsert\") where IsMap(log.cache)'\n          - 'flatten(log.attributes) where IsMap(log.cache)'\n          - 'merge_maps(log.attributes, log.body, \"upsert\") where IsMap(log.body)'\n      - context: 'log'\n        conditions:\n          - 'severity_number == 0 and severity_text == \"\"'\n        error_mode: 'ignore'\n        statements:\n          - 'set(log.severity_text, log.attributes[\"level\"]) where log.severity_text == \"\" and IsString(log.attributes[\"level\"]) and Len(log.attributes[\"level\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"Level\"]) where log.severity_text == \"\" and IsString(log.attributes[\"Level\"]) and Len(log.attributes[\"Level\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"LEVEL\"]) where log.severity_text == \"\" and IsString(log.attributes[\"LEVEL\"]) and Len(log.attributes[\"LEVEL\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"severity\"]) where log.severity_text == \"\" and IsString(log.attributes[\"severity\"]) and Len(log.attributes[\"severity\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"Severity\"]) where log.severity_text == \"\" and IsString(log.attributes[\"Severity\"]) and Len(log.attributes[\"Severity\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"SEVERITY\"]) where log.severity_text == \"\" and IsString(log.attributes[\"SEVERITY\"]) and Len(log.attributes[\"SEVERITY\"]) > 0'\n          - 'set(log.severity_text, log.attributes[\"log.level\"]) where log.severity_text == \"\" and IsString(log.attributes[\"log.level\"]) and Len(log.attributes[\"log.level\"]) > 0'\n          - 'set(log.severity_number, SEVERITY_NUMBER_FATAL) where IsMatch(log.severity_text, \"(?i)(alert|crit|emerg|fatal)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_ERROR) where IsMatch(log.severity_text, \"(?i)(error|err)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_WARN) where IsMatch(log.severity_text, \"(?i)(warn|notice)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_INFO) where IsMatch(log.severity_text, \"(?i)(info)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_DEBUG) where IsMatch(log.severity_text, \"(?i)(debug|dbug)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_TRACE) where IsMatch(log.severity_text, \"(?i)(trace)\")'\n          - 'set(log.severity_number, SEVERITY_NUMBER_INFO) where log.severity_number == 0 and log.severity_text != \"\"'\n      - context: 'log'\n        conditions:\n          - 'severity_number == 0 and severity_text == \"\"'\n        error_mode: 'ignore'\n        statements:\n          - 'set(log.cache[\"substr\"], log.body.string) where Len(log.body.string) < 256'\n          - 'set(log.cache[\"substr\"], Substring(log.body.string, 0, 256)) where Len(log.body.string) >= 256'\n          - 'set(log.cache, ExtractPatterns(log.cache[\"substr\"], \"(?i)(?P<0>\\\\b(alert|crit|emerg|fatal|error|err|warn|notice|debug|dbug|trace))\"))'\n          - 'set(log.severity_number, SEVERITY_NUMBER_FATAL) where IsMatch(log.cache[\"0\"], \"(?i)(alert|crit|emerg|fatal)\")'\n          - 'set(log.severity_text, \"fatal\") where log.severity_number == SEVERITY_NUMBER_FATAL'\n          - 'set(log.severity_number, SEVERITY_NUMBER_ERROR) where IsMatch(log.cache[\"0\"], \"(?i)(error|err)\")'\n          - 'set(log.severity_text, \"error\") where log.severity_number == SEVERITY_NUMBER_ERROR'\n          - 'set(log.severity_number, SEVERITY_NUMBER_WARN) where IsMatch(log.cache[\"0\"], \"(?i)(warn|notice)\")'\n          - 'set(log.severity_text, \"warn\") where log.severity_number == SEVERITY_NUMBER_WARN'\n          - 'set(log.severity_number, SEVERITY_NUMBER_DEBUG) where IsMatch(log.cache[\"0\"], \"(?i)(debug|dbug)\")'\n          - 'set(log.severity_text, \"debug\") where log.severity_number == SEVERITY_NUMBER_DEBUG'\n          - 'set(log.severity_number, SEVERITY_NUMBER_TRACE) where IsMatch(log.cache[\"0\"], \"(?i)(trace)\")'\n          - 'set(log.severity_text, \"trace\") where log.severity_number == SEVERITY_NUMBER_TRACE'\n          - 'set(log.severity_text, \"info\") where log.severity_number == 0'\n          - 'set(log.severity_number, SEVERITY_NUMBER_INFO) where log.severity_number == 0'\n      - context: 'log'\n        error_mode: 'ignore'\n        statements:\n          - 'set(log.severity_text, ConvertCase(log.severity_text, \"lower\"))'\nexporters:\n  clickhouse:\n    ttl: '720h'\n    json: '${env:HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE:-false}'\n    timeout: '${env:HYPERDX_OTEL_EXPORTER_TIMEOUT:-5s}'\n    database: '${env:CLICKHOUSE_DATABASE}'\n    endpoint: '${env:CLICKHOUSE_ENDPOINT}'\n    password: '${env:CLICKHOUSE_PASSWORD}'\n    username: '${env:CLICKHOUSE_USER}'\n    create_schema: true\n    retry_on_failure:\n      enabled: true\n      max_interval: '30s'\n      initial_interval: '5s'\n      max_elapsed_time: '300s'\n  clickhouse/rrweb:\n    ttl: '720h'\n    json: '${env:HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE:-false}'\n    timeout: '${env:HYPERDX_OTEL_EXPORTER_TIMEOUT:-5s}'\n    database: '${env:CLICKHOUSE_DATABASE}'\n    endpoint: '${env:CLICKHOUSE_ENDPOINT}'\n    password: '${env:CLICKHOUSE_PASSWORD}'\n    username: '${env:CLICKHOUSE_USER}'\n    create_schema: true\n    logs_table_name: 'hyperdx_sessions'\n    retry_on_failure:\n      enabled: true\n      max_interval: '30s'\n      initial_interval: '5s'\n      max_elapsed_time: '300s'\nconnectors:\n  routing/logs:\n    table:\n      - context: 'log'\n        pipelines:\n          - 'logs/out-rrweb'\n        statement: 'route() where IsMatch(attributes[\"rr-web.event\"], \".*\")'\n    error_mode: 'ignore'\n    default_pipelines:\n      - 'logs/out-default'\nextensions:\n  health_check:\n    endpoint: ':13133'\nservice:\n  extensions: [health_check]\n  pipelines:\n    traces:\n      receivers: [otlp/hyperdx]\n      processors: [memory_limiter, batch]\n      exporters: [clickhouse]\n    metrics:\n      receivers: [otlp/hyperdx]\n      processors: [memory_limiter, batch]\n      exporters: [clickhouse]\n    logs/in:\n      receivers: [otlp/hyperdx]\n      exporters: [routing/logs]\n    logs/out-default:\n      receivers: [routing/logs]\n      processors: [memory_limiter, transform, batch]\n      exporters: [clickhouse]\n    logs/out-rrweb:\n      receivers: [routing/logs]\n      processors: [memory_limiter, batch]\n      exporters: [clickhouse/rrweb]\n  telemetry:\n    metrics:\n      readers:\n        - pull:\n            exporter:\n              prometheus:\n                host: '0.0.0.0'\n                port: 8888\n    logs:\n      level: 'info'\n      output_paths:\n        - 'stdout'\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: "https://github.com/hyperdxio/hyperdx/tree/main/docker/otel-collector",
    published: true,
    sort_order: 90,
  }),
  Object.freeze({
    slug: "llm-telemetry-gateway",
    name: "LLM Telemetry Gateway",
    summary: "Strips prompt and completion content from gen_ai span attributes, span events, and log events, across both gen_ai naming generations, with the redaction processor as a pattern backstop.",
    description: "LLM instrumentation captures prompts and completions by default, which means your traces contain whatever your users typed. This flow strips that content at a gateway before it reaches a vendor, covering all three places it hides: gen_ai span attributes, span events, and log events.\n\nIt handles both generations of the gen_ai semantic conventions, since instrumentation in the wild is split across them, and adds the redaction processor as a pattern backstop for content that ends up somewhere the explicit rules don't cover. Traces are split into an LLM pipeline and a regular APM pipeline so the redaction cost is only paid on the spans that need it.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "logs"]),
    tags: Object.freeze(["security", "genai", "redaction"]),
    yaml_content: "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317  # gateway role: accept OTLP from other pods/hosts\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:  # first processor so backpressure reaches receivers\n    check_interval: 1s\n    limit_mib: 1024\n    spike_limit_mib: 256\n\n  # Prompt/completion content hides in three places depending on the SDK:\n  # span attributes, span events, and log events. These statements cover all\n  # three, for both semconv generations (legacy gen_ai.prompt.* and the\n  # 1.37+ gen_ai.input.messages / gen_ai.output.messages attributes), plus\n  # the older message-event names Strands Agents records content under\n  # (gen_ai.user.message, gen_ai.assistant.message, gen_ai.choice).\n  transform/genai_scrub:\n    error_mode: ignore  # one malformed record must not drop the whole batch\n    trace_statements:\n      - delete_key(span.attributes, \"gen_ai.input.messages\")\n      - delete_key(span.attributes, \"gen_ai.output.messages\")\n      - delete_key(span.attributes, \"gen_ai.system_instructions\")\n      - delete_matching_keys(span.attributes, \"^gen_ai\\\\.(prompt|completion)(\\\\..*)?$\")\n      - delete_matching_keys(spanevent.attributes, \"^gen_ai\\\\.(prompt|completion|input\\\\.messages|output\\\\.messages|user\\\\.message|assistant\\\\.message|choice)(\\\\..*)?$\")\n    log_statements:\n      - set(log.body, \"content removed by collector\") where log.event_name != \"\" and IsMatch(log.event_name, \"^gen_ai\\\\.\")\n      - set(log.body, \"content removed by collector\") where log.attributes[\"event.name\"] != nil and IsMatch(log.attributes[\"event.name\"], \"^gen_ai\\\\.\")\n      - delete_matching_keys(log.attributes, \"^gen_ai\\\\.(prompt|completion|input\\\\.messages|output\\\\.messages)(\\\\..*)?$\")\n\n  # Backstop behind the transform: masks values if a content-bearing key\n  # survives. Redaction covers span, span event, and log attributes (span\n  # event attributes since contrib v0.121.0) but never log bodies, so the\n  # transform's log_statements above are the only scrub for log-event bodies.\n  redaction:\n    allow_all_keys: true  # keep normal APM attributes; block by pattern only\n    blocked_key_patterns:\n      - ^gen_ai\\.(input|output)\\.messages$\n      - ^gen_ai\\.(prompt|completion)(\\..*)?$\n      - ^gen_ai\\.system_instructions$\n      - ^gen_ai\\.(user|assistant)\\.message$\n      - ^gen_ai\\.choice$\n    summary: info\n\n  batch:  # last before export, after all drops and rewrites\n    send_batch_size: 8192\n    timeout: 200ms\n\nconnectors:\n  # action: copy sends gen_ai spans to the LLM pipeline AND lets every span\n  # fall through to default_pipelines, so APM traces stay complete.\n  routing:\n    error_mode: ignore\n    default_pipelines: [traces/apm]\n    table:\n      - context: span\n        condition: attributes[\"gen_ai.operation.name\"] != nil or attributes[\"gen_ai.provider.name\"] != nil or attributes[\"gen_ai.system\"] != nil\n        action: copy\n        pipelines: [traces/llm]\n\nexporters:\n  otlp_http/langfuse:  # Langfuse ingests OTLP over HTTP only, no gRPC\n    endpoint: https://cloud.langfuse.com/api/public/otel\n    headers:\n      # base64 of <public_key>:<secret_key>: echo -n \"pk-lf-...:sk-lf-...\" | base64\n      Authorization: Basic ${env:LANGFUSE_BASIC_AUTH}\n      x-langfuse-ingestion-version: \"4\"  # avoids delayed visibility on Langfuse v4\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      enabled: true\n      sizer: items  # more predictable than the default request-based sizing\n      queue_size: 10000\n\n  otlp_grpc/apm:\n    endpoint: ${env:APM_OTLP_ENDPOINT}  # e.g. apm-gateway.internal:4317\n    tls:\n      insecure: false\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      enabled: true\n      sizer: items\n      queue_size: 10000\n\nservice:\n  pipelines:\n    traces/in:\n      receivers: [otlp]\n      processors: [memory_limiter, transform/genai_scrub, redaction]\n      exporters: [routing]\n    traces/llm:\n      receivers: [routing]\n      processors: [batch]\n      exporters: [otlp_http/langfuse]\n    traces/apm:\n      receivers: [routing]\n      processors: [batch]\n      exporters: [otlp_grpc/apm]\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, transform/genai_scrub, redaction, batch]\n      exporters: [otlp_grpc/apm]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 100,
  }),
  Object.freeze({
    slug: "datadog-to-elastic-migration-bridge",
    name: "Datadog to Elastic Migration Bridge",
    summary: "Accepts traffic from existing Datadog Agents and OTel SDKs, then exports every trace, metric, and log to both Datadog and the Elastic Cloud managed OTLP endpoint.",
    description: "The config you run while moving from Datadog to Elastic Observability. The datadog receiver accepts traffic from Datadog Agents that are already deployed — re-point their `dd_url`, `apm_config.apm_dd_url`, and `logs_config.logs_dd_url` (forced onto HTTP transport) at this collector rather than reinstrumenting anything — and the OTLP receiver takes traffic from services you have already moved. Everything then fans out to both Datadog and Elastic's managed OTLP endpoint, so you can compare the two on identical data before cutting over.\n\nMetrics split into two pipelines because Datadog expects delta temporality: only the Datadog path runs `cumulativetodelta`, so Elastic receives the original cumulative series (Serverless, or Hosted on stack 9.5+ — on 9.0–9.4, convert the Elastic copy too). Each exporter has its own file_storage-backed queue, so an outage on one backend never blocks delivery to the other, though the datadog exporter retries logs only — a long Datadog outage can drop queued traces and metrics. The datadog receiver is an alpha component with no validate route: re-pointed agents log API-key errors while data still flows, and Live Process, NPM, and orchestrator traffic has no intake here — replay recorded agent traffic through it before a fleet rollout.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["migration", "datadog", "elastic", "dual-ship"]),
    yaml_content: "# Datadog to Elastic Migration Bridge\n# Fans the same telemetry out to Datadog (current backend) and the Elastic Cloud\n# managed OTLP endpoint (new one). Datadog Agents keep running: re-point their\n# dd_url / apm dd_url / logs_dd_url at this collector.\n\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n    # create_directory lets the collector make this itself on first start;\n    # without it the collector refuses to boot when the path is absent.\n    create_directory: true\n    directory: /var/lib/otelcol/file_storage\n\nreceivers:\n  datadog:\n    # Accepts existing Datadog Agent traffic (traces, metrics, logs).\n    # Alpha component: replay recorded agent traffic through this before fleet\n    # rollout. It has no /api/v1/validate route, so re-pointed agents log\n    # API-key errors while data still flows, and there is no intake for Live\n    # Process, NPM, or orchestrator traffic - leave those pointed at Datadog.\n    # Agent logs must use HTTP transport (logs_config.force_use_http: true).\n    endpoint: 0.0.0.0:8126\n    read_timeout: 60s\n  otlp:\n    # Entry point for services already re-instrumented with OTel SDKs.\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    # First in every pipeline so overload becomes backpressure, not an OOM kill.\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  # Normalize attribute names so both backends see the same data. The example\n  # maps the Datadog \"env\" tag onto semconv when it is present; extend for your\n  # tag scheme. Elastic stores attributes OTel-natively, so nothing else is\n  # required; set data_stream.dataset / data_stream.namespace resource\n  # attributes here only to steer Elastic data-stream routing away from the\n  # *-generic.otel-default streams.\n  transform:\n    error_mode: ignore\n    trace_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    metric_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    log_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n\n  # Datadog counts are delta-based; convert cumulative OTLP series on the\n  # Datadog path only. The Elastic managed endpoint accepts both temporalities\n  # on Serverless and on Hosted stack 9.5+, so it keeps the original cumulative\n  # series; on Hosted 9.0-9.4, add this processor to metrics/elastic too.\n  cumulativetodelta:\n    max_staleness: 1h  # forget idle series after 1h to bound state\n\n  batch:\n    # Last processor before export. Datadog trace intake rejects payloads over\n    # 3.2 MB with HTTP 413, and the Elastic managed endpoint rejects requests\n    # over ~4 MB uncompressed; lower these sizes if you see either error.\n    send_batch_size: 8192\n    send_batch_max_size: 8192\n    timeout: 200ms\n\nexporters:\n  datadog:\n    api:\n      key: ${env:DD_API_KEY}\n      site: ${env:DD_SITE}  # datadoghq.com, datadoghq.eu, us3.datadoghq.com, ...\n    # Each exporter has its own file_storage-backed queue, so an outage on one\n    # backend never blocks delivery to the other until that queue fills. Note:\n    # at this version the datadog exporter retries logs only - traces and\n    # metrics are attempted once each, so a long Datadog outage can drop them.\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      queue_size: 1000\n      storage: file_storage  # persistent queue, survives restarts\n\n  otlp_http:\n    # Elastic Cloud managed OTLP endpoint: OTLP/HTTP with protobuf payload,\n    # port 443. The URL is in the Cloud console under \"Managed OTLP\" (Hosted\n    # 9.0+) or \"OpenTelemetry\" (Serverless).\n    # Self-managed Elasticsearch instead? Swap this for the `elasticsearch`\n    # exporter (otel mapping mode), route metrics/elastic through\n    # cumulativetodelta as well, and drop `batch` from that pipeline - the\n    # exporter batches internally, and split metric batches cause TSDB version\n    # conflicts. Its metrics support is development-stability at this collector\n    # version, so treat that path as logs-and-traces-first.\n    # Note: renamed from `otlphttp` in core v0.144.0; use the old id on older versions.\n    endpoint: ${env:ELASTIC_OTLP_ENDPOINT}  # e.g. https://<project>.ingest.us-east-1.aws.elastic.cloud:443\n    headers:\n      Authorization: \"ApiKey ${env:ELASTIC_API_KEY}\"  # Elasticsearch API key, encoded form\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      queue_size: 1000\n      storage: file_storage\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    traces:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, otlp_http]\n    # Metrics split into two pipelines: only the Datadog copy is converted to\n    # delta; Elastic receives the original cumulative series.\n    metrics/datadog:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, cumulativetodelta, batch]\n      exporters: [datadog]\n    metrics/elastic:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [otlp_http]\n    logs:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, otlp_http]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 145,
  }),
  Object.freeze({
    slug: "datadog-to-clickstack-migration-bridge",
    name: "Datadog to ClickStack Migration Bridge",
    summary: "Accepts traffic from existing Datadog Agents and OTel SDKs, then exports every trace, metric, and log to both Datadog and the ClickHouse Cloud service that ClickStack Managed reads.",
    description: "The config you run while moving from Datadog to ClickStack Managed. The datadog receiver takes traffic from the Datadog Agents you already have: re-point each agent's `dd_url`, `apm_config.apm_dd_url`, and `logs_config.logs_dd_url` at this collector and force logs onto HTTP. The otlp receiver takes services already on OTel SDKs. Everything fans out to both Datadog and ClickStack, so you can compare the two on the same data before you cut over.\n\nClickStack Managed has no ingestion endpoint of its own, so the ClickStack leg is the clickhouse exporter writing straight to your Cloud service, into the otel_* tables HyperDX reads. Set CLICKHOUSE_ENDPOINT, CLICKHOUSE_DATABASE, CLICKHOUSE_USER, and CLICKHOUSE_PASSWORD, the same variables the Ship OTel data to ClickHouse flow uses. Each exporter keeps its own disk-backed queue, so a Datadog outage never blocks ClickStack, and the other way around. The datadog receiver is alpha: replay recorded agent traffic through it before a fleet rollout, and migrate metrics last, which is also what ClickHouse's migration guide says. Deleting the datadog exporter finishes the cutover.",
    source: "telflo",
    author_name: null,
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["migration", "datadog", "clickstack", "dual-ship"]),
    yaml_content: "extensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n    create_directory: true\n    directory: /var/lib/otelcol/file_storage\n\nreceivers:\n  datadog:\n    endpoint: 0.0.0.0:8126\n    read_timeout: 60s\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\n\nprocessors:\n  memory_limiter:\n    check_interval: 1s\n    limit_percentage: 80\n    spike_limit_percentage: 20\n\n  transform:\n    error_mode: ignore\n    trace_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    metric_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n    log_statements:\n      - set(resource.attributes[\"deployment.environment.name\"], resource.attributes[\"env\"]) where resource.attributes[\"deployment.environment.name\"] == nil and resource.attributes[\"env\"] != nil\n\n  batch:\n    send_batch_size: 10000\n    send_batch_max_size: 10000\n    timeout: 5s\n\nexporters:\n  datadog:\n    api:\n      key: ${env:DD_API_KEY}\n      site: ${env:DD_SITE}\n    retry_on_failure:\n      enabled: true\n    sending_queue:\n      queue_size: 1000\n      storage: file_storage\n\n  clickhouse:\n    endpoint: ${env:CLICKHOUSE_ENDPOINT}\n    database: ${env:CLICKHOUSE_DATABASE}\n    username: ${env:CLICKHOUSE_USER}\n    password: ${env:CLICKHOUSE_PASSWORD}\n    ttl: 720h\n    timeout: 5s\n    compress: lz4\n    async_insert: true\n    create_schema: true\n    retry_on_failure:\n      enabled: true\n      initial_interval: 5s\n      max_interval: 30s\n      max_elapsed_time: 300s\n    sending_queue:\n      enabled: true\n      sizer: items\n      queue_size: 100000\n      num_consumers: 2\n      storage: file_storage\n\nservice:\n  extensions: [health_check, file_storage]\n  pipelines:\n    traces:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, clickhouse]\n    metrics:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, clickhouse]\n    logs:\n      receivers: [datadog, otlp]\n      processors: [memory_limiter, transform, batch]\n      exporters: [datadog, clickhouse]\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.162.0",
    source_url: null,
    published: true,
    sort_order: 150,
  }),
  Object.freeze({
    slug: "clickhouse-failover-gateway-s3-overflow",
    name: "ClickHouse failover gateway (S3 overflow)",
    summary: "Fails over from ClickHouse to an S3 overflow bucket per signal when inserts back up, then fails back on its own once ClickHouse recovers.",
    description: "The gateway design from ClickHouse's own LogHouse pipeline: ClickHouse stays in the hot path, S3 is a release valve that only opens under backpressure, and a separate catch-up collector replays the overflow from SQS notifications so live traffic never waits behind backlog.\n\nPer signal, a `failover` connector routes to `<signal>/clickhouse` first and `<signal>/s3` second. The queue placement is the whole trick: the connector owns the sending queue, the ClickHouse exporter has no queue but inline retries, and the S3 exporters queue and retry forever so S3 hiccups never look like a second outage.\n\nSet the `CLICKHOUSE_*` variables, `AWS_REGION` and `OVERFLOW_S3_BUCKET`, and create the bucket with an event notification and SQS queue per prefix. The catch-up collector is a separate deployment and not part of this flow.",
    source: "telflo",
    author_name: "ClickStack",
    author_url: null,
    signals: Object.freeze(["traces", "metrics", "logs"]),
    tags: Object.freeze(["clickstack", "gateway", "logs", "trace", "metrics", "s3", "failover"]),
    yaml_content: "# OpenTelemetry Collector Configuration\n# Generated by Telflo\n\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: '0.0.0.0:4317'\n      http:\n        endpoint: '0.0.0.0:4318'\nprocessors:\n  memory_limiter:\n    limit_mib: 1500\n    spike_limit_mib: 512\n    check_interval: '1s'\n  batch:\n    send_batch_size: 10000\n    send_batch_max_size: 0\n    timeout: '5s'\nexporters:\n  clickhouse:\n    endpoint: '${env:CLICKHOUSE_ENDPOINT}'\n    database: '${env:CLICKHOUSE_DATABASE}'\n    username: '${env:CLICKHOUSE_USER}'\n    password: '${env:CLICKHOUSE_PASSWORD}'\n    ttl: '720h'\n    timeout: '5s'\n    create_schema: false\n    connection_params:\n      async_insert: '1'\n      wait_for_async_insert: '1'\n    sending_queue:\n      enabled: false\n    retry_on_failure:\n      enabled: true\n      initial_interval: '5s'\n      max_interval: '30s'\n      max_elapsed_time: '300s'\n  awss3/logs:\n    s3uploader:\n      region: '${env:AWS_REGION}'\n      s3_bucket: '${env:OVERFLOW_S3_BUCKET}'\n      s3_base_prefix: 'logs'\n    marshaler: 'otlp_proto'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\n    retry_on_failure:\n      enabled: true\n      initial_interval: '1s'\n      max_interval: '30s'\n      max_elapsed_time: 0\n  awss3/traces:\n    s3uploader:\n      region: '${env:AWS_REGION}'\n      s3_bucket: '${env:OVERFLOW_S3_BUCKET}'\n      s3_base_prefix: 'traces'\n    marshaler: 'otlp_proto'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\n    retry_on_failure:\n      enabled: true\n      initial_interval: '1s'\n      max_interval: '30s'\n      max_elapsed_time: 0\n  awss3/metrics:\n    s3uploader:\n      region: '${env:AWS_REGION}'\n      s3_bucket: '${env:OVERFLOW_S3_BUCKET}'\n      s3_base_prefix: 'metrics'\n    marshaler: 'otlp_proto'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\n    retry_on_failure:\n      enabled: true\n      initial_interval: '1s'\n      max_interval: '30s'\n      max_elapsed_time: 0\nconnectors:\n  failover/logs:\n    priority_levels:\n      - - 'logs/clickhouse'\n      - - 'logs/s3'\n    retry_interval: '30s'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\n  failover/traces:\n    priority_levels:\n      - - 'traces/clickhouse'\n      - - 'traces/s3'\n    retry_interval: '30s'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\n  failover/metrics:\n    priority_levels:\n      - - 'metrics/clickhouse'\n      - - 'metrics/s3'\n    retry_interval: '30s'\n    sending_queue:\n      enabled: true\n      queue_size: 10000\nextensions:\n  health_check:\n    endpoint: '0.0.0.0:13133'\nservice:\n  extensions: [health_check]\n  pipelines:\n    logs:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [failover/logs]\n    logs/clickhouse:\n      receivers: [failover/logs]\n      exporters: [clickhouse]\n    logs/s3:\n      receivers: [failover/logs]\n      exporters: [awss3/logs]\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [failover/traces]\n    traces/clickhouse:\n      receivers: [failover/traces]\n      exporters: [clickhouse]\n    traces/s3:\n      receivers: [failover/traces]\n      exporters: [awss3/traces]\n    metrics:\n      receivers: [otlp]\n      processors: [memory_limiter, batch]\n      exporters: [failover/metrics]\n    metrics/clickhouse:\n      receivers: [failover/metrics]\n      exporters: [clickhouse]\n    metrics/s3:\n      receivers: [failover/metrics]\n      exporters: [awss3/metrics]\n  telemetry:\n    metrics:\n      readers:\n        - pull:\n            exporter:\n              prometheus:\n                host: '0.0.0.0'\n                port: 8888\n    logs:\n      level: 'info'\n      output_paths:\n        - 'stdout'\n",
    collector_distribution: "otelcol-contrib",
    collector_version: "0.159.0",
    source_url: "https://clickhouse.com/blog/reliable-opentelemetry-ingestion-at-scale",
    published: true,
    sort_order: 160,
  }),
]);

/** The dollar-quoting tag every seeded text is written between. */
const textTag = "$seeded_flow$";

/** The columns `flowsInsert` writes, in its order. */
const insertColumns = [
  "slug",
  "name",
  "summary",
  "description",
  "source",
  "author_name",
  "author_url",
  "signals",
  "tags",
  "yaml_content",
  "collector_distribution",
  "collector_version",
  "source_url",
  "published",
  "sort_order",
];

/**
 * `value` dollar-quoted. Refuses a text the tag would end early: one that
 * holds the tag, or ends with all of it but its last `$` (the tag's closing
 * `$` would then complete it one character early).
 */
function quotedText(value) {
  if (typeof value !== "string") throw new Error(`a seeded flow's text must be a string, not ${typeof value}`);
  if ((value + textTag).indexOf(textTag) !== value.length) {
    throw new Error(`a seeded flow's text holds the quoting tag ${textTag}`);
  }
  return `${textTag}${value}${textTag}`;
}

/** One column's value as SQL. */
function sqlValue(column, value) {
  if (value === null) return "null";
  if (column === "signals" || column === "tags") {
    if (!Array.isArray(value)) throw new Error(`a seeded flow's ${column} must be a list`);
    return `array[${value.map(quotedText).join(", ")}]::text[]`;
  }
  if (column === "published") {
    if (typeof value !== "boolean") throw new Error("a seeded flow's published must be a boolean");
    return String(value);
  }
  if (column === "sort_order") {
    if (!Number.isInteger(value)) throw new Error("a seeded flow's sort_order must be an integer");
    return String(value);
  }
  return quotedText(value);
}

/**
 * The insert of `flows`, on conflict (slug) do nothing, so a second run
 * inserts no flow that is there and changes none: an admin's edit stands. A
 * deleted one comes back. created_at and updated_at are the transaction's
 * time to the millisecond.
 */
export function flowsInsert(flows) {
  const rows = flows.map(
    (flow) =>
      `  (${insertColumns.map((column) => sqlValue(column, flow[column])).join(", ")}, ` +
      "date_trunc('milliseconds', now()), date_trunc('milliseconds', now()))",
  );
  return (
    `insert into flows\n  (${insertColumns.join(", ")}, created_at, updated_at)\nvalues\n` +
    `${rows.join(",\n")}\non conflict (slug) do nothing`
  );
}

/** The seeded flows' insert, as up runs it. */
export const seededFlowsInsert = () => flowsInsert(seededFlows);

export const up = (pgm) => {
  pgm.sql(`
    create table flows (
      id                      uuid         primary key default uuidv7(),
      slug                    text         not null,
      name                    text         not null,
      summary                 text         not null,
      description             text         not null,
      source                  text         not null,
      author_name             text,
      author_url              text,
      signals                 text[]       not null default '{}',
      tags                    text[]       not null default '{}',
      yaml_content            text         not null,
      collector_distribution  text         not null,
      collector_version       text         not null,
      source_url              text,
      published               boolean      not null default true,
      sort_order              integer      not null default 0,
      created_at              timestamptz  not null,
      updated_at              timestamptz  not null,
      constraint uq_flows_slug unique (slug),
      constraint ck_flows_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      constraint ck_flows_slug_length check (char_length(slug) <= 80),
      constraint ck_flows_source check (source in ('telflo', 'community')),
      constraint ck_flows_source_url_scheme check (source_url is null or source_url ~ '^https?://'),
      constraint ck_flows_collector_version_present check (btrim(collector_version) <> ''),
      constraint fk_flows_collector_distribution
        foreign key (collector_distribution) references collector_distributions (id)
    );

    comment on table flows is
      'prebuilt collector configurations, each solving one problem: one row
       per flow, no history, an edit overwrites it and a delete removes it
       for good. Global: no organization column, no row-level security.
       Anyone reads the published ones through the API; only a product admin
       (users.is_product_admin) writes them, which the API decides. Seeded
       with 13 flows by migration 1700000000026.';
    comment on column flows.id is
      'the flow''s id, which the admin''s writes address: its slug may
       change.';
    comment on column flows.slug is
      'the public URL segment (/flows/<slug>, /app/flows/<slug>) and the
       flow''s stable identity: kebab-case, at most 80 characters, unique.
       A configuration created from it records it (source_flow_slug).';
    comment on column flows.name is
      'the flow''s title on its card and page.';
    comment on column flows.summary is
      'the one-line card copy the gallery and the showcase show.';
    comment on column flows.description is
      'the flow page''s long text, shown as plain paragraphs.';
    comment on column flows.source is
      'telflo, authored by product admins and badged Built by Telflo, or
       community, reserved for user-submitted flows, which are not built.';
    comment on column flows.author_name is
      'who the flow credits (ClickStack), or null for Telflo.';
    comment on column flows.author_url is
      'a link for the author, or null.';
    comment on column flows.signals is
      'the telemetry signals it handles (traces, metrics, logs): the
       gallery''s and the library''s filter.';
    comment on column flows.tags is
      'its categories, shown on its card and filtered by.';
    comment on column flows.yaml_content is
      'the collector configuration a configuration created from the flow
       starts with, copied byte for byte. Public content:
       anyone reads a published flow''s.';
    comment on column flows.collector_distribution is
      'the distribution a configuration created from it is built for, a
       distribution of the catalog (fk_flows_collector_distribution).
       No default: the API always writes it.';
    comment on column flows.collector_version is
      'the collector version the flow was checked against, and the pin a
       configuration created from it starts on. No foreign
       key: the API refuses a version the distribution
       doesn''t offer on every write, and a pin deprecated since stays and is
       read.';
    comment on column flows.source_url is
      'an http(s) link to where the configuration lives elsewhere, shown as
       View source on its page, or null for none.';
    comment on column flows.published is
      'false hides the flow from everyone but product admins: the library,
       the showcase, the sitemap, the gallery and the picker. True when
       created.';
    comment on column flows.sort_order is
      'the gallery''s order, ascending, the name breaking ties.';
    comment on column flows.created_at is
      'written by the API from its clock, never now(), so that it holds whole
       milliseconds as a JavaScript Date does (migration 015''s rule). No
       default, so a write that forgets the clock fails. The seeded flows''
       is the migration''s time to the millisecond.';
    comment on column flows.updated_at is
      'written by the API from its clock on create and on every change; the
       sitemap''s lastmod. No default, as created_at.';
    comment on constraint flows_pkey on flows is
      'one row per flow, by its id, which the admin''s writes address.';
    comment on constraint uq_flows_slug on flows is
      'a slug names one flow: /flows/<slug> resolves to exactly one row.
       The seed''s on conflict target.';
    comment on constraint ck_flows_slug_format on flows is
      'lowercase letters and digits in words joined by single
       hyphens, so the slug is a URL segment as it is.';
    comment on constraint ck_flows_slug_length on flows is
      'at most 80 characters, the API''s limit.';
    comment on constraint ck_flows_source on flows is
      'the two sources: telflo or community.';
    comment on constraint ck_flows_source_url_scheme on flows is
      'the link is rendered into an href on a public page, so
       a javascript: or data: URL would be stored XSS. Only http(s).';
    comment on constraint ck_flows_collector_version_present on flows is
      'a blank pin would create a configuration pinned to no collector
       version at all (the check also refuses only whitespace).';
    comment on constraint fk_flows_collector_distribution on flows is
      'a flow is built for a distribution of the catalog (23503 otherwise),
       so none names one the platform doesn''t offer. Distributions are never
       deleted, so nothing cascades.';

    create index idx_flows_sort_order_name on flows (sort_order, name);

    comment on index idx_flows_sort_order_name is
      'the gallery''s order (sort_order, then name), which every list reads.';

    alter table users add column is_product_admin boolean not null default false;

    comment on column users.is_product_admin is
      'a product admin: writes the flows and reaches
       /product-admin. False by default; set and cleared only by an
       operator''s SQL as the tables'' owner (users_product_admin_owner_only),
       and read on every request, so a revocation takes effect at once.';

    -- Not SECURITY DEFINER: it must see the role that runs the write, as
    -- current_user. A fixed search_path all the same, as migration 022's
    -- trigger function has. 42501 (insufficient_privilege): the refusal is
    -- one of privilege, as a missing grant's would be.
    create function refuse_product_admin_change() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if (tg_op = 'INSERT' and new.is_product_admin)
         or (tg_op = 'UPDATE' and new.is_product_admin is distinct from old.is_product_admin)
      then
        if not pg_has_role(current_user, (select c.relowner from pg_class c where c.oid = tg_relid), 'MEMBER') then
          raise exception 'only the tables'' owner sets or clears the product-admin flag of user %', new.id
            using errcode = 'insufficient_privilege';
        end if;
      end if;
      return new;
    end;
    $$;

    create trigger users_product_admin_owner_only
      before insert or update on users
      for each row execute function refuse_product_admin_change();

    comment on function refuse_product_admin_change() is
      'only the tables'' owner grants or revokes product admin, kept by the
       database and not just the API.
       Refuses an insert with is_product_admin true, and an update that
       changes it, unless current_user is a member of the users table''s
       owner, raising 42501 with a message naming only the user''s id. A
       write that leaves the flag as it is passes, whoever runs it. Not
       SECURITY DEFINER: it must see the role that runs the write.';
    comment on trigger users_product_admin_owner_only on users is
      'before insert or update, every row, for every role: the API''s role
       is refused any change of is_product_admin, the tables'' owner (the
       operator''s SQL) allowed. Only an operator can bypass it: the owner
       with ALTER TABLE … DISABLE TRIGGER, a superuser with
       session_replication_role = replica.';

    alter table configurations add column source_flow_slug text;

    comment on column configurations.source_flow_slug is
      'the slug of the flow the configuration was created from, or null for
       one created blank. No foreign key and no check: a flow
       may be deleted, and the configuration keeps its copy; a slug no flow
       has is a retired flow, not a broken reference. The API checks its
       format on create and returns it nowhere.';
  `);
  pgm.sql(seededFlowsInsert());
};

export const down = (pgm) => {
  pgm.sql(`
    alter table configurations drop column source_flow_slug;

    drop trigger users_product_admin_owner_only on users;
    drop function refuse_product_admin_change();
    alter table users drop column is_product_admin;

    drop table flows;
  `);
};
