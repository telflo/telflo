import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { DATADOG_SITES, DATADOG_TOASTS, DatadogExporterForm, FIRST_RESOURCE_HINT } from "./DatadogExporterForm.js";
import {
  COMPRESSION_HINT,
  COMPRESSION_ITEMS,
  DatadogReceiverForm,
  IGNORED_FLAT_HINT,
  movedNoOpToast,
  movedToast,
  NOW_OFF_TOAST,
  removedNoOpToast,
  removedToast,
} from "./DatadogReceiverForm.js";
import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "./form-context.js";
import { formFor } from "./registry.js";
import { FIELD_WRITE_DELAY_MS } from "~/lib/editor/held-text.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The Datadog exporter and receiver: their forms over the form contract.
 * Each field is driven as a person would on the vendors corpus text
 * (comments, an anchor and its merges, flow lists, `${env:…}` references,
 * CRLF as the file has it, and LF), and writes only its key. The fixes
 * have tests that fail if the bug returns.
 *
 * Collector claims cite contrib v0.162.0 (`pkg/datadog/config`,
 * `receiver/datadogreceiver`) and core v0.162.0 (`config/confighttp`).
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The vendors corpus (LF); the file itself is CRLF. */
const CORPUS = LF(corpusText("forms-vendors.yaml"));

const EX = "exporters.datadog";
const EX_META = "exporters.datadog/metadata";
const RX = "receivers.datadog";
const RX_LEGACY = "receivers.datadog/legacy";

/** A text holding only a datadog exporter (its lines at four spaces), in a traces pipeline. */
function ownExporter(lines: string): string {
  const body = lines.trimEnd() === "" ? ["  datadog: {}"] : ["  datadog:", lines.trimEnd()];
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "exporters:",
    ...body,
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      exporters: [datadog]",
    "",
  ].join("\n");
}

