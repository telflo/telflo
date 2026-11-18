export function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * An ISO timestamp as a date and time in en-US, in the browser's own time
 * zone ("Oct 9, 2026, 7:58 AM"). "—" for none, or for one that isn't a time.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * As formatDateTime, to the second ("Oct 9, 2026, 7:58:30 AM"): for a name
 * that must tell apart two times in one minute (an install link's, by its
 * creation: D17c-2 Ruling 39). "—" for none, or for one that isn't a time.
 */
export function formatDateTimeToTheSecond(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

/**
 * How long ago an ISO timestamp was, by the largest unit that fits ("5
 * seconds ago", "3 minutes ago", "2 days ago"): the fleet list's Last Seen
 * (D17a decision 22, Preflight ruling 12). `Intl.RelativeTimeFormat`, en-US,
 * `numeric: "always"`, which reads the same in Chromium, Firefox and WebKit
 * (no date-fns, decision 5). Each unit is floored: seconds under a minute,
 * minutes under an hour, hours under a day, days under 30, months (30 days
 * each, at most 11) under 365 days, then years of 365 days. A time after
 * `now` (a clock running behind the server's) is "0 seconds ago". The
 * elapsed count is passed negated, so 0 is `-0`, which reads "0 seconds
 * ago" (a plain 0 would read "in 0 seconds"). "—" for none, or for a string
 * that isn't a time.
 */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.floor(Math.max(0, now - at) / SECOND_MS);
  if (seconds < MINUTE_S) return RELATIVE_TIME.format(-seconds, "second");
  if (seconds < HOUR_S) return RELATIVE_TIME.format(-Math.floor(seconds / MINUTE_S), "minute");
  if (seconds < DAY_S) return RELATIVE_TIME.format(-Math.floor(seconds / HOUR_S), "hour");
  const days = Math.floor(seconds / DAY_S);
  if (days < 30) return RELATIVE_TIME.format(-days, "day");
  if (days < 365) return RELATIVE_TIME.format(-Math.min(11, Math.floor(days / 30)), "month");
  return RELATIVE_TIME.format(-Math.floor(days / 365), "year");
}

/**
 * How long until an ISO timestamp, by the largest unit that fits ("in 5
 * days", "in 3 hours"): the Tokens tab's rotate-before-expiry banner (D17b-2
 * decision 28; Preflight ruling 13), where `formatRelativeTime` would clamp
 * a future time to "0 seconds ago". Its twin for the future: the same
 * `Intl.RelativeTimeFormat` (en-US, `numeric: "always"`), the same units,
 * each floored (5 days and 23 hours is "in 5 days"). A time at or before
 * `now` (a clock running ahead of the server's) is "in 0 seconds". "—" for
 * none, or for a string that isn't a time.
 */
export function formatRelativeFuture(iso: string | null, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.floor(Math.max(0, at - now) / SECOND_MS);
  if (seconds < MINUTE_S) return RELATIVE_TIME.format(seconds, "second");
  if (seconds < HOUR_S) return RELATIVE_TIME.format(Math.floor(seconds / MINUTE_S), "minute");
  if (seconds < DAY_S) return RELATIVE_TIME.format(Math.floor(seconds / HOUR_S), "hour");
  const days = Math.floor(seconds / DAY_S);
  if (days < 30) return RELATIVE_TIME.format(days, "day");
  if (days < 365) return RELATIVE_TIME.format(Math.min(11, Math.floor(days / 30)), "month");
  return RELATIVE_TIME.format(Math.floor(days / 365), "year");
}
