import type { Ref } from "react";
import { FolderInput, Pin, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { GROUPS_UNREADABLE_WORDS } from "./EditCollectorDialog.js";

/*
 * The Collectors tab's selection bar (D17b-1 decision 27; Preflight rulings 5
 * and 13): with one or more collectors selected on the page: "{n} selected",
 * Pin, Move to group (disabled, "The groups couldn't be read." beside it,
 * while the tab holds no groups), Delete and "Clear selection". Pin and
 * Delete are named "Pin selected collectors" and "Delete selected collectors"
 * (the words shown are the same), apart from the rows' and the dialogs'
 * buttons. It names no collector. It is a region, "Selected collectors", that
 * takes the focus (`tabIndex` -1) when a bulk dialog's opener is gone as it
 * closes, with the buttons' focus ring so the focus given it is seen.
 */

interface CollectorsSelectionBarProps {
  /** The bar itself: where the focus goes when a bulk dialog's button is gone. */
  ref?: Ref<HTMLDivElement> | undefined;
  count: number;
  /** Whether the tab holds the fleet's groups: Move to group needs them. */
  groupsRead: boolean;
  /** Each opens its dialog; `from` the button, where the focus goes back as it closes. */
  onPin: (from: HTMLElement) => void;
  onMove: (from: HTMLElement) => void;
  onDelete: (from: HTMLElement) => void;
  onClear: () => void;
}

export function CollectorsSelectionBar({ ref, count, groupsRead, onPin, onMove, onDelete, onClear }: CollectorsSelectionBarProps) {
  return (
    <div
      ref={ref}
      role="region"
      aria-label="Selected collectors"
      tabIndex={-1}
      className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <p className="mr-1 text-[13px] font-medium text-foreground">{count} selected</p>
      <Button type="button" variant="outline" size="sm" aria-label="Pin selected collectors" onClick={(event) => onPin(event.currentTarget)}>
        <Pin className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Pin
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={(event) => onMove(event.currentTarget)} disabled={!groupsRead}>
        <FolderInput className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Move to group
      </Button>
      {!groupsRead && <p className="text-xs text-muted-foreground">{GROUPS_UNREADABLE_WORDS}</p>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Delete selected collectors"
        onClick={(event) => onDelete(event.currentTarget)}
        className="text-fail hover:text-fail"
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Delete
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onClear} className="ml-auto">
        Clear selection
      </Button>
    </div>
  );
}
