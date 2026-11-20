import { ConfigField } from "../../ConfigField.js";
import { CheckboxField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { TimestampConfigSection } from "../shared/TimestampConfigSection.js";

/*
 * The `json_parser` operator's form, over the card's scope (the plug-in
 * contract in `./index.ts`). Ids are the card's (`op-<index>-json-…`).
 *
 * Unset Parse From and Parse To show the collector's defaults, `body` and
 * `attributes` (`helper/parser.go:26-27`), as FieldSelector's
 * placeholders and the hints' "Default …", not as values. Parse To is
 * rootable (`helper/parser.go:35`: a bare `attributes` is a field there).
 * Unset "Parse integers" shows unticked, the collector's `false`
 * (`parser/jsonparser/config.go:35`); ticking writes `true`, unticking
 * `false`.
 */
export function JsonParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <ConfigField label="Parse From" description="Field containing JSON string to parse." defaultValue="body" htmlFor={opId("json-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("json-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for parsed JSON fields." defaultValue="attributes" htmlFor={opId("json-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("json-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <CheckboxField
        path={["parse_ints"]}
        id={opId("json-parse-ints")}
        label="Parse integers as int64 (instead of float64)"
        defaultChecked={false}
        labelClassName="text-sm"
      />

      <TimestampConfigSection />

      <SeverityConfigSection />
    </div>
  );
}
