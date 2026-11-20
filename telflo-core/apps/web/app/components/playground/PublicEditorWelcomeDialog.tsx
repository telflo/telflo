import { useEffect, useId, useState } from "react";
import { FileText, LayoutTemplate } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";

/** The one flag: set once the visitor has chosen how to start. */
export const PUBLIC_EDITOR_WELCOME_DONE_KEY = "telflo-public-editor-welcome-done";

export const PUBLIC_EDITOR_WELCOME_TITLE = "Welcome to Telflo";
export const PUBLIC_EDITOR_WELCOME_TEXT = "Build OpenTelemetry Collector configurations visually. How would you like to start?";
export const START_BLANK_LABEL = "Start from Scratch";
export const START_EXAMPLE_LABEL = "Use a Template";
export const SKIP_TOUR_LABEL = "Skip tour";

/** How the visitor starts: an empty canvas or the example. */
export type PublicEditorStart = "blank" | "example";

/** Whether the visitor has chosen before; false when storage can't be read (the dialog shows again). */
export function isPublicEditorWelcomeDone(): boolean {
  try {
    return window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY) === "true";
  } catch {
    return false;
  }
}

function markPublicEditorWelcomeDone(): void {
  try {
    window.localStorage.setItem(PUBLIC_EDITOR_WELCOME_DONE_KEY, "true");
  } catch {
    // Storage refused: the dialog shows again on the next visit.
  }
}

/*
 * The public editor's WelcomeDialog: "Welcome to Telflo", Start from Scratch
 * or Use a Template, and "Skip tour" (the editor tour is the choice's second
 * half). It honors its "done" flag, so it shows only until a choice is made:
 * one localStorage word, `telflo-public-editor-welcome-done`, read after
 * mount (the page renders on the server too) and written once a choice is
 * made, both in effects. Until a choice it can't be dismissed: no close
 * button, Escape and an outside click do nothing. Fixed words only.
 *
 * `onStart` hears the choice and whether to take the tour.
 */
export function PublicEditorWelcomeDialog({
  onStart,
  consentPending = false,
}: {
  onStart: (start: PublicEditorStart, takeTour: boolean) => void;
  /** The cookie banner still asks (`useConsentPending`, the route's): the dialog waits for its answer. */
  consentPending?: boolean;
}) {
  /** Unknown until the flag is read; then whether to show, until a choice. */
  const [shown, setShown] = useState<"unknown" | "open" | "chosen" | "done">("unknown");
  const [skipTour, setSkipTour] = useState(false);
  const skipTourId = useId();

  // Not while the cookie banner asks (it is modal too, and would be covered); then once.
  useEffect(() => {
    if (consentPending) return;
    setShown((current) => (current !== "unknown" ? current : isPublicEditorWelcomeDone() ? "done" : "open"));
  }, [consentPending]);

  useEffect(() => {
    if (shown === "chosen") markPublicEditorWelcomeDone();
  }, [shown]);

  const choose = (start: PublicEditorStart) => {
    setShown("chosen");
    onStart(start, !skipTour);
  };

  return (
    <Dialog open={shown === "open"}>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="mb-2 flex items-center justify-center gap-2">
            <img src="/telflo-logo-dark.svg" alt="Telflo" className="h-10 w-auto dark:hidden" />
            <img src="/telflo-logo-full.svg" alt="Telflo" className="hidden h-10 w-auto dark:block" />
          </div>
          <DialogTitle>{PUBLIC_EDITOR_WELCOME_TITLE}</DialogTitle>
          <DialogDescription>{PUBLIC_EDITOR_WELCOME_TEXT}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button variant="outline" className="flex h-auto flex-col items-center gap-2 p-4" onClick={() => choose("blank")}>
            <FileText className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">{START_BLANK_LABEL}</span>
          </Button>
          <Button variant="outline" className="flex h-auto flex-col items-center gap-2 p-4" onClick={() => choose("example")}>
            <LayoutTemplate className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">{START_EXAMPLE_LABEL}</span>
          </Button>
        </div>

        <div className="flex items-center justify-center gap-2 pt-1">
          <input
            type="checkbox"
            id={skipTourId}
            checked={skipTour}
            onChange={(event) => setSkipTour(event.target.checked)}
            className="rounded border-input"
          />
          <label htmlFor={skipTourId} className="cursor-pointer select-none text-xs text-muted-foreground">
            {SKIP_TOUR_LABEL}
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
