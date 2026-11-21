import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import { FEEDBACK_DEFAULT_REPLY, FEEDBACK_REPLY_MAXIMUM_LENGTH, type UserFeedbackItem } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Textarea } from "~/components/ui/textarea.js";
import { acknowledgeFeedback, ApiError, dismissFeedback, getUserFeedback, isSessionEnded } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { formatDateTime } from "~/lib/format.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { abortAfter } from "~/lib/abort-after.js";
import { RUNS_REQUEST_TIMEOUT_MS } from "~/lib/stores/testing-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * `/product-admin/user-feedback`: the heading "Pending User Feedback",
 * "Loading feedback...", the table (Email, Feedback, Created At, Actions), "No
 * pending user feedback", the full text in a dialog titled "Feedback" (sr-only
 * "Full feedback text"), Acknowledge's dialog ("Acknowledge Feedback", "Edit
 * the response below. This will be emailed to the user.", the default reply,
 * Cancel, Ok / "Sending..." disabled while blank) and Dismiss; the toasts
 * "Feedback acknowledged", "Feedback dismissed", "Failed to acknowledge
 * feedback", "Failed to dismiss feedback".
 *
 * - the pending items come from the API, newest first, 25 a page, with "Load
 *   more"; a handled item leaves the list at once, and the layout is
 *   revalidated after each acknowledge or dismiss so the nav's pending count
 *   follows;
 * - a deleted sender's row shows their anonymous address and only Dismiss
 *   (an acknowledge would email no one: 409 `feedback_author_deleted`);
 * - the truncated text's button has no `title` holding the text, and each
 *   row's Acknowledge and Dismiss are named through `aria-labelledby` (the
 *   button itself and the row's email cell: ids only in the attribute);
 * - the reply's textarea is uncontrolled, inside `ph-no-capture`, at most
 *   5,000 characters; the reply is never stored (the API emails it);
 * - a refusal for the item (missing or handled meanwhile, its sender
 *   deleted) shows the API's fixed words and reads the list again; a 403
 *   `product_admin_required` (the flag cleared since the page opened) goes
 *   to `/app`, as the other admin pages; an ended session says nothing (the
 *   session-ended handler has the page); a read that never answers ends
 *   after 10 s as a failure, "Failed to load feedback"; a failed read with
 *   nothing listed shows "Try again" in the table's place, never "No pending
 *   user feedback".
 *
 * Other people's emails and feedback are personal data: visible text only,
 * inside the shell's `ph-mask` (and `<body>`'s, where Radix portals the
 * dialogs); toasts are fixed words or the API's (which name no one).
 */

export const FEEDBACK_ADMIN_LOAD_FAILED_MESSAGE = "Failed to load feedback";
export const FEEDBACK_ACKNOWLEDGED_MESSAGE = "Feedback acknowledged";
export const FEEDBACK_DISMISSED_MESSAGE = "Feedback dismissed";
export const FEEDBACK_ACKNOWLEDGE_FAILED_MESSAGE = "Failed to acknowledge feedback";
export const FEEDBACK_DISMISS_FAILED_MESSAGE = "Failed to dismiss feedback";

/** The item is gone from the pending list (another admin handled it) or can't be acknowledged (its sender deleted): the list is read again. */
function isStaleItem(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "feedback_not_found" || error.code === "feedback_author_deleted");
}

const HEADER_CLASS =
  "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

