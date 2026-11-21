import { ConfigField } from "../../ConfigField.js";
import { NumberField, TextField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";
import { SeverityConfigSection } from "../shared/SeverityConfigSection.js";
import { TimestampConfigSection } from "../shared/TimestampConfigSection.js";
import { findPattern } from "~/lib/regex-library.js";

/*
 * The `regex_parser` operator's form, over the card's scope. Ids are the
 * card's (`op-<index>-regex-…`). The pattern's placeholder and the tip's
 * example are regex-library's "Generic Log Line" and "Date-Prefixed Log Line".
 *
 * - Regex Pattern is written as typed: a pattern without named groups, which
 *   the collector refuses (`parser/regex/config.go:64-75`), is written all
 *   the same. Cleared, the key goes (the collector requires it, `:55-56`,
 *   and refuses `""` as well).
 * - Cache Size is a number field: 0 is typed and written (never shown as
 *   empty); a value past `uint16` (`config.go:43-45`) is written as typed.
 *   Unset shows the collector's 0, no cache (`config.go:82-83`), as the
 *   placeholder and "Default 0". Cleared, `cache.size` goes and an emptied
 *   `cache` stays `{}`, which the collector reads as no cache.
 * - Parse From and Parse To show the collector's `body` and `attributes`
 *   when unset (`helper/parser.go:26-27`); Parse To is rootable (`:35`).
 */
export function RegexParserForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <TextField
        path={["regex"]}
        id={opId("regex-pattern")}
        label="Regex Pattern"
        description="Go regex with named capture groups (?P<name>...)."
        placeholder={findPattern("Generic Log Line (timestamp/level/message)").pattern}
        className="font-mono text-xs"
      />

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Tip:</strong> Use named groups like{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">{"(?P<field_name>...)"}</code> to extract fields.
          Example:{" "}
          <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">{findPattern("Date-Prefixed Log Line").pattern}</code>
        </p>
      </div>

      <ConfigField label="Parse From" description="Field containing text to parse." defaultValue="body" htmlFor={opId("regex-parse-from")}>
        <FieldSelector path={["parse_from"]} id={opId("regex-parse-from")} defaultValue="body" />
      </ConfigField>

      <ConfigField label="Parse To" description="Destination for extracted fields." defaultValue="attributes" htmlFor={opId("regex-parse-to")}>
        <FieldSelector path={["parse_to"]} id={opId("regex-parse-to")} defaultValue="attributes" rootable />
      </ConfigField>

      <NumberField
        path={["cache", "size"]}
        id={opId("regex-cache")}
        label="Cache Size"
        description="Regex cache size (0 = disabled)."
        defaultValue="0"
      />

      <TimestampConfigSection />

      <SeverityConfigSection />
    </div>
  );
}
