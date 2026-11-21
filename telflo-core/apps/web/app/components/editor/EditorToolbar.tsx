import { Pencil, Rocket, Save } from "lucide-react";
import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { CONFIGURATION_NAME_MAXIMUM_LENGTH } from "@telflo/contracts";
import { CollectorVersionSelect } from "~/components/editor/CollectorVersionSelect.js";
import { EditorEditActions } from "~/components/editor/EditorEditActions.js";
import { PublishDialog } from "~/components/editor/PublishDialog.js";
import { VersionSelect } from "~/components/editor/VersionSelect.js";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { updateConfiguration } from "~/lib/api-client.js";
import {
  configurationRefusalMessage,
  isOrganizationGone,
  isTermsAcceptanceRequired,
} from "~/lib/configurations.js";
import {
  ALREADY_PUBLISHED_TOOLTIP,
  EMPTY_VERSION_MESSAGE,
  PUBLISH_TOOLTIP,
} from "~/lib/editor/publishing.js";
import { usePublishVersion } from "~/lib/editor/use-publish-version.js";
import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

// The builder buttons' titles live with the buttons (EditorEditActions), re-exported here as before.
export { DELETE_TITLE, DUPLICATE_TITLE, REDO_TITLE, UNDO_TITLE } from "~/components/editor/EditorEditActions.js";

/** The toast for a rename. */
export const RENAMED_MESSAGE = "Configuration updated";
/** For a rename that failed without a refusal to show. */
export const RENAME_FAILED_MESSAGE = "Failed to update configuration";

/**
 * The editor's toolbar: the name with its inline rename, the "Unsaved" badge
 * and Save; Undo, Redo, Duplicate and Delete before Save; the version picker
 * first in the actions, then a divider; and the collector picker at the tail
 * of the left group (`CollectorVersionSelect`): the configuration's
 * distribution, locked, and the version's collector version, whose pick is
 * an unsaved change Save stores. Publish follows Save (below).
 *
 * The row fits beside the expanded sidebar at 1280 px: the actions never
 * shrink, and the left group gives way, the name truncating first (its full
 * text stays in the heading); "Collector:" shows on wide screens only
 * (`CollectorVersionSelect`), and so does "Version:", whose picker narrows
 * below them (`VersionSelect`).
 *
 * How it behaves:
 * - the pencil also shows on keyboard focus, and is labeled "Rename
 *   configuration";
 * - the name has no `title` (attributes aren't masked in replay), and the
 *   rename field is labeled with fixed text, "Configuration name";
 * - Save is disabled while a save is under way, as well as while clean;
 * - a failed rename toasts the refusal's message, or "Failed to update
 *   configuration", and keeps the field open with what was typed. A 404
 *   `organization_not_found` or a 403 `terms_acceptance_required` also
 *   revalidates the layout, as the list's dialogs do.
 * The rename's rules: Enter or blur saves, Escape cancels, a
 * blank name keeps editing, and an unchanged one sends nothing. It renames in
 * the organization the configuration was loaded in, as saves do.
 *
 * The builder buttons, with their disabled rules and the keyboard shortcuts
 * that come with them: `EditorEditActions`, shared with the playground's
 * toolbars (the same DOM).
 *
 * Publish follows Save: its rocket, and its tooltip as the button's `title`,
 * as the toolbar's other tooltips are (fixed text): "Publish this version so
 * fleets can deploy it.", "Already published" on a published version, and
 * "An empty version can't be published." while the editor's text is empty
 * (saved-but-empty text with text typed over it publishes, saving first),
 * both disabled. It is disabled too while a save, a create or a publish is
 * under way. It opens the Publish Configuration dialog, which saves unsaved
 * changes first (`usePublishVersion`). A published version is read-only:
 * Save, Publish, Undo, Redo, Duplicate and Delete are all disabled; the
 * configuration can still be renamed.
 */
