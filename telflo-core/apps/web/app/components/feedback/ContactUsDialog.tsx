import { useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { FEEDBACK_TEXT_MAXIMUM_LENGTH } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Textarea } from "~/components/ui/textarea.js";
import { createFeedback, isSessionEnded } from "~/lib/api-client.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";

/*
 * "Contact us" (D29 decisions 6, 32 and 40; Preflight rulings 16 and 21),
 * the dialog from the Sidebar: "Contact Us", its sentence (the
 * curly ‘hello’), a textarea with the placeholder "Type your message
 * here...", Cancel, and Send (disabled while the text is blank, "Sending..."
 * while it sends); the toasts "Thanks for your feedback!" and "Failed to
 * submit feedback". `POST /api/v1/feedback` in the organization the person
 * acts in; every product admin is emailed about it (never its text).
 *
 * The message is the person's own words, personal data (decision 41): the
 * textarea is uncontrolled, inside `ph-no-capture` (no `value` attribute or
 * React state ever holds it; only whether it is blank), at most 5,000
 * characters as the API's cap. The toasts are fixed words. Each opening is
 * a new session (an empty box); the dialog can't close while it sends. A
 * failure keeps it open with the text, to send again; an ended session
 * says nothing (the session-ended handler has the page).
 */

export const CONTACT_US_SENT_MESSAGE = "Thanks for your feedback!";
export const CONTACT_US_FAILED_MESSAGE = "Failed to submit feedback";

export interface ContactUsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it (the rail's "Contact us"): the focus goes back to it as the dialog closes, however it closes (Ruling 271). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

export function ContactUsDialog(props: ContactUsDialogProps) {
  const opening = useOpeningKey(props.open);
  return <ContactUsSession key={opening} {...props} />;
}

function ContactUsSession({ open, onOpenChange, returnFocusTo }: ContactUsDialogProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [blank, setBlank] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const changeOpen = (next: boolean) => {
    if (!sendingRef.current) onOpenChange(next);
  };

  const send = async () => {
    const text = (field.current?.value ?? "").trim();
    if (text === "" || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await createFeedback({ text });
      toast.success(CONTACT_US_SENT_MESSAGE);
      onOpenChange(false);
    } catch (error) {
      if (!isSessionEnded(error)) toast.error(CONTACT_US_FAILED_MESSAGE);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // No Radix trigger opens it, so Radix's own close would leave the focus on the body.
          const opener = returnFocusTo?.current;
          if (opener?.isConnected !== true) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Contact Us</DialogTitle>
          <DialogDescription>
            Want us to know something? Need new connectors? Or maybe you just want to say &lsquo;hello&rsquo;. We want to hear it all, so
            send us your thoughts.
          </DialogDescription>
        </DialogHeader>
        <div className="ph-no-capture">
          <Textarea
            ref={field}
            aria-label="Message"
            placeholder="Type your message here..."
            maxLength={FEEDBACK_TEXT_MAXIMUM_LENGTH}
            rows={5}
            readOnly={sending}
            onInput={(event) => setBlank(event.currentTarget.value.trim() === "")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={blank || sending}>
            {sending ? "Sending..." : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
