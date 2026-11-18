import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import type { FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";

/*
 * A fleet row's actions (D17a decisions 3, 18 and 29): icon buttons
 * "Rename" (Pencil), "Archive" or "Unarchive" (Archive, ArchiveRestore) and
 * "Delete" (Trash2), each with a fixed `title`, as D7's cards; no dropdown
 * menu (none is installed, and decision 5 adds none). No `aria-label`
 * carries the fleet's label into an attribute, which replay can't mask (a
 * D17a Parity Note): each button is named by `aria-labelledby` pointing at
 * screen-reader text ("Rename {label}" and so on), as D15a's rule rows:
 * the label is text inside the masked shell, and the ids hold the table's
 * `useId` and the fleet's id, never its label. The spans are `hidden`: an
 * `aria-labelledby` target names its button all the same, and a screen
 * reader's browse mode doesn't read each name a second time beside it.
 */

/** What a row's button asks for: the page opens the dialog (D17a Task 6). */
export type FleetRowAction = "rename" | "archive" | "unarchive" | "delete";

interface FleetRowActionsProps {
  fleet: FleetDetail;
  /** The table's `useId`: with the fleet's id, the screen-reader text's ids. */
  idPrefix: string;
  /** `from` the button pressed: where the focus goes back as its dialog closes. */
  onAction: (action: FleetRowAction, fleet: FleetDetail, from: HTMLElement) => void;
}

const BUTTON_CLASS = "h-7 w-7";

export function FleetRowActions({ fleet, idPrefix, onAction }: FleetRowActionsProps) {
  const rowId = `${idPrefix}-fleet-${fleet.id}`;
  const archived = fleet.status === "archived";
  const statusAction: FleetRowAction = archived ? "unarchive" : "archive";
  return (
    <div className="flex justify-end gap-1">
      <span id={`${rowId}-rename`} className="sr-only" hidden>
        Rename {fleet.label}
      </span>
      <span id={`${rowId}-${statusAction}`} className="sr-only" hidden>
        {archived ? "Unarchive" : "Archive"} {fleet.label}
      </span>
      <span id={`${rowId}-delete`} className="sr-only" hidden>
        Delete {fleet.label}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className={BUTTON_CLASS}
        title="Rename"
        aria-labelledby={`${rowId}-rename`}
        onClick={(event) => onAction("rename", fleet, event.currentTarget)}
      >
        <Pencil className="!size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={BUTTON_CLASS}
        title={archived ? "Unarchive" : "Archive"}
        aria-labelledby={`${rowId}-${statusAction}`}
        onClick={(event) => onAction(statusAction, fleet, event.currentTarget)}
      >
        {archived ? <ArchiveRestore className="!size-3.5" /> : <Archive className="!size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={`${BUTTON_CLASS} text-fail hover:bg-fail-soft hover:text-fail`}
        title="Delete"
        aria-labelledby={`${rowId}-delete`}
        onClick={(event) => onAction("delete", fleet, event.currentTarget)}
      >
        <Trash2 className="!size-3.5" />
      </Button>
    </div>
  );
}
