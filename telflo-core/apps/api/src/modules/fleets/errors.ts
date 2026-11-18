import {
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_REQUIRED_MESSAGE,
  COLLECTOR_GROUP_NAME_FIXED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  collectorBinariesMissingMessage,
  collectorDistributionNotInstallableMessage,
  collectorVersionNotOfferedMessage,
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  FLEETS_UNAVAILABLE_MESSAGE,
  HELM_CHART_ENV_NAME_MESSAGE,
  INSTALL_PLATFORM_NOT_SUITED_MESSAGE,
  INSTALL_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  type FleetErrorCode,
  type KubernetesRole,
  type QuickDeployLinkErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";
import { rateLimited } from "../../http/rate-limits.js";

/*
 * The fleet routes' own refusals (D16b decisions 13, 14 and 16, Preflight
 * rulings 5, 8, 9 and 19). The organization's (`organization_not_found`) are the
 * organization module's, so every route answers alike. Each message is the
 * platform's own words: never the opamp-server's text, and never a value (a
 * label, a name, an id) of the request's.
 */

/**
 * A fleet the organization doesn't hold: an unknown id, another
 * organization's, one deleted, an id that isn't a canonical UUID (no call),
 * or an organization the opamp-server doesn't know (it holds no fleets).
 */
export function fleetNotFound(): AppError {
  return new AppError("fleet_not_found" satisfies FleetErrorCode, "Fleet not found", 404);
}

/** A token the fleet doesn't hold, alike for an id that isn't a canonical UUID (no call). */
export function enrollmentTokenNotFound(): AppError {
  return new AppError("enrollment_token_not_found" satisfies FleetErrorCode, "Enrollment token not found", 404);
}

/** A group the fleet doesn't hold (another fleet's or organization's too), alike for an id that isn't a canonical UUID (no call). */
export function collectorGroupNotFound(): AppError {
  return new AppError("collector_group_not_found" satisfies FleetErrorCode, "Collector group not found", 404);
}

/** A collector the fleet doesn't hold (another fleet's or organization's too), alike for an id that isn't a canonical UUID (no call). */
export function collectorNotFound(): AppError {
  return new AppError("collector_not_found" satisfies FleetErrorCode, "Collector not found", 404);
}

export function collectorGroupNameTaken(): AppError {
  return new AppError(
    "collector_group_name_taken" satisfies FleetErrorCode,
    "Another of the fleet's collector groups has this name.",
    409,
  );
}

/** A rename or a delete of the fleet's Default group. */
export function collectorGroupIsDefault(): AppError {
  return new AppError(
    "collector_group_is_default" satisfies FleetErrorCode,
    "The fleet's Default group can't be renamed or deleted.",
    409,
  );
}

export function collectorNameTaken(): AppError {
  return new AppError(
    "collector_name_taken" satisfies FleetErrorCode,
    "Another of the organization's collectors has this name.",
    409,
  );
}

/**
 * An assignment or a pin naming a version of a configuration the person can
 * see that isn't published (decision 14): only a published version can be
 * served. Refused before any call.
 */
export function configurationVersionNotPublished(): AppError {
  return new AppError(
    "configuration_version_not_published" satisfies FleetErrorCode,
    "This version isn't published: publish it before assigning or pinning it.",
    422,
  );
}

/**
 * One entry of a 400's `details`, naming the request's field at `path` (a
 * top-level field's name, or the segments of a nested one), in the shape
 * the contract's own 400s give (fastify-type-provider-zod's: each zod issue
 * as {keyword, instancePath, schemaPath, params: {issue}, message}, the
 * instance path "/" and the segments joined by "/"), so a client reads both
 * alike (Ruling 31). The message is the platform's own words, never a value
 * of the request's.
 */
export interface InvalidRequestDetail {
  keyword: "custom";
  instancePath: string;
  schemaPath: string;
  params: { issue: { code: "custom"; path: (string | number)[]; message: string } };
  message: string;
}

export function fieldDetail(path: string | readonly (string | number)[], message: string): InvalidRequestDetail {
  const segments = typeof path === "string" ? [path] : [...path];
  const joined = segments.join("/");
  return {
    keyword: "custom",
    instancePath: `/${joined}`,
    schemaPath: `#/${joined}/custom`,
    params: { issue: { code: "custom", path: segments, message } },
    message,
  };
}

/*
 * A group's annotations against its fleet's type (D17d-1 decisions 17 and
 * 18; Preflight ruling 13): the platform reads the fleet first, then
 * refuses, 400 `invalid_request`, its detail at the field's path. The
 * messages are fixed words: a name, a namespace or a path never reaches one.
 */

/** A server fleet's group carrying the annotations' `telflo.kubernetes`. */
export function kubernetesOnServerFleet(): AppError {
  return new AppError("invalid_request", "Only a kubernetes-supervisor fleet's groups take Kubernetes settings.", 400, [
    fieldDetail(["annotations", "telflo", "kubernetes"], "Only a kubernetes-supervisor fleet's groups take it."),
  ]);
}

/** A Kubernetes fleet's group carrying the annotations' `telflo.dockerMounts` (D17c-1's handoff: the mounts are a `docker run`'s). */
export function dockerMountsOnKubernetesFleet(): AppError {
  return new AppError("invalid_request", "Only a server fleet's groups take Docker mounts.", 400, [
    fieldDetail(["annotations", "telflo", "dockerMounts"], "Only a server fleet's groups take it."),
  ]);
}

/** A Kubernetes fleet's group created under a name that is neither `cluster` nor a gateway's (gatewayNameProblem's words). */
export function kubernetesGroupNameRefused(problem: string): AppError {
  return new AppError("invalid_request", "A Kubernetes fleet's group is the Cluster (named cluster) or a gateway pool.", 400, [
    fieldDetail("name", problem),
  ]);
}

/**
 * A Kubernetes fleet's group whose write carries annotations without its
 * settings (Ruling 48): a create, or an update that sends `annotations`
 * (null, `telflo: {}` or other keys only), would leave the group without the
 * settings D17d-2's Helm values read.
 */
export function kubernetesSettingsRequired(): AppError {
  return new AppError("invalid_request", "A Kubernetes fleet's group keeps its Kubernetes settings in its annotations.", 400, [
    fieldDetail(["annotations", "telflo", "kubernetes"], "Kubernetes settings are required."),
  ]);
}

/**
 * A Kubernetes fleet's group whose settings name another role than the
 * group's on its fleet (collectorGroupRole: the Default group `node`,
 * `cluster` the Cluster, any other `gateway`).
 */
export function kubernetesRoleRefused(role: KubernetesRole): AppError {
  return new AppError("invalid_request", "The group's Kubernetes settings must name its role.", 400, [
    fieldDetail(["annotations", "telflo", "kubernetes", "role"], `Must be ${role}: the group's role on its fleet.`),
  ]);
}

/** Any rename of a Kubernetes fleet's group (D17d-1 decision 18): D17d-2's Helm release is named after it. */
export function collectorGroupNameFixed(): AppError {
  return new AppError("collector_group_name_fixed" satisfies FleetErrorCode, COLLECTOR_GROUP_NAME_FIXED_MESSAGE, 409);
}

/** A create naming the id of a fleet with another label or type, or of another organization's fleet. */
export function fleetConflict(): AppError {
  return new AppError("fleet_conflict" satisfies FleetErrorCode, "A different fleet already has this id.", 409);
}

export function fleetLabelTaken(): AppError {
  return new AppError(
    "fleet_label_taken" satisfies FleetErrorCode,
    "Another of the organization's fleets has this label.",
    409,
  );
}

/** A rotation of an archived fleet's token, or a new default token for one. */
export function fleetArchived(): AppError {
  return new AppError("fleet_archived" satisfies FleetErrorCode, "This fleet is archived.", 409);
}

export function enrollmentTokenRevoked(): AppError {
  return new AppError("enrollment_token_revoked" satisfies FleetErrorCode, "This enrollment token is revoked.", 409);
}

export function enrollmentTokenExpired(): AppError {
  return new AppError("enrollment_token_expired" satisfies FleetErrorCode, "This enrollment token has expired.", 409);
}

/**
 * A new default token asked for while the fleet holds a valid one (D17c-1
 * decisions 29 and 45): another member issued one first, or the default
 * token was never revoked.
 */
export function enrollmentTokenDefaultExists(): AppError {
  return new AppError(
    "enrollment_token_default_exists" satisfies FleetErrorCode,
    "The fleet already has a valid default token.",
    409,
  );
}

/**
 * Preflight ruling 8's one 503 (ruling 19's words): the opamp-server down,
 * slow, oversized, refusing the secret, or answering what the API doesn't
 * document. A write's can follow a change it made.
 */
export function fleetsUnavailable(): AppError {
  return new AppError("fleets_unavailable" satisfies FleetErrorCode, FLEETS_UNAVAILABLE_MESSAGE, 503);
}

/** A list's cursor the opamp-server didn't give (the browser's), 400 `invalid_request`, its details naming `cursor`. */
export function invalidCursor(): AppError {
  return new AppError("invalid_request", "The list's cursor isn't valid: reload the list.", 400, [
    fieldDetail("cursor", "Not a cursor of this list's: reload the list."),
  ]);
}

/**
 * A time the opamp-server refused (a create's rotate token expiry, a
 * rotation's): in the past by its clock, or past what it can keep. The
 * platform checks its own clock first; this is the clock skew it can't.
 * Given two fields, the message covers both: the opamp-server's reply
 * names which, but its message is never passed on.
 */
export function invalidTime(...fields: readonly [string, ...string[]]): AppError {
  const message =
    fields.length === 1 ? `${fields[0]} must be a time in the future.` : `${fields.join(" and ")} must be times in the future.`;
  return new AppError(
    "invalid_request",
    message,
    400,
    fields.map((field) => fieldDetail(field, "Must be a time in the future.")),
  );
}

/** A rotation whose grace would end after the new token expires, its details naming `graceEndsAt`. */
export function graceAfterExpiry(): AppError {
  return new AppError("invalid_request", "graceEndsAt must not be after expiresAt.", 400, [
    fieldDetail("graceEndsAt", "Must not be after expiresAt."),
  ]);
}

// ---------------------------------------------------------------------------
// Installing (D17c-1 decisions 36, 38, 39 and 47; Preflight ruling 14).

/** A Kubernetes-supervisor fleet's group: its install (Helm) is D17d's. */
export function fleetTypeNotInstallable(): AppError {
  return new AppError("fleet_type_not_installable" satisfies FleetErrorCode, FLEET_TYPE_NOT_INSTALLABLE_MESSAGE, 409);
}

/**
 * The public install's platform that doesn't suit the fleet's type (D25
 * decision 37): 422, the browser's code in the API's words (docker and
 * linux are a server fleet's, kubernetes a Kubernetes-supervisor fleet's).
 */
export function installPlatformNotSuited(): AppError {
  return new AppError("fleet_type_not_installable" satisfies FleetErrorCode, INSTALL_PLATFORM_NOT_SUITED_MESSAGE, 422);
}

/**
 * The public install named no group, and the fleet holds no single one to
 * install in (D25 decision 37): a Kubernetes fleet with several groups (or a
 * server fleet without its Default group, which the opamp-server never
 * answers). The ids in `details.groupIds`; the words name no group.
 */
export function collectorGroupRequired(groupIds: readonly string[]): AppError {
  return new AppError("collector_group_required" satisfies FleetErrorCode, COLLECTOR_GROUP_REQUIRED_MESSAGE, 422, { groupIds: [...groupIds] });
}

/** A server fleet's group asked for a Helm install (D17d-2 Preflight ruling 2): the other direction's words. */
export function fleetTypeNotHelmInstallable(): AppError {
  return new AppError("fleet_type_not_installable" satisfies FleetErrorCode, FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE, 409);
}

/**
 * A Kubernetes group whose settings refuse its Helm install (D17d-2
 * decision 15, Preflight ruling 3): unreadable, a stored role that isn't
 * the group's, a Cluster or a gateway without any.
 */
export function collectorGroupSettingsUnreadable(): AppError {
  return new AppError(
    "collector_group_settings_unreadable" satisfies FleetErrorCode,
    COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
    409,
  );
}

/** A group with no published version: its collector version picks what to install (Q28). */
export function collectorGroupUnassigned(): AppError {
  return new AppError("collector_group_unassigned" satisfies FleetErrorCode, COLLECTOR_GROUP_UNASSIGNED_MESSAGE, 409);
}

/** A group whose published version the platform holds no live version of: a deleted configuration's. */
export function collectorGroupAssignmentDeleted(): AppError {
  return new AppError("collector_group_assignment_deleted" satisfies FleetErrorCode, COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE, 409);
}

/** A published version built for a collector version the catalogue no longer offers (deprecated, or gone). */
export function collectorVersionNotOffered(version: string): AppError {
  return new AppError("collector_version_not_offered" satisfies FleetErrorCode, collectorVersionNotOfferedMessage(version), 409);
}

/** A published version built for a distribution the image and the bundles don't hold (Ruling 47). */
export function collectorDistributionNotInstallable(distribution: string): AppError {
  return new AppError("collector_version_not_offered" satisfies FleetErrorCode, collectorDistributionNotInstallableMessage(distribution), 409);
}

/** A version the catalogue has no binaries of for the bundle's arch (Ruling 47): refused before rendering. */
export function collectorBinariesMissing(version: string, arch: string): AppError {
  return new AppError("collector_version_not_offered" satisfies FleetErrorCode, collectorBinariesMissingMessage(version, arch), 409);
}

/** The install templates can't be read (decision 36): the operator's to fix. */
export function installUnavailable(): AppError {
  return new AppError("install_unavailable" satisfies FleetErrorCode, INSTALL_UNAVAILABLE_MESSAGE, 503);
}

/** A bundle's variables the facts don't offer, its details naming each `env.N.name` (never the name itself). */
export function envVarsNotOffered(indexes: readonly number[]): AppError {
  return new AppError(
    "invalid_request",
    "Only the variables this group's published version reads can be set.",
    400,
    indexes.map((index) => fieldDetail(["env", index, "name"], "Not a variable this group's published version reads.")),
  );
}

// ---------------------------------------------------------------------------
// Quick-deploy links (D17c-2 decisions 22 and 25, Preflight ruling 15).

function quickDeployLinkError(code: QuickDeployLinkErrorCode, statusCode: number): AppError {
  return new AppError(code, QUICK_DEPLOY_LINK_ERROR_MESSAGES[code], statusCode);
}

/** A link the fleet doesn't hold (another fleet's or organization's too), alike for an id that isn't a canonical UUID. */
export function quickDeployLinkNotFound(): AppError {
  return quickDeployLinkError("quick_deploy_link_not_found", 404);
}

/** An extend of a revoked link: a revoked link is never re-enabled (decision 5). */
export function quickDeployLinkRevoked(): AppError {
  return quickDeployLinkError("quick_deploy_link_revoked", 409);
}

/**
 * A create while the fleet holds the most active links, or any extend while the fleet's OTHER active links are at
 * the cap (normally an expired link's: an active link of a full fleet has one fewer others) (decision 22, Rulings 36
 * and 40).
 */
export function quickDeployLinkLimitReached(): AppError {
  return quickDeployLinkError("quick_deploy_link_limit_reached", 409);
}

/** A create while the fleet has no valid default token: the command carries its bearer (decision 10). */
export function enrollmentTokenDefaultMissing(): AppError {
  return quickDeployLinkError("enrollment_token_default_missing", 409);
}

/** A link's create while the organization's "Public install links" switch is off (D17d-2 decision 20). */
export function publicInstallLinksDisabled(): AppError {
  return quickDeployLinkError("public_install_links_disabled", 409);
}

/**
 * A Helm link's variables the chart sets itself (HELM_CHART_ENV_NAMES;
 * D17d-2 Ruling 41): its `env` beats `collectorEnv`'s, so a typed value
 * would be ignored. Each at its index, never the name.
 */
export function helmChartEnvNamesRefused(indexes: readonly number[]): AppError {
  return new AppError(
    "invalid_request",
    HELM_CHART_ENV_NAME_MESSAGE,
    400,
    indexes.map((index) => fieldDetail(["env", index, "name"], HELM_CHART_ENV_NAME_MESSAGE)),
  );
}

/** The person's fleet limits (Preflight ruling 12): the generic 429 with its Retry-After. */
export function fleetsRateLimited(retryAfterSeconds: number): AppError {
  return rateLimited(retryAfterSeconds);
}
