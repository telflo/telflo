import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { AdminUser, AdminUserBlockKind } from "@telflo/contracts";
import { UserDeleteDialog, type UserDeleteTarget } from "./UserDeleteDialog.js";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { abortAfter } from "~/lib/abort-after.js";
import { getAdminUsers, isSessionEnded } from "~/lib/api-client.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { useReturnFocus } from "~/lib/hooks/use-return-focus.js";
import { useSettled } from "~/lib/hooks/use-settled.js";
import { formatServiceAccountDate } from "~/lib/service-accounts.js";
import { useUserStore } from "~/lib/stores/user-store.js";

/*
 * `/product-admin/users` (D29 decisions 3, 9, 38 and 41; Preflight rulings
 * 15, 17 and 21; Ruling 258): the heading "Users", "Refresh"/"Refreshing...",
 * the filter box, the table (Email with "(you)", Created, Actions: Delete on
 * every row but the caller's), "Loading users...", "No users found" / "No
 * users match the filter", and the toasts "Failed to load users" and "Failed
 * to delete user". Per the Parity Notes:
 *
 * - The subtitle says what the platform does: people who share an
 *   organization with someone else can't be deleted until that's resolved.
 * - The search runs on the server (decision 9): the trimmed term, sent 300
 *   ms after the typing stops (useSettled), as `q`, by email or the name of
 *   any of the person's organizations; 50 a page, newest first, and "Load
 *   more" for the next page (the same term). Only the latest read is shown
 *   (the reads ref); a read that never answers is aborted after 10 s and
 *   toasts as a failure. The term is never in the page's address, an
 *   attribute or storage: the box is uncontrolled, inside `ph-no-capture`,
 *   and its text lives in state only.
 * - Delete opens UserDeleteDialog on the row as it was (a snapshot): its
 *   block, or the type-to-confirm. Deleted (or gone already), the row goes
 *   from the list. A 409 `user_delete_blocked` (a block that appeared since
 *   the list) reads the first page again with the same term and shows the
 *   block from the row taken by id; with the row gone, the kind's sentence
 *   in fixed words (Preflight ruling 15).
 * - A failed first-page read with nothing listed shows "Try again" in the
 *   rows' place, never "No users found" (Ruling 264's, as User Feedback's).
 * - A 403 `product_admin_required` (the flag cleared since the page opened,
 *   or while the delete waited) goes to `/app`, replacing the page; a
 *   session that ended says nothing (the session-ended handler has it).
 * - Each Delete is named through `aria-labelledby` by a fixed-word span and
 *   the row's email cell (ids only in the attribute); the dialog's close
 *   gives the focus back to it, or, with its row gone, to the filter box
 *   (useReturnFocus).
 *
 * Other people's emails and organization names are visible text inside the
 * shell's `ph-mask` only (decision 41): never an attribute, a toast (fixed
 * words), the title or the page's address.
 */

/** A read that never answers ends after this, as a failure (the hang guard of the browser's reads). */
export const USERS_READ_TIMEOUT_MS = 10_000;
/** The pause after the last keystroke before the term is sent (decision 38). */
export const USERS_SEARCH_DELAY_MS = 300;
export const USERS_LOAD_FAILED_MESSAGE = "Failed to load users";
export const USERS_SUBTITLE =
  "All registered accounts. People who share an organization with someone else can't be deleted until that's resolved.";

const HEAD_CLASS =
  "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

/** The rows shown, the term they were read for, the next page's cursor, and the number of the read (or removal) that set them. */
interface Listed {
  users: AdminUser[];
  term: string;
  nextCursor: string | null;
  shown: number;
}

