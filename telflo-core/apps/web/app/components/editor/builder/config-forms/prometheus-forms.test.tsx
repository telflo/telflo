import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { FormProvider, useComponentForm } from "./form-context.js";
import {
  ADD_METRIC_SUFFIXES_ALERT,
  CONSTANT_LABELS_HINT,
  LABEL_NOUNS,
  PrometheusExporterForm,
} from "./PrometheusExporterForm.js";
import {
  nextJobName,
  PrometheusReceiverForm,
  REMOVED_AUTHORIZATION,
  REMOVED_BASIC_AUTH,
} from "./PrometheusReceiverForm.js";
import {
  PRW_ADD_METRIC_SUFFIXES_ALERT,
  PrometheusRemoteWriteExporterForm,
  RW2_GATE_HINT,
} from "./PrometheusRemoteWriteExporterForm.js";
import { isPrometheusDuration, PROMETHEUS_DURATION_MESSAGE } from "./shared/prometheus-duration.js";
import { PROMETHEUS_TLS_HINT, PROMETHEUS_TLS_LABEL } from "./shared/PrometheusTLSSection.js";
import { CLIENT_TLS_HINT } from "./shared/TLSConfigSection.js";
import { INSECURE_COPY } from "./shared/TLSInsecureCheckbox.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { findPaletteEntry, paletteDefaultConfig } from "~/lib/graph/palette.js";
import { componentValueText } from "~/lib/graph/text-edits.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";
import { formControls } from "~/test/form-controls.js";

/*
 * The prometheus receiver and exporter and the remote write exporter: their
 * forms over the form contract. Each field is driven as a person would on
 * the metrics corpus text (comments, an anchor and a merge, flow and block
 * lists, a bare `0750`), LF and CRLF, and writes only its key. The exporter
 * (5) and remote write (7) cases follow; the remote write http:// alert's
 * two assert it is gone.
 *
 * Collector claims cite contrib v0.162.0 (`receiver/prometheusreceiver`,
 * `exporter/prometheusexporter`, `exporter/prometheusremotewriteexporter`),
 * prometheus v3.14.0 (`config/config.go`) and prometheus/common v0.71.0
 * (`config/http_config.go`, `model/time.go`), which the receiver's
 * `config:` block is loaded by (`receiver/prometheusreceiver/config.go:187-205`).
 */

const LF = (text: string) => text.replace(/\r\n/g, "\n");
const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

/** The metrics corpus (LF): comments, an anchor and a merge, a bare `0750` (`queue_size`). */
const CORPUS = LF(corpusText("forms-metrics.yaml"));

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

const infoToasts = () => vi.mocked(toast.info).mock.calls.map(([message]) => message);

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

const RECEIVER = "receivers.prometheus";
const EXPORTER = "exporters.prometheus";
const PRW = "exporters.prometheusremotewrite";
const MIMIR = "exporters.prometheus_remote_write/mimir";

function formOf(key: string): ReactNode {
  if (key.startsWith("receivers.")) return <PrometheusReceiverForm />;
  if (key.startsWith("exporters.prometheus") && !key.includes("remote")) return <PrometheusExporterForm />;
  return <PrometheusRemoteWriteExporterForm />;
}

