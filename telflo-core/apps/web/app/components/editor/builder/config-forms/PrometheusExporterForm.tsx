import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, DurationField, FormScope, SelectField, TextField, useForm, type SelectOption } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { KeyValueMapField, type KeyValueNouns } from "./shared/KeyValueMapField.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Prometheus exporter's form, over the form's fields: each field writes
 * its own key.
 *
 * - Constant Labels is `KeyValueMapField`'s `"staging"` layout (as
 *   `HeadersConfigSection` with `title={null}`), with label nouns (as
 *   docker_stats' form has).
 * - Translation Strategy's "Collector default (suffixes added)" is
 *   `SelectField`'s unset option: shown while the key is unset, choosing it
 *   removes the key (its value `__unset__`, never written). With the beta
 *   gate `exporter.prometheusexporter.DisableAddMetricSuffixes` on by
 *   default, unset means UnderscoreEscapingWithSuffixes
 *   (`exporter/prometheusexporter/collector.go:126-130`, `metadata.yaml:20-
 *   24` at contrib v0.162.0).
 * - The add_metric_suffixes alert says the collector ignores it (that gate).
 * - "Convert all resource attributes" can't be ticked while
 *   `resource_constant_labels` is set, which the collector refuses beside it
 *   (`config.go:76-78`), with a hint; ticked, it can be unticked. It writes
 *   `resource_to_telemetry_conversion. enabled` (`true`, or removed when
 *   unticked, the block with its last key), never replacing the whole block.
 * - The behavior boxes write `true` or remove the key;
 *   unset shows the collector's default (`factory.go:29-38`): Metric
 *   Expiration 5m.
 * - TLS is the server variant (the exporter serves `/metrics`, a squashed
 *   `confighttp.ServerConfig`, `config.go:22-62`).
 *
 * Ids are fixed (`prometheus-exporter-…`); no value reaches an attribute.
 */

/** Constant and external labels: the rows' words. */
export const LABEL_NOUNS: KeyValueNouns = {
  key: "Label name",
  value: "Label value",
  addLabel: "Add label",
  removeLabel: "Remove label",
  exists: "A label with this name already exists.",
  newKey: "e.g. env",
  newValue: "e.g. prod",
};

/** The translation strategies (`config.go:85-92`) and their labels. */
export const TRANSLATION_STRATEGIES: readonly SelectOption[] = [
  { value: "UnderscoreEscapingWithSuffixes", label: "Underscore escaping + suffixes" },
  { value: "UnderscoreEscapingWithoutSuffixes", label: "Underscore escaping, no suffixes" },
  { value: "NoUTF8EscapingWithSuffixes", label: "Keep UTF-8 + suffixes" },
  { value: "NoTranslation", label: "No translation (pass-through)" },
];

/** The unset option's label (the sentinel item). */
export const STRATEGY_UNSET = { label: "Collector default (suffixes added)" } as const;

export const TRANSLATION_STRATEGY_DESCRIPTION =
  "How OTLP metric names translate to Prometheus names (escaping and type/unit suffixes).";

/** While the text sets `add_metric_suffixes` (the gate is on by default). */
export const ADD_METRIC_SUFFIXES_ALERT =
  "This config sets the deprecated add_metric_suffixes field; the collector ignores it (the exporter.prometheusexporter.DisableAddMetricSuffixes feature gate is on by default).";

export const CONVERT_ALL_LABEL = "Convert all resource attributes to metric labels (instead of target_info)";

/** Under "Convert all resource attributes" while `resource_constant_labels` is set. */
export const CONSTANT_LABELS_HINT = "Can't be used while resource_constant_labels is set.";

/** A mapping's key count (0 for anything else). */
export function keyCount(view: ValueView): number {
  return view.kind === "map" ? Object.keys(view.value).length : 0;
}

/** Whether `resource_constant_labels` is set as the collector counts it: anything but unset or an empty mapping. */
function constantLabelsSet(view: ValueView): boolean {
  return view.kind !== "absent" && !(view.kind === "map" && Object.keys(view.value).length === 0);
}

/**
 * "Convert all resource attributes" (both exporters): `resource_to_telemetry_conversion.enabled`,
 * ticked `true`, unticked removed (the block with its last key). Ticking is disabled while
 * `resource_constant_labels` is set: the collector refuses both (prometheus `config.go:76-78`,
 * remote write `config.go:217-219`); deleting the person's labels instead would lose a list they wrote.
 */
export function ConvertAllResourceAttributes({ id }: { id: string }) {
  const form = useForm();
  const constantLabels = constantLabelsSet(form.read(["resource_constant_labels"]));
  const enabled = form.read(["resource_to_telemetry_conversion", "enabled"]);
  const ticked = enabled.kind === "scalar" && enabled.value === true;
  return (
    <FormScope path={["resource_to_telemetry_conversion"]} prune>
      <CheckboxField
        path={["enabled"]}
        id={id}
        label={CONVERT_ALL_LABEL}
        defaultChecked={false}
        uncheckedRemoves
        labelClassName="text-xs text-muted-foreground"
        disabled={constantLabels && !ticked}
        {...(constantLabels ? { description: CONSTANT_LABELS_HINT } : {})}
      />
    </FormScope>
  );
}

export function PrometheusExporterForm() {
  const form = useForm();

  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="prometheus-exporter-endpoint"
        label="Endpoint"
        required
        description="Address the HTTP server binds to; metrics are served at /metrics for Prometheus to scrape."
        placeholder="e.g. 0.0.0.0:8889"
      />

      <TextField
        path={["namespace"]}
        id="prometheus-exporter-namespace"
        label="Namespace"
        description="Prefix added to every exported metric name."
        placeholder="e.g. myapp"
      />

      <ConfigSection title="Constant Labels" count={keyCount(form.read(["const_labels"]))}>
        <KeyValueMapField
          path={["const_labels"]}
          layout="staging"
          nouns={LABEL_NOUNS}
          title={null}
          description="Added to every exported metric."
        />
      </ConfigSection>

      <ConfigSection title="Metric Naming">
        <SelectField
          path={["translation_strategy"]}
          id="prometheus-exporter-translation-strategy"
          label="Translation Strategy"
          description={TRANSLATION_STRATEGY_DESCRIPTION}
          placeholder="Collector default"
          unsetOption={STRATEGY_UNSET}
          options={TRANSLATION_STRATEGIES}
        />

        {form.read(["add_metric_suffixes"]).kind !== "absent" && (
          <InlineAlert variant="warn">{ADD_METRIC_SUFFIXES_ALERT}</InlineAlert>
        )}
      </ConfigSection>

      <ConfigSection title="Behavior">
        <DurationField
          path={["metric_expiration"]}
          id="prometheus-exporter-metric-expiration"
          label="Metric Expiration"
          defaultValue="5m"
          description="How long a series stays exposed without an update before it is dropped."
          placeholder="5m"
        />

        <CheckboxField
          path={["send_timestamps"]}
          id="prometheus-exporter-send-timestamps"
          label="Send sample timestamps with each metric"
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-xs text-muted-foreground"
        />

        <CheckboxField
          path={["enable_open_metrics"]}
          id="prometheus-exporter-open-metrics"
          label="Expose in OpenMetrics format (required for exemplars)"
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-xs text-muted-foreground"
        />

        <ConvertAllResourceAttributes id="prometheus-exporter-resource-to-telemetry" />

        <CheckboxField
          path={["without_scope_info"]}
          id="prometheus-exporter-without-scope-info"
          label="Omit otel_scope_* instrumentation-scope labels"
          defaultChecked={false}
          uncheckedRemoves
          labelClassName="text-xs text-muted-foreground"
        />
      </ConfigSection>

      <ConfigSection title="TLS">
        <TLSConfigSection path={["tls"]} protocolLabel="the scrape endpoint" variant="server" />
      </ConfigSection>
    </div>
  );
}
