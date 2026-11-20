import { Compass } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { isPlaygroundTourCompleted } from "./playground-tour.js";

/** The dialog's title. */
export const PLAYGROUND_WELCOME_TITLE = "Welcome to the Telflo playground";

/** md and wider: the tour walks through the editor, which is desktop only itself. */
export const PLAYGROUND_TOUR_DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Whether the list offers the tour: a desktop visitor who has neither
 * dismissed the dialog nor taken the tour (one flag, the tour's completion).
 * Read in an effect, never while rendering.
 */
export function shouldOfferPlaygroundTour(): boolean {
  if (typeof window === "undefined") return false;
  if (isPlaygroundTourCompleted()) return false;
  return window.matchMedia(PLAYGROUND_TOUR_DESKTOP_QUERY).matches;
}

/*
 * `PlaygroundTourWelcomeDialog`: the first desktop visit's greeter on
 * `/playground`, offering the tour before the visitor starts clicking around.
 * Any way of closing it (the skip button, ✕, Esc, a click outside) counts as
 * "I'll explore on my own": the list marks the tour completed, so it never
 * asks again. Fixed words only.
 */
export function PlaygroundTourWelcomeDialog({
  open,
  onTakeTour,
  onSkip,
}: {
  open: boolean;
  onTakeTour: () => void;
  onSkip: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onSkip();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {/* An informational prompt: centered, as message dialogs are. */}
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle>{PLAYGROUND_WELCOME_TITLE}</DialogTitle>
          <DialogDescription>
            This is the full product running on sample data. Nothing you do here is saved, so explore freely. Want a
            quick tour of the highlights first?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
          <Button variant="outline" onClick={onSkip}>
            I&apos;ll explore on my own
          </Button>
          <Button onClick={onTakeTour}>
            <Compass className="h-4 w-4" />
            Show me around
            <span className="font-mono text-xs font-normal opacity-70">~1 min</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
