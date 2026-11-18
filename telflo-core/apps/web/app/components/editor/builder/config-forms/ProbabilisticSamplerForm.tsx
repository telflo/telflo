import { useState } from "react";

import { ConfigSection } from "./ConfigSection.js";
import { CheckboxField, NumberField, SelectField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The probabilistic sampler's form (ADR 0018), over the form's fields
 * (D9d decision 2, D9b's contract): each field writes its own key.
 * Collector claims are contrib v0.162.0's
 * `processor/probabilisticsamplerprocessor`.
 *
 * - Kept (the controller's ruling): Sampling Percentage is marked required
 *   (the README calls it required, `README.md:306`), though the factory
 *   leaves it 0, which rejects everything (`config.go:32`): unset shows the
 *   placeholder 0 and "Default 0".
 * - Changed (decision 4): Sampling Mode unset is blank with the placeholder
 *   Hash Seed, "Default hash_seed" and hash_seed's description: an unset
 *   mode runs as `hash_seed` (`sampler_mode.go:69-70, 381-397`; the
 *   README's reference agrees, `README.md:305`), not
 *   proportional. Hash Seed and its "Seed must match" alert show while the
 *   mode is unset or hash_seed, the mode the collector runs.
 * - Changed (decision 2): the number fields write what is typed, as typed;
 *   cleared, the key is removed (never 0, and the precision isn't clamped:
 *   `config.go:125-129` refuses 0 and 15+, which D13 reports). Unset shows
 *   the collector's defaults: Hash Seed 0, Precision 4 (`factory.go:20,
 *   32-39`).
 * - Changed (decision 3 display): Attribute Source unset is blank with the
 *   placeholder TraceID and "Default traceID" (`factory.go:34`).
 * - Changed (the controller's ruling): From Attribute shows while it is set
 *   or the source is `record`: the collector reads it under traceID too, as
 *   a fallback for a record with no trace ID (`config.go:90-92`;
 *   `logsprocessor.go:128-136`), so a value in the text can be seen and
 *   removed. Cleared, From Attribute and Sampling Priority remove their
 *   keys (never `""`). Once shown, From Attribute stays shown
 *   for the form's session (D9d Ruling 43), until another component (or
 *   load) is shown: cleared under traceID, it doesn't vanish mid-edit.
 * - Kept: Fail Closed ticked while unset (`factory.go:32-39`), writing
 *   `true` or `false`. No cascades: a mode or source switch leaves the
 *   other keys.
 *
 * Ids are fixed; no value reaches an attribute (decision 13).
 */

const MODES = [
  { value: "proportional", label: "Proportional" },
  { value: "hash_seed", label: "Hash Seed" },
  { value: "equalizing", label: "Equalizing" },
] as const;

const MODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  proportional: "Predictable output ratios, W3C compliant. Recommended.",
  hash_seed: "Deterministic sampling by attribute hash.",
  equalizing: "Adjusts for upstream sampling decisions (mixed SDKs).",
};

const ATTRIBUTE_SOURCES = [
  { value: "traceID", label: "TraceID" },
  { value: "record", label: "Log Record Attribute" },
] as const;

/** A scalar's characters as written, `undefined` while unset, null when it isn't a scalar. */
function written(view: ValueView): string | undefined | null {
  if (view.kind === "absent") return undefined;
  if (view.kind !== "scalar") return null;
  return view.source ?? String(view.value);
}

export function ProbabilisticSamplerForm() {
  const form = useForm();
  const mode = written(form.read(["mode"]));
  // An unset mode runs as hash_seed (sampler_mode.go:69-70).
  const runningMode = mode === undefined ? "hash_seed" : mode;
  const hashSeedShown = runningMode === "hash_seed";
  const source = written(form.read(["attribute_source"]));
  const fromAttributeWanted = source === "record" || form.read(["from_attribute"]).kind !== "absent";
  // Once shown, kept for the session: the Configuration tab is keyed by the load and the node (D9d Ruling 43).
  const [fromAttributeKept, setFromAttributeKept] = useState(false);
  if (fromAttributeWanted && !fromAttributeKept) setFromAttributeKept(true);
  const fromAttributeShown = fromAttributeWanted || fromAttributeKept;

  return (
    <div className="space-y-4">
      <NumberField
        path={["sampling_percentage"]}
        id="sampling-percentage"
        label="Sampling Percentage"
        required
        defaultValue="0"
        description="Percent of items to keep; 0 rejects all, 100+ keeps all."
        className="font-mono"
      />

      <SelectField
        path={["mode"]}
        id="mode"
        label="Sampling Mode"
        defaultValue="hash_seed"
        options={MODES}
        {...(runningMode !== null && Object.hasOwn(MODE_DESCRIPTIONS, runningMode) ? { description: MODE_DESCRIPTIONS[runningMode] } : {})}
      />

      {hashSeedShown && (
        <>
          <NumberField path={["hash_seed"]} id="hash-seed" label="Hash Seed" defaultValue="0" className="font-mono" />

          <InlineAlert variant="warn" title="Seed must match">
            All collectors processing the same data must use identical <span className="font-mono">hash_seed</span> values.
          </InlineAlert>
        </>
      )}

      <InlineAlert variant="info" title="Signal support">
        Traces are beta, logs alpha; metrics are not supported.
      </InlineAlert>

      <ConfigSection title="Advanced">
        <CheckboxField
          path={["fail_closed"]}
          id="fail-closed"
          label="Fail Closed"
          description="Rejects items when the sampling decision errors."
          defaultChecked
        />

        <NumberField
          path={["sampling_precision"]}
          id="sampling-precision"
          label="Sampling Precision"
          defaultValue="4"
          description="Hex digits for threshold encoding (1-14); higher is finer."
          className="font-mono"
        />
      </ConfigSection>

      <ConfigSection title="Logs Sampling">
        <SelectField
          path={["attribute_source"]}
          id="attribute-source"
          label="Attribute Source"
          defaultValue="traceID"
          description="Randomness source for logs; traces always use the trace ID."
          options={ATTRIBUTE_SOURCES}
        />

        {fromAttributeShown && (
          <TextField
            path={["from_attribute"]}
            id="from-attribute"
            label="From Attribute"
            description="Log attribute used for the sampling decision."
            placeholder="e.g. service.instance.id"
            className="font-mono text-xs"
          />
        )}

        <TextField
          path={["sampling_priority"]}
          id="sampling-priority"
          label="Sampling Priority"
          description="Attribute overriding the percentage per record (0 drops, 100+ keeps)."
          placeholder="e.g. sampling.priority"
          className="font-mono text-xs"
        />
      </ConfigSection>
    </div>
  );
}
