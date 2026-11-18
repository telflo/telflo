import { NumberField, TextField } from "../../form-context.js";
import { useOperatorId } from "../operator-ids.js";

/*
 * The `filter` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-filter-…`).
 *
 * Changed (D9b decisions 2 and 3):
 * - Drop Ratio is D9b's number field: what is typed is written as typed,
 *   plain when it reads as a number (`0.5`, `1.0`, `0`), a string otherwise
 *   (`1.0` stays `1.0`, never `1`). Its 0-1 range is advisory: a ratio
 *   outside it, which
 *   the collector refuses (`transformer/filter/config.go:61-63`), is written
 *   as typed (decision 3), D13's to report. Unset keeps the placeholder
 *   "1.0 (drop all)", the collector's 1 (`config.go:38`), and
 *   gains the hint "Default 1.0".
 * - Expression, cleared, removes `expr` (D9b's rule; never `""`, which the
 *   collector refuses to compile as well, `config.go:56-59`).
 * Fixed (decision 4; D9c Ruling 67): the "Drop by service" example reads
 * the `service.name` key, `resource["service.name"] == "noisy-service"`;
 * `resource.service.name` would be a nested path (`service` →
 * `name`), which the semantic-convention key never matches
 * (`entry/field.go:152-226`; `docs/types/field.md`).
 */
export function FilterOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 rounded-md border border-warn/25 bg-warn-soft">
        <p className="text-xs text-warn">
          Filter out (drop) log entries that match the expression. Matching entries will not continue through the pipeline.
        </p>
      </div>

      <TextField
        path={["expr"]}
        id={opId("filter-expr")}
        label="Expression"
        description="Boolean expression - matching entries are dropped."
        placeholder="body matches 'DEBUG' or attributes.level == 'trace'"
        className="font-mono text-xs"
      />

      <NumberField
        path={["drop_ratio"]}
        id={opId("filter-ratio")}
        label="Drop Ratio"
        description="Fraction of matching entries to drop (0.0-1.0)."
        defaultValue="1.0"
        placeholder="1.0 (drop all)"
      />

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Expression examples:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">body matches &apos;health.*check&apos;</code> - Drop health
            checks
          </li>
          <li>
            <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">attributes.level == &quot;debug&quot;</code> - Drop debug logs
          </li>
          <li>
            <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">resource[&quot;service.name&quot;] == &quot;noisy-service&quot;</code> - Drop
            by service
          </li>
          <li>
            <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">body contains &quot;password&quot;</code> - Drop sensitive data
          </li>
        </ul>
        <p className="text-xs text-muted-foreground mt-2">
          <strong className="font-medium text-foreground">Operators:</strong>{" "}
          <span className="font-mono">==, !=, &lt;, &gt;, contains, matches (regex), and, or, not</span>
        </p>
      </div>
    </div>
  );
}
