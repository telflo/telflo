import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, DurationField, FormScope, NumberField, SelectField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import {
  ConvertAllResourceAttributes,
  keyCount,
  LABEL_NOUNS,
  STRATEGY_UNSET,
  TRANSLATION_STRATEGIES,
  TRANSLATION_STRATEGY_DESCRIPTION,
} from "./PrometheusExporterForm.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { KeyValueMapField } from "./shared/KeyValueMapField.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { TLSInsecureCheckbox } from "./shared/TLSInsecureCheckbox.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The Prometheus remote write exporter's form, over the form's fields: each
 * field writes its own key. Collector claims cite contrib v0.162.0
 * `exporter/prometheusremotewriteexporter`.
 *
 * - While the text has an `http:` key (any value, null included),
 *   Endpoint, HTTP Headers, TLS and its insecure box read and write under
 *   `http`: the collector then reads the client settings there and ignores
 *   the deprecated top-level ones (`config.go:41-45, 188-194`). Otherwise
 *   they are top-level. Timeout is the exporter's own (`config.go:26`),
 *   top-level either way.
 * - TLS is the shared section's client variant ("Customize TLS for the
 *   remote-write connection"; the client config refuses Client CA File and
 *   its reload). Its insecure box is separate and always shown: unticking
 *   the section keeps `insecure` (`keepKeys`).
 * - There is no http:// alert (nothing fails at start: confighttp's client
 *   uses TLS only for https), and the insecure box has the HTTP copy.
 * - The strategies `NoUTF8EscapingWithSuffixes` and `NoTranslation` are
 *   offered only while the text's `protobuf_message` is Remote Write 2.0
 *   (`config.go:272-274`); a value already written shows as written. With
 *   v2, a hint names its feature gate (`config.go:260-262`, alpha, off by
 *   default).
 * - Retry's Initial Interval shows the exporter's default, 50ms
 *   (`factory.go:91-92`); External Labels have label nouns; Target Info shows
 *   ticked while unset (`factory.go:118-120`), unticking writes
 *   `target_info.enabled: false` and ticking removes it (the block with its
 *   last key). The add_metric_suffixes alert applies here (no gate;
 *   `exporter.go:224-225`).
 * - "Convert all resource attributes" can't be ticked while
 *   `resource_constant_labels` is set (`config.go:217-219`).
 * - The queue fields write `remote_write_queue.<key>` by key (never
 *   leaving `remote_write_queue: {}` when cleared).
 *
 * Ids are fixed (`prwe-…`, `tls-insecure`); no value reaches an attribute.
 */

/** Remote Write 2.0's message (prometheus/client_golang exp `api/remote/remote_headers.go:51-54`). */
export const RW2_MESSAGE = "io.prometheus.write.v2.Request";

/** The strategies that need Remote Write 2.0 (`config.go:272-274`). */
const RW2_STRATEGIES = new Set(["NoUTF8EscapingWithSuffixes", "NoTranslation"]);

/** Under Translation Strategy while the text's `protobuf_message` is v2 (`config.go:260-262`). */
export const RW2_GATE_HINT = "Needs the exporter.prometheusremotewritexporter.enableSendingRW2 feature gate (off by default).";

/** The add_metric_suffixes alert, right for remote write (no gate). */
export const PRW_ADD_METRIC_SUFFIXES_ALERT =
  "This config sets the deprecated add_metric_suffixes field; it is ignored whenever a translation strategy is selected.";

