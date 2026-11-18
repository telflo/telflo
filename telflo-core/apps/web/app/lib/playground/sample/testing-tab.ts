import {
  TestRunSummarySchema,
  type TestDefinition,
  type TestFile,
  type TestRunCompatibilityIssue,
  type TestRunDetail,
  type TestRunFile,
  type TestRunMutation,
  type TestRunSignal,
  type TestRunSummary,
  type TestSuite,
  type TestTemplate,
  type ValidationPipeline,
  type ValidationRule,
  type ValidationRuleOttl,
  type ValidationRuleResult,
  type ValidationRuleSnapshot,
} from "@telflo/contracts";
import type { TestingReads } from "~/lib/workspace-reads.js";
import { SAMPLE_CONFIGURATION_IDS, sampleConfigurations, type SampleConfigurationKey } from "./configurations.js";
import {
  clockAt,
  DAY,
  HOUR,
  SAMPLE_DISTRIBUTION,
  SAMPLE_SECURITY,
  SAMPLE_SRE,
  SAMPLE_VISITOR,
  sampleNotFound,
  type SampleClock,
} from "./types.js";

/*
 * The sample's Testing tab (D31-1 decisions 10, 12 and 31; Preflight rulings
 * 6 and 8): the sample input library (six templates), and per
 * configuration its test runs (their summaries, details and files), its
 * validation pipelines and rules (D15a's "seeded rules") and its suites and
 * definitions, in the platform's shapes, rebuilt on every call with times
 * relative to now. Everything is the open draft's (the playground editor
 * opens only that version); the tenth configuration, freshly imported, has
 * none, and so does any configuration the sample holds no testing for (the
 * blank playground editor's): its lists are empty.
 *
 * Ids are fixed lowercase v4-shaped UUIDs; a run's collector version is its
 * configuration's pin; the gateway's validation pipeline is its logs
 * pipeline, which its runs and rules test; a run's rules are the snapshot
 * it took of its pipeline's, matched to its results by the rules' own ids;
 * statuses are the platform's (succeeded, validation_failed and failed);
 * every run was fed a template, whose bytes (a small OTLP/JSON document
 * each) are the run's input and decoded input, with an output per run, so
 * a run's input and output open (Ruling 280). The visitor has no files of
 * their own. OTLP ids are left out of the documents, so nothing in them is
 * shaped like a secret (sample.test.ts).
 */

/** The run, as the API keeps it, with its files' bytes. */
export interface SampleTestRun {
  detail: TestRunDetail;
  files: Partial<Record<TestRunFile, Uint8Array>>;
}

/** One configuration's testing, all of it its draft's. */
export interface SampleTestingConfiguration {
  configurationId: string;
  versionId: string;
  runs: SampleTestRun[];
  validationPipelines: ValidationPipeline[];
  rulesByPipeline: Record<string, ValidationRule[]>;
  suites: TestSuite[];
  definitionsBySuite: Record<string, TestDefinition[]>;
}

/** The testing sample: the product's templates (and their bytes), the visitor's files, and each configuration's testing. */
export interface SampleTesting {
  templates: TestTemplate[];
  templateBytes: Record<string, Uint8Array>;
  files: TestFile[];
  configurations: SampleTestingConfiguration[];
}

const encoder = new TextEncoder();

