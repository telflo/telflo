import { Link } from "react-router";
import type { FleetRotateToken, FleetStatus } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { formatDateTime } from "~/lib/format.js";

/*
 * The fleet list's Token column, from the server's rotate-token state
 * (`summary.rotateToken`) rather than the browser's sums. Its details:
 * - the buckets' edges: under a day reads "<1d left" (not "0d left"), months
 *   stop at 11 (no "12mo"), and years round to whole ones from 345 days ("1y"
 *   for a fresh "1 year" token, never "1.0y" or "1.5y"). "Expired" can't
 *   occur: a fleet whose rotate tokens have all expired has none valid,
 *   Suspended;
 * - the "Rotating" badge while a replaced token is in its grace (`graceEndsAt`);
 * - the tooltip is Radix tooltip content (text, which replay masks), not a
 *   `title`: the valid count, the current token's expiry and the grace's end;
 *   for Suspended, the suspension's words (no "no-op stub config": untrue
 *   here). For an archived fleet the agent endpoint refuses every collector
 *   (403 with a valid token, 401 with a revoked, expired or unknown one: it
 *   checks the token first), so ARCHIVED_TOOLTIP takes the Suspended words'
 *   and the grace line's place; the badge, the valid count and the expiry
 *   stay.
 * The cell links to the fleet's page at its Tokens tab, in the fleet list
 * and in a fleet's own stats strip alike; the link's address holds the
 * fleet's id only. Its name ends in TOKEN_LINK_SUFFIX, hidden text naming
 * where it goes (the badge alone wouldn't say where the link goes).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The link's hidden end, after its badges: where it goes. */
export const TOKEN_LINK_SUFFIX = " (open the Tokens tab)";

/** The badge's colour, by bucket. */
export type TokenBadgeVariant = "outline" | "secondary" | "destructive" | "warning" | "success";

export interface TokenBucket {
  variant: TokenBadgeVariant;
  label: string;
}

/**
 * The Token badge at `now`: Suspended with no valid rotate token; Never
 * for one that never expires; else by the days left (fractional): under 1
 * "<1d left" and under 7 "{d}d left" (destructive), under 30 "{d}d left"
 * (warning), under 60 "{d}d", under 345 "{m}mo" (rounded months, 2 to
 * 11), then "{y}y" (rounded years, at least 1), all three success. A
 * token past its expiry at render (the poll's lag) reads "<1d left".
 */
export function tokenBucket(rotateToken: FleetRotateToken | null, now: number): TokenBucket {
  if (rotateToken === null) return { variant: "outline", label: "Suspended" };
  return expiryBucket(rotateToken.expiresAt, now);
}

/**
 * One expiry's badge at `now`: `tokenBucket` less Suspended, for the
 * fleet's current rotate token above and for each token's Expires in the
 * Tokens tab. Never for none; else by the days left, as `tokenBucket`
 * says. A time at or past `now` reads "<1d left": the Tokens table shows
 * "Expired" there instead.
 */
export function expiryBucket(expiresAt: string | null, now: number): TokenBucket {
  if (expiresAt === null) return { variant: "secondary", label: "Never" };
  const days = (Date.parse(expiresAt) - now) / DAY_MS;
  if (days < 1) return { variant: "destructive", label: "<1d left" };
  if (days < 7) return { variant: "destructive", label: `${Math.floor(days)}d left` };
  if (days < 30) return { variant: "warning", label: `${Math.floor(days)}d left` };
  if (days < 60) return { variant: "success", label: `${Math.floor(days)}d` };
  if (days < 345) return { variant: "success", label: `${Math.round(days / 30)}mo` };
  return { variant: "success", label: `${Math.max(1, Math.round(days / 365))}y` };
}

/**
 * What a Suspended fleet's collectors meet. "A valid default token": the cell reads the fleet's summary only, which
 * can't tell whether its default token is revoked, so the words hold either way.
 */
export const SUSPENDED_TOOLTIP =
  "No valid rotate token: collectors on a valid default token still connect but get no configuration, and collectors on a revoked or expired rotate token are refused.";

/** What an archived fleet's collectors meet, whatever their token. */
export const ARCHIVED_TOOLTIP = "Archived: its collectors are refused whatever their token.";

/**
 * The tooltip's lines, dates by `formatDateTime`. An archived fleet's last
 * line is ARCHIVED_TOOLTIP, in place of the Suspended words and the grace
 * line.
 */
export function tokenTooltipLines(rotateToken: FleetRotateToken | null, status: FleetStatus): string[] {
  const archived = status === "archived";
  if (rotateToken === null) return [archived ? ARCHIVED_TOOLTIP : SUSPENDED_TOOLTIP];
  const { validCount, expiresAt, graceEndsAt } = rotateToken;
  const lines = [
    `${validCount} valid rotate token${validCount === 1 ? "" : "s"}`,
    expiresAt === null ? "Current one never expires" : `Current one expires ${formatDateTime(expiresAt)}`,
  ];
  if (archived) {
    lines.push(ARCHIVED_TOOLTIP);
  } else if (graceEndsAt !== null) {
    lines.push(`Grace ends ${formatDateTime(graceEndsAt)}: collectors on the replaced token move to the current one on their next poll.`);
  }
  return lines;
}

interface TokenCellProps {
  fleetId: string;
  rotateToken: FleetRotateToken | null;
  /** The fleet's status: an archived fleet's tooltip says so. */
  status: FleetStatus;
  /** The time the badge is reckoned at: the list's or the page's render. */
  now: number;
}

const TRIGGER_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function TokenCell({ fleetId, rotateToken, status, now }: TokenCellProps) {
  const bucket = tokenBucket(rotateToken, now);
  const badges = (
    <>
      <Badge variant={bucket.variant}>{bucket.label}</Badge>
      {rotateToken?.graceEndsAt != null && <Badge variant="info">Rotating →</Badge>}
    </>
  );
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to={`/fleet-management/${encodeURIComponent(fleetId)}?tab=tokens`} className={TRIGGER_CLASS}>
            {badges}
            <span className="sr-only">{TOKEN_LINK_SUFFIX}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {tokenTooltipLines(rotateToken, status).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