/** A text holding only a datadog receiver (its lines at four spaces), in a traces pipeline. */
function ownReceiver(lines: string): string {
  const body = lines.trimEnd() === "" ? ["  datadog: {}"] : ["  datadog:", lines.trimEnd()];
  return [
    "receivers:",
    ...body,
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [datadog]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "warning").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const toasts = (kind: "error" | "success" | "warning" | "info") => vi.mocked(toast[kind]).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(text: string, key: string) {
  openText(text);
  const user = userEvent.setup();
  render(
    <ComponentForm nodeId={componentNamed(key).id}>
      {key.startsWith("receivers.") ? <DatadogReceiverForm /> : <DatadogExporterForm />}
    </ComponentForm>,
  );
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
type Value = Record<string, unknown>;
const valueOf = (key: string, written = text()): Value => {
  const dot = key.indexOf(".");
  const parsed = parseYaml(written, { merge: true }) as Record<string, Record<string, Value>>;
  return parsed[key.slice(0, dot)]![key.slice(dot + 1)]!;
};
/** A hint line, by its whole text. */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** `typed` with user-event's special characters (`{`, `[`) escaped. */
const escapeKeys = (typed: string) => typed.replace(/[{[]/g, (c) => c + c);

async function retypeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, escapeKeys(typed));
  await user.tab();
}

async function typeInto(user: UserEvent, input: HTMLElement, typed: string) {
  await user.click(input);
  await user.keyboard(escapeKeys(typed));
  await user.tab();
}

async function pickIn(user: UserEvent, trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name may also hold its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\d*$`) }));
}

const box = (label: string) => screen.getByRole("checkbox", { name: label });

/** Waits out a field's pause, so what it holds is written (`useHeldText`). */
const pause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, FIELD_WRITE_DELAY_MS + 100)));

/**
 * Clears the field `id` without leaving it, waits for the write, then types
 * `typed` and leaves: the input is the same element throughout, focused, so
 * nothing typed after the key moved is lost.
 */
async function clearPauseRetype(user: UserEvent, id: string, typed: string) {
  const input = byId(id);
  await user.clear(input);
  await pause();
  expect(byId(id)).toBe(input);
  expect(document.activeElement).toBe(input);
  await user.keyboard(typed);
  expect(input).toHaveValue(typed);
  await user.tab();
}
const combo = (label: string) => screen.getByRole("combobox", { name: label });

/** A labeled field's block (its ConfigField), by its label. */
function fieldOf(label: string): HTMLElement {
  return screen.getByText(label, { selector: "label" }).closest("div.space-y-1\\.5") as HTMLElement;
}

/** Where `key`'s lines start in `text`: its name's line under its section. */
function componentAt(text: string, key: string): number {
  const dot = key.indexOf(".");
  return text.indexOf(`\n  ${key.slice(dot + 1)}:`, text.indexOf(`\n${key.slice(0, dot)}:`));
}

// ── Every field writes only its key ──

interface FieldCase {
  name: string;
  key: string;
  /** The text the case runs on (LF); the corpus by default. */
  base?: string;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  check: (value: Value) => void;
}

const QUEUE_END = "      queue_size: 1000\n";
const RX_END = '    compression_algorithms: ["", gzip, zstd] # "" is an uncompressed body\n';

const EXPORTER_CASES: FieldCase[] = [
  {
    name: "Site: ap2.datadoghq.com",
    key: EX,
    edit: (user) => pickIn(user, combo("Site"), "ap2.datadoghq.com"),
    from: "      site: datadoghq.eu\n",
    to: "      site: ap2.datadoghq.com\n",
    check: (v) => expect((v.api as Value).site).toBe("ap2.datadoghq.com"),
  },
  {
    name: "API Key over the anchor's merged key: the exporter's own key, the anchor untouched",
    key: EX,
    edit: (user) => retypeInto(user, byId("datadog-api-key"), "abc123"),
    from: "      <<: *dd-api\n      site: datadoghq.eu\n",
    to: "      <<: *dd-api\n      site: datadoghq.eu\n      key: abc123\n",
    check: (v) => expect(v.api).toEqual({ key: "abc123", fail_on_invalid_key: true, site: "datadoghq.eu" }),
  },
  {
    name: "Hostname",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host");
      await retypeInto(user, byId("datadog-hostname"), "telflo-2");
    },
    from: "    hostname: telflo-host\n",
    to: "    hostname: telflo-2\n",
    check: (v) => expect(v.hostname).toBe("telflo-2"),
  },
  {
    name: "Hostname Detection Timeout (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host");
      await typeInto(user, byId("datadog-hostname-detect-timeout"), "30s");
    },
    from: QUEUE_END,
    to: `${QUEUE_END}    hostname_detection_timeout: 30s\n`,
    check: (v) => expect(v.hostname_detection_timeout).toBe("30s"),
  },
  {
    name: "Request Timeout",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("datadog-timeout"), "20s");
    },
    from: "    timeout: 15s\n",
    to: "    timeout: 20s\n",
    check: (v) => expect(v.timeout).toBe("20s"),
  },
  {
    name: "Idle Connection Timeout edits the flat key the text uses (client.go:106-107)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await retypeInto(user, byId("datadog-idle-conn"), "60s");
    },
    from: "    idle_conn_timeout: 90s\n",
    to: "    idle_conn_timeout: 60s\n",
    check: (v) => {
      expect(v.idle_conn_timeout).toBe("60s");
      expect(v).not.toHaveProperty("keepalive");
    },
  },
  {
    name: "Proxy URL (unset)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await typeInto(user, byId("datadog-proxy"), "http://proxy:3128");
    },
    from: QUEUE_END,
    to: `${QUEUE_END}    proxy_url: http://proxy:3128\n`,
    check: (v) => expect(v.proxy_url).toBe("http://proxy:3128"),
  },
  {
    name: "Skip TLS Verification ticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Connection");
      await user.click(box("Skip TLS Verification (insecure)"));
    },
    from: "      insecure_skip_verify: false\n",
    to: "      insecure_skip_verify: true\n",
    check: (v) => expect(v.tls).toEqual({ insecure_skip_verify: true }),
  },
  {
    name: "Send Host Metadata unticked (no Only Metadata: no cascade)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host Metadata");
      await user.click(box("Send Host Metadata"));
    },
    from: "    host_metadata:\n      enabled: true\n",
    to: "    host_metadata:\n      enabled: false\n",
    check: (v) => expect((v.host_metadata as Value).enabled).toBe(false),
  },
  {
    name: "Host Metadata's Hostname Source",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host Metadata");
      await pickIn(user, combo("Hostname Source"), "first_resource");
    },
    from: "      hostname_source: config_or_system\n",
    to: "      hostname_source: first_resource\n",
    check: (v) => expect((v.host_metadata as Value).hostname_source).toBe("first_resource"),
  },
  {
    name: "Reporter Period",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host Metadata");
      await retypeInto(user, byId("datadog-hm-period"), "1h");
    },
    from: "      reporter_period: 30m\n",
    to: "      reporter_period: 1h\n",
    check: (v) => expect((v.host_metadata as Value).reporter_period).toBe("1h"),
  },
  {
    name: "Tags, an item changed in its flow list",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Host Metadata");
      await retypeInto(user, byId("datadog-hm-tags"), "env:prod,team:web");
    },
    from: "      tags: [env:prod, team:platform]\n",
    to: "      tags: [env:prod, team:web]\n",
    check: (v) => expect((v.host_metadata as Value).tags).toEqual(["env:prod", "team:web"]),
  },
  {
    name: "Traces Endpoint",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await retypeInto(user, byId("datadog-traces-endpoint"), "https://trace.agent.datadoghq.com");
    },
    from: "      endpoint: https://trace.agent.datadoghq.eu\n",
    to: "      endpoint: https://trace.agent.datadoghq.com\n",
    check: (v) => expect((v.traces as Value).endpoint).toBe("https://trace.agent.datadoghq.com"),
  },
  {
    name: "Ignore Resources, a regex written as typed, its quotes kept",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await retypeInto(user, byId("datadog-traces-ignore"), "(GET|POST) /health");
    },
    from: '      ignore_resources: ["(GET|POST) /healthz"]\n',
    to: '      ignore_resources: ["(GET|POST) /health"]\n',
    check: (v) => expect((v.traces as Value).ignore_resources).toEqual(["(GET|POST) /health"]),
  },
  {
    name: "Peer Tags, an item appended",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await typeInto(user, byId("datadog-peer-tags"), ",rpc.service");
    },
    from: "      peer_tags: [db.system, messaging.system]\n",
    to: "      peer_tags: [db.system, messaging.system, rpc.service]\n",
    check: (v) => expect((v.traces as Value).peer_tags).toEqual(["db.system", "messaging.system", "rpc.service"]),
  },
  {
    name: "Trace Buffer 0, written plain",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await retypeInto(user, byId("datadog-trace-buffer"), "0");
    },
    from: "      trace_buffer: 10\n",
    to: "      trace_buffer: 0\n",
    check: (v) => expect((v.traces as Value).trace_buffer).toBe(0),
  },
  {
    name: "Span Name as Resource Name unticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await user.click(box("Span Name as Resource Name"));
    },
    from: "      span_name_as_resource_name: true\n",
    to: "      span_name_as_resource_name: false\n",
    check: (v) => expect((v.traces as Value).span_name_as_resource_name).toBe(false),
  },
  {
    name: "Compute Stats by Span Kind unticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await user.click(box("Compute Stats by Span Kind"));
    },
    from: "      compute_stats_by_span_kind: true\n",
    to: "      compute_stats_by_span_kind: false\n",
    check: (v) => expect((v.traces as Value).compute_stats_by_span_kind).toBe(false),
  },
  {
    name: "Peer Tags Aggregation unticked (no deprecated key: no cascade)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Traces");
      await user.click(box("Peer Tags Aggregation"));
    },
    from: "      peer_tags_aggregation: true\n",
    to: "      peer_tags_aggregation: false\n",
    check: (v) => expect((v.traces as Value).peer_tags_aggregation).toBe(false),
  },
  {
    name: "Delta TTL",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await retypeInto(user, byId("datadog-delta-ttl"), "7200");
    },
    from: "      delta_ttl: 3600\n",
    to: "      delta_ttl: 7200\n",
    check: (v) => expect((v.metrics as Value).delta_ttl).toBe(7200),
  },
  {
    name: "Histogram Mode: counters",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await pickIn(user, combo("Histogram Mode"), "counters");
    },
    from: "        mode: distributions\n",
    to: "        mode: counters\n",
    check: (v) => expect((v.metrics as Value).histograms).toEqual({ mode: "counters", send_aggregation_metrics: true }),
  },
  {
    name: "Summary Mode writes summaries.mode only",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await pickIn(user, combo("Summary Mode"), "noquantiles");
    },
    from: "        mode: gauges\n",
    to: "        mode: noquantiles\n",
    check: (v) => expect((v.metrics as Value).summaries).toEqual({ mode: "noquantiles" }),
  },
  {
    name: "Send Histogram Aggregation Metrics unticked (distributions: no cascade)",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(box("Send Histogram Aggregation Metrics"));
    },
    from: "        send_aggregation_metrics: true\n",
    to: "        send_aggregation_metrics: false\n",
    check: (v) => expect((v.metrics as Value).histograms).toEqual({ mode: "distributions", send_aggregation_metrics: false }),
  },
  {
    name: "Resource Attributes as Tags unticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(box("Resource Attributes as Tags"));
    },
    from: "      resource_attributes_as_tags: true\n",
    to: "      resource_attributes_as_tags: false\n",
    check: (v) => expect((v.metrics as Value).resource_attributes_as_tags).toBe(false),
  },
  {
    name: "Instrumentation Scope Metadata as Tags unticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Metrics");
      await user.click(box("Instrumentation Scope Metadata as Tags"));
    },
    from: "      instrumentation_scope_metadata_as_tags: true\n",
    to: "      instrumentation_scope_metadata_as_tags: false\n",
    check: (v) => expect((v.metrics as Value).instrumentation_scope_metadata_as_tags).toBe(false),
  },
  {
    name: "Batch Wait",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Logs");
      await retypeInto(user, byId("datadog-batch-wait"), "10");
    },
    from: "      batch_wait: 5\n",
    to: "      batch_wait: 10\n",
    check: (v) => expect((v.logs as Value).batch_wait).toBe(10),
  },
  {
    name: "Compression Level",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Logs");
      await retypeInto(user, byId("datadog-compression-level"), "9");
    },
    from: "      compression_level: 6\n",
    to: "      compression_level: 9\n",
    check: (v) => expect((v.logs as Value).compression_level).toBe(9),
  },
  {
    name: "Use Compression unticked",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Logs");
      await user.click(box("Use Compression"));
    },
    from: "      use_compression: true\n",
    to: "      use_compression: false\n",
    check: (v) => expect((v.logs as Value).use_compression).toBe(false),
  },
  {
    name: "Retry's Max Interval",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Retry on Failure");
      await retypeInto(user, byId("retry-max-interval"), "1m");
    },
    from: "      max_interval: 30s\n",
    to: "      max_interval: 1m\n",
    check: (v) => expect((v.retry_on_failure as Value).max_interval).toBe("1m"),
  },
  {
    name: "Queue Size",
    key: EX,
    edit: async (user) => {
      await openSection(user, "Sending Queue");
      await retypeInto(user, byId("queue-size"), "2000");
    },
    from: QUEUE_END,
    to: "      queue_size: 2000\n",
    check: (v) => expect((v.sending_queue as Value).queue_size).toBe(2000),
  },
  {
    name: "Only Metadata unticked (datadog/metadata)",
    key: EX_META,
    edit: async (user) => {
      await openSection(user, "Connection");
      await user.click(box("Only Metadata"));
    },
    from: "    only_metadata: true\n",
    to: "    only_metadata: false\n",
    check: (v) => expect(v.only_metadata).toBe(false),
  },
];