/** A document's bytes, as the API stores them. */
function bytesOf(document: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(document, null, 2)}\n`);
}

// ---- The documents (OTLP/JSON, without trace and span ids) ----

const NANOS = "1761566400000000000";

/** An OTLP attribute: a text or an integer value. */
type Attribute = { key: string; value: { stringValue: string } | { intValue: string } };

const text = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const number = (key: string, value: number): Attribute => ({ key, value: { intValue: String(value) } });

/** "Kubernetes pod logs": a busy namespace's container logs; two records carry a social security number. */
function podLogs({ environment, ssn }: { environment: boolean; ssn: boolean }) {
  const record = (body: string, severityText: string, attributes: Attribute[]) => ({
    timeUnixNano: NANOS,
    severityText,
    body: { stringValue: body },
    attributes,
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            text("service.name", "checkout"),
            text("k8s.namespace.name", "shop"),
            text("k8s.pod.name", "checkout-7d9f8-x2kq1"),
            ...(environment ? [text("deployment.environment", "production")] : []),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "filelog" },
            logRecords: [
              record("order placed", "INFO", [text("order.id", "ord-1042"), ...(ssn ? [text("user.ssn", "123-45-6789")] : [])]),
              record("payment authorized", "INFO", [text("order.id", "ord-1042")]),
              record("inventory reserved", "INFO", [text("order.id", "ord-1043"), ...(ssn ? [text("user.ssn", "987-65-4321")] : [])]),
              record("upstream slow to answer", "WARN", [text("peer.address", "203.0.113.24")]),
            ],
          },
        ],
      },
    ],
  };
}

/** "Host metrics sample": one Linux host's gauges. */
function hostMetrics({ namespace }: { namespace: boolean }) {
  const gauge = (name: string, unit: string, value: number) => ({
    name,
    unit,
    gauge: { dataPoints: [{ timeUnixNano: NANOS, asDouble: value }] },
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [text("host.name", "web-01.acme.example"), ...(namespace ? [text("service.namespace", "infra")] : [])],
        },
        scopeMetrics: [
          {
            scope: { name: "hostmetrics" },
            metrics: [
              gauge("system.cpu.utilization", "1", 0.42),
              gauge("system.memory.usage", "By", 6_442_450_944),
              gauge("system.disk.io", "By", 1_048_576),
              gauge("system.network.io", "By", 524_288),
            ],
          },
        ],
      },
    ],
  };
}

/** "Checkout traces sample": a checkout flow, a few error spans and a health check. */
function checkoutTraces({ healthChecks, environment }: { healthChecks: boolean; environment: boolean }) {
  const span = (name: string, error: boolean) => ({
    name,
    kind: 2,
    startTimeUnixNano: NANOS,
    endTimeUnixNano: NANOS,
    status: error ? { code: 2, message: "payment declined" } : { code: 1 },
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            text("service.name", "checkout-service"),
            ...(environment ? [text("deployment.environment", "production")] : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "checkout" },
            spans: [
              span("POST /checkout", false),
              span("POST /checkout/payment", true),
              span("SELECT orders", false),
              span("POST /checkout/payment", true),
              ...(healthChecks ? [span("GET /healthz", false)] : []),
            ],
          },
        ],
      },
    ],
  };
}

/** "Browser session logs": a storefront session; one record names the shopper's email. */
function browserLogs({ source, masked }: { source: boolean; masked: boolean }) {
  const record = (body: string, attributes: Attribute[]) => ({
    timeUnixNano: NANOS,
    severityText: "INFO",
    body: { stringValue: body },
    attributes,
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [text("service.name", "storefront-web"), ...(source ? [text("telemetry.source", "browser")] : [])],
        },
        scopeLogs: [
          {
            scope: { name: "browser" },
            logRecords: [
              record("page_view /checkout", [text("page.path", "/checkout")]),
              record("click add_to_cart", [text("product.id", "8571")]),
              record("signed in", [
                text("user.email", masked ? "****" : "shopper@acme.example"),
                ...(masked ? [number("redaction.masked.count", 1)] : []),
              ]),
            ],
          },
        ],
      },
    ],
  };
}

/** "High cardinality traces": five product-page requests whose span names embed raw product ids. */
function highCardinalityTraces({ sanitized }: { sanitized: boolean }) {
  const ids = ["8571", "1129", "6640", "3305", "9012"];
  return {
    resourceSpans: [
      {
        resource: { attributes: [text("service.name", "storefront-api")] },
        scopeSpans: [
          {
            scope: { name: "http" },
            spans: ids.map((id) => ({
              name: sanitized ? "GET /product/{id}" : `GET /product/${id}`,
              kind: 2,
              startTimeUnixNano: NANOS,
              endTimeUnixNano: NANOS,
              attributes: [text("http.route", "/product/{id}"), text("url.path", `/product/${id}`)],
            })),
          },
        ],
      },
    ],
  };
}

/** "Kubelet stats sample": one kubelet's node, pod and container gauges. */
function kubeletStats() {
  const gauge = (name: string, value: number) => ({ name, gauge: { dataPoints: [{ timeUnixNano: NANOS, asInt: String(value) }] } });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [text("k8s.node.name", "node-a"), text("k8s.namespace.name", "shop"), text("k8s.pod.name", "checkout-7d9f8-x2kq1")],
        },
        scopeMetrics: [
          {
            scope: { name: "kubeletstats" },
            metrics: [gauge("k8s.pod.memory.working_set", 268_435_456), gauge("k8s.pod.cpu.time", 1_520), gauge("container.memory.rss", 201_326_592)],
          },
        ],
      },
    ],
  };
}

// ---- The templates (the sample input library) ----

type TemplateKey = "podLogs" | "hostMetrics" | "checkoutTraces" | "browserLogs" | "highCardinality" | "kubeletStats";

interface TemplateSpec {
  id: string;
  name: string;
  description: string;
  receiverType: string;
  signal: TestRunSignal;
  fileName: string;
  document: unknown;
}

/** The six templates, in order: each one's input as the run was fed it. */
const TEMPLATE_SPECS: Record<TemplateKey, TemplateSpec> = {
  podLogs: {
    id: "55555555-0000-4000-8000-000000000001",
    name: "Kubernetes pod logs",
    description: "A batch of container log records from a busy namespace",
    receiverType: "filelog",
    signal: "logs",
    fileName: "k8s-pod-logs.json",
    document: podLogs({ environment: false, ssn: true }),
  },
  hostMetrics: {
    id: "55555555-0000-4000-8000-000000000002",
    name: "Host metrics sample",
    description: "CPU, memory, disk and network gauges from one Linux host",
    receiverType: "hostmetrics",
    signal: "metrics",
    fileName: "host-metrics.json",
    document: hostMetrics({ namespace: false }),
  },
  checkoutTraces: {
    id: "55555555-0000-4000-8000-000000000003",
    name: "Checkout traces sample",
    description: "Traces from a checkout flow, including a few error spans",
    receiverType: "otlp",
    signal: "traces",
    fileName: "checkout-traces.json",
    document: checkoutTraces({ healthChecks: true, environment: false }),
  },
  browserLogs: {
    id: "55555555-0000-4000-8000-000000000004",
    name: "Browser session logs",
    description: "Frontend RUM log records from a web storefront session",
    receiverType: "otlp",
    signal: "logs",
    fileName: "browser-logs.json",
    document: browserLogs({ source: false, masked: false }),
  },
  highCardinality: {
    id: "55555555-0000-4000-8000-000000000005",
    name: "High cardinality traces",
    description: "Five product-page requests whose span names embed raw product ids",
    receiverType: "otlp",
    signal: "traces",
    fileName: "high-cardinality-traces.json",
    document: highCardinalityTraces({ sanitized: false }),
  },
  kubeletStats: {
    id: "55555555-0000-4000-8000-000000000006",
    name: "Kubelet stats sample",
    description: "Node, pod, and container gauges from one kubelet",
    receiverType: "kubeletstats",
    signal: "metrics",
    fileName: "kubelet-stats.json",
    document: kubeletStats(),
  },
};

// ---- The rules, the runs, the suites ----

type Author = { userId: string };

interface RuleSpec {
  id: string;
  kind: ValidationRule["kind"];
  target: ValidationRule["target"];
  pattern?: string;
  ottl?: ValidationRuleOttl;
  name: string;
  description: string;
  createdAgo: number;
  updatedAgo: number;
}

/** What one rule's result was: passed, or failed with a detail. */
type ResultSpec = true | Exclude<ValidationRuleResult["detail"], null>;

interface RunSpec {
  id: string;
  status: "succeeded" | "validation_failed" | "failed";
  queuedAgo: number;
  durationMs: number;
  durationSeconds: number;
  queuedBy: Author;
  template: TemplateKey;
  /** The text it ran: the draft's, or a change of it. */
  yaml?: (draft: string) => string;
  mutations: TestRunMutation[];
  compatibility?: TestRunCompatibilityIssue[];
  /** The output it produced; none for a failed run. */
  output: unknown;
  /** Its rules' results, by the rule's id, in its pipeline's order: the rules it snapshotted. */
  results: Record<string, ResultSpec>;
  /** A failed run's error: its message and the collector's log. */
  error?: { message: string; logs: string };
  kwok?: boolean;
  /** The suite and definition it came from (a suite's Play), by their ids. */
  from?: { suiteId: string; definitionId: string };
}

interface SuiteSpec {
  id: string;
  name: string;
  description: string;
  createdAgo: number;
  definitions: Array<{ id: string; name: string; description: string; template: TemplateKey; durationSeconds: number; createdAgo: number; by: Author }>;
}

interface ConfigurationTestingSpec {
  author: Author;
  validationPipeline: { id: string; pipeline: string; signal: TestRunSignal; createdAgo: number } | null;
  rules: RuleSpec[];
  runs: RunSpec[];
  suites: SuiteSpec[];
}

/** The sandbox's rewrite notes (otelcol-testing's SANDBOX_REWRITES.md), by rule id. */
function replacedReceivers(receivers: string[]): TestRunMutation {
  return {
    id: "R-001",
    severity: "info",
    message: `Your receivers (${receivers.join(", ")}) were replaced with a sandbox OTLP/HTTP source. The data flowing through your processor chain comes from the fixture you selected, not from the original receivers.`,
    details: { original_receivers: receivers, test_receiver: "otlp/test_in" },
  };
}

function replacedExporters(exporters: string[]): TestRunMutation {
  return {
    id: "R-002",
    severity: "info",
    message: `Your exporters (${exporters.join(", ")}) were replaced with a sandbox capture. Your processor chain's output is shown in the test result; nothing was sent to your real backends.`,
    details: { original_exporters: exporters, test_exporter: "file/test_out" },
  };
}

