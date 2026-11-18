import { useEffect, useRef, useState } from "react";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import type { CollectorGroup, FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { GROUPS_LOAD_FAILED_MESSAGE, useGroupsTab } from "~/lib/groups.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { DeleteGroupDialog } from "./DeleteGroupDialog.js";
import { GroupDetailsDialog } from "./GroupDetailsDialog.js";
import { GroupDialog } from "./GroupDialog.js";
import { GroupsTable, type GroupRowAction } from "./GroupsTable.js";

/*
 * A server fleet's Groups tab (D17b-2 decisions 9, 10, 14, 22–25, 32–34;
 * Preflight rulings 8, 10, 11, 14 and 15): its intro, its "New group" button
 * and its table, over `useGroupsTab` (the fleet's groups, polled every 15 s
 * while the tab is visible and no dialog is open). Mounted only while the tab
 * is chosen (Radix Tabs unmounts the others), keyed by the fleet.
 * Per the D17b-2 Parity Notes:
 *
 * - The intro and "New group" in the spec's words (decision 6); a refresh
 *   button ("Refresh groups", spinning while a person's read is under way).
 * - States: "Loading groups…"; a failed first load ("Failed to load
 *   groups") with "Try again"; never empty (Default always exists).
 * - A row's More opens its details (`GroupDetailsDialog`); "New group", a
 *   row's Assign or Edit the group dialog (`GroupDialog`); a row's Delete
 *   the delete (`DeleteGroupDialog`). One dialog at a time, for the
 *   organization it was opened in: another organization (a switch, or a
 *   removal elsewhere) closes it, and its late answer is dropped.
 * - After a write (or a 404, or an unknown outcome) the tab reads its groups
 *   again and the route its fleet (`onFleetChanged`: the strip and the
 *   Collectors tab's next read follow).
 * - A row's Install opens the route's install dialog (D17c-1 decision 44:
 *   one dialog for the page, `onInstall`), absent on an archived fleet; the
 *   route moves `groupsChanged` after an assignment made outside the tab,
 *   and the tab reads its groups again.
 * - An archived fleet's groups stay editable (Preflight ruling 8: the API
 *   allows it; its collectors are refused anyway until it is unarchived).
 *
 * Every dialog's close gives the focus back to the control that opened it
 * (`useReturnFocus`, Preflight ruling 14): the row's More, Assign or Edit, or
 * Delete, or "New group". When that control is gone (its row deleted), the
 * focus goes to the first row's Assign or Edit, else to "Refresh groups". A
 * write's reload that removes the row the focus went back to moves it on
 * the same way; rows from a read begun before the write leave that to the
 * reload.
 */

export const GROUPS_INTRO =
  "A group gives its collectors one published version. Collectors join a group when they are installed into it or moved to it; a collector pinned to a version keeps its pin. Add groups to run different configurations in one fleet, e.g.";

interface GroupsTabProps {
  fleet: FleetDetail;
  /** The route's `useFleet().reload`: a groups read that finds the fleet gone shows "Fleet not found". */
  onFleetGone: () => void;
  /** The route's `useFleet().reload` again: after a group's write, the strip and the Collectors tab follow. */
  onFleetChanged: () => void;
  /** A row's Install (an active fleet only, D17c-1 decision 44): the route's install dialog for the group. */
  onInstall?: ((group: CollectorGroup, from: HTMLElement) => void) | undefined;
  /** A count the route moves when the groups changed elsewhere (the install dialog's or the checklist's Assign): the tab reads them again. */
  groupsChanged?: number | undefined;
}

/** The dialog asked for, its group (null: a new one), and the organization it was opened in. */
interface GroupAction {
  kind: GroupRowAction | "create";
  group: CollectorGroup | null;
  organizationId: string;
}

/** The sign-up prompt's words for each group action in the playground. */
export const GROUP_LOCKED_WORDS: Record<Exclude<GroupAction["kind"], "more">, string> = {
  create: "create a collector group",
  edit: "edit a collector group",
  delete: "delete a collector group",
};

export function GroupsTab({ fleet, onFleetGone, onFleetChanged, onInstall, groupsChanged = 0 }: GroupsTabProps) {
  const tab = useGroupsTab(fleet.id, { onFleetGone });
  const { groups, rowsRead } = tab;

  // The groups changed elsewhere: read again (a person's read). Not on the first render.
  const seenChange = useRef(groupsChanged);
  const { reload } = tab;
  useEffect(() => {
    if (seenChange.current === groupsChanged) return;
    seenChange.current = groupsChanged;
    reload();
  }, [groupsChanged, reload]);
  const organizationId = useCurrentUser()?.organization.id ?? null;

  // Focus back to each dialog's opener, else the first row's Assign or Edit, else Refresh (Preflight ruling 14).
  const focus = useReturnFocus();
  const firstAction = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const fallback = () => firstAction.current ?? refreshButton.current;
  // The rows with their read's number: rows from a read begun before a write never spend it before the close.
  useEffect(() => focus.rowsChanged(rowsRead), [groups, rowsRead, focus]);

  // The dialog open, in the organization it was opened in; another organization closes it.
  const [action, setAction] = useState<GroupAction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  if (actionOpen && action !== null && action.organizationId !== organizationId) setActionOpen(false);
  const locked = useLockedAction();
  const openAction = (kind: GroupAction["kind"], group: CollectorGroup | null, from: HTMLElement) => {
    if (organizationId === null) return;
    // In the playground (D31-1 decisions 24 and 35) a group's details open (a read); its create, edit and delete are locked.
    if (locked !== null && kind !== "more") {
      locked(GROUP_LOCKED_WORDS[kind], from);
      return;
    }
    focus.opened(from, fallback);
    setAction({ kind, group, organizationId });
    setActionOpen(true);
  };

  // A write (or a 404, or an unknown outcome): its reload may take the row the focus went back to.
  // The latest read is taken before the reload begins: the reload's, and any later read's, are numbered above it.
  const changed = () => {
    focus.wrote(tab.latestRead());
    tab.reload();
    onFleetChanged();
  };

  const kind = actionOpen ? action?.kind : undefined;
  return (
    <section>
      <div className="flex items-start justify-between gap-4 pb-3">
        <p className="text-xs text-muted-foreground">
          {GROUPS_INTRO} <span className="font-mono">web-hosts</span> and <span className="font-mono">db-hosts</span>.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            ref={refreshButton}
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={tab.reload}
            aria-label="Refresh groups"
          >
            <RefreshCw className={`h-4 w-4 ${tab.personsRead ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" onClick={(event) => openAction("create", null, event.currentTarget)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            New group
          </Button>
        </div>
      </div>
      {tab.failed ? (
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
          <AlertCircle className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">{GROUPS_LOAD_FAILED_MESSAGE}</p>
          <Button variant="outline" onClick={tab.reload}>
            Try again
          </Button>
        </div>
      ) : groups === null ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading groups…
          </p>
        </div>
      ) : (
        <GroupsTable
          groups={groups}
          firstActionRef={firstAction}
          onAction={(each, group, from) => openAction(each, group, from)}
          onInstall={onInstall}
        />
      )}
      <GroupDetailsDialog
        open={kind === "more"}
        onOpenChange={setActionOpen}
        group={action?.kind === "more" ? action.group : null}
        onCloseAutoFocus={focus.returnFocus}
      />
      {/* The group dialog and the delete take the current organization: an answer for an earlier one is dropped (useStillCurrent). */}
      <GroupDialog
        open={kind === "create" || kind === "edit"}
        onOpenChange={setActionOpen}
        group={action?.kind === "edit" ? action.group : null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <DeleteGroupDialog
        open={kind === "delete"}
        onOpenChange={setActionOpen}
        group={action?.kind === "delete" ? action.group : null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onDeleted={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
    </section>
  );
}
