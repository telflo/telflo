import type { ValidationPipeline } from "@telflo/contracts";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import type { RunTarget } from "~/lib/stores/testing-store.js";
import { isAlreadyGone, sameTarget, useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { useDialogShowing } from "../test-suites/use-dialog-showing.js";
import { DeleteValidationPipelineDialog } from "./DeleteConfirmations.js";
import { ValidationPipelineCard } from "./ValidationPipelineCard.js";
import { ValidationPipelineEditorDialog } from "./ValidationPipelineEditorDialog.js";

/** Another version's pipelines show as none: one array, so the selector answers the same each time. */
const NO_PIPELINES: ValidationPipeline[] = [];

interface ValidationPipelinesPanelProps {
  /** Called as one of the subtab's dialogs shows; what it returns, as that dialog closes (`useDialogShowing`): a Play all's switch to Tests waits. */
  onDialogShown?: (() => () => void) | undefined;
}

/**
 * The Testing tab's Validation subtab: its help, words, empty state and
 * confirmation. The version open in the editor's validation pipelines, one
 * per YAML pipeline, each a ValidationPipelineCard holding its rules; "+
 * Pipeline" creates one (ValidationPipelineEditorDialog). Pipelines and
 * rules can be created, edited and deleted on any version, published or not,
 * by anyone who can see the configuration.
 *
 * Differences:
 * - the pipelines are read each time the subtab shows and when the version
 *   changes, not once a version; a failed read shows inline with Retry
 *   ("Failed to load validation pipelines", or the API's words for a
 *   refusal), not a toast with no read again; it is announced
 *   (`role="alert"`), as a card's is;
 * - the whole panel is blocked from replay (`ph-no-capture`): pipeline names
 *   and every rule's name, description, pattern and OTTL are configuration
 *   text; its dialogs, being portals, each carry the class too;
 * - closing "New validation pipeline" gives the focus back to "+ Pipeline";
 *   a validation pipeline deleted gives it to the next card's header, else
 *   the previous one's, else "+ Pipeline"; a confirmation closed without a
 *   delete gives it back to the card's Delete, not to the page; a card gone
 *   under its own rule editor or confirmation (its pipeline "not found", a
 *   teammate's delete) gives it to "+ Pipeline"; a card gone under its
 *   pipeline's delete confirmation, to the card now at its place, else the
 *   one before, else "+ Pipeline";
 * - while any of its dialogs shows, the tab knows (`onDialogShown`): a Play
 *   all under way doesn't switch to Tests and tear the dialog away;
 * - in the playground, + Pipeline opens the sign-up prompt at its button
 *   (`useLockedAction`), as every card's change does; the pipelines and their
 *   rules read from the sample;
 * - nothing here sends an analytics event.
 */
export function ValidationPipelinesPanel({ onDialogShown }: ValidationPipelinesPanelProps) {
  const locked = useLockedAction();
  const organizationId = useEditorStore((state) => state.organizationId);
  const configurationId = useEditorStore((state) => state.configuration?.id ?? null);
  const versionId = useEditorStore((state) => state.version?.id ?? null);
  const target = useMemo<RunTarget | null>(
    () =>
      organizationId === null || configurationId === null || versionId === null
        ? null
        : { organizationId, configurationId, versionId },
    [organizationId, configurationId, versionId],
  );
  const pipelines = useValidationPipelinesStore((state) => (sameTarget(state.target, target) ? state.pipelines : NO_PIPELINES));
  const loading = useValidationPipelinesStore((state) => sameTarget(state.target, target) && state.pipelinesLoading);
  const loaded = useValidationPipelinesStore((state) => sameTarget(state.target, target) && state.pipelinesLoaded);
  const error = useValidationPipelinesStore((state) => (sameTarget(state.target, target) ? state.pipelinesError : null));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ValidationPipeline | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The place in the list of the pipeline just deleted: the focus goes to the card now there, as the confirmation closes. */
  const deletedAt = useRef<number | null>(null);
  /** The Delete validation pipeline that opened the confirmation: the focus goes back to it when the confirmation closes without a delete. */
  const deleteOpener = useRef<HTMLElement | null>(null);
  /** The place in the list of the pipeline whose confirmation is open: its card gone meanwhile, the focus goes to the card now there. */
  const openedAt = useRef<number | null>(null);
  useDialogShowing(dialogOpen, onDialogShown);
  useDialogShowing(pendingDelete !== null, onDialogShown);

  // Read afresh each time the subtab shows (it mounts) and when the version changes.
  useEffect(() => {
    if (target !== null) void useValidationPipelinesStore.getState().loadPipelines(target);
  }, [target]);

  if (target === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <ShieldCheck className="w-5 h-5 text-muted-foreground mx-auto" />
          <p className="text-[13px] text-muted-foreground">Load a configuration version to manage validation rules.</p>
        </div>
      </div>
    );
  }

  const openDelete = (validationPipeline: ValidationPipeline, opener: HTMLElement) => {
    deleteOpener.current = opener;
    openedAt.current = pipelines.findIndex((listed) => listed.id === validationPipeline.id);
    setPendingDelete(validationPipeline);
  };

  /**
   * After a delete: the card now at its place, else the one before, else
   * "+ Pipeline". Closed without one (Cancel, Escape): back to the Delete
   * that opened it, while it is there (the confirmation has no Radix
   * trigger, so Radix's own return would leave it on the page's body); its
   * card gone meanwhile (its pipeline "not found" under an abandoned rule
   * save, a teammate's delete), as after a delete.
   */
  const focusAfterDelete = (event: Event) => {
    const opener = deleteOpener.current;
    const index = deletedAt.current ?? (opener !== null && !opener.isConnected ? openedAt.current : null);
    deletedAt.current = null;
    deleteOpener.current = null;
    openedAt.current = null;
    if (index === null || index < 0) {
      if (opener === null || !opener.isConnected) return;
      event.preventDefault();
      opener.focus();
      return;
    }
    const headers = [...(listRef.current?.querySelectorAll<HTMLElement>("button[aria-expanded]") ?? [])];
    const next = headers[index] ?? headers[index - 1] ?? addRef.current;
    if (next === null || !next.isConnected) return;
    event.preventDefault();
    next.focus();
  };

  const deletePipeline = async (validationPipeline: ValidationPipeline) => {
    // Its card gone already (a Delete clicked in a confirmation that outlived it): the place it was opened at.
    const found = pipelines.findIndex((listed) => listed.id === validationPipeline.id);
    const index = found >= 0 ? found : (openedAt.current ?? -1);
    try {
      await useValidationPipelinesStore.getState().deletePipeline(target, validationPipeline.id);
      deletedAt.current = index;
    } catch (error) {
      // Already gone: it has left the list all the same.
      if (isAlreadyGone(error)) deletedAt.current = index;
      throw error;
    }
  };

  return (
    <div className="ph-no-capture flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <HelpPopover label="What are validation pipelines?" title="Validation">
          <p>
            Validation pipelines group validation rules by the YAML pipeline they check. When you run a test against a pipeline,
            only the rules in that pipeline&apos;s group are evaluated.
          </p>
        </HelpPopover>
        <button
          ref={addRef}
          type="button"
          onClick={(event) => (locked ? locked("create a validation pipeline", event.currentTarget) : setDialogOpen(true))}
          aria-label="Add validation pipeline"
          title="Add validation pipeline"
          className="inline-flex items-center gap-1 px-2 h-8 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Pipeline
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error !== null && (
          <div className="flex items-center justify-between gap-2 pb-2 text-[13px]">
            <span role="alert" className="text-fail">
              {error}
            </span>
            <button
              type="button"
              onClick={() => void useValidationPipelinesStore.getState().loadPipelines(target)}
              disabled={loading}
              className="h-7 px-2 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}
        {loading && !loaded ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground" role="status" aria-label="Loading validation pipelines">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : !loaded ? null : pipelines.length === 0 ? (
          <div className="text-center py-6 text-[13px] text-muted-foreground">No validation pipelines yet. Click + Pipeline to create one.</div>
        ) : (
          <ul ref={listRef} className="flex flex-col gap-2">
            {pipelines.map((validationPipeline) => (
              <ValidationPipelineCard
                key={validationPipeline.id}
                target={target}
                validationPipeline={validationPipeline}
                onDelete={openDelete}
                onDialogShown={onDialogShown}
                focusFallback={() => addRef.current}
              />
            ))}
          </ul>
        )}
      </div>

      <ValidationPipelineEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
        onCloseAutoFocus={(event) => {
          // Back to "+ Pipeline", its opener.
          if (addRef.current === null) return;
          event.preventDefault();
          addRef.current.focus();
        }}
      />

      <DeleteValidationPipelineDialog
        validationPipeline={pendingDelete}
        onConfirm={deletePipeline}
        onClose={() => setPendingDelete(null)}
        onCloseAutoFocus={focusAfterDelete}
      />
    </div>
  );
}
