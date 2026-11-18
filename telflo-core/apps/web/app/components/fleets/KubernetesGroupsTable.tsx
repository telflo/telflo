import { useId, type Ref } from "react";
import { COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE, gatewayNameProblem, type KubernetesRole } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { HelpPopover } from "~/components/ui/help-popover.js";
import {
  KUBERNETES_ROLE_LABELS,
  kubernetesRowKey,
  kubernetesRowName,
  kubernetesSettingsOf,
  type KubernetesGroupRow,
} from "~/lib/kubernetes-groups.js";
import { INSTALL_NEEDS_VERSION, installDisabledReason, isUnassigned, PublishedVersionCell, RowInstallButton } from "./GroupsTable.js";
import { VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A Kubernetes fleet's groups (D17d-1 decisions 6 and 24; Preflight rulings
 * 23, 24, 34 and 35) as plain table markup with the fleet screens' classes
 * (D17b-2's `GroupsTable`). Per the D17d-1 Parity Notes:
 *
 * - The rows (`kubernetesGroupRows`): the Agent (the fleet's Default group),
 *   the Cluster (its group, or none before its first Assign), then the
 *   gateway pools in the API's order. A row's role is the contracts'
 *   `collectorGroupRole` (never the stored `kubernetes.role`), so settings
 *   Telflo can't read never hide one.
 * - Columns: **Group**, one column (Ruling 66, the owner's Q49: separate Role
 *   and Group columns read as a group within a group): the role's badge and
 *   its help popover (its trigger's label fixed words "What is an Agent?",
 *   "What is a Cluster?", "What is a Gateway?", since `HelpPopover` puts it
 *   in an `aria-label` and a `title`; the Cluster's text says the chart's
 *   StatefulSet), then a gateway's name (the Agent and the Cluster their
 *   badge alone), **Namespace**, **Published version** (D17b-2's cell;
 *   "Nothing assigned" for the Cluster before its group exists), **Variable
 *   group** (D20 default 25: the group's variable group, else "Organization
 *   values", opening each variable's value: `VariableGroupLink`), **Volumes**
 *   (a count), **Replicas** (a gateway's, "—" otherwise), **More** (the row's
 *   details), and the row's actions: **Assign** (nothing assigned, or no
 *   group yet) or **Edit**, and **Delete** on a gateway only (decision 6: the
 *   Agent and the Cluster are never deleted). Settings none saved, or Telflo
 *   can't read, show "—".
 * - D17d-2 (decision 23; Preflight rulings 26 and 28): a row's **Install**
 *   (an active fleet's: `onInstall`), before Assign or Edit as a server
 *   fleet's (`RowInstallButton`), opening the Helm install dialog for the
 *   row's group, named "Install {name}"; disabled with its reason
 *   (`kubernetesInstallDisabledReason`): nothing assigned or the Cluster
 *   before its group exists ("Assign a published version first."), a
 *   deleted configuration's version, settings Telflo can't read (a gateway
 *   whose name isn't one among them, as the facts' 409 says: Ruling 44).
 * - "More about {name}", `Assign {name}`, `Edit {name}` and `Delete {name}`
 *   (the name Agent, Cluster or the gateway's) through `aria-labelledby`
 *   pointing at hidden text (D17a's `FleetRowActions` pattern): the ids hold
 *   the table's `useId` and the group's id or the Cluster's role, never a
 *   name. A gateway's name and a namespace are text in the masked shell only
 *   (D17d-1's paragraph of ADR 0024).
 */

export const KUBERNETES_ROLE_HELP: Record<KubernetesRole, string> = {
  node: "Runs as a DaemonSet: one collector on each node. Collects node-local telemetry such as host metrics and container and pod logs, and data from the workloads on that node.",
  cluster:
    "Runs as a single-replica StatefulSet: one collector for the cluster. Collects cluster-wide telemetry such as Kubernetes events and cluster-level metrics.",
  gateway: "A pool of collectors that receive telemetry from the Agent and Cluster collectors, then process it and export it to your backends.",
};

/** The help popover's label (an `aria-label` and a `title`): fixed words, never a name. */
export const KUBERNETES_ROLE_HELP_LABELS: Record<KubernetesRole, string> = {
  node: "What is an Agent?",
  cluster: "What is a Cluster?",
  gateway: "What is a Gateway?",
};

const HEAD_BASE_CLASS =
  "h-9 whitespace-nowrap px-3 align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const HEAD_CLASS = `${HEAD_BASE_CLASS} text-left`;
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";
const DASH = <span className="text-muted-foreground">—</span>;

/** What a row's button asks for: the tab opens the dialog. */
export type KubernetesRowAction = "more" | "edit" | "delete";

/**
 * Why a row's group has no Helm install, or null when it has one (D17d-2
 * decision 23; Preflight rulings 3 and 26): the Cluster before its group
 * exists and a group with nothing assigned need a published version, a
 * deleted configuration's version another one (the server group's words),
 * and settings the platform can't read (unreadable, a stored role that
 * isn't the row's, a Cluster or a gateway without any, a gateway whose name
 * fails `gatewayNameProblem`: written around the platform) the facts' 409
 * words (`helmFactsOf`'s). The Helm dialog's Group select and the row's
 * Install.
 */
export function kubernetesInstallDisabledReason(row: KubernetesGroupRow): string | null {
  if (row.group === null) return INSTALL_NEEDS_VERSION;
  const reason = installDisabledReason(row.group);
  if (reason !== null) return reason;
  const { readable, kubernetes } = kubernetesSettingsOf(row.group);
  const unreadable =
    !readable ||
    (kubernetes === null ? row.role !== "node" : kubernetes.role !== row.role) ||
    (row.role === "gateway" && gatewayNameProblem(row.group.name) !== null);
  return unreadable ? COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE : null;
}

export interface KubernetesGroupsTableProps {
  rows: readonly KubernetesGroupRow[];
  /** A row's More, Assign or Edit, or Delete; `from` the button pressed, where the focus goes back as its dialog closes. */
  onAction: (action: KubernetesRowAction, row: KubernetesGroupRow, from: HTMLElement) => void;
  /** The first row's Assign or Edit (the Agent's): where the focus goes when a dialog's opener is gone. */
  firstActionRef?: Ref<HTMLButtonElement> | undefined;
  /** A row's Install (an active fleet only): the route's Helm install dialog for the row's group; `from` the button pressed. */
  onInstall?: ((row: KubernetesGroupRow, from: HTMLElement) => void) | undefined;
}

export function KubernetesGroupsTable({ rows, onAction, firstActionRef, onInstall }: KubernetesGroupsTableProps) {
  const idPrefix = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Group</th>
              <th className={HEAD_CLASS}>Namespace</th>
              <th className={HEAD_CLASS}>Published version</th>
              <th className={HEAD_CLASS}>Variable group</th>
              <th className={HEAD_CLASS}>Volumes</th>
              <th className={HEAD_CLASS}>Replicas</th>
              <th className={`${HEAD_BASE_CLASS} text-center`}>More</th>
              <th className={HEAD_CLASS}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {rows.map((row, index) => {
              const rowId = `${idPrefix}-row-${kubernetesRowKey(row)}`;
              const settings = kubernetesSettingsOf(row.group).kubernetes;
              const unassigned = row.group === null || isUnassigned(row.group);
              const name = kubernetesRowName(row);
              return (
                <tr key={kubernetesRowKey(row)} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline">{KUBERNETES_ROLE_LABELS[row.role]}</Badge>
                      <HelpPopover
                        label={KUBERNETES_ROLE_HELP_LABELS[row.role]}
                        title={KUBERNETES_ROLE_LABELS[row.role]}
                        triggerClassName="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        iconClassName="h-3.5 w-3.5"
                      >
                        <p>{KUBERNETES_ROLE_HELP[row.role]}</p>
                      </HelpPopover>
                      {row.role === "gateway" && row.group !== null && (
                        <>
                          {" "}
                          <span className="ml-1 font-medium">{row.group.name}</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className={`${CELL_CLASS} font-mono text-xs`}>{settings === null ? DASH : settings.namespace}</td>
                  <td className={CELL_CLASS}>
                    <PublishedVersionCell group={row.group} />
                  </td>
                  <td className={CELL_CLASS}>
                    <VariableGroupLink groupVariableGroupId={row.group?.variableGroupId ?? null} />
                  </td>
                  <td className={CELL_CLASS}>{settings === null ? DASH : settings.volumes.length}</td>
                  <td className={CELL_CLASS}>{row.role === "gateway" && settings?.replicas !== undefined ? settings.replicas : DASH}</td>
                  <td className={`${CELL_CLASS} text-center`}>
                    <span id={`${rowId}-more`} className="sr-only" hidden>
                      More about {name}
                    </span>
                    <button
                      type="button"
                      aria-labelledby={`${rowId}-more`}
                      onClick={(event) => onAction("more", row, event.currentTarget)}
                      className="text-[13px] font-medium text-brand hover:underline focus:underline focus:outline-none"
                    >
                      More
                    </button>
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex justify-end gap-2">
                      {onInstall !== undefined && (
                        <RowInstallButton
                          rowId={rowId}
                          label={`Install ${name}`}
                          reason={kubernetesInstallDisabledReason(row)}
                          onInstall={(from) => onInstall(row, from)}
                        />
                      )}
                      <span id={`${rowId}-edit`} className="sr-only" hidden>
                        {unassigned ? "Assign" : "Edit"} {name}
                      </span>
                      <Button
                        ref={index === 0 ? firstActionRef : undefined}
                        type="button"
                        size="sm"
                        variant={unassigned ? "default" : "outline"}
                        aria-labelledby={`${rowId}-edit`}
                        onClick={(event) => onAction("edit", row, event.currentTarget)}
                      >
                        {unassigned ? "Assign" : "Edit"}
                      </Button>
                      {row.role === "gateway" && row.group !== null && (
                        <>
                          <span id={`${rowId}-delete`} className="sr-only" hidden>
                            Delete {name}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                            aria-labelledby={`${rowId}-delete`}
                            onClick={(event) => onAction("delete", row, event.currentTarget)}
                          >
                            Delete
                          </Button>
                        </>
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
  );
}
