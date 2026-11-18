import { ConfigField } from "../../ConfigField.js";
import { CheckboxField, TextField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { TimestampConfigSection } from "../shared/TimestampConfigSection.js";

/*
 * The `csv_parser` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-csv-…`).
 *
 * Fixed:
 * - Header Attribute is an attribute's name (decision 4): the collector
 *   looks the header up as `e.Attributes[header_attribute]`
 *   (`parser/csv/parser.go:95`), so a FieldSelector, which writes
 *   `attributes.x`, would name a key `"attributes.x"`. It is a text field, with
 *   the collector's own example as its placeholder (`header_field`,
 *   `parser/csv/config_test.go:71`).
 * - Header and Header Attribute exclude each other, and so do Lazy quotes
 *   and Ignore quotes (decision 7; Preflight ruling 15): the collector
 *   refuses both headers (`parser/csv/config.go:78-80`) and both quote
 *   modes (`:62-64`). Typing in one header removes the other in the same
 *   change; ticking one quote box unticks the other (writes `false`, as
 *   unticking it does); no alert, as filelog's multiline patterns. Neither
 *   is disabled while the other is set, so the seed's header gives way to a
 *   typed attribute (both are never kept).
 * - A one-column header, which the collector refuses (`config.go:82-84`),
 *   is written as typed (decision 3), D13's to report.
 * - Header's hint is "Column names, separated by the delimiter." (D9c
 *   Ruling 63; not "Comma-separated column names."): the header is
 *   split on `header_delimiter`, which defaults to Delimiter
 *   (`config.go:58-60, 82-84, 99`), not always on a comma.
 * Changed (D9b decision 3): an unset Delimiter shows the collector's `,`
 * (`config.go:54-56`) as its placeholder and in the hint, never as the
 * value (which couldn't be cleared); Parse From and Parse To show `body` and
 * `attributes` (`helper/parser.go:26-27`), Parse To rootable (`:35`). The
 * quote boxes write `true` or `false`.
 */
export function CsvParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <TextField
        path={["header"]}
        id={opId("csv-header")}
        label="Header"
        description="Column names, separated by the delimiter."
        placeholder="id,name,timestamp,message"
        className="font-mono text-xs"
        excludes={["header_attribute"]}
      />

      <TextField
        path={["header_attribute"]}
        id={opId("csv-header-attr")}
        label="Header Attribute"
        description="Alternative: attribute containing header row."
        placeholder="e.g., header_field"
        className="font-mono text-xs"
        excludes={["header"]}
      />

      <div className="grid grid-cols-2 gap-4">
        <TextField
          path={["delimiter"]}
          id={opId("csv-delimiter")}
          label="Delimiter"
          description="Column separator."
          defaultValue=","
          className="font-mono text-xs w-20"
        />

        <div className="space-y-2">
          <CheckboxField
            path={["lazy_quotes"]}
            id={opId("csv-lazy-quotes")}
            label="Lazy quotes"
            defaultChecked={false}
            labelClassName="text-sm"
            excludes={["ignore_quotes"]}
          />

          <CheckboxField
            path={["ignore_quotes"]}
            id={opId("csv-ignore-quotes")}
            label="Ignore quotes"
            defaultChecked={false}
            labelClassName="text-sm"
            excludes={["lazy_quotes"]}
          />
        </div>
      </div>

      <ConfigField label="Parse From" description="Field containing CSV data." defaultValue="body" htmlFor={opId("csv-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("csv-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for parsed fields." defaultValue="attributes" htmlFor={opId("csv-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("csv-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <TimestampConfigSection />

      <SeverityConfigSection />
    </div>
  );
}
