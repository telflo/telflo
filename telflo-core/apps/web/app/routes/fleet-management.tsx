import { useEffect, useState } from "react";
import { AlertCircle, Search } from "lucide-react";
import type { FleetStatus } from "@telflo/contracts";
import type { Route } from "./+types/fleet-management";
import { EmptyFleets } from "~/components/fleets/EmptyFleets.js";
import { FleetActionDialogs, useFleetActionDialogs } from "~/components/fleets/FleetActionDialogs.js";
import { NewFleetButton, NewFleetDialogs, useNewFleetDialogs } from "~/components/fleets/NewFleetButton.js";
import { FleetsTable } from "~/components/fleets/FleetsTable.js";
import { Button } from "~/components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { FLEETS_LOAD_FAILED_MESSAGE, useFleetsList } from "~/lib/fleets.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `/fleet-management`, the fleet list: its header, table and first-run
 * card, in the configurations page's structure (`configurations.tsx`). Its
 * rules:
 * - the heading is "Fleets" (the filter shows archived ones too), with the
 *   organization's name beside it as text, in the masked shell;
 * - a filter, "All fleets" (the default, every fleet), "Active" and
 *   "Archived": the API's `status`, kept out of the URL;
 * - the rows are the API's, 50 a page, newest first, with "Load more"
 *   (disabled while a person's read is under way), polled every 15 seconds
 *   while the tab is visible and no dialog is open (`useFleetsList`); no
 *   sorting, and no usage strip;
 * - a failed first load says so, with "Try again" (never the onboarding
 *   card); "No active fleets." and "No archived fleets." when a
 *   filter matches nothing; the onboarding card only for no fleet at all;
 * - "Loading fleets…" while the first page is read.
 * The title is fixed, never a fleet's label (posthog-js sends
 * `document.title` with every page view, and replay records `<head>`, outside
 * `ph-mask`). No attribute carries a fleet's label. The layout route supplies
 * the shell, and its terms dialog: the list waits for it (lib/fleets.ts).
 *
 * Where the dialogs plug in:
 * - "New Fleet" (the header's, and the empty state's) is `NewFleetButton`,
 *   opening the type chooser and the create dialogs (`NewFleetDialogs`),
 *   held once here, outside the content: a read landing mid-create (a
 *   filter's, a poll's) may swap the empty state out, and the dialog, its
 *   bearers or its outcome, must outlive it. A create opens the new fleet's
 *   page on Done; a dialog closed after an unknown outcome reloads the list
 *   (`list.reload`), as a fleet may have been made. Another organization
 *   closes them;
 * - a row's Rename, Archive, Unarchive and Delete open that dialog for its
 *   fleet (`FleetActionDialogs`), each reloading the list (`list.reload`)
 *   when done, after a 404 for the fleet, or after an answer that leaves the
 *   change unknown (a 503, its hang guard). Another organization closes
 *   them, as the configurations page's.
 * - Every dialog's close gives the focus back to the button that opened it:
 *   the row's, a "New Fleet"; else, its row (or the empty state's New
 *   Fleet) gone once the list has been read again after the dialog's write
 *   or unknown outcome, the header's New Fleet. A poll after a close with
 *   no write never moves the focus.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Fleets - Telflo" }];
}

const FLEET_LIST_FILTERS = ["all", "active", "archived"] as const;
type FleetListFilter = (typeof FLEET_LIST_FILTERS)[number];

/** The filter's options, in order: "All fleets" first, the default. */
const FILTER_LABELS: Record<FleetListFilter, string> = {
  all: "All fleets",
  active: "Active",
  archived: "Archived",
};

function isListFilter(value: string): value is FleetListFilter {
  return (FLEET_LIST_FILTERS as readonly string[]).includes(value);
}

function statusOf(filter: FleetListFilter): FleetStatus | undefined {
  return filter === "all" ? undefined : filter;
}

export default function FleetManagementRoute() {
  const currentUser = useCurrentUser();
  const organizationId = currentUser?.organization.id ?? "";
  const [filter, setFilter] = useState<FleetListFilter>("all");
  const list = useFleetsList({ status: statusOf(filter) });
  const newFleet = useNewFleetDialogs();
  // A row's dialog closed, its row gone (deleted, or archived under Active): the header's New Fleet takes the focus.
  const dialogs = useFleetActionDialogs(organizationId, () => newFleet.headerButton.current);
  const { wrote, rowsChanged } = dialogs;
  // The create flow's too: a create closed after an unknown outcome, the empty state's New Fleet gone once the list is read again.
  const { wrote: mayHaveCreated, rowsChanged: createRowsChanged } = newFleet.focus;
  // The rows with their read's number: rows from a read begun before a write (a poll's, "Load more"'s) never spend it before the close.
  const { rowsRead, latestRead } = list;
  useEffect(() => {
    rowsChanged(rowsRead);
    createRowsChanged(rowsRead);
  }, [list.fleets, rowsRead, rowsChanged, createRowsChanged]);
  // A dialog's write (or its 404, or its unknown outcome) reads the list again: its rows may have lost the focus.
  // The latest read is taken before the reload begins: the reload's, and any later read's, are numbered above it.
  const reloadAfterWrite = () => {
    wrote(latestRead());
    list.reload();
  };
  const reloadAfterCreate = () => {
    mayHaveCreated(latestRead());
    list.reload();
  };
  // The Token and Last Seen columns are reckoned at each render: each poll's.
  const now = Date.now();

  let content;
  if (list.failed) {
    content = (
      <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">{FLEETS_LOAD_FAILED_MESSAGE}</p>
        <Button variant="outline" onClick={list.reload}>
          Try again
        </Button>
      </div>
    );
  } else if (list.fleets === null) {
    content = (
      <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">Loading fleets…</p>
      </div>
    );
  } else if (list.fleets.length === 0 && list.shownStatus === undefined) {
    content = <EmptyFleets action={<NewFleetButton dialogs={newFleet} />} />;
  } else if (list.fleets.length === 0) {
    content = (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center">
        <Search className="h-5 w-5 text-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">
          {list.shownStatus === "active" ? "No active fleets." : "No archived fleets."}
        </p>
      </div>
    );
  } else {
    content = (
      <>
        <FleetsTable fleets={list.fleets} now={now} onAction={dialogs.openFor} />
        {list.hasMore && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={list.loadMore} disabled={list.isLoadingMore || list.isStale}>
              {list.isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-card border-b border-border">
        <div className="flex h-[52px] items-center justify-between gap-4 px-5">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Fleets</h1>
            {currentUser && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{currentUser.organization.name}</span>
            )}
          </div>
          <NewFleetButton dialogs={newFleet} buttonRef={newFleet.headerButton} />
        </div>
      </div>

      {/* Content */}
      <div className="px-5 py-4">
        {/* Toolbar: filter */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={filter}
            onValueChange={(value) => {
              if (isListFilter(value)) setFilter(value);
            }}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              {FLEET_LIST_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {content}
      </div>

      <NewFleetDialogs dialogs={newFleet} onMayHaveCreated={reloadAfterCreate} />
      <FleetActionDialogs
        target={dialogs.target}
        open={dialogs.open}
        onOpenChange={dialogs.setOpen}
        organizationId={organizationId}
        onChanged={reloadAfterWrite}
        onDeleted={reloadAfterWrite}
        onDeleteUnknown={reloadAfterWrite}
        onCloseAutoFocus={dialogs.returnFocus}
      />
    </div>
  );
}
