import { useCallback, useRef, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import type { FleetType } from "@telflo/contracts";
import { FleetTypeChooserDialog } from "~/components/fleets/FleetTypeChooserDialog.js";
import { NewKubernetesFleetDialog } from "~/components/fleets/NewKubernetesFleetDialog.js";
import { NewServerFleetDialog } from "~/components/fleets/NewServerFleetDialog.js";
import { Button } from "~/components/ui/button.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * "New Fleet". The button opens the type chooser; a type picked closes it
 * and opens that type's create dialog, in the active organization. A create
 * that finishes opens the fleet's page (the dialog's Done); one that closes
 * after an unknown outcome calls `onMayHaveCreated`, so the list reloads.
 *
 * The page holds the dialogs once (`NewFleetDialogs`, from
 * `useNewFleetDialogs`), outside whatever its content shows, and each "New
 * Fleet" (the header's, the empty state's) only opens the chooser: a list's
 * read landing mid-create (a filter's, a poll's) may swap the empty state out,
 * and a dialog held there would go with it, its bearers or its outcome lost.
 * Another organization (a switch, or a removal elsewhere) closes them, a
 * create under way too: they were for the one before.
 *
 * Closing gives the focus back to the "New Fleet" pressed, the chooser
 * handing it on to the create dialog; when that button is gone (the empty
 * state's, swapped out by a read), to the header's (`headerButton`).
 *
 * In the playground "New Fleet" opens the sign-up prompt instead,
 * locked at this opener.
 */

/** The sign-up prompt's words for "New Fleet" in the playground. */
export const NEW_FLEET_LOCKED_WORDS = "connect your own collector fleet";

/** Which of the chooser and the create dialogs is open, closed by an organization switch. */
export function useNewFleetDialogs() {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const [chooserOpen, setChooserOpen] = useState(false);
  // null: no create dialog open; a type: that type's open.
  const [fleetType, setFleetType] = useState<FleetType | null>(null);
  const [dialogsOrganizationId, setDialogsOrganizationId] = useState(organizationId);
  if (dialogsOrganizationId !== organizationId) {
    setDialogsOrganizationId(organizationId);
    setChooserOpen(false);
    setFleetType(null);
  }
  const focus = useReturnFocus();
  const locked = useLockedAction();
  // The page's header "New Fleet": the focus goes there when the one pressed is gone.
  const headerButton = useRef<HTMLButtonElement>(null);
  /** Opens the chooser; `from` the "New Fleet" pressed, where the focus goes back as the dialogs close. */
  const openChooser = useCallback(
    (from: HTMLElement | null) => {
      if (locked !== null) {
        locked(NEW_FLEET_LOCKED_WORDS, from);
        return;
      }
      focus.opened(from, () => headerButton.current);
      setChooserOpen(true);
    },
    [focus, locked],
  );
  return { organizationId, chooserOpen, setChooserOpen, fleetType, setFleetType, openChooser, headerButton, focus };
}

export type NewFleetDialogsState = ReturnType<typeof useNewFleetDialogs>;

/** "New Fleet": opens the page's chooser. Disabled with no active organization. */
export function NewFleetButton({
  dialogs,
  buttonRef,
}: {
  dialogs: NewFleetDialogsState;
  /** The header's `dialogs.headerButton`: the fallback for the focus. */
  buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  return (
    <Button ref={buttonRef} onClick={(event) => dialogs.openChooser(event.currentTarget)} disabled={dialogs.organizationId === null}>
      <Plus className="h-4 w-4" />
      New Fleet
    </Button>
  );
}

/** The chooser and the create dialogs, held once by the page. */
export function NewFleetDialogs({
  dialogs,
  onMayHaveCreated,
}: {
  dialogs: NewFleetDialogsState;
  onMayHaveCreated?: (() => void) | undefined;
}) {
  const { organizationId, chooserOpen, setChooserOpen, fleetType, setFleetType, focus } = dialogs;
  if (organizationId === null) return null;

  const closeCreate = (open: boolean) => {
    if (!open) setFleetType(null);
  };

  return (
    <>
      <FleetTypeChooserDialog
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onSelect={(type) => {
          // The chooser's close leaves the focus to the create dialog, whose close gives it back.
          focus.handOff();
          setChooserOpen(false);
          setFleetType(type);
        }}
        onCloseAutoFocus={focus.returnFocus}
      />
      <NewServerFleetDialog
        open={fleetType === "server"}
        onOpenChange={closeCreate}
        organizationId={organizationId}
        onMayHaveCreated={onMayHaveCreated}
        onCloseAutoFocus={focus.returnFocus}
      />
      <NewKubernetesFleetDialog
        open={fleetType === "kubernetes-supervisor"}
        onOpenChange={closeCreate}
        organizationId={organizationId}
        onMayHaveCreated={onMayHaveCreated}
        onCloseAutoFocus={focus.returnFocus}
      />
    </>
  );
}
