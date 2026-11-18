import type { FleetDetail, FleetSummary } from "@telflo/contracts";
import { Stat, type StatEmphasis } from "./Stat.js";
import { TokenCell } from "./TokenCell.js";

/*
 * A fleet's stats strip, both fleet types' (D17b-1 decision 20, Preflight
 * ruling 8; D17d-1 decision 11: a Kubernetes-supervisor fleet's the same
 * tiles): the server tiles, between the header and the tabs, from the fleet's
 * summary as the server counted it (`useFleet`'s, polled every 15 s), never
 * recomputed from the collectors shown. Per the D17b-1 Parity Notes:
 * - Online is the last minute ("Last minute"), in the danger colour when
 *   there are collectors and none is online, the warning colour when some
 *   aren't;
 * - Version drift counts pending, failed and drifted collectors ("Collectors
 *   lagging", failed ones included); with no drift, its hint says how many
 *   have nothing assigned ("{n} with nothing assigned", D16c Ruling 18: since
 *   D16c every collector arrives so) and "All up to date" only when none has;
 * - Token expires is D17a's Token badge and tooltip (`TokenCell`), a link
 *   to the fleet's Tokens tab (D17b-2 decision 22) as in the fleet list.
 */

/** Online's colour: danger with collectors and none online, warning with some offline, else neutral. */
export function onlineEmphasis({ collectors, online }: Pick<FleetSummary, "collectors" | "online">): StatEmphasis {
  if (collectors === 0 || online === collectors) return "neutral";
  return online === 0 ? "danger" : "warn";
}

/** Version drift: the collectors not running what resolves for them. */
export function versionDriftCount({ pending, failed, drifted }: Pick<FleetSummary, "pending" | "failed" | "drifted">): number {
  return pending + failed + drifted;
}

/** Version drift's hint: lagging with drift, else how many have nothing assigned, else up to date. */
export function versionDriftHint(summary: Pick<FleetSummary, "pending" | "failed" | "drifted" | "unassigned">): string {
  if (versionDriftCount(summary) > 0) return "Collectors lagging";
  return summary.unassigned > 0 ? `${summary.unassigned} with nothing assigned` : "All up to date";
}

interface StatsStripProps {
  fleet: FleetDetail;
  /** The time the Token tile is reckoned at: the page's render. */
  now: number;
}

export function StatsStrip({ fleet, now }: StatsStripProps) {
  const { summary } = fleet;
  const drift = versionDriftCount(summary);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Collectors" value={String(summary.collectors)} />
      <Stat label="Online" value={String(summary.online)} emphasis={onlineEmphasis(summary)} hint="Last minute" />
      <Stat
        label="Version drift"
        value={String(drift)}
        emphasis={drift > 0 ? "warn" : "neutral"}
        hint={versionDriftHint(summary)}
      />
      <Stat
        label="Token expires"
        value={<TokenCell fleetId={fleet.id} rotateToken={summary.rotateToken} status={fleet.status} now={now} />}
      />
    </div>
  );
}
