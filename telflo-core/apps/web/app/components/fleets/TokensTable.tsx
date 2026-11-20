import { useId, type Ref } from "react";
import { Eye, ShieldOff } from "lucide-react";
import type { EnrollmentTokenListed } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { formatDateTime, formatRelativeTime } from "~/lib/format.js";
import { tokenStatus, tokenValidAt } from "~/lib/tokens.js";
import { expiryBucket, type TokenBucket } from "./TokenCell.js";

/*
 * A server fleet's tokens: plain table markup with the fleet screens'
 * classes (`GroupsTable`; no table component). Its details:
 *
 * - Both kinds: the default token too, in the API's order (newest first); a
 *   Kind column.
 * - Created: `formatDateTime` and the relative time.
 * - Expires: the Token badge for the token's own expiry (`expiryBucket`),
 *   or "Expired" (outline) at or past it, a revoked token's included; the
 *   date below it as text (never a `title`), none under "Never".
 * - Status by the opamp-server's rules (`tokenStatus`): "Revoked",
 *   "Expired", "Valid" (the default token), "Current", "Being replaced"
 *   with "until {date}".
 * - "Active in the last 5 minutes": the API's `activeCollectors` ("1
 *   collector", "{n} collectors"), for either kind.
 * - Reveal and Revoke on a valid token only (never on an expired one), each
 *   named for its row through `aria-labelledby` pointing at hidden text:
 *   "Reveal the default token", "Revoke the rotate token created {date}" (a
 *   kind and a date, never a name or a bearer). A fleet holding more than
 *   one default token (a revoked one followed by a new one) names each by
 *   its date too: "the default token created {date}".
 */

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

/** A token's kind as the table and the history name it. */
export function tokenKindWords(token: Pick<EnrollmentTokenListed, "kind">): string {
  return token.kind === "default" ? "Default" : "Rotate";
}

/**
 * A token named by its kind and, for a rotate token, when it was made: "the
 * default token", "the rotate token created {date}"; a default token by its
 * date too when the fleet holds more than one (`defaultTokens`, their count).
 */
export function tokenRowName(token: Pick<EnrollmentTokenListed, "kind" | "createdAt">, defaultTokens = 1): string {
  if (token.kind === "default") return defaultTokens > 1 ? `the default token created ${formatDateTime(token.createdAt)}` : "the default token";
  return `the rotate token created ${formatDateTime(token.createdAt)}`;
}

/** How many of `tokens` are default tokens: more than one names each by its date. */
export function defaultTokenCount(tokens: readonly Pick<EnrollmentTokenListed, "kind">[]): number {
  return tokens.filter((token) => token.kind === "default").length;
}

/** A token's Expires badge at `now`: "Expired" (outline) at or past its expiry, else `expiryBucket`. */
export function expiresBadge(expiresAt: string | null, now: number): TokenBucket {
  if (expiresAt !== null && Date.parse(expiresAt) <= now) return { variant: "outline", label: "Expired" };
  return expiryBucket(expiresAt, now);
}

/** "1 collector", "{n} collectors". */
export function collectorCount(count: number): string {
  return `${count} collector${count === 1 ? "" : "s"}`;
}

/** What a row's button asks for: the tab opens the dialog. */
export type TokenRowAction = "reveal" | "revoke";

export interface TokensTableProps {
  tokens: EnrollmentTokenListed[];
  /** The time the badges and statuses are reckoned at: the tab's render. */
  now: number;
  /** A row's Reveal or Revoke; `from` the button pressed, where the focus goes back as its dialog closes. */
  onAction: (action: TokenRowAction, token: EnrollmentTokenListed, from: HTMLElement) => void;
  /** The first row action shown: where the focus goes when a dialog's opener is gone. */
  firstActionRef?: Ref<HTMLButtonElement> | undefined;
}

export function TokensTable({ tokens, now, onAction, firstActionRef }: TokensTableProps) {
  const idPrefix = useId();
  const firstValid = tokens.findIndex((token) => tokenValidAt(token, now));
  const defaultTokens = defaultTokenCount(tokens);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Kind</th>
              <th className={HEAD_CLASS}>Created</th>
              <th className={HEAD_CLASS}>Expires</th>
              <th className={HEAD_CLASS}>Status</th>
              <th className={HEAD_CLASS}>Active in the last 5 minutes</th>
              <th className={HEAD_CLASS}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {tokens.map((token, index) => {
              const rowId = `${idPrefix}-token-${token.id}`;
              const expires = expiresBadge(token.expiresAt, now);
              const status = tokenStatus(token, tokens, now);
              const valid = tokenValidAt(token, now);
              const name = tokenRowName(token, defaultTokens);
              return (
                <tr key={token.id} className={ROW_CLASS}>
                  <td className={CELL_CLASS}>
                    <span className="text-[13px] font-medium text-foreground">{tokenKindWords(token)}</span>
                  </td>
                  <td className={CELL_CLASS}>
                    <div className="font-mono text-xs tabular-nums text-foreground">{formatDateTime(token.createdAt)}</div>
                    <div className="text-xs text-muted-foreground">{formatRelativeTime(token.createdAt, now)}</div>
                  </td>
                  <td className={CELL_CLASS}>
                    <Badge variant={expires.variant}>{expires.label}</Badge>
                    {token.expiresAt !== null && (
                      <div className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{formatDateTime(token.expiresAt)}</div>
                    )}
                  </td>
                  <td className={CELL_CLASS}>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    {status.label === "Being replaced" && status.until !== null && (
                      <div className="mt-0.5 text-xs text-muted-foreground">until {formatDateTime(status.until)}</div>
                    )}
                  </td>
                  <td className={CELL_CLASS}>
                    <span className="font-mono text-xs tabular-nums text-foreground">{collectorCount(token.activeCollectors)}</span>
                  </td>
                  <td className={CELL_CLASS}>
                    {valid && (
                      <div className="flex justify-end gap-1">
                        <span id={`${rowId}-reveal`} className="sr-only" hidden>
                          Reveal {name}
                        </span>
                        <Button
                          ref={index === firstValid ? firstActionRef : undefined}
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-labelledby={`${rowId}-reveal`}
                          onClick={(event) => onAction("reveal", token, event.currentTarget)}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                          Reveal
                        </Button>
                        <span id={`${rowId}-revoke`} className="sr-only" hidden>
                          Revoke {name}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-fail hover:bg-fail-soft hover:text-fail"
                          aria-labelledby={`${rowId}-revoke`}
                          onClick={(event) => onAction("revoke", token, event.currentTarget)}
                        >
                          <ShieldOff className="h-4 w-4" aria-hidden="true" />
                          Revoke
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
