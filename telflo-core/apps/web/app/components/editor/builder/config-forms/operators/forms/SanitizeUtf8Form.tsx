import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `sanitize_utf8` operator's form, over the card's scope. Ids are the
 * card's (`op-<index>-sanitize-utf8-…`).
 *
 * An unset Field shows the collector's `body`
 * (`transformer/sanitizeutf8/transformer.go:37`) as its placeholder and
 * "Default body", never as a value it doesn't write. The example's code is
 * the escape text `\uFFFD` (JSX text, so the six characters), then the
 * character itself in brackets.
 */

export function SanitizeUtf8Form() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <ConfigField label="Field" description="String field to sanitize." defaultValue="body" htmlFor={opId("sanitize-utf8-field")}>
        <FieldSelector path={["field"]} id={opId("sanitize-utf8-field")} defaultValue="body" />
      </ConfigField>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">How it works:</strong> Invalid UTF-8 byte sequences are replaced with the
          Unicode replacement character <code className="rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs">\uFFFD</code> (�).
        </p>
      </div>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Use case:</strong> Ensures log data has valid UTF-8 encoding for downstream systems
          that require valid UTF-8 text.
        </p>
      </div>
    </div>
  );
}
