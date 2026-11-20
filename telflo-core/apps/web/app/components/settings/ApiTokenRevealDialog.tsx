import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { API_TOKEN_REVEAL_WORDS } from "~/lib/service-accounts.js";

/*
 * "Copy your token", the one-time reveal: the token in the shared copy box,
 * inside `ph-no-capture`, as text only, its button "Copy token" (the box's
 * "Copied"; no toast), and "Done".
 *
 * The token is the page's, from the create's reply, held in its state for
 * this dialog alone and never in a store, browser storage, a query cache or
 * a URL. Done, Escape, an outside click and the X all close it through
 * `onClose`, where the page drops the token, so it is gone from the DOM and
 * from every component's state once the dialog has closed.
 */

export interface ApiTokenRevealDialogProps {
  /** The token to show once; null when closed. */
  token: string | null;
  /** However the dialog closes: the page drops the token, then reads the list again. */
  onClose: () => void;
}

export function ApiTokenRevealDialog({ token, onClose }: ApiTokenRevealDialogProps) {
  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your token</DialogTitle>
          <DialogDescription>{API_TOKEN_REVEAL_WORDS}</DialogDescription>
        </DialogHeader>
        <div className="py-2">{token !== null && <SecretCopyBox secret={token} copyLabel="Copy token" />}</div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
