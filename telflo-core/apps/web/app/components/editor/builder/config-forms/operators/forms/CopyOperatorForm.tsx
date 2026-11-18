import { ConfigField } from "../../ConfigField.js";
import { useOperatorId } from "../operator-ids.js";
import { FieldSelector } from "../shared/FieldSelector.js";

/*
 * The `copy` operator's form (ADR 0018), over the card's scope (D9c
 * decisions 2 and 8). Ids are the card's (`op-<index>-copy-…`). From and To
 * are required (`docs/operators/copy.md`), so they show no default, and
 * neither is rootable (`transformer/copy/config.go:42-43`, `entry.Field`s).
 */
export function CopyOperatorForm() {
  const opId = useOperatorId();
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">Copy a field value to another location. The original field is preserved.</p>
      </div>

      <ConfigField label="From" description="Source field to copy from." htmlFor={opId("copy-from")}>
        <FieldSelector path={["from"]} id={opId("copy-from")} />
      </ConfigField>

      <ConfigField label="To" description="Destination field to copy to." htmlFor={opId("copy-to")}>
        <FieldSelector path={["to"]} id={opId("copy-to")} />
      </ConfigField>
    </div>
  );
}
