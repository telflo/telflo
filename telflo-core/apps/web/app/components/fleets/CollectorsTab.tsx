import { useEffect, useRef, useState } from "react";
import { AlertCircle, TerminalSquare } from "lucide-react";
import type { Collector, FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { COLLECTORS_LOAD_FAILED_MESSAGE, useCollectorsPage, type CollectorsListQuery } from "~/lib/collectors.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { BulkDeleteDialog } from "./BulkDeleteDialog.js";
import { BulkMoveDialog } from "./BulkMoveDialog.js";
import { BulkPinDialog } from "./BulkPinDialog.js";
import { CollectorDetailsDialog } from "./CollectorDetailsDialog.js";
import { CollectorsPager } from "./CollectorsPager.js";
import { CollectorsSelectionBar } from "./CollectorsSelectionBar.js";
import { CollectorsTable } from "./CollectorsTable.js";
import { CollectorsToolbar } from "./CollectorsToolbar.js";
import { DeleteCollectorDialog } from "./DeleteCollectorDialog.js";
import { EditCollectorDialog } from "./EditCollectorDialog.js";

/*
 * A server fleet's Collectors tab: a toolbar, grid, pager and empty
 * states, over `useCollectorsPage` (one page at a time, polled every 15 s
 * while the tab is visible and no dialog is open). Mounted only while the
 * tab is chosen (Radix Tabs unmounts the others), keyed by the fleet.
 *
 * States: "Loading collectors…"; a failed first load, with "Try again"; an
 * empty fleet (page 1 empty, nothing searched or filtered): the install state
 * ("Install your first collector") until installing started in this visit
 * (`installStarted`, the route's), then its waiting state with the help
 * "Collector not showing up?"; "Install collector" (`onInstall`, the install
 * dialog for the Default group) one element across both, so the focus stays on
 * it; an archived fleet's words instead (no install); a search matching
 * nothing; a group with none. The hook steps an empty page other than the
 * first back, so only page 1 is ever empty here.
 *
 * The selection is the tab's: the ids of collectors on the page shown,
 * cleared when the page or the query changes (a page change, a search, a
 * filter, a sort, an emptied page stepped back), and kept across a poll for
 * the rows still shown. With one or more selected, its bar
 * (`CollectorsSelectionBar`) opens bulk pin, bulk move and bulk delete
 * (`BulkPinDialog`, `BulkMoveDialog`, `BulkDeleteDialog`) for the
 * collectors selected when it opened, in the organization it was opened in,
 * closed by another as the details are; Move to group is disabled while the
 * tab holds no groups.
 *
 * A Kubernetes-supervisor fleet's tab is the same tab, every part told the
 * fleet's type (`fleetType`): the grid's Role column and the Group column's
 * dash for Agent and Cluster, the Agent's and the Cluster's names in the Group
 * filter, the edit's Group select and bulk move (ordered Agent, Cluster, then
 * the gateways), the details' Node row, the pins' canary note and the deletes'
 * words. Its empty fleet shows the waiting state at once, its help always
 * there, in Kubernetes words, and "Install with Helm" (the route's Helm
 * install dialog, `onInstall`).
 *
 * A row's Name opens its details (`CollectorDetailsDialog`),
 * for the organization it was opened in: another organization (a switch,
 * or a removal elsewhere) closes them, as the fleet's dialogs
 * (`useFleetActionDialogs`). The polls pause while they are open (an open
 * dialog pauses `useVisiblePolling`).
 *
 * A row's Edit and the details' "Edit collector" open the edit dialog
 * (`EditCollectorDialog`), a row's Delete the delete
 * (`DeleteCollectorDialog`), one at a time, for the organization they were
 * opened in, closed by another as the details are. After a write (or a
 * 404, or an answer that leaves one unknown, or a bulk move's or delete's
 * run, closed) the tab reads its page again and the route its fleet
 * (`onFleetChanged`), so the strip and the total follow at once.
 *
 * Every dialog's close gives the focus back to the control that opened it
 * (`useReturnFocus`): the row's Name, Edit or Delete, the selection bar's
 * button; the details' "Edit collector" hands the row's Name on to the edit.
 * When that control is gone, its row deleted, the focus goes to the grid's
 * first Name, else the search box; after a bulk action, to the selection
 * bar, else the search box. A write's reload that removes the row the focus
 * went back to moves it on the same way; a poll after a close with no write
 * never moves it.
 *
 * In the playground the details open (a read), and every write is locked
 * at its opener (`openAction`, `openBulk`): the sign-up prompt opens with
 * the action's words, and no dialog does.
 */

/** The sign-up prompt's words for each collector action in the playground. */
export const COLLECTOR_LOCKED_WORDS = {
  edit: "edit a collector",
  delete: "delete a collector",
  pin: "pin collectors to a version",
  move: "move collectors to another group",
  bulkDelete: "delete collectors",
} as const;

const NO_SELECTION: ReadonlySet<string> = new Set();

/** What the selection is kept for: the page and the query of the rows shown. */
function selectionKey(query: CollectorsListQuery, pageIndex: number): string {
  return JSON.stringify([pageIndex, query.q, query.groupId, query.sort, query.order]);
}

/** The empty fleet's states' words. */
export const INSTALL_FIRST_TITLE = "Install your first collector";
export const INSTALL_FIRST_DETAIL = "Run one copy-paste command on a host; the collector connects with this fleet's token and appears here.";
export const WAITING_TITLE = "Waiting for your first collector to connect";
export const WAITING_DETAIL = "It appears here the moment it checks in. This list refreshes automatically every 15 seconds.";
export const ARCHIVED_INSTALL_WORDS = "This fleet is archived: unarchive it to install collectors.";
export const NOT_SHOWING_UP = "Collector not showing up?";
export const NOT_SHOWING_UP_TIPS = [
  "The host must reach the endpoint shown in the install command.",
  "Linux: export OPAMP_TOKEN before running start_supervisor.sh (copy it again from the install dialog).",
  "Container: docker logs telflo-collector shows the supervisor's output.",
  "A command naming a group that has since been deleted is refused: copy a new one.",
  // A second `docker run` on the same host fails on the command's fixed --name.
  "Re-installing on a container host: remove the old container first (docker rm -f telflo-collector); keep the telflo-opamp volume to keep the same collector.",
] as const;

/** A Kubernetes fleet's empty tab, beside "Install with Helm". */
export const KUBERNETES_WAITING_DETAIL =
  "Each pod a group's Helm release starts appears here when it checks in with this fleet's token. This list refreshes automatically every 15 seconds.";
/** The command a Kubernetes tip names, in monospace as the server tip's `docker logs`. */
const KUBECTL_LOGS = "kubectl logs";
export const KUBERNETES_NOT_SHOWING_UP_TIPS = [
  "The pod must reach the fleet's endpoint: kubectl logs on the pod shows the supervisor's output.",
  "Each collector names its group (COLLECTOR_GROUP_ID): one naming no group, or a group that has since been deleted, is refused.",
] as const;

interface CollectorsTabProps {
  fleet: FleetDetail;
  /** Whether a reveal or a download succeeded in this visit (the route's): the empty fleet's waiting state. */
  installStarted: boolean;
  /**
   * "Install collector" on an empty active fleet: the route's install dialog for the Default group; a Kubernetes fleet's
   * "Install with Helm", its Helm install dialog. `from` the button pressed.
   */
  onInstall: (from: HTMLElement) => void;
  /** The route's `useFleet().reload`: a collectors read that finds the fleet gone shows "Fleet not found". */
  onFleetGone: () => void;
  /** The route's `useFleet().reload` again: after a collector's write, the strip and the total follow. */
  onFleetChanged: () => void;
}

/** A bulk dialog asked for, the collectors selected when it opened, and the organization it was opened in. */
interface BulkAction {
  kind: "pin" | "move" | "delete";
  collectors: Collector[];
  organizationId: string;
}

/** The edit or delete dialog asked for, its collector, and the organization it was opened in. */
interface CollectorAction {
  kind: "edit" | "delete";
  collector: Collector;
  organizationId: string;
}

export function CollectorsTab({ fleet, installStarted, onInstall, onFleetGone, onFleetChanged }: CollectorsTabProps) {
  const page = useCollectorsPage(fleet.id, fleet.summary, { onFleetGone });
  const fleetType = fleet.type;
  const { collectors, rowsRead, groups, query, pageIndex, pager } = page;
  const now = Date.now();
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const locked = useLockedAction();

  // Focus back to each dialog's opener, else these.
  const focus = useReturnFocus();
  const searchBox = useRef<HTMLInputElement>(null);
  const firstName = useRef<HTMLButtonElement>(null);
  const selectionBar = useRef<HTMLDivElement>(null);
  const rowFallback = () => firstName.current ?? searchBox.current;
  const bulkFallback = () => selectionBar.current ?? searchBox.current;
  // The rows with their read's number: rows from a read begun before a write never spend it before the close.
  useEffect(() => focus.rowsChanged(rowsRead), [collectors, rowsRead, focus]);

  // The details: the row opened, in the organization it was opened in; another organization closes them.
  const [details, setDetails] = useState<{ collector: Collector; organizationId: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The collector whose Edit, pressed in the details inside the playground, opens the prompt after their close.
  const lockedEditFromDetails = useRef<Collector | null>(null);
  // The row that opened the details: the locked Edit's prompt gives the focus back there (its own Edit is gone).
  const detailsOpener = useRef<HTMLElement | null>(null);
  if (detailsOpen && details !== null && details.organizationId !== organizationId) setDetailsOpen(false);
  const openDetails = (collector: Collector, from: HTMLElement) => {
    if (organizationId === null) return;
    focus.opened(from, rowFallback);
    detailsOpener.current = from;
    setDetails({ collector, organizationId });
    setDetailsOpen(true);
  };

  // The edit or delete dialog, as the details: another organization closes it.
  const [action, setAction] = useState<CollectorAction | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  if (actionOpen && action !== null && action.organizationId !== organizationId) setActionOpen(false);
  /** `from` the row's button; none from the details, whose opener carries over (`focus.handOff`). */
  const openAction = (kind: CollectorAction["kind"], collector: Collector, from?: HTMLElement) => {
    if (organizationId === null) return;
    if (locked !== null) {
      locked(COLLECTOR_LOCKED_WORDS[kind], from ?? detailsOpener.current);
      return;
    }
    if (from !== undefined) focus.opened(from, rowFallback);
    setAction({ kind, collector, organizationId });
    setActionOpen(true);
  };
  // A bulk dialog, as the edit and delete: another organization closes it.
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  if (bulkOpen && bulk !== null && bulk.organizationId !== organizationId) setBulkOpen(false);

  // A write (or a 404, or an unknown outcome): its reload may take the row the focus went back to.
  // The latest read is taken before the reload begins: the reload's, and any later read's, are numbered above it.
  const changed = () => {
    focus.wrote(page.latestRead());
    page.reload();
    onFleetChanged();
  };

  // The selection, and what it was made for: React's adjust-on-render, so a
  // stale selection never reaches the screen.
  const key = selectionKey(query, pageIndex);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [basis, setBasis] = useState<{ key: string; rows: Collector[] | null }>({ key, rows: collectors });
  if (basis.key !== key || basis.rows !== collectors) {
    setBasis({ key, rows: collectors });
    if (basis.key !== key) {
      setSelected(NO_SELECTION);
    } else {
      const shown = new Set((collectors ?? []).map((collector) => collector.id));
      setSelected(new Set([...selected].filter((id) => shown.has(id))));
    }
  }

  const select = (collectorId: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(collectorId);
      else next.delete(collectorId);
      return next;
    });
  const selectAll = (checked: boolean) =>
    setSelected(checked ? new Set((collectors ?? []).map((collector) => collector.id)) : NO_SELECTION);
  const selectedRows = (collectors ?? []).filter((collector) => selected.has(collector.id));
  const openBulk = (kind: BulkAction["kind"], from: HTMLElement) => {
    if (organizationId === null || selectedRows.length === 0) return;
    if (locked !== null) {
      locked(COLLECTOR_LOCKED_WORDS[kind === "delete" ? "bulkDelete" : kind], from);
      return;
    }
    focus.opened(from, bulkFallback);
    setBulk({ kind, collectors: selectedRows, organizationId });
    setBulkOpen(true);
  };

  return (
    <section>
      <CollectorsToolbar
        searchBoxRef={searchBox}
        groups={groups}
        groupId={query.groupId}
        busy={page.personsRead}
        onSearch={page.search}
        onFilter={page.filterByGroup}
        onRefresh={page.reload}
        fleetType={fleetType}
      />
      {page.failed ? (
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
          <AlertCircle className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">{COLLECTORS_LOAD_FAILED_MESSAGE}</p>
          <Button variant="outline" onClick={page.reload}>
            Try again
          </Button>
        </div>
      ) : collectors === null ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading collectors…
          </p>
        </div>
      ) : collectors.length === 0 ? (
        query.q !== "" ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-[13px] text-muted-foreground">No collectors match “{query.q}”.</p>
          </div>
        ) : query.groupId !== null ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-[13px] text-muted-foreground">No collectors in this group.</p>
          </div>
        ) : fleet.status === "archived" ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <p className="text-[13px] text-muted-foreground">{ARCHIVED_INSTALL_WORDS}</p>
          </div>
        ) : fleetType === "kubernetes-supervisor" ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
            />
            <div>
              <p className="text-[13px] font-medium text-foreground">{WAITING_TITLE}</p>
              <p className="mt-1 text-xs text-muted-foreground">{KUBERNETES_WAITING_DETAIL}</p>
            </div>
            <Button type="button" onClick={(event) => onInstall(event.currentTarget)}>
              <TerminalSquare className="h-4 w-4" aria-hidden="true" />
              Install with Helm
            </Button>
            <HelpPopover label={NOT_SHOWING_UP}>
              <p className="font-medium text-foreground">{NOT_SHOWING_UP}</p>
              <ul className="list-disc space-y-1 pl-4 text-left">
                {KUBERNETES_NOT_SHOWING_UP_TIPS.map((tip) => (
                  <li key={tip}>
                    {tip.includes(KUBECTL_LOGS) ? (
                      <>
                        {tip.slice(0, tip.indexOf(KUBECTL_LOGS))}
                        <span className="font-mono">{KUBECTL_LOGS}</span>
                        {tip.slice(tip.indexOf(KUBECTL_LOGS) + KUBECTL_LOGS.length)}
                      </>
                    ) : (
                      tip
                    )}
                  </li>
                ))}
              </ul>
            </HelpPopover>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            {installStarted ? (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
              />
            ) : (
              <TerminalSquare className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            )}
            <div>
              <p className="text-[13px] font-medium text-foreground">{installStarted ? WAITING_TITLE : INSTALL_FIRST_TITLE}</p>
              <p className="mt-1 text-xs text-muted-foreground">{installStarted ? WAITING_DETAIL : INSTALL_FIRST_DETAIL}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" onClick={(event) => onInstall(event.currentTarget)}>
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                Install collector
              </Button>
              {installStarted && (
                <HelpPopover label={NOT_SHOWING_UP}>
                  <p className="font-medium text-foreground">{NOT_SHOWING_UP}</p>
                  <ul className="list-disc space-y-1 pl-4 text-left">
                    {NOT_SHOWING_UP_TIPS.map((tip) => (
                      <li key={tip}>
                        {tip.startsWith("Container: ") ? (
                          <>
                            Container: <span className="font-mono">docker logs telflo-collector</span> shows the supervisor&apos;s output.
                          </>
                        ) : (
                          tip
                        )}
                      </li>
                    ))}
                  </ul>
                </HelpPopover>
              )}
            </div>
          </div>
        )
      ) : (
        <>
          {selectedRows.length > 0 && (
            <CollectorsSelectionBar
              ref={selectionBar}
              count={selectedRows.length}
              groupsRead={groups !== null}
              onPin={(from) => openBulk("pin", from)}
              onMove={(from) => openBulk("move", from)}
              onDelete={(from) => openBulk("delete", from)}
              onClear={() => setSelected(NO_SELECTION)}
            />
          )}
          <CollectorsTable
            collectors={collectors}
            groups={groups}
            query={query}
            onSort={page.sortBy}
            now={now}
            selected={selected}
            onSelect={select}
            onSelectAll={selectAll}
            firstNameRef={firstName}
            fleetType={fleetType}
            onOpen={openDetails}
            onEdit={(collector, from) => openAction("edit", collector, from)}
            onDelete={(collector, from) => openAction("delete", collector, from)}
          />
          {pager !== null && (
            <CollectorsPager
              pager={pager}
              hasPrev={page.hasPrev}
              hasNext={page.hasNext}
              onPrev={page.prev}
              onNext={page.next}
            />
          )}
        </>
      )}
      <CollectorDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        collector={details?.collector ?? null}
        organizationId={details?.organizationId ?? ""}
        fleetId={fleet.id}
        groups={groups}
        fleetType={fleetType}
        onCollectorGone={changed}
        onEdit={(collector) => {
          if (locked === null) {
            focus.handOff();
            openAction("edit", collector);
            return;
          }
          // Locked in the playground: the prompt opens once the details have
          // closed and given the focus back to the row, so the prompt's close
          // gives it back there too (its opener, the details' Edit, is gone by
          // then; as the Testing tab's locked Run).
          lockedEditFromDetails.current = collector;
        }}
        onCloseAutoFocus={(event) => {
          focus.returnFocus(event);
          const collector = lockedEditFromDetails.current;
          lockedEditFromDetails.current = null;
          if (collector !== null) openAction("edit", collector);
        }}
      />
      {/* Edit and Delete take the current organization: an answer for an earlier one is dropped (useStillCurrent), and the route unmounts the tab on a switch. */}
      <EditCollectorDialog
        open={actionOpen && action?.kind === "edit"}
        onOpenChange={setActionOpen}
        collector={action?.collector ?? null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        groups={groups}
        fleetType={fleetType}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <DeleteCollectorDialog
        open={actionOpen && action?.kind === "delete"}
        onOpenChange={setActionOpen}
        collector={action?.collector ?? null}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        fleetType={fleetType}
        groups={groups}
        onDeleted={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <BulkPinDialog
        open={bulkOpen && bulk?.kind === "pin"}
        onOpenChange={setBulkOpen}
        collectors={bulk?.collectors ?? []}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        groups={groups}
        fleetType={fleetType}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <BulkMoveDialog
        open={bulkOpen && bulk?.kind === "move"}
        onOpenChange={setBulkOpen}
        collectors={bulk?.collectors ?? []}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        groups={groups}
        fleetType={fleetType}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
      <BulkDeleteDialog
        open={bulkOpen && bulk?.kind === "delete"}
        onOpenChange={setBulkOpen}
        collectors={bulk?.collectors ?? []}
        organizationId={organizationId ?? ""}
        fleetId={fleet.id}
        fleetType={fleetType}
        groups={groups}
        onChanged={changed}
        onCloseAutoFocus={focus.returnFocus}
      />
    </section>
  );
}