export function EditorToolbar({ onSave }: { onSave: () => void }) {
  const { revalidate } = useRevalidator();
  const configuration = useEditorStore((state) => state.configuration);
  const isDirty = useEditorStore(selectIsDirty);
  const isSaving = useEditorStore((state) => state.isSaving);
  const isCreatingVersion = useEditorStore((state) => state.isCreatingVersion);
  const isPublishing = useEditorStore((state) => state.isPublishing);
  const isPublished = useEditorStore(selectIsVersionPublished);
  const isEmpty = useEditorStore((state) => state.text === "");
  const versionNumber = useEditorStore((state) => state.version?.versionNumber ?? null);
  const publish = usePublishVersion();
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState("");
  // A rename under way: Enter, then the blur that follows it, rename once.
  const renamingRef = useRef(false);

  const startEditing = () => {
    setEditedName(configuration?.name ?? "");
    setIsEditingName(true);
  };

  const handleNameSave = async () => {
    const { configuration: current, organizationId } = useEditorStore.getState();
    if (current === null || organizationId === null || renamingRef.current) return;

    const trimmedName = editedName.trim();
    if (trimmedName === "") {
      setIsEditingName(true);
      return;
    }

    if (trimmedName === current.name) {
      setEditedName(current.name);
      setIsEditingName(false);
      return;
    }

    renamingRef.current = true;
    try {
      const { configuration: renamed } = await updateConfiguration(organizationId, current.id, { name: trimmedName });
      if (useEditorStore.getState().configuration?.id !== current.id) return;
      useEditorStore.getState().renameConfiguration(renamed.name);
      toast.success(RENAMED_MESSAGE);
      setIsEditingName(false);
    } catch (error) {
      if (useEditorStore.getState().configuration?.id !== current.id) return;
      toast.error(configurationRefusalMessage(error, RENAME_FAILED_MESSAGE));
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) void revalidate();
    } finally {
      renamingRef.current = false;
    }
  };

  const handleNameCancel = () => {
    if (renamingRef.current) return;
    setEditedName(configuration?.name ?? "");
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleNameSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleNameCancel();
    }
  };

  const publishTooltip = isPublished ? ALREADY_PUBLISHED_TOOLTIP : isEmpty ? EMPTY_VERSION_MESSAGE : PUBLISH_TOOLTIP;
  const publishDisabled = isPublished || isEmpty || isSaving || isCreatingVersion || isPublishing;

  return (
    <div className="h-12 bg-card border-b border-border px-3 flex items-center justify-between gap-3">
      {/* The left group gives way first, its name truncating, so the actions stay on screen. */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Configuration Name with inline editing */}
          <div className="flex min-w-0 items-center gap-1.5 group">
            {isEditingName ? (
              <Input
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onBlur={() => void handleNameSave()}
                onKeyDown={handleNameKeyDown}
                autoFocus
                aria-label="Configuration name"
                maxLength={CONFIGURATION_NAME_MAXIMUM_LENGTH}
                className="h-7 min-w-0 text-sm font-semibold px-2 py-0"
                // Grow with the text but cap well below toolbar width —
                // names can be 200 chars, which would otherwise render an
                // ~1800px input and push the actions off-screen.
                style={{ width: `${Math.min(Math.max(editedName.length * 9, 180), 420)}px` }}
              />
            ) : (
              <>
                <h1
                  id="configuration_name"
                  className="min-w-0 max-w-[28vw] truncate text-sm font-semibold tracking-[-0.01em] text-foreground"
                >
                  {configuration?.name}
                </h1>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={startEditing}
                  aria-label="Rename configuration"
                  className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                >
                  <Pencil className="!size-3 text-muted-foreground" />
                </Button>
              </>
            )}
          </div>
          {/* Unsaved changes indicator */}
          {isDirty && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-[4px] border border-warn/25 bg-warn-soft px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-[0.07em] text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              Unsaved
            </span>
          )}
        </div>
        <CollectorVersionSelect />
      </div>

      <div className="flex shrink-0 items-center gap-2" data-tour-step="toolbar-actions">
        {/* The version picker, first, then a divider */}
        <VersionSelect />
        <div className="w-px h-5 bg-border" />

        <EditorEditActions />

        <div className="w-px h-5 bg-border" />

        <Button
          onClick={onSave}
          variant="default"
          size="sm"
          className="h-8 gap-2"
          disabled={!isDirty || isSaving || isPublished}
        >
          <Save className="w-4 h-4" />
          Save
        </Button>
        <Button
          onClick={() => setPublishDialogOpen(true)}
          variant="default"
          size="sm"
          className="h-8 gap-2"
          disabled={publishDisabled}
          title={publishTooltip}
        >
          <Rocket className="w-4 h-4" />
          Publish
        </Button>
      </div>

      {versionNumber !== null && (
        <PublishDialog
          open={publishDialogOpen}
          onOpenChange={setPublishDialogOpen}
          versionNumber={versionNumber}
          dirty={isDirty}
          publishing={isPublishing}
          onPublish={publish}
        />
      )}
    </div>
  );
}
