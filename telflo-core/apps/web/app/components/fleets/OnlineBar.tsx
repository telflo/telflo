import type { FleetSummary } from "@telflo/contracts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";

/*
 * The fleet list's Online column: a tight stacked bar and "{online}/{total}"
 * count, from the summary's liveness counts as the server reckons them,
 * never recomputed here. Its details:
 * - four segments (online, warning, unknown, offline), and online means seen
 *   in the last minute;
 * - the legend says each window, as Radix tooltip content on a focusable
 *   trigger and as screen-reader text (a tooltip never shows on touch),
 *   never a `title`;
 * - "No collectors" for a fleet with none.
 * The segments are decoration (`aria-hidden`): the count and the legend
 * say the same in words.
 */

export type LivenessCounts = Pick<FleetSummary, "collectors" | "online" | "warning" | "unknown" | "offline">;

/** The legend: each count with its window, as the server reckons it. */
export function onlineLegend({ online, warning, unknown, offline }: LivenessCounts): string {
  return [
    `${online} online (seen in the last minute)`,
    `${warning} warning (1–2 minutes)`,
    `${unknown} unknown (2–5 minutes)`,
    `${offline} offline (over 5 minutes)`,
  ].join(" · ");
}

const SEGMENTS: { key: keyof Omit<LivenessCounts, "collectors">; className: string }[] = [
  { key: "online", className: "bg-ok" },
  { key: "warning", className: "bg-warn" },
  { key: "unknown", className: "bg-muted-foreground/40" },
  { key: "offline", className: "bg-fail" },
];

export function OnlineBar({ summary }: { summary: LivenessCounts }) {
  if (summary.collectors === 0) {
    return <span className="text-xs text-muted-foreground">No collectors</span>;
  }
  const legend = onlineLegend(summary);
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="flex min-w-[140px] items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span aria-hidden="true" className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              {SEGMENTS.map(({ key, className }) => (
                <span
                  key={key}
                  className={`${className} transition-[width] duration-[400ms] ease-in-out`}
                  style={{ width: `${(summary[key] / summary.collectors) * 100}%` }}
                />
              ))}
            </span>
            <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
              {summary.online}/{summary.collectors}
            </span>
            <span className="sr-only"> {legend}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {legend}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
