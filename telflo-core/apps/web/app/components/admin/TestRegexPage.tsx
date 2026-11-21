import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { CreateTestRegexRequest, TestRegex, UpdateTestRegexRequest } from "@telflo/contracts";
import { TestRegexDeleteDialog } from "./TestRegexDeleteDialog.js";
import { TestRegexDialog } from "./TestRegexDialog.js";
import { Button } from "~/components/ui/button.js";
import {
  ApiError,
  createTestRegex,
  deleteTestRegex,
  getTestRegexes,
  isSessionEnded,
  updateTestRegex,
} from "~/lib/api-client.js";
import { abortAfter, RUNS_REQUEST_TIMEOUT_MS } from "~/lib/stores/testing-store.js";

/*
 * Product admin's Test Regex page: its header, "New Regex", the table (Name,
 * which opens the edit; Category; Regex; Actions, Delete), "Loading
 * regexes...", the empty row "No test regexes yet", and its toasts ("Regex
 * created", "Regex updated", "Regex deleted", "Failed to load test
 * regexes"). With the Test Templates page's conventions:
 * - the library comes from the API (`GET /api/v1/test-regexes`, which a
 *   product admin reads without the current terms), in the API's order
 *   (category, then name), and every write goes through it; the list is
 *   read again after each create, edit and delete, so a new or renamed
 *   entry takes its place in that order; only the latest read is shown, so a
 *   slow earlier one can't overwrite a later one; a read that never answers
 *   is aborted after 10 s, as the Testing tab's reads are, and toasts as a
 *   failure;
 * - the Regex column shows each regex in full, wrapped, with no title and no
 *   disclosure: the text stays text;
 * - a 403 `product_admin_required` (the flag cleared since the page
 *   opened) goes to `/app`, replacing the page in the history, as the
 *   flows and templates pages';
 * - an entry deleted since the list was read (404 `test_regex_not_found`,
 *   another admin's doing): its delete counts as done, "Regex deleted"; an
 *   edit of it closes the dialog, shows the API's words and reads the list
 *   again, so its row goes;
 * - every dialog's close (Cancel, Escape, a create, an edit) gives the
 *   focus back to the button that opened it: "New Regex", the row's name,
 *   the row's Delete; when that row has gone by the time it closes, to "New
 *   Regex";
 * - an entry's name, category, description and regex are configuration
 *   text: the page sits inside `ph-no-capture` (and so does each
 *   dialog, which Radix portals out of it), no entry's text reaches an
 *   attribute (the Name column's button opens the edit by the entry's id and
 *   is named by its text; each Delete is described by the name's text,
 *   `aria-describedby`), and a toast carrying an error's words is blocked
 *   too (`ph-no-capture`): the Toaster sits outside every block.
 */

/** What the page says when the library can't be read (the toast's words). */
export const TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE = "Failed to load test regexes";

function isTestRegexNotFound(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "test_regex_not_found";
}

export function TestRegexPage() {
  const navigate = useNavigate();
  const [testRegexes, setTestRegexes] = useState<TestRegex[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TestRegex | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestRegex | null>(null);
  const reads = useRef(0);
  /** The button that opened the dialog showing ("New Regex", a row's name or Delete): the focus goes back to it as the dialog closes. */
  const dialogOpener = useRef<HTMLElement | null>(null);
  const newRegexRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();

  /** The flag was cleared since the gate let the admin in: the page goes, as the gate sends a non-admin. */
  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    const read = ++reads.current;
    // A read that never answers ends after the hang guard, as a failure.
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    try {
      const { testRegexes: listed } = await getTestRegexes({ signal: timeout.signal });
      if (read === reads.current) setTestRegexes(listed);
    } catch (error) {
      // The session is over: the session-ended handler, or Logout, has the page.
      if (read === reads.current && !isSessionEnded(error)) toast.error(TEST_REGEXES_ADMIN_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Each throws to its dialog, which shows the API's words (under the field
  // they are about, or in a toast), or goes to /app on a 403. An edit of an
  // entry deleted meanwhile doesn't throw: the dialog closes.
  const handleCreate = async (request: CreateTestRegexRequest) => {
    await createTestRegex(request);
    toast.success("Regex created");
    await load();
  };

  const handleUpdate = async (testRegexId: string, changes: UpdateTestRegexRequest) => {
    try {
      await updateTestRegex(testRegexId, changes);
    } catch (error) {
      if (!isTestRegexNotFound(error)) throw error;
      // Deleted since the list was read: the dialog closes on the API's words, and the row goes.
      toast.error(error.message, { className: "ph-no-capture" });
      await load();
      return;
    }
    toast.success("Regex updated");
    await load();
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    try {
      await deleteTestRegex(deleteTarget.id);
    } catch (error) {
      // Deleted already, since the list was read: what the admin asked for.
      if (!isTestRegexNotFound(error)) throw error;
    }
    toast.success("Regex deleted");
    await load();
  };

  const openCreate = (opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (testRegexId: string, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(testRegexes.find((testRegex) => testRegex.id === testRegexId) ?? null);
    setDialogOpen(true);
  };

  const openDelete = (testRegex: TestRegex, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setDeleteTarget(testRegex);
  };

  /**
   * As a dialog closes, however it closes: back to the button that opened
   * it, explicitly: the dialogs have no Radix trigger, so Radix's own
   * handling would leave the focus on the body. When the entry's row went on
   * the list's re-read (which ends before either dialog closes), so did that
   * button, and the focus goes to "New Regex".
   */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const opener = dialogOpener.current;
    dialogOpener.current = null;
    (opener?.isConnected === true ? opener : newRegexRef.current)?.focus();
  };

  const headerClass =
    "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

  return (
    // Configuration text, all of it: blocked from replay.
    <div className="ph-no-capture p-5">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Test Regex</h1>
        <Button ref={newRegexRef} onClick={(event) => openCreate(event.currentTarget)}>
          New Regex
        </Button>
      </div>

      {!loaded ? (
        <div className="flex justify-center items-center py-8">
          <div className="text-[13px] text-muted-foreground">Loading regexes...</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={headerClass}>Name</th>
                <th className={headerClass}>Category</th>
                <th className={headerClass}>Regex</th>
                <th className={headerClass}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {testRegexes.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                    No test regexes yet
                  </td>
                </tr>
              ) : (
                testRegexes.map((testRegex) => {
                  const nameId = `${idPrefix}-name-${testRegex.id}`;
                  return (
                    <tr key={testRegex.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          id={nameId}
                          onClick={(event) => openEdit(testRegex.id, event.currentTarget)}
                          className="text-left font-medium text-brand hover:underline"
                        >
                          {testRegex.name}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">{testRegex.category}</td>
                      {/* In full, wrapped: no truncation, no title. */}
                      <td className="px-3 py-2.5 font-mono text-xs text-foreground whitespace-pre-wrap break-all max-w-md">
                        {testRegex.regex}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          onClick={(event) => openDelete(testRegex, event.currentTarget)}
                          aria-describedby={nameId}
                          className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft"
                        >
                          Delete
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

      <TestRegexDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        testRegex={editing}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />

      <TestRegexDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        regexName={deleteTarget?.name ?? null}
        doDelete={handleDelete}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
