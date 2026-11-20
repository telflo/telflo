import { AlertTriangle, RefreshCw } from "lucide-react";
import type { FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { formatDateTime, formatRelativeFuture } from "~/lib/format.js";
import { NO_VALID_DEFAULT_CLAUSE } from "./RevokeTokenDialog.js";

/*
 * The rotate-before-expiry banner, above the Tokens table, from the
 * fleet's summary (`rotateToken`, the route's poll keeps it current),
 * never on an archived fleet (its collectors are refused whatever their
 * token):
 *
 * - suspended (no valid rotate token), destructive; when the Tokens tab's
 *   tokens hold no valid default token, it says so (a restarted collector
 *   has nothing to come back through);
 * - expiring: the current rotate token's expiry under 30 days, warning, and
 *   under 7, destructive; "in 5 days" by `formatRelativeFuture`, the date by
 *   `formatDateTime`. After a revoke of the current token mid-grace the
 *   summary's expiry is the promoted token's, which the banner then shows.
 *
 * Each has a "Rotate token" button opening the rotate dialog; the tab gives
 * the focus back to it as the dialog closes (or, once a rotation has taken
 * the banner away, to its fallback). `ui/alert.tsx` has no warning tone, so
 * the banner styles its own two.
 *
 * The banner is rendered only when there is one, as a `region` landmark
 * named "Rotate token notice", with no live semantics at all: no
 * `aria-live`, no `role="status"`, no always-mounted wrapper. Radix's
 * `hideOthers` skips `aria-live` elements and Radix sets no `aria-modal`,
 * so a live wrapper left the banner's button reachable by a screen reader
 * behind the dialogs; a `status` re-announced the countdown each time its
 * words changed; an empty status was exposed in the accessibility tree with
 * no banner. Its first appearance isn't announced: it follows the person's
 * own revoke, whose "Token revoked" toast is, or is there at load.
 */

const DAY_MS = 86_400_000;

/** The banner's accessible name: the name of its `region` landmark. */
export const TOKEN_BANNER_LABEL = "Rotate token notice";

export const SUSPENDED_BANNER =
  "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token are refused until their supervisors restart. Rotate to issue a new one: collectors on the default token that accept connection settings are handed it on one of their next polls.";

const SUSPENDED_LEAD =
  "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token";

/**
 * The suspended banner's words by whether the fleet has a valid default token, as the Tokens tab's tokens say:
 * SUSPENDED_BANNER while it has (a restarted collector comes back through it); with none valid, the clause saying to
 * issue a new default token and re-install them, and only re-installed collectors handed the new rotate token; null
 * (the tokens not read yet), words true either way. Off SUSPENDED_BANNER, "Rotate to issue a new rotate token" (never
 * "a new one", beside a new default token).
 */
export function suspendedBannerWords(defaultTokenValid: boolean | null): string {
  if (defaultTokenValid === true) return SUSPENDED_BANNER;
  if (defaultTokenValid === false) {
    return `${SUSPENDED_LEAD} are refused until their supervisors restart${NO_VALID_DEFAULT_CLAUSE}. Rotate to issue a new rotate token: collectors re-installed with a new default token that accept connection settings are handed it on one of their next polls.`;
  }
  return `${SUSPENDED_LEAD} are refused until their supervisors restart and, if the fleet has a valid default token, come back through it. Rotate to issue a new rotate token: collectors on a valid default token that accept connection settings are handed it on one of their next polls.`;
}

/** The expiring banner's words: "{in 5 days} ({date})". */
export function expiringBannerWords(expiresAt: string, now: number): string {
  return `The fleet's rotate token expires ${formatRelativeFuture(expiresAt, now)} (${formatDateTime(expiresAt)}). Rotate it before then: collectors still holding it when it expires are refused until their supervisors restart.`;
}

/** What the banner shows at `now`, or null for none: suspended, or the current token expiring under 30 days (under 7 destructive). */
export function bannerOf(
  fleet: Pick<FleetDetail, "status" | "summary">,
  now: number,
  defaultTokenValid: boolean | null = true,
): { tone: "warning" | "destructive"; words: string } | null {
  if (fleet.status === "archived") return null;
  const { rotateToken } = fleet.summary;
  if (rotateToken === null) return { tone: "destructive", words: suspendedBannerWords(defaultTokenValid) };
  if (rotateToken.expiresAt === null) return null;
  const days = (Date.parse(rotateToken.expiresAt) - now) / DAY_MS;
  if (days >= 30) return null;
  return { tone: days < 7 ? "destructive" : "warning", words: expiringBannerWords(rotateToken.expiresAt, now) };
}

const TONE_CLASS = {
  warning: "border-warn/30 bg-warn-soft text-warn",
  destructive: "border-fail/30 bg-fail-soft text-fail",
} as const;

interface TokenBannerProps {
  fleet: Pick<FleetDetail, "status" | "summary">;
  /** The time the banner is reckoned at: the tab's render. */
  now: number;
  /** "Rotate token": the tab opens the rotate dialog from `from`. */
  onRotate: (from: HTMLElement) => void;
  /** Whether the tab's tokens hold a valid default token; null before they are read. */
  defaultTokenValid: boolean | null;
}

export function TokenBanner({ fleet, now, onRotate, defaultTokenValid }: TokenBannerProps) {
  const banner = bannerOf(fleet, now, defaultTokenValid);
  if (banner === null) return null;
  return (
    <div
      role="region"
      aria-label={TOKEN_BANNER_LABEL}
      className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-[13px] ${TONE_CLASS[banner.tone]}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">{banner.words}</p>
      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={(event) => onRotate(event.currentTarget)}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Rotate token
      </Button>
    </div>
  );
}
