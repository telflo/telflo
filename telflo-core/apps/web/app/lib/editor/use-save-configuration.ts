import { useCallback } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { CONFIGURATION_YAML_MAXIMUM_LENGTH, hasUnstorableCharacter, type ConfigurationErrorCode } from "@telflo/contracts";
import { ApiError, saveConfigurationVersion } from "~/lib/api-client.js";
import { isConfigurationGone, isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { isVersionPublishedRefusal, publishedVersionMessage, rereadVersion } from "~/lib/editor/publishing.js";
import { toStored } from "~/lib/graph/stored-graph.js";
import { selectIsDirty, selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

/** The toasts for a save. */
export const SAVED_MESSAGE = "Saved configuration";
export const SAVE_FAILED_MESSAGE = "Failed to save configuration. Please try again.";

/** Refused before sending: the contract's limit, in UTF-16 units as the contract counts them. */
export const TOO_LARGE_MESSAGE = "This configuration is too large to save (the limit is 256 KiB).";

/**
 * Refused before sending: U+0000 or a lone surrogate, which the API refuses
 * because Postgres can't store them exactly. Its 400 would only say the save
 * failed.
 */
export const UNSTORABLE_CHARACTER_MESSAGE =
  "This configuration contains a character that can't be saved. Remove it and try again.";

/** A save refused with 404 `configuration_not_found`: someone deleted it meanwhile. */
export const DELETED_MESSAGE = "This configuration was deleted. Copy your changes before leaving.";

/**
 * A save refused with 404 `organization_not_found`: the session works in
 * another organization now, switched in another tab. The sidebar refuses a
 * switch back while the editor is dirty, so the toast can't say "switch
 * back to it" alone.
 */
export const OTHER_ORGANIZATION_MESSAGE =
  "This configuration belongs to another organization than the one you're working in. Copy your changes, or switch back to it in another tab.";

/**
 * A save or a create refused with 400 `collector_version_unknown`: the pick
 * names a collector version the catalogue no longer offers (retired since
 * the page read it). The pick stays on screen, unsaved, for another to be
 * chosen.
 */
export const COLLECTOR_VERSION_UNAVAILABLE_MESSAGE = "That collector version isn't available.";

const COLLECTOR_VERSION_UNKNOWN: ConfigurationErrorCode = "collector_version_unknown";

/** Whether a save or a create named a collector version the catalogue doesn't offer. */
export function isCollectorVersionUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === COLLECTOR_VERSION_UNKNOWN;
}

/**
 * How a save ended. Not saved, `toasted` says whether the save already told
 * the person why, so a caller that has its own message (the Unsaved Changes
 * dialog's) adds it only when nothing was said. `busy`: it didn't try, because
 * a save or the picker's create was under way. Nothing failed, so a caller
 * says nothing of a failure.
 */
export type SaveResult = { saved: true } | { saved: false; toasted: boolean } | { saved: false; busy: true };

const SAVED: SaveResult = { saved: true };
const NOT_SAVED: SaveResult = { saved: false, toasted: false };
const REFUSED: SaveResult = { saved: false, toasted: true };
const BUSY: SaveResult = { saved: false, busy: true };

/**
 * The editor's save, for the Save button, Cmd/Ctrl+S inside Monaco and outside
 * it, and for a publish's save first (`saveOpenVersion`). It reads the
 * editor's store when called, so every caller saves the same way, whenever it
 * was rendered.
 *
 * - It first writes every edit a field holds that the store doesn't have
 *   yet (`held-edits`: a name typed, a write waiting for its pause), so the
 *   save has it.
 * - It does nothing while the editor is clean or a save is under way, so two
 *   quick saves send once, nor while the picker's create is under way: the
 *   create sends the text as it was, and the save would write it into the
 *   source, which the create leaves as last saved. While a save or a create
 *   is under way it answers `busy`, and so while a publish is, whose own
 *   save first is the one exception.
 * - A published version is never sent: it says "Version {N} is published
 *   and can't be changed.", clean (a Cmd/Ctrl+S on it, in Monaco or
 *   outside) or with unsaved text on screen (a stale tab).
 * - Text over 262,144 characters is refused before sending, with
 *   TOO_LARGE_MESSAGE, and so is text holding U+0000 or a lone surrogate,
 *   which the API would refuse, with UNSTORABLE_CHARACTER_MESSAGE.
 * - Otherwise it sends the text as it is when the save starts, with the graph
 *   as it is then (`toStored`: the layout, best effort, so the graph never
 *   stops the text's save), to the organization the configuration was loaded
 *   in (the store's; never the session's current one). In manual edit mode
 *   that is the typed text with the last applied graph. The collector version
 *   is sent only when this tab picked one (the pin on screen isn't the saved
 *   one); left out, the server keeps the version's stored pin, which may be a
 *   teammate's since: the pin follows whoever last picked it, as the text
 *   follows whoever last saved it. On success the saved text and layout are
 *   those that were sent, so a change during the save leaves the editor dirty;
 *   the saved pin is the answer's, which an untouched picker then shows, while
 *   a pick made during the save stays, unsaved (`markSaved`). It toasts "Saved
 *   configuration".
 * - A refusal never touches the text: a deleted configuration and another
 *   organization each get their own message, and the second also revalidates
 *   the layout, as the list does; a 403 `terms_acceptance_required`
 *   revalidates the layout, whose terms dialog opens, with no toast; a 409
 *   `configuration_version_published` (a teammate published the version since
 *   this tab opened it) says "Version {N} is published and can't be changed.",
 *   re-reads the version and puts it in the store, so the editor locks with
 *   the unsaved text still on screen, dirty against the published content (the
 *   banner's create carries it into a new version); a 400
 *   `collector_version_unknown` (a pick the catalogue retired since the page
 *   read it) says "That collector version isn't available."; anything else
 *   toasts the failure message.
 * - An answer for a load the editor no longer holds (another configuration
 *   opened meanwhile, or this one left and opened again) changes and toasts
 *   nothing, and leaves a save under way since alone.
 *
 * Resolves `{ saved: true }` when the text it sent was saved, and `{ saved:
 * false, busy: true }` when it didn't try because a save or a create was
 * under way. Otherwise `toasted` is true when it toasted why (a refusal
 * before sending, or one the API gave), and false when it said nothing:
 * there was nothing to save, the terms dialog opened, or the answer came
 * for a version no longer open.
 */
export function useSaveConfiguration(): () => Promise<SaveResult> {
  const { revalidate } = useRevalidator();
  return useCallback(() => saveOpenVersion(revalidate), [revalidate]);
}

/**
 * `useSaveConfiguration`'s save, with the layout's `revalidate`. A publish's
 * save first (`forPublish`) is the one save made while the publish is under
 * way.
 */
export async function saveOpenVersion(
  revalidate: () => Promise<void> | void,
  { forPublish = false }: { forPublish?: boolean } = {},
): Promise<SaveResult> {
  // What a field holds and the store doesn't have yet is written first, so it is saved.
  flushHeldEdits();
  const state = useEditorStore.getState();
  const { configuration, version, organizationId, text, graph, collectorVersion, savedCollectorVersion } = state;
  if (configuration === null || version === null || organizationId === null) return NOT_SAVED;
  if (state.isSaving || state.isCreatingVersion || (state.isPublishing && !forPublish)) return BUSY;
  if (selectIsVersionPublished(state)) {
    toast.error(publishedVersionMessage(version.versionNumber));
    return REFUSED;
  }
  if (!selectIsDirty(state)) return NOT_SAVED;
  if (text.length > CONFIGURATION_YAML_MAXIMUM_LENGTH) {
    toast.error(TOO_LARGE_MESSAGE);
    return REFUSED;
  }
  if (hasUnstorableCharacter(text)) {
    toast.error(UNSTORABLE_CHARACTER_MESSAGE);
    return REFUSED;
  }

  // Still the load this save began in: not another configuration, and not
  // this one left and opened again (whose own save may be under way).
  const { loadCount } = state;
  const stillOpen = () => {
    const now = useEditorStore.getState();
    return (
      now.loadCount === loadCount && now.version?.id === version.id && now.organizationId === organizationId
    );
  };

  // The picks so far: one made during the save stays on screen after it.
  const { collectorVersionPicks } = state;
  const picked = collectorVersion !== null && collectorVersion !== savedCollectorVersion;

  state.setSaving(true);
  try {
    const { version: saved } = await saveConfigurationVersion(organizationId, configuration.id, version.id, {
      yamlContent: text,
      ...toStored(graph),
      // Only a pick: an untouched picker leaves the stored pin, maybe a teammate's, as it is.
      ...(picked ? { collectorVersion } : {}),
    });
    if (!stillOpen()) return NOT_SAVED;
    useEditorStore.getState().markSaved(text, saved, graph, collectorVersionPicks);
    toast.success(SAVED_MESSAGE);
    return SAVED;
  } catch (error) {
    if (!stillOpen()) return NOT_SAVED;
    if (isTermsAcceptanceRequired(error)) {
      void revalidate();
      return NOT_SAVED;
    }
    if (isVersionPublishedRefusal(error)) {
      toast.error(publishedVersionMessage(version.versionNumber));
      // The version as it is now, so the editor locks, its published content the baseline; the text stays.
      await rereadVersion(organizationId, configuration.id, version.id, stillOpen);
    } else if (isConfigurationGone(error)) {
      toast.error(DELETED_MESSAGE);
    } else if (isOrganizationGone(error)) {
      toast.error(OTHER_ORGANIZATION_MESSAGE);
      void revalidate();
    } else if (isCollectorVersionUnavailable(error)) {
      toast.error(COLLECTOR_VERSION_UNAVAILABLE_MESSAGE);
    } else {
      toast.error(SAVE_FAILED_MESSAGE);
    }
    return REFUSED;
  } finally {
    if (stillOpen()) useEditorStore.getState().setSaving(false);
  }
}