export function PrometheusRemoteWriteExporterForm() {
  const form = useForm();
  const root = form.read([]);
  // config.go:188-194: with `http` set, the top-level client settings are ignored.
  const base: ValuePath = root.kind === "map" && Object.hasOwn(root.value, "http") ? ["http"] : [];
  const message = form.read(["protobuf_message"]);
  const rw2 = message.kind === "scalar" && message.value === RW2_MESSAGE;
  const strategies = rw2 ? TRANSLATION_STRATEGIES : TRANSLATION_STRATEGIES.filter((option) => !RW2_STRATEGIES.has(option.value));
  const enabled = form.read(["resource_to_telemetry_conversion", "enabled"]);
  const converting = enabled.kind === "scalar" && enabled.value === true;

  return (
    <div className="space-y-4">
      <FormScope path={base}>
        <TextField
          path={["endpoint"]}
          id="prwe-endpoint"
          label="Endpoint"
          required
          description="Full remote-write URL the metrics are pushed to."
          placeholder="e.g. https://prometheus.example.com/api/v1/write"
        />
      </FormScope>

      <TextField
        path={["namespace"]}
        id="prwe-namespace"
        label="Namespace"
        description="Prefix added to every exported metric name."
        placeholder="e.g. myapp"
      />

      <ConfigSection title="External Labels" count={keyCount(form.read(["external_labels"]))}>
        <KeyValueMapField
          path={["external_labels"]}
          layout="staging"
          nouns={LABEL_NOUNS}
          title={null}
          description="Attached to every exported data point."
        />
      </ConfigSection>

      <ConfigSection title="HTTP Headers" count={keyCount(form.read([...base, "headers"]))}>
        <HeadersConfigSection
          path={[...base, "headers"]}
          title={null}
          description="Added to each request. Content-Encoding, Content-Type, User-Agent, and X-Prometheus-Remote-Write-Version are reserved."
        />
      </ConfigSection>

      <ConfigSection title="Metric Naming">
        <SelectField
          path={["translation_strategy"]}
          id="prwe-translation-strategy"
          label="Translation Strategy"
          description={TRANSLATION_STRATEGY_DESCRIPTION}
          placeholder="Collector default"
          unsetOption={STRATEGY_UNSET}
          options={strategies}
        />

        {rw2 && <p className="text-[11px] leading-4 text-muted-foreground">{RW2_GATE_HINT}</p>}

        {form.read(["add_metric_suffixes"]).kind !== "absent" && (
          <InlineAlert variant="warn">{PRW_ADD_METRIC_SUFFIXES_ALERT}</InlineAlert>
        )}
      </ConfigSection>

      <ConfigSection title="Behavior">
        <ConvertAllResourceAttributes id="prwe-resource-to-telemetry" />

        {converting && (
          <FormScope path={["resource_to_telemetry_conversion"]} prune>
            <CheckboxField
              path={["exclude_service_attributes"]}
              id="prwe-exclude-service-attributes"
              label="Skip service.* attributes already mapped to job/instance labels"
              defaultChecked={false}
              uncheckedRemoves
              rowClassName="flex items-center gap-2 pl-6"
              labelClassName="text-xs text-muted-foreground"
            />
          </FormScope>
        )}

        <FormScope path={["target_info"]} prune>
          <CheckboxField
            path={["enabled"]}
            id="prwe-target-info"
            label="Emit a target_info series carrying resource attributes (collector default)"
            defaultChecked={true}
            checkedRemoves
            labelClassName="text-xs text-muted-foreground"
          />
        </FormScope>

        <CheckboxField
          path={["send_metadata"]}
          id="prwe-send-metadata"
          label="Send Prometheus metric metadata (type, help text)"
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-xs text-muted-foreground"
        />

        <CheckboxField
          path={["disable_scope_info"]}
          id="prwe-disable-scope-info"
          label="Omit otel_scope_* instrumentation-scope labels"
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-xs text-muted-foreground"
        />
      </ConfigSection>

      <ConfigSection title="Delivery">
        <DurationField
          path={["timeout"]}
          id="prwe-timeout"
          label="Timeout"
          defaultValue="5s"
          description="Per-request timeout for each remote-write call."
          placeholder="5s"
        />

        <NumberField
          path={["remote_write_queue", "queue_size"]}
          id="prwe-queue-size"
          label="Queue Size"
          defaultValue="10000"
          description="Metrics buffered in the exporter's own remote-write queue (the standard sending_queue is not supported)."
          placeholder="10000"
        />

        <NumberField
          path={["remote_write_queue", "num_consumers"]}
          id="prwe-num-consumers"
          label="Queue Workers"
          defaultValue="5"
          description="Workers fanning out queued writes. Set 1 when the backend rejects out-of-order samples."
          placeholder="5"
        />

        <RetryConfigSection path={["retry_on_failure"]} initialIntervalDefault="50ms" />
      </ConfigSection>

      <ConfigSection title="TLS">
        <TLSInsecureCheckbox path={[...base, "tls", "insecure"]} protocol="http" />

        <TLSConfigSection
          path={[...base, "tls"]}
          protocolLabel="the remote-write connection"
          variant="client"
          keepKeys={["insecure"]}
        />
      </ConfigSection>
    </div>
  );
}
