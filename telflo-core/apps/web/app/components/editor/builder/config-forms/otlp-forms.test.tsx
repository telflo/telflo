import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { FormProvider, useComponentForm } from "./form-context.js";
import { OTLPExporterForm } from "./OTLPExporterForm.js";
import {
  getActiveQuickSetupId,
  getQuickSetupChanges,
  isPresetHeader,
  OTLPHTTPExporterForm,
  QUICK_SETUP_CUSTOM,
  QUICK_SETUP_PRESETS,
} from "./OTLPHTTPExporterForm.js";
import { OTLPReceiverForm } from "./OTLPReceiverForm.js";
import { CLIENT_TLS_HINT } from "./shared/TLSConfigSection.js";
import { INSECURE_COPY } from "./shared/TLSInsecureCheckbox.js";
import { findPaletteEntry, paletteDefaultConfig } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import type { ComponentType } from "~/lib/graph/types.js";
import { selectIsDirty, selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * The OTLP receiver and exporters (D9b Task 6): their three forms
 * over the form's fields. Each field is driven as a person would (typing,
 * clicking, picking) and writes only its key: the text changes in that
 * key's lines only, on a text with comments, an anchor and a merge, `0750`,
 * and CRLF line endings (decision 2). What they show follows decision 3.
 * 27 cases (OTLPReceiverForm 8, OTLPExporterForm 6, OTLPHTTPExporterForm
 * 13) follow, their YAML checks as text-edit checks; "custom keeps user
 * headers" now keeps the person's own `Authorization` too (decision 4).
 */

const OTLP = [
  "# The OTLP forms (D9b Task 6).",
  "receivers:",
  "  otlp: # the receiver",
  "    protocols:",
  "      grpc:",
  "        endpoint: 0.0.0.0:4317 # gRPC",
  "        max_recv_msg_size_mib: 0750 # octal to the collector",
  "        keepalive:",
  "          server_parameters:",
  "            time: 1h # ping",
  "      http: # HTTP",
  "        endpoint: 0.0.0.0:4318",
  "        compression_algorithms:",
  "          - gzip # the usual",
  "        traces_url_path: /traces # custom",
  "  otlp/bare:",
  "    protocols:",
  "      grpc:",
  "exporters:",
  "  otlp/base: &base # shared settings",
  "    timeout: 10s # the base's",
  "    compression: gzip",
  "    sending_queue:",
  "      num_consumers: 2",
  "  otlp: # the exporter",
  "    endpoint: otelcol:4317 # downstream",
  "    timeout: 10s",
  "    compression: zstd # outside the options",
  "    tls:",
  "      insecure: true # plaintext",
  "    headers:",
  "      x-tenant: acme # the tenant",
  "    sending_queue:",
  "      queue_size: 0750",
  "  otlp/merged:",
  "    <<: *base # shared",
  "    endpoint: other:4317",
  "  otlphttp: # vendor",
  "    endpoint: https://api.example.com # base",
  "    encoding: json",
  "    headers:",
  "      Authorization: Bearer mine # the person's own",
  "    read_buffer_size: 0750",
  "    traces_endpoint: https://t.example/v1/traces",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp, otlp/bare]",
  "      exporters: [otlp, otlp/merged, otlphttp]",
  "",
].join("\n");

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderForm(key: string, form: ReactNode, text = OTLP) {
  openText(text);
  const user = userEvent.setup();
  render(<ComponentForm nodeId={componentNamed(key).id}>{form}</ComponentForm>);
  return user;
}

const text = () => builderStore().text;
const entries = () => builderStore().history.past.length;
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const box = (name: string) => screen.getByRole("checkbox", { name });
/** A hint line, by its whole text ("… · Default 5s" spans elements). */
const hint = (whole: string) =>
  screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === whole);

/** The value at `path` in the component `key`, as the collector's YAML reads it. */
function valueAt(written: string, key: string, path: readonly (string | number)[]): unknown {
  const [section, name] = key.split(".") as [string, string];
  let value: unknown = (parseYaml(written, { merge: true }) as Record<string, Record<string, unknown>>)[section]![name];
  for (const segment of path) value = (value as Record<string | number, unknown> | null)?.[segment];
  return value;
}

/** Replaces the field's text with `typed` and leaves it, as a person does. */
async function retypeInto(user: UserEvent, input: HTMLInputElement, typed: string) {
  await user.clear(input);
  if (typed !== "") await user.type(input, typed);
  await user.tab();
}

const retype = (user: UserEvent, name: string, typed: string) => retypeInto(user, field(name), typed);

async function pick(user: UserEvent, name: string, option: string) {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(screen.getByRole("option", { name: option }));
}

