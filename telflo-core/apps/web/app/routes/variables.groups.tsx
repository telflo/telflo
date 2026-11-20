import { useRef, useState } from "react";
import { AlertCircle, Layers, Plus } from "lucide-react";
import type { VariableGroup } from "@telflo/contracts";
import type { Route } from "./+types/variables.groups";
import { DeleteVariableGroupDialog } from "~/components/variables/DeleteVariableGroupDialog.js";
import { SecretsWarning } from "~/components/variables/SecretsWarning.js";
import { VariableGroupDialog } from "~/components/variables/VariableGroupDialog.js";
import { VariableGroupsTable, type VariableGroupRowAction } from "~/components/variables/VariableGroupsTable.js";
import { Button } from "~/components/ui/button.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { VARIABLE_GROUPS_LOAD_FAILED_MESSAGE, useVariableGroupsList } from "~/lib/variables.js";

/*
 * `/variables/groups`, the left nav's "Variable groups", with its columns
 * (`VariableGroupsTable.tsx`), "Add variable group" in the header and the
 * empty state ("No variable groups yet"), "Loading variable groups…", and a
 * failed read with "Try again". A row's name opens the group's page
 * (`/variables/groups/{id}`). Under the header, the warning that secrets stay
 * in `${env:NAME}` (a test run uses the organization's values only); below the
 * list, "How variable groups work", as the Variables page's "How variables
 * work". The title is fixed. An organization switch closes the dialogs.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Variable groups - Telflo" }];
}

type OpenDialog = { kind: "add" } | { kind: VariableGroupRowAction; variableGroup: VariableGroup };

export default function VariableGroupsPage() {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  return organizationId === null ? null : <VariableGroupsPageFor key={organizationId} organizationId={organizationId} />;
}

function VariableGroupsPageFor({ organizationId }: { organizationId: string }) {
  const list = useVariableGroupsList();
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

  const groups = list.value;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Overrides of the organization&apos;s values, used by collector groups and pinned collectors.
        </p>
        <Button onClick={(event) => open({ kind: "add" }, event.currentTarget)}>
          <Plus className="h-4 w-4" />
          Add variable group
        </Button>
      </div>

      <SecretsWarning />

      {groups === null ? (
        list.failed ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-12 text-center">
            <p className="mb-3 text-[13px] text-muted-foreground">{VARIABLE_GROUPS_LOAD_FAILED_MESSAGE}</p>
            <Button variant="outline" onClick={list.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" className="rounded-lg border border-border bg-card py-12 text-center text-[13px] text-muted-foreground">
            Loading variable groups…
          </div>
        )
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-12 text-center">
          <Layers className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="mb-3 mt-2 text-[13px] text-muted-foreground">No variable groups yet</p>
          <Button variant="outline" onClick={(event) => open({ kind: "add" }, event.currentTarget)}>
            <Plus className="h-4 w-4" />
            Add variable group
          </Button>
        </div>
      ) : (
        <VariableGroupsTable variableGroups={groups} onAction={(kind, variableGroup, from) => open({ kind, variableGroup }, from)} />
      )}

      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-4">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="text-[13px]">
          <p className="mb-1 font-medium text-foreground">How variable groups work</p>
          <p className="text-muted-foreground">
            A variable group overrides some of your organization&apos;s values, such as one region&apos;s endpoint. A
            collector group uses one in its Edit dialog, and a single collector can be pinned to its own. Each collector
            receives every variable from its pinned variable group, else its collector group&apos;s, else the
            organization&apos;s. A variable the group doesn&apos;t override keeps the organization&apos;s value.
          </p>
        </div>
      </div>

      <VariableGroupDialog
        open={dialogOpen && (dialog?.kind === "add" || dialog?.kind === "edit")}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroup={dialog?.kind === "edit" ? dialog.variableGroup : null}
        onChanged={list.reload}
        onCloseAutoFocus={returnFocus}
      />
      <DeleteVariableGroupDialog
        open={dialogOpen && dialog?.kind === "delete"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variableGroup={dialog?.kind === "delete" ? dialog.variableGroup : null}
        onChanged={list.reload}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
