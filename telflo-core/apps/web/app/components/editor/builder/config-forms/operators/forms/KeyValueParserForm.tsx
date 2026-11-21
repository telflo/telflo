import { ConfigField } from "../../ConfigField.js";
import { TextField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { TimestampConfigSection } from "../shared/TimestampConfigSection.js";

/*
 * The `key_value_parser` operator's form, over the card's scope.
 * Ids are the card's (`op-<index>-kv-…`).
 *
 * Unset delimiters show the collector's defaults as their placeholders and
 * hints, not as values (which couldn't be cleared): Key-Value Delimiter `=`
 * (`parser/keyvalue/config.go:30`), Pair Delimiter a space (`:53-56`), which
 * the placeholder and hint call "(space)". Equal delimiters, which the
 * collector refuses (`:58-60`), are written as typed. Parse From and Parse
 * To show `body` and `attributes` (`helper/parser.go:26-27`), Parse To
 * rootable (`:35`).
 */
export function KeyValueParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          Parses key-value pairs like:{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">user=john level=info message=&quot;hello world&quot;</code>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <TextField
          path={["delimiter"]}
          id={opId("kv-delimiter")}
          label="Key-Value Delimiter"
          description="Separator between key and value."
          defaultValue="="
          className="font-mono text-xs w-20"
        />

        <TextField
          path={["pair_delimiter"]}
          id={opId("kv-pair-delimiter")}
          label="Pair Delimiter"
          description="Separator between pairs."
          defaultValue="(space)"
          className="font-mono text-xs w-20"
        />
      </div>

      <ConfigField label="Parse From" description="Field containing key-value string." defaultValue="body" htmlFor={opId("kv-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("kv-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField
        label="Parse To"
        description="Destination for extracted key-value pairs."
        defaultValue="attributes"
        htmlFor={opId("kv-parse-to")}
      >
        <FieldSelector path={["parse_to"]} id={opId("kv-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <TimestampConfigSection />

      <SeverityConfigSection />
    </div>
  );
}