/** Opens a section by its title (its name also holds its count). */
async function openSection(user: UserEvent, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title.replace(/[&]/g, "\\$&")}( \\d+)?$`) }));
}

interface FieldCase {
  /** What is edited, for the test's name. */
  name: string;
  key: string;
  form: ReactNode;
  edit: (user: UserEvent) => Promise<void>;
  /** The lines before and after, in the LF text: nothing else may change. */
  from: string;
  to: string;
  /** Where to look in the component's value after, and what is there, as parsed. */
  path: readonly (string | number)[];
  value: unknown;
}

const RECEIVER = "receivers.otlp";
const GRPC_EXPORTER = "exporters.otlp";
const HTTP_EXPORTER = "exporters.otlphttp";
const receiver = <OTLPReceiverForm />;
const grpcExporter = <OTLPExporterForm />;
const httpExporter = <OTLPHTTPExporterForm />;

const GRPC_BLOCK = [
  "      grpc:",
  "        endpoint: 0.0.0.0:4317 # gRPC",
  "        max_recv_msg_size_mib: 0750 # octal to the collector",
  "        keepalive:",
  "          server_parameters:",
  "            time: 1h # ping",
  "",
].join("\n");

const CASES: FieldCase[] = [
  // The OTLP receiver
  {
    name: "receiver gRPC Endpoint",
    key: RECEIVER,
    form: receiver,
    edit: (user) => retypeInto(user, byId("grpc-endpoint"), "0.0.0.0:14317"),
    from: "        endpoint: 0.0.0.0:4317 # gRPC\n",
    to: "        endpoint: 0.0.0.0:14317 # gRPC\n",
    path: ["protocols", "grpc", "endpoint"],
    value: "0.0.0.0:14317",
  },
  {
    name: "receiver HTTP Endpoint",
    key: RECEIVER,
    form: receiver,
    edit: (user) => retypeInto(user, byId("http-endpoint"), "0.0.0.0:14318"),
    from: "        endpoint: 0.0.0.0:4318\n",
    to: "        endpoint: 0.0.0.0:14318\n",
    path: ["protocols", "http", "endpoint"],
    value: "0.0.0.0:14318",
  },
  {
    name: "receiver gRPC turned off (its block goes)",
    key: RECEIVER,
    form: receiver,
    edit: (user) => user.click(box("Enable gRPC Protocol")),
    from: GRPC_BLOCK,
    to: "",
    path: ["protocols", "grpc"],
    value: undefined,
  },
  {
    name: "receiver HTTP turned off (its block goes)",
    key: RECEIVER,
    form: receiver,
    edit: (user) => user.click(box("Enable HTTP Protocol")),
    from: "      http: # HTTP\n        endpoint: 0.0.0.0:4318\n        compression_algorithms:\n          - gzip # the usual\n        traces_url_path: /traces # custom\n",
    to: "",
    path: ["protocols", "http"],
    value: undefined,
  },
  {
    name: "receiver HTTP turned on beside a bare grpc: (its default endpoint)",
    key: "receivers.otlp/bare",
    form: receiver,
    edit: (user) => user.click(box("Enable HTTP Protocol")),
    from: "      grpc:\nexporters:",
    to: "      grpc:\n      http:\n        endpoint: localhost:4318\nexporters:",
    path: ["protocols"],
    value: { grpc: null, http: { endpoint: "localhost:4318" } },
  },
  {
    name: "receiver Transport",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await pick(user, "Transport", "UDP");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n        transport: udp\n",
    path: ["protocols", "grpc", "transport"],
    value: "udp",
  },
  {
    name: "receiver Max Receive Message Size (0 can be entered)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retype(user, "Max Receive Message Size", "0");
    },
    from: "        max_recv_msg_size_mib: 0750 # octal to the collector\n",
    to: "        max_recv_msg_size_mib: 0 # octal to the collector\n",
    path: ["protocols", "grpc", "max_recv_msg_size_mib"],
    value: 0,
  },
  {
    name: "receiver Max Concurrent Streams (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retype(user, "Max Concurrent Streams", "100");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n        max_concurrent_streams: 100\n",
    path: ["protocols", "grpc", "max_concurrent_streams"],
    value: 100,
  },
  {
    name: "receiver Read Buffer Size (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retype(user, "Read Buffer Size", "524288");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n        read_buffer_size: 524288\n",
    path: ["protocols", "grpc", "read_buffer_size"],
    value: 524288,
  },
  {
    name: "receiver Write Buffer Size (added, 0 can be entered)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retype(user, "Write Buffer Size", "0");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n        write_buffer_size: 0\n",
    path: ["protocols", "grpc", "write_buffer_size"],
    value: 0,
  },
  {
    name: "receiver Max Request Body Size (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await retype(user, "Max Request Body Size", "1e6");
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "        traces_url_path: /traces # custom\n        max_request_body_size: 1e6\n",
    path: ["protocols", "http", "max_request_body_size"],
    value: 1e6,
  },
  {
    name: "receiver Compression Algorithms, one ticked (appended as an item)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await user.click(box("zstd"));
    },
    from: "          - gzip # the usual\n",
    to: "          - gzip # the usual\n          - zstd\n",
    path: ["protocols", "http", "compression_algorithms"],
    value: ["gzip", "zstd"],
  },
  {
    name: "receiver Compression Algorithms, the last unticked (the list goes)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Performance");
      await user.click(box("gzip"));
    },
    from: "        compression_algorithms:\n          - gzip # the usual\n",
    to: "",
    path: ["protocols", "http", "compression_algorithms"],
    value: undefined,
  },
  {
    name: "receiver Keepalive Time",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Keepalive Time", "1m30s");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1m30s # ping\n",
    path: ["protocols", "grpc", "keepalive", "server_parameters", "time"],
    value: "1m30s",
  },
  {
    name: "receiver Max Connection Idle (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Max Connection Idle", "30s");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n            max_connection_idle: 30s\n",
    path: ["protocols", "grpc", "keepalive", "server_parameters", "max_connection_idle"],
    value: "30s",
  },
  {
    name: "receiver Max Connection Age (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Max Connection Age", "0");
    },
    from: "            time: 1h # ping\n",
    to: '            time: 1h # ping\n            max_connection_age: "0"\n',
    path: ["protocols", "grpc", "keepalive", "server_parameters", "max_connection_age"],
    value: "0",
  },
  {
    name: "receiver Keepalive Timeout (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Keepalive Timeout", "20s");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n            timeout: 20s\n",
    path: ["protocols", "grpc", "keepalive", "server_parameters", "timeout"],
    value: "20s",
  },
  {
    name: "receiver Min Time Between Pings (its mapping added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Min Time Between Pings", "10s");
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n          enforcement_policy:\n            min_time: 10s\n",
    path: ["protocols", "grpc", "keepalive", "enforcement_policy", "min_time"],
    value: "10s",
  },
  {
    name: "receiver Permit keepalive pings without active streams",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await user.click(box("Permit keepalive pings without active streams"));
    },
    from: "            time: 1h # ping\n",
    to: "            time: 1h # ping\n          enforcement_policy:\n            permit_without_stream: true\n",
    path: ["protocols", "grpc", "keepalive", "enforcement_policy", "permit_without_stream"],
    value: true,
  },
  {
    name: "receiver Traces URL Path",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Traces URL Path", "/v1/t");
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "        traces_url_path: /v1/t # custom\n",
    path: ["protocols", "http", "traces_url_path"],
    value: "/v1/t",
  },
  {
    name: "receiver Traces URL Path cleared (the key goes)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Traces URL Path", "");
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "",
    path: ["protocols", "http", "traces_url_path"],
    value: undefined,
  },
  {
    name: "receiver Metrics URL Path (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Metrics URL Path", "/m");
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "        traces_url_path: /traces # custom\n        metrics_url_path: /m\n",
    path: ["protocols", "http", "metrics_url_path"],
    value: "/m",
  },
  {
    name: "receiver Logs URL Path (added)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Network");
      await retype(user, "Logs URL Path", "/l");
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "        traces_url_path: /traces # custom\n        logs_url_path: /l\n",
    path: ["protocols", "http", "logs_url_path"],
    value: "/l",
  },
  {
    name: "receiver gRPC TLS turned on (the server section)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(box("Enable TLS for gRPC"));
      expect(screen.getByRole("textbox", { name: "Client CA File" })).toBeInTheDocument();
    },
    from: "            time: 1h # ping\n",
    to: '            time: 1h # ping\n        tls:\n          min_version: "1.2"\n          max_version: "1.3"\n',
    path: ["protocols", "grpc", "tls"],
    value: { min_version: "1.2", max_version: "1.3" },
  },
  {
    name: "receiver HTTP TLS turned on",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(box("Enable TLS for HTTP"));
    },
    from: "        traces_url_path: /traces # custom\n",
    to: '        traces_url_path: /traces # custom\n        tls:\n          min_version: "1.2"\n          max_version: "1.3"\n',
    path: ["protocols", "http", "tls"],
    value: { min_version: "1.2", max_version: "1.3" },
  },
  {
    name: "receiver CORS turned on (under HTTP)",
    key: RECEIVER,
    form: receiver,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(box("Enable CORS (HTTP only)"));
    },
    from: "        traces_url_path: /traces # custom\n",
    to: "        traces_url_path: /traces # custom\n        cors:\n          allowed_origins: []\n          allowed_headers: []\n          max_age: 7200\n",
    path: ["protocols", "http", "cors"],
    value: { allowed_origins: [], allowed_headers: [], max_age: 7200 },
  },
  // The OTLP gRPC exporter
  {
    name: "gRPC exporter Endpoint",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: (user) => retype(user, "Endpoint", "collector:4317"),
    from: "    endpoint: otelcol:4317 # downstream\n",
    to: "    endpoint: collector:4317 # downstream\n",
    path: ["endpoint"],
    value: "collector:4317",
  },
  {
    name: "gRPC exporter Timeout (a Go duration)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: (user) => retype(user, "Timeout", "1m30s"),
    from: "    timeout: 10s\n",
    to: "    timeout: 1m30s\n",
    path: ["timeout"],
    value: "1m30s",
  },
  {
    name: "gRPC exporter Compression (from a value outside the options)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: (user) => pick(user, "Compression", "gzip"),
    from: "    compression: zstd # outside the options\n",
    to: "    compression: gzip # outside the options\n",
    path: ["compression"],
    value: "gzip",
  },
  {
    name: "gRPC exporter Customize TLS turned off (the block goes)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(box("Customize TLS for OTLP gRPC"));
    },
    from: "    tls:\n      insecure: true # plaintext\n",
    to: "",
    path: ["tls"],
    value: undefined,
  },
  {
    name: "gRPC exporter Disable TLS (insecure) unticked",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.click(box(INSECURE_COPY.grpc.label));
    },
    from: "      insecure: true # plaintext\n",
    to: "      insecure: false # plaintext\n",
    path: ["tls", "insecure"],
    value: false,
  },
  {
    name: "gRPC exporter a metadata header's value",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Security");
      await retypeInto(user, screen.getByDisplayValue("acme") as HTMLInputElement, "globex");
    },
    from: "      x-tenant: acme # the tenant\n",
    to: "      x-tenant: globex # the tenant\n",
    path: ["headers", "x-tenant"],
    value: "globex",
  },
  {
    name: "gRPC exporter a metadata header added",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Security");
      await user.type(screen.getByPlaceholderText("e.g. Authorization"), "x-env");
      await user.type(screen.getByPlaceholderText("e.g. Bearer token"), "prod{Enter}");
    },
    from: "      x-tenant: acme # the tenant\n",
    to: "      x-tenant: acme # the tenant\n      x-env: prod\n",
    path: ["headers"],
    value: { "x-tenant": "acme", "x-env": "prod" },
  },
  {
    name: "gRPC exporter Retry turned off (unset shows on; off writes enabled: false)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Retry & Queue");
      expect(box("Enable Retry on Failure")).toBeChecked();
      await user.click(box("Enable Retry on Failure"));
    },
    from: "      queue_size: 0750\n",
    to: "      queue_size: 0750\n    retry_on_failure:\n      enabled: false\n",
    path: ["retry_on_failure"],
    value: { enabled: false },
  },
  {
    name: "gRPC exporter Queue Size (0 can be entered)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Retry & Queue");
      await retype(user, "Queue Size", "0");
    },
    from: "      queue_size: 0750\n",
    to: "      queue_size: 0\n",
    path: ["sending_queue", "queue_size"],
    value: 0,
  },
  {
    name: "gRPC exporter Consumers (added)",
    key: GRPC_EXPORTER,
    form: grpcExporter,
    edit: async (user) => {
      await openSection(user, "Retry & Queue");
      await retype(user, "Consumers", "4");
    },
    from: "      queue_size: 0750\n",
    to: "      queue_size: 0750\n      num_consumers: 4\n",
    path: ["sending_queue", "num_consumers"],
    value: 4,
  },
  // The OTLP/HTTP exporter
  {
    name: "HTTP exporter Endpoint",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Endpoint", "https://other.example.com"),
    from: "    endpoint: https://api.example.com # base\n",
    to: "    endpoint: https://other.example.com # base\n",
    path: ["endpoint"],
    value: "https://other.example.com",
  },
  {
    name: "HTTP exporter Timeout (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Timeout", "10s"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    timeout: 10s\n",
    path: ["timeout"],
    value: "10s",
  },
  {
    name: "HTTP exporter Encoding",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => pick(user, "Encoding", "Protocol Buffers (proto)"),
    from: "    encoding: json\n",
    to: "    encoding: proto\n",
    path: ["encoding"],
    value: "proto",
  },
  {
    name: "HTTP exporter Compression (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => pick(user, "Compression", "none"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    compression: none\n",
    path: ["compression"],
    value: "none",
  },
  {
    name: "HTTP exporter Traces Endpoint (its section open, as one is set)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Traces Endpoint", "https://t.example/traces"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/traces\n",
    path: ["traces_endpoint"],
    value: "https://t.example/traces",
  },
  {
    name: "HTTP exporter Metrics Endpoint (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Metrics Endpoint", "https://m.example"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    metrics_endpoint: https://m.example\n",
    path: ["metrics_endpoint"],
    value: "https://m.example",
  },
  {
    name: "HTTP exporter Logs Endpoint (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Logs Endpoint", "https://l.example"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    logs_endpoint: https://l.example\n",
    path: ["logs_endpoint"],
    value: "https://l.example",
  },
  {
    name: "HTTP exporter Profiles Endpoint (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: (user) => retype(user, "Profiles Endpoint", "https://p.example"),
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    profiles_endpoint: https://p.example\n",
    path: ["profiles_endpoint"],
    value: "https://p.example",
  },
  {
    name: "HTTP exporter Customize TLS turned on (its block)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "TLS");
      await user.click(box("Customize TLS for OTLP/HTTP"));
      expect(box(INSECURE_COPY.http.label)).not.toBeChecked();
    },
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: '    traces_endpoint: https://t.example/v1/traces\n    tls:\n      min_version: "1.2"\n      max_version: "1.3"\n',
    path: ["tls"],
    value: { min_version: "1.2", max_version: "1.3" },
  },
  {
    name: "HTTP exporter a header's value",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "HTTP Headers");
      await retypeInto(user, screen.getByDisplayValue("Bearer mine") as HTMLInputElement, "Bearer yours");
    },
    from: "      Authorization: Bearer mine # the person's own\n",
    to: "      Authorization: Bearer yours # the person's own\n",
    path: ["headers", "Authorization"],
    value: "Bearer yours",
  },
  {
    name: "HTTP exporter Read Buffer Size (0 can be entered)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "Buffer Sizes");
      await retype(user, "Read Buffer Size", "0");
    },
    from: "    read_buffer_size: 0750\n",
    to: "    read_buffer_size: 0\n",
    path: ["read_buffer_size"],
    value: 0,
  },
  {
    name: "HTTP exporter Write Buffer Size (added)",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "Buffer Sizes");
      await retype(user, "Write Buffer Size", "1048576");
    },
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    write_buffer_size: 1048576\n",
    path: ["write_buffer_size"],
    value: 1048576,
  },
  {
    name: "HTTP exporter Retry turned off",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "Retry on Failure");
      await user.click(box("Enable Retry on Failure"));
    },
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    retry_on_failure:\n      enabled: false\n",
    path: ["retry_on_failure"],
    value: { enabled: false },
  },
  {
    name: "HTTP exporter Sending Queue turned off",
    key: HTTP_EXPORTER,
    form: httpExporter,
    edit: async (user) => {
      await openSection(user, "Sending Queue");
      await user.click(box("Enable Sending Queue"));
    },
    from: "    traces_endpoint: https://t.example/v1/traces\n",
    to: "    traces_endpoint: https://t.example/v1/traces\n    sending_queue:\n      enabled: false\n",
    path: ["sending_queue"],
    value: { enabled: false },
  },
];

const CRLF = (lf: string) => lf.replace(/\n/g, "\r\n");

describe("every field of the three forms writes only its key (decision 2)", () => {
  it.each(CASES.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const before = crlf ? CRLF(OTLP) : OTLP;
      const from = crlf ? CRLF(c.from) : c.from;
      const to = crlf ? CRLF(c.to) : c.to;
      expect(before.split(from)).toHaveLength(2);
      const user = renderForm(c.key, c.form, before);

      await c.edit(user);

      expect(text()).toBe(before.replace(from, to));
      expect(entries()).toBe(1);
      expect(valueAt(text(), c.key, c.path)).toEqual(c.value);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("a merged key edited copies the merge first; the anchor and its owner don't change", async () => {
    const user = renderForm("exporters.otlp/merged", grpcExporter);
    // Merged values show as the text holds them; its own endpoint wins.
    expect(field("Endpoint")).toHaveValue("other:4317");
    expect(field("Timeout")).toHaveValue("10s");

    await retype(user, "Timeout", "20s");

    expect(valueAt(text(), "exporters.otlp/merged", [])).toEqual({
      endpoint: "other:4317",
      timeout: "20s",
      compression: "gzip",
      sending_queue: { num_consumers: 2 },
    });
    expect(text()).toContain(
      "  otlp/base: &base # shared settings\n    timeout: 10s # the base's\n    compression: gzip\n    sending_queue:\n      num_consumers: 2\n",
    );
    expect(entries()).toBe(1);
  });

  it("a receiver compression box unticked with others left removes only its item", async () => {
    const two = OTLP.replace("          - gzip # the usual\n", "          - gzip # the usual\n          - zstd # fast\n");
    const user = renderForm(RECEIVER, receiver, two);
    await openSection(user, "Performance");
    expect(box("gzip")).toBeChecked();
    expect(box("zstd")).toBeChecked();
    expect(box("lz4")).not.toBeChecked();

    await user.click(box("gzip"));

    expect(text()).toBe(two.replace("          - gzip # the usual\n", ""));
    expect(valueAt(text(), RECEIVER, ["protocols", "http", "compression_algorithms"])).toEqual(["zstd"]);
  });

  it("each edit is one undo entry named after the component", async () => {
    const user = renderForm(GRPC_EXPORTER, grpcExporter);
    await retype(user, "Endpoint", "x:4317");
    expect(selectUndoDescription(builderStore())).toBe("Update OTLP");
    expect(selectIsDirty(builderStore())).toBe(true);
  });
});

describe("the OTLP receiver shows the text (decisions 3, 4)", () => {
  it("a bare grpc: shows gRPC on, with its default endpoint as the placeholder; HTTP, missing, off", () => {
    renderForm("receivers.otlp/bare", receiver);
    expect(box("Enable gRPC Protocol")).toBeChecked();
    expect(box("Enable HTTP Protocol")).not.toBeChecked();
    expect(byId("grpc-endpoint")).toHaveValue("");
    expect(byId("grpc-endpoint")).toHaveAttribute("placeholder", "localhost:4317");
    expect(hint("Listen address. · Default localhost:4317")).toBeInTheDocument();
    expect(byId("http-endpoint")).toBeNull();
    expect(text()).toBe(OTLP);
  });

  it("an endpoint typed under a bare grpc: is written under it", async () => {
    const user = renderForm("receivers.otlp/bare", receiver);
    await retypeInto(user, byId("grpc-endpoint"), "0.0.0.0:4317");
    expect(text()).toBe(OTLP.replace("      grpc:\nexporters:", "      grpc:\n        endpoint: 0.0.0.0:4317\nexporters:"));
  });

  it("turning a bare grpc: off removes it; on again writes its default endpoint", async () => {
    const user = renderForm("receivers.otlp/bare", receiver);
    await user.click(box("Enable gRPC Protocol"));
    expect(valueAt(text(), "receivers.otlp/bare", ["protocols"])).toEqual({});
    await user.click(box("Enable gRPC Protocol"));
    expect(valueAt(text(), "receivers.otlp/bare", ["protocols"])).toEqual({ grpc: { endpoint: "localhost:4317" } });
  });

  it("with no protocol, each section says to enable one", async () => {
    const none =
      "receivers:\n  otlp:\n    protocols: {}\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    const user = renderForm(RECEIVER, receiver, none);
    for (const [section, what] of [
      ["Security", "security"],
      ["Performance", "performance"],
      ["Network", "network"],
    ] as const) {
      await openSection(user, section);
      expect(screen.getByText(`Enable at least one protocol to configure ${what} settings.`)).toBeInTheDocument();
    }
  });

  it("a protocol whose value can't hold settings shows on, read-only, with decision 3's hint", () => {
    const scalar = OTLP.replace("  otlp/bare:\n    protocols:\n      grpc:\n", "  otlp/bare:\n    protocols:\n      grpc: [a]\n");
    renderForm("receivers.otlp/bare", receiver, scalar);
    expect(box("Enable gRPC Protocol")).toBeChecked();
    expect(box("Enable gRPC Protocol")).toBeDisabled();
    expect(
      screen.getByText("This value is written in a form this field can't show. Edit it in the YAML below."),
    ).toBeInTheDocument();
  });

  const UNSHOWABLE = "This value is written in a form this field can't show. Edit it in the YAML below.";
  const NOTICE = /^Enable at least one protocol to configure/;

  it("grpc: [x] (neither a mapping nor null): ticked and read-only, and the sections show the hint, not 'Enable at least one protocol' (Ruling 74)", async () => {
    const list = OTLP.replace("  otlp/bare:\n    protocols:\n      grpc:\n", "  otlp/bare:\n    protocols:\n      grpc: [x]\n");
    const user = renderForm("receivers.otlp/bare", receiver, list);
    expect(box("Enable gRPC Protocol")).toBeChecked();
    expect(box("Enable gRPC Protocol")).toBeDisabled();
    expect(box("Enable HTTP Protocol")).not.toBeChecked();
    expect(box("Enable HTTP Protocol")).toBeEnabled();
    for (const section of ["Security", "Performance", "Network"]) {
      await openSection(user, section);
      expect(screen.queryByText(NOTICE)).toBeNull();
    }
    // The card's hint and one per section.
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(4);
    expect(text()).toBe(list);
  });

  it("protocols: foo (not a mapping): both boxes unticked and read-only with the hint, the sections too; nothing written (Ruling 74)", async () => {
    const scalar = OTLP.replace("  otlp/bare:\n    protocols:\n      grpc:\n", "  otlp/bare:\n    protocols: foo # a scalar\n");
    const user = renderForm("receivers.otlp/bare", receiver, scalar);
    for (const name of ["Enable gRPC Protocol", "Enable HTTP Protocol"]) {
      expect(box(name)).not.toBeChecked();
      expect(box(name)).toBeDisabled();
      await user.click(box(name));
    }
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(2);
    for (const section of ["Security", "Performance", "Network"]) {
      await openSection(user, section);
      expect(screen.queryByText(NOTICE)).toBeNull();
    }
    expect(screen.getAllByText(UNSHOWABLE)).toHaveLength(5);
    expect(text()).toBe(scalar);
    expect(entries()).toBe(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("values as the text writes them, and the collector's defaults as placeholders and hints (v0.162.0)", async () => {
    const user = renderForm(RECEIVER, receiver);
    await openSection(user, "Performance");
    expect(field("Max Receive Message Size")).toHaveValue("0750");
    expect(hint("In MiB. · Default 4")).toBeInTheDocument();
    const transport = screen.getByRole("combobox", { name: "Transport" });
    expect(transport).toHaveTextContent("TCP");
    expect(transport).toHaveAttribute("data-placeholder");
    expect(field("Max Request Body Size")).toHaveAttribute("placeholder", "20971520");
    expect(hint("In bytes. · Default 20971520 (20 MiB)")).toBeInTheDocument();
    expect(screen.getByText("Leave all unchecked to accept every encoding.")).toBeInTheDocument();

    await openSection(user, "Network");
    expect(field("Keepalive Time")).toHaveValue("1h");
    expect(field("Keepalive Timeout")).toHaveAttribute("placeholder", "20s");
    expect(hint("Close connections idle for this long. · Default 0s (no limit)")).toBeInTheDocument();
    expect(hint("Clients pinging more often are disconnected. · Default 5m")).toBeInTheDocument();
    expect(field("Traces URL Path")).toHaveValue("/traces");
    expect(field("Metrics URL Path")).toHaveAttribute("placeholder", "/v1/metrics");
    expect(hint("Default /v1/logs")).toBeInTheDocument();
    expect(text()).toBe(OTLP);
  });

  it("has no Profiles URL Path: the collector has no profiles_url_path at v0.162.0, and one in the text is left alone (Ruling 52)", async () => {
    const withProfiles = OTLP.replace(
      "        traces_url_path: /traces # custom\n",
      "        traces_url_path: /traces # custom\n        profiles_url_path: /p # unknown to the collector\n",
    );
    const user = renderForm(RECEIVER, receiver, withProfiles);
    await openSection(user, "Network");
    expect(screen.getByText("HTTP URL Paths")).toBeInTheDocument();
    expect(screen.queryByText("Profiles URL Path")).toBeNull();
    expect(byId("http-profiles-path")).toBeNull();
    await retype(user, "Logs URL Path", "/l");
    expect(text()).toBe(
      withProfiles.replace("        profiles_url_path: /p # unknown to the collector\n", "$&        logs_url_path: /l\n"),
    );
  });

  it("the receivers' TLS is the server section, per protocol", async () => {
    const user = renderForm(RECEIVER, receiver);
    await openSection(user, "Security");
    expect(box("Enable TLS for gRPC")).not.toBeChecked();
    expect(box("Enable TLS for HTTP")).not.toBeChecked();
    expect(screen.queryByText(CLIENT_TLS_HINT)).toBeNull();
    expect(box("Enable CORS (HTTP only)")).not.toBeChecked();
  });
});

describe("the exporters' TLS: the client variant and the insecure box's copy (decision 4)", () => {
  it("OTLP gRPC: \"Customize TLS for OTLP gRPC\", its hint, no Client CA fields, and the gRPC insecure copy", async () => {
    const user = renderForm(GRPC_EXPORTER, grpcExporter);
    await openSection(user, "Security");

    expect(box("Customize TLS for OTLP gRPC")).toBeChecked();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(CLIENT_TLS_HINT).toBe("Off: the collector uses TLS with the system's CAs, as the endpoint allows.");
    expect(screen.queryByRole("textbox", { name: "Client CA File" })).toBeNull();
    expect(screen.queryByText("Enable client CA file reload")).toBeNull();
    expect(screen.getByRole("textbox", { name: "CA File" })).toBeInTheDocument();

    const insecure = box("Disable TLS (plaintext, insecure)");
    expect(insecure).toBeChecked();
    const copy = hint(
      "Sends without TLS, unless the endpoint starts with https:// or a CA file is set. To keep TLS but skip certificate checks, leave this off and set insecure_skip_verify in the YAML.",
    );
    expect(within(copy).getByText("insecure_skip_verify").tagName).toBe("CODE");
    expect(screen.queryByText(/Skip TLS verification/)).toBeNull();
    expect(screen.queryByText(INSECURE_COPY.http.label)).toBeNull();
  });

  it("OTLP/HTTP: \"Customize TLS for OTLP/HTTP\", and the HTTP insecure copy once a tls block is there", async () => {
    const withTls = OTLP.replace("    read_buffer_size: 0750\n", "    read_buffer_size: 0750\n    tls:\n      ca_file: /ca.pem\n");
    const user = renderForm(HTTP_EXPORTER, httpExporter, withTls);
    await openSection(user, "TLS");

    expect(box("Customize TLS for OTLP/HTTP")).toBeChecked();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Client CA File" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "CA File" })).toHaveValue("/ca.pem");

    expect(box("Ignore these TLS settings (insecure)")).not.toBeChecked();
    const copy = hint(
      "Without a CA file, the settings here are ignored and the endpoint's scheme decides TLS: http:// sends plaintext, https:// uses TLS and verifies the server. To skip verification, leave this off and set insecure_skip_verify in the YAML.",
    );
    expect(within(copy).getByText("insecure_skip_verify").tagName).toBe("CODE");

    await user.click(box("Ignore these TLS settings (insecure)"));
    expect(text()).toBe(withTls.replace("      ca_file: /ca.pem\n", "      ca_file: /ca.pem\n      insecure: true\n"));
  });

  it("without a tls block, the section is off with its hint, and there's no insecure box", async () => {
    const user = renderForm(HTTP_EXPORTER, httpExporter);
    await openSection(user, "TLS");
    expect(box("Customize TLS for OTLP/HTTP")).not.toBeChecked();
    expect(screen.getByText(CLIENT_TLS_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: INSECURE_COPY.http.label })).toBeNull();
  });

  it("an insecure value that isn't a boolean leaves the box read-only with decision 3's hint", async () => {
    const odd = OTLP.replace("      insecure: true # plaintext\n", "      insecure: ${env:INSECURE}\n");
    const user = renderForm(GRPC_EXPORTER, grpcExporter, odd);
    await openSection(user, "Security");
    expect(box(INSECURE_COPY.grpc.label)).toBeDisabled();
    expect(
      screen.getByText("This value is written in a form this field can't show. Edit it in the YAML below."),
    ).toBeInTheDocument();
  });
});

describe("the exporters show the text (decision 3)", () => {
  it("gRPC: a compression outside the options shows as an extra option, as written", async () => {
    const user = renderForm(GRPC_EXPORTER, grpcExporter);
    const compression = screen.getByRole("combobox", { name: "Compression" });
    expect(compression).toHaveTextContent("zstd");
    await user.click(compression);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["gzip", "none", "zstd"]);
  });

  it("gRPC: unset keys show empty, with the collector's defaults (5s, gzip) as placeholder and hint", () => {
    const empty =
      "exporters:\n  otlp:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp]\n";
    renderForm(GRPC_EXPORTER, grpcExporter, empty);
    expect(field("Timeout")).toHaveValue("");
    expect(field("Timeout")).toHaveAttribute("placeholder", "5s");
    expect(hint("Max wait per delivery attempt. · Default 5s")).toBeInTheDocument();
    const compression = screen.getByRole("combobox", { name: "Compression" });
    expect(compression).toHaveTextContent("gzip");
    expect(compression).toHaveAttribute("data-placeholder");
    expect(field("Endpoint")).toHaveAttribute("placeholder", "e.g. otelcol:4317");
    expect(screen.getByText("Endpoint").querySelector("span")).toHaveTextContent("*");
  });

  it("OTLP/HTTP: the collector's defaults (30s, proto, gzip, 0, 512 KiB) as placeholders and hints", async () => {
    const empty =
      "exporters:\n  otlphttp:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlphttp]\n";
    const user = renderForm(HTTP_EXPORTER, httpExporter, empty);
    expect(field("Timeout")).toHaveAttribute("placeholder", "30s");
    expect(hint("Per-request HTTP timeout. · Default 30s")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Encoding" })).toHaveTextContent("Protocol Buffers (proto)");
    expect(screen.getByRole("combobox", { name: "Compression" })).toHaveTextContent("gzip");
    // No override is set: the section is closed and carries no count.
    expect(screen.getByRole("button", { name: "Signal Endpoint Overrides" })).toHaveAttribute("aria-expanded", "false");
    await openSection(user, "Buffer Sizes");
    expect(field("Read Buffer Size")).toHaveAttribute("placeholder", "0");
    expect(hint("HTTP client read buffer, in bytes. · Default 0")).toBeInTheDocument();
    expect(hint("HTTP client write buffer, in bytes. · Default 524288 (512 KiB)")).toBeInTheDocument();
  });

  it("OTLP/HTTP: the overrides and headers sections count what is set; 0750 shows as written", async () => {
    const user = renderForm(HTTP_EXPORTER, httpExporter);
    expect(screen.getByRole("button", { name: "Signal Endpoint Overrides 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "HTTP Headers 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Profiling support is still in development.")).toBeInTheDocument();
    await openSection(user, "Buffer Sizes");
    expect(field("Read Buffer Size")).toHaveValue("0750");
  });
});

describe("the OTLP/HTTP quick setups, in the text (decision 4)", () => {
  const grafana = QUICK_SETUP_PRESETS.find((p) => p.id === "grafana")!;
  const dynatrace = QUICK_SETUP_PRESETS.find((p) => p.id === "dynatrace")!;
  const datadog = QUICK_SETUP_PRESETS.find((p) => p.id === "datadog")!;

  /** An OTLP/HTTP exporter written as the case needs, commented, in a pipeline. */
  const exporterText = (lines: string[]) =>
    [
      "exporters:",
      "  otlphttp: # vendor",
      "    encoding: json # kept",
      ...lines,
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [otlphttp]",
      "",
    ].join("\n");

  interface QuickCase {
    name: string;
    before: string[];
    option: string;
    after: string[];
  }

  const QUICK: QuickCase[] = [
    {
      name: "Grafana Cloud on a fresh exporter: its endpoint and its Authorization placeholder",
      before: [],
      option: "Grafana Cloud",
      after: [`    endpoint: ${grafana.endpoint}`, "    headers:", `      Authorization: Basic <YOUR_BASE64_CREDENTIALS>`],
    },
    {
      name: "Grafana Cloud keeps the person's own headers, their Authorization included",
      before: ["    endpoint: https://mine.example # mine", "    headers:", "      Authorization: Bearer mine # own", "      X-Custom: abc"],
      option: "Grafana Cloud",
      after: [`    endpoint: ${grafana.endpoint} # mine`, "    headers:", "      Authorization: Bearer mine # own", "      X-Custom: abc"],
    },
    {
      name: "Dynatrace after Grafana replaces Grafana's placeholder in place",
      before: [`    endpoint: ${grafana.endpoint}`, "    headers:", "      Authorization: Basic <YOUR_BASE64_CREDENTIALS> # placed", "      X-Custom: abc"],
      option: "Dynatrace",
      after: [`    endpoint: ${dynatrace.endpoint}`, "    headers:", "      Authorization: Api-Token <YOUR_DYNATRACE_TOKEN> # placed", "      X-Custom: abc"],
    },
    {
      name: "Datadog after Grafana removes Grafana's placeholder and adds its own, keeping the person's",
      before: [`    endpoint: ${grafana.endpoint}`, "    headers:", "      Authorization: Basic <YOUR_BASE64_CREDENTIALS>", "      X-Custom: abc"],
      option: "Datadog",
      after: [`    endpoint: ${datadog.endpoint}`, "    headers:", "      X-Custom: abc", "      dd-api-key: <YOUR_DATADOG_API_KEY>"],
    },
    {
      name: "Custom clears Grafana's pre-fill: its endpoint and its placeholder, the headers mapping with its last header",
      before: [`    endpoint: ${grafana.endpoint} # pre-filled`, "    headers:", "      Authorization: Basic <YOUR_BASE64_CREDENTIALS>"],
      option: "Custom (clear pre-fill)",
      after: [],
    },
    {
      name: "Custom keeps the person's own Authorization (never stripped)",
      before: [`    endpoint: ${grafana.endpoint}`, "    headers:", "      Authorization: Bearer mine # own", "      X-Custom: abc"],
      option: "Custom (clear pre-fill)",
      after: ["    headers:", "      Authorization: Bearer mine # own", "      X-Custom: abc"],
    },
    {
      name: "Custom removes a Datadog placeholder and keeps the person's own dd-api-key-like header",
      before: [
        `    endpoint: ${datadog.endpoint}`,
        "    headers:",
        "      dd-api-key: <YOUR_DATADOG_API_KEY>",
        "      Authorization: Bearer mine",
      ],
      option: "Custom (clear pre-fill)",
      after: ["    headers:", "      Authorization: Bearer mine"],
    },
    {
      name: "Custom leaves the person's own endpoint (it isn't a preset's)",
      before: ["    endpoint: https://mine.example", "    headers:", "      Authorization: Basic <YOUR_BASE64_CREDENTIALS>", "      X-Custom: abc"],
      option: "Custom (clear pre-fill)",
      after: ["    endpoint: https://mine.example", "    headers:", "      X-Custom: abc"],
    },
  ];

  it.each(QUICK.flatMap((c) => [[`${c.name}, LF`, c, false] as const, [`${c.name}, CRLF`, c, true] as const]))(
    "%s",
    async (_name, c, crlf) => {
      const convert = (t: string) => (crlf ? CRLF(t) : t);
      const before = convert(exporterText(c.before));
      const user = renderForm(HTTP_EXPORTER, httpExporter, before);

      await pick(user, "Quick Setup", c.option);

      expect(text()).toBe(convert(exporterText(c.after)));
      expect(entries()).toBe(1);
      expect(parse(text()).ok).toBe(true);
      act(() => void builderStore().undo());
      expect(text()).toBe(before);
    },
  );

  it("the trigger follows the endpoint: a preset's shows its name, and Custom returns it to the placeholder", async () => {
    const before = exporterText(["    endpoint: https://mine.example"]);
    const user = renderForm(HTTP_EXPORTER, httpExporter, before);
    const trigger = () => screen.getByRole("combobox", { name: "Quick Setup" });
    expect(trigger()).toHaveTextContent("Choose a backend…");

    await pick(user, "Quick Setup", "Datadog");
    expect(trigger()).toHaveTextContent("Datadog");
    expect(field("Endpoint")).toHaveValue(datadog.endpoint);

    await pick(user, "Quick Setup", "Custom (clear pre-fill)");
    expect(trigger()).toHaveTextContent("Choose a backend…");
    expect(field("Endpoint")).toHaveValue("");
  });

  it("the options show each preset's mark beside its name, hidden from assistive technology", async () => {
    const user = renderForm(HTTP_EXPORTER, httpExporter, exporterText([]));
    await user.click(screen.getByRole("combobox", { name: "Quick Setup" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Custom (clear pre-fill)",
      "Grafana Cloud",
      "Dynatrace",
      "Datadog",
    ]);
    const marks = screen.getAllByRole("option").map((o) => o.querySelector("svg"));
    expect(marks[0]).toBeNull();
    for (const mark of marks.slice(1)) expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(marks[1]).toHaveAttribute("fill", "#F46800");
    expect(marks[3]!.getAttribute("class")).toContain("text-[#632CA6]");
  });
});

