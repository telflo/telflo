import { useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { StringListField } from "./shared/StringListField.js";

/*
 * The group-by-attributes processor's form, over the form's fields:
 * Grouping Keys is the shared `StringListField` over `keys`, written by
 * item; removing the last leaves `keys: []`, which the collector takes
 * (contrib v0.162.0 `processor/groupbyattrsprocessor/factory.go:32-36`,
 * its default). The compaction alert shows while the text has no keys
 * (unset, null or `[]`).
 */

export const COMPACTION_ALERT =
  "With no keys the processor runs in compaction mode: records that share the same resource and scope are merged into a single ResourceSpans/ResourceMetrics/ResourceLogs entry.";

export function GroupByAttrsProcessorForm() {
  const form = useForm();
  const keys = form.read(["keys"]);
  const none = keys.kind === "absent" || (keys.kind === "list" && keys.value.length === 0);
  return (
    <div className="space-y-4">
      <StringListField
        path={["keys"]}
        label="Grouping Keys"
        description="Attribute names promoted to resource identity: records are regrouped under a resource per distinct value combination, and the attributes move from the record to the resource."
        placeholder="e.g. host.name"
      />

      {none && <InlineAlert variant="info">{COMPACTION_ALERT}</InlineAlert>}

      <p className="text-[11px] leading-4 text-muted-foreground">
        Upstream recommends a batch processor as the step after this one, so regrouped data is packed efficiently before
        export.
      </p>
    </div>
  );
}
