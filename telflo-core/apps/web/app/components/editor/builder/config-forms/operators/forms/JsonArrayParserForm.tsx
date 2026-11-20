import { ConfigField } from "../../ConfigField.js";
import { TextField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { TimestampConfigSection } from "../shared/TimestampConfigSection.js";

/*
 * The `json_array_parser` operator's form, over the card's scope.
 * Ids are the card's (`op-<index>-json-array-…`).
 *
 * - Parse To keeps its required mark, and shows no default: the
 *   collector's `attributes` (`helper/parser.go:27`) takes an array only
 *   with a header (`docs/operators/json_array_parser.md`, `parse_to`), so
 *   the seed writes `body` (`operator-catalog.ts`); unset never shows
 *   `attributes` as the value. It is rootable (`helper/parser.go:35`).
 * Changed: unset Parse From shows the collector's `body`
 * (`helper/parser.go:26`); Header, cleared, removes its key.
 */
export function JsonArrayParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <ConfigField label="Parse From" description="Field containing JSON array string." defaultValue="body" htmlFor={opId("json-array-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("json-array-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for parsed array." required htmlFor={opId("json-array-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("json-array-parse-to")} rootable />
      </ConfigField>

      <TextField
        path={["header"]}
        id={opId("json-array-header")}
        label="Header"
        description="Comma-delimited keys to create a map instead of list."
        placeholder="key1,key2,key3"
        className="font-mono text-sm"
      />

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Usage:</strong> Parses JSON arrays like{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">[1, &quot;debug&quot;, true]</code>. When header is set
          (e.g., &quot;foo,bar,baz&quot;), outputs a map instead of list.
        </p>
      </div>

      <TimestampConfigSection />

      <SeverityConfigSection />
    </div>
  );
}