export function UsersAdminPage() {
  const navigate = useNavigate();
  const myId = useUserStore((state) => state.current?.user.id ?? null);
  const [typed, setTyped] = useState("");
  const term = useSettled(typed.trim(), USERS_SEARCH_DELAY_MS);
  const [listed, setListed] = useState<Listed>({ users: [], term: "", nextCursor: null, shown: 0 });
  const [loaded, setLoaded] = useState(false);
  /** The latest first-page read failed: "Try again" in the rows' place until one succeeds, never "No users found" (Ruling 264). */
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [target, setTarget] = useState<UserDeleteTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** The latest first-page read begun: an older answer, or a Load more begun before it, is dropped. */
  const reads = useRef(0);
  /** Each read and each removal, numbered as it begins: what the focus return compares (useReturnFocus). */
  const changes = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const focus = useReturnFocus();
  const idPrefix = useId();

  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  /** Fails the read in the page's words: the way out on a 403, nothing when the session ended. */
  const failed = useCallback(
    (error: unknown) => {
      if (isProductAdminRefusal(error)) {
        leave();
        return;
      }
      if (!isSessionEnded(error)) toast.error(USERS_LOAD_FAILED_MESSAGE);
    },
    [leave],
  );

  /** The first page for `searched`; answers the users read, or null when it failed or a later read began. */
  const load = useCallback(
    async (searched: string): Promise<AdminUser[] | null> => {
      const read = ++reads.current;
      const shown = ++changes.current;
      const timeout = abortAfter(USERS_READ_TIMEOUT_MS);
      setRefreshing(true);
      try {
        const page = await getAdminUsers(searched === "" ? {} : { q: searched }, { signal: timeout.signal });
        if (read !== reads.current) return null;
        setListed({ users: page.items, term: searched, nextCursor: page.nextCursor, shown });
        setLoadFailed(false);
        return page.items;
      } catch (error) {
        if (read === reads.current) {
          setLoadFailed(true);
          failed(error);
        }
        return null;
      } finally {
        timeout.clear();
        if (read === reads.current) {
          setLoaded(true);
          setRefreshing(false);
        }
      }
    },
    [failed],
  );

  useEffect(() => {
    void load(term);
  }, [load, term]);

  // A removal dropped the row whose Delete had the focus back: on to the filter box.
  useEffect(() => {
    focus.rowsChanged(listed.shown);
  }, [focus, listed]);

  const loadMore = async () => {
    const { nextCursor, term: searched } = listed;
    if (nextCursor === null || loadingMore) return;
    const read = reads.current;
    const shown = ++changes.current;
    const timeout = abortAfter(USERS_READ_TIMEOUT_MS);
    setLoadingMore(true);
    try {
      const page = await getAdminUsers({ ...(searched === "" ? {} : { q: searched }), cursor: nextCursor }, { signal: timeout.signal });
      if (read !== reads.current) return;
      setListed((current) => ({
        users: [...current.users, ...page.items.filter((user) => !current.users.some((shownUser) => shownUser.id === user.id))],
        term: current.term,
        nextCursor: page.nextCursor,
        shown,
      }));
    } catch (error) {
      if (read === reads.current) failed(error);
    } finally {
      timeout.clear();
      setLoadingMore(false);
    }
  };

  const openDelete = (user: AdminUser, opener: HTMLElement) => {
    focus.opened(opener, () => searchRef.current);
    setTarget({ user });
    setDialogOpen(true);
  };

  /** Deleted, or gone already: the row goes; the dialog closes. */
  const handleDeleted = (userId: string) => {
    focus.wrote(changes.current);
    const shown = ++changes.current;
    setListed((current) => ({ ...current, users: current.users.filter((user) => user.id !== userId), shown }));
    setDialogOpen(false);
  };

  /** A block appeared since the list: the first page again, the same term, and the block from the row taken by id. */
  const handleBlocked = async (userId: string, kind: AdminUserBlockKind) => {
    focus.wrote(changes.current);
    const users = await load(listed.term);
    const found = users?.find((user) => user.id === userId);
    setTarget(found !== undefined && found.block !== null ? { user: found } : { kind });
  };

  return (
    <div className="p-5">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Users</h1>
        <Button variant="outline" onClick={() => void load(term)} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </div>
      <p className="mb-4 text-[13px] text-muted-foreground">{USERS_SUBTITLE}</p>
      <div className="ph-no-capture mb-4">
        <Input
          ref={searchRef}
          type="search"
          aria-label="Filter by email or organization"
          placeholder="Filter by email or organization..."
          autoComplete="off"
          onInput={(event) => setTyped(event.currentTarget.value)}
          className="max-w-md"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th className={HEAD_CLASS}>Email</th>
              <th className={HEAD_CLASS}>Created</th>
              <th className={HEAD_CLASS}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loaded ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  Loading users...
                </td>
              </tr>
            ) : loadFailed && listed.users.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center">
                  <Button variant="outline" onClick={() => void load(term)}>
                    Try again
                  </Button>
                </td>
              </tr>
            ) : listed.users.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  {listed.term !== "" ? "No users match the filter" : "No users found"}
                </td>
              </tr>
            ) : (
              listed.users.map((user) => {
                const rowId = `${idPrefix}-user-${user.id}`;
                const isSelf = user.id === myId;
                return (
                  <tr key={user.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-foreground">
                      <span id={`${rowId}-email`}>{user.email}</span>
                      {isSelf && <span className="ml-2 font-sans text-xs text-muted-foreground">(you)</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {formatServiceAccountDate(user.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[13px]">
                      {!isSelf && (
                        <>
                          <span id={`${rowId}-delete`} className="sr-only" hidden>
                            Delete
                          </span>
                          <button
                            type="button"
                            aria-labelledby={`${rowId}-delete ${rowId}-email`}
                            onClick={(event) => openDelete(user, event.currentTarget)}
                            className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {loaded && listed.nextCursor !== null && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            Load more
          </Button>
        </div>
      )}

      <UserDeleteDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
        onDeleted={handleDeleted}
        onBlocked={(userId, kind) => void handleBlocked(userId, kind)}
        onProductAdminLost={leave}
        onCloseAutoFocus={focus.returnFocus}
      />
    </div>
  );
}