const RECEIVER_CASES: FieldCase[] = [
  {
    name: "Endpoint",
    key: RX,
    edit: (user) => retypeInto(user, byId("datadog-endpoint"), "localhost:9126"),
    from: "    endpoint: localhost:8126\n",
    to: "    endpoint: localhost:9126\n",
    check: (v) => expect(v.endpoint).toBe("localhost:9126"),
  },
  {
    name: "Read Timeout",
    key: RX,
    edit: (user) => retypeInto(user, byId("datadog-read-timeout"), "30s"),
    from: "    read_timeout: 60s\n",
    to: "    read_timeout: 30s\n",
    check: (v) => expect(v.read_timeout).toBe("30s"),
  },
  {
    name: "Trace ID Cache Size",
    key: RX,
    edit: (user) => retypeInto(user, byId("datadog-trace-cache"), "200"),
    from: "    trace_id_cache_size: 100\n",
    to: "    trace_id_cache_size: 200\n",
    check: (v) => expect(v.trace_id_cache_size).toBe(200),
  },
  {
    name: "Idle Series Timeout (unset)",
    key: RX,
    edit: (user) => typeInto(user, byId("datadog-idle-timeout"), "10m"),
    from: RX_END,
    to: `${RX_END}    idle_series_timeout: 10m\n`,
    check: (v) => expect(v.idle_series_timeout).toBe("10m"),
  },
  {
    name: "Idle Series Cleanup Interval (unset)",
    key: RX,
    edit: (user) => typeInto(user, byId("datadog-idle-cleanup"), "1m"),
    from: RX_END,
    to: `${RX_END}    idle_series_cleanup_interval: 1m\n`,
    check: (v) => expect(v.idle_series_cleanup_interval).toBe("1m"),
  },
  {
    name: "TLS Certificate File",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Security");
      await retypeInto(user, byId("tls-cert-file-http"), "/etc/otel/tls/other.crt");
    },
    from: "      cert_file: /etc/otel/tls/server.crt\n",
    to: "      cert_file: /etc/otel/tls/other.crt\n",
    check: (v) => expect((v.tls as Value).cert_file).toBe("/etc/otel/tls/other.crt"),
  },
  {
    name: "Authenticator Extension (unset), trimmed",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Security");
      await typeInto(user, byId("datadog-auth"), "  bearertokenauth/dd ");
    },
    from: RX_END,
    to: `${RX_END}    auth:\n      authenticator: bearertokenauth/dd\n`,
    check: (v) => expect(v.auth).toEqual({ authenticator: "bearertokenauth/dd" }),
  },
  {
    name: "Max Request Body Size (unset), written plain",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await typeInto(user, byId("datadog-max-body"), "1048576");
    },
    from: RX_END,
    to: `${RX_END}    max_request_body_size: 1048576\n`,
    check: (v) => expect(v.max_request_body_size).toBe(1048576),
  },
  {
    name: "Compression: zstd unticked, its item removed from the flow list",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("zstd"));
    },
    from: RX_END,
    to: '    compression_algorithms: ["", gzip] # "" is an uncompressed body\n',
    check: (v) => expect(v.compression_algorithms).toEqual(["", "gzip"]),
  },
  {
    name: "Compression: none (uncompressed) unticked removes the \"\" item",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("none (uncompressed)"));
    },
    from: RX_END,
    to: '    compression_algorithms: [gzip, zstd] # "" is an uncompressed body\n',
    check: (v) => expect(v.compression_algorithms).toEqual(["gzip", "zstd"]),
  },
  {
    name: "Compression: x-snappy-framed ticked",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("x-snappy-framed"));
    },
    from: RX_END,
    to: '    compression_algorithms: ["", gzip, zstd, x-snappy-framed] # "" is an uncompressed body\n',
    check: (v) => expect(v.compression_algorithms).toEqual(["", "gzip", "zstd", "x-snappy-framed"]),
  },
  {
    name: "Write Timeout (unset)",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await typeInto(user, byId("datadog-write-timeout"), "45s");
    },
    from: RX_END,
    to: `${RX_END}    write_timeout: 45s\n`,
    check: (v) => expect(v.write_timeout).toBe("45s"),
  },
  {
    name: "Idle Timeout in the keepalive section the text has",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await retypeInto(user, byId("datadog-idle-timeout-server"), "3m");
    },
    from: "      idle_timeout: 2m\n",
    to: "      idle_timeout: 3m\n",
    check: (v) => expect(v.keepalive).toEqual({ enabled: true, idle_timeout: "3m" }),
  },
  {
    name: "Keep-Alives unticked writes keepalive.enabled: false",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("Enable HTTP Keep-Alives"));
    },
    from: "    keepalive:\n      enabled: true\n",
    to: "    keepalive:\n      enabled: false\n",
    check: (v) => expect(v.keepalive).toEqual({ enabled: false, idle_timeout: "2m" }),
  },
  {
    name: "Propagate Client Metadata Downstream ticked (unset)",
    key: RX,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("Propagate Client Metadata Downstream"));
    },
    from: RX_END,
    to: `${RX_END}    include_metadata: true\n`,
    check: (v) => expect(v.include_metadata).toBe(true),
  },
  {
    name: "Idle Timeout at the flat key datadog/legacy uses, no keepalive section: no move",
    key: RX_LEGACY,
    edit: async (user) => {
      await openSection(user, "Performance: HTTP Server");
      await retypeInto(user, byId("datadog-idle-timeout-server"), "2m");
    },
    from: "    idle_timeout: 90s\n",
    to: "    idle_timeout: 2m\n",
    check: (v) => expect(v).toEqual({ endpoint: "localhost:8127", idle_timeout: "2m" }),
  },
];

describe("every field writes only its key", () => {
  it.each(
    [...EXPORTER_CASES, ...RECEIVER_CASES].flatMap((c) => [
      [`${c.key}: ${c.name}, LF`, c, false] as const,
      [`${c.key}: ${c.name}, CRLF`, c, true] as const,
    ]),
  )(
    "%s",
    async (_name, c, crlf) => {
      const base = c.base ?? CORPUS;
      const before = crlf ? CRLF(base) : base;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from).length).toBeGreaterThanOrEqual(2);
      const user = renderForm(before, c.key);

      await c.edit(user);

      // The component's own occurrence of `from` changes, and nothing else.
      const at = before.indexOf(from, componentAt(before, c.key));
      expect(text()).toBe(before.slice(0, at) + to + before.slice(at + from.length));
      expect(entries()).toBe(1);
      c.check(valueOf(c.key));
      expect(toasts("error")).toEqual([]);
      expect(toasts("info")).toEqual([]);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );
});

// ── Opening writes nothing ──