function removedExtensions(extensions: string[]): TestRunMutation {
  return {
    id: "R-003",
    severity: "info",
    message: "Extensions are not run during testing — your test result reflects only the receivers → processors → exporters path.",
    details: { removed_extensions: extensions },
  };
}

function droppedPipelines(dropped: string[], signal: TestRunSignal): TestRunMutation {
  return {
    id: "R-005",
    severity: "caution",
    message: `Your config includes ${dropped.length} additional pipeline(s) for signals other than ${signal} (${dropped.join(", ")}). They were excluded from this test. Test each signal type separately.`,
    details: { dropped_pipelines: dropped, target_signal: signal, mode: "signal_type" },
  };
}

const GATEWAY_MUTATIONS = [
  replacedReceivers(["filelog", "otlp"]),
  replacedExporters(["debug", "otlphttp"]),
  removedExtensions(["health_check"]),
  droppedPipelines(["traces", "metrics"], "logs"),
];

const SPANMETRICS_MUTATIONS: TestRunMutation[] = [
  replacedReceivers(["otlp"]),
  replacedExporters(["otlp", "otlphttp"]),
  droppedPipelines(["metrics"], "traces"),
  {
    id: "R-007",
    severity: "info",
    message:
      "Your connectors (spanmetrics) were removed before running this test. The sandbox tests one pipeline's processor chain at a time and can't faithfully exercise connector logic that spans pipelines or signal types. Test connector behavior in a real collector deployment, or with the connector's own upstream tests.",
    details: { removed_connectors: ["spanmetrics"] },
  },
];

const SSN_PATTERN = "\\b\\d{3}-\\d{2}-\\d{4}\\b";

const ottl = (value: ValidationRuleOttl) => value;

/** A not-contains rule's match of a social security number in the gateway's output (the run's failure detail). */
function ssnMatch(text: string, record: number, attribute: number) {
  return {
    text,
    textTruncated: false,
    before: '"stringValue": "',
    after: '"',
    record: { index: 0, path: `resourceLogs[0].scopeLogs[0].logRecords[${record}].attributes[${attribute}].value.stringValue` },
  };
}

const NIGHTLY_SUITE = "88888888-0000-4000-8000-000000000001";
const NIGHTLY_K8S_DEFINITION = "99999999-0000-4000-8000-000000000011";

