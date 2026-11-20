import type { ComponentType } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { DurationField, NumberField, SelectField, TextField, useForm } from "./form-context.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { TLSInsecureCheckbox } from "./shared/TLSInsecureCheckbox.js";
import { DatadogIcon } from "../icons/DatadogIcon.js";
import { DynatraceIcon } from "../icons/DynatraceIcon.js";
import { GrafanaIcon } from "../icons/GrafanaIcon.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The OTLP/HTTP exporter's form, over the form's fields: each field writes its
 * own key.
 *
 * The collector's defaults (otlphttp exporter `createDefaultConfig`, core
 * v0.162.0: timeout 30s, encoding proto, compression gzip, read buffer 0,
 * write buffer 512 KiB) show while a key is unset, not written as values.
 * A compression or encoding outside the options shows as an extra option,
 * as written.
 *
 * The TLS section is the client variant ("Customize TLS for OTLP/HTTP", no
 * Client CA fields), and the `insecure` box says what it does on HTTP.
 *
 * The quick setups (presets, endpoints, placeholder credentials and marks)
 * are written by key: one change list, one undo entry. The rule, so a
 * person's own config isn't lost: **a quick setup only removes or replaces
 * what a preset put there.** A header is a preset's while its name is one
 * a preset sets (in any case) and its value is still that preset's
 * placeholder (`Basic <YOUR_BASE64_CREDENTIALS>`,
 * `Api-Token <YOUR_DYNATRACE_TOKEN>`, `<YOUR_DATADOG_API_KEY>`); any other
 * value is the person's own and is never removed or overwritten.
 * - "Custom (clear pre-fill)" removes the endpoint while it is still a
 *   preset's, and every header that is still a preset's; the person's own
 *   headers, their own `Authorization` included, stay.
 * - A preset sets its endpoint and its headers, replacing a header another
 *   preset put there (in place), removing the other presets' remaining
 *   ones, and leaving a header of the same name the person wrote
 *   themselves as it is.
 * The last header removed takes the `headers` mapping with it.
 *
 * The selection is derived from the endpoint as the text holds it: a preset
 * while the endpoint is exactly its endpoint. The options' values are the
 * presets' fixed ids.
 */

export interface QuickSetupPreset {
  id: string;
  label: string;
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  Icon: ComponentType<{ className?: string }>;
  /** Extra classes for the icon (e.g. brand color for currentColor icons). */
  iconClassName?: string;
}

/**
 * Known OTLP/HTTP backends. Picking one in the Quick Setup dropdown pre-fills
 * the endpoint and an Authorization header (with a placeholder credential the
 * user replaces under HTTP Headers).
 */
export const QUICK_SETUP_PRESETS: readonly QuickSetupPreset[] = [
  {
    id: "grafana",
    label: "Grafana Cloud",
    endpoint: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp",
    headers: { Authorization: "Basic <YOUR_BASE64_CREDENTIALS>" },
    Icon: GrafanaIcon,
  },
  {
    id: "dynatrace",
    label: "Dynatrace",
    endpoint: "https://<YOUR_ENVIRONMENT_ID>.live.dynatrace.com/api/v2/otlp",
    headers: { Authorization: "Api-Token <YOUR_DYNATRACE_TOKEN>" },
    Icon: DynatraceIcon,
  },
  {
    // Datadog's direct OTLP/HTTP intake. The host is per-site: otlp.<site>,
    // e.g. otlp.datadoghq.com (US1), otlp.us3.datadoghq.com, otlp.datadoghq.eu.
    // See docs.datadoghq.com/opentelemetry/setup/otlp_ingest.
    id: "datadog",
    label: "Datadog",
    endpoint: "https://otlp.<YOUR_DATADOG_SITE>",
    headers: { "dd-api-key": "<YOUR_DATADOG_API_KEY>" },
    Icon: DatadogIcon,
    iconClassName: "text-[#632CA6]",
  },
];

/**
 * Sentinel option that returns the Quick Setup dropdown to a no-preset state.
 * Radix Select offers no clear affordance and won't re-fire on the already
 * selected item, so this explicit "Custom" entry is how a user backs out of a
 * preset (and clears the values it pre-filled).
 */
export const QUICK_SETUP_CUSTOM = "custom";

