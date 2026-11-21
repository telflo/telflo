import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { JAEGER_SEEDS, JaegerReceiverForm } from "./JaegerReceiverForm.js";
import { ProbabilisticSamplerForm } from "./ProbabilisticSamplerForm.js";
import { formFor } from "./registry.js";
import {
  BOTH_HISTOGRAMS,
  DEFAULT_BUCKETS,
  EXPONENTIAL_IN_USE,
  REMOVED_EXPLICIT,
  REMOVED_EXPONENTIAL,
  REMOVED_TIMESTAMP_CACHE,
  SpanmetricsConnectorForm,
  TEMPORALITY_HINT,
} from "./SpanmetricsConnectorForm.js";
import { EMPTY_SPAN_WARNING, REMOVED_DESCRIPTION, SpanProcessorForm } from "./SpanProcessorForm.js";
import { ZipkinExporterForm } from "./ZipkinExporterForm.js";
import { ZipkinReceiverForm } from "./ZipkinReceiverForm.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPaletteEntry, paletteDefaultConfig } from "~/lib/graph/palette.js";
import { RENAMED_TYPES } from "~/lib/collector/renamed-types.js";
import { paletteSubType } from "~/lib/graph/parse.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The jaeger and zipkin receivers, the zipkin exporter, the probabilistic
 * sampler and span processors, and the spanmetrics connector: their forms
 * over the form contract. Each field is driven as a person would on the
 * traces corpus text (comments, an anchor and its aliases, flow and block
 * lists, a bare `0750` the collector reads as a number), LF and CRLF, and
 * writes only its key. Seven span processor cases are included. The
 * cascades each have a test.
 *
 * Collector claims cite contrib v0.162.0: `receiver/jaegerreceiver`,
 * `receiver/zipkinreceiver`, `exporter/zipkinexporter`,
 * `processor/probabilisticsamplerprocessor`, `processor/spanprocessor`,
 * `internal/filter`, `connector/spanmetricsconnector`.
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The traces corpus (LF): comments, an anchor and its aliases, flow and block lists, a bare `0750`. */
const CORPUS = LF(corpusText("forms-traces.yaml"));

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Ends the store's run of changes (one undo entry per run within 800 ms,
 * `HISTORY_THROTTLE_MS`): the next write is an entry of its own.
 */
function stepPastRuns() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 1000);
}

const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const JAEGER = "receivers.jaeger";
const ZIPKIN_IN = "receivers.zipkin";
const ZIPKIN_OUT = "exporters.zipkin";
const PROB = "processors.probabilistic_sampler";
const PROB_LOGS = "processors.probabilistic_sampler/logs";
const SPAN = "processors.span";
const SPAN_RULES = "processors.span/to_attributes";
const SM = "connectors.spanmetrics";
const SM_DELTA = "connectors.span_metrics/delta";

function formOf(key: string): ReactNode {
  if (key.startsWith("receivers.jaeger")) return <JaegerReceiverForm />;
  if (key.startsWith("receivers.zipkin")) return <ZipkinReceiverForm />;
  if (key.startsWith("exporters.zipkin")) return <ZipkinExporterForm />;
  if (key.startsWith("processors.probabilistic")) return <ProbabilisticSamplerForm />;
  if (key.startsWith("processors.span")) return <SpanProcessorForm />;
  return <SpanmetricsConnectorForm />;
}

