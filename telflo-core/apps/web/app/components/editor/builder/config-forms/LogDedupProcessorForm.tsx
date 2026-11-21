import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { DurationField, MultiValueField, NumberField, TextField, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { listLength } from "./shared/counts.js";

/*
 * The log dedup processor's form, over the form's fields. Collector claims
 * are contrib v0.162.0's `processor/logdedupprocessor`. The collector's own
 * name, `log_dedup`, opens this form (`RENAMED_TYPES`; `metadata.yaml:2-3`).
 *
 * - The lists' Add holds a row that isn't in the text (never `""`: a field
 *   whose first segment isn't `body` or `attributes` is refused,
 *   `config.go:107-172`; an empty condition doesn't parse,
 *   `factory.go:46-58`); the first typing appends it. Removing a list's last
 *   item removes its key.
 * - The collector refuses Include and Exclude Fields together
 *   (`config.go:85-87`). A cascade would delete a typed list, so each list
 *   is locked (typing and Add disabled) while the other has items, with a
 *   hint; its items can still be removed. A text with both shows a fail
 *   alert, its section forced open.
 * - Exclude Fields says excluded fields are removed from the emitted log
 *   (`README.md:35`).
 * - Metadata Cardinality Limit is a number field: 0, the collector's "no
 *   limit" (`config.go:51-53`), can be typed; cleared removes it.
 * - Strings are written as typed: field paths keep `\.`, and conditions their
 *   quotes and escapes.
 *
 * Ids are fixed per field.
 */

export const EXCLUDE_FIELDS_DESCRIPTION =
  "Fields ignored when matching and removed from the emitted log; the entire body cannot be excluded.";
export const INCLUDE_LOCKED_HINT = "Can't be used while Exclude Fields has items.";
export const EXCLUDE_LOCKED_HINT = "Can't be used while Include Fields has items.";

const hint = (text: string) => <p className="text-[11px] leading-4 text-muted-foreground">{text}</p>;

export function LogDedupProcessorForm() {
  const form = useForm();
  const includeCount = listLength(form.read(["include_fields"]));
  const excludeCount = listLength(form.read(["exclude_fields"]));
  const hasFieldConflict = includeCount > 0 && excludeCount > 0;
  const metadataCount = listLength(form.read(["metadata_keys"]));

  return (
    <div className="space-y-4">
      <DurationField
        path={["interval"]}
        id="interval"
        label="Interval"
        defaultValue="10s"
        description="Aggregation window; the duplicate counter resets after each interval."
      />

      <TextField
        path={["log_count_attribute"]}
        id="log-count-attribute"
        label="Log Count Attribute"
        defaultValue="log_count"
        description="Attribute on the emitted log holding the duplicate count."
      />

      <TextField
        path={["timezone"]}
        id="timezone"
        label="Timezone"
        defaultValue="UTC"
        placeholder="e.g. America/Los_Angeles"
        description="IANA timezone for the first/last observed timestamps."
      />

      <ConfigSection title="Match Scope" count={includeCount + excludeCount} forceOpen={hasFieldConflict}>
        {hasFieldConflict && (
          <InlineAlert variant="fail" title="Conflicting field lists">
            <span className="font-mono">include_fields</span> and <span className="font-mono">exclude_fields</span> are mutually
            exclusive; the collector rejects a config with both set.
          </InlineAlert>
        )}

        <ConfigField
          label="Include Fields"
          htmlFor="include-fields"
          description="Only these body/attribute fields are compared when matching duplicates."
        >
          <MultiValueField
            path={["include_fields"]}
            id="include-fields"
            placeholder="e.g. attributes.id"
            helpText={"Prefix with body. or attributes.; escape literal dots as \\."}
            holdEmpty
            emptyRemovesKey
            locked={excludeCount > 0}
          />
          {excludeCount > 0 && hint(INCLUDE_LOCKED_HINT)}
        </ConfigField>

        <ConfigField label="Exclude Fields" htmlFor="exclude-fields" description={EXCLUDE_FIELDS_DESCRIPTION}>
          <MultiValueField
            path={["exclude_fields"]}
            id="exclude-fields"
            placeholder="e.g. body.timestamp"
            holdEmpty
            emptyRemovesKey
            locked={includeCount > 0}
          />
          {includeCount > 0 && hint(EXCLUDE_LOCKED_HINT)}
        </ConfigField>
      </ConfigSection>

      <ConfigSection title="Conditions" count={listLength(form.read(["conditions"]))}>
        <ConfigField
          label="OTTL Conditions"
          htmlFor="conditions"
          description="Only records matching a condition are deduped; everything else passes through untouched."
        >
          <MultiValueField
            path={["conditions"]}
            id="conditions"
            placeholder={'e.g. resource.attributes["service.name"] == "my-service"'}
            holdEmpty
            emptyRemovesKey
          />
        </ConfigField>
      </ConfigSection>

      <ConfigSection title="Metadata Partitioning" count={metadataCount}>
        <ConfigField
          label="Metadata Keys"
          htmlFor="metadata-keys"
          description="Client metadata keys (gRPC/HTTP headers) that partition aggregation."
        >
          <MultiValueField path={["metadata_keys"]} id="metadata-keys" placeholder="e.g. tenant.id" holdEmpty emptyRemovesKey />
        </ConfigField>

        {metadataCount > 0 && (
          <NumberField
            path={["metadata_cardinality_limit"]}
            id="metadata-cardinality-limit"
            label="Metadata Cardinality Limit"
            defaultValue="0 (unlimited)"
            placeholder="0"
            description="Max distinct metadata combinations tracked simultaneously."
          />
        )}
      </ConfigSection>
    </div>
  );
}