function renderForm(key: string, text = CORPUS) {
  openText(text);
  const user = userEvent.setup();
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
const jobsOf = (written = text()) => ((valueOf(RECEIVER, written).config as Value).scrape_configs as Value[]) ?? [];
/** A hint line, by its whole text ("… · Default 5m" spans elements). */
const hint = (whole: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

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

/** Expands a job's card by its header ("Job #2: node"). */
async function openJob(user: UserEvent, number: number) {
  const header = screen.getByRole("button", { name: new RegExp(`^Job #${number}:`) });
  if (header.getAttribute("aria-expanded") !== "true") await user.click(header);
}

/** Opens every `<details>` (Advanced Options, the Security box's authentication). */
async function openDetails(user: UserEvent) {
  for (const summary of document.querySelectorAll("summary")) {
    if (!(summary.parentElement as HTMLDetailsElement).open) await user.click(summary);
  }
}

/** A text holding `type`'s palette default under `subType`, in a metrics pipeline. */
function paletteText(type: ComponentType, subType: string, key = subType): string {
  const config = paletteDefaultConfig(findPaletteEntry(type, subType)!);
  return stringify({
    ...(type === "receiver" ? {} : { receivers: { otlp: { protocols: { grpc: null } } } }),
    [`${type}s`]: { [key]: config },
    ...(type === "exporter" ? {} : { exporters: { debug: {} } }),
    service: {
      pipelines: {
        metrics: type === "exporter" ? { receivers: ["otlp"], exporters: [key] } : { receivers: [key], exporters: ["debug"] },
      },
    },
  });
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

const job = (value: Value, index: number) => ((value.config as Value).scrape_configs as Value[])[index]!;

const CASES: FieldCase[] = [
  // the receiver
  {
    name: "receiver Trim Metric Suffixes",
    key: RECEIVER,
    edit: (user) => user.click(byId("trim-suffixes")),
    from: "    trim_metric_suffixes: false\n",
    to: "    trim_metric_suffixes: true\n",
    check: (v) => expect(v.trim_metric_suffixes).toBe(true),
  },
  {
    name: "receiver Report Extra Scrape Metrics, Prometheus' own global key",
    key: RECEIVER,
    edit: (user) => user.click(byId("extra-metrics")),
    from: "        extra_scrape_metrics: true # Prometheus' own key, not the receiver's\n",
    to: "        extra_scrape_metrics: false # Prometheus' own key, not the receiver's\n",
    check: (v) => expect((v.config as Value).global).toEqual({ extra_scrape_metrics: false }),
  },
  {
    name: "receiver Job Name",
    key: RECEIVER,
    edit: (user) => retypeInto(user, byId("job-name-0"), "collector"),
    from: "        - job_name: otel-collector\n",
    to: "        - job_name: collector\n",
    check: (v) => expect(job(v, 0).job_name).toBe("collector"),
  },
  {
    name: "receiver Scrape Interval, a unit combination",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await retypeInto(user, byId("scrape-interval-1"), "1h30m");
    },
    from: "          scrape_interval: 15s\n",
    to: "          scrape_interval: 1h30m\n",
    check: (v) => expect(job(v, 1).scrape_interval).toBe("1h30m"),
  },
  {
    name: "receiver Scrape Timeout (unset)",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await typeInto(user, byId("scrape-timeout-1"), "5s");
    },
    from: "                env: prod\n",
    to: "                env: prod\n          scrape_timeout: 5s\n",
    check: (v) => expect(job(v, 1).scrape_timeout).toBe("5s"),
  },
  {
    name: "receiver Metrics Path",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await retypeInto(user, byId("metrics-path-1"), "/probe");
    },
    from: "          metrics_path: /metrics\n",
    to: "          metrics_path: /probe\n",
    check: (v) => expect(job(v, 1).metrics_path).toBe("/probe"),
  },
  {
    name: "receiver Scheme",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await pickIn(user, byId("scheme-1"), "HTTP");
    },
    from: "          scheme: https\n",
    to: "          scheme: http\n",
    check: (v) => expect(job(v, 1).scheme).toBe("http"),
  },
  {
    name: "receiver a static target row",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await retypeInto(user, screen.getAllByPlaceholderText("e.g. localhost:8080")[2]!, "node-3:9100");
    },
    from: "                - node-2:9100\n",
    to: "                - node-3:9100\n",
    check: (v) => expect((job(v, 1).static_configs as Value[])[0]!.targets).toEqual(["node-1:9100", "node-3:9100"]),
  },
  {
    name: "receiver Add Target appends the seed",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await user.click(screen.getAllByRole("button", { name: "Add Target" })[1]!);
    },
    from: "                - node-2:9100\n",
    to: "                - node-2:9100\n                - localhost:8080\n",
    check: (v) => expect((job(v, 1).static_configs as Value[])[0]!.targets).toEqual(["node-1:9100", "node-2:9100", "localhost:8080"]),
  },
  {
    name: "receiver Honor Labels",
    key: RECEIVER,
    edit: async (user) => {
      await openJob(user, 2);
      await openDetails(user);
      await user.click(byId("honor-labels-1"));
    },
    from: "                env: prod\n",
    to: "                env: prod\n          honor_labels: true\n",
    check: (v) => expect(job(v, 1).honor_labels).toBe(true),
  },
  {
    name: "receiver Honor Timestamps unticked (ticked while unset)",
    key: RECEIVER,
    edit: async (user) => {
      await openDetails(user);
      await user.click(byId("honor-timestamps-0"));
    },
    from: "            - targets: [localhost:8888]\n",
    to: "            - targets: [localhost:8888]\n          honor_timestamps: false\n",
    check: (v) => expect(job(v, 0).honor_timestamps).toBe(false),
  },
  {
    name: "receiver Sample Limit, written plain",
    key: RECEIVER,
    edit: async (user) => {
      await openDetails(user);
      await typeInto(user, byId("sample-limit-0"), "1000");
    },
    from: "            - targets: [localhost:8888]\n",
    to: "            - targets: [localhost:8888]\n          sample_limit: 1000\n",
    check: (v) => expect(job(v, 0).sample_limit).toBe(1000),
  },
  {
    name: "receiver Target Limit, written plain",
    key: RECEIVER,
    edit: async (user) => {
      await openDetails(user);
      await typeInto(user, byId("target-limit-0"), "0");
    },
    from: "            - targets: [localhost:8888]\n",
    to: "            - targets: [localhost:8888]\n          target_limit: 0\n",
    check: (v) => expect(job(v, 0).target_limit).toBe(0),
  },
  {
    name: "receiver a job's TLS ticked writes Prometheus' versions",
    key: RECEIVER,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(byId("prometheus-job-0-tls-enable"));
    },
    from: "            - targets: [localhost:8888]\n",
    to: "            - targets: [localhost:8888]\n          tls_config:\n            min_version: TLS12\n            max_version: TLS13\n",
    check: (v) => expect(job(v, 0).tls_config).toEqual({ min_version: "TLS12", max_version: "TLS13" }),
  },
  {
    name: "receiver a job's Max TLS Version",
    key: RECEIVER,
    edit: async (user) => {
      await openSection(user, "Security");
      await pickIn(user, byId("prometheus-job-1-tls-max-version"), "TLS 1.2");
    },
    from: "            max_version: TLS13\n",
    to: "            max_version: TLS12\n",
    check: (v) => expect(job(v, 1).tls_config).toEqual({ min_version: "TLS12", max_version: "TLS12" }),
  },
  {
    name: "receiver a job's Certificate File",
    key: RECEIVER,
    edit: async (user) => {
      await openSection(user, "Security");
      await typeInto(user, byId("prometheus-job-1-tls-cert-file"), "/etc/scrape.crt");
    },
    from: "            max_version: TLS13\n",
    to: "            max_version: TLS13\n            cert_file: /etc/scrape.crt\n",
    check: (v) => expect((job(v, 1).tls_config as Value).cert_file).toBe("/etc/scrape.crt"),
  },
  {
    name: "receiver Basic Authentication Username",
    key: RECEIVER,
    edit: async (user) => {
      await openSection(user, "Security");
      await openDetails(user);
      await retypeInto(user, byId("basic-auth-username-1"), "metrics");
    },
    from: "            username: scraper\n",
    to: "            username: metrics\n",
    check: (v) => expect(job(v, 1).basic_auth).toEqual({ username: "metrics", password: "${env:SCRAPE_PASSWORD}" }),
  },
  {
    name: "receiver Authorization Credentials File (unset)",
    key: RECEIVER,
    edit: async (user) => {
      await openSection(user, "Security");
      await openDetails(user);
      await typeInto(user, byId("auth-credentials-file-0"), "/var/run/token");
    },
    from: "            - targets: [localhost:8888]\n",
    to: "            - targets: [localhost:8888]\n          authorization:\n            credentials_file: /var/run/token\n",
    check: (v) => expect(job(v, 0).authorization).toEqual({ credentials_file: "/var/run/token" }),
  },
  // the exporter
  {
    name: "exporter Endpoint",
    key: EXPORTER,
    edit: (user) => retypeInto(user, byId("prometheus-exporter-endpoint"), "0.0.0.0:9464"),
    from: "    endpoint: 0.0.0.0:8889\n",
    to: "    endpoint: 0.0.0.0:9464\n",
    check: (v) => expect(v.endpoint).toBe("0.0.0.0:9464"),
  },
  {
    name: "exporter Namespace",
    key: EXPORTER,
    edit: (user) => retypeInto(user, byId("prometheus-exporter-namespace"), "app"),
    from: "  prometheus:\n    endpoint: 0.0.0.0:8889\n    namespace: telflo\n",
    to: "  prometheus:\n    endpoint: 0.0.0.0:8889\n    namespace: app\n",
    check: (v) => expect(v.namespace).toBe("app"),
  },
  {
    name: "exporter a constant label's value",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Constant Labels");
      await retypeInto(user, screen.getByDisplayValue("eu-west-1"), "us-east-1");
    },
    from: "      region: eu-west-1 # the deployment's\n",
    to: "      region: us-east-1 # the deployment's\n",
    check: (v) => expect(v.const_labels).toEqual({ region: "us-east-1" }),
  },
  {
    name: "exporter Translation Strategy (unset)",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Metric Naming");
      await pickIn(user, byId("prometheus-exporter-translation-strategy"), "Keep UTF-8 + suffixes");
    },
    from: "    add_metric_suffixes: false\n",
    to: "    add_metric_suffixes: false\n    translation_strategy: NoUTF8EscapingWithSuffixes\n",
    check: (v) => expect(v.translation_strategy).toBe("NoUTF8EscapingWithSuffixes"),
  },
  {
    name: "exporter Metric Expiration",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await retypeInto(user, byId("prometheus-exporter-metric-expiration"), "10m");
    },
    from: "    send_timestamps: true\n    metric_expiration: 5m\n",
    to: "    send_timestamps: true\n    metric_expiration: 10m\n",
    check: (v) => expect(v.metric_expiration).toBe("10m"),
  },
  {
    name: "exporter Send timestamps unticked removes the key",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prometheus-exporter-send-timestamps"));
    },
    from: "    send_timestamps: true\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("send_timestamps"),
  },
  {
    name: "exporter Convert all resource attributes ticked writes enabled in place",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prometheus-exporter-resource-to-telemetry"));
    },
    from: "      enabled: false\n    enable_open_metrics: true\n",
    to: "      enabled: true\n    enable_open_metrics: true\n",
    check: (v) => expect(v.resource_to_telemetry_conversion).toEqual({ enabled: true }),
  },
  {
    name: "exporter Omit otel_scope_* labels (unset)",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prometheus-exporter-without-scope-info"));
    },
    from: "    add_metric_suffixes: false\n",
    to: "    add_metric_suffixes: false\n    without_scope_info: true\n",
    check: (v) => expect(v.without_scope_info).toBe(true),
  },
  {
    name: "exporter TLS ticked (the server variant, configtls' versions)",
    key: EXPORTER,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(byId("tls-enable-the-scrape-endpoint"));
    },
    from: "    add_metric_suffixes: false\n",
    to: '    add_metric_suffixes: false\n    tls:\n      min_version: "1.2"\n      max_version: "1.3"\n',
    check: (v) => expect(v.tls).toEqual({ min_version: "1.2", max_version: "1.3" }),
  },
  // remote write
  {
    name: "remote write Endpoint (top-level: no http block)",
    key: PRW,
    edit: (user) => retypeInto(user, byId("prwe-endpoint"), "https://mimir.example.com/api/v1/push"),
    from: "    endpoint: https://prometheus.example.com/api/v1/write\n",
    to: "    endpoint: https://mimir.example.com/api/v1/push\n",
    check: (v) => expect(v.endpoint).toBe("https://mimir.example.com/api/v1/push"),
  },
  {
    name: "remote write an external label's value",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "External Labels");
      await retypeInto(user, screen.getByDisplayValue("prod"), "staging");
    },
    from: "      cluster: prod\n",
    to: "      cluster: staging\n",
    check: (v) => expect(v.external_labels).toEqual({ cluster: "staging" }),
  },
  {
    name: "remote write an HTTP header's value",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "HTTP Headers");
      await retypeInto(user, screen.getByDisplayValue("tenant-1"), "tenant-2");
    },
    from: "      X-Scope-OrgID: tenant-1\n",
    to: "      X-Scope-OrgID: tenant-2\n",
    check: (v) => expect(v.headers).toEqual({ "X-Scope-OrgID": "tenant-2" }),
  },
  {
    name: "remote write Translation Strategy (unset)",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Metric Naming");
      await pickIn(user, byId("prwe-translation-strategy"), "Underscore escaping, no suffixes");
    },
    from: "      max_interval: 30s\n",
    to: "      max_interval: 30s\n    translation_strategy: UnderscoreEscapingWithoutSuffixes\n",
    check: (v) => expect(v.translation_strategy).toBe("UnderscoreEscapingWithoutSuffixes"),
  },
  {
    name: "remote write Convert all unticked removes enabled, and the emptied block",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prwe-resource-to-telemetry"));
    },
    from: "    resource_to_telemetry_conversion:\n      enabled: true\n",
    to: "",
    check: (v) => expect(v).not.toHaveProperty("resource_to_telemetry_conversion"),
  },
  {
    name: "remote write Target Info unticked writes enabled: false",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prwe-target-info"));
    },
    from: "    target_info:\n      enabled: true\n",
    to: "    target_info:\n      enabled: false\n",
    check: (v) => expect(v.target_info).toEqual({ enabled: false }),
  },
  {
    name: "remote write Send metadata (unset)",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Behavior");
      await user.click(byId("prwe-send-metadata"));
    },
    from: "      max_interval: 30s\n",
    to: "      max_interval: 30s\n    send_metadata: true\n",
    check: (v) => expect(v.send_metadata).toBe(true),
  },
  {
    name: "remote write Queue Workers, under remote_write_queue",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Delivery");
      await retypeInto(user, byId("prwe-num-consumers"), "1");
    },
    from: "      num_consumers: 5\n",
    to: "      num_consumers: 1\n",
    // The bare `0750` stays as written (YAML 1.2 reads 750; the collector's yaml.v3, octal).
    check: (v) => expect(v.remote_write_queue).toEqual({ enabled: true, queue_size: 750, num_consumers: 1 }),
  },
  {
    name: "remote write Timeout (unset)",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Delivery");
      await typeInto(user, byId("prwe-timeout"), "10s");
    },
    from: "      max_interval: 30s\n",
    to: "      max_interval: 30s\n    timeout: 10s\n",
    check: (v) => expect(v.timeout).toBe("10s"),
  },
  {
    name: "remote write Retry Initial Interval",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "Delivery");
      await retypeInto(user, byId("retry-initial-interval"), "50ms");
    },
    from: "      initial_interval: 5s\n",
    to: "      initial_interval: 50ms\n",
    check: (v) => expect((v.retry_on_failure as Value).initial_interval).toBe("50ms"),
  },
  {
    name: "remote write insecure ticked (no tls block)",
    key: PRW,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(byId("tls-insecure"));
    },
    from: "      max_interval: 30s\n",
    to: "      max_interval: 30s\n    tls:\n      insecure: true\n",
    check: (v) => expect(v.tls).toEqual({ insecure: true }),
  },
  {
    name: "remote write/mimir TLS ticked beside insecure, by key",
    key: MIMIR,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(byId("tls-enable-the-remote-write-connection"));
    },
    from: "      insecure: false\n",
    to: '      insecure: false\n      min_version: "1.2"\n      max_version: "1.3"\n',
    check: (v) => expect(v.tls).toEqual({ insecure: false, min_version: "1.2", max_version: "1.3" }),
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
    [RECEIVER]: { textboxes: 26, all: 38, field: "prometheus-job-1-tls-max-version" },
    [EXPORTER]: { textboxes: 6, all: 13, field: "prometheus-exporter-translation-strategy" },
    [PRW]: { textboxes: 14, all: 22, field: "retry-initial-interval" },
    [MIMIR]: { textboxes: 10, all: 18, field: "prwe-num-consumers" },
  };
  // One test per form and text, each with its own time limit.
  it.each(Object.keys(OPENED).flatMap((key) => [[key, "LF", CORPUS] as const, [key, "CRLF", CRLF(CORPUS)] as const]))(
    "opening %s (%s), every section, card and details, focusing every field, writes nothing and leaves the editor clean",
    async (key, _name, base) => {
      const user = renderForm(key, base);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      await openDetails(user);
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

// ── The receiver ──

/** A receiver text of its own: jobs as given, under `config.scrape_configs`. */
function receiverText(jobs: string): string {
  return [
    "receivers:",
    "  prometheus:",
    "    config:",
    "      scrape_configs:",
    jobs.trimEnd(),
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    metrics:",
    "      receivers: [prometheus]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

describe("PrometheusReceiverForm: jobs", () => {
  it("Add Job seeds the first job-N no job has, expanded, in one entry (Prometheus refuses a repeat, config/config.go:444)", async () => {
    // A plain `job-${count + 1}` would give job-3 here, which job 2 already is.
    const before = receiverText(
      [
        "        - job_name: job-1",
        "          static_configs: [{targets: [a:1]}]",
        "        - job_name: job-3",
        "          static_configs: [{targets: [b:1]}]",
      ].join("\n"),
    );
    const user = renderForm(RECEIVER, before);
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(jobsOf().map((j) => j.job_name)).toEqual(["job-1", "job-3", "job-4"]);
    expect(jobsOf()[2]).toEqual({ job_name: "job-4", scrape_interval: "10s", static_configs: [{ targets: ["localhost:8888"] }] });
    expect(entries()).toBe(1);
    expect(screen.getByRole("button", { name: "Job #3: job-4" })).toHaveAttribute("aria-expanded", "true");
    expect(byId("job-name-2")).toHaveValue("job-4");
  });

  it("nextJobName counts up from the job count past every name in use", () => {
    expect(nextJobName([], 0)).toBe("job-1");
    expect(nextJobName(["otel-collector", "node"], 2)).toBe("job-3");
    expect(nextJobName(["job-3", "job-4"], 2)).toBe("job-5");
    expect(nextJobName(["job-1"], 1)).toBe("job-2");
  });

  it("Add Job on a receiver with no scrape_configs writes the list", async () => {
    const before = receiverText("").replace("    config:\n      scrape_configs:\n", "    trim_metric_suffixes: true\n");
    const user = renderForm(RECEIVER, before);
    expect(screen.getByText("No scrape jobs configured")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(jobsOf()).toEqual([{ job_name: "job-1", scrape_interval: "10s", static_configs: [{ targets: ["localhost:8888"] }] }]);
    expect(entries()).toBe(1);
  });

  it("Add Target on a job with no target group writes static_configs: [{targets: [localhost:8080]}]", async () => {
    const before = receiverText("        - job_name: bare # no targets yet\n          scrape_interval: 15s");
    const user = renderForm(RECEIVER, before);
    await user.click(screen.getByRole("button", { name: "Add Target" }));
    expect(text()).toBe(
      before.replace(
        "          scrape_interval: 15s\n",
        "          scrape_interval: 15s\n          static_configs:\n            - targets:\n                - localhost:8080\n",
      ),
    );
    expect(jobsOf()[0]!.static_configs).toEqual([{ targets: ["localhost:8080"] }]);
    expect(entries()).toBe(1);
  });

  it("a job's other target groups and labels stay; a first group that isn't a mapping is read-only with the unshowable-value hint", async () => {
    const before = receiverText(
      [
        "        - job_name: groups",
        "          static_configs:",
        "            - targets: [a:1]",
        "              labels: {env: prod}",
        "            - targets: [b:1]",
        "        - job_name: odd",
        "          static_configs: [a:1]",
      ].join("\n"),
    );
    const user = renderForm(RECEIVER, before);
    await user.click(screen.getByRole("button", { name: "Add Target" }));
    expect(jobsOf()[0]!.static_configs).toEqual([{ targets: ["a:1", "localhost:8080"], labels: { env: "prod" } }, { targets: ["b:1"] }]);
    await openJob(user, 2);
    expect(screen.getAllByRole("button", { name: "Add Target" })).toHaveLength(1);
    expect(screen.getByText("This value is written in a form this field can't show. Edit it in the YAML below.")).toBeInTheDocument();
  });

  it("a job's interval read through a merge shows the anchor's value", () => {
    renderForm(RECEIVER);
    expect(byId("scrape-interval-0")).toHaveValue("30s");
    expect(byId("scrape-timeout-0")).toHaveValue("10s");
  });

  it("removing a job removes its lines; the expanded card is still its job's", async () => {
    const user = renderForm(RECEIVER);
    await openJob(user, 2);
    await user.click(screen.getAllByRole("button", { name: "Remove job" })[0]!);
    expect(jobsOf().map((j) => j.job_name)).toEqual(["node"]);
    expect(text()).not.toContain("otel-collector");
    expect(text()).toContain("x-scrape: &scrape\n");
    expect(entries()).toBe(1);
    expect(screen.getByRole("button", { name: "Job #1: node" })).toHaveAttribute("aria-expanded", "true");
    expect(byId("job-name-0")).toHaveValue("node");
  });

  it("dragging a job by keyboard moves its lines, its expanded state with it", async () => {
    layOutRows();
    const user = renderForm(RECEIVER);
    await openJob(user, 2);
    await user.click(screen.getByRole("button", { name: "Job #1: otel-collector" }));
    const [first] = screen.getAllByRole("button", { name: "Drag to reorder" });
    await dragByKeyboard(first!, 1);
    expect(jobsOf().map((j) => j.job_name)).toEqual(["node", "otel-collector"]);
    expect(entries()).toBe(1);
    expect(text()).toContain("        # the hosts, over TLS\n        - job_name: node\n");
    // The node job's card was open: it moved with its job.
    expect(screen.getByRole("button", { name: "Job #1: node" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Job #2: otel-collector" })).toHaveAttribute("aria-expanded", "false");
  });

  it("Job Name cleared keeps the key, written \"\" (an item's key stays)", async () => {
    const user = renderForm(RECEIVER);
    await retypeInto(user, byId("job-name-0"), "");
    expect(text()).toContain('        - job_name: ""\n');
    expect(entries()).toBe(1);
  });
});

describe("PrometheusReceiverForm: the fixes", () => {
  it("Report Extra Scrape Metrics writes config.global.extra_scrape_metrics, never the removed receiver key (CHANGELOG.md:3911-3913)", async () => {
    const before = paletteText("receiver", "prometheus");
    const user = renderForm(RECEIVER, before);
    expect(byId("extra-metrics")).not.toBeChecked();
    await user.click(byId("extra-metrics"));
    expect(text()).not.toContain("report_extra_scrape_metrics");
    expect((valueOf(RECEIVER).config as Value).global).toEqual({ extra_scrape_metrics: true });
    expect(entries()).toBe(1);
  });

  it("the scrape TLS box writes Prometheus' versions TLS12/TLS13, never configtls' \"1.2\" (http_config.go:72-91)", async () => {
    const user = renderForm(RECEIVER, paletteText("receiver", "prometheus"));
    await openSection(user, "Security");
    await user.click(byId("prometheus-job-0-tls-enable"));
    expect(jobsOf()[0]!.tls_config).toEqual({ min_version: "TLS12", max_version: "TLS13" });
    expect(text()).not.toMatch(/"1\.[0-3]"/);
    expect(entries()).toBe(1);
    // Unticking removes the block.
    await user.click(byId("prometheus-job-0-tls-enable"));
    expect(jobsOf()[0]).not.toHaveProperty("tls_config");
  });

  it("the scrape TLS section: the Customize label and hint, TLS10-TLS13, versions blank when unset, no server-only fields", async () => {
    const before = receiverText("        - job_name: tls\n          tls_config:\n            ca_file: /ca.pem\n          static_configs: [{targets: [a:1]}]");
    const user = renderForm(RECEIVER, before);
    await openSection(user, "Security");
    expect(screen.getByText(PROMETHEUS_TLS_LABEL, { selector: "label" })).toBeInTheDocument();
    expect(screen.getByText(PROMETHEUS_TLS_HINT)).toBeInTheDocument();
    expect(PROMETHEUS_TLS_LABEL).toBe("Customize TLS for this job's scrapes");
    expect(PROMETHEUS_TLS_HINT).toBe("Off: https scrapes use the system's CAs. Scheme decides whether TLS is used.");
    expect(byId("prometheus-job-0-tls-ca-file")).toHaveValue("/ca.pem");
    expect(byId("prometheus-job-0-tls-min-version")).toHaveTextContent(/^$/);
    expect(byId("prometheus-job-0-tls-max-version")).toHaveTextContent(/^$/);
    expect(await optionsOf(user, byId("prometheus-job-0-tls-min-version"))).toEqual(["TLS 1.0", "TLS 1.1", "TLS 1.2", "TLS 1.3"]);
    for (const absent of ["Client CA File", "Enable client CA file reload", "Reload Interval", "Include system CA certificates pool"]) {
      expect(screen.queryByText(absent)).toBeNull();
    }
    await pickIn(user, byId("prometheus-job-0-tls-min-version"), "TLS 1.0");
    expect(jobsOf()[0]!.tls_config).toEqual({ ca_file: "/ca.pem", min_version: "TLS10" });
    // A configtls version in the text shows as written.
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(RECEIVER, before.replace("            ca_file: /ca.pem\n", '            min_version: "1.2"\n'));
    await openSection(userEvent.setup(), "Security");
    expect(byId("prometheus-job-0-tls-min-version")).toHaveTextContent("1.2");
  });

  it("typing into basic authentication removes authorization, one entry, with the toast (http_config.go:434-437)", async () => {
    const before = receiverText(
      "        - job_name: secured\n          authorization:\n            credentials_file: /token # bearer\n          static_configs: [{targets: [a:1]}]",
    );
    const user = renderForm(RECEIVER, before);
    await openSection(user, "Security");
    await openDetails(user);
    expect(byId("auth-credentials-file-0")).toHaveValue("/token");
    await typeInto(user, byId("basic-auth-username-0"), "scraper");
    expect(jobsOf()[0]).not.toHaveProperty("authorization");
    expect(jobsOf()[0]!.basic_auth).toEqual({ username: "scraper" });
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_AUTHORIZATION]);
    expect(REMOVED_AUTHORIZATION).toBe("Removed authorization: it can't be used with basic authentication.");
    act(() => void builderStore().undo());
    expect(text()).toBe(before);
  });

  it("typing into authorization removes basic authentication, one entry, with the toast", async () => {
    const user = renderForm(RECEIVER);
    await openSection(user, "Security");
    await openDetails(user);
    await typeInto(user, byId("auth-type-1"), "Bearer");
    expect(jobsOf()[1]).not.toHaveProperty("basic_auth");
    expect(jobsOf()[1]!.authorization).toEqual({ type: "Bearer" });
    expect(text()).not.toContain("SCRAPE_PASSWORD");
    expect(entries()).toBe(1);
    expect(infoToasts()).toEqual([REMOVED_BASIC_AUTH]);
    expect(REMOVED_BASIC_AUTH).toBe("Removed basic authentication: it can't be used with authorization.");
  });

  it("clearing an authentication block's last field removes the block; a key it doesn't show keeps it; neither touches the other", async () => {
    const before = receiverText(
      [
        "        - job_name: a",
        "          basic_auth:",
        "            username: me",
        "          static_configs: [{targets: [a:1]}]",
        "        - job_name: b",
        "          basic_auth:",
        "            username: me",
        "            password: secret",
        "          static_configs: [{targets: [b:1]}]",
      ].join("\n"),
    );
    const user = renderForm(RECEIVER, before);
    await openSection(user, "Security");
    await openDetails(user);
    await retypeInto(user, byId("basic-auth-username-0"), "");
    expect(jobsOf()[0]).not.toHaveProperty("basic_auth");
    await retypeInto(user, byId("basic-auth-username-1"), "");
    expect(jobsOf()[1]!.basic_auth).toEqual({ password: "secret" });
    expect(infoToasts()).toEqual([]);
  });

  it("shows unset as Prometheus' defaults: Honor Timestamps ticked, the timeout's rule, Scheme http, Interval 1m", async () => {
    const user = renderForm(RECEIVER, receiverText("        - job_name: plain\n          static_configs: [{targets: [a:1]}]"));
    await openDetails(user);
    // config/config.go:203-211 (DefaultScrapeConfig), 913-915 (the timeout).
    expect(byId("honor-timestamps-0")).toBeChecked();
    expect(byId("honor-labels-0")).not.toBeChecked();
    expect(hint("Default 10s, or the scrape interval if shorter")).toBeInTheDocument();
    expect(byId("scrape-timeout-0")).toHaveAttribute("placeholder", "10s");
    expect(hint("Default 1m")).toBeInTheDocument();
    expect(hint("Default http")).toBeInTheDocument();
    expect(byId("scheme-0")).toHaveTextContent("HTTP");
    expect(hint("Max samples per scrape. · Default 0 (no limit)")).toBeInTheDocument();
    expect(text()).not.toContain("scheme");
  });

  it("checks the interval and timeout with Prometheus' grammar: 1d and 1h30m pass, 1.5h shows the error and is still written", async () => {
    const user = renderForm(RECEIVER);
    await retypeInto(user, byId("scrape-interval-0"), "1d");
    expect(screen.queryByText(PROMETHEUS_DURATION_MESSAGE)).toBeNull();
    await retypeInto(user, byId("scrape-timeout-0"), "1.5h");
    expect(screen.getByText(PROMETHEUS_DURATION_MESSAGE)).toBeInTheDocument();
    expect(PROMETHEUS_DURATION_MESSAGE).toBe("Invalid duration format. Use: 1ms, 1s, 1m, 1h, 1d, 1w, or 1y");
    expect(jobsOf()[0]!.scrape_timeout).toBe("1.5h");
    expect(screen.queryByText(/Use: 1ns/)).toBeNull();
  });

  it("isPrometheusDuration is prometheus/common's ParseDuration (model/time.go:211-280)", () => {
    for (const ok of ["", "0", "1h30m", "1d", "2w", "1y", "500ms", "1m30s500ms", "90s", "${env:SCRAPE_INTERVAL}"]) {
      expect([ok, isPrometheusDuration(ok)]).toEqual([ok, true]);
    }
    for (const bad of ["1.5h", "30", "1ns", "1us", "-5s", "1m1h", "1s1s", "1 m", "s", "00", "1h 30m"]) {
      expect([bad, isPrometheusDuration(bad)]).toEqual([bad, false]);
    }
  });

  it("keeps the YAML-only alert and empty-state copy", () => {
    renderForm(RECEIVER, receiverText("").replace("    config:\n      scrape_configs:\n", "    config: {}\n"));
    expect(screen.getByText("YAML-only features")).toBeInTheDocument();
    expect(
      screen.getByText("Service discovery (Kubernetes, Consul), relabeling, and OAuth2 are not available in this form. Edit them in the YAML editor."),
    ).toBeInTheDocument();
    expect(screen.getByText("No scrape jobs configured")).toBeInTheDocument();
  });

  it("a scrape_configs it can't show is read-only with the unshowable-value hint; Add Job is disabled", () => {
    renderForm(RECEIVER, receiverText("").replace("      scrape_configs:\n", "      scrape_configs: not-a-list\n"));
    expect(screen.getByText("This value is written in a form this field can't show. Edit it in the YAML below.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Job" })).toBeDisabled();
  });
});

// ── The exporter: five cases ──

describe("PrometheusExporterForm cases", () => {
  const defaults = () => paletteText("exporter", "prometheus");

  it("renders endpoint value from config", () => {
    renderForm(EXPORTER, defaults());
    expect(byId("prometheus-exporter-endpoint")).toHaveValue("0.0.0.0:8889");
  });

  it("renders collapsible section headers", () => {
    renderForm(EXPORTER, defaults());
    for (const name of ["Constant Labels", "Metric Naming", "Behavior", "TLS"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("renders custom endpoint and namespace values", () => {
    renderForm(EXPORTER, defaults().replace("endpoint: 0.0.0.0:8889\n", "endpoint: 127.0.0.1:9464\n    namespace: myapp\n"));
    expect(byId("prometheus-exporter-endpoint")).toHaveValue("127.0.0.1:9464");
    expect(byId("prometheus-exporter-namespace")).toHaveValue("myapp");
  });

  it("edits a metrics pipeline's exporter in place: only the edited lines change (was: generates valid YAML)", async () => {
    const before = defaults();
    const user = renderForm(EXPORTER, before);
    await typeInto(user, byId("prometheus-exporter-namespace"), "myapp");
    expect(text()).toBe(before.replace("    metric_expiration: 5m\n", "    metric_expiration: 5m\n    namespace: myapp\n"));
    expect(valueOf(EXPORTER)).toEqual({ endpoint: "0.0.0.0:8889", metric_expiration: "5m", namespace: "myapp" });
  });

  it("beside the prometheus receiver (the shared type string), each form edits its own entry", async () => {
    const both = [
      "receivers:",
      "  prometheus:",
      "    config:",
      "      scrape_configs:",
      "        - job_name: otel-collector",
      "          scrape_interval: 10s",
      "          static_configs: [{targets: [localhost:8888]}]",
      "exporters:",
      "  prometheus:",
      "    endpoint: 0.0.0.0:8889",
      "    metric_expiration: 5m",
      "service:",
      "  pipelines:",
      "    metrics:",
      "      receivers: [prometheus]",
      "      exporters: [prometheus]",
      "",
    ].join("\n");
    const user = renderForm(EXPORTER, both);
    expect(byId("prometheus-exporter-endpoint")).toHaveValue("0.0.0.0:8889");
    await retypeInto(user, byId("prometheus-exporter-endpoint"), "0.0.0.0:9090");
    cleanup();
    const after = text();
    expect(after).toBe(both.replace("    endpoint: 0.0.0.0:8889\n", "    endpoint: 0.0.0.0:9090\n"));

    const user2 = userEvent.setup();
    render(
      <ComponentForm nodeId={componentNamed(RECEIVER).id}>
        <PrometheusReceiverForm />
      </ComponentForm>,
    );
    expect(byId("job-name-0")).toHaveValue("otel-collector");
    await retypeInto(user2, byId("scrape-interval-0"), "15s");
    expect(text()).toBe(after.replace("          scrape_interval: 10s\n", "          scrape_interval: 15s\n"));
    expect(valueOf(EXPORTER)).toEqual({ endpoint: "0.0.0.0:9090", metric_expiration: "5m" });
  });
});

describe("PrometheusExporterForm: the changes", () => {
  it("Constant Labels have label nouns", async () => {
    const user = renderForm(EXPORTER);
    await openSection(user, "Constant Labels");
    expect(screen.getByPlaceholderText("Label name")).toHaveValue("region");
    expect(screen.getByPlaceholderText("Label value")).toHaveValue("eu-west-1");
    expect(screen.getByPlaceholderText("e.g. env")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. prod")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove label" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Header name")).toBeNull();
    expect(LABEL_NOUNS.exists).toBe("A label with this name already exists.");
    // A new label from the staging row.
    await user.type(screen.getByPlaceholderText("e.g. env"), "env");
    await user.type(screen.getByPlaceholderText("e.g. prod"), "prod");
    await user.click(screen.getByRole("button", { name: "Add label" }));
    expect(valueOf(EXPORTER).const_labels).toEqual({ region: "eu-west-1", env: "prod" });
    // A clash is refused under the row.
    await retypeInto(user, screen.getAllByPlaceholderText("Label name")[1]!, "region");
    expect(screen.getByText("A label with this name already exists.")).toBeInTheDocument();
  });

  it("Translation Strategy shows the unset option while unset; choosing it removes the key (its token never written)", async () => {
    const user = renderForm(EXPORTER);
    await openSection(user, "Metric Naming");
    const trigger = byId("prometheus-exporter-translation-strategy");
    expect(trigger).toHaveTextContent("Collector default (suffixes added)");
    expect(await optionsOf(user, trigger)).toEqual([
      "Collector default (suffixes added)",
      "Underscore escaping + suffixes",
      "Underscore escaping, no suffixes",
      "Keep UTF-8 + suffixes",
      "No translation (pass-through)",
    ]);
    await pickIn(user, trigger, "No translation (pass-through)");
    expect(valueOf(EXPORTER).translation_strategy).toBe("NoTranslation");
    await pickIn(user, trigger, "Collector default (suffixes added)");
    expect(valueOf(EXPORTER)).not.toHaveProperty("translation_strategy");
    expect(text()).toBe(CORPUS);
    expect(text()).not.toContain("__unset__");
  });

  it("the add_metric_suffixes alert says the collector ignores it (the DisableAddMetricSuffixes gate, collector.go:126-130); none while unset", async () => {
    const user = renderForm(EXPORTER);
    await openSection(user, "Metric Naming");
    expect(screen.getByText(ADD_METRIC_SUFFIXES_ALERT)).toBeInTheDocument();
    expect(ADD_METRIC_SUFFIXES_ALERT).toBe(
      "This config sets the deprecated add_metric_suffixes field; the collector ignores it (the exporter.prometheusexporter.DisableAddMetricSuffixes feature gate is on by default).",
    );
    expect(screen.queryByText(/ignored whenever a translation strategy is selected/)).toBeNull();
    cleanup();
    useEditorStore.setState(initialState, true);
    const user2 = renderForm(EXPORTER, CORPUS.replace("    add_metric_suffixes: false\n", ""));
    await openSection(user2, "Metric Naming");
    expect(screen.queryByText(ADD_METRIC_SUFFIXES_ALERT)).toBeNull();
  });

  it("Convert all resource attributes can't be ticked while resource_constant_labels is set (config.go:76-78), with the hint; ticked, it can be unticked", async () => {
    const withLabels = CORPUS.replace("    enable_open_metrics: true\n", "    enable_open_metrics: true\n    resource_constant_labels:\n      included: [service.name]\n");
    const user = renderForm(EXPORTER, withLabels);
    await openSection(user, "Behavior");
    expect(byId("prometheus-exporter-resource-to-telemetry")).toBeDisabled();
    expect(screen.getByText(CONSTANT_LABELS_HINT)).toBeInTheDocument();
    expect(CONSTANT_LABELS_HINT).toBe("Can't be used while resource_constant_labels is set.");
    await user.click(byId("prometheus-exporter-resource-to-telemetry"));
    expect(text()).toBe(withLabels);

    cleanup();
    useEditorStore.setState(initialState, true);
    const ticked = withLabels.replace("      enabled: false\n", "      enabled: true\n");
    const user2 = renderForm(EXPORTER, ticked);
    await openSection(user2, "Behavior");
    expect(byId("prometheus-exporter-resource-to-telemetry")).toBeEnabled();
    await user2.click(byId("prometheus-exporter-resource-to-telemetry"));
    expect(valueOf(EXPORTER)).not.toHaveProperty("resource_to_telemetry_conversion");
    expect(valueOf(EXPORTER).resource_constant_labels).toEqual({ included: ["service.name"] });

    // An empty resource_constant_labels is unset to the collector: the box is enabled, with no hint.
    cleanup();
    useEditorStore.setState(initialState, true);
    const user3 = renderForm(EXPORTER, CORPUS.replace("    enable_open_metrics: true\n", "    enable_open_metrics: true\n    resource_constant_labels: {}\n"));
    await openSection(user3, "Behavior");
    expect(byId("prometheus-exporter-resource-to-telemetry")).toBeEnabled();
    expect(screen.queryByText(CONSTANT_LABELS_HINT)).toBeNull();
  });

  it("Convert all keeps the block's other keys: unticking removes enabled only", async () => {
    const before = CORPUS.replace("      enabled: false\n    enable_open_metrics", "      enabled: true\n      exclude_service_attributes: true\n    enable_open_metrics");
    const user = renderForm(EXPORTER, before);
    await openSection(user, "Behavior");
    await user.click(byId("prometheus-exporter-resource-to-telemetry"));
    expect(valueOf(EXPORTER).resource_to_telemetry_conversion).toEqual({ exclude_service_attributes: true });
  });
});

// ── Remote write: seven cases ──

describe("PrometheusRemoteWriteExporterForm cases", () => {
  const defaults = () => paletteText("exporter", "prometheusremotewrite");
  const RW = "exporters.prometheusremotewrite";

  it("renders endpoint value from config", () => {
    renderForm(RW, defaults());
    expect(byId("prwe-endpoint")).toHaveValue("https://prometheus.example.com/api/v1/write");
  });

  it("renders collapsible section headers", () => {
    renderForm(RW, defaults());
    for (const name of ["External Labels", "HTTP Headers", "Metric Naming", "Behavior", "Delivery", "TLS"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("doesn't warn of an http:// endpoint without insecure: the alert was false and is gone", async () => {
    const user = renderForm(RW, defaults().replace("https://prometheus.example.com/api/v1/write", "http://clickhouse:9090/write"));
    await openSection(user, "TLS");
    expect(screen.queryByText(/TLS is required by default/)).toBeNull();
    expect(screen.queryByText(/required for plain http:\/\/ endpoints/)).toBeNull();
  });

  it("doesn't warn once tls.insecure is set either", async () => {
    const user = renderForm(
      RW,
      defaults().replace("https://prometheus.example.com/api/v1/write\n", "http://clickhouse:9090/write\n    tls:\n      insecure: true\n"),
    );
    await openSection(user, "TLS");
    expect(byId("tls-insecure")).toBeChecked();
    expect(screen.queryByText(/TLS is required by default/)).toBeNull();
  });

  it("edits a metrics pipeline's exporter in place: only the edited lines change (was: generates valid YAML)", async () => {
    const before = defaults();
    const user = renderForm(RW, before);
    await typeInto(user, byId("prwe-namespace"), "myapp");
    expect(text()).toBe(
      before.replace("    endpoint: https://prometheus.example.com/api/v1/write\n", "    endpoint: https://prometheus.example.com/api/v1/write\n    namespace: myapp\n"),
    );
  });

  it("survives a YAML round-trip: the text it writes opens with what it wrote", async () => {
    const user = renderForm(RW, defaults());
    await retypeInto(user, byId("prwe-endpoint"), "https://mimir.example.com/api/v1/push");
    const written = text();
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(RW, written);
    expect(byId("prwe-endpoint")).toHaveValue("https://mimir.example.com/api/v1/push");
    expect(valueOf(RW).endpoint).toBe("https://mimir.example.com/api/v1/push");
  });

  it("opens the collector's prometheus_remote_write spelling in this form, and edits it", async () => {
    const yaml = [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc:",
      "        endpoint: localhost:4317",
      "exporters:",
      "  prometheus_remote_write:",
      "    endpoint: https://mimir.example.com/api/v1/push",
      "    resource_to_telemetry_conversion:",
      "      enabled: true",
      "service:",
      "  pipelines:",
      "    metrics:",
      "      receivers: [otlp]",
      "      exporters: [prometheus_remote_write]",
      "",
    ].join("\n");
    const user = renderForm("exporters.prometheus_remote_write", yaml);
    expect(componentNamed("exporters.prometheus_remote_write").data.componentSubType).toBe("prometheusremotewrite");
    expect(byId("prwe-endpoint")).toHaveValue("https://mimir.example.com/api/v1/push");
    await openSection(user, "Behavior");
    expect(byId("prwe-resource-to-telemetry")).toBeChecked();
    await user.click(byId("prwe-exclude-service-attributes"));
    expect(valueOf("exporters.prometheus_remote_write").resource_to_telemetry_conversion).toEqual({
      enabled: true,
      exclude_service_attributes: true,
    });
  });
});

describe("PrometheusRemoteWriteExporterForm: the changes", () => {
  it("with an http block, Endpoint, Headers, TLS and insecure read and write under http (config.go:188-194); Timeout stays top-level", async () => {
    const before = CORPUS.replace(
      "    protobuf_message: prometheus.WriteRequest\n    tls:\n      insecure: false\n",
      "    protobuf_message: prometheus.WriteRequest\n    tls:\n      insecure: false\n    http: # the collector reads these\n      endpoint: https://mimir.example.com/http\n      headers:\n        X-Tenant: a\n",
    );
    const user = renderForm(MIMIR, before);
    expect(byId("prwe-endpoint")).toHaveValue("https://mimir.example.com/http");
    await retypeInto(user, byId("prwe-endpoint"), "https://mimir.example.com/v2");
    expect((valueOf(MIMIR).http as Value).endpoint).toBe("https://mimir.example.com/v2");
    expect(valueOf(MIMIR).endpoint).toBe("https://mimir.example.com/api/v1/push");
    await openSection(user, "HTTP Headers");
    expect(screen.getByDisplayValue("a")).toBeInTheDocument();
    await openSection(user, "TLS");
    // The top-level tls (insecure: false) is ignored by the collector: the box reads http's (unset).
    expect(byId("tls-insecure")).not.toBeChecked();
    await user.click(byId("tls-insecure"));
    expect((valueOf(MIMIR).http as Value).tls).toEqual({ insecure: true });
    expect(valueOf(MIMIR).tls).toEqual({ insecure: false });
    await user.click(byId("tls-enable-the-remote-write-connection"));
    expect((valueOf(MIMIR).http as Value).tls).toEqual({ insecure: true, min_version: "1.2", max_version: "1.3" });
    await openSection(user, "Delivery");
    await typeInto(user, byId("prwe-timeout"), "9s");
    expect(valueOf(MIMIR).timeout).toBe("9s");
    expect(valueOf(MIMIR).http as Value).not.toHaveProperty("timeout");
  });

  it("an http: key with no value (null) still takes the client fields: the endpoint is written under it", async () => {
    const before = CORPUS.replace("    protobuf_message: prometheus.WriteRequest\n", "    protobuf_message: prometheus.WriteRequest\n    http:\n");
    const user = renderForm(MIMIR, before);
    expect(byId("prwe-endpoint")).toHaveValue("");
    await typeInto(user, byId("prwe-endpoint"), "https://a.example.com/push");
    expect((valueOf(MIMIR).http as Value).endpoint).toBe("https://a.example.com/push");
    expect(valueOf(MIMIR).endpoint).toBe("https://mimir.example.com/api/v1/push");
  });

  it("TLS is the client variant: the Customize label and hint, no Client CA fields (configtls.ClientConfig)", async () => {
    const user = renderForm(MIMIR);
    await openSection(user, "TLS");
    expect(screen.getByText("Customize TLS for the remote-write connection", { selector: "label" })).toBeInTheDocument();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(screen.queryByText("Enable TLS for the remote-write connection")).toBeNull();
    await user.click(byId("tls-enable-the-remote-write-connection"));
    expect(screen.queryByText("Client CA File")).toBeNull();
    expect(screen.queryByText("Enable client CA file reload")).toBeNull();
  });

  it("unticking the TLS section keeps insecure; the box then shows unticked", async () => {
    const before = CORPUS.replace("      insecure: false\n", '      insecure: true # plaintext\n      min_version: "1.2"\n      ca_file: /ca.pem\n');
    const user = renderForm(MIMIR, before);
    await openSection(user, "TLS");
    expect(byId("tls-enable-the-remote-write-connection")).toBeChecked();
    await user.click(byId("tls-enable-the-remote-write-connection"));
    expect(text()).toBe(CORPUS.replace("      insecure: false\n", "      insecure: true # plaintext\n"));
    expect(entries()).toBe(1);
    expect(byId("tls-enable-the-remote-write-connection")).not.toBeChecked();
    expect(byId("tls-insecure")).toBeChecked();
    // A block holding only insecure removes nothing more; ticking writes the versions beside it.
    await user.click(byId("tls-enable-the-remote-write-connection"));
    expect(valueOf(MIMIR).tls).toEqual({ insecure: true, min_version: "1.2", max_version: "1.3" });
  });

  it("the insecure box has the HTTP copy and is always shown", async () => {
    const user = renderForm(PRW);
    await openSection(user, "TLS");
    expect(screen.getByText(INSECURE_COPY.http.label)).toBeInTheDocument();
    expect(screen.queryByText("Disable TLS (required for plain http:// endpoints)")).toBeNull();
    expect(byId("tls-insecure")).not.toBeChecked();
  });

  it("offers NoUTF8EscapingWithSuffixes and NoTranslation only while protobuf_message is v2, then with the gate's hint (config.go:260-274)", async () => {
    const user = renderForm(MIMIR);
    await openSection(user, "Metric Naming");
    expect(await optionsOf(user, byId("prwe-translation-strategy"))).toEqual([
      "Collector default (suffixes added)",
      "Underscore escaping + suffixes",
      "Underscore escaping, no suffixes",
    ]);
    expect(screen.queryByText(RW2_GATE_HINT)).toBeNull();

    cleanup();
    useEditorStore.setState(initialState, true);
    const v2 = CORPUS.replace("protobuf_message: prometheus.WriteRequest", "protobuf_message: io.prometheus.write.v2.Request");
    const user2 = renderForm(MIMIR, v2);
    await openSection(user2, "Metric Naming");
    expect(await optionsOf(user2, byId("prwe-translation-strategy"))).toEqual([
      "Collector default (suffixes added)",
      "Underscore escaping + suffixes",
      "Underscore escaping, no suffixes",
      "Keep UTF-8 + suffixes",
      "No translation (pass-through)",
    ]);
    expect(screen.getByText(RW2_GATE_HINT)).toBeInTheDocument();
    expect(RW2_GATE_HINT).toBe("Needs the exporter.prometheusremotewritexporter.enableSendingRW2 feature gate (off by default).");
    await pickIn(user2, byId("prwe-translation-strategy"), "No translation (pass-through)");
    expect(valueOf(MIMIR).translation_strategy).toBe("NoTranslation");

    // Written with v1 (refused), it shows as written.
    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(MIMIR, CORPUS.replace("    protobuf_message: prometheus.WriteRequest\n", "    protobuf_message: prometheus.WriteRequest\n    translation_strategy: NoTranslation\n"));
    await openSection(userEvent.setup(), "Metric Naming");
    expect(byId("prwe-translation-strategy")).toHaveTextContent("NoTranslation");
  });

  it("shows the exporter's defaults: Retry Initial Interval 50ms (factory.go:91-92), Timeout 5s, the queue 10000 and 5, Target Info ticked", async () => {
    const user = renderForm(MIMIR);
    await openSection(user, "Delivery");
    expect(hint("Wait this long after the first failure. · Default 50ms")).toBeInTheDocument();
    expect(byId("retry-initial-interval")).toHaveAttribute("placeholder", "50ms");
    expect(byId("prwe-timeout")).toHaveAttribute("placeholder", "5s");
    expect(byId("prwe-queue-size")).toHaveAttribute("placeholder", "10000");
    expect(byId("prwe-num-consumers")).toHaveAttribute("placeholder", "5");
    await openSection(user, "Behavior");
    expect(byId("prwe-target-info")).toBeChecked();
  });

  it("Target Info: unticking writes target_info.enabled: false; ticking removes it, the block with it", async () => {
    const user = renderForm(MIMIR);
    await openSection(user, "Behavior");
    await user.click(byId("prwe-target-info"));
    expect(valueOf(MIMIR).target_info).toEqual({ enabled: false });
    await user.click(byId("prwe-target-info"));
    expect(text()).toBe(CORPUS);
  });

  it("the queue fields write under remote_write_queue, by key", async () => {
    const user = renderForm(MIMIR);
    await openSection(user, "Delivery");
    await typeInto(user, byId("prwe-queue-size"), "5000");
    expect(valueOf(MIMIR).remote_write_queue).toEqual({ queue_size: 5000 });
    await retypeInto(user, byId("prwe-queue-size"), "");
    expect(valueOf(MIMIR).remote_write_queue).toEqual({});
  });

  it("External Labels have label nouns; HTTP Headers keep the header nouns", async () => {
    const user = renderForm(PRW);
    await openSection(user, "External Labels");
    await openSection(user, "HTTP Headers");
    expect(screen.getByPlaceholderText("Label name")).toHaveValue("cluster");
    expect(screen.getByPlaceholderText("Header name")).toHaveValue("X-Scope-OrgID");
    expect(screen.getByRole("button", { name: "Add label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add header" })).toBeInTheDocument();
  });

  it("Convert all can't be ticked while resource_constant_labels is set (config.go:217-219), with the hint", async () => {
    const user = renderForm(MIMIR, CORPUS.replace("    protobuf_message: prometheus.WriteRequest\n", "    protobuf_message: prometheus.WriteRequest\n    resource_constant_labels:\n      excluded: [k8s.pod.uid]\n"));
    await openSection(user, "Behavior");
    expect(byId("prwe-resource-to-telemetry")).toBeDisabled();
    expect(screen.getByText(CONSTANT_LABELS_HINT)).toBeInTheDocument();
  });

  it("keeps the add_metric_suffixes alert, which is right here (no gate)", async () => {
    const user = renderForm(MIMIR, CORPUS.replace("    protobuf_message: prometheus.WriteRequest\n", "    protobuf_message: prometheus.WriteRequest\n    add_metric_suffixes: false\n"));
    await openSection(user, "Metric Naming");
    expect(screen.getByText(PRW_ADD_METRIC_SUFFIXES_ALERT)).toBeInTheDocument();
  });
});

// ── Sortable cards by keyboard ──

const ROW_HEIGHT = 40;

/** The sortable card an element is in: a child of a `space-y-3` list whose children all hold a drag handle. */
function rowOf(element: Element): HTMLElement | null {
  for (let e: HTMLElement | null = element as HTMLElement; e; e = e.parentElement) {
    const parent = e.parentElement;
    if (
      parent?.classList.contains("space-y-3") &&
      [...parent.children].every((child) => child.querySelector('[aria-roledescription="sortable"]'))
    ) {
      return e;
    }
  }
  return null;
}

/** dnd-kit measures rows; jsdom's are all zero, so cards are laid out 40 px apart. */
function layOutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = rowOf(this);
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return { x: 0, y: top, top, left: 0, right: 200, bottom: top + ROW_HEIGHT, width: 200, height: ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
  });
}

async function press(element: Element, key: string, code = key) {
  await act(async () => {
    fireEvent.keyDown(element, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Drags handle `handle` by keyboard: Space, `steps` arrows, Space. */
async function dragByKeyboard(handle: HTMLElement, steps: number) {
  act(() => handle.focus());
  await press(handle, " ", "Space");
  for (let i = 0; i < Math.abs(steps); i++) await press(handle, steps > 0 ? "ArrowDown" : "ArrowUp");
  await press(handle, " ", "Space");
}

// ── Privacy ──

describe("privacy", () => {
  it("puts no job name or config value in any attribute; a job's TLS ids are by its index", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  prometheus:",
      "    config:",
      "      scrape_configs:",
      `        - job_name: ${MARK}-job Scrape`,
      `          scrape_interval: ${MARK}-interval`,
      `          scheme: ${MARK}-scheme`,
      `          metrics_path: /${MARK}`,
      `          static_configs: [{targets: [${MARK}-target:1]}]`,
      "          tls_config:",
      `            min_version: ${MARK}-tls`,
      `            cert_file: /${MARK}.crt`,
      "          basic_auth:",
      `            username: ${MARK}-user`,
      `        - job_name: ${MARK}-second`,
      "exporters:",
      "  prometheus:",
      `    endpoint: ${MARK}-endpoint`,
      `    const_labels: {${MARK}-label: ${MARK}-value}`,
      `    translation_strategy: ${MARK}-strategy`,
      "  prometheusremotewrite:",
      `    endpoint: https://${MARK}.example.com`,
      `    external_labels: {${MARK}-ext: ${MARK}-v}`,
      `    protobuf_message: ${MARK}-message`,
      "    http:",
      `      headers: {${MARK}-h: ${MARK}-hv}`,
      "      tls:",
      `        ca_file: /${MARK}-ca`,
      "service:",
      "  pipelines:",
      "    metrics:",
      "      receivers: [prometheus]",
      "      exporters: [prometheus, prometheusremotewrite]",
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
      [RECEIVER, ["scheme-0", "prometheus-job-0-tls-min-version", "prometheus-job-0-tls-max-version"]],
      [EXPORTER, ["prometheus-exporter-translation-strategy"]],
      [PRW, ["prwe-translation-strategy"]],
    ];
    for (const [key, menus] of runs) {
      cleanup();
      useEditorStore.setState(initialState, true);
      layOutRows();
      const user = renderForm(key, marked);
      for (let round = 0; round < 3; round++) {
        for (const button of screen.queryAllByRole("button", { expanded: false })) await user.click(button);
      }
      await openDetails(user);
      expect(shown()).toContain(`${MARK}-`);
      scan(key);

      for (const handle of screen.queryAllByRole("button", { name: "Drag to reorder" })) {
        act(() => handle.focus());
        await press(handle, " ", "Space");
        await press(handle, "ArrowDown");
        scan(`${key} (dragging)`);
        await press(handle, "Escape");
      }

      for (const menu of menus) {
        await user.click(byId(menu));
        expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
        scan(`${key} (${menu} menu)`);
        await user.keyboard("{Escape}");
      }
      if (key === RECEIVER) {
        // The ids hold the job's index, not "<job name> Scrape".
        const ids = [...document.querySelectorAll("[id*='tls']")].map((element) => element.id);
        expect(ids).toEqual(expect.arrayContaining(["prometheus-job-0-tls-enable", "prometheus-job-0-tls-cert-file", "prometheus-job-1-tls-enable"]));
        for (const id of ids) expect(id).toMatch(/^prometheus-job-\d+-tls-[a-z-]+$/);
      }
      expect(text()).toBe(marked);
      expect(entries()).toBe(0);
    }
    expect(leaks).toEqual([]);
  }, 30_000);
});

// ── The YAML box ──

describe("the YAML box", () => {
  it("a job added in the YAML box gets its own card, collapsed; the open card stays its job's", () => {
    // The corpus's merge names an anchor outside the receiver, which its YAML box can't hold.
    renderForm(RECEIVER, receiverText("        - job_name: otel-collector\n          static_configs: [{targets: [a:1]}]"));
    const nodeId = componentNamed(RECEIVER).id;
    act(() => {
      builderStore().setComponentValue(
        nodeId,
        componentValueText(text(), RECEIVER).replace(/( *)scrape_configs:\n/, (line, indent: string) => `${line}${indent}  - job_name: first\n`),
      );
    });
    expect(screen.getByRole("button", { name: "Job #1: first" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Job #2: otel-collector" })).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("button", { name: "Job #2: otel-collector" }).closest("div.rounded-md")!).getByDisplayValue("otel-collector")).toBeInTheDocument();
  });
});
