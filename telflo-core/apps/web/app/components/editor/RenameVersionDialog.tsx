import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH, type ConfigurationVersionSummary } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { renameConfigurationVersion } from "~/lib/api-client.js";
import { configurationRefusalMessage, isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { isVersionPublishedRefusal, rereadVersion } from "~/lib/editor/publishing.js";
import { versionLabelText } from "~/lib/editor/version-label.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/** The toasts for a version's rename. */
export const VERSION_RENAMED_MESSAGE = "Version renamed";
export const RENAME_VERSION_FAILED_MESSAGE = "Failed to rename version. Please try again.";

interface RenameVersionDialogProps {
  /** The version to rename; the dialog is open while there is one. */
  version: ConfigurationVersionSummary | null;
  onOpenChange: (open: boolean) => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`). */
  onCloseAutoFocus?: (event: Event) => void;
}

/*
 * The Rename Version dialog (ADR 0018; D10 decision 12): "Version
 * name", at most 80 characters, prefilled with the label shown ("Version N"
 * for an unnamed version) and focused; Save is disabled while the name is
 * blank, and while the rename is under way, when it reads "Saving…" and
 * everything is disabled. Differences, all in the D10 Parity Notes:
 * - a name unchanged from the one shown (after trimming) closes the dialog
 *   and sends nothing, so "Version N" is never stored as a label;
 * - a failure keeps the dialog open with what was typed, the focus back in
 *   the field, which was disabled meanwhile (D10 Ruling 44), toasting the
 *   refusal's message or "Failed to rename version. Please try again.", and a
 *   404 `organization_not_found` or a 403 `terms_acceptance_required`
 *   revalidates the layout, as the configuration's rename does (D8 decision
 *   14; D10 Preflight ruling 15). A 409 `configuration_version_published` (a
 *   teammate published it since the picker listed it; D11b) toasts its
 *   message and closes the dialog, since no name will be taken, and the
 *   version is read again (`rereadVersion`), as a save's refusal does, so its
 *   row shows the lock and, when it is the open version, the editor locks
 *   (Ruling 31) with its published content as the baseline (Ruling 35).
 * It renames in the organization the configuration was loaded in, as saves
 * do. On success it toasts "Version renamed", and the picker's
 * row and trigger show the new label (the store's `setVersionLabel`). An
 * answer after another configuration opened, or a reload in another
 * organization, changes and toasts nothing. The label is the user's text:
 * it is the field's value, never another attribute (ADR 0024).
 */
export function RenameVersionDialog({ version, onOpenChange, onCloseAutoFocus }: RenameVersionDialogProps) {
  const { revalidate } = useRevalidator();
  const open = version !== null;
  const shown = version === null ? "" : versionLabelText(version.versionNumber, version.label);
  const [label, setLabel] = useState(shown);
  const [isSaving, setIsSaving] = useState(false);
  // Set before the state re-renders: Enter then a click renames once.
  const savingRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  // Counts failures: after each, once the field is enabled again, it takes the focus (Ruling 44).
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    if (failures > 0) fieldRef.current?.focus();
  }, [failures]);

  // Prefilled each time it opens, for the version it opens for.
  const versionId = version?.id ?? null;
  useEffect(() => {
    if (versionId !== null) setLabel(shown);
    // Only on opening (`shown` left out): a label changed meanwhile mustn't overwrite what is typed.
  }, [versionId]);

  const trimmed = label.trim();
  const canSave = trimmed !== "" && !isSaving;

  const handleSave = async () => {
    if (version === null || !canSave || savingRef.current) return;
    if (trimmed === shown.trim()) {
      onOpenChange(false);
      return;
    }
    const { configuration, organizationId } = useEditorStore.getState();
    if (configuration === null || organizationId === null) return;
    const stillCurrent = () => {
      const now = useEditorStore.getState();
      return now.configuration?.id === configuration.id && now.organizationId === organizationId;
    };

    savingRef.current = true;
    setIsSaving(true);
    try {
      const { version: renamed } = await renameConfigurationVersion(organizationId, configuration.id, version.id, {
        label: trimmed,
      });
      if (!stillCurrent()) return;
      useEditorStore.getState().setVersionLabel(renamed.id, renamed.label);
      toast.success(VERSION_RENAMED_MESSAGE);
      onOpenChange(false);
    } catch (error) {
      if (!stillCurrent()) return;
      toast.error(configurationRefusalMessage(error, RENAME_VERSION_FAILED_MESSAGE));
      if (isVersionPublishedRefusal(error)) {
        onOpenChange(false);
        await rereadVersion(organizationId, configuration.id, version.id, stillCurrent);
        return;
      }
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) void revalidate();
      setFailures((count) => count + 1);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isSaving && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Rename Version</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 py-4">
          <Label htmlFor="rename-version-label">Version name</Label>
          <Input
            ref={fieldRef}
            id="rename-version-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSave();
              }
            }}
            placeholder="e.g. Add tail sampling"
            maxLength={CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH}
            autoFocus
            disabled={isSaving}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
