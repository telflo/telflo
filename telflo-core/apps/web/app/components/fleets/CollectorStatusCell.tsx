import type { Collector } from "@telflo/contracts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";

/*
 * A collector's Status (D17b-1 decisions 11 and 23; D17d-2 Ruling 55, the
 * owner's Q58): a dot and words from the server's `liveness` (Online,
 * Warning, Unknown, Offline), never recomputed in the browser. Until Ruling 55
 * the column showed the configuration's sync (now the Configuration column,
 * `CollectorConfigurationCell`) and the liveness was only a dot beside Last
 * seen: a collector whose token was revoked kept a green "In sync" while
 * it went unseen. Its window (D17a's `OnlineBar` windows, as the server
 * reckons them) is tooltip text on a focusable trigger and screen-reader
 * text (a tooltip never shows on touch), never a `title` or an
 * `aria-label`. Fixed words only.
 */

type Liveness = Collector["liveness"];

/** The words shown for each liveness state. */
export const LIVENESS_LABELS: Record<Liveness, string> = {
  online: "Online",
  warning: "Warning",
  unknown: "Unknown",
  offline: "Offline",
};

/** Each liveness state's window, as the server reckons it, without its words: the details' Status row says it so. */
export const LIVENESS_MEANINGS: Record<Liveness, string> = {
  online: "seen in the last minute",
  warning: "last seen 1–2 minutes ago",
  unknown: "last seen 2–5 minutes ago",
  offline: "not seen for over 5 minutes",
};

/** Each liveness state with its window: "{words}: {window}", as "online: seen in the last minute". */
export const LIVENESS_WINDOWS: Record<Liveness, string> = {
  online: `online: ${LIVENESS_MEANINGS.online}`,
  warning: `warning: ${LIVENESS_MEANINGS.warning}`,
  unknown: `unknown: ${LIVENESS_MEANINGS.unknown}`,
  offline: `offline: ${LIVENESS_MEANINGS.offline}`,
};

/** The dot's colour: ok online, warning warning, muted unknown, fail offline. */
export const LIVENESS_DOT_CLASSES: Record<Liveness, string> = {
  online: "bg-ok",
  warning: "bg-warn",
  unknown: "bg-muted-foreground/40",
  offline: "bg-fail",
};

/** A status dot (decoration: the words say the same). */
export function StatusDot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${className}`} />;
}

export function CollectorStatusCell({ liveness }: { liveness: Liveness }) {
  const seenWindow = LIVENESS_WINDOWS[liveness];
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <StatusDot className={LIVENESS_DOT_CLASSES[liveness]} />
            {LIVENESS_LABELS[liveness]}
            <span className="sr-only"> ({seenWindow})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {seenWindow}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
