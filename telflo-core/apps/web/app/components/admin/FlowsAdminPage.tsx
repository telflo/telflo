import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Flow } from "@telflo/contracts";
import { FlowAdminDialog } from "./FlowAdminDialog.js";
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
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Switch } from "~/components/ui/switch.js";
import { createFlow, deleteFlow, getFlows, isSessionEnded, updateFlow } from "~/lib/api-client.js";
import { changedFields, isPinOffered, isProductAdminRefusal, type FlowFields } from "~/lib/flows/flow-admin.js";
import { isFlowNotFound } from "~/lib/flows/flow-loaders.js";
import { useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";

/*
 * Product admin's flows page: its header, intro, table, empty state, toasts
 * ("Flow hidden" included) and delete confirmation:
 * - the flows come from the API (`GET /api/v1/flows`, the hidden ones too
 *   for a product admin), and every write goes through it;
 * - an edit sends only the fields it changed, so a pin the catalog has
 *   retired since stays unless the admin changes it;
 * - the Collector column marks a pin the catalog no longer offers, so the
 *   admin knows "Use this flow" moves copies to the default;
 * - the Visible switch's accessible name is given by hidden text rather than
 *   an `aria-label`, so the flow's name is in no attribute;
 * - a 403 `product_admin_required` (the flag cleared since the page opened)
 *   goes to `/app`, replacing the page in the history;
 * - a flow deleted since the list was read (404 `flow_not_found`, another
 *   admin's doing): its delete counts as done, "Flow deleted"; a
 *   switch or an edit of it shows the API's message ("Flow not found") and
 *   reads the list again, so its row goes;
 * - the dialog's and the confirmation's close gives the focus back to the
 *   button that opened it (New flow, the row's Edit or Delete), else, its
 *   row gone, to the header's New flow: opened without a Radix trigger,
 *   they would leave it on the body. The confirmation closes at the click,
 *   before the delete and the list's re-read have answered, so the focus
 *   goes back to the row's Delete first; once the list is read again
 *   without the row, it goes to New flow.
 */

/** The pin's mark in the Collector column: the catalog no longer offers it. */
export const PIN_NO_LONGER_OFFERED = "No longer offered";

export function FlowsAdminPage() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Flow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Flow | null>(null);
  const { distributions } = useCollectorDistributions();
  const idPrefix = useId();
  /** The button that opened the dialog or the confirmation: the focus goes back to it as that closes. */
  const opener = useRef<HTMLElement | null>(null);
  const newFlowRef = useRef<HTMLButtonElement>(null);
  /** The Delete of a row being deleted: once the list is read again, the focus left with it goes to New flow. */
  const deletedFrom = useRef<HTMLElement | null>(null);
  /** How many deletes have settled, the list read again: each checks the focus once rendered. */
  const [deletesSettled, setDeletesSettled] = useState(0);

  /** The flag was cleared since the gate let the admin in: the page goes, as the gate sends a non-admin. */
  const leave = useCallback(() => {
    void navigate("/app", { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    try {
      setFlows((await getFlows()).flows);
    } catch (error) {
      // The session is over: the session-ended handler, or Logout, has the page.
      if (!isSessionEnded(error)) toast.error("Failed to load flows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Throws to the dialog, which shows the API's message; a 403
  // product_admin_required goes to /app from there. An edit of a flow
  // deleted meanwhile reads the list again first, so its row goes.
  const handleSave = async (fields: FlowFields) => {
    if (editing) {
      try {
        await updateFlow(editing.id, changedFields(editing, fields));
      } catch (error) {
        if (isFlowNotFound(error)) await load();
        throw error;
      }
      toast.success("Flow updated");
    } else {
      await createFlow(fields);
      toast.success("Flow created");
    }
    await load();
  };

  const handlePublishedChange = async (flow: Flow, published: boolean) => {
    try {
      await updateFlow(flow.id, { published });
      toast.success(published ? "Flow is now visible" : "Flow hidden");
      await load();
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        leave();
        return;
      }
      if (isFlowNotFound(error)) {
        toast.error(error instanceof Error ? error.message : "Flow not found");
        await load();
        return;
      }
      toast.error("Failed to update the flow");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    // Still the row's Delete: the confirmation's close (returnFocus) comes after the click.
    const from = opener.current;
    try {
      try {
        await deleteFlow(deleteTarget.id);
      } catch (error) {
        // Deleted already, since the list was read: what the admin asked for.
        if (!isFlowNotFound(error)) throw error;
      }
      toast.success("Flow deleted");
      await load();
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        leave();
        return;
      }
      toast.error("Failed to delete flow");
    } finally {
      setDeleteTarget(null);
      deletedFrom.current = from;
      setDeletesSettled((count) => count + 1);
    }
  };

  // A delete settled, its re-read rendered: when the row went, taking the
  // focus that came back to its Delete with it, the focus goes to New flow;
  // never from where the person has put it since.
  useEffect(() => {
    if (deletesSettled === 0) return;
    const from = deletedFrom.current;
    deletedFrom.current = null;
    if (from === null || from.isConnected) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) newFlowRef.current?.focus();
  }, [deletesSettled]);

  const openNew = (from: HTMLElement) => {
    opener.current = from;
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (flow: Flow, from: HTMLElement) => {
    opener.current = from;
    setEditing(flow);
    setDialogOpen(true);
  };

  const openDelete = (flow: Flow, from: HTMLElement) => {
    opener.current = from;
    setDeleteTarget(flow);
  };

  /**
   * As the dialog or the confirmation closes: back to the button that opened
   * it, else (its row gone, or the empty state's New flow gone with the
   * empty state) the header's New flow. Neither has a Radix trigger, so
   * Radix's own handling would leave the focus on the body.
   */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const from = opener.current;
    opener.current = null;
    (from?.isConnected === true ? from : newFlowRef.current)?.focus();
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="flex h-13 items-center justify-between border-b border-border bg-card px-5">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Flows</h1>
        <Button ref={newFlowRef} onClick={(event) => openNew(event.currentTarget)}>
          <Plus className="h-4 w-4" />
          New flow
        </Button>
      </div>

      <div className="max-w-6xl px-5 py-5">
        <p className="mb-4 max-w-2xl text-[13px] text-muted-foreground">
          Prebuilt configurations offered to every user, published as
          <strong> Built by Telflo</strong> unless a flow names another author. Anything marked visible appears in every
          user&apos;s flow gallery (and, where public flows are on, to visitors who aren&apos;t signed in). Switch it off
          to pull a flow from the gallery without deleting it.
        </p>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
          </div>
        ) : flows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">No flows yet. The gallery is empty until you add one.</p>
            <Button variant="outline" onClick={(event) => openNew(event.currentTarget)}>
              <Plus className="h-4 w-4" />
              New flow
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-[13px]">
              <thead className="border-b border-border text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Slug</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 font-medium">Visible</th>
                  <th className="px-4 py-2.5 font-medium">Signals</th>
                  <th className="px-4 py-2.5 font-medium">Collector</th>
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {flows.map((flow) => {
                  const isTelflo = flow.source === "telflo";
                  const switchLabelId = `${idPrefix}-visible-${flow.id}`;
                  return (
                    <tr key={flow.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium text-foreground">{flow.name}</td>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">{flow.slug}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={isTelflo ? "info" : "outline"}>
                          {flow.authorName ? `Built by ${flow.authorName}` : isTelflo ? "Built by Telflo" : "Community"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {/* The name in text, which replay masks, not in an attribute. */}
                        <span id={switchLabelId} className="sr-only">
                          {flow.published
                            ? `Hide ${flow.name} from the gallery`
                            : `Show ${flow.name} on the gallery`}
                        </span>
                        <Switch
                          checked={flow.published}
                          onCheckedChange={(next) => void handlePublishedChange(flow, next)}
                          aria-labelledby={switchLabelId}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{flow.signals.join(", ")}</td>
                      <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          {flow.collectorVersion}
                          {isPinOffered(flow, distributions) === false && (
                            <Badge variant="warning">{PIN_NO_LONGER_OFFERED}</Badge>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{flow.sortOrder}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {/* Community flows are somebody else's work: an admin
                              can remove one, but editing it would silently put
                              Telflo's words in a user's mouth. */}
                          {isTelflo && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Edit"
                              onClick={(event) => openEdit(flow, event.currentTarget)}
                            >
                              <Pencil className="!size-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-fail hover:bg-fail-soft hover:text-fail"
                            title={isTelflo ? "Delete" : "Remove from catalog"}
                            onClick={(event) => openDelete(flow, event.currentTarget)}
                          >
                            <Trash2 className="!size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <FlowAdminDialog
        open={dialogOpen}
        flow={editing}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        onProductAdminLost={leave}
        onCloseAutoFocus={returnFocus}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(next) => !next && setDeleteTarget(null)}>
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the gallery and its public page starts returning 404. Configurations users already
              created from it are unaffected — they own their copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
