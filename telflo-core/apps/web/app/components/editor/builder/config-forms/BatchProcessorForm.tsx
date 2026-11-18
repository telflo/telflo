import { ConfigSection } from "./ConfigSection.js";
import { DurationField, MultiValueField, NumberField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The batch processor's form (ADR 0018), over the form's fields (D9b
 * decisions 2 and 3): each field writes its own key; the metadata keys are
 * written by item. The collector's defaults (batch processor
 * `createDefaultConfig`, v0.162.0: 200ms, 8192, no maximum, 1000) show while
 * a key is unset; 0 can be entered (decision 4).
 *
 * The alerts read the text: "Zero timeout" for a timeout written `0` or
 * `0s`, "Size conflict" while both sizes are numbers and the maximum is
 * above 0 and below the batch size, quoting each as the text writes it.
 */

/** A scalar's characters as the text writes them (`0750` stays `0750`). */
function written(view: ValueView): string | undefined {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : undefined;
}

function numberOf(view: ValueView): number | undefined {
  return view.kind === "scalar" && typeof view.value === "number" ? view.value : undefined;
}

export function BatchProcessorForm() {
  const form = useForm();
  const timeout = written(form.read(["timeout"]));
  const size = form.read(["send_batch_size"]);
  const maxSize = form.read(["send_batch_max_size"]);
  const sizeValue = numberOf(size);
  const maxValue = numberOf(maxSize);
  const hasMaxSizeConflict = maxValue !== undefined && maxValue > 0 && sizeValue !== undefined && maxValue < sizeValue;
  const hasZeroTimeout = timeout === "0" || timeout === "0s";

  const keys = form.read(["metadata_keys"]);
  const keyCount = keys.kind === "list" ? keys.value.length : 0;

  return (
    <div className="space-y-4">
      <DurationField
        path={["timeout"]}
        id="timeout"
        label="Timeout"
        defaultValue="200ms"
        description="Send a batch after this long, regardless of size."
      />

      {hasZeroTimeout && (
        <InlineAlert variant="warn" title="Zero timeout">
          Batches are sent only when <span className="font-mono">send_batch_size</span> is reached.
        </InlineAlert>
      )}

      <NumberField
        path={["send_batch_size"]}
        id="send-batch-size"
        label="Send Batch Size"
        defaultValue="8192"
        description="Send a batch once it holds this many items."
      />

      <NumberField
        path={["send_batch_max_size"]}
        id="send-batch-max-size"
        label="Send Batch Max Size"
        defaultValue="0 (no limit)"
        placeholder="0"
        description="Hard cap per batch; must be at least the batch size."
      />

      {hasMaxSizeConflict && (
        <InlineAlert variant="fail" title="Size conflict">
          <span className="font-mono">send_batch_max_size</span> ({written(maxSize)}) must be at least{" "}
          <span className="font-mono">send_batch_size</span> ({written(size)}).
        </InlineAlert>
      )}

      <ConfigSection title="Metadata Batching" count={keyCount}>
        <MultiValueField
          path={["metadata_keys"]}
          label="Metadata Keys"
          placeholder="e.g. tenant.id"
          helpText="Batch separately per unique value of these keys."
          addButtonText="Add Metadata Key"
        />

        {keyCount > 0 && (
          <>
            <NumberField
              path={["metadata_cardinality_limit"]}
              id="metadata-cardinality-limit"
              label="Metadata Cardinality Limit"
              defaultValue="1000"
              description="Max unique metadata combinations kept in memory."
            />

            <InlineAlert variant="info" title="Memory per combination">
              Each unique combination runs its own batcher. Avoid high-cardinality keys like request ids.
            </InlineAlert>
          </>
        )}
      </ConfigSection>
    </div>
  );
}