describe("opening writes nothing", () => {
  async function openEverything(user: UserEvent) {
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
  }

  // One test per text, each with its own time limit.
  it.each([
    // 3 top fields; Host 2; Connection 5; Host Metadata 4; Traces 7; Metrics 8; Logs 4; retry 5; queue 4+.
    ["the exporter, the vendors corpus", CORPUS, EX, 40],
    ["the exporter, the vendors corpus, CRLF", CRLF(CORPUS), EX, 40],
    ["datadog/metadata", CORPUS, EX_META, 40],
    ["an empty exporter", ownExporter(""), EX, 40],
    // 5 top fields; TLS box and its fields; CORS box; authenticator; body size, 8 boxes, 3 timeouts, 2 boxes, a header row.
    ["the receiver, the vendors corpus", CORPUS, RX, 25],
    ["the receiver, the vendors corpus, CRLF", CRLF(CORPUS), RX, 25],
    ["datadog/legacy", CORPUS, RX_LEGACY, 20],
    ["an empty receiver", ownReceiver(""), RX, 20],
  ] as const)(
    "opening %s, every section, focusing every field, writes nothing and leaves the editor clean",
    async (_name, base, key, minimum) => {
      const user = renderForm(base, key);
      await openEverything(user);
      expect(screen.queryAllByRole("button", { expanded: false })).toEqual([]);
      const { textboxes, all } = formControls();
      expect(all).toBeGreaterThanOrEqual(minimum);
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

  it("the forms are the receiver's and the exporter's, from the registry", () => {
    expect(formFor("exporter", "datadog")).toBe(DatadogExporterForm);
    expect(formFor("receiver", "datadog")).toBe(DatadogReceiverForm);
  });
});

// ── The cascades ──

interface CascadeCase {
  name: string;
  base: string;
  section: string;
  act: (user: UserEvent) => Promise<void>;
  /** The component's value after the change. */
  value: Value;
  /** The one toast, exactly. */
  toast: string;
}

const API = "    api:\n      key: ${env:DD_API_KEY}\n";

const CASCADES: CascadeCase[] = [
  {
    // config.go:156-158: only_metadata needs host_metadata.enabled and hostname_source first_resource (unset is config_or_system, config.go:398).
    name: "E1: ticking Only Metadata with the hostname source unset sets first_resource",
    base: ownExporter(`${API}    only_metadata: false\n`),
    section: "Connection",
    act: (user) => user.click(box("Only Metadata")),
    value: { api: { key: "${env:DD_API_KEY}" }, only_metadata: true, host_metadata: { hostname_source: "first_resource" } },
    toast: DATADOG_TOASTS.firstResource,
  },
  {
    name: "E2: ticking Only Metadata with host metadata off turns it on",
    base: ownExporter(`${API}    host_metadata:\n      enabled: false\n      hostname_source: first_resource\n`),
    section: "Connection",
    act: (user) => user.click(box("Only Metadata")),
    value: { api: { key: "${env:DD_API_KEY}" }, host_metadata: { enabled: true, hostname_source: "first_resource" }, only_metadata: true },
    toast: DATADOG_TOASTS.hostMetadataOn,
  },
  {
    name: "E1 and E2 together: one change, both messages in one toast",
    base: ownExporter(`${API}    host_metadata:\n      enabled: false\n`),
    section: "Connection",
    act: (user) => user.click(box("Only Metadata")),
    value: { api: { key: "${env:DD_API_KEY}" }, host_metadata: { enabled: true, hostname_source: "first_resource" }, only_metadata: true },
    toast: `${DATADOG_TOASTS.firstResource} ${DATADOG_TOASTS.hostMetadataOn}`,
  },
  {
    name: "E3: unticking Send Host Metadata while Only Metadata is on unticks it",
    base: ownExporter(`${API}    only_metadata: true\n    host_metadata:\n      hostname_source: first_resource\n`),
    section: "Host Metadata",
    act: (user) => user.click(box("Send Host Metadata")),
    value: { api: { key: "${env:DD_API_KEY}" }, only_metadata: false, host_metadata: { hostname_source: "first_resource", enabled: false } },
    toast: DATADOG_TOASTS.onlyMetadataOffHost,
  },
  {
    name: "E4: choosing config_or_system while Only Metadata is on unticks it",
    base: ownExporter(`${API}    only_metadata: true\n    host_metadata:\n      hostname_source: first_resource\n`),
    section: "Host Metadata",
    act: (user) => pickIn(user, combo("Hostname Source"), "config_or_system"),
    value: { api: { key: "${env:DD_API_KEY}" }, only_metadata: false, host_metadata: { hostname_source: "config_or_system" } },
    toast: DATADOG_TOASTS.onlyMetadataOffSource,
  },
  {
    // metrics.go:97-102: nobuckets with send_aggregation_metrics false sends no histogram metrics, refused.
    name: "E5: choosing nobuckets turns aggregation metrics on",
    base: ownExporter(`${API}    metrics:\n      histograms:\n        mode: distributions\n`),
    section: "Metrics",
    act: (user) => pickIn(user, combo("Histogram Mode"), "nobuckets"),
    value: { api: { key: "${env:DD_API_KEY}" }, metrics: { histograms: { mode: "nobuckets", send_aggregation_metrics: true } } },
    toast: DATADOG_TOASTS.aggregationOn,
  },
  {
    // config_warnings.go:55-58: the deprecated and the new key can't both be set.
    name: "E5 with the deprecated send_count_sum_metrics: false: it goes in the same change",
    base: ownExporter(`${API}    metrics:\n      histograms:\n        send_count_sum_metrics: false\n`),
    section: "Metrics",
    act: (user) => pickIn(user, combo("Histogram Mode"), "nobuckets"),
    value: { api: { key: "${env:DD_API_KEY}" }, metrics: { histograms: { mode: "nobuckets", send_aggregation_metrics: true } } },
    toast: `${DATADOG_TOASTS.aggregationOn} ${DATADOG_TOASTS.countSum}`,
  },
  {
    name: "E6: unticking aggregation metrics under nobuckets removes the mode (distributions)",
    base: ownExporter(`${API}    metrics:\n      histograms:\n        mode: nobuckets\n        send_aggregation_metrics: true\n`),
    section: "Metrics",
    act: (user) => user.click(box("Send Histogram Aggregation Metrics")),
    value: { api: { key: "${env:DD_API_KEY}" }, metrics: { histograms: { send_aggregation_metrics: false } } },
    toast: DATADOG_TOASTS.distributions,
  },
  {
    name: "E7: toggling aggregation metrics removes the deprecated send_count_sum_metrics",
    base: ownExporter(`${API}    metrics:\n      histograms:\n        send_count_sum_metrics: true\n`),
    section: "Metrics",
    act: (user) => user.click(box("Send Histogram Aggregation Metrics")),
    value: { api: { key: "${env:DD_API_KEY}" }, metrics: { histograms: { send_aggregation_metrics: false } } },
    toast: DATADOG_TOASTS.countSum,
  },
  {
    name: "E8: toggling Peer Tags Aggregation removes the deprecated peer_service_aggregation",
    base: ownExporter(`${API}    traces:\n      peer_service_aggregation: false\n`),
    section: "Traces",
    act: (user) => user.click(box("Peer Tags Aggregation")),
    value: { api: { key: "${env:DD_API_KEY}" }, traces: { peer_tags_aggregation: true } },
    toast: DATADOG_TOASTS.peerService,
  },
  {
    // config.go:324-331: initial_cumulative_monotonic_value only with to_delta.
    name: "E9: choosing raw_value removes the initial cumulative value",
    base: ownExporter(`${API}    metrics:\n      sums:\n        initial_cumulative_monotonic_value: keep\n`),
    section: "Metrics",
    act: (user) => pickIn(user, combo("Cumulative Sum Mode"), "raw_value"),
    value: { api: { key: "${env:DD_API_KEY}" }, metrics: { sums: { cumulative_monotonic_mode: "raw_value" } } },
    toast: DATADOG_TOASTS.initialValue,
  },
];

describe("the nine cascades: one change, one undo entry, one toast", () => {
  it.each(CASCADES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const user = renderForm(c.base, EX);
    await openSection(user, c.section);
    await c.act(user);
    expect(valueOf(EX)).toEqual(c.value);
    expect(toasts("info")).toEqual([c.toast]);
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(c.base);
  });

  it("the toasts read as the plan gives them", () => {
    expect(Object.values(DATADOG_TOASTS)).toEqual([
      "Hostname source set to first_resource: Only Metadata needs it.",
      "Turned Send Host Metadata on: Only Metadata needs it.",
      "Unticked Only Metadata: it needs host metadata.",
      "Unticked Only Metadata: it needs the first_resource hostname source.",
      "Turned on Send Histogram Aggregation Metrics: nobuckets sends no histogram metrics without it.",
      "Histogram mode set to distributions: nobuckets needs aggregation metrics.",
      "Removed send_count_sum_metrics: it can't be set beside send_aggregation_metrics.",
      "Removed peer_service_aggregation: it can't be set beside peer_tags_aggregation.",
      "Removed initial_cumulative_monotonic_value: it only applies to to_delta.",
    ]);
  });

  it("a change the collector takes as it is adjusts nothing and toasts nothing", async () => {
    // Only Metadata ticked with first_resource and host metadata on (the default).
    let base = ownExporter(`${API}    host_metadata:\n      hostname_source: first_resource\n`);
    let user = renderForm(base, EX);
    await openSection(user, "Connection");
    await user.click(box("Only Metadata"));
    expect(valueOf(EX)).toEqual({ api: { key: "${env:DD_API_KEY}" }, host_metadata: { hostname_source: "first_resource" }, only_metadata: true });
    cleanup();
    // nobuckets with the deprecated send_count_sum_metrics: true, which the collector applies (config_warnings.go:31-33).
    base = ownExporter(`${API}    metrics:\n      histograms:\n        send_count_sum_metrics: true\n`);
    user = renderForm(base, EX);
    await openSection(user, "Metrics");
    await pickIn(user, combo("Histogram Mode"), "nobuckets");
    expect(valueOf(EX).metrics).toEqual({ histograms: { send_count_sum_metrics: true, mode: "nobuckets" } });
    cleanup();
    // raw_value with no initial value; to_delta with one.
    base = ownExporter(`${API}    metrics:\n      sums:\n        initial_cumulative_monotonic_value: keep\n`);
    user = renderForm(base, EX);
    await openSection(user, "Metrics");
    await pickIn(user, combo("Cumulative Sum Mode"), "to_delta");
    expect(valueOf(EX).metrics).toEqual({ sums: { initial_cumulative_monotonic_value: "keep", cumulative_monotonic_mode: "to_delta" } });
    // Send Host Metadata unticked, and the source changed, while Only Metadata is off.
    await openSection(user, "Host Metadata");
    await user.click(box("Send Host Metadata"));
    await pickIn(user, combo("Hostname Source"), "first_resource");
    expect(valueOf(EX).host_metadata).toEqual({ enabled: false, hostname_source: "first_resource" });
    expect(valueOf(EX)).not.toHaveProperty("only_metadata");
    expect(toasts("info")).toEqual([]);
  });
});

// ── The exporter's keys and defaults ──

describe("Idle Connection Timeout: the key the text uses", () => {
  it("with neither key, writes keepalive.idle_conn_timeout, the current key (client.go:99-104, 163-168); never idle_connection_timeout", async () => {
    const base = ownExporter(API);
    const user = renderForm(base, EX);
    await openSection(user, "Connection");
    expect(fieldOf("Idle Connection Timeout")).toHaveTextContent("Default 90s");
    await typeInto(user, byId("datadog-idle-conn"), "30s");
    expect(text()).toBe(base.replace(API, `${API}    keepalive:\n      idle_conn_timeout: 30s\n`));
    expect(valueOf(EX)).not.toHaveProperty("idle_connection_timeout");
    expect(valueOf(EX)).not.toHaveProperty("idle_conn_timeout");
    // Cleared, the last key takes the block (the collector's default is the same).
    await retypeInto(user, byId("datadog-idle-conn"), "");
    expect(text()).toBe(base);
  });

  it("edits keepalive.idle_conn_timeout where the text has it, keeping the section's other keys", async () => {
    const base = ownExporter(`${API}    keepalive:\n      max_idle_conns: 50 # pool\n      idle_conn_timeout: 45s\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Connection");
    expect(byId("datadog-idle-conn")).toHaveValue("45s");
    await retypeInto(user, byId("datadog-idle-conn"), "");
    expect(text()).toBe(base.replace("      idle_conn_timeout: 45s\n", ""));
  });

  it("a flat idle_conn_timeout cleared (the only flat key) and, after the pause, retyped: the input keeps focus and what is typed goes to keepalive.idle_conn_timeout", async () => {
    const base = ownExporter(`${API}    idle_conn_timeout: 30s\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Connection");
    expect(byId("datadog-idle-conn")).toHaveValue("30s");
    await clearPauseRetype(user, "datadog-idle-conn", "45s");
    expect(valueOf(EX)).toEqual({ api: { key: "${env:DD_API_KEY}" }, keepalive: { idle_conn_timeout: "45s" } });
  });

  it("a flat idle_conn_timeout cleared beside another flat key and retyped stays flat, the input kept", async () => {
    const base = ownExporter(`${API}    max_idle_conns: 50\n    idle_conn_timeout: 30s\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Connection");
    await clearPauseRetype(user, "datadog-idle-conn", "45s");
    expect(valueOf(EX)).toEqual({ api: { key: "${env:DD_API_KEY}" }, max_idle_conns: 50, idle_conn_timeout: "45s" });
  });

  it("writes the flat key while the text uses the flat keep-alive keys, which the collector refuses beside a keepalive section (client.go:249-251)", async () => {
    const base = ownExporter(`${API}    max_idle_conns: 50\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Connection");
    await typeInto(user, byId("datadog-idle-conn"), "30s");
    expect(valueOf(EX)).toEqual({ api: { key: "${env:DD_API_KEY}" }, max_idle_conns: 50, idle_conn_timeout: "30s" });
  });
});

describe("the dropped controls", () => {
  it("Host's Hostname Source, Dump Payloads and HTTP Headers aren't shown; their keys in a text are left alone by an edit", async () => {
    const base = ownExporter(
      `${API}    hostname: a\n    hostname_source: first_resource # top level\n    headers:\n      X-Team: obs\n    logs:\n      dump_payloads: true\n`,
    );
    const user = renderForm(base, EX);
    for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    expect(screen.queryByText("HTTP Headers")).toBeNull();
    expect(screen.queryByText("Dump Payloads")).toBeNull();
    expect(screen.queryByText("Debug: logs raw outbound payloads.")).toBeNull();
    expect(screen.queryByText("How to resolve the hostname when not explicitly set.")).toBeNull();
    // One Hostname Source: Host Metadata's.
    expect(screen.getAllByText("Hostname Source", { selector: "label" })).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: /header/i })).toBeNull();
    await retypeInto(user, byId("datadog-hostname"), "b");
    expect(text()).toBe(base.replace("    hostname: a\n", "    hostname: b\n"));
  });
});

