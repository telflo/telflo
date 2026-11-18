import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `remove` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-remove-…`). Field is
 * required (`docs/operators/remove.md`), so it shows no default. It is
 * rootable (`transformer/remove/config.go:39`, `rootable_field.go:49-64`):
 * an empty suffix writes a bare `attributes` or `resource`, which removes
 * them all (decision 8).
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function RemoveOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="border border-warn/25 bg-warn-soft rounded-md px-3 py-2">
        <p className="text-xs text-warn">Permanently remove a field from the log entry. This cannot be undone.</p>
      </div>

      <ConfigField label="Field" description="Field to remove." htmlFor={opId("remove-field")}>
        <FieldSelector path={["field"]} id={opId("remove-field")} rootable />
      </ConfigField>

      <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground font-medium">Common use cases:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            Remove sensitive data: <code className={CODE}>attributes.password</code>
          </li>
          <li>
            Clean up parsed fields: <code className={CODE}>attributes.raw_message</code>
          </li>
          <li>Remove temporary fields after processing</li>
        </ul>
      </div>
    </div>
  );
}
