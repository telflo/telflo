import { useId, type Ref } from "react";
import { ArrowUpDown, Pencil, Trash2 } from "lucide-react";
import { collectorGroupRole, type Collector, type CollectorGroup, type FleetType } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import type { CollectorsListQuery, CollectorsSortColumn } from "~/lib/collectors.js";
import { groupColumnText, KUBERNETES_ROLE_LABELS } from "~/lib/kubernetes-groups.js";
import { CollectorConfigurationCell } from "./CollectorConfigurationCell.js";
import { CollectorStatusCell } from "./CollectorStatusCell.js";
import { LastSeenCell } from "./LastSeenCell.js";
import { PublishedVersionLink } from "./PublishedVersionLink.js";
import { VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A server fleet's collectors grid (D17b-1 decisions 21–23, 27 and 32;
 * Preflight rulings 10 and 17): plain table markup with the fleet list's
 * classes (`FleetsTable`; no @tanstack/react-table, decision 5). In the
 * D17b-1 Parity Notes:
 * - a selection column first (decision 27): a checkbox per row and one in
 *   the header for the page, the selection the tab's;
 * - "Group", "Version" (the version served);
 * - "Variable group" (D20 default 25): the collector's pinned variable group,
 *   else its group's, else "Organization values" (a dash while the groups are
 *   unread and it has no pin), a button opening each variable's value and
 *   where it comes from (`VariableGroupLink`: the pin's override, then the
 *   group's, then the organization's);
 * - Name and Last seen sort, server-side: `aria-sort` on the sorted header
 *   only, none for the API's default (newest first);
 * - Status from the server's `liveness` (Online, Warning, Unknown, Offline:
 *   `CollectorStatusCell`), then a Configuration column (new) from its
 *   `drift` (In sync, Pending pickup, Apply failed, Drifted, Nothing
 *   assigned: `CollectorConfigurationCell`), each a dot and words with its
 *   meaning as tooltip and screen-reader text; Last seen how long ago as
 *   plain text, its full time the tooltip (`LastSeenCell`). D17d-2 Ruling
 *   55 (the owner's Q58): Status had been the drift, the liveness only a dot
 *   beside Last seen, so a collector gone unseen still showed a green "In
 *   sync". Configuration sits after Status, before Version: Status keeps its
 *   place, and the sync sits beside the version it is about;
 * - Version, centred: "{configurationName} @v{n}" linked to the editor
 *   for a published version served (`PublishedVersionLink`, as the Groups
 *   tab's: D17c-1 decisions 7 and 46), "Deleted configuration" for a published
 *   version the platform no longer holds, a dash for nothing served (no
 *   "Imported": D16c removed importing); each form's meaning
 *   (`VERSION_MEANINGS`, D16c Ruling 21: it is what the collector runs,
 *   which a pin or a group's version doesn't change until it is sent) as
 *   tooltip text on a focusable trigger and screen-reader text, as Status,
 *   Configuration and Last seen; the version's one tooltip holds its full
 *   text, then its meaning;
 * - no collector, group or fleet name, IP address or version label in an
 *   attribute (no `title`, no `aria-label`): each row's buttons and checkbox
 *   are named by `aria-labelledby` pointing at hidden text ("Edit {name}",
 *   D17a's `FleetRowActions` pattern), whose ids hold the table's `useId` and
 *   the collector's id; the names are text in the masked shell.
 * A Kubernetes-supervisor fleet's grid (D17d-1 decision 23; Preflight
 * ruling 25; Ruling 66, the owner's Q49): its Group column, where a server
 * fleet's is, shows the role's badge ("Agent", "Cluster" or "Gateway", from
 * the collector's group by `collectorGroupRole`), then a gateway's name (the
 * Agent and the Cluster their badge alone), as the Groups tab; a dash while
 * the groups are unread.
 * The Name button opens the details (`onOpen`), the row actions the edit
 * and delete dialogs (`onEdit`, `onDelete`); the checkboxes the tab's
 * selection, whose bar (`CollectorsSelectionBar`) opens the bulk actions.
 */

const HEAD_BASE_CLASS =
  "h-9 whitespace-nowrap px-3 align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const HEAD_CLASS = `${HEAD_BASE_CLASS} text-left`;
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";
const ACTION_CLASS = "h-7 w-7";

/** What a collector's IP Address column shows: its host's address, else its own, else nothing. */
export function collectorAddress(collector: Collector): string | null {
  return collector.reported.hostIp ?? collector.reported.ip ?? null;
}

const DASH = <span className="text-muted-foreground">—</span>;

/** The Version cell's three forms: a published version served, one of a configuration since deleted, nothing served. */
export type ServedForm = "version" | "deleted" | "nothing";

/** Which form a collector's served state takes. */
export function servedForm(served: Collector["served"]): ServedForm {
  if (served === null) return "nothing";
  return served.version === null ? "deleted" : "version";
}

/**
 * What each form means (D16c Ruling 21): what the collector runs, as the
 * grid's Version tooltip and the details' Effective Version row say it.
 * Fixed words: never a name, label or id (ADR 0024).
 */
export const VERSION_MEANINGS: Record<ServedForm, string> = {
  version: "Running: the last published version it was sent.",
  nothing: "Nothing sent yet: it runs its own file.",
  deleted: "Running a version of a configuration since deleted.",
};

const TRIGGER_FOCUS_CLASS = "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * Version: what was served, its meaning (D16c Ruling 21) as tooltip text and
 * screen-reader text, never a `title` or an `aria-label` (D17b-1 Preflight
 * ruling 10: a tooltip never shows on touch). The "{configurationName} @v{n}"
 * link is the trigger itself (`PublishedVersionLink`: its tooltip the full
 * text, then the meaning), still a link that goes to the editor; its
 * screen-reader copy sits beside it, so the link's name stays the version.
 * The dash and "Deleted configuration" are focusable spans, as Status's and
 * Configuration's, their copy inside.
 */
function VersionCell({ served }: { served: Collector["served"] }) {
  const meaning = VERSION_MEANINGS[servedForm(served)];
  if (served !== null && served.version !== null) {
    return (
      <>
        <PublishedVersionLink version={served.version} meaning={meaning} />
        <span className="sr-only"> ({meaning})</span>
      </>
    );
  }
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className={`${served === null ? "" : "text-[13px] "}text-muted-foreground ${TRIGGER_FOCUS_CLASS}`}>
            {served === null ? "—" : "Deleted configuration"}
            <span className="sr-only"> ({meaning})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {meaning}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface SortHeaderProps {
  column: CollectorsSortColumn;
  label: string;
  query: Pick<CollectorsListQuery, "sort" | "order">;
  onSort: (column: CollectorsSortColumn) => void;
}

/** A sortable header: a ghost button with `ArrowUpDown`; `aria-sort` only while it is the sorted column. */
function SortHeader({ column, label, query, onSort }: SortHeaderProps) {
  const sorted = query.sort === column;
  return (
    <th className={HEAD_CLASS} aria-sort={sorted ? (query.order === "asc" ? "ascending" : "descending") : undefined}>
      <Button
        variant="ghost"
        onClick={() => onSort(column)}
        className="-ml-2 h-7 px-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em]"
      >
        {label}
        <ArrowUpDown className="ml-1 h-3 w-3" aria-hidden="true" />
      </Button>
    </th>
  );
}

export interface CollectorsTableProps {
  collectors: Collector[];
  /** The fleet's groups, for the Group column; null while none has been read (a dash). */
  groups: CollectorGroup[] | null;
  /** The sort shown. */
  query: Pick<CollectorsListQuery, "sort" | "order">;
  onSort: (column: CollectorsSortColumn) => void;
  /** The time Last seen is reckoned at: the tab's render. */
  now: number;
  /** The selected collectors' ids (on this page). */
  selected: ReadonlySet<string>;
  /** Selects or deselects one collector. */
  onSelect: (collectorId: string, selected: boolean) => void;
  /** Selects every collector on the page, or none. */
  onSelectAll: (selected: boolean) => void;
  /** The Name button: the details; `from` the button, where the focus goes back as they close. */
  onOpen?: (collector: Collector, from: HTMLElement) => void;
  /** The row's "Edit collector": the edit dialog. */
  onEdit?: (collector: Collector, from: HTMLElement) => void;
  /** The row's "Delete collector record": the delete dialog. */
  onDelete?: (collector: Collector, from: HTMLElement) => void;
  /** The first row's Name button: where the focus goes when a dialog's row is gone. */
  firstNameRef?: Ref<HTMLButtonElement> | undefined;
  /** The fleet's type: a Kubernetes fleet's Group column shows the role's badge, then a gateway's name. */
  fleetType?: FleetType;
}

export function CollectorsTable({
  collectors,
  groups,
  query,
  onSort,
  now,
  selected,
  onSelect,
  onSelectAll,
  onOpen,
  onEdit,
  onDelete,
  firstNameRef,
  fleetType = "server",
}: CollectorsTableProps) {
  const idPrefix = useId();
  const kubernetes = fleetType === "kubernetes-supervisor";
  const groupsById = new Map((groups ?? []).map((group) => [group.id, group]));
  const selectedCount = collectors.filter((collector) => selected.has(collector.id)).length;
  const allSelected = collectors.length > 0 && selectedCount === collectors.length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={`${HEAD_CLASS} w-10`}>
                <Checkbox
                  aria-label="Select all on this page"
                  checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
                  onCheckedChange={(checked) => onSelectAll(checked === true)}
                />
              </th>
              <SortHeader column="name" label="Name" query={query} onSort={onSort} />
              <th className={HEAD_CLASS}>IP Address</th>
              <th className={HEAD_CLASS}>Group</th>
              <th className={HEAD_CLASS}>Variable group</th>
              <th className={HEAD_CLASS}>Status</th>
              <th className={HEAD_CLASS}>Configuration</th>
              <th className={`${HEAD_BASE_CLASS} text-center`}>Version</th>
              <SortHeader column="lastSeen" label="Last seen" query={query} onSort={onSort} />
              <th className={HEAD_CLASS}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {collectors.map((collector, index) => {
              const rowId = `${idPrefix}-collector-${collector.id}`;
              const address = collectorAddress(collector);
              const group = groupsById.get(collector.groupId);
              const groupName = group === undefined ? null : groupColumnText(group, fleetType);
              const role = group === undefined ? null : collectorGroupRole(group, fleetType);
              return (
                <tr key={collector.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <span id={`${rowId}-select`} className="sr-only" hidden>
                      Select {collector.name}
                    </span>
                    <Checkbox
                      aria-labelledby={`${rowId}-select`}
                      checked={selected.has(collector.id)}
                      onCheckedChange={(checked) => onSelect(collector.id, checked === true)}
                    />
                  </td>
                  <td className={CELL_CLASS}>
                    <button
                      ref={index === 0 ? firstNameRef : undefined}
                      type="button"
                      onClick={(event) => onOpen?.(collector, event.currentTarget)}
                      className="text-[13px] font-medium text-brand hover:underline focus:underline focus:outline-none"
                      title="View collector details"
                    >
                      {collector.name}
                    </button>
                  </td>
                  <td className={CELL_CLASS}>
                    {address === null ? DASH : <span className="font-mono text-xs text-foreground">{address}</span>}
                  </td>
                  <td className={CELL_CLASS}>
                    {kubernetes && role !== null ? (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline">{KUBERNETES_ROLE_LABELS[role]}</Badge>
                        {role === "gateway" && groupName !== null && (
                          <>
                            {" "}
                            <span className="text-[13px] text-foreground">{groupName}</span>
                          </>
                        )}
                      </div>
                    ) : groupName === null ? (
                      DASH
                    ) : (
                      <span className="text-[13px] text-foreground">{groupName}</span>
                    )}
                  </td>
                  <td className={CELL_CLASS}>
                    <VariableGroupLink
                      pinnedVariableGroupId={collector.pinnedVariableGroupId}
                      groupVariableGroupId={group === undefined ? undefined : group.variableGroupId}
                    />
                  </td>
                  <td className={CELL_CLASS}>
                    <CollectorStatusCell liveness={collector.liveness} />
                  </td>
                  <td className={CELL_CLASS}>
                    <CollectorConfigurationCell drift={collector.drift} />
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="text-center">
                      <VersionCell served={collector.served} />
                    </div>
                  </td>
                  <td className={CELL_CLASS}>
                    <LastSeenCell lastSeenAt={collector.lastSeenAt} now={now} />
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="flex items-center justify-end gap-1">
                      <span id={`${rowId}-edit`} className="sr-only" hidden>
                        Edit {collector.name}
                      </span>
                      <span id={`${rowId}-delete`} className="sr-only" hidden>
                        Delete {collector.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`${ACTION_CLASS} text-muted-foreground hover:text-foreground`}
                        title="Edit collector"
                        aria-labelledby={`${rowId}-edit`}
                        onClick={(event) => onEdit?.(collector, event.currentTarget)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`${ACTION_CLASS} text-fail hover:bg-fail-soft hover:text-fail`}
                        title="Delete collector record"
                        aria-labelledby={`${rowId}-delete`}
                        onClick={(event) => onDelete?.(collector, event.currentTarget)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
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
