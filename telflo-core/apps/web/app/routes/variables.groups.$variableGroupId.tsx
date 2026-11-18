import { useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { Route } from "./+types/variables.groups.$variableGroupId";
import { DeleteVariableGroupDialog } from "~/components/variables/DeleteVariableGroupDialog.js";
import { OverrideDialog, ResetOverrideDialog } from "~/components/variables/OverrideDialogs.js";
import { VariableGroupDialog } from "~/components/variables/VariableGroupDialog.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import {
  VARIABLE_GROUP_LOAD_FAILED_MESSAGE,
  VARIABLE_GROUP_NOT_FOUND_MESSAGE,
  changedLines,
  useVariableGroupPage,
  usageText,
  variableGroupRows,
  type VariableGroupRow,
} from "~/lib/variables.js";

/*
 * `/variables/groups/{id}`, a variable group's page (D20 default 22; Q82;
 * ADR 0018), with D20's overrides-only groups. It lists EVERY organization
 * variable (not only the group's members, a Parity Note) with its value in
 * the group and its source, "Override" or "Organization value" (an
 * override's "changed {when} by {email}" beneath it, decision 15), and per
 * row Override (a dialog) and Reset (an override's only). The header names
 * the group (text in the masked shell), its description, its counts, Edit
 * and Delete; a delete goes back to the list. The values sit inside
 * `ph-no-capture`. The address holds the group's id only; one that isn't a
 * UUID, or a group gone, says "Variable group not found" with no further
 * read. The title is fixed ("Variable group - Telflo"), never the name.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Variable group - Telflo" }];
}

const HEAD_CLASS = "h-9 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-top";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

/** An override's "changed {when} by {email}" beneath its source (decision 15, Q94): text in the masked shell, no attribute. */
function OverrideChanged({ override }: { override: NonNullable<VariableGroupRow["override"]> }) {
  const changed = changedLines(override.changedAt, override.changedBy);
  return (
    <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
      changed {changed.at}
      {changed.by !== null && ` by ${changed.by}`}
    </div>
  );
}

type OpenDialog = { kind: "override" | "reset"; row: VariableGroupRow } | { kind: "edit" | "delete" };

export default function VariableGroupRoute({ params }: Route.ComponentProps) {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  return organizationId === null ? null : (
    <VariableGroupPageFor key={`${organizationId}/${params.variableGroupId}`} organizationId={organizationId} variableGroupId={params.variableGroupId} />
  );
}

