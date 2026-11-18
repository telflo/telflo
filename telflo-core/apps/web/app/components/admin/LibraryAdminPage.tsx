import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { LibraryFile, UpdateLibraryFileRequest } from "@telflo/contracts";
import { LibraryFileDeleteDialog } from "./LibraryFileDeleteDialog.js";
import { LibraryFileDialog } from "./LibraryFileDialog.js";
import { LIBRARY_LOAD_FAILED_MESSAGE, LIBRARY_REQUEST_TIMEOUT_MS } from "~/components/library/LibraryPage.js";
import { Button } from "~/components/ui/button.js";
import { abortAfter } from "~/lib/abort-after.js";
import {
  ApiError,
  createLibraryFile,
  deleteLibraryFile,
  getLibraryFiles,
  isSessionEnded,
  updateLibraryFile,
  type LibraryFileUpload,
} from "~/lib/api-client.js";

/*
 * Product admin's Library page (`/product-admin/library`, the third tab;
 * D23-2 decisions 5, 25 and 53): its header ("Library", "New
 * File"), the table (Name, which opens the edit; Description; File, the
 * file's own name; Actions, Delete), "Loading library files...", the empty
 * row "No library files yet", and its toasts ("Library file
 * created|updated|deleted", "Failed to load library files"). As the test
 * templates' page's (D14b):
 * - the files come from the API (`GET /api/v1/library-files`, which a
 *   product admin reads with or without the current terms), every write
 *   goes through it, and the list is read again after each; only the
 *   latest read is shown, and a read that never answers is aborted after
 *   10 s and toasts as a failure;
 * - a 403 `product_admin_required` (the flag cleared since the page
 *   opened) goes to `/app`, replacing the page in the history;
 * - a file deleted since the list was read (404 `library_file_not_found`,
 *   another admin's doing): its delete counts as done; an edit of it closes
 *   the dialog, shows the API's words and reads the list again;
 * - every dialog's close gives the focus back to the button that opened it,
 *   or to "New File" when that row has gone;
 * - no name reaches an attribute, a toast or a log (decision 58): the Name
 *   column's button opens the edit by the file's id and is named by its
 *   text; each Delete is described by the name's text
 *   (`aria-describedby`). The page sits under the signed-in app's
 *   `ph-mask`; nothing is captured (decision 55).
 */

function isLibraryFileNotFound(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "library_file_not_found";
}

export function LibraryAdminPage() {
  const navigate = useNavigate();
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LibraryFile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryFile | null>(null);
  const reads = useRef(0);
  /** The button that opened the dialog showing ("New File", a row's name or Delete): the focus goes back to it as the dialog closes. */
  const dialogOpener = useRef<HTMLElement | null>(null);
  const newFileRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();

  /** The flag was cleared since the gate let the admin in: the page goes, as the gate sends a non-admin. */
  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    const read = ++reads.current;
    const timeout = abortAfter(LIBRARY_REQUEST_TIMEOUT_MS);
    try {
      const { libraryFiles: listed } = await getLibraryFiles({ signal: timeout.signal });
      if (read === reads.current) setLibraryFiles(listed);
    } catch (error) {
      if (read !== reads.current) return;
      if (error instanceof ApiError && error.code === "product_admin_required") {
        leave();
        return;
      }
      // The session is over: the session-ended handler, or Logout, has the page.
      if (!isSessionEnded(error)) toast.error(LIBRARY_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) setLoaded(true);
    }
  }, [leave]);

  useEffect(() => {
    void load();
  }, [load]);

  // Each throws to its dialog, which shows the API's words, or goes to /app
  // on a 403. An edit of a file deleted meanwhile doesn't throw: the dialog
  // closes.
  const handleCreate = async (upload: LibraryFileUpload) => {
    await createLibraryFile(upload);
    toast.success("Library file created");
    await load();
  };

  const handleUpdate = async (fileId: string, changes: UpdateLibraryFileRequest) => {
    try {
      await updateLibraryFile(fileId, changes);
    } catch (error) {
      if (!isLibraryFileNotFound(error)) throw error;
      // Deleted since the list was read: the dialog closes on the API's words, and the row goes.
      toast.error(error.message);
      await load();
      return;
    }
    toast.success("Library file updated");
    await load();
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    try {
      await deleteLibraryFile(deleteTarget.id);
    } catch (error) {
      // Deleted already, since the list was read: what the admin asked for.
      if (!isLibraryFileNotFound(error)) throw error;
    }
    toast.success("Library file deleted");
    await load();
  };

  const openCreate = (opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (fileId: string, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(libraryFiles.find((libraryFile) => libraryFile.id === fileId) ?? null);
    setDialogOpen(true);
  };

  const openDelete = (libraryFile: LibraryFile, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setDeleteTarget(libraryFile);
  };

  /** As a dialog closes, however it closes: back to the button that opened it, or "New File" when its row has gone. */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const opener = dialogOpener.current;
    dialogOpener.current = null;
    (opener?.isConnected === true ? opener : newFileRef.current)?.focus();
  };

  const headerClass =
    "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Library</h1>
        <Button ref={newFileRef} onClick={(event) => openCreate(event.currentTarget)}>
          New File
        </Button>
      </div>

      {!loaded ? (
        <div className="flex justify-center items-center py-8">
          <div className="text-[13px] text-muted-foreground">Loading library files...</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={headerClass}>Name</th>
                <th className={headerClass}>Description</th>
                <th className={headerClass}>File</th>
                <th className={headerClass}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {libraryFiles.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                    No library files yet
                  </td>
                </tr>
              ) : (
                libraryFiles.map((libraryFile) => {
                  const nameId = `${idPrefix}-name-${libraryFile.id}`;
                  return (
                    <tr key={libraryFile.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          id={nameId}
                          onClick={(event) => openEdit(libraryFile.id, event.currentTarget)}
                          className="text-left font-medium text-brand hover:underline"
                        >
                          {libraryFile.name}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-[13px] text-muted-foreground">{libraryFile.description}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {libraryFile.fileName}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          onClick={(event) => openDelete(libraryFile, event.currentTarget)}
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

      <LibraryFileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        libraryFile={editing}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />

      <LibraryFileDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        fileName={deleteTarget?.name ?? null}
        doDelete={handleDelete}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
