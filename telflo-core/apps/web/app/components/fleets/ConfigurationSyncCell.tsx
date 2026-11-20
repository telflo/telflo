import type { Collector, FleetSummary } from "@telflo/contracts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";

/*
 * The fleet list's Configuration Sync column, named in full, never `config`.
 * State-aware text, never a second fraction beside Online's, from the
 * summary's drift counts as the server reckons them:
 * - "all in sync" only when every collector is in sync (never when nothing
 *   is assigned); otherwise the non-zero counts in a fixed order, failed,
 *   drifted, pending, unassigned, in sync ("1 failed", a middle dot, "3 in
 *   sync"), in the warning color;
 * - the legend counts each drift state and says what it means, as Online's:
 *   Radix tooltip content on a focusable trigger and screen-reader text,
 *   never a `title`;
 * - "No collectors" for a fleet with none.
 */

export type DriftCounts = Pick<FleetSummary, "collectors" | "inSync" | "pending" | "failed" | "drifted" | "unassigned">;

/**
 * What each drift state means, as the legend says it; a collector's
 * Configuration (`CollectorConfigurationCell`) reuses them, with its own words
 * for unassigned.
 */
export const DRIFT_MEANINGS: Record<Collector["drift"], string> = {
  failed: "failed to apply its configuration",
  drifted: "running another configuration",
  pending: "not running its configuration yet",
  unassigned: "no configuration assigned",
  inSync: "running its configuration",
};

/** The drift states in the order the cell names them, with their words. */
const STATES: { key: keyof Omit<DriftCounts, "collectors">; words: string; meaning: string }[] = [
  { key: "failed", words: "failed", meaning: DRIFT_MEANINGS.failed },
  { key: "drifted", words: "drifted", meaning: DRIFT_MEANINGS.drifted },
  { key: "pending", words: "pending", meaning: DRIFT_MEANINGS.pending },
  { key: "unassigned", words: "unassigned", meaning: DRIFT_MEANINGS.unassigned },
  { key: "inSync", words: "in sync", meaning: DRIFT_MEANINGS.inSync },
];

/** The cell's text: "all in sync", or the non-zero counts in order. Empty for no collectors. */
export function configurationSyncText(counts: DriftCounts): string {
  if (counts.collectors === 0) return "";
  if (counts.inSync === counts.collectors) return "all in sync";
  return STATES.filter(({ key }) => counts[key] > 0)
    .map(({ key, words }) => `${counts[key]} ${words}`)
    .join(" · ");
}

/** The legend: every state's count, with what it means. */
export function configurationSyncLegend(counts: DriftCounts): string {
  return STATES.map(({ key, words, meaning }) => `${counts[key]} ${words} (${meaning})`).join(" · ");
}

export function ConfigurationSyncCell({ summary }: { summary: DriftCounts }) {
  if (summary.collectors === 0) {
    return <span className="text-xs text-muted-foreground">No collectors</span>;
  }
  const allInSync = summary.inSync === summary.collectors;
  const legend = configurationSyncLegend(summary);
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={`whitespace-nowrap rounded-sm font-mono text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              allInSync ? "text-muted-foreground" : "text-warn"
            }`}
          >
            {configurationSyncText(summary)}
            <span className="sr-only"> ({legend})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {legend}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