/** What a quick setup reads: the endpoint and the headers as the text holds them. */
export interface QuickSetupState {
  endpoint?: unknown;
  headers?: Readonly<Record<string, unknown>>;
}

/** Whether a header is still what a preset put there: a preset's name (any case) with that preset's placeholder. */
export function isPresetHeader(name: string, value: unknown): boolean {
  return QUICK_SETUP_PRESETS.some((preset) =>
    Object.entries(preset.headers).some(
      ([presetName, placeholder]) => presetName.toLowerCase() === name.toLowerCase() && value === placeholder,
    ),
  );
}

function isPresetEndpoint(endpoint: unknown): boolean {
  return QUICK_SETUP_PRESETS.some((preset) => preset.endpoint === endpoint);
}

/**
 * The changes a Quick Setup choice makes, under the rule above, or null for
 * an unknown id. An empty list when there is nothing to change.
 */
export function getQuickSetupChanges(state: QuickSetupState, id: string): ValueChange[] | null {
  const preset = id === QUICK_SETUP_CUSTOM ? undefined : QUICK_SETUP_PRESETS.find((p) => p.id === id);
  if (id !== QUICK_SETUP_CUSTOM && preset === undefined) return null;

  const headers = state.headers ?? {};
  const names = Object.keys(headers);
  const changes: ValueChange[] = [];
  const kept = new Set(names);

  if (preset) {
    if (state.endpoint !== preset.endpoint) changes.push({ path: ["endpoint"], value: preset.endpoint });
  } else if (state.endpoint !== undefined && isPresetEndpoint(state.endpoint)) {
    changes.push({ path: ["endpoint"], remove: true });
  }

  /** Headers the chosen preset fills: a placeholder already there is replaced in place; the person's own is left. */
  const filled = new Set<string>();
  for (const [presetName, placeholder] of Object.entries(preset?.headers ?? {})) {
    const same = names.filter((name) => name.toLowerCase() === presetName.toLowerCase());
    const own = same.find((name) => !isPresetHeader(name, headers[name]));
    const placed = same.find((name) => isPresetHeader(name, headers[name]));
    if (own !== undefined) {
      filled.add(own);
    } else if (placed !== undefined) {
      filled.add(placed);
      if (headers[placed] !== placeholder) changes.push({ path: ["headers", placed], value: placeholder });
    } else {
      kept.add(presetName);
      changes.push({ path: ["headers", presetName], value: placeholder });
    }
  }

  const removed = names.filter((name) => !filled.has(name) && isPresetHeader(name, headers[name]));
  for (const name of removed) kept.delete(name);
  if (removed.length > 0 && kept.size === 0) {
    changes.push({ path: ["headers"], remove: true });
  } else {
    for (const name of removed) changes.push({ path: ["headers", name], remove: true });
  }
  return changes;
}

/**
 * The Quick Setup selection reflected by a config, derived purely from
 * the endpoint (returns "" when no preset matches — a fresh or custom
 * endpoint). Deriving instead of holding local state keeps the dropdown
 * per-component: two unlinked exporters with different endpoints show
 * different selections, while linked instances — which share the same config —
 * stay in sync.
 */
export function getActiveQuickSetupId(endpoint: unknown): string {
  return QUICK_SETUP_PRESETS.find((p) => p.endpoint === endpoint)?.id ?? "";
}

const ENCODINGS = [
  { value: "proto", label: "Protocol Buffers (proto)" },
  { value: "json", label: "JSON" },
] as const;

const COMPRESSIONS = [
  { value: "gzip", label: "gzip" },
  { value: "none", label: "none" },
] as const;

/** Whether a key holds a value the form counts as set (present and not `""`). */
function isSet(view: ValueView): boolean {
  return view.kind !== "absent" && view.value !== "";
}

