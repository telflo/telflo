import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormScope,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  useForm,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { isTruthy, listLength } from "./shared/counts.js";
import { DimensionListField } from "./shared/DimensionListField.js";
import { ExcludingScope } from "./shared/ExcludingScope.js";
import { ListTextField } from "./shared/ListTextField.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The spanmetrics connector's form, over the form's fields: each field
 * writes its own key. Collector claims are contrib v0.162.0's
 * `connector/spanmetricsconnector`. The collector's own name,
 * `span_metrics`, opens this form (`RENAMED_TYPES`; `metadata.yaml:1-2`).
 *
 * - Fixed: Histogram Buckets are `[]time.Duration` (`config.go:139-144`;
 *   core `confmap/internal/decoder.go:58-76` has no weak typing, so a bare
 *   number is nanoseconds: `2ms` read as a number would be `2`, 2 ns). The
 *   field is a `ListTextField`: each item written as typed, by item (`2ms`
 *   a string, a bare number plain), joined ", "; cleared,
 *   `histogram.explicit` goes, so the collector's defaults apply
 *   (`connector.go:216-225`; an `explicit` with no buckets has none,
 *   `connector.go:211-215`). Its placeholder is the 16 defaults
 *   (`config.go:25-27`), its copy corrected.
 * - Changed: the collector refuses `explicit` beside `exponential`
 *   (`config.go:172-174`). Typing buckets while `histogram.exponential` is
 *   set removes it in the same change, and typing Exponential Max Size while
 *   `histogram.explicit` is set removes that, each with its toast. A null
 *   one is unset to the collector (neither is a `configoptional.Default`,
 *   `factory.go:38-55`; core `configoptional/optional.go:176`) and isn't
 *   removed. Max Size cleared removes `max_size` only: `exponential: {}`
 *   stays, an exponential histogram at the default 160 (the collector checks
 *   `Histogram.Exponential.HasValue()` first, `connector.go`
 *   `initHistogramMetrics`); removing it would switch the connector to
 *   explicit buckets unasked. While `histogram.exponential` is a mapping
 *   (`{}` too; a null one is unset) and `explicit` isn't set, Histogram
 *   Buckets says so (`EXPONENTIAL_IN_USE`); with both written, which the
 *   collector refuses (`config.go:172-174`), it says that instead
 *   (`BOTH_HISTOGRAMS`).
 * - Changed: choosing Delta while `metric_timestamp_cache_size`
 *   is 0 or less removes it in the same change (the 1000 default applies),
 *   with its toast (`config.go:188-193`, `215-220`).
 * - Fixed: Enable Events Metrics with no events dimensions also writes
 *   the README's `dimensions: [{name: exception.type}]`
 *   (`README.md:200-204`), one change, no toast (the box's own seed): the
 *   collector refuses events with no dimensions
 *   (`config.go:168-170, 271-279`). The "Dimension required" alert stays
 *   for a text that has them on with none.
 * - Fixed: the four dimension lists are `DimensionListField`s
 *   (Add holds a row until a name is typed, never `{name: ""}`,
 *   refused, `config.go:238-241`); the three string lists hold their rows
 *   (never `""`). Exclude Dimensions emptied leaves `[]`, the
 *   other two remove their key.
 * - Changed: Aggregation Temporality writes
 *   `AGGREGATION_TEMPORALITY_CUMULATIVE` or `_DELTA`; unset is blank with
 *   "Default Cumulative"; any other value shows as written with the hint
 *   that the collector reads it as cumulative (`config.go:206-213`;
 *   `DELTA` included). Histogram Unit unset is blank with "Default ms"
 *   (`factory.go:43-49`); number fields write what is typed, 0 included.
 * - Changed copy: Histogram Unit, Histogram Buckets, Exclude
 *   Dimensions (`collector.instance.id`, `connector.go:600-602`), Include
 *   Instrumentation Scopes (it adds dimensions, filtering nothing,
 *   `connector.go:605-610`), Add Resource Attributes (kept either way
 *   unless the alpha gate is on, `connector.go:315-317`).
 *
 * Ids are fixed (dimension rows by index); no value reaches an attribute.
 */

export const REMOVED_EXPLICIT = "Removed the explicit buckets: the collector uses either explicit or exponential buckets.";
export const REMOVED_EXPONENTIAL = "Removed the exponential histogram: the collector uses either explicit or exponential buckets.";
export const REMOVED_TIMESTAMP_CACHE = "Removed metric_timestamp_cache_size: delta temporality needs a positive cache size.";
export const EXPONENTIAL_IN_USE = "Exponential buckets are in use; typing buckets switches to explicit.";
export const BOTH_HISTOGRAMS = "The collector refuses explicit and exponential buckets together. Remove one in the YAML below.";
export const TEMPORALITY_HINT = "The collector reads anything but AGGREGATION_TEMPORALITY_DELTA as cumulative.";

/** The collector's default buckets (`config.go:25-27`), as durations. */
export const DEFAULT_BUCKETS = "2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s";

const CUMULATIVE = "AGGREGATION_TEMPORALITY_CUMULATIVE";
const DELTA = "AGGREGATION_TEMPORALITY_DELTA";

const UNITS = [
  { value: "ms", label: "Milliseconds (ms)" },
  { value: "s", label: "Seconds (s)" },
] as const;

const TEMPORALITIES = [
  { value: CUMULATIVE, label: "Cumulative" },
  { value: DELTA, label: "Delta" },
] as const;

/** A labelled dimension list (heading, description and rows). */
function Dimensions({ label, description, path, id, namePlaceholder }: { label?: string; description: string; path: ValuePath; id: string; namePlaceholder?: string }) {
  return (
    <div className="space-y-2">
      {label === undefined ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : (
        <div>
          <label className="text-sm font-medium">{label}</label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      )}
      <DimensionListField path={path} id={id} {...(namePlaceholder !== undefined ? { namePlaceholder } : {})} />
    </div>
  );
}

export function SpanmetricsConnectorForm() {
  const form = useForm();
  const { note } = useAdjustments();
  const temporality = form.read(["aggregation_temporality"]);
  const temporalityText = temporality.kind === "scalar" ? (temporality.source ?? String(temporality.value)) : null;
  const temporalityAsWritten = temporalityText !== null && temporalityText !== CUMULATIVE && temporalityText !== DELTA;
  const eventsOn = isTruthy(form.read(["events", "enabled"]));
  const eventsMissingDimensions = eventsOn && listLength(form.read(["events", "dimensions"])) === 0;
  const dimensionCount = listLength(form.read(["dimensions"])) + listLength(form.read(["calls_dimensions"]));
  // A mapping, `{}` included, is the histogram the collector makes, unless explicit is set too, which the
  // collector refuses (config.go:172-174). Null is unset to it (optional.go:176).
  const exponentialSet = form.read(["histogram", "exponential"]).kind === "map";
  const explicitSet = form.read(["histogram", "explicit"]).kind !== "absent";

  const chooseTemporality = (value: string) => {
    const changes: ValueChange[] = [{ path: ["aggregation_temporality"], value }];
    // config.go:188-193: delta needs a positive timestamp cache size; removed, the default 1000 applies.
    const size = form.read(["metric_timestamp_cache_size"]);
    const nonPositive = value === DELTA && size.kind === "scalar" && (typeof size.value === "number" || typeof size.value === "bigint") && size.value <= 0;
    if (nonPositive) changes.push({ path: ["metric_timestamp_cache_size"], remove: true });
    const result = form.apply(changes);
    if (nonPositive) note([REMOVED_TIMESTAMP_CACHE], result);
  };

  const toggleEvents = (on: boolean) => {
    // config.go:168-170, 271-279: events need a dimension; the README's seed comes with the box (README.md:200-204).
    if (on && listLength(form.read(["events", "dimensions"])) === 0) {
      form.apply([
        { path: ["events", "enabled"], value: true },
        { path: ["events", "dimensions"], value: [{ name: "exception.type" }] },
      ]);
    } else {
      form.set(["events", "enabled"], on);
    }
  };

  return (
    <div className="space-y-4">
      <SelectField
        path={["histogram", "unit"]}
        id="histogram-unit"
        label="Histogram Unit"
        defaultValue="ms"
        description="Unit the duration metrics are recorded in."
        options={UNITS}
      />

      <ExcludingScope excludes={["histogram", "exponential"]} message={REMOVED_EXPONENTIAL}>
        <ListTextField
          path={["histogram", "explicit", "buckets"]}
          id="histogram-buckets"
          separator=","
          join=", "
          plainNumbers
          removePathWhenEmpty={["histogram", "explicit"]}
          label="Histogram Buckets"
          description="Comma-separated durations, e.g. 2ms, 100ms, 1s. A number without a unit is read as nanoseconds."
          placeholder={DEFAULT_BUCKETS}
        />
        {exponentialSet && !explicitSet && <p className="text-[11px] leading-4 text-muted-foreground">{EXPONENTIAL_IN_USE}</p>}
        {exponentialSet && explicitSet && <p className="text-[11px] leading-4 text-warn">{BOTH_HISTOGRAMS}</p>}
      </ExcludingScope>

      <CheckboxField
        path={["histogram", "disable"]}
        id="disable-histogram"
        label="Disable Histogram"
        description="Only generate call count metrics."
        defaultChecked={false}
      />

      <ExcludingScope excludes={["histogram", "explicit"]} message={REMOVED_EXPLICIT}>
        <FormScope path={["histogram", "exponential"]}>
          <NumberField
            path={["max_size"]}
            id="exponential-max-size"
            label="Exponential Histogram Max Size"
            defaultValue="160"
            description="Max buckets per positive or negative range."
          />
        </FormScope>
      </ExcludingScope>

      <Dimensions
        label="Histogram Dimensions"
        description="Extra dimensions for the duration histogram only."
        path={["histogram", "dimensions"]}
        id="histogram-dimensions"
      />

      <ConfigSection title="Dimensions" count={dimensionCount}>
        <Dimensions description="Span or resource attributes to add as metric labels." path={["dimensions"]} id="dimensions" />

        <Dimensions label="Calls Dimensions" description="Applied only to call count metrics." path={["calls_dimensions"]} id="calls-dimensions" />

        <MultiValueField
          path={["exclude_dimensions"]}
          id="exclude-dimensions"
          label="Exclude Dimensions"
          placeholder="e.g. status.code"
          helpText="Drop default dimensions (service.name, span.name, span.kind, status.code, collector.instance.id)."
          addButtonText="Add Exclusion"
          holdEmpty
        />

        <MultiValueField
          path={["include_instrumentation_scope"]}
          id="include-instrumentation-scope"
          label="Include Instrumentation Scopes"
          placeholder="e.g. @opentelemetry/instrumentation-http"
          helpText="Adds the scope name and version as dimensions for spans from these instrumentation scopes."
          addButtonText="Add Scope"
          holdEmpty
          emptyRemovesKey
        />
      </ConfigSection>

      <ConfigSection title="Aggregation">
        <SelectField
          path={["aggregation_temporality"]}
          id="aggregation-temporality"
          label="Aggregation Temporality"
          defaultValue="Cumulative"
          description="How metric values accumulate over time."
          options={TEMPORALITIES}
          onSelect={chooseTemporality}
        />
        {temporalityAsWritten && <p className="text-[11px] leading-4 text-muted-foreground">{TEMPORALITY_HINT}</p>}

        <TextField
          path={["namespace"]}
          id="namespace"
          label="Namespace"
          defaultValue="traces.span.metrics"
          description="Prefix for generated metric names."
        />

        <DurationField
          path={["metrics_flush_interval"]}
          id="flush-interval"
          label="Metrics Flush Interval"
          defaultValue="60s"
          description="How often metrics are flushed to the next component."
        />

        <DurationField
          path={["metrics_expiration"]}
          id="metrics-expiration"
          label="Metrics Expiration"
          defaultValue="0 (never)"
          description="Remove metrics that receive no new data for this long."
        />
      </ConfigSection>

      <ConfigSection title="Advanced" forceOpen={eventsMissingDimensions}>
        <h4 className="tf-label">Exemplars</h4>
        <CheckboxField
          path={["exemplars", "enabled"]}
          id="exemplars-enabled"
          label="Enable Exemplars"
          description="Attach trace IDs to metrics for trace correlation."
          defaultChecked={false}
        />

        {isTruthy(form.read(["exemplars", "enabled"])) && (
          <NumberField path={["exemplars", "max_per_data_point"]} id="max-exemplars" label="Max Exemplars Per Data Point" defaultValue="5" />
        )}

        <h4 className="tf-label">Events Metrics</h4>
        <CheckboxField
          path={["events", "enabled"]}
          id="events-enabled"
          label="Enable Events Metrics"
          description="Generate metrics from span events."
          defaultChecked={false}
          onToggle={toggleEvents}
        />

        {eventsOn && (
          <div className="space-y-2">
            <div>
              <label className="text-sm font-medium">Events Dimensions</label>
              <p className="text-xs text-muted-foreground">Span event attributes to add as dimensions.</p>
            </div>
            <DimensionListField path={["events", "dimensions"]} id="events-dimensions" namePlaceholder="e.g. exception.type" />
            {eventsMissingDimensions && (
              <InlineAlert variant="warn" title="Dimension required">
                Add at least one span event attribute when events metrics are enabled.
              </InlineAlert>
            )}
          </div>
        )}

        <h4 className="tf-label">Cache &amp; Limits</h4>
        <NumberField
          path={["resource_metrics_cache_size"]}
          id="cache-size"
          label="Resource Metrics Cache Size"
          defaultValue="1000"
          description="Max resource entries kept in the metrics cache."
        />

        <NumberField
          path={["aggregation_cardinality_limit"]}
          id="cardinality-limit"
          label="Aggregation Cardinality Limit"
          defaultValue="0 (unlimited)"
          description="Max unique dimension combinations."
          placeholder="0"
        />

        <NumberField
          path={["metric_timestamp_cache_size"]}
          id="timestamp-cache-size"
          label="Metric Timestamp Cache Size"
          defaultValue="1000"
          description="Cache size for delta temporality metric timestamps."
        />

        <CheckboxField
          path={["add_resource_attributes"]}
          id="add-resource-attributes"
          label="Add Resource Attributes"
          description="Resource attributes are kept either way unless the connector.spanmetrics.excludeResourceMetrics feature gate is on."
          defaultChecked={false}
          uncheckedRemoves
        />

        <MultiValueField
          path={["resource_metrics_key_attributes"]}
          id="resource-metrics-key-attributes"
          label="Resource Metrics Key Attributes"
          placeholder="e.g. service.name"
          helpText="Restrict which resource attributes form the resource metrics key hash."
          addButtonText="Add Attribute"
          holdEmpty
          emptyRemovesKey
        />
      </ConfigSection>
    </div>
  );
}
