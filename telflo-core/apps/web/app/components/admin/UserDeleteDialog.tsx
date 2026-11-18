import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { UserDeleteBlockedDetailsSchema, type AdminUser, type AdminUserBlock, type AdminUserBlockKind } from "@telflo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { Input } from "~/components/ui/input.js";
import { ApiError, deleteAdminUser, isSessionEnded } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { isNamedByEmail } from "~/lib/organization-names.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * A person's delete from the Users page (D29 decisions 29, 30 and 38;
 * Preflight rulings 15 and 21; Ruling 258; Parity Notes):
 *
 * - A blocked person: "Cannot delete user" and the reason, fixed words
 *   around the visible values (the email, the organization's name, the
 *   role), and Close. Each kind's sentence: `member` "… is a member of
 *   organization … (role). Remove them from the organization before
 *   deleting this account."; `owner` "… owns organization …. Remove its
 *   other members and pending invitations first." (not a transfer of
 *   ownership, which a personal organization can't make), and for a
 *   personal workspace under its default name, its owner's email, "… owns
 *   <email>'s organization. …" (D36-1 Q264; only a personal organization
 *   has an owner, migration 010's check);
 *   `product_admin` "… is a product admin. Remove their product-admin role
 *   first." When the row is gone from a re-read, the kind's sentence in
 *   fixed words only (BLOCKED_WITHOUT_ROW).
 * - Otherwise "Nuclear delete: <email>": what goes (said as the platform does
 *   it), "This cannot be undone. Type the user's email to confirm.", which
 *   labels an uncontrolled field inside `ph-no-capture` with no placeholder
 *   (`ServiceAccountDeleteDialog`'s pattern: no `value` attribute ever holds
 *   the typed text), and "Permanently delete"/"Deleting...", enabled once the
 *   trimmed text equals the email. Unclosable while it deletes; each opening
 *   a new session (an empty field).
 * - Its answers: 204 toasts "Account permanently deleted" (no email) and
 *   reports `onDeleted`; 404 `user_not_found` (deleted meanwhile) toasts the
 *   API's fixed words and reports `onDeleted` too; 409 `user_delete_blocked`
 *   (a block that appeared since the list) reports `onBlocked` with its kind,
 *   and the page shows the block from a re-read; 409 `user_delete_busy`
 *   toasts its fixed words and stays open to try again; a 403
 *   `product_admin_required` reports `onProductAdminLost` (the page goes to
 *   `/app`); a session that ended says nothing; anything else toasts the
 *   API's fixed words, else "Failed to delete user", and stays open.
 *
 * The person shown is the page's snapshot taken as it opened (or as the
 * re-read found them), never a live row. Other people's emails and
 * organization names are visible text only, inside the shell's `ph-mask`
 * (Radix portals the dialog into `<body>`, which the shell masks), never an
 * attribute, a toast or the title (decision 41).
 */

export const USER_DELETED_MESSAGE = "Account permanently deleted";
export const USER_DELETE_FAILED_MESSAGE = "Failed to delete user";
export const USER_DELETE_CONFIRM_WORDS = "This cannot be undone. Type the user's email to confirm.";

/** A block's sentence in fixed words only: the re-read no longer lists the person (Preflight ruling 15). */
export const BLOCKED_WITHOUT_ROW: Record<AdminUserBlockKind, string> = {
  member: "This account is a member of an organization someone else is in. Remove them from the organization before deleting this account.",
  owner: "This account owns an organization with other members or pending invitations. Remove its other members and pending invitations first.",
  product_admin: "This account is a product admin. Remove their product-admin role first.",
};

/** What the dialog shows: a person to confirm or a block, from the page's snapshot; or a block's kind alone. */
export type UserDeleteTarget =
  | { user: AdminUser }
  | { kind: AdminUserBlockKind };

