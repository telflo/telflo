import { useId } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { OrganizationVariable } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { changedLines } from "~/lib/variables.js";

/*
 * The Variables page's table, with its columns: Name (the description
 * beneath), Value, Changed (the time and who) and the row's actions, Edit and
 * Delete. In detail:
 * - the value is shown in full (unmasked: nothing in it is secret), and
 *   inside `ph-no-capture` (replay records nothing of it), as configuration
 *   text; the name and the description are text in the masked shell;
 * - the actions are icon buttons named by `aria-labelledby` pointing at
 *   hidden text ("Edit {name}", "Delete {name}"), as the fleet rows'
 *   (`FleetRowActions.tsx`): no attribute holds a name.
 */

const HEAD_CLASS = "h-9 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-top";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

/** What a row's button asks for. */
export type VariableRowAction = "edit" | "delete";

interface VariablesTableProps {
  variables: readonly OrganizationVariable[];
  /** `from` is the button pressed: where the focus goes back as its dialog closes. */
  onAction: (action: VariableRowAction, variable: OrganizationVariable, from: HTMLElement) => void;
}

export function VariablesTable({ variables, onAction }: VariablesTableProps) {
  const idPrefix = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Name</th>
              <th className={HEAD_CLASS}>Value</th>
              <th className={HEAD_CLASS}>Changed</th>
              <th className={HEAD_CLASS}>
                <div className="text-right">Actions</div>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {variables.map((variable) => {
              const rowId = `${idPrefix}-variable-${variable.id}`;
              const changed = changedLines(variable.changedAt, variable.changedBy);
              return (
                <tr key={variable.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <div className="break-all font-mono text-xs font-medium text-foreground">{variable.name}</div>
                    {variable.description !== null && (
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">{variable.description}</div>
                    )}
                  </td>
                  <td className={CELL_CLASS}>
                    <code className="ph-no-capture block whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {variable.value}
                    </code>
                  </td>
                  <td className={`${CELL_CLASS} whitespace-nowrap`}>
                    <div className="font-mono text-xs text-muted-foreground">{changed.at}</div>
                    {changed.by !== null && <div className="text-xs text-muted-foreground">by {changed.by}</div>}
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex justify-end gap-1">
                      <span id={`${rowId}-edit`} className="sr-only" hidden>
                        Edit {variable.name}
                      </span>
                      <span id={`${rowId}-delete`} className="sr-only" hidden>
                        Delete {variable.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Edit"
                        aria-labelledby={`${rowId}-edit`}
                        onClick={(event) => onAction("edit", variable, event.currentTarget)}
                      >
                        <Pencil className="!size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-fail hover:bg-fail-soft hover:text-fail"
                        title="Delete"
                        aria-labelledby={`${rowId}-delete`}
                        onClick={(event) => onAction("delete", variable, event.currentTarget)}
                      >
                        <Trash2 className="!size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