const SPECS: Record<SampleConfigurationKey, ConfigurationTestingSpec> = {
  gateway: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000001", pipeline: "logs", signal: "logs", createdAgo: 20 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000101",
        kind: "contains_text",
        target: "output",
        pattern: "service.name",
        name: "service.name present on every record",
        description: "The resource attribute must survive the pipeline",
        createdAgo: 20 * DAY,
        updatedAgo: 20 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000102",
        kind: "not_contains_regex",
        target: "output",
        pattern: SSN_PATTERN,
        name: "No SSNs leak through",
        description: "PII scrub check for user.ssn",
        createdAgo: 20 * DAY,
        updatedAgo: 3 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000103",
        kind: "not_contains_text",
        target: "stderr",
        pattern: "Exporting failed",
        name: "No exporter errors on stderr",
        description: "",
        createdAgo: 18 * DAY,
        updatedAgo: 18 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000104",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "resource", condition: 'attributes["k8s.namespace.name"] != nil', quantifier: "all" }),
        name: "k8s.namespace.name on every resource",
        description: "Pod logs must keep their k8s.* resource attributes",
        createdAgo: 15 * DAY,
        updatedAgo: 15 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000001",
        status: "succeeded",
        queuedAgo: 2 * HOUR,
        durationMs: 5230,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "podLogs",
        mutations: GATEWAY_MUTATIONS,
        output: podLogs({ environment: true, ssn: false }),
        results: {
          "77777777-0000-4000-8000-000000000101": true,
          "77777777-0000-4000-8000-000000000102": true,
          "77777777-0000-4000-8000-000000000103": true,
        },
      },
      {
        id: "66666666-0000-4000-8000-000000000002",
        status: "validation_failed",
        queuedAgo: 26 * HOUR,
        durationMs: 5180,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "podLogs",
        yaml: (draft) => draft.replace("  attributes:\n    actions:\n      - key: user.ssn\n        action: delete\n", ""),
        mutations: GATEWAY_MUTATIONS,
        output: podLogs({ environment: true, ssn: true }),
        results: {
          "77777777-0000-4000-8000-000000000101": true,
          "77777777-0000-4000-8000-000000000102": {
            kind: "unexpected_match",
            source: "output",
            totalMatchCount: 2,
            moreMatches: false,
            matches: [ssnMatch("123-45-6789", 0, 1), ssnMatch("987-65-4321", 2, 1)],
          },
          "77777777-0000-4000-8000-000000000103": true,
        },
      },
      {
        id: "66666666-0000-4000-8000-000000000003",
        status: "succeeded",
        queuedAgo: 28 * HOUR,
        durationMs: 4890,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "podLogs",
        mutations: GATEWAY_MUTATIONS,
        output: podLogs({ environment: true, ssn: false }),
        results: { "77777777-0000-4000-8000-000000000104": true },
        from: { suiteId: NIGHTLY_SUITE, definitionId: NIGHTLY_K8S_DEFINITION },
      },
      {
        id: "66666666-0000-4000-8000-000000000004",
        status: "failed",
        queuedAgo: 2 * DAY,
        durationMs: 740,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "podLogs",
        yaml: (draft) => draft.replace("memory_limiter:", "memorylimiter:"),
        mutations: GATEWAY_MUTATIONS,
        output: null,
        results: { "77777777-0000-4000-8000-000000000101": true },
        error: {
          message: "The collector failed to start: its configuration could not be loaded.",
          logs: 'Error: failed to get config: cannot unmarshal the configuration: error decoding \'processors\': unknown type "memorylimiter" for id "memorylimiter" (valid values: [attributes batch filter memory_limiter resource transform ...])',
        },
      },
    ],
    suites: [
      {
        id: NIGHTLY_SUITE,
        name: "Nightly regression",
        description: "Runs against the standard fixtures every night",
        createdAgo: 14 * DAY,
        definitions: [
          {
            id: NIGHTLY_K8S_DEFINITION,
            name: "k8s attributes present",
            description: "Pod logs keep their k8s.* resource attributes",
            template: "podLogs",
            durationSeconds: 5,
            createdAgo: 14 * DAY,
            by: SAMPLE_VISITOR,
          },
          {
            id: "99999999-0000-4000-8000-000000000012",
            name: "PII scrub holds on RUM logs",
            description: "user.ssn is stripped before export",
            template: "browserLogs",
            durationSeconds: 5,
            createdAgo: 10 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  hostMetrics: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000002", pipeline: "metrics", signal: "metrics", createdAgo: 12 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000201",
        kind: "contains_text",
        target: "output",
        pattern: "system.cpu.utilization",
        name: "CPU utilization metric present",
        description: "",
        createdAgo: 12 * DAY,
        updatedAgo: 12 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000202",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "datapoint", condition: "true", quantifier: "count", count: { operator: "gt", value: 0 } }),
        name: "At least one datapoint emitted",
        description: "",
        createdAgo: 12 * DAY,
        updatedAgo: 12 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000101",
        status: "succeeded",
        queuedAgo: 9 * DAY,
        durationMs: 4310,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "hostMetrics",
        mutations: [replacedReceivers(["hostmetrics"]), replacedExporters(["debug", "otlphttp"])],
        output: hostMetrics({ namespace: true }),
        results: { "77777777-0000-4000-8000-000000000201": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000002",
        name: "Metric coverage",
        description: "Confirms the core host metrics make it through",
        createdAgo: 11 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000021",
            name: "CPU + memory present",
            description: "Core gauges survive the resource processor",
            template: "hostMetrics",
            durationSeconds: 5,
            createdAgo: 11 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  tailSampling: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000003", pipeline: "traces", signal: "traces", createdAgo: 5 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000301",
        kind: "contains_text",
        target: "output",
        pattern: "checkout-service",
        name: "Error traces survive sampling",
        description: "Tail sampling must keep traces from the checkout service",
        createdAgo: 5 * DAY,
        updatedAgo: 5 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000302",
        kind: "not_contains_text",
        target: "stderr",
        pattern: "error decoding 'processors'",
        name: "Config loads cleanly",
        description: "No processor decode errors on startup",
        createdAgo: 5 * DAY,
        updatedAgo: 5 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000201",
        status: "succeeded",
        queuedAgo: 26 * HOUR,
        durationMs: 11240,
        durationSeconds: 15,
        queuedBy: SAMPLE_VISITOR,
        template: "checkoutTraces",
        mutations: [replacedReceivers(["otlp"]), replacedExporters(["otlp"])],
        compatibility: [
          {
            id: "C-003",
            severity: "advisory",
            component: "tail_sampling",
            message:
              "tail_sampling.decision_wait is 30s but the test runs for 15s — traces in flight when the collector receives SIGTERM may be sampled with the default policy or dropped, not the decision your config intends. Raise the run duration to at least 31s for a faithful test.",
            details: { processor: "tail_sampling", knob: "tail_sampling.decision_wait", window_seconds: 30, duration_seconds: 15 },
          },
        ],
        output: checkoutTraces({ healthChecks: false, environment: false }),
        results: { "77777777-0000-4000-8000-000000000301": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000003",
        name: "Sampling sanity",
        description: "Error traces kept, config loads clean",
        createdAgo: 5 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000031",
            name: "Checkout errors retained",
            description: "Tail sampling keeps the error spans",
            template: "checkoutTraces",
            durationSeconds: 15,
            createdAgo: 5 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  rum: {
    author: SAMPLE_SRE,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000004", pipeline: "logs", signal: "logs", createdAgo: 6 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000401",
        kind: "contains_text",
        target: "output",
        pattern: "telemetry.source",
        name: "Source attribute stamped on every record",
        description: "",
        createdAgo: 6 * DAY,
        updatedAgo: 6 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000402",
        kind: "not_contains_regex",
        target: "output",
        pattern: "\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b",
        name: "No raw email addresses in logs",
        description: "Catch un-scrubbed PII before export",
        createdAgo: 6 * DAY,
        updatedAgo: 6 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000301",
        status: "succeeded",
        queuedAgo: 6 * DAY,
        durationMs: 4720,
        durationSeconds: 5,
        queuedBy: SAMPLE_SRE,
        template: "browserLogs",
        mutations: [replacedReceivers(["otlp"]), replacedExporters(["otlphttp"])],
        output: browserLogs({ source: true, masked: true }),
        results: { "77777777-0000-4000-8000-000000000401": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000004",
        name: "RUM hygiene",
        description: "Source tagging + PII scrubbing checks",
        createdAgo: 6 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000041",
            name: "Source attribute stamped",
            description: "telemetry.source=browser on every record",
            template: "browserLogs",
            durationSeconds: 5,
            createdAgo: 6 * DAY,
            by: SAMPLE_SRE,
          },
        ],
      },
    ],
  },
  spanMetrics: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000005", pipeline: "traces", signal: "traces", createdAgo: 12 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000501",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "span", quantifier: "distinct", expression: "name", count: { operator: "lte", value: 1 } }),
        name: "Route collapses to a single series",
        description: "Distinct span names are the series the connector will mint for this route",
        createdAgo: 12 * DAY,
        updatedAgo: 4 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000502",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "span", condition: "true", quantifier: "count", count: { operator: "eq", value: 5 } }),
        name: "Rename, never drop",
        description: "The sanitizing transform must not add or drop spans",
        createdAgo: 12 * DAY,
        updatedAgo: 12 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000501",
        status: "succeeded",
        queuedAgo: 4 * DAY,
        durationMs: 5340,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "highCardinality",
        mutations: SPANMETRICS_MUTATIONS,
        output: highCardinalityTraces({ sanitized: true }),
        results: { "77777777-0000-4000-8000-000000000501": true, "77777777-0000-4000-8000-000000000502": true },
      },
      {
        id: "66666666-0000-4000-8000-000000000502",
        status: "validation_failed",
        queuedAgo: 5 * DAY,
        durationMs: 5210,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "highCardinality",
        yaml: (draft) =>
          draft
            .replace(
              '  transform/sanitize_spans:\n    error_mode: ignore\n    trace_statements:\n      - context: span\n        statements:\n          - set_semconv_span_name("1.37.0")\n',
              "",
            )
            .replace("processors: [memory_limiter, transform/sanitize_spans, batch]", "processors: [memory_limiter, batch]"),
        mutations: SPANMETRICS_MUTATIONS,
        output: highCardinalityTraces({ sanitized: false }),
        results: {
          "77777777-0000-4000-8000-000000000501": {
            kind: "distinct_mismatch",
            totalCount: 5,
            matchedCount: 5,
            distinctCount: 5,
            samples: ["GET /product/8571", "GET /product/1129", "GET /product/6640", "GET /product/3305", "GET /product/9012"],
          },
          "77777777-0000-4000-8000-000000000502": true,
        },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000005",
        name: "Cardinality guardrails",
        description: "Any change that reintroduces an unbounded span name fails here, not on the bill",
        createdAgo: 12 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000051",
            name: "Route template collapse",
            description: "Five raw product-id span names normalize to one route",
            template: "highCardinality",
            durationSeconds: 5,
            createdAgo: 12 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  k8sNode: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000006", pipeline: "metrics", signal: "metrics", createdAgo: 20 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000601",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "resource", condition: 'attributes["k8s.namespace.name"] != nil', quantifier: "all" }),
        name: "Every resource tagged with its namespace",
        description: "k8sattributes enrichment applied to all datapoints",
        createdAgo: 20 * DAY,
        updatedAgo: 20 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000602",
        kind: "contains_text",
        target: "output",
        pattern: "k8s.pod.memory.working_set",
        name: "Pod memory series present",
        description: "",
        createdAgo: 20 * DAY,
        updatedAgo: 20 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000601",
        status: "succeeded",
        queuedAgo: 8 * DAY,
        durationMs: 6120,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "kubeletStats",
        kwok: true,
        mutations: [
          replacedReceivers(["filelog", "hostmetrics", "kubeletstats"]),
          replacedExporters(["otlp"]),
          removedExtensions(["file_storage"]),
          droppedPipelines(["logs"], "metrics"),
          {
            id: "R-100",
            severity: "warn",
            message:
              "Your k8sattributes processor(s) had `auth_type` rewritten to `kubeConfig` so they could connect to the sandbox's simulated Kubernetes API (kwok). The processor runs, but the cluster state it sees is the test fixture's fake pods — not your real cluster.",
            details: { rewritten_processors: ["k8sattributes"], from_auth_type: "serviceAccount", to_auth_type: "kubeConfig" },
          },
        ],
        output: kubeletStats(),
        results: { "77777777-0000-4000-8000-000000000601": true, "77777777-0000-4000-8000-000000000602": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000006",
        name: "Node coverage",
        description: "Kubelet series and k8s enrichment survive the pipeline",
        createdAgo: 20 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000061",
            name: "Namespace enrichment holds",
            description: "k8s.namespace.name lands on every resource",
            template: "kubeletStats",
            durationSeconds: 5,
            createdAgo: 20 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  pii: {
    author: SAMPLE_SECURITY,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000007", pipeline: "logs", signal: "logs", createdAgo: 15 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000701",
        kind: "not_contains_regex",
        target: "output",
        pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
        name: "No raw email addresses reach the backend",
        description: "",
        createdAgo: 15 * DAY,
        updatedAgo: 15 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000702",
        kind: "not_contains_regex",
        target: "output",
        pattern: SSN_PATTERN,
        name: "No SSNs reach the backend",
        description: "",
        createdAgo: 15 * DAY,
        updatedAgo: 15 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000703",
        kind: "contains_text",
        target: "output",
        pattern: "redaction.masked.count",
        name: "Masked-value counts stamped for audit",
        description: "summary: debug annotates every redacted record",
        createdAgo: 15 * DAY,
        updatedAgo: 15 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000701",
        status: "succeeded",
        queuedAgo: 7 * DAY,
        durationMs: 4980,
        durationSeconds: 5,
        queuedBy: SAMPLE_SECURITY,
        template: "browserLogs",
        mutations: [replacedReceivers(["otlp"]), replacedExporters(["otlphttp"]), droppedPipelines(["traces"], "logs")],
        output: browserLogs({ source: false, masked: true }),
        results: {
          "77777777-0000-4000-8000-000000000701": true,
          "77777777-0000-4000-8000-000000000702": true,
          "77777777-0000-4000-8000-000000000703": true,
        },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000007",
        name: "Compliance checks",
        description: "Nothing personally identifiable leaves the pipeline",
        createdAgo: 15 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000071",
            name: "Emails and SSNs masked",
            description: "blocked_values regexes catch PII wherever it appears",
            template: "browserLogs",
            durationSeconds: 5,
            createdAgo: 15 * DAY,
            by: SAMPLE_SECURITY,
          },
          {
            id: "99999999-0000-4000-8000-000000000072",
            name: "Secret-looking keys blocked",
            description: "password/token/authorization keys never pass through",
            template: "podLogs",
            durationSeconds: 5,
            createdAgo: 15 * DAY,
            by: SAMPLE_SECURITY,
          },
        ],
      },
    ],
  },
  cost: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000008", pipeline: "traces", signal: "traces", createdAgo: 9 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000801",
        kind: "not_contains_text",
        target: "output",
        pattern: "/healthz",
        name: "Health-check spans dropped",
        description: "",
        createdAgo: 9 * DAY,
        updatedAgo: 9 * DAY,
      },
      {
        id: "77777777-0000-4000-8000-000000000802",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "span", condition: "true", quantifier: "count", count: { operator: "gt", value: 0 } }),
        name: "Real traffic survives the filters",
        description: "The filter must not drop everything",
        createdAgo: 9 * DAY,
        updatedAgo: 9 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000801",
        status: "succeeded",
        queuedAgo: 2 * DAY,
        durationMs: 5060,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "checkoutTraces",
        mutations: [replacedReceivers(["otlp"]), replacedExporters(["otlphttp"]), droppedPipelines(["logs"], "traces")],
        output: checkoutTraces({ healthChecks: false, environment: false }),
        results: { "77777777-0000-4000-8000-000000000801": true, "77777777-0000-4000-8000-000000000802": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000008",
        name: "Noise filters",
        description: "Known noise stays dropped; real traffic stays intact",
        createdAgo: 9 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000081",
            name: "Health checks dropped",
            description: "No /healthz, /readyz, or /livez spans in the output",
            template: "checkoutTraces",
            durationSeconds: 5,
            createdAgo: 9 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  migrate: {
    author: SAMPLE_VISITOR,
    validationPipeline: { id: "44444444-0000-4000-8000-000000000009", pipeline: "traces", signal: "traces", createdAgo: 3 * DAY },
    rules: [
      {
        id: "77777777-0000-4000-8000-000000000901",
        kind: "ottl",
        target: "output",
        ottl: ottl({ context: "resource", condition: 'attributes["deployment.environment"] == "production"', quantifier: "all" }),
        name: "Environment stamped on every resource",
        description: "Both backends must agree on the environment label",
        createdAgo: 3 * DAY,
        updatedAgo: 3 * DAY,
      },
    ],
    runs: [
      {
        id: "66666666-0000-4000-8000-000000000901",
        status: "succeeded",
        queuedAgo: 5 * HOUR,
        durationMs: 4870,
        durationSeconds: 5,
        queuedBy: SAMPLE_VISITOR,
        template: "checkoutTraces",
        mutations: [replacedReceivers(["otlp"]), replacedExporters(["otlp/legacy", "otlphttp/new"]), droppedPipelines(["metrics", "logs"], "traces")],
        output: checkoutTraces({ healthChecks: true, environment: true }),
        results: { "77777777-0000-4000-8000-000000000901": true },
      },
    ],
    suites: [
      {
        id: "88888888-0000-4000-8000-000000000009",
        name: "Dual-ship parity",
        description: "The stream both backends receive is identically labeled",
        createdAgo: 3 * DAY,
        definitions: [
          {
            id: "99999999-0000-4000-8000-000000000091",
            name: "Environment label present",
            description: "deployment.environment=production on every resource",
            template: "checkoutTraces",
            durationSeconds: 5,
            createdAgo: 3 * DAY,
            by: SAMPLE_VISITOR,
          },
        ],
      },
    ],
  },
  // Freshly adopted: nobody has tested it yet, so its Testing tab shows the empty states.
  import: { author: SAMPLE_VISITOR, validationPipeline: null, rules: [], runs: [], suites: [] },
};

