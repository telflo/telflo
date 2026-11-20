import { useId } from "react";
import { Link } from "react-router";
import { Pencil, Trash2 } from "lucide-react";
import type { VariableGroup } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { changedLines, usageText } from "~/lib/variables.js";

/*
 * The Variable groups page's table, with its columns: Name (the description
 * beneath; a link to the group's page, `/variables/groups/{id}`), Overrides
 * (a count, the API's), Used by (the collector groups bound to it and the
 * collectors it is pinned on, counted), Changed (the time and who), and
 * Edit and Delete, named by hidden text as the fleet rows' (no attribute
 * holds a name). A name and a description are text in the masked shell.
 */

const HEAD_CLASS = "h-9 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-top";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

export type VariableGroupRowAction = "edit" | "delete";

interface VariableGroupsTableProps {
  variableGroups: readonly VariableGroup[];
  onAction: (action: VariableGroupRowAction, variableGroup: VariableGroup, from: HTMLElement) => void;
}

export function VariableGroupsTable({ variableGroups, onAction }: VariableGroupsTableProps) {
  const idPrefix = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Name</th>
              <th className={HEAD_CLASS}>Overrides</th>
              <th className={HEAD_CLASS}>Used by</th>
              <th className={HEAD_CLASS}>Changed</th>
              <th className={HEAD_CLASS}>
                <div className="text-right">Actions</div>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {variableGroups.map((group) => {
              const rowId = `${idPrefix}-variable-group-${group.id}`;
              const changed = changedLines(group.changedAt, group.changedBy);
              return (
                <tr key={group.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <Link
                      to={`/variables/groups/${encodeURIComponent(group.id)}`}
                      className="break-words font-medium text-foreground hover:text-brand hover:underline"
                    >
                      {group.name}
                    </Link>
                    {group.description !== null && (
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">{group.description}</div>
                    )}
                  </td>
                  <td className={`${CELL_CLASS} font-mono text-xs tabular-nums text-muted-foreground`}>{group.overrideCount}</td>
                  <td className={`${CELL_CLASS} text-xs text-muted-foreground`}>{usageText(group.usage)}</td>
                  <td className={`${CELL_CLASS} whitespace-nowrap`}>
                    <div className="font-mono text-xs text-muted-foreground">{changed.at}</div>
                    {changed.by !== null && <div className="text-xs text-muted-foreground">by {changed.by}</div>}
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex justify-end gap-1">
                      <span id={`${rowId}-edit`} className="sr-only" hidden>
                        Edit {group.name}
                      </span>
                      <span id={`${rowId}-delete`} className="sr-only" hidden>
                        Delete {group.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Edit"
                        aria-labelledby={`${rowId}-edit`}
                        onClick={(event) => onAction("edit", group, event.currentTarget)}
                      >
                        <Pencil className="!size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-fail hover:bg-fail-soft hover:text-fail"
                        title="Delete"
                        aria-labelledby={`${rowId}-delete`}
                        onClick={(event) => onAction("delete", group, event.currentTarget)}
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
