import { Button } from "~/components/ui/button.js";
import type { CollectorsPager as PagerNumbers } from "~/lib/collectors.js";

/*
 * The Collectors tab's pager (D17b-1 decisions 2 and 21, Preflight ruling 9):
 * "Showing {from}–{to} of {total}" with Prev and Next, over the cursors of
 * the pages seen. "of {total}" only when nothing is searched or filtered (the
 * API counts nothing else); Prev disabled on page 1, Next when the page has
 * no next cursor. Both stay enabled while a person's read is under way, so
 * the focus isn't dropped: the hook ignores them meanwhile
 * (`useCollectorsPage`).
 */

/** The pager's words: "Showing 51–100 of 312", or "Showing 51–100" without a total. */
export function pagerText({ from, to, total }: PagerNumbers): string {
  return total === null ? `Showing ${from}–${to}` : `Showing ${from}–${to} of ${total}`;
}

interface CollectorsPagerProps {
  pager: PagerNumbers;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export function CollectorsPager({ pager, hasPrev, hasNext, onPrev, onNext }: CollectorsPagerProps) {
  return (
    <div className="mt-3 flex items-center justify-between">
      <p className="text-xs text-muted-foreground">{pagerText(pager)}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!hasPrev}>
          Prev
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
