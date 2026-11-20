import { useCallback, useRef, useState } from "react";
import type { FleetDetail } from "@telflo/contracts";
import { useReturnFocus, type FocusFallback } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { ArchiveFleetDialog } from "./ArchiveFleetDialog.js";
import { DeleteFleetDialog } from "./DeleteFleetDialog.js";
import type { FleetRowAction } from "./FleetRowActions.js";
import { RenameFleetDialog } from "./RenameFleetDialog.js";

/*
 * The rename, archive, unarchive and delete dialogs, opened from the list's
 * rows and from the fleet's page alike: one is open at a time, for one fleet.
 * Another organization (a switch, or a removal elsewhere) closes them, as the
 * configurations page does: they were for the one before, and its fleet. Each
 * close gives the focus back to the button that opened it, else, its row gone,
 * to the page's fallback (the list's New Fleet).
 *
 * In the playground every one of them is locked at this opener: the sign-up
 * prompt opens with the action's words, and no dialog does.
 */

/** The sign-up prompt's words for each fleet action in the playground. */
export const FLEET_ACTION_LOCKED_WORDS: Record<FleetRowAction, string> = {
  rename: "rename a fleet",
  archive: "archive a fleet",
  unarchive: "unarchive a fleet",
  delete: "delete a fleet",
};

/** The dialog asked for, and its fleet. */
export interface FleetActionTarget {
  action: FleetRowAction;
  fleet: FleetDetail;
}

const NO_FALLBACK: FocusFallback = () => null;

/**
 * Which dialog is open, for which fleet, closed by an organization switch;
 * `fallback` takes the focus as one closes when its opener is gone.
 */
export function useFleetActionDialogs(organizationId: string, fallback: FocusFallback = NO_FALLBACK) {
  const focus = useReturnFocus();
  const locked = useLockedAction();
  const [target, setTarget] = useState<FleetActionTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [dialogsOrganizationId, setDialogsOrganizationId] = useState(organizationId);
  if (dialogsOrganizationId !== organizationId) {
    setDialogsOrganizationId(organizationId);
    setOpen(false);
    setTarget(null);
  }
  const latestFallback = useRef(fallback);
  latestFallback.current = fallback;
  /** Opens `action`'s dialog for `fleet`; `from` the button pressed, where the focus goes back as it closes. */
  const openFor = useCallback(
    (action: FleetRowAction, fleet: FleetDetail, from?: HTMLElement | null) => {
      if (locked !== null) {
        locked(FLEET_ACTION_LOCKED_WORDS[action], from);
        return;
      }
      focus.opened(from ?? null, () => latestFallback.current());
      setTarget({ action, fleet });
      setOpen(true);
    },
    [focus, locked],
  );
  return { target, open, setOpen, openFor, returnFocus: focus.returnFocus, wrote: focus.wrote, rowsChanged: focus.rowsChanged };
}

interface FleetActionDialogsProps {
  target: FleetActionTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** After a rename, an archive or unarchive (or an answer that leaves one unknown), or any 404 for the fleet but the delete's. */
  onChanged: () => void;
  /** After a delete, or the delete's 404 (the fleet already gone). */
  onDeleted: () => void;
  /** After a delete whose outcome is unknown (a 503, the hang guard). */
  onDeleteUnknown: () => void;
  /** Each dialog's `onCloseAutoFocus`: `useFleetActionDialogs`' `returnFocus`. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function FleetActionDialogs({
  target,
  open,
  onOpenChange,
  organizationId,
  onChanged,
  onDeleted,
  onDeleteUnknown,
  onCloseAutoFocus,
}: FleetActionDialogsProps) {
  const fleet = target?.fleet ?? null;
  const action = target?.action ?? null;
  return (
    <>
      <RenameFleetDialog
        open={open && action === "rename"}
        onOpenChange={onOpenChange}
        fleet={fleet}
        organizationId={organizationId}
        onRenamed={onChanged}
        onCloseAutoFocus={onCloseAutoFocus}
      />
      <ArchiveFleetDialog
        open={open && (action === "archive" || action === "unarchive")}
        onOpenChange={onOpenChange}
        fleet={fleet}
        action={action === "unarchive" ? "unarchive" : "archive"}
        organizationId={organizationId}
        onChanged={onChanged}
        onCloseAutoFocus={onCloseAutoFocus}
      />
      <DeleteFleetDialog
        open={open && action === "delete"}
        onOpenChange={onOpenChange}
        fleet={fleet}
        organizationId={organizationId}
        onDeleted={onDeleted}
        onReload={onDeleteUnknown}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    </>
  );
}
