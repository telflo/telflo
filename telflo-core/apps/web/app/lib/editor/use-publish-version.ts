import { useCallback } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { VARIABLE_REFERENCE_TOO_LONG_MESSAGE, type ConfigurationErrorCode } from "@telflo/contracts";
import { ApiError, publishConfigurationVersion } from "~/lib/api-client.js";
import { isConfigurationGone, isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import {
  EMPTY_VERSION_MESSAGE,
  PUBLISHED_MESSAGE,
  PUBLISHING_UNAVAILABLE_MESSAGE,
  PUBLISH_CHANGED_MESSAGE,
  PUBLISH_FAILED_MESSAGE,
  alreadyPublishedMessage,
  isVersionPublishedRefusal,
  reloadOpenVersion,
  rereadVersion,
} from "~/lib/editor/publishing.js";
import { DELETED_MESSAGE, OTHER_ORGANIZATION_MESSAGE, saveOpenVersion } from "~/lib/editor/use-save-configuration.js";
import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

const VERSION_CHANGED: ConfigurationErrorCode = "configuration_version_changed";
const VERSION_EMPTY: ConfigurationErrorCode = "configuration_version_empty";
const PUBLISHING_UNAVAILABLE: ConfigurationErrorCode = "publishing_unavailable";

/**
 * Whether a publish was refused for a reference no organization variable can
 * have: 400 `invalid_request`, its details naming `yaml` (each detail's
 * `instancePath`).
 */
function isVariableReferenceTooLongRefusal(error: ApiError): boolean {
  return (
    error.code === "invalid_request" &&
    Array.isArray(error.details) &&
    error.details.some(
      (detail: unknown) => typeof detail === "object" && detail !== null && (detail as { instancePath?: unknown }).instancePath === "/yaml",
    )
  );
}

/** Whether a publish was refused because the version was saved since the tab saw it, or meanwhile. */
function isVersionChangedRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.code === VERSION_CHANGED;
}

/**
 * What a publish's refusal toasts, by its code: never the server's message. A
 * deleted configuration and another organization get the save's own messages;
 * a 403 `terms_acceptance_required` toasts nothing (null), since the terms
 * dialog opens, as for a save or a create. A text referencing an organization
 * variable name over 128 characters says so, in the contracts' fixed words.
 * Exported for its tests.
 */
export function refusalMessage(error: unknown, versionNumber: number): string | null {
  if (isTermsAcceptanceRequired(error)) return null;
  if (isConfigurationGone(error)) return DELETED_MESSAGE;
  if (isOrganizationGone(error)) return OTHER_ORGANIZATION_MESSAGE;
  if (!(error instanceof ApiError)) return PUBLISH_FAILED_MESSAGE;
  switch (error.code) {
    case VERSION_CHANGED:
      return PUBLISH_CHANGED_MESSAGE;
    case VERSION_EMPTY:
      return EMPTY_VERSION_MESSAGE;
    case PUBLISHING_UNAVAILABLE:
      return PUBLISHING_UNAVAILABLE_MESSAGE;
    default:
      if (isVariableReferenceTooLongRefusal(error)) return VARIABLE_REFERENCE_TOO_LONG_MESSAGE;
      return isVersionPublishedRefusal(error) ? alreadyPublishedMessage(versionNumber) : PUBLISH_FAILED_MESSAGE;
  }
}

