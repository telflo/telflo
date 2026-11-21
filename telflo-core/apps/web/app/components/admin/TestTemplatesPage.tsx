import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { TestTemplate, UpdateTestTemplateRequest } from "@telflo/contracts";
import { TestTemplateDeleteDialog } from "./TestTemplateDeleteDialog.js";
import { TestTemplateDialog } from "./TestTemplateDialog.js";
import { Button } from "~/components/ui/button.js";
import {
  ApiError,
  createTestTemplate,
  deleteTestTemplate,
  getTestTemplates,
  isSessionEnded,
  updateTestTemplate,
  type TestTemplateUpload,
} from "~/lib/api-client.js";
import { abortAfter, RUNS_REQUEST_TIMEOUT_MS } from "~/lib/stores/testing-store.js";
import { receiverTypeLabel, signalLabel } from "~/lib/test-templates/labels.js";

/*
 * Product admin's Test Templates page: its header, "New Template", the table
 * (Name, which opens the edit; Receiver Type; Signal Type; Actions, Delete),
 * "Loading templates...", the empty row "No test templates yet", and its
 * toasts:
 * - the templates come from the API (`GET /api/v1/test-templates`, which a
 *   product admin reads without the current terms, as the flows admin
 *   list), and every write goes through it; only the latest read is shown,
 *   so a slow earlier one can't overwrite a later one; a read that never
 *   answers is aborted after 10 s, as the Testing tab's reads are, and
 *   toasts as a failure;
 * - Receiver Type and Signal Type show the palette's labels and "Traces",
 *   "Logs", "Metrics", each raw value as a fallback;
 * - a 403 `product_admin_required` (the flag cleared since the page
 *   opened) goes to `/app`, replacing the page in the history, as the
 *   flows page's;
 * - a template deleted since the list was read (404
 *   `test_template_not_found`, another admin's doing): its delete counts as
 *   done, "Template deleted", as the flows page's does; an edit of it closes
 *   the dialog, shows the API's words and reads the list again, so its row
 *   goes: there is nothing left to edit;
 * - every dialog's close (Cancel, Escape, a create, an edit) gives the
 *   focus back to the button that opened it: "New Template", the row's
 *   name, the row's Delete, where the dialogs, opened without a Radix
 *   trigger, would leave it on the body; when that row has gone by the time
 *   it closes (a delete, or an edit or delete answered 404, the list read
 *   again), to "New Template";
 * - no name reaches an attribute: the Name column's button opens the edit
 *   by the template's id and is named by its text; each Delete is
 *   described by the name's text (`aria-describedby`). The page sits
 *   under the signed-in app's `ph-mask`.
 */

/** What the page says when the templates can't be read (the toast's words). */
export const TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE = "Failed to load test template files";

function isTemplateNotFound(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "test_template_not_found";
}

export function TestTemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TestTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TestTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TestTemplate | null>(null);
  const reads = useRef(0);
  /** The button that opened the dialog showing ("New Template", a row's name or Delete): the focus goes back to it as the dialog closes. */
  const dialogOpener = useRef<HTMLElement | null>(null);
  const newTemplateRef = useRef<HTMLButtonElement>(null);
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
      const { templates: listed } = await getTestTemplates({ signal: timeout.signal });
      if (read === reads.current) setTemplates(listed);
    } catch (error) {
      // The session is over: the session-ended handler, or Logout, has the page.
      if (read === reads.current && !isSessionEnded(error)) toast.error(TEMPLATES_ADMIN_LOAD_FAILED_MESSAGE);
    } finally {
      timeout.clear();
      if (read === reads.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Each throws to its dialog, which shows the API's words, or goes to /app
  // on a 403. An edit of a template deleted meanwhile doesn't throw: the
  // dialog closes.
  const handleCreate = async (upload: TestTemplateUpload) => {
    await createTestTemplate(upload);
    toast.success("Template created");
    await load();
  };

  const handleUpdate = async (templateId: string, changes: UpdateTestTemplateRequest) => {
    try {
      await updateTestTemplate(templateId, changes);
    } catch (error) {
      if (!isTemplateNotFound(error)) throw error;
      // Deleted since the list was read: the dialog closes on the API's words, and the row goes.
      toast.error(error.message);
      await load();
      return;
    }
    toast.success("Template updated");
    await load();
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    try {
      await deleteTestTemplate(deleteTarget.id);
    } catch (error) {
      // Deleted already, since the list was read: what the admin asked for.
      if (!isTemplateNotFound(error)) throw error;
    }
    toast.success("Template deleted");
    await load();
  };

  const openCreate = (opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (templateId: string, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setEditing(templates.find((template) => template.id === templateId) ?? null);
    setDialogOpen(true);
  };

  const openDelete = (template: TestTemplate, opener: HTMLElement) => {
    dialogOpener.current = opener;
    setDeleteTarget(template);
  };

  /**
   * As a dialog closes, however it closes: back to the button that opened
   * it, explicitly: the dialogs have no Radix trigger, so Radix's own
   * handling would leave the focus on the body, and a click doesn't focus
   * a button in every browser. When the template's row went on the list's
   * re-read (which ends before either dialog closes), so did that button,
   * and the focus goes to "New Template".
   */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const opener = dialogOpener.current;
    dialogOpener.current = null;
    (opener?.isConnected === true ? opener : newTemplateRef.current)?.focus();
  };

  const headerClass =
    "h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border";

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Test Templates</h1>
        <Button ref={newTemplateRef} onClick={(event) => openCreate(event.currentTarget)}>
          New Template
        </Button>
      </div>

      {!loaded ? (
        <div className="flex justify-center items-center py-8">
          <div className="text-[13px] text-muted-foreground">Loading templates...</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={headerClass}>Name</th>
                <th className={headerClass}>Receiver Type</th>
                <th className={headerClass}>Signal Type</th>
                <th className={headerClass}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                    No test templates yet
                  </td>
                </tr>
              ) : (
                templates.map((template) => {
                  const nameId = `${idPrefix}-name-${template.id}`;
                  return (
                    <tr key={template.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          id={nameId}
                          onClick={(event) => openEdit(template.id, event.currentTarget)}
                          className="text-left font-medium text-brand hover:underline"
                        >
                          {template.name}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">
                        {receiverTypeLabel(template.receiverType)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">
                        {signalLabel(template.signal)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                        <button
                          type="button"
                          onClick={(event) => openDelete(template, event.currentTarget)}
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

      <TestTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />

      <TestTemplateDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        templateName={deleteTarget?.name ?? null}
        doDelete={handleDelete}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
