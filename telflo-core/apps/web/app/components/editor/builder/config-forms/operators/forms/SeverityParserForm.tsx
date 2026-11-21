import { ConfigField } from "../../ConfigField.js";
import { CheckboxField, SelectField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityMappingRows, useCustomMapping } from "../shared/SeverityConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";

/*
 * The `severity_parser` operator's form, over the card's scope. Ids are the
 * card's (`op-<index>-sevp-…`); the mapping rows' are
 * `op-<index>-sevp-mapping-<level>`.
 *
 * A mapping level typed as `a, b` is written as a list, one value as a
 * string, none removes the level, and the last level's removal removes
 * `mapping`; unticking "Custom severity mapping" removes `mapping`;
 * "Overwrite severity text…" writes `true` or `false`.
 *
 * - Nothing is written on render: the mapping's keys are never lower-cased in
 *   an effect, a write on opening. The collector lower-cases them itself
 *   (`helper/severity_builder.go:125-126`, `helper/severity.go:75-79`), so the
 *   rows read keys case-insensitively and write under the text's spelling
 *   (`Error:` stays `Error:`), through the section's shared rows.
 * - The custom mapping box is on while `mapping` is there, and while it was
 *   ticked or a row typed in (not reset on every change); it is
 *   per-card state, following the card.
 * - A mapping the six rows can't show (an alias key, a number, a range, a
 *   level in two spellings, a value with a comma) is read-only with
 *   the unshowable-value hint (never `[object Object]` or nothing).
 *
 * An unset Preset shows the collector's `default`
 * (`severity_builder.go:18-107`) as the placeholder and "Default
 * default"; a preset outside the two (`otel`, `aliases`) shows as
 * written, an extra option. Parse From has no default: the collector
 * requires it (`severity_builder.go:149-151`).
 */

const PRESETS = [
  { value: "default", label: "Default (info, warn, error, debug, etc.)" },
  { value: "none", label: "None (custom mapping only)" },
] as const;

export function SeverityParserForm() {
  const opId = useOperatorId();
  const custom = useCustomMapping();
  const customId = opId("sevp-custom");
  return (
    <div className="space-y-4">
      <ConfigField label="Parse From" description="Field containing the severity value." htmlFor={opId("sevp-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("sevp-parse-from")} />
      </ConfigField>

      <SelectField
        path={["preset"]}
        id={opId("sevp-preset")}
        label="Preset"
        description="Predefined severity mappings."
        defaultValue="default"
        options={PRESETS}
      />

      <div className="flex items-center gap-2">
        <Checkbox
          id={customId}
          checked={custom.on}
          onCheckedChange={(checked) => {
            if ((checked === true) !== custom.on) custom.toggle(checked === true);
          }}
          disabled={custom.disabled}
        />
        <Label htmlFor={customId} className="text-sm">
          Custom severity mapping
        </Label>
      </div>

      {custom.on && (
        <div className="space-y-2 p-3 bg-muted/50 rounded-md border border-border">
          <p className="text-xs text-muted-foreground mb-2">Map log values to severity levels (comma-separated for multiple values)</p>
          <SeverityMappingRows idPrefix={opId("sevp-mapping")} onWrite={custom.keepOn} />
        </div>
      )}

      <CheckboxField
        path={["overwrite_text"]}
        id={opId("sevp-overwrite")}
        label="Overwrite severity text with standard name"
        defaultChecked={false}
        labelClassName="text-sm"
      />
    </div>
  );
}