// ---- Building ----

/** The templates, as the API lists them (newest first: all made together, in the specs' order). */
function buildTemplates(clock: SampleClock): { templates: TestTemplate[]; templateBytes: Record<string, Uint8Array> } {
  const templateBytes: Record<string, Uint8Array> = {};
  const templates = Object.values(TEMPLATE_SPECS).map((spec): TestTemplate => {
    const bytes = bytesOf(spec.document);
    templateBytes[spec.id] = bytes;
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      receiverType: spec.receiverType,
      signal: spec.signal,
      fileName: spec.fileName,
      contentType: "application/json",
      sizeBytes: bytes.byteLength,
      createdAt: clock.ago(60 * DAY),
      updatedAt: clock.ago(60 * DAY),
    };
  });
  return { templates, templateBytes };
}

function snapshotOf(rule: ValidationRule): ValidationRuleSnapshot {
  const { id, position, kind, target, pattern, ottl: checks, name, description } = rule;
  return { id, position, kind, target, pattern, ottl: checks, name, description };
}

function resultOf(id: string, spec: ResultSpec): ValidationRuleResult {
  return spec === true
    ? { id, passed: true, error: null, advisory: null, detail: null }
    : { id, passed: false, error: null, advisory: null, detail: spec };
}

function buildConfiguration(
  key: SampleConfigurationKey,
  versionId: string,
  draftYaml: string,
  collectorVersion: string,
  clock: SampleClock,
  templateBytes: Record<string, Uint8Array>,
): SampleTestingConfiguration {
  const spec = SPECS[key];
  const configurationId = SAMPLE_CONFIGURATION_IDS[key];
  const pipeline = spec.validationPipeline;

  const validationPipelines: ValidationPipeline[] =
    pipeline === null
      ? []
      : [
          {
            id: pipeline.id,
            configurationId,
            versionId,
            pipeline: pipeline.pipeline,
            signal: pipeline.signal,
            createdByUserId: spec.author.userId,
            createdAt: clock.ago(pipeline.createdAgo),
          },
        ];
  const rules: ValidationRule[] =
    pipeline === null
      ? []
      : spec.rules.map((rule, index) => ({
          id: rule.id,
          validationPipelineId: pipeline.id,
          position: index + 1,
          kind: rule.kind,
          target: rule.target,
          pattern: rule.pattern ?? null,
          ottl: rule.ottl ?? null,
          name: rule.name,
          description: rule.description,
          createdByUserId: spec.author.userId,
          createdAt: clock.ago(rule.createdAgo),
          updatedAt: clock.ago(rule.updatedAgo),
        }));

  const suites: TestSuite[] = spec.suites.map((suite) => ({
    id: suite.id,
    configurationId,
    versionId,
    name: suite.name,
    description: suite.description,
    createdByUserId: spec.author.userId,
    createdAt: clock.ago(suite.createdAgo),
    updatedAt: clock.ago(suite.createdAgo),
  }));
  const definitionsBySuite: Record<string, TestDefinition[]> = Object.fromEntries(
    spec.suites.map((suite) => [
      suite.id,
      suite.definitions.map((definition): TestDefinition => {
        const template = TEMPLATE_SPECS[definition.template];
        return {
          id: definition.id,
          suiteId: suite.id,
          name: definition.name,
          description: definition.description,
          pipeline: template.signal,
          signal: template.signal,
          durationSeconds: definition.durationSeconds,
          inputName: template.fileName,
          createdByUserId: definition.by.userId,
          createdAt: clock.ago(definition.createdAgo),
        };
      }),
    ]),
  );

  const runs = spec.runs.map((run): SampleTestRun => {
    const template = TEMPLATE_SPECS[run.template];
    const input = templateBytes[template.id]!;
    const output = run.output === null ? null : bytesOf(run.output);
    const snapshotted = rules.filter((rule) => Object.hasOwn(run.results, rule.id)).map(snapshotOf);
    const suite = run.from === undefined ? undefined : spec.suites.find((listed) => listed.id === run.from!.suiteId);
    const definition = suite?.definitions.find((listed) => listed.id === run.from!.definitionId);
    const queuedAgo = run.queuedAgo;
    const startedAgo = queuedAgo - 2_000;
    const detail: TestRunDetail = {
      id: run.id,
      status: run.status,
      queuedAt: clock.ago(queuedAgo),
      startedAt: clock.ago(startedAgo),
      finishedAt: clock.ago(startedAgo - run.durationMs),
      ahead: null,
      pipeline: template.signal,
      signal: template.signal,
      durationSeconds: run.durationSeconds,
      collectorVersion,
      queuedByUserId: run.queuedBy.userId,
      inputName: template.fileName,
      errorCode: run.status === "failed" ? "collector_failed" : null,
      suiteId: suite?.id ?? null,
      suiteName: suite?.name ?? null,
      definitionId: definition?.id ?? null,
      definitionName: definition?.name ?? null,
      configurationId,
      versionId,
      sourceRunId: null,
      yaml: run.yaml === undefined ? draftYaml : run.yaml(draftYaml),
      collectorDistribution: SAMPLE_DISTRIBUTION,
      inputSizeBytes: input.byteLength,
      inputContentType: "application/json",
      strategy: "otlp",
      kwokEnabled: run.kwok ?? false,
      mutatedYaml: null,
      mutations: run.mutations,
      compatibility: run.compatibility ?? [],
      logs: run.error?.logs ?? "",
      timings: null,
      errorMessage: run.error?.message ?? null,
      outputSizeBytes: output?.byteLength ?? null,
      outputTruncated: output === null ? null : false,
      decodedInputSizeBytes: input.byteLength,
      decodedInputTruncated: false,
      validationRules: snapshotted,
      validationResults: run.status === "failed" ? null : snapshotted.map((rule) => resultOf(rule.id, run.results[rule.id]!)),
    };
    const files: SampleTestRun["files"] = { input, "decoded-input": input };
    if (output !== null) files.output = output;
    return { detail, files };
  });

  return {
    configurationId,
    versionId,
    runs: runs.sort((one, other) => other.detail.queuedAt.localeCompare(one.detail.queuedAt)),
    validationPipelines,
    rulesByPipeline: pipeline === null ? {} : { [pipeline.id]: rules },
    suites,
    definitionsBySuite,
  };
}

