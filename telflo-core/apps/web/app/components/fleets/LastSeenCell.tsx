import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { formatDateTime, formatRelativeTime } from "~/lib/format.js";

/*
 * A collector's Last seen: how long ago (`formatRelativeTime`, at the
 * tab's render, so each poll re-reckons it) as plain text, no dot: the
 * server's `liveness` is the Status column's (`CollectorStatusCell`). The
 * full local time is tooltip text on a focusable trigger and screen-reader
 * text, never a `title` or an `aria-label` on a span nothing can focus.
 * `lastSeenAt` is never null (the contract), so there is no dash. Its text
 * is 13 px, monospaced.
 */

interface LastSeenCellProps {
  lastSeenAt: string;
  /** The time it is reckoned at: the tab's render. */
  now: number;
}

export function LastSeenCell({ lastSeenAt, now }: LastSeenCellProps) {
  const fullTime = formatDateTime(lastSeenAt);
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="whitespace-nowrap rounded-sm font-mono text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {formatRelativeTime(lastSeenAt, now)}
            <span className="sr-only"> ({fullTime})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {fullTime}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
