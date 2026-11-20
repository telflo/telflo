import { useState } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { DurationField, FormScope, MultiValueField, SelectField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The cumulative-to-delta processor's form, over the form's fields: each
 * field writes its own key. Collector claims are contrib v0.162.0's
 * `processor/cumulativetodeltaprocessor`. The collector's own name,
 * `cumulative_to_delta`, opens this form (`RENAMED_TYPES`).
 *
 * - There is no Max Streams control: `max_streams` isn't a key of the
 *   processor (`config.go:28-53`), which refuses it. A key already in the text
 *   is left alone.
 * - Each side's Metric Names are held rows, as the hostmetrics form's
 *   filters are (Add never writes `""`); a side's first item is written
 *   with `match_type: strict`, or the match chosen before it, whenever the
 *   side has none (the collector refuses metrics without a match type,
 *   `config.go:60-63`); a match chosen on a side with no metrics is held
 *   by the form until its first item (`config.go:64-67` refuses a match
 *   type alone). Removing a side's last metric removes `metrics` and
 *   `match_type` together, and the side's block when nothing else is in it
 *   (a pruning scope): `metric_types` and the regexp cache settings, which
 *   no field shows, keep it.
 * - Initial Value Handling unset is blank with "Default auto"
 *   (`config.go:32-37`); Max Staleness says "Default 1h"
 *   (`factory.go:33-37`; not 0, never expire). A side's Match Type beside
 *   metrics and no `match_type` is blank (the collector has no default
 *   there); with no metrics it shows the match its first item will be
 *   written with.
 * - The alert names Max Staleness, the collector's own bound.
 *
 * Ids are fixed (`initial-value`, `include-match-type`, …); no value
 * reaches an attribute.
 */

export const MEMORY_ALERT =
  "Every unique metric name + label combination is tracked as its own stream until it has been idle for Max Staleness (default 1h). In high-cardinality setups, lower it to cap memory growth.";

const INITIAL_VALUES = [
  { value: "auto", label: "Auto" },
  { value: "drop", label: "Drop" },
  { value: "keep", label: "Keep" },
] as const;

const MATCH_TYPES = [
  { value: "strict", label: "Strict (exact match)" },
  { value: "regexp", label: "Regexp (pattern match)" },
] as const;

type Side = "include" | "exclude";

/** A side's metrics, as many as the text lists. */
function metricCount(view: ValueView): number {
  return view.kind === "list" ? view.value.length : 0;
}

export function CumulativeToDeltaProcessorForm() {
  const form = useForm();
  const filterCount = metricCount(form.read(["include", "metrics"])) + metricCount(form.read(["exclude", "metrics"]));

  return (
    <div className="space-y-4">
      <SelectField
        path={["initial_value"]}
        id="initial-value"
        label="Initial Value Handling"
        description="Auto decides per metric; drop avoids large initial deltas."
        defaultValue="auto"
        options={INITIAL_VALUES}
      />

      <ConfigSection title="Filtering" count={filterCount}>
        <MatchedSide
          side="include"
          title="Include Metrics"
          placeholder="e.g. system.cpu.time"
          strictHelp="Leave empty to convert all metrics."
          regexpHelp="Go regular expressions; leave empty to convert all metrics."
        />
        <MatchedSide
          side="exclude"
          title="Exclude Metrics"
          placeholder="e.g. system.network.io"
          strictHelp="Exclude wins over include."
          regexpHelp="Go regular expressions; exclude wins over include."
        />
      </ConfigSection>

      <ConfigSection title="Advanced: Stream Limits">
        <DurationField
          path={["max_staleness"]}
          id="max-staleness"
          label="Max Staleness"
          defaultValue="1h"
          placeholder="e.g. 5m"
          description="Drop streams idle for this long."
        />

        <InlineAlert variant="warn" title="Unbounded memory">
          {MEMORY_ALERT}
        </InlineAlert>
      </ConfigSection>
    </div>
  );
}

/** One side's box, its fields under its own block, which goes with its last key. */
function MatchedSide(props: { side: Side; title: string; placeholder: string; strictHelp: string; regexpHelp: string }) {
  return (
    <div className="rounded-md border border-border p-2.5 space-y-2">
      <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
      <FormScope path={[props.side]} prune>
        <SideFields {...props} />
      </FormScope>
    </div>
  );
}

function SideFields({ side, placeholder, strictHelp, regexpHelp }: { side: Side; placeholder: string; strictHelp: string; regexpHelp: string }) {
  const form = useForm();
  const block = form.read([]);
  const metrics = form.read(["metrics"]);
  const hasMetrics = metrics.kind === "list" && metrics.value.length > 0;
  /** The match chosen while the side has no metrics: the form's, until its first item. */
  const [heldMatch, setHeldMatch] = useState<string | null>(null);
  // Once the side has metrics, however they came, the text says the match.
  if (hasMetrics && heldMatch !== null) setHeldMatch(null);

  if (block.kind !== "map" && block.kind !== "absent") {
    return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }

  const matchView = form.read(["match_type"]);
  const written = matchView.kind === "absent" ? "" : matchView.kind === "scalar" ? (matchView.source ?? String(matchView.value)) : null;
  const firstMatch = heldMatch ?? "strict";
  // Beside metrics, an unset match is blank (refused, config.go:60-63); with none, the match the first item gets.
  const shown = written === null ? null : written !== "" ? written : hasMetrics ? "" : firstMatch;
  const extra = shown !== null && shown !== "" && !MATCH_TYPES.some((option) => option.value === shown);
  const options = extra && shown !== null ? [...MATCH_TYPES, { value: shown, label: shown }] : MATCH_TYPES;

  const chooseMatch = (value: string) => {
    if (value === shown) return;
    // config.go:64-67: a match type alone is refused, so it waits for the side's first metric.
    if (written === "" && !hasMetrics) setHeldMatch(value);
    else form.set(["match_type"], value);
  };

  const withFirst = (): ValueChange[] => (form.read(["match_type"]).kind === "absent" ? [{ path: ["match_type"], value: firstMatch }] : []);
  // config.go:64-67: the last metric takes its match type with it; the pruning scope takes the block when that empties it.
  const emptied = (): ValueChange[] => [
    { path: ["metrics"], remove: true },
    { path: ["match_type"], remove: true },
  ];

  return (
    <>
      <ConfigField label="Match Type" htmlFor={`${side}-match-type`}>
        <Select value={shown ?? ""} onValueChange={chooseMatch} disabled={form.disabled || shown === null}>
          <SelectTrigger id={`${side}-match-type`}>
            <SelectValue placeholder="Select match type" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      <MultiValueField
        path={["metrics"]}
        id={`${side}-metrics`}
        label="Metric Names"
        placeholder={placeholder}
        helpText={shown === "regexp" ? regexpHelp : strictHelp}
        addButtonText="Add Metric Name"
        holdEmpty
        alsoOnAppend={withFirst}
        onEmptied={emptied}
      />
    </>
  );
}
