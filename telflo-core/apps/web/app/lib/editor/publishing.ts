import type { ConfigurationErrorCode } from "@telflo/contracts";
import { ApiError, getConfigurationVersion } from "~/lib/api-client.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * Publishing's words and what the editor's publish and save share. Every
 * message names the version by its number only, never its label or the
 * configuration's name. The toasts follow the refusal's code, never the
 * server's message.
 */

/** The Publish button's tooltip, while it can publish. */
export const PUBLISH_TOOLTIP = "Publish this version so fleets can deploy it.";
/** The Publish button's tooltip on a published version (disabled). */
export const ALREADY_PUBLISHED_TOOLTIP = "Already published";
/**
 * The Publish button's tooltip while the editor's text is empty (disabled),
 * and the toast of a 409 `configuration_version_empty` or of a save first
 * that left it empty.
 */
export const EMPTY_VERSION_MESSAGE = "An empty version can't be published.";

/** The dialog's title. */
export const PUBLISH_DIALOG_TITLE = "Publish Configuration";
/** The dialog's line when the editor holds unsaved changes. */
export const SAVED_FIRST_MESSAGE = "Your unsaved changes will be saved first.";

/** The dialog's body. */
export function publishDialogMessage(versionNumber: number): string {
  return `This will publish version ${versionNumber}, making it available to your organization members and fleet management.`;
}

export const PUBLISHED_MESSAGE = "Configuration published successfully";
/**
 * A publish refused with 409 `configuration_version_changed`: the version was
 * saved since the tab loaded or saved it, or between the publish's checks and
 * its record. The editor then reloads it (`reloadOpenVersion`).
 */
export const PUBLISH_CHANGED_MESSAGE = "This version changed while it was being published. Try again.";
export const PUBLISHING_UNAVAILABLE_MESSAGE = "Publishing is unavailable right now. Try again.";
export const PUBLISH_FAILED_MESSAGE = "An error occurred while publishing.";

/** A publish refused with 409 `configuration_version_published`. */
export function alreadyPublishedMessage(versionNumber: number): string {
  return `Version ${versionNumber} is already published.`;
}

/** The banner over a published version, and a save's refusal of one. */
export function publishedVersionMessage(versionNumber: number): string {
  return `Version ${versionNumber} is published and can't be changed.`;
}

/** The banner's one button. */
export const CREATE_FROM_PUBLISHED_LABEL = "Create a new version from it";

/** The picker's lock, on a published row, as its `aria-label` and its tooltip: fixed text. */
export const PUBLISHED_IMMUTABLE_LABEL = "Published versions are immutable";

const VERSION_PUBLISHED: ConfigurationErrorCode = "configuration_version_published";

/** Whether a request was refused because the version is published (409). */
export function isVersionPublishedRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === VERSION_PUBLISHED;
}

/**
 * Reads the version again and puts it in the store whole
 * (`replaceVersion`), so a version published elsewhere locks the editor
 * without a reload, and its published content becomes the saved baseline:
 * what this tab last loaded or saved may not be what a teammate published.
 * A clean editor shows that content; unsaved changes stay on screen, dirty
 * against it; the history stays. Best effort: a failure changes nothing,
 * and so does an answer for a version no longer open (`stillOpen`, the
 * caller's).
 */
export async function rereadVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  stillOpen: () => boolean,
): Promise<void> {
  try {
    const { version } = await getConfigurationVersion(organizationId, configurationId, versionId);
    if (stillOpen()) useEditorStore.getState().replaceVersion(version);
  } catch {
    // Nothing more to say: the refusal has been toasted.
  }
}

/**
 * Opens the version again, as the page's load does (`getConfigurationVersion`,
 * then the store's `load`), so the editor shows the text a teammate saved
 * since this tab loaded or saved it (refuse, then reload). The same version
 * stays open, in the organization it was loaded in; the undo history, manual
 * edit mode and the selection go, as for any load. Only a clean editor is
 * reloaded: the publish that asks for it began clean, or its own save had just
 * landed, so nothing typed is lost; text typed since stays, and a reload never
 * goes over it. Best effort: a failure changes nothing, and so does an answer
 * for a version no longer open (`stillOpen`, the caller's).
 */
export async function reloadOpenVersion(
  organizationId: string,
  configurationId: string,
  versionId: string,
  stillOpen: () => boolean,
): Promise<void> {
  try {
    const { configuration, version, versions } = await getConfigurationVersion(
      organizationId,
      configurationId,
      versionId,
    );
    const state = useEditorStore.getState();
    if (!stillOpen() || selectIsDirty(state)) return;
    state.load({ organizationId, configuration, version, versions });
  } catch {
    // Nothing more to say: the refusal has been toasted.
  }
}
