import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, DurationField, FormScope, NumberField, SelectField, TextField, useForm, type FormSource } from "./form-context.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { ListTextField } from "./shared/ListTextField.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The Datadog exporter's form, over the form's fields: each field writes its
 * own key. Collector claims are contrib v0.162.0's `pkg/datadog/config` (the
 * exporter's config, `exporter/datadogexporter/factory.go:211-213`) and core
 * v0.162.0's `config/confighttp/client.go`.
 *
 * - No field writes a top-level `hostname_source`, which `Config` doesn't
 *   have (`config.go:75-118`; the collector refuses unknown keys),
 *   `logs.dump_payloads`, which `LogsConfig` doesn't have (`logs.go:9-26`),
 *   or `headers`, which the exporter refuses whatever the value
 *   (`config.go:184-209`). Any of them already in a text is left alone (the
 *   collector validator reports it).
 * - Idle Connection Timeout edits the key the text uses: the flat
 *   `idle_conn_timeout` (deprecated since v0.160.0, `client.go:106-107`) or
 *   `keepalive.idle_conn_timeout`; with neither, it writes
 *   `keepalive.idle_conn_timeout`, the current key (under the
 *   `PrioritizeNewKeepalive` gate, beta at v0.162.0, the default is a
 *   keepalive section, `client.go:163-168`). A text using the flat
 *   keep-alive keys (`max_idle_conns`, …) gets the flat key too: the
 *   collector refuses the two forms together (`client.go:249-251`).
 *   Clearing the last key of `keepalive` removes the block (the default is
 *   the same, `client.go:163-168`).
 * - Tags, Ignore Resources and Peer Tags are `ListTextField`s (comma):
 *   typing is held, so a typed comma stays until the next item; an item
 *   holding a comma (a regex's `\d{1,3}`) makes the field read-only with
 *   `UNSHOWABLE_VALUE_MESSAGE` (never split on retype).
 * - Unset shows the collector's defaults: Compute Stats by Span Kind, Peer
 *   Tags Aggregation and Instrumentation Scope Metadata as Tags ticked
 *   (`config.go:360, 382-383`); Trace Buffer "Default 0" (unbuffered,
 *   `traces.go:131-133`; not 10); Host Metadata's Hostname Source "Default
 *   config_or_system" (`config.go:398`), with the hint
 *   `FIRST_RESOURCE_HINT` (`config.go:298-300` logs it); Site "Default
 *   datadoghq.com" (`config.go:350`; a hint, not a value). Peer Tags
 *   Aggregation and Send Histogram Aggregation Metrics show the deprecated
 *   key's value while only it is in the text, as the collector applies it
 *   (`config_warnings.go:27-42`).
 * - Site adds `ap2.datadoghq.com` (Datadog's site list; the collector takes
 *   any string, `config.go:49-51`).
 * - Summary Mode writes `summaries.mode` only (the rest of `summaries`
 *   stays).
 * - The nine cascades, each one change with its toast: Only Metadata needs
 *   host metadata and the first_resource hostname source
 *   (`config.go:156-158`); nobuckets needs aggregation metrics
 *   (`metrics.go:97-102`); a deprecated key beside its new one is refused
 *   (`config_warnings.go:55-58`); the initial cumulative value only with
 *   to_delta (`config.go:324-331`).
 * - API Key is a plain text field.
 * - Retry and Queue: the shared sections (`RetryConfigSection`,
 *   `SendingQueueSection`), on by default (`config.go:346-347`).
 *
 * Ids are fixed; no value reaches an attribute.
 */

export const DATADOG_SITES = [
  "datadoghq.com",
  "datadoghq.eu",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "ddog-gov.com",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
] as const;

/** Under Host Metadata's Hostname Source (`config.go:298-300`). */
export const FIRST_RESOURCE_HINT = "first_resource is deprecated; the collector logs a warning.";

/** The cascades' toasts. */
export const DATADOG_TOASTS = {
  firstResource: "Hostname source set to first_resource: Only Metadata needs it.",
  hostMetadataOn: "Turned Send Host Metadata on: Only Metadata needs it.",
  onlyMetadataOffHost: "Unticked Only Metadata: it needs host metadata.",
  onlyMetadataOffSource: "Unticked Only Metadata: it needs the first_resource hostname source.",
  aggregationOn: "Turned on Send Histogram Aggregation Metrics: nobuckets sends no histogram metrics without it.",
  distributions: "Histogram mode set to distributions: nobuckets needs aggregation metrics.",
  countSum: "Removed send_count_sum_metrics: it can't be set beside send_aggregation_metrics.",
  peerService: "Removed peer_service_aggregation: it can't be set beside peer_tags_aggregation.",
  initialValue: "Removed initial_cumulative_monotonic_value: it only applies to to_delta.",
} as const;

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

const HOSTNAME_SOURCES = options(["first_resource", "config_or_system"]);
const HISTOGRAM_MODES = options(["distributions", "counters", "nobuckets"]);
const SUM_MODES = options(["to_delta", "raw_value"]);
const SUMMARY_MODES = options(["gauges", "noquantiles"]);

const ONLY_METADATA: ValuePath = ["only_metadata"];
const HOST_ENABLED: ValuePath = ["host_metadata", "enabled"];
const HOSTNAME_SOURCE: ValuePath = ["host_metadata", "hostname_source"];
const HISTOGRAM_MODE: ValuePath = ["metrics", "histograms", "mode"];
const AGGREGATIONS: ValuePath = ["metrics", "histograms", "send_aggregation_metrics"];
const COUNT_SUM: ValuePath = ["metrics", "histograms", "send_count_sum_metrics"];
const PEER_TAGS_AGGREGATION: ValuePath = ["traces", "peer_tags_aggregation"];
const PEER_SERVICE: ValuePath = ["traces", "peer_service_aggregation"];
const SUM_MODE: ValuePath = ["metrics", "sums", "cumulative_monotonic_mode"];
const INITIAL_VALUE: ValuePath = ["metrics", "sums", "initial_cumulative_monotonic_value"];

/** The client's flat keep-alive keys, deprecated since v0.160.0 (`client.go:106-113`). */
const FLAT_KEEPALIVE_KEYS = ["idle_conn_timeout", "max_idle_conns", "max_idle_conns_per_host", "disable_keep_alives"] as const;

const present = (form: FormSource, path: ValuePath) => form.read(path).kind !== "absent";
const isTrue = (form: FormSource, path: ValuePath) => form.read(path).value === true;

/** A box's value as the collector has it: the key, else the deprecated key it replaces, else the default. */
function effective(form: FormSource, path: ValuePath, deprecated: ValuePath, fallback: boolean): boolean {
  for (const at of [path, deprecated]) {
    const view = form.read(at);
    if (view.kind === "scalar" && typeof view.value === "boolean") return view.value;
  }
  return fallback;
}

/** What a box shows while its key is unset: the deprecated key's value while only it is written (`config_warnings.go:27-42`). */
function deprecatedOr(form: FormSource, deprecated: ValuePath, fallback: boolean): boolean {
  const view = form.read(deprecated);
  return view.kind === "scalar" && typeof view.value === "boolean" ? view.value : fallback;
}

export function DatadogExporterForm() {
  const form = useForm();
  const { note } = useAdjustments();

  /** Writes `changes` with the cascades' changes, toasting their messages once written. */
  const write = (changes: ValueChange[], messages: string[]) => {
    const result = form.apply(changes);
    if (messages.length > 0) note(messages, result);
  };

  // E1, E2: Only Metadata needs host metadata and the first_resource source (config.go:156-158).
  const toggleOnlyMetadata = (next: boolean) => {
    const changes: ValueChange[] = [{ path: ONLY_METADATA, value: next }];
    const messages: string[] = [];
    if (next) {
      if (form.read(HOSTNAME_SOURCE).value !== "first_resource") {
        changes.push({ path: HOSTNAME_SOURCE, value: "first_resource" });
        messages.push(DATADOG_TOASTS.firstResource);
      }
      if (form.read(HOST_ENABLED).value === false) {
        changes.push({ path: HOST_ENABLED, value: true });
        messages.push(DATADOG_TOASTS.hostMetadataOn);
      }
    }
    write(changes, messages);
  };

  // E3.
  const toggleHostMetadata = (next: boolean) => {
    const changes: ValueChange[] = [{ path: HOST_ENABLED, value: next }];
    const messages: string[] = [];
    if (!next && isTrue(form, ONLY_METADATA)) {
      changes.push({ path: ONLY_METADATA, value: false });
      messages.push(DATADOG_TOASTS.onlyMetadataOffHost);
    }
    write(changes, messages);
  };

  // E4.
  const chooseHostnameSource = (value: string) => {
    const changes: ValueChange[] = [{ path: HOSTNAME_SOURCE, value }];
    const messages: string[] = [];
    if (value !== "first_resource" && isTrue(form, ONLY_METADATA)) {
      changes.push({ path: ONLY_METADATA, value: false });
      messages.push(DATADOG_TOASTS.onlyMetadataOffSource);
    }
    write(changes, messages);
  };

  // E5 (and E7 with it): nobuckets needs aggregation metrics (metrics.go:97-102).
  const chooseHistogramMode = (value: string) => {
    const changes: ValueChange[] = [{ path: HISTOGRAM_MODE, value }];
    const messages: string[] = [];
    if (value === "nobuckets" && !effective(form, AGGREGATIONS, COUNT_SUM, false)) {
      changes.push({ path: AGGREGATIONS, value: true });
      messages.push(DATADOG_TOASTS.aggregationOn);
      if (present(form, COUNT_SUM)) {
        changes.push({ path: COUNT_SUM, remove: true });
        messages.push(DATADOG_TOASTS.countSum);
      }
    }
    write(changes, messages);
  };

  // E6, E7.
  const toggleAggregations = (next: boolean) => {
    const changes: ValueChange[] = [{ path: AGGREGATIONS, value: next }];
    const messages: string[] = [];
    if (!next && form.read(HISTOGRAM_MODE).value === "nobuckets") {
      changes.push({ path: HISTOGRAM_MODE, remove: true });
      messages.push(DATADOG_TOASTS.distributions);
    }
    if (present(form, COUNT_SUM)) {
      changes.push({ path: COUNT_SUM, remove: true });
      messages.push(DATADOG_TOASTS.countSum);
    }
    write(changes, messages);
  };

  // E8.
  const togglePeerTagsAggregation = (next: boolean) => {
    const changes: ValueChange[] = [{ path: PEER_TAGS_AGGREGATION, value: next }];
    const messages: string[] = [];
    if (present(form, PEER_SERVICE)) {
      changes.push({ path: PEER_SERVICE, remove: true });
      messages.push(DATADOG_TOASTS.peerService);
    }
    write(changes, messages);
  };

  // E9: the initial value only with to_delta (config.go:324-331).
  const chooseSumMode = (value: string) => {
    const changes: ValueChange[] = [{ path: SUM_MODE, value }];
    const messages: string[] = [];
    if (value !== "to_delta" && present(form, INITIAL_VALUE)) {
      changes.push({ path: INITIAL_VALUE, remove: true });
      messages.push(DATADOG_TOASTS.initialValue);
    }
    write(changes, messages);
  };

  return (
    <div className="space-y-4">
      <SelectField
        path={["api", "site"]}
        id="datadog-site"
        label="Site"
        description="Match this to your Datadog org's region."
        defaultValue="datadoghq.com"
        options={options(DATADOG_SITES)}
      />

      <TextField
        path={["api", "key"]}
        id="datadog-api-key"
        label="API Key"
        required
        description="Use a secret reference instead of hardcoding the key."
        placeholder="${env:DD_API_KEY}"
      />

      <CheckboxField
        path={["api", "fail_on_invalid_key"]}
        id="datadog-fail-on-invalid"
        label="Fail to Start on Invalid API Key"
        defaultChecked={false}
        labelClassName="text-sm"
      />

      <ConfigSection title="Host">
        <TextField
          path={["hostname"]}
          id="datadog-hostname"
          label="Hostname"
          defaultValue="auto-detected"
          description="Override the host reported to Datadog."
        />

        <DurationField
          path={["hostname_detection_timeout"]}
          id="datadog-hostname-detect-timeout"
          label="Hostname Detection Timeout"
          defaultValue="25s"
        />
      </ConfigSection>

      <ConfigSection title="Connection">
        <DurationField path={["timeout"]} id="datadog-timeout" label="Request Timeout" defaultValue="15s" />

        <IdleConnectionTimeout />

        <TextField
          path={["proxy_url"]}
          id="datadog-proxy"
          label="Proxy URL"
          description="HTTP(S) proxy for all outbound Datadog traffic."
          placeholder="e.g. http://proxy.internal:3128"
        />

        <CheckboxField
          path={ONLY_METADATA}
          id="datadog-only-metadata"
          label="Only Metadata"
          description="Send only host metadata (no traces, metrics, or logs)."
          defaultChecked={false}
          labelClassName="text-sm"
          onToggle={toggleOnlyMetadata}
        />

        <CheckboxField
          path={["tls", "insecure_skip_verify"]}
          id="datadog-insecure"
          label="Skip TLS Verification (insecure)"
          defaultChecked={false}
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Host Metadata">
        <CheckboxField
          path={HOST_ENABLED}
          id="datadog-hm-enabled"
          label="Send Host Metadata"
          defaultChecked={true}
          labelClassName="text-sm"
          onToggle={toggleHostMetadata}
        />

        <div className="space-y-1">
          <SelectField
            path={HOSTNAME_SOURCE}
            id="datadog-hm-source"
            label="Hostname Source"
            description="Where to pull hostname and host tags from."
            defaultValue="config_or_system"
            options={HOSTNAME_SOURCES}
            onSelect={chooseHostnameSource}
          />
          <p className="text-[11px] leading-4 text-muted-foreground">{FIRST_RESOURCE_HINT}</p>
        </div>

        <DurationField
          path={["host_metadata", "reporter_period"]}
          id="datadog-hm-period"
          label="Reporter Period"
          defaultValue="30m"
          description="How often host metadata is sent."
        />

        <ListTextField
          path={["host_metadata", "tags"]}
          id="datadog-hm-tags"
          separator=","
          emptyRemovesKey
          label="Tags"
          description="Comma-separated host tags."
          placeholder="e.g. env:prod,team:platform"
        />
      </ConfigSection>

      <ConfigSection title="Traces">
        <TextField
          path={["traces", "endpoint"]}
          id="datadog-traces-endpoint"
          label="Endpoint"
          description="Override the trace intake URL (rarely needed)."
          placeholder="e.g. https://trace.agent.datadoghq.com"
        />

        <ListTextField
          path={["traces", "ignore_resources"]}
          id="datadog-traces-ignore"
          separator=","
          emptyRemovesKey
          label="Ignore Resources"
          description="Regex patterns for resource names to drop, comma-separated."
          placeholder="e.g. (GET|POST) /healthz"
        />

        <ListTextField
          path={["traces", "peer_tags"]}
          id="datadog-peer-tags"
          separator=","
          emptyRemovesKey
          label="Peer Tags"
          description="Attribute keys to include as peer tags, comma-separated."
          placeholder="e.g. db.system,messaging.system"
        />

        <NumberField
          path={["traces", "trace_buffer"]}
          id="datadog-trace-buffer"
          label="Trace Buffer"
          defaultValue="0"
          description="In-memory buffer for trace payloads awaiting send."
        />

        <CheckboxField
          path={["traces", "span_name_as_resource_name"]}
          id="datadog-span-name-as-resource"
          label="Span Name as Resource Name"
          defaultChecked={false}
          labelClassName="text-sm"
        />

        <CheckboxField
          path={["traces", "compute_stats_by_span_kind"]}
          id="datadog-compute-stats"
          label="Compute Stats by Span Kind"
          defaultChecked={true}
          labelClassName="text-sm"
        />

        <CheckboxField
          path={PEER_TAGS_AGGREGATION}
          id="datadog-peer-tags-agg"
          label="Peer Tags Aggregation"
          defaultChecked={deprecatedOr(form, PEER_SERVICE, true)}
          labelClassName="text-sm"
          onToggle={togglePeerTagsAggregation}
        />
      </ConfigSection>

      <ConfigSection title="Metrics">
        <TextField
          path={["metrics", "endpoint"]}
          id="datadog-metrics-endpoint"
          label="Endpoint"
          description="Override the metric intake URL."
          placeholder="e.g. https://api.datadoghq.com"
        />

        <NumberField
          path={["metrics", "delta_ttl"]}
          id="datadog-delta-ttl"
          label="Delta TTL"
          defaultValue="3600"
          description="Seconds to remember cumulative series for delta conversion."
        />

        <SelectField
          path={HISTOGRAM_MODE}
          id="datadog-hist-mode"
          label="Histogram Mode"
          defaultValue="distributions"
          options={HISTOGRAM_MODES}
          onSelect={chooseHistogramMode}
        />

        <SelectField
          path={SUM_MODE}
          id="datadog-sums-mode"
          label="Cumulative Sum Mode"
          defaultValue="to_delta"
          options={SUM_MODES}
          onSelect={chooseSumMode}
        />

        <SelectField
          path={["metrics", "summaries", "mode"]}
          id="datadog-summary-mode"
          label="Summary Mode"
          defaultValue="gauges"
          options={SUMMARY_MODES}
        />

        <CheckboxField
          path={AGGREGATIONS}
          id="datadog-hist-agg"
          label="Send Histogram Aggregation Metrics"
          defaultChecked={deprecatedOr(form, COUNT_SUM, false)}
          labelClassName="text-sm"
          onToggle={toggleAggregations}
        />

        <CheckboxField
          path={["metrics", "resource_attributes_as_tags"]}
          id="datadog-res-attrs-tags"
          label="Resource Attributes as Tags"
          defaultChecked={false}
          labelClassName="text-sm"
        />

        <CheckboxField
          path={["metrics", "instrumentation_scope_metadata_as_tags"]}
          id="datadog-scope-tags"
          label="Instrumentation Scope Metadata as Tags"
          defaultChecked={true}
          labelClassName="text-sm"
        />
      </ConfigSection>

      <ConfigSection title="Logs">
        <TextField
          path={["logs", "endpoint"]}
          id="datadog-logs-endpoint"
          label="Endpoint"
          description="Override the log intake URL."
          placeholder="e.g. https://http-intake.logs.datadoghq.com"
        />

        <NumberField
          path={["logs", "batch_wait"]}
          id="datadog-batch-wait"
          label="Batch Wait"
          defaultValue="5"
          description="Seconds to wait before flushing a batch."
        />

        <NumberField
          path={["logs", "compression_level"]}
          id="datadog-compression-level"
          label="Compression Level"
          defaultValue="6"
          description="gzip level 0–9; applies only when compression is on."
        />

        <CheckboxField
          path={["logs", "use_compression"]}
          id="datadog-logs-compression"
          label="Use Compression"
          defaultChecked={true}
          labelClassName="text-sm"
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

/**
 * Idle Connection Timeout, at the key the text uses: the flat
 * `idle_conn_timeout` while the text uses the flat keep-alive keys and has no
 * `keepalive` section, else `keepalive.idle_conn_timeout` (whose block goes
 * with its last key).
 */
function IdleConnectionTimeout() {
  const form = useForm();
  // A null `keepalive` reads as unset, as the collector has it (client.go:221-224).
  const flat = !present(form, ["keepalive"]) && FLAT_KEEPALIVE_KEYS.some((key) => present(form, [key]));
  // One element at either key: the flat key cleared moves the field to `keepalive`, its input kept.
  return (
    <FormScope path={flat ? [] : ["keepalive"]} prune={!flat}>
      <DurationField path={["idle_conn_timeout"]} id="datadog-idle-conn" label="Idle Connection Timeout" defaultValue="90s" />
    </FormScope>
  );
}
