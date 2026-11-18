import { useEffect, useRef, useState } from "react";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import type { FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { GROUPS_LOAD_FAILED_MESSAGE, useGroupsTab } from "~/lib/groups.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { kubernetesGroupRows, type KubernetesGroupRow } from "~/lib/kubernetes-groups.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { DeleteGroupDialog } from "./DeleteGroupDialog.js";
import { KubernetesGroupDetailsDialog } from "./KubernetesGroupDetailsDialog.js";
import { KubernetesGroupDialog, type KubernetesGroupTarget } from "./KubernetesGroupDialog.js";
import { KubernetesGroupsTable, type KubernetesRowAction } from "./KubernetesGroupsTable.js";

/*
 * A Kubernetes-supervisor fleet's Groups tab (D17d-1 decisions 3, 6, 10, 24
 * and 25; Preflight rulings 22–24, 30–35), beside D17b-2's server
 * `GroupsTab` (untouched), over the same `useGroupsTab` (the fleet's groups,
 * one read a poll, every 15 s while the tab is visible and no dialog is
 * open). Mounted only while the tab is chosen, keyed by the fleet.
 * Per the D17d-1 Parity Notes:
 *
 * - The intro in the spec's words (decision 24), "Add gateway" and
 *   "Refresh groups"; the states as the server tab's ("Loading groups…",
 *   "Failed to load groups" with "Try again"; never empty: the Agent is the
 *   fleet's Default group and the Cluster's row is drawn before its group
 *   exists).
 * - The table (`KubernetesGroupsTable`): Agent, Cluster, the gateway pools.
 *   A row's More opens its details (`KubernetesGroupDetailsDialog`); a row's
 *   Assign or Edit, or "Add gateway", the group dialog
 *   (`KubernetesGroupDialog`: the Cluster's Assign before its group exists
 *   creates it); a gateway's Delete the typed-name delete
 *   (`DeleteGroupDialog`, with the Helm release's words). One dialog at a
 *   time, for the organization it was opened in: another organization closes
 *   it, and its late answer is dropped. Each dialog takes the row as it was
 *   at the opening (D17c-1 Ruling 66).
 * - After a write (or a 404, an unknown outcome, or a refusal that found
 *   the groups changed) the tab reads its groups again and the route its
 *   fleet (`onFleetChanged`).
 * - A row's Install (D17d-2 decision 23; Preflight ruling 28) opens the
 *   route's Helm install dialog for the row's group (`onInstall`), absent
 *   on an archived fleet; the route moves `groupsChanged` when the groups
 *   changed outside the tab, and the tab reads them again.
 *
 * Every dialog's close gives the focus back to the control that opened it
 * (`useReturnFocus`, D17b-2 Preflight ruling 14); when that control is gone
 * (its row deleted), to the first row's Assign or Edit (the Agent's), else
 * to "Refresh groups".
 */

export const KUBERNETES_GROUPS_INTRO =
  "Each group is a Helm-installed collector workload: Agent runs one collector on each node, Cluster one pod for cluster-wide metrics, and each gateway pool a set of collectors that receive telemetry from the others. Collectors pick up their group's published version on their next poll.";

interface KubernetesGroupsTabProps {
  fleet: FleetDetail;
  /** The route's `useFleet().reload`: a groups read that finds the fleet gone shows "Fleet not found". */
  onFleetGone: () => void;
  /** The route's `useFleet().reload` again: after a group's write, the strip and the Collectors tab follow. */
  onFleetChanged: () => void;
  /** A row's Install (an active fleet only, D17d-2 decision 23): the route's Helm install dialog for the row's group. */
  onInstall?: ((row: KubernetesGroupRow, from: HTMLElement) => void) | undefined;
  /** A count the route moves when the groups changed elsewhere (the Helm dialog found its group gone): the tab reads them again. */
  groupsChanged?: number | undefined;
}

/** The dialog asked for, its row (null: Add gateway), and the organization it was opened in. */
interface RowAction {
  kind: KubernetesRowAction | "add";
  row: KubernetesGroupRow | null;
  organizationId: string;
}

/** The sign-up prompt's words for each Kubernetes group action in the playground. */
export const KUBERNETES_GROUP_LOCKED_WORDS: Record<Exclude<RowAction["kind"], "more">, string> = {
  add: "add a gateway to your own cluster",
  edit: "edit a collector group",
  delete: "delete a collector group",
};

export function KubernetesGroupsTab({ fleet, onFleetGone, onFleetChanged, onInstall, groupsChanged = 0 }: KubernetesGroupsTabProps) {
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

  const focus = useReturnFocus();
  const firstAction = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const fallback = () => firstAction.current ?? refreshButton.current;
  useEffect(() => focus.rowsChanged(rowsRead), [groups, rowsRead, focus]);

  const [action, setAction] = useState<RowAction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  if (actionOpen && action !== null && action.organizationId !== organizationId) setActionOpen(false);
  const locked = useLockedAction();
  const openAction = (kind: RowAction["kind"], row: KubernetesGroupRow | null, from: HTMLElement) => {
    if (organizationId === null) return;
    // In the playground (D31-1 decisions 24 and 35) a group's details open (a read); adding, editing and deleting are locked.
    if (locked !== null && kind !== "more") {
      locked(KUBERNETES_GROUP_LOCKED_WORDS[kind], from);
      return;
    }
    focus.opened(from, fallback);
    setAction({ kind, row, organizationId });
    setActionOpen(true);
  };

  const changed = () => {
    focus.wrote(tab.latestRead());
    tab.reload();
    onFleetChanged();
  };

  const kind = actionOpen ? action?.kind : undefined;
  const target: KubernetesGroupTarget | null =
    action?.kind === "add" ? { role: "gateway", group: null } : action?.kind === "edit" && action.row !== null ? action.row : null;
  return (
    <section>
      <div className="flex items-start justify-between gap-4 pb-3">
        <p className="text-xs text-muted-foreground">{KUBERNETES_GROUPS_INTRO}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button ref={refreshButton} variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={tab.reload} aria-label="Refresh groups">
            <RefreshCw className={`h-4 w-4 ${tab.personsRead ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" onClick={(event) => openAction("add", null, event.currentTarget)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Add gateway
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
        <KubernetesGroupsTable
          rows={kubernetesGroupRows(groups)}
          firstActionRef={firstAction}
          onAction={(each, row, from) => openAction(each, row, from)}
          onInstall={onInstall}
        />
      )}
      <KubernetesGroupDetailsDialog
        open={kind === "more"}
        onOpenChange={setActionOpen}
        row={action?.kind === "more" ? action.row : null}
        onCloseAutoFocus={focus.returnFocus}
      />
      {/* The group dialog and the delete take the current organization: an answer for an earlier one is dropped (useStillCurrent). */}
      <KubernetesGroupDialog
        open={kind === "add" || kind === "edit"}
        onOpenChange={setActionOpen}
        target={target}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <DeleteGroupDialog
        open={kind === "delete"}
        onOpenChange={setActionOpen}
        group={action?.kind === "delete" ? (action.row?.group ?? null) : null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        onDeleted={changed}
        onCloseAutoFocus={focus.returnFocus}
        fleetType="kubernetes-supervisor"
      />
    </section>
  );
}
