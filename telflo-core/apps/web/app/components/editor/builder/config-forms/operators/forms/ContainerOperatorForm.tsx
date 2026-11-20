import { ConfigField } from "../../ConfigField.js";
import { CheckboxField, NumberField, SelectField, useForm } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";

/*
 * The `container` operator's form, over the card's scope. Ids are the card's
 * (`op-<index>-container-…`). The operator has no timestamp block, so the form
 * has the Severity section only.
 *
 * Kept: Container Format's "Auto-detect" removes `format` (the collector
 * detects the format when it is unset, `parser/container/config.go:63-73`),
 * and unset shows "Auto-detect" as its placeholder; a format outside the
 * three shows as written, `format: auto` included: the collector refuses
 * `auto` (`config.go:63-71`), so it isn't shown as Auto-detect. The
 * Auto-detect item's value is a fixed name the text's format never equals.
 * "Add Kubernetes metadata from file path" shows the collector's `true` when
 * unset (`config.go:42`) and writes `true` or `false`. Fixed: Max Log Size's
 * default is the collector's 1 MiB (`config.go:25, 43`), shown as "Default
 * 1MiB" and the placeholder, and its description no longer says 0 is the
 * default: "Maximum bytes for recombined partial logs." (not "… (0 =
 * unlimited).", placeholder 0). It is a number field: a number is written
 * plain, 0 included, and a size with a unit (`2MiB`, a `helper.ByteSize`,
 * `config.go:53`) as typed (never `parseInt`'s 2 for `2MiB`). Changed: unset
 * Parse From and Parse To show the collector's `body` and `attributes`
 * (`helper/parser.go:26-27`), Parse To rootable (`:35`).
 */

const FORMATS = [
  { value: "docker", label: "Docker (JSON)" },
  { value: "crio", label: "CRI-O" },
  { value: "containerd", label: "Containerd" },
] as const;

/** The Auto-detect item's value: one of two fixed names, whichever the text's format isn't. */
function autoDetectValue(written: unknown): string {
  return written === "auto-detect" ? "(auto-detect)" : "auto-detect";
}

export function ContainerOperatorForm() {
  const form = useForm();
  const opId = useOperatorId();
  const format = form.read(["format"]);
  const auto = autoDetectValue(format.kind === "scalar" ? format.value : undefined);
  return (
    <div className="space-y-4">
      <SelectField
        path={["format"]}
        id={opId("container-format")}
        label="Container Format"
        description="Container runtime log format (auto-detect if not set)."
        placeholder="Auto-detect"
        options={[{ value: auto, label: "Auto-detect" }, ...FORMATS]}
        onSelect={(value) => {
          if (value === auto) form.remove(["format"]);
          else form.set(["format"], value);
        }}
      />

      <CheckboxField
        path={["add_metadata_from_filepath"]}
        id={opId("container-add-metadata")}
        label="Add Kubernetes metadata from file path"
        defaultChecked
        labelClassName="text-sm"
      />

      <NumberField
        path={["max_log_size"]}
        id={opId("container-max-log-size")}
        label="Max Log Size"
        description="Maximum bytes for recombined partial logs."
        defaultValue="1MiB"
      />

      <ConfigField label="Parse From" description="Source field to parse." defaultValue="body" htmlFor={opId("container-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("container-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for parsed fields." defaultValue="attributes" htmlFor={opId("container-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("container-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Supported formats:</strong>
          <br />• <strong className="font-medium text-foreground">Docker:</strong> JSON format with log, stream, time fields
          <br />• <strong className="font-medium text-foreground">CRI-O:</strong> Text format with log tags
          <br />• <strong className="font-medium text-foreground">Containerd:</strong> Text format with timestamps
        </p>
      </div>

      <SeverityConfigSection />
    </div>
  );
}