function VariableGroupPageFor({ organizationId, variableGroupId }: { organizationId: string; variableGroupId: string }) {
  const page = useVariableGroupPage(variableGroupId);
  const navigate = useNavigate();
  const idPrefix = useId();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const open = (next: OpenDialog, from: HTMLElement | null) => {
    opener.current = from;
    setDialog(next);
    setDialogOpen(true);
  };
  const returnFocus = (event: Event) => {
    const from = opener.current;
    if (from !== null && from.isConnected) {
      event.preventDefault();
      from.focus();
    }
  };

  const backLink = (
    <Link to="/variables/groups" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      All variable groups
    </Link>
  );

  if (page.notFound) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-[13px] text-muted-foreground">{VARIABLE_GROUP_NOT_FOUND_MESSAGE}</p>
      </div>
    );
  }
  if (page.value === null) {
    return (
      <div className="space-y-4">
        {backLink}
        {page.failed ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-12 text-center">
            <p className="mb-3 text-[13px] text-muted-foreground">{VARIABLE_GROUP_LOAD_FAILED_MESSAGE}</p>
            <Button variant="outline" onClick={page.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" className="rounded-lg border border-border bg-card py-12 text-center text-[13px] text-muted-foreground">
            Loading variable group…
          </div>
        )}
      </div>
    );
  }

  const { variableGroup } = page.value.detail;
  const rows = variableGroupRows(page.value);
  const changed = changedLines(variableGroup.changedAt, variableGroup.changedBy);

  return (
    <div className="space-y-4">
      {backLink}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-[15px] font-semibold tracking-[-0.01em] text-foreground">{variableGroup.name}</h2>
          {variableGroup.description !== null && (
            <p className="mt-0.5 break-words text-[13px] text-muted-foreground">{variableGroup.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {variableGroup.overrideCount === 1 ? "1 override" : `${variableGroup.overrideCount} overrides`} ·{" "}
            {usageText(variableGroup.usage)} · Changed {changed.at}
            {changed.by !== null && ` by ${changed.by}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={(event) => open({ kind: "edit" }, event.currentTarget)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-fail hover:bg-fail-soft hover:text-fail"
            onClick={(event) => open({ kind: "delete" }, event.currentTarget)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-[13px] text-muted-foreground">
          The organization has no variables yet. <Link to="/variables" className="text-brand hover:underline">Add one</Link> to
          override it here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-[13px]">
              <thead className="[&_tr]:border-b">
                <tr className={ROW_CLASS}>
                  <th className={HEAD_CLASS}>Name</th>
                  <th className={HEAD_CLASS}>Value</th>
                  <th className={HEAD_CLASS}>Source</th>
                  <th className={HEAD_CLASS}>
                    <div className="text-right">Actions</div>
                  </th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {rows.map((row) => {
                  const rowId = `${idPrefix}-row-${row.variable.id}`;
                  return (
                    <tr key={row.variable.id} className={ROW_CLASS}>
                      <td className={CELL_CLASS}>
                        <div className="break-all font-mono text-xs font-medium text-foreground">{row.variable.name}</div>
                        {row.variable.description !== null && (
                          <div className="mt-0.5 break-words text-xs text-muted-foreground">{row.variable.description}</div>
                        )}
                      </td>
                      <td className={CELL_CLASS}>
                        <code className="ph-no-capture block whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {row.value}
                        </code>
                      </td>
                      <td className={CELL_CLASS}>
                        <Badge variant={row.source === "Override" ? "default" : "outline"}>{row.source}</Badge>
                        {row.override !== null && <OverrideChanged override={row.override} />}
                      </td>
                      <td className={CELL_CLASS}>
                        <div className="flex justify-end gap-1">
                          <span id={`${rowId}-override`} className="sr-only" hidden>
                            Override {row.variable.name}
                          </span>
                          <span id={`${rowId}-reset`} className="sr-only" hidden>
                            Reset {row.variable.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            aria-labelledby={`${rowId}-override`}
                            onClick={(event) => open({ kind: "override", row }, event.currentTarget)}
                          >
                            <Pencil className="!size-3.5" aria-hidden="true" />
                            <span aria-hidden="true">Override</span>
                          </Button>
                          {row.override !== null && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-labelledby={`${rowId}-reset`}
                              onClick={(event) => open({ kind: "reset", row }, event.currentTarget)}
                            >
                              <RotateCcw className="!size-3.5" aria-hidden="true" />
                              <span aria-hidden="true">Reset</span>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <OverrideDialog
        open={dialogOpen && dialog?.kind === "override"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroupId={variableGroup.id}
        row={dialog?.kind === "override" ? dialog.row : null}
        onChanged={page.reload}
        onCloseAutoFocus={returnFocus}
      />
      <ResetOverrideDialog
        open={dialogOpen && dialog?.kind === "reset"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroupId={variableGroup.id}
        row={dialog?.kind === "reset" ? dialog.row : null}
        onChanged={page.reload}
        onCloseAutoFocus={returnFocus}
      />
      <VariableGroupDialog
        open={dialogOpen && dialog?.kind === "edit"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroup={variableGroup}
        onChanged={page.reload}
        onCloseAutoFocus={returnFocus}
      />
      <DeleteVariableGroupDialog
        open={dialogOpen && dialog?.kind === "delete"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroup={variableGroup}
        onChanged={page.reload}
        onDeleted={() => void navigate("/variables/groups")}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