/** The testing sample, with times relative to `now`. */
export function sampleTesting(now: number = Date.now()): SampleTesting {
  const clock = clockAt(now);
  const { templates, templateBytes } = buildTemplates(clock);
  const configurations = sampleConfigurations(now).map(({ configuration, version }) => {
    const key = (Object.keys(SAMPLE_CONFIGURATION_IDS) as SampleConfigurationKey[]).find(
      (candidate) => SAMPLE_CONFIGURATION_IDS[candidate] === configuration.id,
    )!;
    return buildConfiguration(key, version.id, version.yamlContent, version.collectorVersion, clock, templateBytes);
  });
  return { templates, templateBytes, files: [], configurations };
}

// ---- The reads ----

/** The list's fields of a run, as the contract names them. */
const SUMMARY_KEYS = Object.keys(TestRunSummarySchema.shape) as Array<keyof TestRunSummary>;

function summaryOf(run: TestRunDetail): TestRunSummary {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, run[key]])) as TestRunSummary;
}

/** The testing of the version a read names, or undefined when the sample holds none for it (its lists are then empty). */
function testingOf(configurationId: string, versionId: string): SampleTestingConfiguration | undefined {
  const configuration = configurationId.toLowerCase();
  const version = versionId.toLowerCase();
  return sampleTesting().configurations.find(
    (listed) => listed.configurationId === configuration && listed.versionId === version,
  );
}