describe("the defaults and the copy", () => {
  it("unset: the three boxes ticked (config.go:360, 382-383), Trace Buffer Default 0 (traces.go:131-133), Site Default datadoghq.com", async () => {
    const user = renderForm(ownExporter(""), EX);
    for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    const ticked = (label: string) => expect(box(label)).toHaveAttribute("data-state", "checked");
    const unticked = (label: string) => expect(box(label)).toHaveAttribute("data-state", "unchecked");
    ticked("Compute Stats by Span Kind");
    ticked("Peer Tags Aggregation");
    ticked("Instrumentation Scope Metadata as Tags");
    ticked("Send Host Metadata");
    ticked("Use Compression");
    unticked("Span Name as Resource Name");
    unticked("Send Histogram Aggregation Metrics");
    unticked("Resource Attributes as Tags");
    unticked("Only Metadata");
    unticked("Fail to Start on Invalid API Key");
    unticked("Skip TLS Verification (insecure)");
    // Retry and the queue are on by default (config.go:346-347).
    ticked("Enable Retry on Failure");
    ticked("Enable Sending Queue");
    expect(fieldOf("Trace Buffer")).toHaveTextContent("In-memory buffer for trace payloads awaiting send. · Default 0");
    expect(byId("datadog-trace-buffer")).toHaveAttribute("placeholder", "0");
    expect(fieldOf("Site")).toHaveTextContent("Match this to your Datadog org's region. · Default datadoghq.com");
    expect(combo("Site")).toHaveTextContent("datadoghq.com");
    await user.click(combo("Site"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([...DATADOG_SITES]);
    expect(DATADOG_SITES).toContain("ap2.datadoghq.com");
  });

  it("Host Metadata's Hostname Source: Default config_or_system (config.go:398) and the first_resource hint (config.go:298-300)", async () => {
    const user = renderForm(ownExporter(""), EX);
    await openSection(user, "Host Metadata");
    expect(fieldOf("Hostname Source")).toHaveTextContent("Where to pull hostname and host tags from. · Default config_or_system");
    expect(hint(FIRST_RESOURCE_HINT)).toBeInTheDocument();
    expect(FIRST_RESOURCE_HINT).toBe("first_resource is deprecated; the collector logs a warning.");
  });

  it("the boxes read a deprecated key while the new one is absent, as the collector applies it (config_warnings.go:27-42)", async () => {
    const user = renderForm(
      ownExporter(`${API}    traces:\n      peer_service_aggregation: false\n    metrics:\n      histograms:\n        send_count_sum_metrics: true\n`),
      EX,
    );
    await openSection(user, "Traces");
    await openSection(user, "Metrics");
    expect(box("Peer Tags Aggregation")).toHaveAttribute("data-state", "unchecked");
    expect(box("Send Histogram Aggregation Metrics")).toHaveAttribute("data-state", "checked");
  });

  it("API Key is a plain text field, required, with its placeholder", () => {
    renderForm(CORPUS, EX);
    expect(byId("datadog-api-key")).toHaveAttribute("type", "text");
    expect(byId("datadog-api-key")).toHaveAttribute("placeholder", "${env:DD_API_KEY}");
    expect(byId("datadog-api-key")).toHaveValue("${env:DD_API_KEY}");
  });

  it("Summary Mode writes summaries.mode only, keeping the block's other keys and comments (the block isn't replaced)", async () => {
    const base = ownExporter(`${API}    metrics:\n      summaries:\n        mode: gauges # summaries\n        extra: kept\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Metrics");
    await pickIn(user, combo("Summary Mode"), "noquantiles");
    expect(text()).toBe(base.replace("mode: gauges # summaries", "mode: noquantiles # summaries"));
  });
});

describe("the comma lists", () => {
  it("a typed comma is held until the next item; left, the list is written", async () => {
    const base = ownExporter(API);
    const user = renderForm(base, EX);
    await openSection(user, "Traces");
    await user.click(byId("datadog-peer-tags"));
    await user.keyboard("db.system,");
    await act(() => new Promise((resolve) => setTimeout(resolve, FIELD_WRITE_DELAY_MS + 100)));
    expect(text()).toBe(base);
    expect(byId("datadog-peer-tags")).toHaveValue("db.system,");
    await user.keyboard("rpc.service");
    await user.tab();
    expect(valueOf(EX).traces).toEqual({ peer_tags: ["db.system", "rpc.service"] });
    expect(entries()).toBe(1);
  });

  it("an item holding a comma makes the field read-only with the unshowable-value hint (never split on retype)", async () => {
    const user = renderForm(ownExporter(`${API}    traces:\n      ignore_resources: ["GET /a{1,3}", b]\n`), EX);
    await openSection(user, "Traces");
    expect(byId("datadog-traces-ignore")).toBeDisabled();
    expect(within(fieldOf("Ignore Resources")).getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
  });

  it("emptied, the key is removed", async () => {
    const base = ownExporter(`${API}    host_metadata:\n      tags: [a, b]\n`);
    const user = renderForm(base, EX);
    await openSection(user, "Host Metadata");
    await retypeInto(user, byId("datadog-hm-tags"), "");
    expect(valueOf(EX)).toEqual({ api: { key: "${env:DD_API_KEY}" }, host_metadata: {} });
  });
});

// ── The receiver ──

describe("the receiver's defaults and copy", () => {
  it("Read Timeout unset is Default 0 (none): the receiver's own 60s field is never read", () => {
    // The receiver declares read_timeout (config.go:26-27, default 60s at factory.go:42) but builds its server from the
    // squashed confighttp.ServerConfig (receiver.go:244: ddr.config.ServerConfig.ToServer), which uses ServerConfig's
    // ReadTimeout (core config/confighttp/server.go:525-527), unset in NewDefaultServerConfig (server.go:143-167): no timeout.
    renderForm(ownReceiver(""), RX);
    expect(fieldOf("Read Timeout")).toHaveTextContent("Default 0 (none)");
    expect(byId("datadog-read-timeout")).toHaveAttribute("placeholder", "0s");
  });

  it("Endpoint isn't marked required: unset is localhost:8126 (factory.go:35)", () => {
    renderForm(ownReceiver(""), RX);
    const label = screen.getByText("Endpoint", { selector: "label" });
    expect(label.textContent).toBe("Endpoint");
    expect(label.querySelector("[aria-hidden]")).toBeNull();
    expect(fieldOf("Endpoint")).toHaveTextContent("Address to listen on; point the Agent's DD_APM_DD_URL here. · Default localhost:8126");
    expect(byId("datadog-endpoint")).toHaveAttribute("placeholder", "localhost:8126");
  });

  it("Security holds the server TLS, CORS and the authenticator; Performance the response headers", async () => {
    const user = renderForm(CORPUS, RX);
    await openSection(user, "Security");
    expect(box("Enable TLS for HTTP")).toHaveAttribute("data-state", "checked");
    expect(box("Enable CORS (HTTP only)")).toHaveAttribute("data-state", "checked");
    expect(byId("datadog-auth")).toHaveAttribute("placeholder", "e.g. bearertokenauth/datadog");
    await openSection(user, "Performance: HTTP Server");
    expect(screen.getByText("Response Headers")).toBeInTheDocument();
    expect(screen.getByText("Added to every HTTP response.")).toBeInTheDocument();
  });
});

describe("Compression Algorithms", () => {
  it("offers the collector's set with none (uncompressed) and x-snappy-framed (compression.go:28-29), and the hint", async () => {
    const user = renderForm(ownReceiver(""), RX);
    await openSection(user, "Performance: HTTP Server");
    const field = fieldOf("Compression Algorithms");
    expect(within(field).getAllByRole("checkbox").map((b) => b.parentElement!.textContent)).toEqual([
      "none (uncompressed)",
      "gzip",
      "zstd",
      "zlib",
      "snappy",
      "deflate",
      "lz4",
      "x-snappy-framed",
    ]);
    expect(COMPRESSION_ITEMS[0]).toEqual({ value: "", label: "none (uncompressed)" });
    // Unset: none ticked, the hint naming the collector's default.
    for (const checkbox of within(field).getAllByRole("checkbox")) expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(field).toHaveTextContent(`Restrict which request encodings are accepted. · ${COMPRESSION_HINT}`);
    expect(COMPRESSION_HINT).toBe("Default: all, uncompressed included. Ticking any accepts only those ticked.");
  });

  it("the \"\" item is read as none (uncompressed) and written as \"\": never an extra or empty row", async () => {
    let user = renderForm(CORPUS, RX);
    await openSection(user, "Performance: HTTP Server");
    const ticked = () =>
      within(fieldOf("Compression Algorithms"))
        .getAllByRole("checkbox")
        .filter((b) => b.getAttribute("data-state") === "checked")
        .map((b) => b.parentElement!.textContent);
    expect(ticked()).toEqual(["none (uncompressed)", "gzip", "zstd"]);
    expect(within(fieldOf("Compression Algorithms")).getAllByRole("checkbox")).toHaveLength(8);
    expect(screen.queryByText(UNSHOWABLE_VALUE_MESSAGE)).toBeNull();
    cleanup();

    // The first tick on an unset list writes that item alone.
    const base = ownReceiver("    endpoint: localhost:8126");
    user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    await user.click(box("none (uncompressed)"));
    expect(valueOf(RX).compression_algorithms).toEqual([""]);
    expect(ticked()).toEqual(["none (uncompressed)"]);
    expect(within(fieldOf("Compression Algorithms")).getAllByRole("checkbox")).toHaveLength(8);
    await user.click(box("gzip"));
    expect(valueOf(RX).compression_algorithms).toEqual(["", "gzip"]);
    // Unticking the last removes the key.
    await user.click(box("none (uncompressed)"));
    await user.click(box("gzip"));
    expect(text()).toBe(base);
  });
});

describe("keep-alives and the keepalive move", () => {
  it("the box shows what the collector does: a flat keep_alives_enabled: false alone is ignored (server.go:197-244), so ticked, with the hint", async () => {
    const user = renderForm(ownReceiver("    keep_alives_enabled: false"), RX);
    await openSection(user, "Performance: HTTP Server");
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "checked");
    expect(hint(IGNORED_FLAT_HINT)).toBeInTheDocument();
    expect(IGNORED_FLAT_HINT).toBe("keep_alives_enabled: false is ignored by the collector; untick to turn keep-alives off.");
  });

  it("the hint shows only for an ignored flat false: not for a flat true, nor beside a keepalive section, nor with neither", async () => {
    for (const lines of ["    keep_alives_enabled: true", "    keep_alives_enabled: false\n    keepalive:\n      enabled: false", "    endpoint: localhost:8126"]) {
      const user = renderForm(ownReceiver(lines), RX);
      await openSection(user, "Performance: HTTP Server");
      expect(screen.queryByText(IGNORED_FLAT_HINT)).toBeNull();
      cleanup();
    }
  });

  it("unticking over an ignored flat false writes keepalive.enabled: false with the move, one change, its toast; the hint goes", async () => {
    const base = ownReceiver("    keep_alives_enabled: false # off\n    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(valueOf(RX)).toEqual({ endpoint: "localhost:8126", keepalive: { enabled: false } });
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "unchecked");
    expect(screen.queryByText(IGNORED_FLAT_HINT)).toBeNull();
    // The person turned them off: the box's own change replaces the flat key, removed.
    expect(toasts("info")).toEqual([removedToast("keep_alives_enabled")]);
    expect(removedToast("keep_alives_enabled")).toBe("Removed keep_alives_enabled: the collector refuses it beside a keepalive block.");
    expect(entries()).toBe(1);
    act(() => void builderStore().undo());
    expect(text()).toBe(base);
  });

  it("unticking writes keepalive.enabled: false, never keep_alives_enabled; ticking removes it, and the emptied section", async () => {
    const base = ownReceiver("    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(text()).toBe(`${base.replace("    endpoint: localhost:8126\n", "    endpoint: localhost:8126\n    keepalive:\n      enabled: false\n")}`);
    expect(valueOf(RX)).not.toHaveProperty("keep_alives_enabled");
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "unchecked");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(text()).toBe(base);
    expect(toasts("info")).toEqual([]);
  });

  it("unticking with a flat idle_timeout moves it into keepalive in the same change, toasted (server.go:225-227)", async () => {
    const user = renderForm(CORPUS, RX_LEGACY);
    await openSection(user, "Performance: HTTP Server");
    expect(byId("datadog-idle-timeout-server")).toHaveValue("90s");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(text()).toBe(CORPUS.replace("    idle_timeout: 90s\n", "    keepalive:\n      enabled: false\n      idle_timeout: 90s\n"));
    expect(toasts("info")).toEqual([movedToast("idle_timeout")]);
    expect(movedToast("idle_timeout")).toBe("Moved idle_timeout into keepalive: the collector refuses the old key beside a keepalive block.");
    expect(entries()).toBe(1);
    // Idle Timeout now edits the section's key.
    await retypeInto(user, byId("datadog-idle-timeout-server"), "2m");
    expect(valueOf(RX_LEGACY)).toEqual({ endpoint: "localhost:8127", keepalive: { enabled: false, idle_timeout: "2m" } });
    act(() => void builderStore().undo());
    act(() => void builderStore().undo());
    expect(text()).toBe(CORPUS);
  });

  it("Idle Timeout typed beside a flat keep_alives_enabled: false moves it into keepalive with the write, toasted that keep-alives are now off", async () => {
    const base = ownReceiver("    keep_alives_enabled: false # off");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "checked");
    await typeInto(user, byId("datadog-idle-timeout-server"), "30s");
    expect(valueOf(RX)).toEqual({ keepalive: { idle_timeout: "30s", enabled: false } });
    expect(toasts("info")).toEqual([
      "Moved keep_alives_enabled into keepalive: the collector refuses the old key beside a keepalive block. Keep-alives are now off, as keep_alives_enabled said.",
    ]);
    expect(toasts("info")).toEqual([`${movedToast("keep_alives_enabled")}${NOW_OFF_TOAST}`]);
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "unchecked");
    expect(entries()).toBe(1);
  });

  it("Idle Timeout typed beside a flat keep_alives_enabled: true moves it without the now-off sentence", async () => {
    const user = renderForm(ownReceiver("    keep_alives_enabled: true"), RX);
    await openSection(user, "Performance: HTTP Server");
    await typeInto(user, byId("datadog-idle-timeout-server"), "30s");
    expect(valueOf(RX)).toEqual({ keepalive: { idle_timeout: "30s", enabled: true } });
    // A no-op to the collector, which doesn't refuse it beside keepalive (server.go:217-227): no reason given.
    expect(toasts("info")).toEqual(["Moved keep_alives_enabled into keepalive."]);
    expect(toasts("info")).toEqual([movedNoOpToast("keep_alives_enabled")]);
  });

  it("a zero flat idle_timeout (0s, 0, 0m0s) moved by the box is toasted without the refusal reason", async () => {
    for (const zero of ["0s", "0", "0m0s"]) {
      const user = renderForm(ownReceiver(`    idle_timeout: ${zero}`), RX);
      await openSection(user, "Performance: HTTP Server");
      await user.click(box("Enable HTTP Keep-Alives"));
      expect(valueOf(RX).keepalive).toEqual({ enabled: false, idle_timeout: zero === "0" ? 0 : zero });
      expect(toasts("info")).toEqual(["Moved idle_timeout into keepalive."]);
      cleanup();
      vi.mocked(toast.info).mockClear();
    }
  });

  it("a flat idle_timeout cleared and, after the pause, retyped: the input keeps focus and what is typed goes to keepalive.idle_timeout", async () => {
    const user = renderForm(ownReceiver("    idle_timeout: 30s"), RX);
    await openSection(user, "Performance: HTTP Server");
    expect(byId("datadog-idle-timeout-server")).toHaveValue("30s");
    await clearPauseRetype(user, "datadog-idle-timeout-server", "45s");
    expect(valueOf(RX)).toEqual({ keepalive: { idle_timeout: "45s" } });
    expect(toasts("info")).toEqual([]);
  });

  it("both flat keys move with one change and one toast; the box's own change wins over keep_alives_enabled", async () => {
    const base = ownReceiver("    idle_timeout: 45s\n    keep_alives_enabled: true");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(valueOf(RX)).toEqual({ keepalive: { enabled: false, idle_timeout: "45s" } });
    // keep_alives_enabled: true, which the collector doesn't refuse beside keepalive, is removed without the reason.
    expect(toasts("info")).toEqual([`${movedToast("idle_timeout")} ${removedNoOpToast("keep_alives_enabled")}`]);
    expect(removedNoOpToast("keep_alives_enabled")).toBe("Removed keep_alives_enabled.");
    expect(entries()).toBe(1);
  });

  it("K1: ticking over keepalive {enabled: false} beside a flat keep_alives_enabled: false removes both, and the emptied block", async () => {
    const base = ownReceiver("    keepalive:\n      enabled: false\n    keep_alives_enabled: false\n    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    expect(box("Enable HTTP Keep-Alives")).toHaveAttribute("data-state", "unchecked");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(text()).toBe(ownReceiver("    endpoint: localhost:8126"));
    expect(text()).not.toContain("keepalive");
    expect(toasts("info")).toEqual([removedToast("keep_alives_enabled")]);
    expect(entries()).toBe(1);
  });

  it("K2: Idle Timeout shows a flat idle_timeout beside keepalive (it overrides it, server.go:235-239); cleared, both go, and the emptied block", async () => {
    const base = ownReceiver("    keepalive:\n      idle_timeout: 30s\n    idle_timeout: 0\n    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    expect(byId("datadog-idle-timeout-server")).toHaveValue("0");
    await retypeInto(user, byId("datadog-idle-timeout-server"), "");
    expect(text()).toBe(ownReceiver("    endpoint: localhost:8126"));
    // A zero flat idle_timeout isn't refused beside keepalive: no reason given.
    expect(toasts("info")).toEqual([removedNoOpToast("idle_timeout")]);
    expect(entries()).toBe(1);
  });

  it("Idle Timeout typed over a flat idle_timeout beside keepalive writes keepalive.idle_timeout and removes the flat key, toasted", async () => {
    const base = ownReceiver("    keepalive:\n      enabled: true\n    idle_timeout: 90s");
    const user = renderForm(base, RX);
    await openSection(user, "Performance: HTTP Server");
    expect(byId("datadog-idle-timeout-server")).toHaveValue("90s");
    await retypeInto(user, byId("datadog-idle-timeout-server"), "2m");
    expect(valueOf(RX)).toEqual({ keepalive: { enabled: true, idle_timeout: "2m" } });
    expect(toasts("info")).toEqual([removedToast("idle_timeout")]);
    expect(byId("datadog-idle-timeout-server")).toHaveValue("2m");
    expect(entries()).toBe(1);
  });

  it("a flat idle_timeout written as a number moves plain, as typed", async () => {
    const user = renderForm(ownReceiver("    idle_timeout: 60000000000"), RX);
    await openSection(user, "Performance: HTTP Server");
    await user.click(box("Enable HTTP Keep-Alives"));
    expect(LF(text())).toContain("    keepalive:\n      enabled: false\n      idle_timeout: 60000000000\n");
  });
});

describe("the authenticator", () => {
  it("cleared, the whole auth block goes (\"blank disables auth\")", async () => {
    const base = ownReceiver("    auth:\n      authenticator: bearertokenauth/dd\n      request_params: [tenant]\n    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Security");
    expect(byId("datadog-auth")).toHaveValue("bearertokenauth/dd");
    await retypeInto(user, byId("datadog-auth"), "   ");
    expect(valueOf(RX)).toEqual({ endpoint: "localhost:8126" });
    expect(entries()).toBe(1);
  });

  it("a space under the cursor isn't written at the pause; leaving writes the trimmed id", async () => {
    const base = ownReceiver("    endpoint: localhost:8126");
    const user = renderForm(base, RX);
    await openSection(user, "Security");
    await user.click(byId("datadog-auth"));
    await user.keyboard("oidc ");
    await act(() => new Promise((resolve) => setTimeout(resolve, FIELD_WRITE_DELAY_MS + 100)));
    expect(text()).toBe(base);
    expect(byId("datadog-auth")).toHaveValue("oidc ");
    await user.tab();
    expect(valueOf(RX).auth).toEqual({ authenticator: "oidc" });
  });
});

// ── Privacy ──

describe("privacy", () => {
  async function openAll(user: UserEvent) {
    for (let round = 0; round < 3; round++) {
      for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
    }
  }
  function scan(mark: string): string[] {
    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.name !== "value" && attribute.value.includes(mark)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
      if (element.tagName === "OPTION" && (element as HTMLOptionElement).value.includes(mark)) leaks.push("option value");
    }
    return leaks;
  }

  it("the exporter puts no key or value in any attribute, every section open and every select opened", async () => {
    const MARK = "zq-mark";
    const marked = ownExporter(
      [
        `    api: {key: ${MARK}-key, site: ${MARK}-site}`,
        `    hostname: ${MARK}-host`,
        `    proxy_url: http://${MARK}-proxy`,
        `    keepalive: {idle_conn_timeout: ${MARK}-idle}`,
        `    host_metadata: {hostname_source: ${MARK}-source, tags: [${MARK}-tag]}`,
        `    traces: {endpoint: ${MARK}-te, ignore_resources: [${MARK}-ir], peer_tags: [${MARK}-pt]}`,
        `    metrics: {histograms: {mode: ${MARK}-hm}, sums: {cumulative_monotonic_mode: ${MARK}-sm}, summaries: {mode: ${MARK}-su}}`,
        `    logs: {endpoint: ${MARK}-le}`,
      ].join("\n"),
    );
    const user = renderForm(marked, EX);
    await openAll(user);
    const shown = document.body.textContent + [...document.querySelectorAll("input")].map((e) => e.value).join();
    for (const what of ["key", "site", "host", "proxy", "idle", "source", "tag", "te", "ir", "pt", "hm", "sm", "su", "le"]) {
      expect(shown).toContain(`${MARK}-${what}`);
    }
    const leaks = scan(MARK);
    for (const label of ["Site", "Hostname Source", "Histogram Mode", "Cumulative Sum Mode", "Summary Mode"]) {
      await user.click(combo(label));
      leaks.push(...scan(MARK));
      await user.keyboard("{Escape}");
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
  });

  it("the receiver puts no key or value in any attribute: its authenticator, compression items, headers, TLS and CORS", async () => {
    const MARK = "zq-mark";
    const marked = ownReceiver(
      [
        `    endpoint: ${MARK}-ep:8126`,
        `    auth: {authenticator: ${MARK}-auth}`,
        `    compression_algorithms: ["", ${MARK}-algo]`,
        `    tls: {cert_file: ${MARK}-cert}`,
        `    cors: {allowed_origins: [${MARK}-origin]}`,
        `    response_headers: {${MARK}-name: ${MARK}-value}`,
        `    keepalive: {idle_timeout: ${MARK}-idle}`,
      ].join("\n"),
    );
    const user = renderForm(marked, RX);
    await openAll(user);
    const shown = document.body.textContent + [...document.querySelectorAll("input")].map((e) => e.value).join();
    for (const what of ["ep", "auth", "algo", "cert", "origin", "name", "value", "idle"]) expect(shown).toContain(`${MARK}-${what}`);
    expect(scan(MARK)).toEqual([]);
    expect(text()).toBe(marked);
  });
});
