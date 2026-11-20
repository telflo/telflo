import { useCallback } from "react";
import { useNavigate, useParams, useRevalidator } from "react-router";
import { toast } from "sonner";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH, hasUnstorableCharacter } from "@telflo/contracts";
import { readViewport, writeViewport } from "~/components/editor/builder/canvas-handlers.js";
import { createConfigurationVersion } from "~/lib/api-client.js";
import { isConfigurationGone, isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import {
  COLLECTOR_VERSION_UNAVAILABLE_MESSAGE,
  DELETED_MESSAGE,
  OTHER_ORGANIZATION_MESSAGE,
  TOO_LARGE_MESSAGE,
  UNSTORABLE_CHARACTER_MESSAGE,
  isCollectorVersionUnavailable,
} from "~/lib/editor/use-save-configuration.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/** For a create that failed without a refusal of the save's to show. */
export const CREATE_VERSION_FAILED_MESSAGE = "Failed to create version. Please try again.";

export interface CreateVersion {
  /**
   * Creates a version from the open one, named `label` (trimmed; blank is
   * unnamed). Resolves true once the editor has opened it, and false when
   * nothing was created or the answer came too late to open it.
   */
  createVersion: (label: string) => Promise<boolean>;
}

/**
 * The picker's "Create New Version": a copy of the open version, with its
 * unsaved changes.
 *
 * - It first writes every edit a field holds (held-edits), as Save does,
 *   then reads the store. A flush that throws creates nothing. Nothing is
 *   created while a save or a publish is under way.
 * - It is also the published version's banner's "Create a new version from
 *   it": unnamed, from the open version with the text on screen, which a
 *   stale tab's unsaved text is.
 * - It refuses before sending, with the save's messages, text over the
 *   contract's limit and text holding a character the API can't store.
 * - It sends the editor's text and graph now (`toStored`), with the open
 *   version as the source, to the organization the configuration was loaded in
 *   (the store's), and the collector version only when this tab picked one (an
 *   unsaved pick): left out, the server takes the source's saved pin, which
 *   may be a teammate's since. The source stays as it was last saved: nothing
 *   is saved over it.
 * - On success the created version's canvas starts at the source's
 *   remembered viewport, the store adopts the version (clean, the undo
 *   history cleared), and only then is its address pushed, since the
 *   unsaved-changes guard would hold a push made while dirty. The address
 *   keeps the configuration's id exactly as the address spells it: another
 *   spelling would be another configuration to the page, which would empty
 *   the store.
 * - Refusals are the save's: a deleted configuration and another organization
 *   each say their message, and the second revalidates the layout; the terms
 *   revalidate it with no toast; a collector version the catalogue retired
 *   says the save's message; anything else toasts "Failed to create version.
 *   Please try again.". The editor keeps its text.
 * - An answer for a load the editor no longer holds (another version or
 *   configuration opened meanwhile, or a reload) changes, opens and toasts
 *   nothing: the save's `stillOpen` rule.
 * - One create at a time: the store says one is under way
 *   (`isCreatingVersion`), and is the only record of it, so the picker's
 *   Create, the dialog's Continue and a save each read it; a second call
 *   meanwhile does nothing. It is set before the request and cleared when the
 *   answer comes, only if no load came between: a load clears it already, and
 *   a create begun since, on the version loaded, has set it again for itself.
 */
export function useCreateVersion(): CreateVersion {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const { configurationId: addressedConfigurationId } = useParams();

  const createVersion = useCallback(
    async (label: string) => {
      // Set in the store before any await: a double Enter creates once.
      if (useEditorStore.getState().isCreatingVersion) return false;
      try {
        flushHeldEdits();
      } catch {
        toast.error(CREATE_VERSION_FAILED_MESSAGE);
        return false;
      }
      const state = useEditorStore.getState();
      const { configuration, version, organizationId, text, graph, collectorVersion, savedCollectorVersion, loadCount } =
        state;
      // Not while a save or a publish is under way: the publish's save would race it.
      if (configuration === null || version === null || organizationId === null || state.isSaving || state.isPublishing) {
        return false;
      }
      if (text.length > CONFIGURATION_YAML_MAXIMUM_LENGTH) {
        toast.error(TOO_LARGE_MESSAGE);
        return false;
      }
      if (hasUnstorableCharacter(text)) {
        toast.error(UNSTORABLE_CHARACTER_MESSAGE);
        return false;
      }

      const stillOpen = () => {
        const now = useEditorStore.getState();
        return now.loadCount === loadCount && now.version?.id === version.id && now.organizationId === organizationId;
      };
      const named = label.trim();

      state.setCreatingVersion(true);
      try {
        const { version: created } = await createConfigurationVersion(organizationId, configuration.id, {
          sourceVersionId: version.id,
          ...(named === "" ? {} : { label: named }),
          yamlContent: text,
          ...toStored(graph),
          // Only an unsaved pick; left out, the source's saved pin. The
          // source keeps its own either way.
          ...(collectorVersion !== null && collectorVersion !== savedCollectorVersion ? { collectorVersion } : {}),
        });
        if (!stillOpen()) return false;
        const viewport = readViewport(version.id);
        if (viewport !== null) writeViewport(created.id, viewport);
        useEditorStore.getState().adoptCreatedVersion(created);
        void navigate(`/editor/${addressedConfigurationId ?? configuration.id}/${created.id}`);
        return true;
      } catch (error) {
        if (!stillOpen()) return false;
        if (isTermsAcceptanceRequired(error)) {
          void revalidate();
        } else if (isConfigurationGone(error)) {
          toast.error(DELETED_MESSAGE);
        } else if (isOrganizationGone(error)) {
          toast.error(OTHER_ORGANIZATION_MESSAGE);
          void revalidate();
        } else if (isCollectorVersionUnavailable(error)) {
          toast.error(COLLECTOR_VERSION_UNAVAILABLE_MESSAGE);
        } else {
          toast.error(CREATE_VERSION_FAILED_MESSAGE);
        }
        return false;
      } finally {
        // The flag is this create's only while no load came between: a load
        // (the adoption included) has cleared it, and a create begun since
        // set it for itself.
        const now = useEditorStore.getState();
        if (now.loadCount === loadCount) now.setCreatingVersion(false);
      }
    },
    [navigate, revalidate, addressedConfigurationId],
  );

  return { createVersion };
}
