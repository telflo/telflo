import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { GrantProductAdminRequestSchema, type ProductAdmin } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, getProductAdmins, grantProductAdmin, isSessionEnded, removeProductAdmin } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * `/product-admin/product-admins` (D29 decisions 5, 27, 28, 39 and 41; Parity
 * Notes). The current product admins (Email, "(you)" on the caller's row, a
 * Remove on each row), and "Add product admin" taking an exact email.
 *
 * - The list is `GET /api/v1/product-admin/product-admins`, read again after
 *   each add and removal; only the latest read is shown (the reads ref), and
 *   a read that never answers is aborted after 10 s and toasts as a failure;
 *   a failed read with nothing listed shows "Try again" in the table's
 *   place, never "No product admins" (Ruling 264's state, Ruling 271).
 * - Add sends the trimmed email (`POST …/product-admins`): "Product admin
 *   added" (a grant, or a person who already was one), the field emptied;
 *   a refusal toasts the API's fixed words (404 "No verified account uses
 *   that email.", a 429), else "Failed to add product admin". An address the
 *   contract refuses is caught here first, in fixed words.
 * - Remove opens a confirmation: "Remove <email>'s product-admin role?", or
 *   for yourself "Remove your own product-admin role? You'll lose access to
 *   these pages at once." Removed: "Product admin removed", and for yourself
 *   the way out, `/app`. 409 `last_product_admin` toasts "Telflo needs at
 *   least one product admin." and closes; 404 `product_admin_not_found`
 *   (another admin's removal got there first) toasts and reads the list
 *   again; anything else toasts and leaves the confirmation open to try
 *   again.
 * - A 403 `product_admin_required` anywhere (the flag cleared since the
 *   page opened, or while a write waited) goes to `/app`, replacing the
 *   page, as the other product-admin pages; a session that ended says
 *   nothing (the session-ended handler has the browser).
 * - Each dialog's close gives the focus back to the Remove that opened it,
 *   or, when its row has gone, to the email field (useReturnFocus).
 *
 * Other people's emails are personal data (decision 41): visible text only,
 * inside the shell's `ph-mask` (the dialog too: Radix portals it into
 * `<body>`, which the shell masks); the typed email inside `ph-no-capture`,
 * uncontrolled (never React state), with no placeholder; never in an
 * attribute, a toast (fixed words only), the title or the page's address.
 * Each Remove is named through `aria-labelledby` by a fixed-word span and
 * the row's email cell: ids only in the attribute.
 */

/** A read that never answers ends after this, as a failure (the hang guard of the browser's reads). */
export const PRODUCT_ADMINS_READ_TIMEOUT_MS = 10_000;

export const PRODUCT_ADMINS_LOAD_FAILED_MESSAGE = "Failed to load product admins";
export const PRODUCT_ADMIN_ADD_FAILED_MESSAGE = "Failed to add product admin";
export const PRODUCT_ADMIN_REMOVE_FAILED_MESSAGE = "Failed to remove product admin";
export const PRODUCT_ADMIN_INVALID_EMAIL_MESSAGE = "Enter a valid email address.";

const HEAD_CLASS =
  "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

/** What the confirmation shows, taken as it opens (a snapshot, never a live row). */
interface RemoveTarget {
  admin: ProductAdmin;
  isSelf: boolean;
}

function hasCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

export function ProductAdminsPage() {
  const navigate = useNavigate();
  const myId = useUserStore((state) => state.current?.user.id ?? null);
  const [listed, setListed] = useState<{ admins: ProductAdmin[]; read: number }>({ admins: [], read: 0 });
  const [loaded, setLoaded] = useState(false);
  /** The latest read failed: "Try again" in the table's place while nothing is listed, never "No product admins" (Ruling 264's state). */
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasEmail, setHasEmail] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const reads = useRef(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const focus = useReturnFocus();
  const idPrefix = useId();

  /** The flag was cleared since the gate let the admin in, or the admin removed themselves: the page goes. */
  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    const read = ++reads.current;
    const timeout = abortAfter(PRODUCT_ADMINS_READ_TIMEOUT_MS);
    try {
      const { items } = await getProductAdmins({ signal: timeout.signal });
      if (read === reads.current) {
        setListed({ admins: items, read });
        setLoadFailed(false);
      }
    } catch (error) {
      if (read !== reads.current) return;
      setLoadFailed(true);
      if (isProductAdminRefusal(error)) {
        leave();
        return;
      }
      // The session is over: the session-ended handler, or Logout, has the page (D12 Ruling 39).
      if (!isSessionEnded(error)) toast.error(PRODUCT_ADMINS_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) setLoaded(true);
    }
  }, [leave]);

  useEffect(() => {
    void load();
  }, [load]);

  // A removal's reload dropped the row whose Remove had the focus back: on to the email field.
  useEffect(() => {
    focus.rowsChanged(listed.read);
  }, [focus, listed]);

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = emailRef.current;
    if (input === null || adding) return;
    const parsed = GrantProductAdminRequestSchema.safeParse({ email: input.value });
    if (!parsed.success) {
      toast.error(PRODUCT_ADMIN_INVALID_EMAIL_MESSAGE);
      return;
    }
    setAdding(true);
    try {
      await grantProductAdmin(parsed.data);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        leave();
        return;
      }
      const message = failureMessage(error, PRODUCT_ADMIN_ADD_FAILED_MESSAGE);
      if (message !== null) toast.error(message);
      return;
    } finally {
      setAdding(false);
    }
    input.value = "";
    setHasEmail(false);
    toast.success("Product admin added");
    await load();
  };

  /** Removes the confirmation's admin; answers whether the confirmation closes. */
  const handleRemove = async (target: RemoveTarget): Promise<boolean> => {
    try {
      await removeProductAdmin(target.admin.id);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        leave();
        return true;
      }
      if (hasCode(error, "last_product_admin")) {
        toast.error(error.message);
        return true;
      }
      if (hasCode(error, "product_admin_not_found")) {
        // Removed already, by another admin: the list catches up.
        toast.error(error.message);
        focus.wrote(reads.current);
        void load();
        return true;
      }
      const message = failureMessage(error, PRODUCT_ADMIN_REMOVE_FAILED_MESSAGE);
      if (message !== null) toast.error(message);
      return false;
    }
    toast.success("Product admin removed");
    if (target.isSelf) {
      leave();
      return true;
    }
    focus.wrote(reads.current);
    void load();
    return true;
  };

  const openRemove = (admin: ProductAdmin, opener: HTMLElement) => {
    focus.opened(opener, () => emailRef.current);
    setRemoveTarget({ admin: { ...admin }, isSelf: admin.id === myId });
  };

  return (
    <div className="p-5">
      <h1 className="mb-4 text-lg font-semibold tracking-[-0.01em] text-foreground">Product admins</h1>

      <section aria-labelledby={`${idPrefix}-add`} className="mb-5 rounded-lg border border-border bg-card p-4">
        <h2 id={`${idPrefix}-add`} className="text-sm font-semibold text-foreground">
          Add product admin
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">The exact email of a verified account.</p>
        {/* The typed email is personal data: blocked from replay, never React state (decision 41). */}
        <form className="ph-no-capture mt-3 flex items-end gap-2" onSubmit={(event) => void handleAdd(event)} noValidate>
          <div className="flex-1 max-w-sm">
            <Label htmlFor={`${idPrefix}-email`}>Email</Label>
            <Input
              ref={emailRef}
              id={`${idPrefix}-email`}
              type="email"
              name="email"
              autoComplete="off"
              spellCheck={false}
              className="mt-1"
              onInput={(event) => setHasEmail(event.currentTarget.value.trim() !== "")}
            />
          </div>
          <Button type="submit" disabled={!hasEmail || adding}>
            {adding ? "Adding..." : "Add"}
          </Button>
        </form>
      </section>

      {!loaded ? (
        <div className="flex justify-center items-center py-8">
          <div className="text-[13px] text-muted-foreground">Loading product admins...</div>
        </div>
      ) : loadFailed && listed.admins.length === 0 ? (
        <div className="flex justify-center items-center py-8">
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={HEAD_CLASS}>Email</th>
                <th className={HEAD_CLASS}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listed.admins.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                    No product admins
                  </td>
                </tr>
              ) : (
                listed.admins.map((admin) => {
                  const rowId = `${idPrefix}-admin-${admin.id}`;
                  const isSelf = admin.id === myId;
                  return (
                    <tr key={admin.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <span id={`${rowId}-email`} className="font-medium text-foreground">
                          {admin.email}
                        </span>
                        {isSelf && <span className="ml-1.5 text-muted-foreground">(you)</span>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <span id={`${rowId}-remove`} className="sr-only" hidden>
                          Remove product admin
                        </span>
                        <button
                          type="button"
                          aria-labelledby={`${rowId}-remove ${rowId}-email`}
                          onClick={(event) => openRemove(admin, event.currentTarget)}
                          className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <RemoveProductAdminDialog
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        doRemove={handleRemove}
        onCloseAutoFocus={focus.returnFocus}
      />
    </div>
  );
}

interface RemoveProductAdminDialogProps {
  /** The admin to remove, as the confirmation opened; null when closed. */
  target: RemoveTarget | null;
  onClose: () => void;
  /** Removes them; answers whether the confirmation closes (a refusal worth another try leaves it open). */
  doRemove: (target: RemoveTarget) => Promise<boolean>;
  onCloseAutoFocus: (event: Event) => void;
}

/** The confirmation of decision 39, not closable while it removes. */
function RemoveProductAdminDialog({ target, onClose, doRemove, onCloseAutoFocus }: RemoveProductAdminDialogProps) {
  const open = target !== null;
  const opening = useOpeningKey(open);
  // The last target shown, so the words stay while the dialog animates closed.
  const [shown, setShown] = useState<RemoveTarget | null>(target);
  if (target !== null && target !== shown) setShown(target);
  const [removing, setRemoving] = useState<{ opening: number } | null>(null);
  const isRemoving = removing !== null && removing.opening === opening;

  const handleRemove = async () => {
    if (target === null || isRemoving) return;
    const session = opening;
    setRemoving({ opening: session });
    try {
      if (await doRemove(target)) onClose();
    } finally {
      setRemoving((current) => (current?.opening === session ? null : current));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isRemoving && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Remove product admin</DialogTitle>
          <DialogDescription>
            {shown?.isSelf === true
              ? "Remove your own product-admin role? You'll lose access to these pages at once."
              : `Remove ${shown?.admin.email ?? "this person"}'s product-admin role?`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isRemoving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleRemove()} disabled={isRemoving}>
            {isRemoving ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
