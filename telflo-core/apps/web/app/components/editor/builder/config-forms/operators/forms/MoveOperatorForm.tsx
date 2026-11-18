import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `move` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-move-…`). From and To
 * are required (`docs/operators/move.md`), so they show no default, and
 * neither is rootable (`transformer/move/config.go:42-43`).
 *
 * Fixed (decision 4): the "Promote to resource" example is
 * `resource["host.name"]`; `resource.host.name` would be a nested
 * path (`host` → `name`), not the semantic-convention key `host.name`
 * (`entry/field.go:152-226`; `docs/types/field.md`).
 */

const CODE = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function MoveOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">Move a field to a new location. The original field is removed.</p>
      </div>

      <ConfigField label="From" description="Source field to move." htmlFor={opId("move-from")}>
        <FieldSelector path={["from"]} id={opId("move-from")} />
      </ConfigField>

      <ConfigField label="To" description="Destination field." htmlFor={opId("move-to")}>
        <FieldSelector path={["to"]} id={opId("move-to")} />
      </ConfigField>

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Common use cases:</strong>
        </p>
        <ul className="text-xs text-muted-foreground list-disc ml-4 mt-1 space-y-1">
          <li>
            Rename a field: <code className={CODE}>attributes.old_name</code> → <code className={CODE}>attributes.new_name</code>
          </li>
          <li>
            Promote to resource: <code className={CODE}>attributes.host</code> → <code className={CODE}>{'resource["host.name"]'}</code>
          </li>
          <li>
            Move body to attribute: <code className={CODE}>body</code> → <code className={CODE}>attributes.original_body</code>
          </li>
        </ul>
      </div>
    </div>
  );
}