const runNotFound = () => sampleNotFound("test_run_not_found", "Test run not found");

function runOf(configurationId: string, versionId: string, runId: string): SampleTestRun {
  const id = runId.toLowerCase();
  const run = testingOf(configurationId, versionId)?.runs.find((listed) => listed.detail.id === id);
  if (run === undefined) throw runNotFound();
  return run;
}

/** A copy of the bytes, so a reader's change never reaches the sample. */
const copyOf = (bytes: Uint8Array) => bytes.slice();

/**
 * The Testing tab's reads under the sample (`readsFor(SAMPLE_ORGANIZATION_ID)`):
 * the sample's templates; no files of the visitor's; and the open draft's
 * runs, files, pipelines, rules, suites and definitions, empty for a version
 * the sample holds no testing for. An id it doesn't hold answers the API's
 * own "not found".
 */
export const SAMPLE_TESTING_READS: TestingReads = {
  getTestFiles: async () => ({ files: sampleTesting().files }),
  getTestFileHead: async () => {
    throw sampleNotFound("test_file_not_found", "Test file not found");
  },
  getTestTemplates: async () => ({ templates: sampleTesting().templates }),
  getTestRuns: async (_organizationId, configurationId, versionId) => ({
    runs: (testingOf(configurationId, versionId)?.runs ?? []).map((run) => summaryOf(run.detail)),
  }),
  getTestRun: async (_organizationId, configurationId, versionId, runId) => ({ run: runOf(configurationId, versionId, runId).detail }),
  getTestRunFile: async (_organizationId, configurationId, versionId, runId, file) => {
    const bytes = runOf(configurationId, versionId, runId).files[file];
    if (bytes === undefined) throw sampleNotFound("test_run_not_found", "This run has no such file.");
    return copyOf(bytes);
  },
  getTestSuites: async (_organizationId, configurationId, versionId) => ({
    suites: testingOf(configurationId, versionId)?.suites ?? [],
  }),
  getTestDefinitions: async (_organizationId, configurationId, versionId, suiteId) => {
    const definitions = testingOf(configurationId, versionId)?.definitionsBySuite[suiteId.toLowerCase()];
    if (definitions === undefined) throw sampleNotFound("test_suite_not_found", "Test suite not found");
    return { definitions };
  },
  getValidationPipelines: async (_organizationId, configurationId, versionId) => ({
    validationPipelines: testingOf(configurationId, versionId)?.validationPipelines ?? [],
  }),
  getValidationRules: async (_organizationId, configurationId, versionId, validationPipelineId) => {
    const rules = testingOf(configurationId, versionId)?.rulesByPipeline[validationPipelineId.toLowerCase()];
    if (rules === undefined) throw sampleNotFound("validation_pipeline_not_found", "Validation pipeline not found");
    return { rules };
  },
};
