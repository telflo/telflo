import { useEffect } from "react";

/**
 * Tells the Testing tab while one of the Suites subtab's dialogs shows (the
 * suite dialog, the definition dialog, either delete confirmation):
 * `onDialogShown` is called as `open` turns true, and what it returns as
 * `open` turns false or the dialog's owner unmounts. A Play doesn't switch
 * to the Tests subtab while one shows, as the switch would unmount the
 * dialog and lose what the person typed in it (D14b Ruling 50).
 */
export function useDialogShowing(open: boolean, onDialogShown: (() => () => void) | undefined): void {
  useEffect(() => (open && onDialogShown !== undefined ? onDialogShown() : undefined), [open, onDialogShown]);
}