/**
 * The toolbar's Publish. Resolves true once the open version is published and
 * the editor shows it so.
 *
 * - One publish at a time: the store says one is under way
 *   (`isPublishing`), set before any await, so a double click publishes
 *   once; a save or a create meanwhile does nothing (they answer busy).
 *   Nothing starts while a save or a create is under way, or on a version
 *   already published.
 * - Every edit a field holds is written first (held-edits), as a save does;
 *   a flush that throws publishes nothing.
 * - With unsaved changes it saves first, through the editor's one save; a
 *   save that fails has said why (the save's own messages) and nothing is
 *   published. Then, if the saved text is empty, it says "An empty version
 *   can't be published." and sends nothing.
 * - It publishes the open version, in the organization the configuration was
 *   loaded in, sending the version's `updatedAt` as the tab last loaded or
 *   saved it (`expectedUpdatedAt`; after a save first, the save's answer's),
 *   so the server publishes what this tab saved or showed, never a
 *   teammate's save it didn't see. On 200 the summary it answers replaces
 *   the open version's (no reload: the history and the canvas stay), which
 *   locks the editor, and it toasts "Configuration published successfully".
 * - Each refusal toasts by its code: already published ("Version {N} is
 *   already published.", and the version is read again so the editor locks,
 *   showing the published content when it was clean); changed ("This
 *   version changed while it was being published. Try again.", and the
 *   version is opened again, so the editor shows the newer saved text:
 *   refuse, then reload); empty; a reference to an organization variable
 *   name over 128 characters (a 400 naming `yaml`: the contracts'
 *   VARIABLE_REFERENCE_TOO_LONG_MESSAGE); unavailable; a deleted
 *   configuration and another organization the save's messages; anything
 *   else "An error occurred while publishing.". A 403
 *   `terms_acceptance_required` toasts nothing and revalidates the layout,
 *   whose terms dialog opens, and a 404 `organization_not_found`
 *   revalidates it too, as the editor's other writes do.
 * - An answer for a load the editor no longer holds changes and toasts
 *   nothing (the save's `stillOpen` rule).
 */
export function usePublishVersion(): () => Promise<boolean> {
  const { revalidate } = useRevalidator();

  return useCallback(async () => {
    const start = useEditorStore.getState();
    const { configuration, version, organizationId, loadCount } = start;
    if (configuration === null || version === null || organizationId === null) return false;
    if (start.isPublishing || start.isSaving || start.isCreatingVersion || selectIsVersionPublished(start)) return false;
    const versionNumber = version.versionNumber;
    const stillOpen = () => {
      const now = useEditorStore.getState();
      return now.loadCount === loadCount && now.version?.id === version.id && now.organizationId === organizationId;
    };

    start.setPublishing(true);
    try {
      try {
        flushHeldEdits();
      } catch {
        toast.error(PUBLISH_FAILED_MESSAGE);
        return false;
      }
      if (selectIsDirty(useEditorStore.getState())) {
        const saved = await saveOpenVersion(revalidate, { forPublish: true });
        // The save said why, or opened the terms dialog, or the version is no longer open.
        if (!saved.saved || !stillOpen()) return false;
      }
      if (useEditorStore.getState().savedText === "") {
        toast.error(EMPTY_VERSION_MESSAGE);
        return false;
      }

      try {
        // The version as this tab last loaded or saved it (after a save first, the save's answer's).
        const expectedUpdatedAt = useEditorStore.getState().version?.updatedAt ?? version.updatedAt;
        const { version: published } = await publishConfigurationVersion(organizationId, configuration.id, version.id, {
          expectedUpdatedAt,
        });
        if (!stillOpen()) return false;
        useEditorStore.getState().replaceVersionSummary(published);
        toast.success(PUBLISHED_MESSAGE);
        return true;
      } catch (error) {
        if (!stillOpen()) return false;
        const message = refusalMessage(error, versionNumber);
        if (message !== null) toast.error(message);
        if (isVersionPublishedRefusal(error)) {
          await rereadVersion(organizationId, configuration.id, version.id, stillOpen);
        } else if (isVersionChangedRefusal(error)) {
          await reloadOpenVersion(organizationId, configuration.id, version.id, stillOpen);
        } else if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
          void revalidate();
        }
        return false;
      }
    } finally {
      // A load clears the flag itself; a publish begun since set it for itself.
      const now = useEditorStore.getState();
      if (now.loadCount === loadCount) now.setPublishing(false);
    }
  }, [revalidate]);
}