export function OTLPHTTPExporterForm() {
  const form = useForm();
  const endpoint = form.read(["endpoint"]);
  const headersView = form.read(["headers"]);
  const headers = headersView.kind === "map" ? headersView.value : undefined;
  const tls = form.read(["tls"]);

  // Derived from the text (not local state) so the selection is per-component
  // and stays correct when switching between unlinked OTLP/HTTP exporters.
  const quickSetup = getActiveQuickSetupId(endpoint.value);

  const applyQuickSetup = (id: string) => {
    const changes = getQuickSetupChanges(
      { endpoint: endpoint.value, ...(headers !== undefined ? { headers } : {}) },
      id,
    );
    if (changes === null || changes.length === 0) return;
    form.apply(changes);
  };

  const signalEndpointCount = ["traces_endpoint", "metrics_endpoint", "logs_endpoint", "profiles_endpoint"].filter(
    (key) => isSet(form.read([key])),
  ).length;

  return (
    <div className="space-y-4">
      {/* Quick Setup: pick a known backend to pre-fill endpoint + auth header */}
      <ConfigField
        label="Quick Setup"
        htmlFor="otlphttp-quick-setup"
        description="Pre-fills the endpoint and auth header; replace the placeholder credential under HTTP Headers."
      >
        <Select value={quickSetup} onValueChange={applyQuickSetup} disabled={form.disabled}>
          <SelectTrigger id="otlphttp-quick-setup">
            <SelectValue placeholder="Choose a backend…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={QUICK_SETUP_CUSTOM}>
              <span className="text-muted-foreground">Custom (clear pre-fill)</span>
            </SelectItem>
            {QUICK_SETUP_PRESETS.map((preset) => {
              const Icon = preset.Icon;
              return (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 shrink-0 ${preset.iconClassName ?? ""}`} />
                    {preset.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </ConfigField>

      <TextField
        path={["endpoint"]}
        id="otlphttp-endpoint"
        label="Endpoint"
        required
        description="Base HTTP(S) URL for all signals unless overridden."
        placeholder="e.g. https://api.example.com:4318"
      />

      <DurationField
        path={["timeout"]}
        id="otlphttp-timeout"
        label="Timeout"
        defaultValue="30s"
        description="Per-request HTTP timeout."
        placeholder="30s"
      />

      <SelectField
        path={["encoding"]}
        id="otlphttp-encoding"
        label="Encoding"
        placeholder="Protocol Buffers (proto)"
        options={ENCODINGS}
      />

      <SelectField
        path={["compression"]}
        id="otlphttp-compression"
        label="Compression"
        placeholder="gzip"
        options={COMPRESSIONS}
      />

      <ConfigSection
        title="Signal Endpoint Overrides"
        count={signalEndpointCount}
        defaultOpen={signalEndpointCount > 0}
      >
        <TextField
          path={["traces_endpoint"]}
          id="traces-endpoint"
          label="Traces Endpoint"
          placeholder="e.g. https://api.example.com/v1/traces"
        />

        <TextField
          path={["metrics_endpoint"]}
          id="metrics-endpoint"
          label="Metrics Endpoint"
          placeholder="e.g. https://api.example.com/v1/metrics"
        />

        <TextField
          path={["logs_endpoint"]}
          id="logs-endpoint"
          label="Logs Endpoint"
          placeholder="e.g. https://api.example.com/v1/logs"
        />

        <TextField
          path={["profiles_endpoint"]}
          id="profiles-endpoint"
          label="Profiles Endpoint"
          description="Profiling support is still in development."
          placeholder="e.g. https://api.example.com/v1/profiles"
        />
      </ConfigSection>

      <ConfigSection title="TLS">
        <TLSConfigSection path={["tls"]} protocolLabel="OTLP/HTTP" variant="client" />

        {tls.kind === "map" && <TLSInsecureCheckbox path={["tls", "insecure"]} protocol="http" />}
      </ConfigSection>

      <ConfigSection title="HTTP Headers" count={Object.keys(headers ?? {}).length}>
        <HeadersConfigSection path={["headers"]} title={null} description="Attached to every export request." />
      </ConfigSection>

      <ConfigSection title="Buffer Sizes">
        <NumberField
          path={["read_buffer_size"]}
          id="read-buffer-size"
          label="Read Buffer Size"
          defaultValue="0"
          description="HTTP client read buffer, in bytes."
          placeholder="0"
        />

        <NumberField
          path={["write_buffer_size"]}
          id="write-buffer-size"
          label="Write Buffer Size"
          defaultValue="524288 (512 KiB)"
          description="HTTP client write buffer, in bytes."
          placeholder="524288"
        />
      </ConfigSection>

      <ConfigSection title="Retry on Failure">
        <RetryConfigSection path={["retry_on_failure"]} />
      </ConfigSection>

      <ConfigSection title="Sending Queue">
        <SendingQueueSection path={["sending_queue"]} showBatchSettings={true} />
      </ConfigSection>
    </div>
  );
}
