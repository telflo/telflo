import type { EnrollmentTokenEvent, EnrollmentTokenEventKind, EnrollmentTokenListed } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { formatDateTime } from "~/lib/format.js";
import { TOKEN_HISTORY_FAILED_MESSAGE, type TokenHistoryRead } from "~/lib/tokens.js";
import { defaultTokenCount } from "./TokensTable.js";

/*
 * A server fleet's token history: the fleet's token events, newest first, 50
 * a page with "Load more" (`useTokensTab`'s `history`), for every member.
 * Each row: When (`formatDateTime`), Event, Token (the event's token from the
 * tokens list, by kind and creation: events carry no kind; a default token by
 * its creation too when the fleet holds more than one) and By (the member's
 * email as plain text, never a link, "—" for none). The emails are text in
 * the masked shell only: no attribute holds one. States: "Loading the token
 * history…"; "No token events yet."; "Failed to load the token history" with
 * "Try again" (the tab's reload, which reads the tokens too); a failed "Load
 * more" toasts that and keeps the rows (the hook's).
 */

/** Each event's words: `viewed` reads "Revealed". */
export const TOKEN_EVENT_WORDS: Record<EnrollmentTokenEventKind, string> = {
  issued: "Issued",
  viewed: "Revealed",
  rotated: "Rotated",
  revoked: "Revoked",
};

/** An event's token not in the tokens read (one newer than it), or with the tokens unread. */
export const TOKEN_NOT_LISTED = "A token not listed";

/**
 * The event's token by its kind and creation: "Default token" ("Default
 * token created {date}" when the fleet holds more than one), "Rotate token
 * created {date}", else TOKEN_NOT_LISTED.
 */
export function eventTokenWords(tokenId: string, tokens: readonly EnrollmentTokenListed[] | null): string {
  const token = tokens?.find((each) => each.id === tokenId);
  if (token === undefined || tokens === null) return TOKEN_NOT_LISTED;
  if (token.kind === "default") return defaultTokenCount(tokens) > 1 ? `Default token created ${formatDateTime(token.createdAt)}` : "Default token";
  return `Rotate token created ${formatDateTime(token.createdAt)}`;
}

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

interface TokenHistoryProps {
  history: TokenHistoryRead;
  /** The tab's tokens, to name each event's token; null while unread. */
  tokens: readonly EnrollmentTokenListed[] | null;
  /** "Try again" after a failed first read: the tab's reload. */
  onRetry: () => void;
}

export function TokenHistory({ history, tokens, onRetry }: TokenHistoryProps) {
  const { events } = history;
  return (
    <section className="space-y-2">
      <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">History</h3>
      {history.failed ? (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-muted-foreground">{TOKEN_HISTORY_FAILED_MESSAGE}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : events === null ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading the token history…
        </p>
      ) : events.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No token events yet.</p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-[13px]">
                <thead className="[&_tr]:border-b">
                  <tr className={ROW_CLASS}>
                    <th className={HEAD_CLASS}>When</th>
                    <th className={HEAD_CLASS}>Event</th>
                    <th className={HEAD_CLASS}>Token</th>
                    <th className={HEAD_CLASS}>By</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {events.map((event: EnrollmentTokenEvent) => (
                    <tr key={event.id} className={ROW_CLASS}>
                      <td className={`${CELL_CLASS} font-mono text-xs tabular-nums`}>{formatDateTime(event.occurredAt)}</td>
                      <td className={CELL_CLASS}>{TOKEN_EVENT_WORDS[event.event]}</td>
                      <td className={CELL_CLASS}>{eventTokenWords(event.tokenId, tokens)}</td>
                      <td className={CELL_CLASS}>{event.actor === null ? "—" : event.actor.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {history.hasMore && (
            <Button type="button" variant="outline" size="sm" disabled={history.loadingMore} onClick={history.loadMore}>
              {history.loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
