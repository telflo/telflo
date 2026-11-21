import { DurationField, FormScope, NumberField, useForm } from "../form-context.js";
import { enabledOf, SectionHint, SectionToggle, UnshowableSectionHint, type AbsentMeans } from "./section-toggle.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The retry section, over the form's fields. Bound to the `retry_on_failure`
 * block's path.
 *
 * Ticking the box writes `enabled: true` with `5s`, `30s`, `300s` and `1.5`
 * as the block; unticking writes `enabled: false` in place of the block. Each
 * is one change.
 *
 * The box shows on while `enabled` is unset (the key or the whole block), as
 * the collector has it. The fields show unset as unset, the default as the
 * placeholder and the "Default" hint, rather than as a value; a field's edit
 * writes only its key.
 *
 * `idPrefix` sets the ids apart where a form shows the section twice (load
 * balancing's `"lb-"`); without it the ids are unprefixed. `absentMeans` gives
 * an off variant (`AbsentMeans`): ticking still writes the block, and
 * unticking removes the key, as absent is off. `initialIntervalDefault` is the
 * collector's default for the exporter, shown as the placeholder and the hint
 * (remote write's 50ms, `factory.go:91-92`); ticking still writes 5s.
 */

export function RetryConfigSection({
  path,
  idPrefix = "",
  absentMeans = "on",
  initialIntervalDefault = "5s",
}: {
  path: ValuePath;
  /** Before every id (`"lb-"`), fixed by the form. */
  idPrefix?: string;
  absentMeans?: AbsentMeans;
  /** The collector's default Initial Interval for this exporter. */
  initialIntervalDefault?: string;
}) {
  const form = useForm();
  const state = enabledOf(form, path, absentMeans);

  const toggle = (
    <SectionToggle
      id={`${idPrefix}retry-enable`}
      label="Enable Retry on Failure"
      state={state}
      disabled={form.disabled}
      onToggle={(on) => {
        if (on) {
          form.set(path, {
            enabled: true,
            initial_interval: "5s",
            max_interval: "30s",
            max_elapsed_time: "300s",
            multiplier: 1.5,
          });
        } else if (absentMeans !== "on") {
          form.remove(path);
        } else {
          form.set(path, { enabled: false });
        }
      }}
    />
  );

  if (state !== "on") {
    return (
      <div className="space-y-1.5">
        {toggle}
        <SectionHint>Retry failed requests with exponential backoff.</SectionHint>
        {state === "unshowable" && <UnshowableSectionHint />}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/50 p-3">
      {toggle}

      <FormScope path={path}>
        <DurationField
          path={["initial_interval"]}
          id={`${idPrefix}retry-initial-interval`}
          label="Initial Interval"
          defaultValue={initialIntervalDefault}
          description="Wait this long after the first failure."
          placeholder={initialIntervalDefault}
        />

        <DurationField
          path={["max_interval"]}
          id={`${idPrefix}retry-max-interval`}
          label="Max Interval"
          defaultValue="30s"
          description="Upper bound for backoff between retries."
          placeholder="30s"
        />

        <DurationField
          path={["max_elapsed_time"]}
          id={`${idPrefix}retry-max-elapsed-time`}
          label="Max Elapsed Time"
          defaultValue="300s"
          description="Total time spent retrying; 0 retries forever."
          placeholder="300s"
        />

        <NumberField
          path={["multiplier"]}
          id={`${idPrefix}retry-multiplier`}
          label="Backoff Multiplier"
          defaultValue="1.5"
          description="Each retry waits this many times longer."
          placeholder="1.5"
        />
      </FormScope>
    </div>
  );
}
