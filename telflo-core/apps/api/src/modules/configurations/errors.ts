import {
  FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE,
  type ConfigurationErrorCode,
  type FleetErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The configuration endpoints' own refusals. The organization's
 * (`organization_not_found`) are the organization module's, so both answer
 * alike.
 */

/**
 * An unknown configuration, a deleted one, one in another organization,
 * another member's draft, and an id that isn't a canonical UUID, all alike.
 * A version is found only through its configuration, so for a version's save
 * an unknown version, one of another configuration and a malformed version
 * id are this too.
 */
export function configurationNotFound(): AppError {
  return new AppError("configuration_not_found" satisfies ConfigurationErrorCode, "Configuration not found", 404);
}

/**
 * A version that isn't one of the live configuration's (an unknown one,
 * another configuration's, an id that isn't a canonical UUID), named in a
 * version's read or rename path, as a create's source, or as a selection.
 * Its own code, so the editor can offer the latest version.
 */
export function configurationVersionNotFound(): AppError {
  return new AppError(
    "configuration_version_not_found" satisfies ConfigurationErrorCode,
    "Version not found",
    404,
  );
}

/**
 * A save or a rename of a published version, which can't be changed. The
 * service checks it under the configuration's lock before it writes, so the
 * database's immutability trigger (migration 020) is never what refuses it.
 * Publishing an already published version has its own message:
 * `configurationVersionAlreadyPublished`.
 */
export function configurationVersionPublished(): AppError {
  return new AppError(
    "configuration_version_published" satisfies ConfigurationErrorCode,
    "This version is published and can't be changed.",
    409,
  );
}

/**
 * Publishing a version that is published already, found by the publish's
 * checks or by its record touching no row. Names the version's number only:
 * never its label.
 */
export function configurationVersionAlreadyPublished(versionNumber: number): AppError {
  return new AppError(
    "configuration_version_published" satisfies ConfigurationErrorCode,
    `Version ${versionNumber} is already published.`,
    409,
  );
}

/**
 * The version was saved since the caller's tab saw it (refused before any
 * call), or saved with other text or renamed between the publish's checks
 * and its record, so the snapshot the opamp-server took isn't what the
 * version holds. Nothing is recorded, and the snapshot is removed after
 * the response.
 */
export function configurationVersionChanged(): AppError {
  return new AppError(
    "configuration_version_changed" satisfies ConfigurationErrorCode,
    "This version changed while it was being published. Try again.",
    409,
  );
}

/**
 * The public API's version PATCH with `?validate=true`, when the version
 * was saved between its validation and the write: the text validated isn't
 * what the version holds, so nothing is saved.
 * `configurationVersionChanged`'s code, with its own words.
 */
export function configurationVersionChangedWhileValidating(): AppError {
  return new AppError(
    "configuration_version_changed" satisfies ConfigurationErrorCode,
    "This version changed while it was being validated. Nothing was saved. Try again.",
    409,
  );
}

/**
 * A version whose saved YAML is exactly empty, which the opamp-server would
 * refuse. Refused before any call to it.
 */
export function configurationVersionEmpty(): AppError {
  return new AppError(
    "configuration_version_empty" satisfies ConfigurationErrorCode,
    "An empty version can't be published.",
    409,
  );
}

/**
 * The opamp-server couldn't be asked (a 5xx, a network error, its timeout),
 * or an organization vanished from its registry mid-publish. Nothing is
 * recorded: the version stays a draft.
 */
export function publishingUnavailable(): AppError {
  return new AppError(
    "publishing_unavailable" satisfies ConfigurationErrorCode,
    "Publishing is unavailable right now. Try again.",
    503,
  );
}

/**
 * A delete by a member who is neither the configuration's author nor an
 * organization admin. Only for a configuration they can see: one they
 * can't is 404 `configuration_not_found` first.
 */
export function configurationDeleteForbidden(): AppError {
  return new AppError(
    "configuration_delete_forbidden" satisfies ConfigurationErrorCode,
    "Only the configuration's author or an organization admin can delete it.",
    403,
  );
}

/**
 * A delete of a configuration one of whose published versions a collector
 * group is assigned or a collector is pinned to, archived fleets' included,
 * as the opamp-server answered just before. Nothing is deleted. Its message
 * names nothing of the fleet's.
 */
export function configurationInUse(): AppError {
  return new AppError(
    "configuration_in_use" satisfies ConfigurationErrorCode,
    "A collector group or a collector uses a published version of this configuration. Remove it from them first.",
    409,
  );
}

/**
 * A delete whose fleet usage the opamp-server couldn't answer (down, slow,
 * oversized, refusing the secret, an answer it doesn't document). The fleets'
 * one 503 code, with the delete's own words: the check runs before anything
 * is deleted.
 */
export function fleetsUnavailableAtDelete(): AppError {
  return new AppError("fleets_unavailable" satisfies FleetErrorCode, FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE, 503);
}

/**
 * A save or a create changing a version's collector version to one its
 * configuration's distribution doesn't offer (not in the catalogue, or
 * deprecated). A pin equal to the one stored, or to the source's, is
 * never this, even if deprecated since. Nothing is written.
 */
export function collectorVersionUnknown(): AppError {
  return new AppError(
    "collector_version_unknown" satisfies ConfigurationErrorCode,
    "That collector version isn't available.",
    400,
  );
}

/**
 * A create naming a distribution the catalogue doesn't have, or one with
 * no version to offer as its default. Nothing is written.
 */
export function collectorDistributionUnknown(): AppError {
  return new AppError(
    "collector_distribution_unknown" satisfies ConfigurationErrorCode,
    "That collector distribution isn't available.",
    400,
  );
}

/**
 * The collector validator couldn't check the text, whatever the reason
 * (down, slow, busy, missing the version, refusing the platform's secret,
 * a malformed answer). Never the reason itself: the log has it.
 */
export function validationUnavailable(): AppError {
  return new AppError(
    "validation_unavailable" satisfies ConfigurationErrorCode,
    "Validation is unavailable. Your YAML was not checked — retry shortly.",
    503,
  );
}

/**
 * The caller's checks in the last minute are used up. `retryAfterSeconds` is
 * when their window ends.
 */
export function validationRateLimited(retryAfterSeconds: number): AppError {
  return new AppError(
    "validation_rate_limited" satisfies ConfigurationErrorCode,
    "Too many checks in the last minute. Checking again shortly.",
    429,
    undefined,
    { "retry-after": retryAfterSeconds },
  );
}

/**
 * Two of the caller's checks are waiting on the validator already. The
 * same code as the minute's limit, so the editor treats both alike
 * (unavailable, retried after `Retry-After`); its own message.
 */
export function validationsInFlight(retryAfterSeconds: number): AppError {
  return new AppError(
    "validation_rate_limited" satisfies ConfigurationErrorCode,
    "Too many checks at once. Checking again shortly.",
    429,
    undefined,
    { "retry-after": retryAfterSeconds },
  );
}

/**
 * A list cursor that doesn't decode to a timestamp and a UUID: the
 * envelope's shared code and message, as a query that fails its schema
 * gets.
 */
export function invalidCursor(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400);
}

/**
 * A save's graph that the table's checks refuse though the contract allowed it
 * (Postgres prints jsonb longer than JSON, `1e300` as 301 digits): the
 * envelope's shared code and message, as a graph the contract refuses gets. No
 * details: the database's say what was stored.
 */
export function invalidGraph(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400);
}