/** A text holding `type`'s palette default under `key`. */
function paletteText(type: ComponentType, subType: string): string {
  const config = paletteDefaultConfig(findPaletteEntry(type, subType)!);
  const section = `${type}s`;
  return stringify({
    [section]: { [subType]: config },
    ...(type === "exporter" ? {} : { exporters: { debug: {} } }),
    service: {
      pipelines: {
        traces:
          type === "exporter" ? { receivers: ["otlp"], exporters: [subType] } : { receivers: [subType], exporters: ["debug"] },
      },
    },
  });
}

describe("OTLPReceiverForm cases", () => {
  const defaults = () => paletteText("receiver", "otlp");

  it("renders gRPC endpoint from default config", () => {
    renderForm(RECEIVER, receiver, defaults());
    expect(byId("grpc-endpoint")).toBeInTheDocument();
    expect(byId("grpc-endpoint")).toHaveValue("localhost:4317");
  });

  it("renders HTTP endpoint from default config", () => {
    renderForm(RECEIVER, receiver, defaults());
    expect(byId("http-endpoint")).toBeInTheDocument();
    expect(byId("http-endpoint")).toHaveValue("localhost:4318");
  });

  it("renders protocol checkboxes as checked when protocols are enabled", () => {
    renderForm(RECEIVER, receiver, defaults());
    expect(screen.getByText("Enable gRPC Protocol")).toBeInTheDocument();
    expect(screen.getByText("Enable HTTP Protocol")).toBeInTheDocument();
    expect(byId("grpc-enable")).toHaveAttribute("data-state", "checked");
    expect(byId("http-enable")).toHaveAttribute("data-state", "checked");
  });

  it("renders collapsible section headers instead of tabs", () => {
    renderForm(RECEIVER, receiver, defaults());
    expect(screen.getByRole("button", { name: "Security" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Performance" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Network" })).toHaveAttribute("aria-expanded", "false");
  });

  it("renders custom endpoint values", () => {
    const custom = defaults().replace("localhost:4317", "0.0.0.0:14317").replace("localhost:4318", "0.0.0.0:14318");
    renderForm(RECEIVER, receiver, custom);
    expect(byId("grpc-endpoint")).toHaveValue("0.0.0.0:14317");
    expect(byId("http-endpoint")).toHaveValue("0.0.0.0:14318");
  });

  it("hides endpoint fields when protocol is disabled", () => {
    const grpcOnly =
      "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: localhost:4317\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    renderForm(RECEIVER, receiver, grpcOnly);
    expect(byId("grpc-endpoint")).toBeInTheDocument();
    expect(byId("http-endpoint")).toBeNull();
  });

  it("generates valid YAML: a field's edit changes only its line, and the text parses to the value", async () => {
    const before = defaults();
    const user = renderForm(RECEIVER, receiver, before);

    await retypeInto(user, byId("grpc-endpoint"), "0.0.0.0:4317");

    expect(text()).toBe(before.replace("endpoint: localhost:4317\n", "endpoint: 0.0.0.0:4317\n"));
    expect(parse(text()).ok).toBe(true);
    expect(valueAt(text(), RECEIVER, [])).toEqual({
      protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "localhost:4318" } },
    });
  });

  it("survives a round trip: the written text, read again, shows the same values", async () => {
    const user = renderForm(RECEIVER, receiver, defaults());
    await retypeInto(user, byId("http-endpoint"), "0.0.0.0:4318");
    const written = text();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(RECEIVER, receiver, written);

    expect(byId("grpc-endpoint")).toHaveValue("localhost:4317");
    expect(byId("http-endpoint")).toHaveValue("0.0.0.0:4318");
    expect(text()).toBe(written);
  });

});

