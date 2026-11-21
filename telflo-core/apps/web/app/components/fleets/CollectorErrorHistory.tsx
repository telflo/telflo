import type { CollectorError } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { formatDateTime } from "~/lib/format.js";

/*
 * A collector's details' error history: the opamp-server's history (its newest
 * 100 for 30 days), newest first, 20 a page with "Load more". Each error's
 * time and its message, the collector's own text, in a `<pre>` that wraps, at
 * most 12rem tall and scrolling (focusable, so a keyboard scrolls it too, and
 * a group named by the fixed "Error message", never its text: ARIA 1.2 doesn't
 * name a `<pre>` without a role, and a group, unlike a region, isn't a
 * landmark, so a history of up to 100 adds none to the landmark list). The
 * section is `ph-no-capture`, so session replay records none of it; no message
 * reaches an attribute or a toast.
 */

/** A first read that failed, and a "Load more" that failed (its toast). */
export const ERROR_HISTORY_FAILED_MESSAGE = "Failed to load the error history";

/** The fixed name of each bounded error `<pre>`, a group and a tab stop: never the error's own text. */
export const ERROR_MESSAGE_LABEL = "Error message";

/** How many errors a page holds. */
export const ERROR_HISTORY_PAGE_SIZE = 20;

/** What the details hold of the history: its first read under way or failed, or the pages read. */
export type ErrorHistoryRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "read"; errors: CollectorError[]; nextCursor: string | null; loadingMore: boolean };

interface CollectorErrorHistoryProps {
  history: ErrorHistoryRead;
  /** Reads the first page again, after it failed. */
  onRetry: () => void;
  /** Reads the next page. */
  onLoadMore: () => void;
}

export function CollectorErrorHistory({ history, onRetry, onLoadMore }: CollectorErrorHistoryProps) {
  return (
    <section className="ph-no-capture space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">Error history</h3>
      {history.state === "loading" ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading errors…
        </p>
      ) : history.state === "failed" ? (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-muted-foreground">{ERROR_HISTORY_FAILED_MESSAGE}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : history.errors.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No errors reported.</p>
      ) : (
        <>
          <ol className="space-y-2">
            {history.errors.map((error) => (
              <li key={error.id} className="rounded-md border border-border bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">{formatDateTime(error.reportedAt)}</p>
                <pre
                  role="group"
                  tabIndex={0}
                  aria-label={ERROR_MESSAGE_LABEL}
                  className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs"
                >
                  {error.message}
                </pre>
              </li>
            ))}
          </ol>
          {history.nextCursor !== null && (
            <Button type="button" variant="outline" size="sm" disabled={history.loadingMore} onClick={onLoadMore}>
              {history.loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