export function UserFeedbackAdminPage() {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [items, setItems] = useState<UserFeedbackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The latest first-page read failed: "Try again" in the table's place until one succeeds (never "No pending user feedback"). */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());
  /** The dismissals in flight, read at the click: a second press of the same Dismiss sends nothing. */
  const dismissingRef = useRef(new Set<string>());
  /** The full-text dialog's item, kept while it closes (its text doesn't empty mid-animation); `shownOpen` opens it. */
  const [shown, setShown] = useState<UserFeedbackItem | null>(null);
  const [shownOpen, setShownOpen] = useState(false);
  const [acknowledging, setAcknowledging] = useState<UserFeedbackItem | null>(null);
  const reads = useRef(0);
  /** The button that opened the dialog showing (a row's text or Acknowledge): the focus goes back to it as the dialog closes. */
  const dialogOpener = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** A dismissed row held the focus: its index, so the focus goes to the row now there (or the one before, or the heading). */
  const focusAfterRemoval = useRef<number | null>(null);
  const idPrefix = useId();

  /** The flag was cleared since the gate let the admin in: the page goes, as the gate sends a non-admin. */
  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  /** The first page afresh; an earlier read or "Load more" still answering is dropped. */
  const load = useCallback(async () => {
    const read = ++reads.current;
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    try {
      const page = await getUserFeedback({}, { signal: timeout.signal });
      if (read !== reads.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setLoadFailed(false);
    } catch (error) {
      if (read !== reads.current) return;
      setLoadFailed(true);
      if (isProductAdminRefusal(error)) leave();
      else if (!isSessionEnded(error)) toast.error(FEEDBACK_ADMIN_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) {
        setLoaded(true);
        setLoadingMore(false);
      }
    }
  }, [leave]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const read = reads.current;
    setLoadingMore(true);
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    try {
      const page = await getUserFeedback({ cursor: nextCursor }, { signal: timeout.signal });
      if (read !== reads.current) return;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (read !== reads.current) return;
      if (isProductAdminRefusal(error)) leave();
      else if (!isSessionEnded(error)) toast.error(FEEDBACK_ADMIN_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) setLoadingMore(false);
    }
  };

  /**
   * After a row the focus was in has gone: the first action of the row now
   * at its place, else of the row before it, else the heading, never the
   * body.
   */
  useLayoutEffect(() => {
    const index = focusAfterRemoval.current;
    if (index === null) return;
    focusAfterRemoval.current = null;
    const row = items[index] ?? items[index - 1];
    const action =
      row === undefined
        ? null
        : (document.getElementById(`${idPrefix}-${row.id}-acknowledge`) ?? document.getElementById(`${idPrefix}-${row.id}-dismiss`));
    (action ?? headingRef.current)?.focus();
  }, [items, idPrefix]);

  /**
   * Every loaded row handled while more are pending (`nextCursor`): the
   * first page is read again, so the rest show, never "No pending user
   * feedback" with Load more hidden.
   */
  useEffect(() => {
    if (loaded && !loadFailed && !loadingMore && items.length === 0 && nextCursor !== null) void load();
  }, [loaded, loadFailed, loadingMore, items.length, nextCursor, load]);

  /** A handled item leaves the list; the layout reads the pending count again. */
  const handled = (feedbackId: string, heldFocus = false) => {
    setItems((current) => {
      if (heldFocus) focusAfterRemoval.current = current.findIndex((item) => item.id === feedbackId);
      return current.filter((item) => item.id !== feedbackId);
    });
    void revalidate();
  };

  /**
   * A refusal (`fallback` the action's words): 403 leaves; an ended session
   * says nothing; otherwise a toast, the API's words or `fallback`; an item
   * handled meanwhile or whose sender was deleted reads the list again.
   * Answers whether the dialog that asked should close.
   */
  const refused = (error: unknown, fallback: string): boolean => {
    if (isProductAdminRefusal(error)) {
      leave();
      return true;
    }
    const message = failureMessage(error, fallback);
    if (message !== null) toast.error(message, { className: "ph-no-capture" });
    if (!isStaleItem(error)) return message === null;
    void load();
    void revalidate();
    return true;
  };

  const dismiss = async (item: UserFeedbackItem) => {
    if (dismissingRef.current.has(item.id)) return;
    dismissingRef.current.add(item.id);
    setDismissing((current) => new Set(current).add(item.id));
    try {
      await dismissFeedback(item.id);
      toast.success(FEEDBACK_DISMISSED_MESSAGE);
      const row = document.getElementById(`${idPrefix}-${item.id}-dismiss`)?.closest("tr");
      handled(item.id, row != null && row.contains(document.activeElement));
    } catch (error) {
      refused(error, FEEDBACK_DISMISS_FAILED_MESSAGE);
    } finally {
      dismissingRef.current.delete(item.id);
      setDismissing((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  /** Throws nothing: answers whether the dialog closes. */
  const acknowledge = async (item: UserFeedbackItem, reply: string): Promise<boolean> => {
    try {
      await acknowledgeFeedback(item.id, { reply });
    } catch (error) {
      return refused(error, FEEDBACK_ACKNOWLEDGE_FAILED_MESSAGE);
    }
    toast.success(FEEDBACK_ACKNOWLEDGED_MESSAGE);
    handled(item.id);
    return true;
  };

  /** As a dialog closes, however it closes: back to the button that opened it, or the heading once its row has gone. */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const opener = dialogOpener.current;
    dialogOpener.current = null;
    (opener?.isConnected === true ? opener : headingRef.current)?.focus();
  };

  return (
    <div className="p-5">
      <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold tracking-[-0.01em] text-foreground mb-4 focus:outline-none">
        Pending User Feedback
      </h1>

      {!loaded ? (
        <div className="flex justify-center items-center py-8">
          <div className="text-[13px] text-muted-foreground">Loading feedback...</div>
        </div>
      ) : loadFailed && items.length === 0 ? (
        <div className="flex justify-center items-center py-8">
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={HEADER_CLASS}>Email</th>
                  <th className={HEADER_CLASS}>Feedback</th>
                  <th className={HEADER_CLASS}>Created At</th>
                  <th className={HEADER_CLASS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                      {nextCursor === null ? "No pending user feedback" : "Loading feedback..."}
                    </td>
                  </tr>
                ) : (
                  items.map((item) => {
                    const rowId = `${idPrefix}-${item.id}`;
                    return (
                      <tr key={item.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                        <td id={`${rowId}-email`} className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-foreground">
                          {item.email}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] text-foreground max-w-md">
                          <button
                            type="button"
                            onClick={(event) => {
                              dialogOpener.current = event.currentTarget;
                              setShown(item);
                              setShownOpen(true);
                            }}
                            className="block max-w-md truncate text-brand hover:underline text-left"
                          >
                            {item.text}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {formatDateTime(item.createdAt)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-[13px] space-x-1">
                          {!item.authorDeleted && (
                            <button
                              type="button"
                              id={`${rowId}-acknowledge`}
                              aria-labelledby={`${rowId}-acknowledge ${rowId}-email`}
                              onClick={(event) => {
                                dialogOpener.current = event.currentTarget;
                                setAcknowledging(item);
                              }}
                              className="rounded-[4px] px-1.5 py-0.5 font-medium text-ok hover:bg-ok-soft"
                            >
                              Acknowledge
                            </button>
                          )}
                          <button
                            type="button"
                            id={`${rowId}-dismiss`}
                            aria-labelledby={`${rowId}-dismiss ${rowId}-email`}
                            // aria-disabled, never disabled, while it sends: browsers move the focus off a button the moment
                            // it is disabled, to the body, so the focus couldn't follow the row's removal; the guard in
                            // dismiss() refuses the second press.
                            aria-disabled={dismissing.has(item.id) ? true : undefined}
                            onClick={() => void dismiss(item)}
                            className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                          >
                            Dismiss
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {nextCursor !== null && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={shownOpen} onOpenChange={setShownOpen}>
        <DialogContent onCloseAutoFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
            <DialogDescription className="sr-only">Full feedback text</DialogDescription>
          </DialogHeader>
          <p className="text-[13px] text-foreground whitespace-pre-wrap break-words">{shown?.text}</p>
        </DialogContent>
      </Dialog>

      <AcknowledgeDialog
        item={acknowledging}
        onClose={() => setAcknowledging(null)}
        onAcknowledge={acknowledge}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}

interface AcknowledgeDialogProps {
  item: UserFeedbackItem | null;
  onClose: () => void;
  /** Answers whether the dialog closes (a success, or a refusal that read the list again). */
  onAcknowledge: (item: UserFeedbackItem, reply: string) => Promise<boolean>;
  onCloseAutoFocus: (event: Event) => void;
}

/** Each opening is a new session: the default reply, Ok enabled. */
function AcknowledgeDialog(props: AcknowledgeDialogProps) {
  const opening = useOpeningKey(props.item !== null);
  return <AcknowledgeSession key={opening} {...props} />;
}

/**
 * The item is the row's when the dialog opened (a snapshot: the list's
 * reload doesn't change it). The reply is uncontrolled, inside
 * `ph-no-capture`; only whether it is blank is state. Unclosable while it
 * sends; a failure keeps it open with the reply, to send again.
 */
function AcknowledgeSession({ item, onClose, onAcknowledge, onCloseAutoFocus }: AcknowledgeDialogProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [blank, setBlank] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const changeOpen = (open: boolean) => {
    if (!open && !sendingRef.current) onClose();
  };

  const send = async () => {
    if (item === null || sendingRef.current) return;
    const reply = (field.current?.value ?? "").trim();
    if (reply === "") return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (await onAcknowledge(item, reply)) {
        sendingRef.current = false;
        onClose();
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={changeOpen}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Acknowledge Feedback</DialogTitle>
          <DialogDescription>Edit the response below. This will be emailed to the user.</DialogDescription>
        </DialogHeader>
        <div className="ph-no-capture">
          <Textarea
            ref={field}
            aria-label="Response"
            defaultValue={FEEDBACK_DEFAULT_REPLY}
            maxLength={FEEDBACK_REPLY_MAXIMUM_LENGTH}
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
            {sending ? "Sending..." : "Ok"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
