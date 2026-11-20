import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { CheckboxField, DurationField, FormScope, NumberField, SelectField, useForm } from "../form-context.js";
import { enabledOf, SectionHint, SectionToggle, UnshowableSectionHint, type AbsentMeans } from "./section-toggle.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The sending queue section, over the form's fields. Bound to the
 * `sending_queue` block's path.
 *
 * Ticking the box writes `enabled: true`, `num_consumers: 10` and
 * `queue_size: 1000` as the block; unticking writes `enabled: false` in
 * place of the block. Each is one change.
 *
 * The box shows on while `enabled` is unset, as the collector has it; the
 * fields show unset as unset.
 *
 * The Batching hints read as if batching were on, though writing any
 * `batch.*` key turns it on.
 */

const SIZERS = [
  { value: "requests", label: "Requests" },
  { value: "items", label: "Items" },
  { value: "bytes", label: "Bytes" },
] as const;

interface SendingQueueSectionProps {
  /** The `sending_queue` block's path under the form. */
  path: ValuePath;
  showBatchSettings?: boolean;
  /** Before every id (`"lb-"`), fixed by the form. */
  idPrefix?: string;
  /** What an absent block means: an off variant's unticking removes the key. */
  absentMeans?: AbsentMeans;
}

/*
 * `idPrefix` sets the ids apart where a form shows the section twice (load
 * balancing's `"lb-"`); without it the ids are unprefixed.
 * `absentMeans: "off-optional"` is a `configoptional.Default` queue (load
 * balancing's top level, the S3 exporter): absent shows off, a null block or
 * one without `enabled: false` on (its fields write it as a mapping); ticking
 * writes the block and unticking removes the key.
 */
export function SendingQueueSection({ path, showBatchSettings = true, idPrefix = "", absentMeans = "on" }: SendingQueueSectionProps) {
  const form = useForm();
  const state = enabledOf(form, path, absentMeans);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggle = (
    <SectionToggle
      id={`${idPrefix}queue-enable`}
      label="Enable Sending Queue"
      state={state}
      disabled={form.disabled}
      onToggle={(on) => {
        if (on) form.set(path, { enabled: true, num_consumers: 10, queue_size: 1000 });
        else if (absentMeans !== "on") form.remove(path);
        else form.set(path, { enabled: false });
      }}
    />
  );

  if (state !== "on") {
    return (
      <div className="space-y-1.5">
        {toggle}
        <SectionHint>Buffer data in an internal queue before exporting.</SectionHint>
        {state === "unshowable" && <UnshowableSectionHint />}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/50 p-3">
      {toggle}

      <FormScope path={path}>
        {/* Basic Queue Settings */}
        <NumberField
          path={["num_consumers"]}
          id={`${idPrefix}queue-num-consumers`}
          label="Consumers"
          defaultValue="10"
          description="Worker goroutines draining the queue."
          placeholder="10"
        />

        <NumberField path={["queue_size"]} id={`${idPrefix}queue-size`} label="Queue Size" defaultValue="1000" placeholder="1000" />

        {/* Batch Settings (if enabled) */}
        {showBatchSettings && (
          <div className="space-y-4 border-t border-border pt-3">
            <p className="text-[13px] font-medium text-foreground">Batching</p>

            <DurationField
              path={["batch", "flush_timeout"]}
              id={`${idPrefix}queue-flush-timeout`}
              label="Flush Timeout"
              defaultValue="200ms"
              description="Send the batch after this long, regardless of size."
              placeholder="200ms"
            />

            <NumberField
              path={["batch", "min_size"]}
              id={`${idPrefix}queue-min-batch-size`}
              label="Min Batch Size"
              defaultValue="8192"
              description="Items required before a batch is sent."
              placeholder="8192"
            />

            <NumberField
              path={["batch", "max_size"]}
              id={`${idPrefix}queue-max-batch-size`}
              label="Max Batch Size"
              defaultValue="0 (unlimited)"
              placeholder="0"
            />
          </div>
        )}

        {/* Advanced Settings (collapsible) */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-4">
              <SelectField
                path={["sizer"]}
                id={`${idPrefix}queue-sizer`}
                label="Sizer"
                defaultValue="requests"
                description="Unit used to measure queue size."
                options={SIZERS}
              />

              <CheckboxField
                path={["wait_for_result"]}
                id={`${idPrefix}wait-for-result`}
                label="Wait for result (blocks until processed)"
                defaultChecked={false}
                labelClassName="text-xs text-muted-foreground"
              />

              <CheckboxField
                path={["block_on_overflow"]}
                id={`${idPrefix}block-on-overflow`}
                label="Block on overflow (instead of dropping data)"
                defaultChecked={false}
                labelClassName="text-xs text-muted-foreground"
              />
            </div>
          )}
        </div>
      </FormScope>
    </div>
  );
}