export interface UserDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: UserDeleteTarget | null;
  /** The person is gone: deleted now, or already (404). */
  onDeleted: (userId: string) => void;
  /** 409 `user_delete_blocked`: the page reads the list again and shows the block. */
  onBlocked: (userId: string, kind: AdminUserBlockKind) => void;
  /** 403 `product_admin_required`: the caller lost the flag. */
  onProductAdminLost: () => void;
  /** Radix's `onCloseAutoFocus`: the page's focus return. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** Each opening is a new session: an empty field, the button disabled. */
export function UserDeleteDialog(props: UserDeleteDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteSession key={opening} {...props} />;
}

/** The block's sentence around the visible values (decision 38). */
function BlockReason({ email, block }: { email: string; block: AdminUserBlock }) {
  const strong = (text: string) => <span className="font-medium text-foreground">{text}</span>;
  switch (block.kind) {
    case "member":
      return (
        <>
          {strong(email)} is a member of organization {strong(block.organizationName)} ({block.role}). Remove them from the
          organization before deleting this account.
        </>
      );
    case "owner":
      // Only a personal organization has an owner (migration 010's check):
      // named by its owner's email, it is "<email>'s organization" (Q264).
      return (
        <>
          {strong(email)} owns{" "}
          {isNamedByEmail(block.organizationName, "personal") ? (
            <>{strong(`${block.organizationName}'s`)} organization</>
          ) : (
            <>organization {strong(block.organizationName)}</>
          )}
          . Remove its other members and pending invitations first.
        </>
      );
    case "product_admin":
      return <>{strong(email)} is a product admin. Remove their product-admin role first.</>;
  }
}

function kindOf(error: ApiError): AdminUserBlockKind {
  const parsed = UserDeleteBlockedDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.kind : "member";
}

function DeleteSession({ open, onOpenChange, target, onDeleted, onBlocked, onProductAdminLost, onCloseAutoFocus }: UserDeleteDialogProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const changeOpen = (next: boolean) => {
    if (!deletingRef.current) onOpenChange(next);
  };

  if (target === null) return null;

  if ("kind" in target || target.user.block !== null) {
    return (
      <AlertDialog open={open} onOpenChange={changeOpen}>
        <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot delete user</AlertDialogTitle>
            <AlertDialogDescription>
              {"kind" in target ? BLOCKED_WITHOUT_ROW[target.kind] : <BlockReason email={target.user.email} block={target.user.block!} />}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const { user } = target;
  const confirm = async () => {
    if (deletingRef.current) return;
    if ((field.current?.value ?? "").trim() !== user.email) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await deleteAdminUser(user.id);
      toast.success(USER_DELETED_MESSAGE);
      onDeleted(user.id);
    } catch (failure) {
      if (isSessionEnded(failure)) return;
      if (isProductAdminRefusal(failure)) {
        onProductAdminLost();
        return;
      }
      if (failure instanceof ApiError && failure.code === "user_delete_blocked") {
        onBlocked(user.id, kindOf(failure));
        return;
      }
      const message = failureMessage(failure, USER_DELETE_FAILED_MESSAGE);
      if (message !== null) toast.error(message);
      // Gone already, in another tab or by another admin: the row was stale.
      if (failure instanceof ApiError && failure.code === "user_not_found") onDeleted(user.id);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const confirmId = `${id}-confirm`;
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-fail">Nuclear delete: {user.email}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>This deletes the account for good, with:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>its sign-in: it can no longer sign in, and its address can register again;</li>
                <li>the organizations it has to itself, with everything in them;</li>
                <li>its API tokens, its sign-in methods and its sessions.</li>
              </ul>
              <p id={confirmId} className="font-medium text-fail">
                {USER_DELETE_CONFIRM_WORDS}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="ph-no-capture">
          <Input
            ref={field}
            aria-labelledby={confirmId}
            autoComplete="off"
            autoFocus
            readOnly={deleting}
            onInput={(event) => setMatches(event.currentTarget.value.trim() === user.email)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={deleting || !matches}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? "Deleting..." : "Permanently delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