describe("OTLPExporterForm cases", () => {
  const exporterDefaults = () => paletteText("exporter", "otlp");
  const input = (value: string) => [...document.querySelectorAll("input")].find((i) => i.value === value);

  it("renders endpoint value from config", () => {
    renderForm(GRPC_EXPORTER, grpcExporter, exporterDefaults());
    expect(input("otelcol:4317")).toBeInTheDocument();
  });

  it("renders timeout value from config; unset, the default is the placeholder (decision 3)", () => {
    renderForm(GRPC_EXPORTER, grpcExporter, exporterDefaults());
    expect(input("5s")).toBeInTheDocument();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(GRPC_EXPORTER, grpcExporter, exporterDefaults().replace("    timeout: 5s\n", ""));
    expect(field("Timeout")).toHaveValue("");
    expect(field("Timeout")).toHaveAttribute("placeholder", "5s");
  });

  it("renders collapsible section headers", () => {
    renderForm(GRPC_EXPORTER, grpcExporter, exporterDefaults());
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry & Queue" })).toBeInTheDocument();
  });

  it("renders custom endpoint values", () => {
    const custom =
      "exporters:\n  otlp:\n    endpoint: https://collector.example.com:443\n    timeout: 10s\n    compression: none\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp]\n";
    renderForm(GRPC_EXPORTER, grpcExporter, custom);
    expect(input("https://collector.example.com:443")).toBeInTheDocument();
    expect(input("10s")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Compression" })).toHaveTextContent("none");
  });

  it("generates valid YAML: a field's edit changes only its line, and the text parses", async () => {
    const before = exporterDefaults();
    const user = renderForm(GRPC_EXPORTER, grpcExporter, before);
    await retype(user, "Endpoint", "collector:4317");
    expect(text()).toBe(before.replace("endpoint: otelcol:4317\n", "endpoint: collector:4317\n"));
    expect(parse(text()).ok).toBe(true);
    expect(text()).toContain("exporters:");
    expect(valueAt(text(), GRPC_EXPORTER, ["endpoint"])).toBe("collector:4317");
  });

  it("survives a round trip with exporter config preserved", async () => {
    const user = renderForm(GRPC_EXPORTER, grpcExporter, exporterDefaults());
    await retype(user, "Timeout", "7s");
    const written = text();

    cleanup();
    useEditorStore.setState(initialState, true);
    renderForm(GRPC_EXPORTER, grpcExporter, written);

    expect(input("otelcol:4317")).toBeInTheDocument();
    expect(field("Timeout")).toHaveValue("7s");
    expect(text()).toBe(written);
  });
});

describe("OTLPHTTPExporterForm cases", () => {
  const grafana = QUICK_SETUP_PRESETS.find((p) => p.id === "grafana")!;
  const datadog = QUICK_SETUP_PRESETS.find((p) => p.id === "datadog")!;

  describe("getQuickSetupChanges", () => {
    it("pre-fills endpoint and auth header for a preset", () => {
      expect(getQuickSetupChanges({}, "grafana")).toEqual([
        { path: ["endpoint"], value: grafana.endpoint },
        { path: ["headers", "Authorization"], value: grafana.headers.Authorization },
      ]);
    });

    it("preserves the user's own headers when applying a preset", () => {
      const changes = getQuickSetupChanges({ headers: { "X-Custom": "abc" } }, "grafana");
      expect(changes).toEqual([
        { path: ["endpoint"], value: grafana.endpoint },
        { path: ["headers", "Authorization"], value: grafana.headers.Authorization },
      ]);
      expect(changes!.some((change) => change.path.includes("X-Custom"))).toBe(false);
    });

    it("replaces a previous preset's managed header instead of stacking", () => {
      const changes = getQuickSetupChanges(
        { endpoint: grafana.endpoint, headers: { ...grafana.headers, "X-Custom": "abc" } },
        "datadog",
      );
      expect(changes).toEqual([
        { path: ["endpoint"], value: datadog.endpoint },
        { path: ["headers", "dd-api-key"], value: datadog.headers["dd-api-key"] },
        { path: ["headers", "Authorization"], remove: true },
      ]);
    });

    it("clears the pre-filled endpoint and managed header for custom", () => {
      expect(getQuickSetupChanges({ endpoint: grafana.endpoint, headers: { ...grafana.headers } }, QUICK_SETUP_CUSTOM)).toEqual([
        { path: ["endpoint"], remove: true },
        { path: ["headers"], remove: true },
      ]);
    });

    it("keeps the user's own headers when clearing to custom, their own Authorization included (changed, decision 4)", () => {
      expect(
        getQuickSetupChanges(
          { endpoint: grafana.endpoint, headers: { ...grafana.headers, "X-Custom": "abc" } },
          QUICK_SETUP_CUSTOM,
        ),
      ).toEqual([
        { path: ["endpoint"], remove: true },
        { path: ["headers", "Authorization"], remove: true },
      ]);
      // A person's own Authorization isn't a preset's: Custom leaves it.
      expect(
        getQuickSetupChanges(
          { endpoint: grafana.endpoint, headers: { Authorization: "Bearer mine", "X-Custom": "abc" } },
          QUICK_SETUP_CUSTOM,
        ),
      ).toEqual([{ path: ["endpoint"], remove: true }]);
      expect(isPresetHeader("Authorization", "Bearer mine")).toBe(false);
      expect(isPresetHeader("authorization", "Basic <YOUR_BASE64_CREDENTIALS>")).toBe(true);
    });

    it("returns null for an unknown id", () => {
      expect(getQuickSetupChanges({}, "nope")).toBeNull();
    });
  });

  describe("getActiveQuickSetupId", () => {
    it("derives the preset from a matching endpoint", () => {
      expect(getActiveQuickSetupId(grafana.endpoint)).toBe("grafana");
      expect(getActiveQuickSetupId(datadog.endpoint)).toBe("datadog");
    });

    it("returns empty for a fresh (no endpoint) config", () => {
      expect(getActiveQuickSetupId(undefined)).toBe("");
      expect(getActiveQuickSetupId("")).toBe("");
    });

    it("returns empty for a custom, non-preset endpoint", () => {
      expect(getActiveQuickSetupId("https://my-own.example.com")).toBe("");
    });

    it("is purely a function of config, so unlinked components stay independent", () => {
      expect(getActiveQuickSetupId(grafana.endpoint)).not.toBe(getActiveQuickSetupId(datadog.endpoint));
      // Linked instances share the same config → same selection.
      expect(getActiveQuickSetupId(grafana.endpoint)).toBe(getActiveQuickSetupId(`${grafana.endpoint}`));
    });
  });

  describe("OTLPHTTPExporterForm Quick Setup rendering", () => {
    const withEndpoint = (endpoint: string | null) =>
      `exporters:\n  otlphttp:${endpoint === null ? "" : `\n    endpoint: ${endpoint}`}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlphttp]\n`;
    const trigger = () => screen.getByRole("combobox", { name: "Quick Setup" });

    it("shows the preset matching the config's endpoint", () => {
      renderForm(HTTP_EXPORTER, httpExporter, withEndpoint(grafana.endpoint));
      expect(trigger().textContent).toContain("Grafana Cloud");
    });

    it("shows the placeholder for a fresh config", () => {
      renderForm(HTTP_EXPORTER, httpExporter, withEndpoint(null));
      expect(trigger().textContent).toContain("Choose a backend");
    });

    it("reflects each config independently (no cross-component leak)", () => {
      renderForm(HTTP_EXPORTER, httpExporter, withEndpoint(datadog.endpoint));
      expect(trigger().textContent).toContain("Datadog");

      cleanup();
      useEditorStore.setState(initialState, true);
      renderForm(HTTP_EXPORTER, httpExporter, withEndpoint(null));
      expect(trigger().textContent).toContain("Choose a backend");
      expect(trigger().textContent).not.toContain("Datadog");
    });
  });
});

describe("privacy (decision 10)", () => {
  it("puts no config value or header name in any attribute of the three forms, their sections and menus opened", async () => {
    const MARK = "zq-mark";
    const marked = [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc:",
      `        endpoint: ${MARK}-grpc`,
      `        transport: ${MARK}-transport`,
      `        max_recv_msg_size_mib: ${MARK}-mib`,
      "        keepalive:",
      "          server_parameters:",
      `            time: ${MARK}-time`,
      "        tls:",
      `          cert_file: ${MARK}-cert`,
      "      http:",
      `        endpoint: ${MARK}-http`,
      `        compression_algorithms: [${MARK}-algo]`,
      `        traces_url_path: ${MARK}-path`,
      "        cors:",
      `          allowed_origins: [${MARK}-origin]`,
      "exporters:",
      "  otlp:",
      `    endpoint: ${MARK}-exporter`,
      `    compression: ${MARK}-compression`,
      "    tls:",
      `      ca_file: ${MARK}-ca`,
      "    headers:",
      `      ${MARK}-name: ${MARK}-header`,
      "    retry_on_failure:",
      `      max_interval: ${MARK}-retry`,
      "  otlphttp:",
      `    endpoint: ${MARK}-http-exporter`,
      `    encoding: ${MARK}-encoding`,
      `    traces_endpoint: ${MARK}-traces`,
      "    headers:",
      `      ${MARK}-auth: ${MARK}-token`,
      "    sending_queue:",
      `      queue_size: ${MARK}-queue`,
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [otlp, otlphttp]",
      "",
    ].join("\n");
    const forms: [string, ReactNode, string[]][] = [
      [RECEIVER, <OTLPReceiverForm key="receiver" />, ["Transport"]],
      [GRPC_EXPORTER, <OTLPExporterForm key="grpc" />, ["Compression"]],
      [HTTP_EXPORTER, <OTLPHTTPExporterForm key="http" />, ["Encoding", "Quick Setup"]],
    ];
    const leaks: string[] = [];
    for (const [key, form, selects] of forms) {
      cleanup();
      useEditorStore.setState(initialState, true);
      const user = renderForm(key, form, marked);
      for (const button of screen.queryAllByRole("button", { expanded: false })) {
        if (!button.hasAttribute("role")) await user.click(button);
      }
      const check = (where: string) => {
        for (const element of document.querySelectorAll("*")) {
          // A controlled field's value property is its content, not an attribute: the replay masks inputs.
          for (const attribute of element.attributes) {
            if (attribute.name !== "value" && attribute.value.includes(MARK)) {
              leaks.push(`${key} (${where}): ${element.tagName}[${attribute.name}]`);
            }
          }
        }
      };
      expect(
        document.body.textContent +
          [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join(),
      ).toContain(MARK);
      check("sections open");
      for (const name of selects) {
        await user.click(screen.getByRole("combobox", { name }));
        check(`${name} open`);
        await user.keyboard("{Escape}");
      }
    }
    expect(leaks).toEqual([]);
    expect(text()).toBe(marked);
  });
});