function renderForm(key: string, text = CORPUS, options?: Parameters<typeof userEvent.setup>[0]) {
  openText(text);
  const user = userEvent.setup(options);
  render(<ComponentForm nodeId={componentNamed(key).id}>{formOf(key)}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const parsed = (written = text()) => parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  return parsed(written)[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
/** A hint line, by its whole text ("… · Default 5m" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);
const queryHint = (whole: string) => screen.queryByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

/** Replaces `input`'s text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

/** Types into an empty field and leaves it. */
async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

async function optionsOf(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  await user.click(trigger);
  const shown = screen.getAllByRole("option").map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return shown;
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${title}\\s*\\d*$`) }).at(-1)!);
}

/** The span filter side (Include, Exclude), by its title. */
const sideOf = (title: string) => screen.getByText(title, { selector: "p" }).parentElement!.parentElement!;

/** A text holding `type`'s palette default under `subType`, in a traces pipeline. */
function paletteText(type: ComponentType, subType: string): string {
  const config = paletteDefaultConfig(findPaletteEntry(type, subType)!);
  return ownText(`${type}s` as Section, subType, stringify(config).replace(/^/gm, "    "));
}

type Section = "receivers" | "processors" | "exporters" | "connectors";

/** A text of its own: `component` (its lines, at four spaces) under `section`, in a traces pipeline. */
function ownText(section: Section, key: string, lines: string): string {
  const body = lines.trimEnd() === "" ? [`  ${key}: {}`] : [`  ${key}:`, lines.trimEnd()];
  const component = [`${section}:`, ...body];
  return [
    ...(section === "receivers" ? component : ["receivers:", "  otlp:", "    protocols:", "      grpc:"]),
    ...(section === "processors" ? component : []),
    ...(section === "exporters" ? component : ["exporters:", "  debug:"]),
    ...(section === "connectors" ? component : []),
    "service:",
    "  pipelines:",
    "    traces:",
    `      receivers: [${section === "receivers" ? key : "otlp"}]`,
    ...(section === "processors" ? [`      processors: [${key}]`] : []),
    `      exporters: [${section === "exporters" ? key : section === "connectors" ? key : "debug"}]`,
    ...(section === "connectors" ? ["    metrics:", `      receivers: [${key}]`, "      exporters: [debug]"] : []),
    "",
  ].join("\n");
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Checks the component's value after, as parsed. */
  check: (value: Value) => void;
}

const protocol = (value: Value, name: string) => (value.protocols as Value)[name] as Value;
const histogram = (value: Value) => value.histogram as Value;
const dimension = (value: Value, index: number) => (value.dimensions as Value[])[index]!;

const CASES: FieldCase[] = [
  // jaeger
  {
    name: "jaeger gRPC Endpoint",
    key: JAEGER,
    edit: (user) => retypeInto(user, byId("grpc-endpoint"), "0.0.0.0:14251"),
    from: "        endpoint: 0.0.0.0:14250\n",
    to: "        endpoint: 0.0.0.0:14251\n",
    check: (v) => expect(protocol(v, "grpc")).toEqual({ endpoint: "0.0.0.0:14251" }),
  },
  {
    name: "jaeger Thrift HTTP Endpoint",
    key: JAEGER,
    edit: (user) => retypeInto(user, byId("thrift-http-endpoint"), "0.0.0.0:14269"),
    from: "        endpoint: 0.0.0.0:14268\n",
    to: "        endpoint: 0.0.0.0:14269\n",
    check: (v) => expect(protocol(v, "thrift_http")).toEqual({ endpoint: "0.0.0.0:14269" }),
  },
  {
    name: "jaeger Thrift Compact Queue Size over a bare 0750, its comment kept",
    key: JAEGER,
    edit: (user) => retypeInto(user, byId("thrift-compact-queue-size"), "2000"),
    from: "        queue_size: 0750 # a number to the collector\n",
    to: "        queue_size: 2000 # a number to the collector\n",
    check: (v) => expect(protocol(v, "thrift_compact").queue_size).toBe(2000),
  },
  {
    name: "jaeger Thrift Compact Workers",
    key: JAEGER,
    edit: (user) => retypeInto(user, byId("thrift-compact-workers"), "20"),
    from: "        workers: 10\n",
    to: "        workers: 20\n",
    check: (v) => expect(protocol(v, "thrift_compact").workers).toBe(20),
  },
  {
    name: "jaeger Thrift Binary Max Packet Size (unset)",
    key: JAEGER,
    edit: (user) => typeInto(user, byId("thrift-binary-max-packet"), "9000"),
    from: "        endpoint: localhost:6832\n",
    to: "        endpoint: localhost:6832\n        max_packet_size: 9000\n",
    check: (v) => expect(protocol(v, "thrift_binary")).toEqual({ endpoint: "localhost:6832", max_packet_size: 9000 }),
  },
  {
    name: "jaeger Thrift Binary unticked",
    key: JAEGER,
    edit: (user) => user.click(byId("protocol-thrift-binary")),
    from: "      thrift_binary:\n        endpoint: localhost:6832\n",
    to: "",
    check: (v) => expect(Object.keys(v.protocols as Value)).toEqual(["grpc", "thrift_http", "thrift_compact"]),
  },
  // zipkin
  {
    name: "zipkin receiver Endpoint",
    key: ZIPKIN_IN,
    edit: (user) => retypeInto(user, byId("endpoint"), "0.0.0.0:9412"),
    from: "    endpoint: 0.0.0.0:9411\n",
    to: "    endpoint: 0.0.0.0:9412\n",
    check: (v) => expect(v.endpoint).toBe("0.0.0.0:9412"),
  },
  {
    name: "zipkin receiver Parse String Tags",
    key: ZIPKIN_IN,
    edit: (user) => user.click(byId("parse-string-tags")),
    from: "    parse_string_tags: false\n",
    to: "    parse_string_tags: true\n",
    check: (v) => expect(v.parse_string_tags).toBe(true),
  },
  {
    name: "zipkin exporter Endpoint",
    key: ZIPKIN_OUT,
    edit: (user) => retypeInto(user, byId("endpoint"), "http://zipkin:9412/api/v2/spans"),
    from: "    endpoint: http://zipkin:9411/api/v2/spans\n",
    to: "    endpoint: http://zipkin:9412/api/v2/spans\n",
    check: (v) => expect(v.endpoint).toBe("http://zipkin:9412/api/v2/spans"),
  },
  {
    name: "zipkin exporter Format",
    key: ZIPKIN_OUT,
    edit: (user) => pickIn(user, byId("format"), "JSON"),
    from: "    format: proto\n",
    to: "    format: json\n",
    check: (v) => expect(v.format).toBe("json"),
  },
  // probabilistic_sampler
  {
    name: "probabilistic Sampling Percentage",
    key: PROB,
    edit: (user) => retypeInto(user, byId("sampling-percentage"), "20"),
    from: "    sampling_percentage: 15.3\n",
    to: "    sampling_percentage: 20\n",
    check: (v) => expect(v.sampling_percentage).toBe(20),
  },
  {
    name: "probabilistic Sampling Mode",
    key: PROB,
    edit: (user) => pickIn(user, byId("mode"), "Proportional"),
    from: "    mode: hash_seed\n",
    to: "    mode: proportional\n",
    check: (v) => expect(v.mode).toBe("proportional"),
  },
  {
    name: "probabilistic Hash Seed, its comment kept",
    key: PROB,
    edit: (user) => retypeInto(user, byId("hash-seed"), "23"),
    from: "    hash_seed: 22 # the same on every collector\n",
    to: "    hash_seed: 23 # the same on every collector\n",
    check: (v) => expect(v.hash_seed).toBe(23),
  },
  {
    name: "probabilistic Fail Closed",
    key: PROB,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await user.click(byId("fail-closed"));
    },
    from: "    fail_closed: true\n",
    to: "    fail_closed: false\n",
    check: (v) => expect(v.fail_closed).toBe(false),
  },
  {
    name: "probabilistic Sampling Precision (unset)",
    key: PROB,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await typeInto(user, byId("sampling-precision"), "6");
    },
    from: "    fail_closed: true\n",
    to: "    fail_closed: true\n    sampling_precision: 6\n",
    check: (v) => expect(v.sampling_precision).toBe(6),
  },
  {
    name: "probabilistic/logs Attribute Source",
    key: PROB_LOGS,
    edit: async (user) => {
      await openSection(user, "Logs Sampling");
      await pickIn(user, byId("attribute-source"), "TraceID");
    },
    from: "    attribute_source: record\n",
    to: "    attribute_source: traceID\n",
    check: (v) => expect(v.attribute_source).toBe("traceID"),
  },
  {
    name: "probabilistic/logs From Attribute",
    key: PROB_LOGS,
    edit: async (user) => {
      await openSection(user, "Logs Sampling");
      await retypeInto(user, byId("from-attribute"), "recordID");
    },
    from: "    from_attribute: logID\n",
    to: "    from_attribute: recordID\n",
    check: (v) => expect(v.from_attribute).toBe("recordID"),
  },
  {
    name: "probabilistic/logs Sampling Priority",
    key: PROB_LOGS,
    edit: async (user) => {
      await openSection(user, "Logs Sampling");
      await retypeInto(user, byId("sampling-priority"), "sampling.priority");
    },
    from: "    sampling_priority: priority\n",
    to: "    sampling_priority: sampling.priority\n",
    check: (v) => expect(v.sampling_priority).toBe("sampling.priority"),
  },
  // span
  {
    name: "span an attribute key appended to its flow list",
    key: SPAN,
    edit: (user) => user.type(screen.getByPlaceholderText("e.g. db.svc"), "peer.service{Enter}"),
    from: "      from_attributes: [db.svc, operation]\n",
    to: "      from_attributes: [db.svc, operation, peer.service]\n",
    check: (v) => expect((v.name as Value).from_attributes).toEqual(["db.svc", "operation", "peer.service"]),
  },
  {
    name: "span an attribute key removed",
    key: SPAN,
    edit: async (user) => {
      await user.click(within(screen.getByText("Attribute Keys").parentElement!).getAllByRole("button", { name: "Remove" })[0]!);
    },
    from: "      from_attributes: [db.svc, operation]\n",
    to: "      from_attributes: [operation]\n",
    check: (v) => expect((v.name as Value).from_attributes).toEqual(["operation"]),
  },
  {
    name: "span Separator",
    key: SPAN,
    edit: (user) => retypeInto(user, byId("span-separator"), "--"),
    from: '      separator: "::"\n',
    to: '      separator: "--"\n',
    check: (v) => expect((v.name as Value).separator).toBe("--"),
  },
  {
    name: "span Error Description",
    key: SPAN,
    edit: async (user) => {
      await openSection(user, "Status Override");
      await retypeInto(user, byId("span-status-description"), "upstream failed");
    },
    from: "      description: some error description\n",
    to: "      description: upstream failed\n",
    check: (v) => expect(v.status).toEqual({ code: "Error", description: "upstream failed" }),
  },
  {
    name: "span a regex rule appended, as typed (escapes included)",
    key: SPAN_RULES,
    // A typed `$` opens the field's variable picker (VaultAwareInput): the rule here has none.
    edit: (user) => user.type(screen.getByPlaceholderText(/^e\.g\. \^/), escapeKeys("^/users/(?P<userId>\\d+)/") + "{Enter}"),
    from: "          - '^/api/v1/document/(?P<documentId>[^/]+)/update'\n",
    to: "          - '^/api/v1/document/(?P<documentId>[^/]+)/update'\n          - ^/users/(?P<userId>\\d+)/\n",
    check: (v) =>
      expect(((v.name as Value).to_attributes as Value).rules).toEqual(["^/api/v1/document/(?P<documentId>[^/]+)/update", "^/users/(?P<userId>\\d+)/"]),
  },
  {
    name: "span Stop processing rules after the first match unticked",
    key: SPAN_RULES,
    edit: (user) => user.click(byId("span-break-after-match")),
    from: "        break_after_match: true\n",
    to: "",
    check: (v) => expect((v.name as Value).to_attributes).toEqual({ rules: ["^/api/v1/document/(?P<documentId>[^/]+)/update"] }),
  },
  {
    name: "span Keep the original span name (unset)",
    key: SPAN_RULES,
    edit: (user) => user.click(byId("span-keep-original-name")),
    from: "        break_after_match: true\n",
    to: "        break_after_match: true\n        keep_original_name: true\n",
    check: (v) => expect(((v.name as Value).to_attributes as Value).keep_original_name).toBe(true),
  },
  {
    name: "span the include Match Type",
    key: SPAN_RULES,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await pickIn(user, byId("include-match-type"), "Strict - Exact match");
    },
    from: "      match_type: regexp\n",
    to: "      match_type: strict\n",
    check: (v) => expect(v.include).toEqual({ match_type: "strict", services: ["auth.*"] }),
  },
  {
    name: "span an include service appended to its quoted flow list",
    key: SPAN_RULES,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.type(within(sideOf("Include")).getByPlaceholderText("e.g. frontend"), "billing{Enter}");
    },
    from: '      services: ["auth.*"]\n',
    to: '      services: ["auth.*", billing]\n',
    check: (v) => expect((v.include as Value).services).toEqual(["auth.*", "billing"]),
  },
  {
    name: "span the exclude side's first span name, with match_type strict",
    key: SPAN_RULES,
    edit: async (user) => {
      await openSection(user, "Filtering");
      await user.type(within(sideOf("Exclude")).getByPlaceholderText("e.g. http.request"), "health{Enter}");
    },
    from: "        break_after_match: true\n",
    to: "        break_after_match: true\n    exclude:\n      span_names:\n        - health\n      match_type: strict\n",
    check: (v) => expect(v.exclude).toEqual({ span_names: ["health"], match_type: "strict" }),
  },
  // spanmetrics
  {
    name: "spanmetrics Histogram Unit",
    key: SM,
    edit: (user) => pickIn(user, byId("histogram-unit"), "Seconds (s)"),
    from: "      unit: ms\n",
    to: "      unit: s\n",
    check: (v) => expect(histogram(v).unit).toBe("s"),
  },
  {
    name: "spanmetrics Histogram Buckets, by item in their flow list",
    key: SM,
    edit: (user) => retypeInto(user, byId("histogram-buckets"), DEFAULT_BUCKETS.replace("4ms", "5ms")),
    from: "        buckets: [2ms, 4ms, 6ms,",
    to: "        buckets: [2ms, 5ms, 6ms,",
    check: (v) => expect((histogram(v).explicit as Value).buckets).toEqual(DEFAULT_BUCKETS.replace("4ms", "5ms").split(", ")),
  },
  {
    name: "spanmetrics Disable Histogram (unset)",
    key: SM,
    edit: (user) => user.click(byId("disable-histogram")),
    from: "15s]\n",
    to: "15s]\n      disable: true\n",
    check: (v) => expect(histogram(v).disable).toBe(true),
  },
  {
    name: "spanmetrics a dimension's Default",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Dimensions");
      await retypeInto(user, byId("dimensions-0-default"), "POST");
    },
    from: "        default: GET\n",
    to: "        default: POST\n",
    check: (v) => expect(dimension(v, 0)).toEqual({ name: "http.method", default: "POST" }),
  },
  {
    name: "spanmetrics a dimension's Name",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Dimensions");
      await retypeInto(user, byId("dimensions-1-name"), "http.route");
    },
    from: "      - name: http.status_code\n",
    to: "      - name: http.route\n",
    check: (v) => expect(dimension(v, 1)).toEqual({ name: "http.route" }),
  },
  {
    name: "spanmetrics the first Exclude Dimension (unset)",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Dimensions");
      await user.click(screen.getByRole("button", { name: "Add Exclusion" }));
      await typeInto(user, byId("exclude-dimensions"), "status.code");
    },
    from: "    namespace: traces.span.metrics\n",
    to: "    namespace: traces.span.metrics\n    exclude_dimensions:\n      - status.code\n",
    check: (v) => expect(v.exclude_dimensions).toEqual(["status.code"]),
  },
  {
    name: "spanmetrics Aggregation Temporality",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Aggregation");
      await pickIn(user, byId("aggregation-temporality"), "Delta");
    },
    from: "    aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE\n",
    to: "    aggregation_temporality: AGGREGATION_TEMPORALITY_DELTA\n",
    check: (v) => expect(v.aggregation_temporality).toBe("AGGREGATION_TEMPORALITY_DELTA"),
  },
  {
    name: "spanmetrics Namespace",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Aggregation");
      await retypeInto(user, byId("namespace"), "spans");
    },
    from: "    namespace: traces.span.metrics\n",
    to: "    namespace: spans\n",
    check: (v) => expect(v.namespace).toBe("spans"),
  },
  {
    name: "spanmetrics Metrics Flush Interval",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Aggregation");
      await retypeInto(user, byId("flush-interval"), "30s");
    },
    from: "    metrics_flush_interval: 15s\n",
    to: "    metrics_flush_interval: 30s\n",
    check: (v) => expect(v.metrics_flush_interval).toBe("30s"),
  },
  {
    name: "spanmetrics Max Exemplars Per Data Point (unset)",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await typeInto(user, byId("max-exemplars"), "10");
    },
    from: "      enabled: true\n",
    to: "      enabled: true\n      max_per_data_point: 10\n",
    check: (v) => expect(v.exemplars).toEqual({ enabled: true, max_per_data_point: 10 }),
  },
  {
    name: "spanmetrics Aggregation Cardinality Limit 0 (unset)",
    key: SM,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await typeInto(user, byId("cardinality-limit"), "0");
    },
    from: "    namespace: traces.span.metrics\n",
    to: "    namespace: traces.span.metrics\n    aggregation_cardinality_limit: 0\n",
    check: (v) => expect(v.aggregation_cardinality_limit).toBe(0),
  },
  {
    name: "span_metrics/delta Exponential Max Size",
    key: SM_DELTA,
    edit: (user) => retypeInto(user, byId("exponential-max-size"), "200"),
    from: "        max_size: 160\n",
    to: "        max_size: 200\n",
    check: (v) => expect(histogram(v)).toEqual({ exponential: { max_size: 200 } }),
  },
  {
    name: "span_metrics/delta Metric Timestamp Cache Size",
    key: SM_DELTA,
    edit: async (user) => {
      await openSection(user, "Advanced");
      await retypeInto(user, byId("timestamp-cache-size"), "2000");
    },
    from: "    metric_timestamp_cache_size: 1000\n",
    to: "    metric_timestamp_cache_size: 2000\n",
    check: (v) => expect(v.metric_timestamp_cache_size).toBe(2000),
  },
];

describe("every field of each form writes only its key", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(CORPUS) : CORPUS;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(infoToasts()).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

describe("opening writes nothing", () => {
  /** What each form shows once opened, at least: its text fields, every control, and a field. */
  const OPENED: Record<string, { textboxes: number; all: number; field: string }> = {
    [JAEGER]: { textboxes: 12, all: 19, field: "thrift-compact-buffer" },
    [ZIPKIN_IN]: { textboxes: 1, all: 4, field: "parse-string-tags" },
    [ZIPKIN_OUT]: { textboxes: 1, all: 2, field: "format" },
    [PROB]: { textboxes: 4, all: 7, field: "hash-seed" },
    [PROB_LOGS]: { textboxes: 5, all: 8, field: "from-attribute" },
    [SPAN]: { textboxes: 10, all: 13, field: "span-status-description" },
    [SPAN_RULES]: { textboxes: 9, all: 14, field: "span-keep-original-name" },
    [SM]: { textboxes: 13, all: 19, field: "dimensions-1-default" },
    [SM_DELTA]: { textboxes: 8, all: 14, field: "timestamp-cache-size" },
  };
  // One test per form and text, each with its own time limit.
  it.each(Object.keys(OPENED).flatMap((key) => [[key, "LF", CORPUS] as const, [key, "CRLF", CRLF(CORPUS)] as const]))(
    "opening %s (%s), every section, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      const { textboxes, all } = formControls();
      expect(textboxes.length).toBeGreaterThanOrEqual(OPENED[key]!.textboxes);
      expect(all).toBeGreaterThanOrEqual(OPENED[key]!.all);
      expect(document.getElementById(OPENED[key]!.field)).not.toBeNull();
      for (const field of textboxes) {
        await user.click(field);
        await user.tab();
      }
      expect(text()).toBe(base);
      expect(entries()).toBe(0);
      expect(selectIsDirty(builderStore())).toBe(false);
    },
    20_000,
  );
});

// ── jaeger ──

const jaegerText = (lines: string) => ownText("receivers", "jaeger", lines);

describe("JaegerReceiverForm", () => {
  it("a bare grpc: (null) is on, as the collector has it (configoptional/optional.go:155-200): its endpoint, and its TLS under Security", async () => {
    const before = jaegerText("    protocols:\n      grpc:\n");
    const user = renderForm(JAEGER, before);
    expect(byId("protocol-grpc")).toBeChecked();
    expect(byId("protocol-thrift-http")).not.toBeChecked();
    expect(byId("grpc-endpoint")).toHaveValue("");
    await openSection(user, "Security");
    expect(screen.getByText("Enable TLS for gRPC")).toBeInTheDocument();
    expect(screen.queryByText("No TCP protocols enabled")).toBeNull();

    await typeInto(user, byId("grpc-endpoint"), "0.0.0.0:14250");
    expect(protocol(valueOf(JAEGER), "grpc")).toEqual({ endpoint: "0.0.0.0:14250" });
    expect(entries()).toBe(1);
  });

  it("ticking each protocol writes the 0.0.0.0 seed, one entry; unticking removes it", async () => {
    const user = renderForm(JAEGER, jaegerText("    protocols:\n      grpc:\n"));
    for (const [id, name] of [
      ["protocol-thrift-http", "thrift_http"],
      ["protocol-thrift-binary", "thrift_binary"],
      ["protocol-thrift-compact", "thrift_compact"],
    ] as const) {
      const before = entries();
      await user.click(byId(id));
      expect(protocol(valueOf(JAEGER), name)).toEqual({ endpoint: JAEGER_SEEDS[name] });
      expect(entries()).toBe(before + 1);
      stepPastRuns();
    }
    expect(JAEGER_SEEDS).toEqual({
      grpc: "0.0.0.0:14250",
      thrift_http: "0.0.0.0:14268",
      thrift_binary: "0.0.0.0:6832",
      thrift_compact: "0.0.0.0:6831",
    });
    await user.click(byId("protocol-grpc"));
    expect(Object.keys(valueOf(JAEGER).protocols as Value)).toEqual(["thrift_http", "thrift_binary", "thrift_compact"]);
    await user.click(byId("protocol-grpc"));
    expect(protocol(valueOf(JAEGER), "grpc")).toEqual({ endpoint: "0.0.0.0:14250" });
  });

  it("shows the collector's localhost defaults as placeholders and hints (factory.go:23-28)", () => {
    renderForm(JAEGER, jaegerText("    protocols:\n      grpc:\n      thrift_http:\n      thrift_binary:\n      thrift_compact:\n"));
    for (const [id, endpoint] of [
      ["grpc-endpoint", "localhost:14250"],
      ["thrift-http-endpoint", "localhost:14268"],
      ["thrift-binary-endpoint", "localhost:6832"],
      ["thrift-compact-endpoint", "localhost:6831"],
    ] as const) {
      expect(byId(id)).toHaveAttribute("placeholder", endpoint);
      expect(hint(`Listen address. · Default ${endpoint}`)).toBeInTheDocument();
    }
    expect(byId("thrift-binary-queue-size")).toHaveAttribute("placeholder", "1000");
    expect(byId("thrift-binary-max-packet")).toHaveAttribute("placeholder", "65000");
    expect(byId("thrift-binary-workers")).toHaveAttribute("placeholder", "10");
    expect(byId("thrift-binary-buffer")).toHaveAttribute("placeholder", "0");
    expect(screen.getAllByText((_c, e) => e?.tagName === "P" && e.textContent === "In bytes. · Default 0 (OS default)")).toHaveLength(2);
  });

  it("UDP tuning takes 0 (socket_buffer_size: 0 is the default, config.go:70-77), written plain under a null protocol; cleared removes it", async () => {
    const before = jaegerText("    protocols:\n      thrift_compact:\n");
    const user = renderForm(JAEGER, before);
    await typeInto(user, byId("thrift-compact-buffer"), "0");
    expect(protocol(valueOf(JAEGER), "thrift_compact")).toEqual({ socket_buffer_size: 0 });
    expect(byId("thrift-compact-buffer")).toHaveValue("0");
    await retypeInto(user, byId("thrift-compact-buffer"), "");
    expect(protocol(valueOf(JAEGER), "thrift_compact")).toEqual({});
  });

  it("with only UDP protocols on, Security shows the info alert, and Remote Sampling its alert", async () => {
    const user = renderForm(JAEGER, jaegerText("    protocols:\n      thrift_compact:\n"));
    await openSection(user, "Security");
    expect(screen.getByText("No TCP protocols enabled")).toBeInTheDocument();
    expect(screen.getByText("TLS and CORS apply only to gRPC and Thrift HTTP. Enable one above to configure them.")).toBeInTheDocument();
    await openSection(user, "Remote Sampling");
    expect(screen.getByText("Removed from this receiver")).toBeInTheDocument();
    expect(screen.getByText("jaegerremotesampling").parentElement).toHaveTextContent("Use the jaegerremotesampling extension instead.");
  });

  it("Thrift HTTP on shows its TLS and CORS sections", async () => {
    const user = renderForm(JAEGER, jaegerText("    protocols:\n      thrift_http:\n        endpoint: 0.0.0.0:14268\n"));
    await openSection(user, "Security");
    expect(screen.getByText("Enable TLS for Thrift HTTP")).toBeInTheDocument();
    expect(byId("cors-enable")).toBeInTheDocument();
    expect(screen.queryByText("No TCP protocols enabled")).toBeNull();
  });

  it("a protocol that is a scalar is on, read-only, with the unshowable-value hint; Security then shows the hint, not the alert", async () => {
    const user = renderForm(JAEGER, jaegerText("    protocols:\n      grpc: 0.0.0.0:14250\n"));
    expect(byId("protocol-grpc")).toBeChecked();
    expect(byId("protocol-grpc")).toBeDisabled();
    expect(document.getElementById("grpc-endpoint")).toBeNull();
    await openSection(user, "Security");
    expect(screen.getAllByText(UNSHOWABLE_VALUE_MESSAGE)).toHaveLength(2);
    expect(screen.queryByText("No TCP protocols enabled")).toBeNull();
  });

  it("a protocols that isn't a mapping makes every box read-only", () => {
    renderForm(JAEGER, jaegerText("    protocols: [grpc]\n"));
    for (const id of ["protocol-grpc", "protocol-thrift-http", "protocol-thrift-binary", "protocol-thrift-compact"]) expect(byId(id)).toBeDisabled();
  });
});

// ── zipkin ──

describe("ZipkinReceiverForm and ZipkinExporterForm", () => {
  it("the receiver's Endpoint shows the collector's localhost:9411 (factory.go:21); cleared, the key is removed (never \"\")", async () => {
    const user = renderForm(ZIPKIN_IN);
    expect(byId("endpoint")).toHaveAttribute("placeholder", "localhost:9411");
    expect(hint("Listen address. · Default localhost:9411")).toBeInTheDocument();
    await retypeInto(user, byId("endpoint"), "");
    expect(valueOf(ZIPKIN_IN)).toEqual({ parse_string_tags: false });
  });

  it("Parse String Tags writes true and false (unticked while unset, factory.go:42); Security has HTTP TLS and CORS", async () => {
    const user = renderForm(ZIPKIN_IN, ownText("receivers", "zipkin", ""));
    expect(byId("parse-string-tags")).not.toBeChecked();
    await user.click(byId("parse-string-tags"));
    expect(valueOf(ZIPKIN_IN)).toEqual({ parse_string_tags: true });
    await user.click(byId("parse-string-tags"));
    expect(valueOf(ZIPKIN_IN)).toEqual({ parse_string_tags: false });
    await openSection(user, "Security");
    expect(screen.getByText("Enable TLS for HTTP")).toBeInTheDocument();
    expect(byId("cors-enable")).toBeInTheDocument();
  });

  it("the exporter's Endpoint is required; Format unset is blank with JSON and Default json (factory.go:20-26)", async () => {
    const user = renderForm(ZIPKIN_OUT, ownText("exporters", "zipkin", "    endpoint: http://zipkin:9411/api/v2/spans\n"));
    expect(screen.getByText("Endpoint").querySelector("span")).toHaveTextContent("*");
    expect(byId("endpoint")).toHaveAttribute("placeholder", "e.g. http://zipkin:9411/api/v2/spans");
    expect(byId("format")).toHaveTextContent("JSON");
    expect(hint("Default json")).toBeInTheDocument();
    expect(await optionsOf(user, byId("format"))).toEqual(["JSON", "Protobuf"]);
    await pickIn(user, byId("format"), "Protobuf");
    expect(valueOf(ZIPKIN_OUT).format).toBe("proto");
  });

  it("a format the collector refuses (JSON, zipkin.go:50-56) shows as written", async () => {
    const user = renderForm(ZIPKIN_OUT, ownText("exporters", "zipkin", "    endpoint: http://z\n    format: JSON\n"));
    expect(byId("format")).toHaveTextContent("JSON");
    expect(await optionsOf(user, byId("format"))).toEqual(["JSON", "Protobuf", "JSON"]);
  });
});

// ── probabilistic_sampler ──

const probText = (lines: string) => ownText("processors", "probabilistic_sampler", lines);

describe("ProbabilisticSamplerForm", () => {
  it("an unset mode shows Hash Seed, Default hash_seed and its description (sampler_mode.go:69-70), with Hash Seed and its alert", () => {
    renderForm(PROB, probText("    sampling_percentage: 10\n"));
    expect(byId("mode")).toHaveTextContent("Hash Seed");
    expect(hint("Deterministic sampling by attribute hash. · Default hash_seed")).toBeInTheDocument();
    expect(byId("hash-seed")).toHaveAttribute("placeholder", "0");
    expect(screen.getByText("Seed must match")).toBeInTheDocument();
  });

  it("Hash Seed and its alert hide under proportional and equalizing; the mode's description follows it", async () => {
    const user = renderForm(PROB, probText("    mode: proportional\n    hash_seed: 22\n"));
    expect(document.getElementById("hash-seed")).toBeNull();
    expect(screen.queryByText("Seed must match")).toBeNull();
    expect(hint("Predictable output ratios, W3C compliant. Recommended. · Default hash_seed")).toBeInTheDocument();
    await pickIn(user, byId("mode"), "Equalizing");
    expect(hint("Adjusts for upstream sampling decisions (mixed SDKs). · Default hash_seed")).toBeInTheDocument();
    await pickIn(user, byId("mode"), "Hash Seed");
    expect(byId("hash-seed")).toHaveValue("22");
    expect(valueOf(PROB)).toEqual({ mode: "hash_seed", hash_seed: 22 });
  });

  it("Sampling Percentage is required, placeholder 0 and Default 0; cleared removes it (never 0)", async () => {
    const user = renderForm(PROB, probText("    sampling_percentage: 10\n    fail_closed: true\n"));
    expect(screen.getByText("Sampling Percentage").querySelector("span")).toHaveTextContent("*");
    expect(byId("sampling-percentage")).toHaveAttribute("placeholder", "0");
    expect(hint("Percent of items to keep; 0 rejects all, 100+ keeps all. · Default 0")).toBeInTheDocument();
    await retypeInto(user, byId("sampling-percentage"), "");
    expect(valueOf(PROB)).toEqual({ fail_closed: true });
  });

  it("Sampling Precision is written as typed, 0 and 15 included (config.go:125-129 refuses them), never clamped to 1-14", async () => {
    const user = renderForm(PROB, probText("    sampling_percentage: 10\n"));
    await openSection(user, "Advanced");
    expect(byId("sampling-precision")).toHaveAttribute("placeholder", "4");
    expect(hint("Hex digits for threshold encoding (1-14); higher is finer. · Default 4")).toBeInTheDocument();
    await typeInto(user, byId("sampling-precision"), "0");
    expect(valueOf(PROB).sampling_precision).toBe(0);
    await retypeInto(user, byId("sampling-precision"), "15");
    expect(valueOf(PROB).sampling_precision).toBe(15);
  });

  it("Fail Closed is ticked while unset (factory.go:32-39); Attribute Source unset is blank with TraceID and Default traceID", async () => {
    const user = renderForm(PROB, probText("    sampling_percentage: 10\n"));
    await openSection(user, "Advanced");
    expect(byId("fail-closed")).toBeChecked();
    await openSection(user, "Logs Sampling");
    expect(byId("attribute-source")).toHaveTextContent("TraceID");
    expect(hint("Randomness source for logs; traces always use the trace ID. · Default traceID")).toBeInTheDocument();
  });

  it("From Attribute shows while set or the source is record (config.go:90-92: read under traceID too)", async () => {
    const user = renderForm(PROB, probText("    sampling_percentage: 10\n"));
    await openSection(user, "Logs Sampling");
    expect(document.getElementById("from-attribute")).toBeNull();
    await pickIn(user, byId("attribute-source"), "Log Record Attribute");
    expect(byId("from-attribute")).toBeInTheDocument();
    await typeInto(user, byId("from-attribute"), "logID");
    await pickIn(user, byId("attribute-source"), "TraceID");
    expect(byId("from-attribute")).toHaveValue("logID");
    expect(valueOf(PROB)).toEqual({ sampling_percentage: 10, attribute_source: "traceID", from_attribute: "logID" });
  });

  it("From Attribute, once shown, stays shown for the form's session: cleared under traceID, it doesn't vanish", async () => {
    const before = probText("    sampling_percentage: 10\n    from_attribute: logID\n");
    const user = renderForm(PROB, before);
    await openSection(user, "Logs Sampling");
    await retypeInto(user, byId("from-attribute"), "");
    expect(valueOf(PROB)).toEqual({ sampling_percentage: 10 });
    expect(byId("from-attribute")).toHaveValue("");
    // Typed again, it is written again.
    await typeInto(user, byId("from-attribute"), "recordID");
    expect(valueOf(PROB)).toEqual({ sampling_percentage: 10, from_attribute: "recordID" });

    // Shown for the source record: chosen back to TraceID, it stays.
    cleanup();
    const user2 = renderForm(PROB, probText("    sampling_percentage: 10\n"));
    await openSection(user2, "Logs Sampling");
    await pickIn(user2, byId("attribute-source"), "Log Record Attribute");
    await pickIn(user2, byId("attribute-source"), "TraceID");
    expect(byId("from-attribute")).toHaveValue("");

    // Another session (another component or load mounts the form again) starts from the text: not shown.
    cleanup();
    const user3 = renderForm(PROB, probText("    sampling_percentage: 10\n"));
    await openSection(user3, "Logs Sampling");
    expect(document.getElementById("from-attribute")).toBeNull();
  });
});

// ── span ──

const spanText = (lines: string) => ownText("processors", "span", lines);

describe("SpanProcessorForm cases", () => {
  const PALETTE = paletteText("processor", "span");

  it("renders the default extraction rule", () => {
    renderForm(SPAN, PALETTE);
    const rule = [...document.querySelectorAll("input")].find((input) => input.value === "^\\/api\\/v1\\/document\\/(?P<documentId>.*)\\/update$");
    expect(rule).toBeInTheDocument();
  });

  it("renders collapsible section headers", () => {
    renderForm(SPAN, PALETTE);
    expect(screen.getByRole("button", { name: "Rename From Attributes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Extract Attributes From Name/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status Override" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filtering" })).toBeInTheDocument();
  });

  it("warns when no rename, extraction, or status action is configured", () => {
    renderForm(SPAN, spanText(""));
    expect(screen.getByText(/an empty span processor fails collector validation/)).toBeInTheDocument();
  });

  it("does not warn when the default extraction rule is present", () => {
    renderForm(SPAN, PALETTE);
    expect(screen.queryByText(/an empty span processor fails collector validation/)).not.toBeInTheDocument();
  });

  it("edits the palette's span processor in a traces pipeline in place: only the edited lines change (was: generates valid YAML)", async () => {
    const user = renderForm(SPAN, PALETTE);
    await user.click(byId("span-keep-original-name"));
    expect(text()).toBe(PALETTE.replace("update$\n", "update$\n        keep_original_name: true\n"));
    expect(((valueOf(SPAN).name as Value).to_attributes as Value).keep_original_name).toBe(true);
  });

  it("shows rename, extraction, status and filter config read from the text (was: survives a YAML round-trip)", async () => {
    const user = renderForm(SPAN);
    expect(byId("span-separator")).toHaveValue("::");
    expect(screen.getByDisplayValue("db.svc")).toBeInTheDocument();
    expect(screen.getByDisplayValue("operation")).toBeInTheDocument();
    await openSection(user, "Status Override");
    expect(byId("span-status-code")).toHaveTextContent("Error");
    expect(byId("span-status-description")).toHaveValue("some error description");
    cleanup();
    const again = renderForm(SPAN_RULES);
    expect(byId("span-break-after-match")).toBeChecked();
    expect(byId("span-keep-original-name")).not.toBeChecked();
    await openSection(again, "Filtering");
    expect(within(sideOf("Include")).getByDisplayValue("auth.*")).toBeInTheDocument();
    expect(byId("include-match-type")).toHaveTextContent("Regexp - Pattern match");
  });

  it("keeps the span processor distinct from the spanmetrics connector", () => {
    openText(spanText("    name:\n      from_attributes: [db.svc]\n"));
    expect(componentNamed(SPAN).data.componentType).toBe("processor");
    expect(formFor("processor", "span")).toBe(SpanProcessorForm);
    expect(formFor("connector", "spanmetrics")).toBe(SpanmetricsConnectorForm);
    expect(formFor("connector", "span")).toBeUndefined();
    expect(formFor("processor", "spanmetrics")).toBeUndefined();
  });
});

describe("SpanProcessorForm: the status code", () => {
  const errorText = spanText("    status:\n      code: Error\n      description: upstream failed # why\n");

  it.each(["Ok", "Unset"])(
    "%s while the text has a description removes it in the same change, one entry, with the toast (factory.go:35, 70-72)",
    async (code) => {
      const user = renderForm(SPAN, errorText);
      await openSection(user, "Status Override");
      await pickIn(user, byId("span-status-code"), code);
      expect(valueOf(SPAN).status).toEqual({ code });
      expect(text()).toBe(errorText.replace("      code: Error\n      description: upstream failed # why\n", `      code: ${code}\n`));
      expect(entries()).toBe(1);
      expect(infoToasts()).toEqual([REMOVED_DESCRIPTION]);
      expect(document.getElementById("span-status-description")).toBeNull();
    },
  );

  it("a code with no description to remove writes the code alone, with no toast", async () => {
    const user = renderForm(SPAN, spanText("    status:\n      code: Ok\n"));
    await openSection(user, "Status Override");
    await pickIn(user, byId("span-status-code"), "Error");
    expect(valueOf(SPAN).status).toEqual({ code: "Error" });
    await pickIn(user, byId("span-status-code"), "Unset");
    expect(valueOf(SPAN).status).toEqual({ code: "Unset" });
    expect(infoToasts()).toEqual([]);
  });

  it("Leave status unchanged removes status, with no toast; the select is labeled (fixed id span-status-code)", async () => {
    const user = renderForm(SPAN, errorText);
    await openSection(user, "Status Override");
    expect(screen.getByLabelText("Status Code")).toBe(byId("span-status-code"));
    expect(await optionsOf(user, byId("span-status-code"))).toEqual(["Leave status unchanged", "Ok", "Error", "Unset"]);
    await pickIn(user, byId("span-status-code"), "Leave status unchanged");
    expect(valueOf(SPAN)).toEqual({});
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    expect(byId("span-status-code")).toHaveTextContent("Leave status unchanged");
  });

  it("a code the collector refuses (ERROR, factory.go:67-68) shows as written; Error Description shows under Error only", async () => {
    const user = renderForm(SPAN, spanText("    status:\n      code: ERROR\n"));
    await openSection(user, "Status Override");
    expect(byId("span-status-code")).toHaveTextContent("ERROR");
    expect(document.getElementById("span-status-description")).toBeNull();
    expect(await optionsOf(user, byId("span-status-code"))).toEqual(["Leave status unchanged", "Ok", "Error", "Unset", "ERROR"]);
  });

  it("a status that isn't a mapping is read-only with the unshowable-value hint", async () => {
    const user = renderForm(SPAN, spanText("    status: Error\n"));
    await openSection(user, "Status Override");
    expect(byId("span-status-code")).toBeDisabled();
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });
});

describe("SpanProcessorForm: the lists", () => {
  it("removing the last regex rule removes name.to_attributes, its boxes with it", async () => {
    const user = renderForm(SPAN_RULES);
    await user.click(within(screen.getByText("Regex Rules").parentElement!).getByRole("button", { name: "Remove" }));
    expect(valueOf(SPAN_RULES).name).toEqual({});
    expect(entries()).toBe(1);
    expect(document.getElementById("span-break-after-match")).toBeNull();
  });

  it("removing the last attribute key removes name.from_attributes; the separator stays", async () => {
    const user = renderForm(SPAN, spanText("    name:\n      from_attributes: [db.svc]\n      separator: '::'\n"));
    await user.click(within(screen.getByText("Attribute Keys").parentElement!).getByRole("button", { name: "Remove" }));
    expect(valueOf(SPAN).name).toEqual({ separator: "::" });
  });

  it("Separator cleared removes its key", async () => {
    const user = renderForm(SPAN, spanText("    name:\n      from_attributes: [a]\n      separator: '::'\n"));
    await retypeInto(user, byId("span-separator"), "");
    expect(valueOf(SPAN).name).toEqual({ from_attributes: ["a"] });
  });
});

describe("SpanProcessorForm: the filters", () => {
  it("a side's first service is written with match_type: strict, one entry (filterset/config.go:38-48 refuses names without one)", async () => {
    const user = renderForm(SPAN, spanText("    status:\n      code: Ok\n"));
    await openSection(user, "Filtering");
    expect(byId("include-match-type")).toHaveTextContent("Strict - Exact match");
    expect(queryHint("Default strict")).toBeNull();
    await user.type(within(sideOf("Include")).getByPlaceholderText("e.g. frontend"), "frontend{Enter}");
    expect(valueOf(SPAN).include).toEqual({ services: ["frontend"], match_type: "strict" });
    expect(entries()).toBe(1);
  });

  it("a match chosen on a side with no names is held (filterconfig/config.go:162-165 refuses it alone), then written with the first name", async () => {
    const before = spanText("    status:\n      code: Ok\n");
    const user = renderForm(SPAN, before);
    await openSection(user, "Filtering");
    await pickIn(user, byId("exclude-match-type"), "Regexp - Pattern match");
    expect(text()).toBe(before);
    expect(byId("exclude-match-type")).toHaveTextContent("Regexp - Pattern match");
    await user.type(within(sideOf("Exclude")).getByPlaceholderText("e.g. http.request"), "GET /health.*{Enter}");
    expect(valueOf(SPAN).exclude).toEqual({ span_names: ["GET /health.*"], match_type: "regexp" });
    expect(entries()).toBe(1);
  });

  it("a side with names and no match_type (refused) shows the match blank; its next name is written with strict", async () => {
    const user = renderForm(SPAN, spanText("    include:\n      services: [a]\n"));
    await openSection(user, "Filtering");
    expect(byId("include-match-type")).not.toHaveTextContent(/Strict|Regexp/);
    await user.type(within(sideOf("Include")).getByPlaceholderText("e.g. http.request"), "b{Enter}");
    expect(valueOf(SPAN).include).toEqual({ services: ["a"], span_names: ["b"], match_type: "strict" });
  });

  it("removing a side's last name removes the side when only match_type is left, one entry", async () => {
    const user = renderForm(SPAN, spanText("    status:\n      code: Ok\n    include:\n      match_type: strict\n      services: [a]\n"));
    await openSection(user, "Filtering");
    await user.click(within(sideOf("Include")).getByRole("button", { name: "Remove" }));
    expect(valueOf(SPAN)).toEqual({ status: { code: "Ok" } });
    expect(entries()).toBe(1);
  });

  it("removing a side's last name keeps the side while another list or a key no field shows is in it", async () => {
    const user = renderForm(
      SPAN,
      spanText("    include:\n      match_type: strict\n      services: [a]\n      span_names: [b]\n    exclude:\n      match_type: strict\n      services: [c]\n      span_kinds: [SPAN_KIND_CLIENT]\n"),
    );
    await openSection(user, "Filtering");
    await user.click(within(sideOf("Include")).getAllByRole("button", { name: "Remove" })[0]!);
    expect(valueOf(SPAN).include).toEqual({ match_type: "strict", span_names: ["b"] });
    await user.click(within(sideOf("Exclude")).getByRole("button", { name: "Remove" }));
    expect(valueOf(SPAN).exclude).toEqual({ match_type: "strict", span_kinds: ["SPAN_KIND_CLIENT"] });
  });

  it("the Filtering count is both sides' names; a side that isn't a mapping is read-only with the unshowable-value hint", async () => {
    const user = renderForm(SPAN, spanText("    include:\n      match_type: strict\n      services: [a, b]\n      span_names: [c]\n    exclude: [x]\n"));
    expect(screen.getByRole("button", { name: /^Filtering\s*3$/ })).toBeInTheDocument();
    await openSection(user, "Filtering");
    expect(within(sideOf("Exclude")).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("Span kind and attribute filters are available in the YAML editor.")).toBeInTheDocument();
  });
});

// ── spanmetrics ──

const smText = (lines: string) => ownText("connectors", "spanmetrics", lines);

describe("SpanmetricsConnectorForm: the buckets", () => {
  it("each bucket is written as typed: 2ms a duration string, a bare number plain (config.go:139-144 reads []time.Duration)", async () => {
    const user = renderForm(SM, smText(""));
    await typeInto(user, byId("histogram-buckets"), "2ms, 1s, 100");
    expect(valueOf(SM)).toEqual({ histogram: { explicit: { buckets: ["2ms", "1s", 100] } } });
    expect(text()).toContain("        buckets:\n          - 2ms\n          - 1s\n          - 100\n");
    expect(entries()).toBe(1);
  });

  it("shows the corrected copy and the 16 defaults as the placeholder (config.go:25-27)", () => {
    renderForm(SM, smText(""));
    expect(byId("histogram-buckets")).toHaveAttribute("placeholder", DEFAULT_BUCKETS);
    expect(hint("Comma-separated durations, e.g. 2ms, 100ms, 1s. A number without a unit is read as nanoseconds.")).toBeInTheDocument();
    expect(hint("Unit the duration metrics are recorded in. · Default ms")).toBeInTheDocument();
    expect(byId("histogram-unit")).toHaveTextContent("Milliseconds (ms)");
  });

  it("cleared removes histogram.explicit, so the collector's defaults apply (connector.go:211-225)", async () => {
    const user = renderForm(SM, smText("    histogram:\n      unit: ms\n      explicit:\n        buckets: [2ms, 4ms]\n"));
    await retypeInto(user, byId("histogram-buckets"), "");
    expect(valueOf(SM)).toEqual({ histogram: { unit: "ms" } });
    expect(entries()).toBe(1);
  });

  it("shows the items joined \", \"; a draft ending in \", \" waits past the pause, and the next item is written after it", () => {
    const before = smText("    histogram:\n      explicit:\n        buckets: [2ms, 4ms]\n");
    renderForm(SM, before);
    vi.useFakeTimers();
    const field = byId("histogram-buckets");
    expect(field).toHaveValue("2ms, 4ms");
    const typeAtEnd = (typed: string) => act(() => void fireEvent.change(field, { target: { value: (field as HTMLInputElement).value + typed } }));
    const pause = () => act(() => void vi.advanceTimersByTime(FIELD_WRITE_DELAY_MS + 100));

    typeAtEnd(",");
    pause();
    typeAtEnd(" ");
    pause();
    expect(text()).toBe(before);
    expect(field).toHaveValue("2ms, 4ms, ");

    typeAtEnd("1s");
    pause();
    expect(text()).toBe(before.replace("buckets: [2ms, 4ms]", "buckets: [2ms, 4ms, 1s]"));
    expect(field).toHaveValue("2ms, 4ms, 1s");
    expect(entries()).toBe(1);
  });
});

describe("SpanmetricsConnectorForm: explicit or exponential (config.go:172-174)", () => {
  it("buckets typed while exponential is set remove it, one entry, with the toast", async () => {
    const before = LF(CORPUS);
    const user = renderForm(SM_DELTA, before);
    await typeInto(user, byId("histogram-buckets"), "2ms, 1s");
    expect(histogram(valueOf(SM_DELTA))).toEqual({ explicit: { buckets: ["2ms", "1s"] } });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_EXPONENTIAL]);
  });

  it("Exponential Max Size typed while explicit is set removes it, one entry, with the toast", async () => {
    const user = renderForm(SM);
    await typeInto(user, byId("exponential-max-size"), "100");
    expect(histogram(valueOf(SM))).toEqual({ unit: "ms", exponential: { max_size: 100 } });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_EXPLICIT]);
  });

  it("a null explicit is unset to the collector (configoptional/optional.go:176): kept, no toast", async () => {
    const user = renderForm(SM, smText("    histogram:\n      explicit:\n"));
    await typeInto(user, byId("exponential-max-size"), "100");
    expect(text()).toContain("      explicit:\n");
    expect(infoToasts()).toEqual([]);
  });

  it("Max Size cleared removes max_size only: exponential: {} stays, an exponential histogram at 160 (connector.go initHistogramMetrics), no toast", async () => {
    const user = renderForm(SM, smText("    histogram:\n      unit: s\n      exponential:\n        max_size: 160\n"));
    await retypeInto(user, byId("exponential-max-size"), "");
    expect(valueOf(SM)).toEqual({ histogram: { unit: "s", exponential: {} } });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    expect(byId("exponential-max-size")).toHaveValue("");
    expect(hint(EXPONENTIAL_IN_USE)).toBeInTheDocument();
  });

  it("Histogram Buckets says exponential buckets are in use while histogram.exponential is set, {} included", async () => {
    for (const exponential of ["      exponential:\n        max_size: 100\n", "      exponential: {}\n"]) {
      const user = renderForm(SM, smText(`    histogram:\n${exponential}`));
      expect(hint(EXPONENTIAL_IN_USE)).toBeInTheDocument();
      // Buckets typed: the cascade and its toast as before; the hint goes with exponential.
      await typeInto(user, byId("histogram-buckets"), "2ms");
      expect(histogram(valueOf(SM))).toEqual({ explicit: { buckets: ["2ms"] } });
      expect(infoToasts()).toEqual([REMOVED_EXPONENTIAL]);
      expect(queryHint(EXPONENTIAL_IN_USE)).toBeNull();
      cleanup();
      vi.mocked(toast.info).mockClear();
    }
    for (const without of ["    histogram:\n      explicit:\n        buckets: [2ms]\n", "    histogram:\n      exponential:\n", ""]) {
      renderForm(SM, smText(without));
      expect(queryHint(EXPONENTIAL_IN_USE)).toBeNull();
      cleanup();
    }
  });

  it("with explicit and exponential both written, which the collector refuses (config.go:172-174), Histogram Buckets says so instead", () => {
    for (const both of [
      "    histogram:\n      explicit:\n        buckets: [2ms]\n      exponential:\n        max_size: 100\n",
      "    histogram:\n      explicit: {}\n      exponential: {}\n",
    ]) {
      renderForm(SM, smText(both));
      expect(hint(BOTH_HISTOGRAMS)).toBeInTheDocument();
      expect(queryHint(EXPONENTIAL_IN_USE)).toBeNull();
      cleanup();
    }
    // Only a mapping is exponential buckets in use: a null one is unset to the collector (optional.go:176),
    // and with a null explicit beside a mapping, exponential is the one in use.
    for (const [shape, inUse] of [
      ["    histogram:\n      explicit:\n      exponential: {}\n", true],
      ["    histogram:\n      explicit:\n        buckets: [2ms]\n      exponential:\n", false],
    ] as const) {
      renderForm(SM, smText(shape));
      expect(queryHint(EXPONENTIAL_IN_USE) !== null).toBe(inUse);
      expect(queryHint(BOTH_HISTOGRAMS)).toBeNull();
      cleanup();
    }
  });

  it("buckets cleared beside exponential write no cascade", async () => {
    const user = renderForm(SM, smText("    histogram:\n      explicit:\n        buckets: [2ms]\n"));
    await retypeInto(user, byId("histogram-buckets"), "");
    expect(infoToasts()).toEqual([]);
  });
});

describe("SpanmetricsConnectorForm: temporality (config.go:188-193, 206-213)", () => {
  it("Delta while metric_timestamp_cache_size is 0 removes it in the same change, one entry, with the toast", async () => {
    const before = smText("    aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE\n    metric_timestamp_cache_size: 0\n");
    const user = renderForm(SM, before);
    await openSection(user, "Aggregation");
    await pickIn(user, byId("aggregation-temporality"), "Delta");
    expect(valueOf(SM)).toEqual({ aggregation_temporality: "AGGREGATION_TEMPORALITY_DELTA" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_TIMESTAMP_CACHE]);
  });

  it("Delta beside a positive cache size keeps it, with no toast", async () => {
    const user = renderForm(SM, smText("    metric_timestamp_cache_size: 500\n"));
    await openSection(user, "Aggregation");
    await pickIn(user, byId("aggregation-temporality"), "Delta");
    expect(valueOf(SM)).toEqual({ metric_timestamp_cache_size: 500, aggregation_temporality: "AGGREGATION_TEMPORALITY_DELTA" });
    expect(infoToasts()).toEqual([]);
  });

  it("unset is blank with Default Cumulative; the palette's CUMULATIVE shows as written with the hint (anything but the exact DELTA is cumulative)", async () => {
    const user = renderForm(SM, smText(""));
    await openSection(user, "Aggregation");
    expect(byId("aggregation-temporality")).toHaveTextContent("Cumulative");
    expect(hint("How metric values accumulate over time. · Default Cumulative")).toBeInTheDocument();
    expect(queryHint(TEMPORALITY_HINT)).toBeNull();
    cleanup();
    const again = renderForm(SM, smText("    aggregation_temporality: DELTA\n"));
    await openSection(again, "Aggregation");
    expect(byId("aggregation-temporality")).toHaveTextContent("DELTA");
    expect(hint(TEMPORALITY_HINT)).toBeInTheDocument();
    expect(await optionsOf(again, byId("aggregation-temporality"))).toEqual(["Cumulative", "Delta", "DELTA"]);
  });
});

describe("SpanmetricsConnectorForm: events and dimensions", () => {
  it("Enable Events Metrics with no dimensions also writes the README's exception.type dimension, one entry, no toast (config.go:168-170)", async () => {
    const user = renderForm(SM, smText("    namespace: spans\n"));
    await openSection(user, "Advanced");
    await user.click(byId("events-enabled"));
    expect(valueOf(SM).events).toEqual({ enabled: true, dimensions: [{ name: "exception.type" }] });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([]);
    expect(byId("events-dimensions-0-name")).toHaveValue("exception.type");
  });

  it("Enable Events Metrics beside dimensions writes enabled alone; unticking writes false", async () => {
    const user = renderForm(SM, smText("    events:\n      enabled: false\n      dimensions:\n        - name: error.kind\n"));
    await openSection(user, "Advanced");
    await user.click(byId("events-enabled"));
    expect(valueOf(SM).events).toEqual({ enabled: true, dimensions: [{ name: "error.kind" }] });
    await user.click(byId("events-enabled"));
    expect(valueOf(SM).events).toEqual({ enabled: false, dimensions: [{ name: "error.kind" }] });
  });

  it("a text with events on and no dimensions opens Advanced with the Dimension required alert", () => {
    renderForm(SM, smText("    events:\n      enabled: true\n"));
    expect(screen.getByText("Dimension required")).toBeInTheDocument();
    expect(screen.getByText("Add at least one span event attribute when events metrics are enabled.")).toBeInTheDocument();
  });

  it("Add Dimension holds a row: nothing written until a name is typed, then {name} (never {name: \"\"}, config.go:238-241)", async () => {
    const before = smText("    namespace: spans\n");
    const user = renderForm(SM, before);
    await user.click(screen.getAllByRole("button", { name: "Add Dimension" })[0]!);
    expect(text()).toBe(before);
    await typeInto(user, byId("histogram-dimensions-0-name"), "http.route");
    expect(valueOf(SM)).toEqual({ namespace: "spans", histogram: { dimensions: [{ name: "http.route" }] } });
    expect(entries()).toBe(1);
  });

  it("the string lists hold their rows; Exclude Dimensions emptied leaves [], the other two remove their key", async () => {
    const before = smText("    exclude_dimensions: [status.code]\n    include_instrumentation_scope: [a]\n    resource_metrics_key_attributes: [service.name]\n");
    const user = renderForm(SM, before);
    await openSection(user, "Dimensions");
    await user.click(screen.getByRole("button", { name: "Add Scope" }));
    expect(text()).toBe(before);
    // Each list's Remove is the one after its first row's input.
    const removeOf = (field: string) =>
      screen.getAllByRole("button", { name: "Remove" }).find((button) => byId(field).compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)!;
    await user.click(removeOf("exclude-dimensions"));
    await user.click(removeOf("include-instrumentation-scope"));
    await openSection(user, "Advanced");
    await user.click(removeOf("resource-metrics-key-attributes"));
    expect(valueOf(SM)).toEqual({ exclude_dimensions: [] });
  });

  it("Add Resource Attributes writes true, unticked removes it; its copy says resource attributes are kept either way", async () => {
    const user = renderForm(SM, smText("    namespace: spans\n"));
    await openSection(user, "Advanced");
    expect(screen.getByText("Resource attributes are kept either way unless the connector.spanmetrics.excludeResourceMetrics feature gate is on.")).toBeInTheDocument();
    await user.click(byId("add-resource-attributes"));
    expect(valueOf(SM).add_resource_attributes).toBe(true);
    await user.click(byId("add-resource-attributes"));
    expect(valueOf(SM)).toEqual({ namespace: "spans" });
  });

  it("shows the corrected copy for Exclude Dimensions and Include Instrumentation Scopes (connector.go:600-610)", async () => {
    const user = renderForm(SM, smText(""));
    await openSection(user, "Dimensions");
    expect(screen.getByText("Drop default dimensions (service.name, span.name, span.kind, status.code, collector.instance.id).")).toBeInTheDocument();
    expect(screen.getByText("Adds the scope name and version as dimensions for spans from these instrumentation scopes.")).toBeInTheDocument();
  });

  it("the span_metrics spelling opens this form (connector/spanmetricsconnector/metadata.yaml:1-2)", () => {
    expect(RENAMED_TYPES.connector.span_metrics).toBe("spanmetrics");
    expect(formFor("connector", "span_metrics")).toBe(SpanmetricsConnectorForm);
    expect(findPaletteEntry("connector", paletteSubType("span_metrics", "connector"))?.subType).toBe("spanmetrics");
    renderForm(SM_DELTA);
    expect(byId("exponential-max-size")).toHaveValue("160");
  });
});

// ── Privacy ──

describe("privacy", () => {
  it("puts no config value in any attribute: every section open, the menus open, held rows", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  jaeger:",
      "    protocols:",
      "      grpc:",
      `        endpoint: ${MARK}-grpc`,
      "      thrift_http:",
      `        endpoint: ${MARK}-http`,
      "      thrift_compact:",
      `        endpoint: ${MARK}-compact`,
      `        queue_size: ${MARK}-queue`,
      "  zipkin:",
      `    endpoint: ${MARK}-zipkin`,
      "processors:",
      "  probabilistic_sampler:",
      `    sampling_percentage: ${MARK}-pct`,
      `    mode: ${MARK}-mode`,
      `    attribute_source: ${MARK}-source`,
      `    from_attribute: ${MARK}-from`,
      `    sampling_priority: ${MARK}-priority`,
      "  span:",
      "    name:",
      `      from_attributes: [${MARK}-attr]`,
      `      separator: ${MARK}-sep`,
      "      to_attributes:",
      `        rules: [${MARK}-rule]`,
      "    status:",
      `      code: ${MARK}-code`,
      "    include:",
      `      match_type: ${MARK}-match`,
      `      services: [${MARK}-service]`,
      `      span_names: [${MARK}-span]`,
      "exporters:",
      "  zipkin:",
      `    endpoint: ${MARK}-out`,
      `    format: ${MARK}-format`,
      "  debug:",
      "connectors:",
      "  spanmetrics:",
      "    histogram:",
      `      unit: ${MARK}-unit`,
      "      explicit:",
      `        buckets: [${MARK}-bucket]`,
      "      dimensions:",
      `        - name: ${MARK}-hd`,
      `          default: ${MARK}-hdd`,
      "    dimensions:",
      `      - name: ${MARK}-dim`,
      `    exclude_dimensions: [${MARK}-ex]`,
      `    aggregation_temporality: ${MARK}-temp`,
      `    namespace: ${MARK}-ns`,
      "    events:",
      "      enabled: true",
      "      dimensions:",
      `        - name: ${MARK}-ev`,
      `    resource_metrics_key_attributes: [${MARK}-rk]`,
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [jaeger, zipkin]",
      "      processors: [probabilistic_sampler, span]",
      "      exporters: [zipkin, spanmetrics]",
      "    metrics:",
      "      receivers: [spanmetrics]",
      "      exporters: [debug]",
      "",
    ].join("\n");

    const leaks: string[] = [];
    const scan = (where: string) => {
      for (const element of document.querySelectorAll("*")) {
        // A controlled field's value property is its content, not an attribute: the replay masks inputs.
        for (const attribute of element.attributes) {
          if (attribute.name !== "value" && attribute.value.includes(MARK)) leaks.push(`${where}: ${element.tagName}[${attribute.name}]`);
        }
        if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(MARK)) leaks.push(`${where}: option value`);
      }
    };
    const shown = () => document.body.textContent + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join();

    const runs: [string, readonly string[]][] = [
      [JAEGER, []],
      [ZIPKIN_IN, []],
      [ZIPKIN_OUT, ["format"]],
      [PROB, ["mode", "attribute-source"]],
      [SPAN, ["span-status-code", "include-match-type"]],
      [SM, ["histogram-unit", "aggregation-temporality"]],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, marked);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }

      // Held rows show what the text has around them.
      for (const name of ["Add Dimension", "Add Exclusion", "Add Attribute"]) {
        for (const add of screen.queryAllByRole("button", { name })) await user.click(add);
      }
      scan(`${key} (held)`);
      expect(text()).toBe(marked);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 30_000);
});

// ── The copy, word for word ──

describe("the forms' copy", () => {
  it("the toasts', hints' and alerts' words, exactly", () => {
    expect(REMOVED_DESCRIPTION).toBe("Removed the error description: it's only used with Error.");
    expect(REMOVED_EXPLICIT).toBe("Removed the explicit buckets: the collector uses either explicit or exponential buckets.");
    expect(REMOVED_EXPONENTIAL).toBe("Removed the exponential histogram: the collector uses either explicit or exponential buckets.");
    expect(EXPONENTIAL_IN_USE).toBe("Exponential buckets are in use; typing buckets switches to explicit.");
    expect(BOTH_HISTOGRAMS).toBe("The collector refuses explicit and exponential buckets together. Remove one in the YAML below.");
    expect(REMOVED_TIMESTAMP_CACHE).toBe("Removed metric_timestamp_cache_size: delta temporality needs a positive cache size.");
    expect(TEMPORALITY_HINT).toBe("The collector reads anything but AGGREGATION_TEMPORALITY_DELTA as cumulative.");
    expect(DEFAULT_BUCKETS).toBe("2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s");
    expect(EMPTY_SPAN_WARNING).toBe(
      "Configure at least a rename, an extraction rule, or a status override — an empty span processor fails collector validation.",
    );
  });
});
