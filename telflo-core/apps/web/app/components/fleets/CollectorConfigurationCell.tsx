import type { Collector } from "@telflo/contracts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { StatusDot } from "./CollectorStatusCell.js";
import { DRIFT_MEANINGS } from "./ConfigurationSyncCell.js";

/*
 * A collector's Configuration (D17b-1 decisions 11 and 22, Preflight
 * rulings 4 and 10; the grid's Status column until D17d-2 Ruling 55, the
 * owner's Q58, made Status the liveness): a dot and words from the server's
 * `drift`, never computed in the browser. Its meaning, D17a's Configuration
 * Sync legend's (`DRIFT_MEANINGS`) but for unassigned's (Preflight ruling
 * 4), is tooltip text on a focusable trigger and screen-reader text (a
 * tooltip never shows on touch), never a `title` or an `aria-label`.
 * Applying counts as pending (the opamp-server counts it so), and a stale
 * collector is the Status column's Offline (`CollectorStatusCell`). Fixed
 * words only.
 */

type Drift = Collector["drift"];

/** The words shown for each drift state. */
export const COLLECTOR_CONFIGURATION_LABELS: Record<Drift, string> = {
  inSync: "In sync",
  pending: "Pending pickup",
  failed: "Apply failed",
  drifted: "Drifted",
  unassigned: "Nothing assigned",
};

/** What "Nothing assigned" means for a collector (Preflight ruling 4); the list's legend keeps "no configuration assigned". */
export const UNASSIGNED_COLLECTOR_MEANING =
  "no pin, and no published version on its group; it keeps running what it has: its own file, or the last published version it was sent.";

/** Each state's meaning: "{words}: {meaning}", as "nothing assigned: no pin, …". */
export function collectorConfigurationMeaning(drift: Drift): string {
  const meaning = drift === "unassigned" ? UNASSIGNED_COLLECTOR_MEANING : DRIFT_MEANINGS[drift];
  return `${COLLECTOR_CONFIGURATION_LABELS[drift].toLowerCase()}: ${meaning}`;
}

/** The dot's colour: ok in sync, warning pending, fail failed or drifted, muted with nothing assigned. */
export const DRIFT_DOT_CLASSES: Record<Drift, string> = {
  inSync: "bg-ok",
  pending: "bg-warn",
  failed: "bg-fail",
  drifted: "bg-fail",
  unassigned: "bg-muted-foreground/40",
};

export function CollectorConfigurationCell({ drift }: { drift: Drift }) {
  const meaning = collectorConfigurationMeaning(drift);
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <StatusDot className={DRIFT_DOT_CLASSES[drift]} />
            {COLLECTOR_CONFIGURATION_LABELS[drift]}
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
