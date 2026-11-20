import { PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, QUICK_DEPLOY_LINK_ERROR_MESSAGES } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The public download's refusals, answered in plain text by its route's
 * error handler (http/public-download.ts): the status and the platform's
 * own words only, never the secret, the fleet's label, a group's name, a
 * path or a value. Their codes travel no further than this process (a
 * plain-text reply has no envelope); they name the refusal for its tests
 * and its log lines.
 */

/** A secret of the wrong shape, or one no link's hash matches: alike, before and after the lookup. */
export function downloadLinkNotFound(): AppError {
  return new AppError("quick_deploy_link_not_found", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_not_found, 404);
}

export function downloadLinkRevoked(): AppError {
  return new AppError("quick_deploy_link_revoked", QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked, 410);
}

export const DOWNLOAD_LINK_EXPIRED_MESSAGE =
  "This install link has expired: extend it under Install links on the Tokens tab, or make a new one.";

export function downloadLinkExpired(): AppError {
  return new AppError("quick_deploy_link_expired", DOWNLOAD_LINK_EXPIRED_MESSAGE, 410);
}

/** Revoked or expired between the checks and the count (the counter's last gate). */
export const DOWNLOAD_LINK_ENDED_MESSAGE = "This install link was revoked or has expired: make a new one.";

export function downloadLinkEnded(): AppError {
  return new AppError("quick_deploy_link_ended", DOWNLOAD_LINK_ENDED_MESSAGE, 410);
}

/** The organization deleted, the fleet deleted, or the fleet not the link's organization's. */
export const DOWNLOAD_FLEET_GONE_MESSAGE = "This install link's fleet no longer exists.";

export function downloadFleetGone(): AppError {
  return new AppError("quick_deploy_fleet_gone", DOWNLOAD_FLEET_GONE_MESSAGE, 410);
}

export const DOWNLOAD_FLEET_ARCHIVED_MESSAGE = "This install link's fleet is archived.";

export function downloadFleetArchived(): AppError {
  return new AppError("quick_deploy_fleet_archived", DOWNLOAD_FLEET_ARCHIVED_MESSAGE, 410);
}

/** The default token the link's command carries is revoked. */
export const DOWNLOAD_TOKEN_REVOKED_MESSAGE = "This link's token was revoked: make a new link.";

export function downloadTokenRevoked(): AppError {
  return new AppError("quick_deploy_token_revoked", DOWNLOAD_TOKEN_REVOKED_MESSAGE, 410);
}

/**
 * The organization's "Public install links" switch is off: every link's
 * download is refused, 403, until it is on again.
 */
export function downloadLinksDisabled(): AppError {
  return new AppError("public_install_links_disabled", PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, 403);
}

/** A stored variable's name the group's published version no longer reads. */
export function downloadVariablesChanged(): AppError {
  return new AppError(
    "collector_group_variables_changed",
    QUICK_DEPLOY_LINK_ERROR_MESSAGES.collector_group_variables_changed,
    409,
  );
}

/** The opamp-server couldn't answer, or the link's values couldn't be opened, or its download not recorded: nothing served. */
export const DOWNLOAD_UNAVAILABLE_MESSAGE = "Downloads aren't available right now. Try again in a moment.";

export function downloadUnavailable(): AppError {
  return new AppError("quick_deploy_unavailable", DOWNLOAD_UNAVAILABLE_MESSAGE, 503);
}

/** The install's refusals the download answers 409 with their own words. */
const INSTALL_CONFLICTS = new Set([
  "fleet_type_not_installable",
  // A Helm values link's group whose Kubernetes settings can't be read.
  "collector_group_settings_unreadable",
  "collector_group_not_found",
  "collector_group_unassigned",
  "collector_group_assignment_deleted",
  "collector_version_not_offered",
]);

/**
 * The fleet routes' refusal of an install, as the public download answers it:
 * the fleet gone (another organization's too) or archived 410; not the link
 * kind's fleet type, the group gone or unassigned, a Kubernetes group's
 * settings unreadable, a deleted configuration's version, a version or arch
 * not offered 409, with the install's words; the opamp-server unavailable 503
 * in the download's own words; the templates' 503 as it is. Anything else is
 * passed on as it is.
 */
export function downloadRefusalOf(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  switch (error.code) {
    case "fleet_not_found":
    case "organization_not_found":
      return downloadFleetGone();
    case "fleet_archived":
      return downloadFleetArchived();
    case "fleets_unavailable":
      return downloadUnavailable();
    default:
      return INSTALL_CONFLICTS.has(error.code) ? new AppError(error.code, error.message, 409) : error;
  }
}
