import { useId } from "react";
import { Link } from "react-router";
import type { FleetDetail, FleetType } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { formatDateTime, formatRelativeTime } from "~/lib/format.js";
import { ConfigurationSyncCell } from "./ConfigurationSyncCell.js";
import { FleetRowActions, type FleetRowAction } from "./FleetRowActions.js";
import { OnlineBar } from "./OnlineBar.js";
import { TokenCell } from "./TokenCell.js";

/*
 * The fleet list's table (D17a decision 18, Preflight ruling 11): plain
 * table markup with the classes of the configurations list's
 * (`ConfigurationsTable.tsx`; no @tanstack/react-table, decision 5).
 * In the D17a Parity Notes:
 * - the headers are plain and don't sort: the rows are in the API's order,
 *   newest first;
 * - Fleet links to the fleet's page (`/fleet-management/{id}`, one route for
 *   every type, decision 7), with an "Archived" badge after an archived
 *   fleet's label;
 * - Type has no "Bridge" (D16a decision 1);
 * - Online, Configuration Sync and Token are their own components, from the
 *   summary the server counted (decision 9);
 * - Last Seen is `formatRelativeTime` ("5 seconds ago"), at the list's
 *   render, so each poll re-reckons it, with the full local time as tooltip
 *   text, never a `title`; a dash for a fleet never seen;
 * - the row's actions: Rename, Archive or Unarchive, and Delete
 *   (`FleetRowActions`).
 * No attribute carries a fleet's label (decision 29): it is text in the
 * masked shell; the links hold ids only.
 */

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

/** The Type column's words; no "Bridge" (D16a decision 1). */
export const FLEET_TYPE_LABELS: Record<FleetType, string> = {
  server: "Supervisor",
  "kubernetes-supervisor": "K8s Supervisor",
};

/** Last Seen: how long ago, its full time in the tooltip; a dash for never. */
function LastSeenCell({ lastSeenAt, now }: { lastSeenAt: string | null; now: number }) {
  if (lastSeenAt === null) return <span className="text-muted-foreground">—</span>;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="whitespace-nowrap rounded-sm font-mono text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {formatRelativeTime(lastSeenAt, now)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{formatDateTime(lastSeenAt)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface FleetsTableProps {
  fleets: FleetDetail[];
  /** The time the Token and Last Seen columns are reckoned at: the page's render. */
  now: number;
  /** A row's Rename, Archive, Unarchive or Delete. */
  onAction: (action: FleetRowAction, fleet: FleetDetail, from: HTMLElement) => void;
}

export function FleetsTable({ fleets, now, onAction }: FleetsTableProps) {
  const idPrefix = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Fleet</th>
              <th className={HEAD_CLASS}>Type</th>
              <th className={HEAD_CLASS}>Online</th>
              <th className={HEAD_CLASS}>Configuration Sync</th>
              <th className={HEAD_CLASS}>Token</th>
              <th className={HEAD_CLASS}>Last Seen</th>
              <th className={HEAD_CLASS}>
                <div className="text-right">Actions</div>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {fleets.map((fleet) => (
              <tr key={fleet.id} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/fleet-management/${encodeURIComponent(fleet.id)}`}
                      className="font-medium text-foreground hover:text-brand hover:underline"
                    >
                      {fleet.label}
                    </Link>
                    {fleet.status === "archived" && <Badge variant="outline">Archived</Badge>}
                  </div>
                </td>
                <td className={CELL_CLASS}>
                  <span className="text-[13px] text-muted-foreground">{FLEET_TYPE_LABELS[fleet.type]}</span>
                </td>
                <td className={CELL_CLASS}>
                  <OnlineBar summary={fleet.summary} />
                </td>
                <td className={CELL_CLASS}>
                  <ConfigurationSyncCell summary={fleet.summary} />
                </td>
                <td className={CELL_CLASS}>
                  <TokenCell fleetId={fleet.id} rotateToken={fleet.summary.rotateToken} status={fleet.status} now={now} />
                </td>
                <td className={CELL_CLASS}>
                  <LastSeenCell lastSeenAt={fleet.summary.lastSeenAt} now={now} />
                </td>
                <td className={CELL_CLASS}>
                  <FleetRowActions fleet={fleet} idPrefix={idPrefix} onAction={onAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
