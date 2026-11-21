import { createHash } from "node:crypto";
import { z } from "zod";
import { readCapped, TOO_LARGE } from "../http/read-capped.js";
import {
  collectorGroupListSchema,
  collectorGroupSchema,
  collectorInstanceBulkPinResultSchema,
  collectorInstanceErrorListSchema,
  collectorInstanceListSchema,
  collectorInstanceSchema,
  configurationUsageSchema,
  enrollmentTokenEventListSchema,
  enrollmentTokenListSchema,
  enrollmentTokenRevealedSchema,
  enrollmentTokenRotatedSchema,
  enrollmentTokenSchema,
  errorEnvelopeSchema,
  fleetCreatedSchema,
  fleetDetailSchema,
  fleetListSchema,
  fleetSchema,
  fleetUnchangedSchema,
  organizationIdReplySchema,
  organizationLimitsSchema,
  organizationSchema,
  publicationListSchema,
  publicationSchema,
  variableGroupDetailSchema,
  variableGroupInUseDetailsSchema,
  variableGroupListSchema,
  variableGroupOverrideSchema,
  variableGroupSchema,
  variableInUseDetailsSchema,
  variableListSchema,
  variableSchema,
  variablesUndefinedDetailsSchema,
  type CollectorGroup,
  type CollectorInstance,
  type CollectorInstanceErrorList,
  type CollectorInstanceList,
  type CollectorInstancePin,
  type ConfigurationUsage,
  type EnrollmentToken,
  type EnrollmentTokenEventList,
  type EnrollmentTokenListed,
  type EnrollmentTokenRevealed,
  type EnrollmentTokenRotated,
  type ErrorEnvelope,
  type Fleet,
  type FleetCreated,
  type FleetDetail,
  type FleetList,
  type FleetStatus,
  type FleetType,
  type Organization,
  type OrganizationLimits,
  type Publication,
  type PublicationList,
  type Variable,
  type VariableGroup,
  type VariableGroupDetail,
  type VariableGroupOverride,
} from "./schemas.js";

// The platform's client for the opamp-server's management API (the contract is
// vendor/opamp-server/openapi.yaml). Each method answers a typed result for
// every answer the API documents, rather than throwing. The organization
// methods are called after the platform's own commits
// (modules/organizations/opamp-registration.ts).
//
// Two answers are thrown instead, as an OpampServerMisconfigurationError:
// a 401 (the platform's secret isn't one the server takes) and a reply that
// isn't what the API documents (a wrong URL, or a server of another
// version). Neither is something a caller can handle; both are a deployment
// to fix.
//
// The secret, the Authorization header and the YAML are never logged and
// never put in an error's message: this module logs nothing, and its
// errors name the operation, the status and the fields at fault only.
//
// There is a method for each of the fleet model's 23 operations (fleets,
// collector groups, enrollment tokens, collectors, limits and a
// configuration's usage), each documented error code its own result kind.
// Every reply, the organization and publication operations' included, is read
// under its operation's size cap (REPLY_CLASSES): a longer one is
// `unavailable` (`oversized_reply`), the rest never read. The ids a reply
// echoes are checked against the request, a mismatch thrown like any other
// undocumented answer. No error carries a URL, a path or a query (a collector
// list's `q` holds a collector's name or address), a bearer, a YAML, a
// reported attribute or a collector's error text. The caller passes every
// actor: this client never names one itself.
//
// The organization variables have 11 operations (variables, variable groups
// and their overrides), and a group, a collector's PATCH and the bulk pin
// carry their bindings. A variable's value, name and description, and a
// variable group's name and description, are configuration text: never in
// an error's message. The three guards' refusals (`variable_in_use`,
// `variable_group_in_use`, `variables_undefined`) carry their parsed
// details: ids, counts and names.

/** A publication as the caller sends it (openapi.yaml's PublicationRequest). */
export interface PublicationRequest {
  configuration: { id: string; name: string };
  version: { id: string; number: number; label: string | null };
  yaml: string;
  /** The SHA-256 of `yaml`'s UTF-8 bytes, which the caller computes (`sha256Hex`). */
  sha256: string;
  publishedBy: { id: string; email: string } | null;
  /** RFC 3339; the server keeps it to the millisecond, dropping anything finer. */
  publishedAt: string;
  /** The collector it is published for: the configuration's distribution and the version's pin. */
  collector: PublicationCollector;
}

/**
 * openapi.yaml's Collector: a catalog distribution's id and one of its
 * versions, both required. The server refuses null.
 */
export interface PublicationCollector {
  /** Lowercase letters and digits in words joined by single hyphens, at most 64 characters: `otelcol-contrib`. */
  distribution: string;
  /** major.minor.patch, at most 64 characters: `0.162.0`. */
  version: string;
}

/** An organization to register (openapi.yaml's OrganizationCreateRequest). */
export interface CreateOrganizationRequest {
  /** The platform always passes its own; without one the server generates one, and a retry registers another. */
  id?: string;
  /** Display-only, 1 to 400 characters, kept exactly as sent. */
  name: string;
}

/**
 * The server couldn't be asked: a 5xx, a network error, no answer in time,
 * or a reply longer than its operation's cap.
 */
export type Unavailable =
  | { kind: "unavailable"; reason: "timeout" }
  | { kind: "unavailable"; reason: "network" }
  | { kind: "unavailable"; reason: "server_error"; status: number }
  | { kind: "unavailable"; reason: "oversized_reply" };

/**
 * The server refused the request (400, 413 or 422), by its code. The
 * envelope's message isn't kept: no caller surfaces or logs it,
 * and the code says which refusal it was.
 */
export interface Invalid {
  kind: "invalid";
  code: "invalid_request" | "payload_too_large" | "sha256_mismatch";
}

/** A publication route under an organization that isn't registered (404 `organization_not_found`). */
export interface OrganizationNotFound {
  kind: "organization_not_found";
}

export type CreateOrganizationResult =
  /** Registered now (201). */
  | { kind: "created"; organizationId: string }
  /** The id was already registered with exactly this name (200): a safe retry. */
  | { kind: "unchanged"; organizationId: string }
  /** The id is registered with another name (409); a create never renames. */
  | { kind: "conflict" }
  | Invalid
  | Unavailable;

export type GetOrganizationResult = { kind: "found"; organization: Organization } | { kind: "not_found" } | Invalid | Unavailable;

export type RenameOrganizationResult =
  | { kind: "renamed"; organization: Organization }
  | { kind: "not_found" }
  | Invalid
  | Unavailable;

export type DeleteOrganizationResult = { kind: "deleted" } | { kind: "not_found" } | Invalid | Unavailable;

export type PostPublicationResult =
  | { kind: "created"; publication: Publication }
  | { kind: "unchanged"; publication: Publication }
  | { kind: "conflict" }
  | OrganizationNotFound
  | Invalid
  | Unavailable;

export type GetPublicationResult =
  | { kind: "found"; publication: Publication }
  | { kind: "not_found" }
  | OrganizationNotFound
  | Invalid
  | Unavailable;

export type ListPublicationsResult = { kind: "page"; page: PublicationList } | OrganizationNotFound | Invalid | Unavailable;

/**
 * The published version, or one of the configuration's, is assigned to a
 * collector group or pinned on a collector (409 `publication_in_use`): the
 * opamp-server deleted nothing.
 */
export interface InUse {
  kind: "in_use";
}

export type DeletePublicationResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | InUse
  | OrganizationNotFound
  | Invalid
  | Unavailable;

export type DeleteConfigurationPublicationsResult = { kind: "deleted" } | InUse | OrganizationNotFound | Invalid | Unavailable;

export interface ListPublicationsQuery {
  configurationId: string;
  /** 1 to 100; the server's default is 50. */
  limit?: number;
  /** A `nextCursor` from an earlier page. */
  cursor?: string;
}

// ---------------------------------------------------------------------------
// The fleet model: requests and results.

type ErrorCode = ErrorEnvelope["error"]["code"];

/**
 * The refusals whose envelope carries a `details` object (at most 100
 * entries, with exact totals), each with its schema.
 */
const DETAILS = {
  variable_in_use: variableInUseDetailsSchema,
  variable_group_in_use: variableGroupInUseDetailsSchema,
  variables_undefined: variablesUndefinedDetailsSchema,
} as const;

type DetailedCode = keyof typeof DETAILS;

/**
 * A refusal the API documents by its error code, answered as a result whose
 * kind is that code (`fleet_not_found`, `collector_name_taken`, …); the three
 * guards' with their parsed `details` too.
 */
export type Refused<Code extends ErrorCode> = Code extends DetailedCode
  ? { kind: Code; details: z.infer<(typeof DETAILS)[Code]> }
  : Code extends ErrorCode
    ? { kind: Code }
    : never;

/** Who acts, for the opamp-server's audit (openapi.yaml's Actor): always the caller's, or null for no person. */
export type OpampActor = { id: string; email: string } | null;

/** openapi.yaml's FleetCreateRequest. */
export interface CreateFleetRequest {
  /** The platform always passes its own, so a retry is safe (200, `unchanged`). */
  id?: string;
  label: string;
  type: FleetType;
  /** RFC 3339, in the future; null for a rotate token that never expires. */
  rotateExpiresAt: string | null;
  actor: OpampActor;
}

export interface ListFleetsQuery {
  status?: FleetStatus;
  /** 1 to 100; the server's default is 50. */
  limit?: number;
  /** A `nextCursor` from an earlier page. */
  cursor?: string;
}

/** openapi.yaml's FleetUpdateRequest: at least one field. */
export interface UpdateFleetRequest {
  label?: string;
  status?: FleetStatus;
}

/**
 * The assignment and the annotations of a collector group; null unsets. A
 * Kubernetes group's role, namespace, replicas and volumes live in its
 * annotations, under the platform's "telflo" key.
 */
interface CollectorGroupFields {
  assignedPublicationId?: string | null;
  /** CollectorGroupAnnotations: an object replaces the group's whole. */
  annotations?: Record<string, unknown> | null;
  /** The variable group its collectors' text is filled in with; null for none. */
  variableGroupId?: string | null;
}

/** openapi.yaml's CollectorGroupCreateRequest. */
export interface CreateCollectorGroupRequest extends CollectorGroupFields {
  name: string;
}

/** openapi.yaml's CollectorGroupUpdateRequest: at least one field. */
export interface UpdateCollectorGroupRequest extends CollectorGroupFields {
  name?: string;
}

/** openapi.yaml's EnrollmentTokenRotateRequest. */
export interface RotateEnrollmentTokenRequest {
  /** RFC 3339, or null: the new rotate token never expires. */
  expiresAt: string | null;
  /** RFC 3339, in the future and not after `expiresAt`. */
  graceEndsAt: string;
  actor: OpampActor;
}

export interface ListCollectorInstancesQuery {
  /** At most 100 characters: a collector's name or address. Never logged. */
  q?: string;
  groupId?: string;
  sort?: "created" | "lastSeen" | "name";
  order?: "asc" | "desc";
  /** 1 to 100; the server's default is 50. */
  limit?: number;
  /** A `nextCursor` from an earlier page of the same sort and order. */
  cursor?: string;
}

/**
 * openapi.yaml's CollectorInstanceBulkPinRequest: at least one of `pin` and
 * `pinnedVariableGroupId`; a field left out leaves each collector's
 * as it is.
 */
export type PinCollectorInstancesRequest = {
  /** 1 to 500. */
  collectorIds: string[];
} & (
  | {
      /** Null unpins. */
      pin: CollectorInstancePin;
      /** Null returns each to its group's variable group. */
      pinnedVariableGroupId?: string | null;
    }
  | { pin?: CollectorInstancePin; pinnedVariableGroupId: string | null }
);

/** openapi.yaml's CollectorInstanceUpdateRequest: at least one field. */
export interface UpdateCollectorInstanceRequest {
  name?: string;
  groupId?: string;
  /** Null unpins. */
  pin?: CollectorInstancePin;
  /** A variable group pinned on it; null returns it to its group's. */
  pinnedVariableGroupId?: string | null;
}

/** openapi.yaml's VariableCreateRequest. */
export interface CreateVariableRequest {
  /** The platform always passes its own, so a retry is safe (200, `unchanged`). */
  id?: string;
  /** The reference's NAME, `${org:NAME}`: the renderer's grammar, at most 128 characters. */
  name: string;
  /** 0 to 1,024 characters on one line. Configuration text: never logged. */
  value: string;
  description: string | null;
  actor: OpampActor;
}

/** openapi.yaml's VariableUpdateRequest: at least one of `name`, `value` and `description` (null removes it). */
export interface UpdateVariableRequest {
  name?: string;
  value?: string;
  description?: string | null;
  actor: OpampActor;
}

/** openapi.yaml's VariableGroupCreateRequest. */
export interface CreateVariableGroupRequest {
  /** The platform always passes its own, so a retry is safe (200, `unchanged`). */
  id?: string;
  name: string;
  description: string | null;
  actor: OpampActor;
}

/** openapi.yaml's VariableGroupUpdateRequest: at least one of `name` and `description` (null removes it). */
export interface UpdateVariableGroupRequest {
  name?: string;
  description?: string | null;
  actor: OpampActor;
}

/** openapi.yaml's VariableGroupOverrideRequest. */
export interface SetVariableGroupOverrideRequest {
  value: string;
  actor: OpampActor;
}

/** A list's paging: a collector's errors. */
export interface PageQuery {
  /** 1 to 100; the server's default is 50. */
  limit?: number;
  /** A `nextCursor` from an earlier page. */
  cursor?: string;
}

type FleetNotFound = Refused<"organization_not_found" | "fleet_not_found">;

export type GetConfigurationUsageResult =
  | { kind: "found"; usage: ConfigurationUsage }
  | Refused<"organization_not_found">
  | Invalid
  | Unavailable;

export type GetLimitsResult = { kind: "found"; limits: OrganizationLimits } | Refused<"organization_not_found"> | Invalid | Unavailable;

export type SetLimitsResult = { kind: "set"; limits: OrganizationLimits } | Refused<"organization_not_found"> | Invalid | Unavailable;

export type CreateFleetResult =
  /** Created now (201): the only answer that carries both tokens' bearers. */
  | ({ kind: "created" } & FleetCreated)
  /** The organization already holds this fleet, with this label and type (200): no bearer. */
  | { kind: "unchanged"; fleet: Fleet }
  | Refused<"organization_not_found" | "fleet_conflict" | "fleet_label_taken">
  | Invalid
  | Unavailable;

export type ListFleetsResult = { kind: "page"; page: FleetList } | Refused<"organization_not_found"> | Invalid | Unavailable;

export type GetFleetResult = { kind: "found"; fleet: FleetDetail } | FleetNotFound | Invalid | Unavailable;

export type UpdateFleetResult =
  | { kind: "updated"; fleet: Fleet }
  | FleetNotFound
  | Refused<"fleet_label_taken">
  | Invalid
  | Unavailable;

export type DeleteFleetResult = { kind: "deleted" } | FleetNotFound | Invalid | Unavailable;

export type ListCollectorGroupsResult = { kind: "listed"; groups: CollectorGroup[] } | FleetNotFound | Invalid | Unavailable;

/**
 * An assignment's or a pin's 422 (openapi.yaml's GroupAssignmentRefused and
 * PinRefused): a published version or a variable group the organization
 * doesn't hold, or a published version referencing names no variable has
 * (with the names).
 */
type AssignmentRefused = Refused<"publication_not_found" | "variable_group_not_found" | "variables_undefined">;

export type CreateCollectorGroupResult =
  | { kind: "created"; group: CollectorGroup }
  | FleetNotFound
  | Refused<"collector_group_name_taken">
  | AssignmentRefused
  | Invalid
  | Unavailable;

type CollectorGroupNotFound = Refused<"organization_not_found" | "fleet_not_found" | "collector_group_not_found">;

export type GetCollectorGroupResult = { kind: "found"; group: CollectorGroup } | CollectorGroupNotFound | Invalid | Unavailable;

export type UpdateCollectorGroupResult =
  | { kind: "updated"; group: CollectorGroup }
  | CollectorGroupNotFound
  | Refused<"collector_group_name_taken" | "collector_group_is_default">
  | AssignmentRefused
  | Invalid
  | Unavailable;

export type DeleteCollectorGroupResult =
  | { kind: "deleted" }
  | CollectorGroupNotFound
  | Refused<"collector_group_is_default">
  | Invalid
  | Unavailable;

type EnrollmentTokenNotFound = Refused<"organization_not_found" | "fleet_not_found" | "enrollment_token_not_found">;

export type ListEnrollmentTokensResult = { kind: "listed"; tokens: EnrollmentTokenListed[] } | FleetNotFound | Invalid | Unavailable;

export type ListEnrollmentTokenEventsResult = { kind: "page"; page: EnrollmentTokenEventList } | FleetNotFound | Invalid | Unavailable;

export type RotateEnrollmentTokenResult =
  | { kind: "rotated"; token: EnrollmentTokenRotated }
  | FleetNotFound
  | Refused<"fleet_archived">
  | Invalid
  | Unavailable;

export type IssueDefaultEnrollmentTokenResult =
  | { kind: "issued"; token: EnrollmentTokenRevealed }
  | FleetNotFound
  | Refused<"fleet_archived" | "enrollment_token_default_exists">
  | Invalid
  | Unavailable;

export type RevealEnrollmentTokenResult =
  | { kind: "revealed"; token: EnrollmentTokenRevealed }
  | EnrollmentTokenNotFound
  | Refused<"enrollment_token_revoked" | "enrollment_token_expired">
  | Invalid
  | Unavailable;

export type RevokeEnrollmentTokenResult =
  | { kind: "revoked"; token: EnrollmentToken }
  | EnrollmentTokenNotFound
  | Invalid
  | Unavailable;

type CollectorNotFound = Refused<"organization_not_found" | "fleet_not_found" | "collector_not_found">;

export type ListCollectorInstancesResult = { kind: "page"; page: CollectorInstanceList } | FleetNotFound | Invalid | Unavailable;

export type PinCollectorInstancesResult =
  /** `updated`: the fleet's collectors now pinned as asked; `notFound`: the ids it doesn't hold. */
  | { kind: "pinned"; updated: string[]; notFound: string[] }
  | FleetNotFound
  | AssignmentRefused
  | Invalid
  | Unavailable;

export type GetCollectorInstanceResult = { kind: "found"; collector: CollectorInstance } | CollectorNotFound | Invalid | Unavailable;

export type UpdateCollectorInstanceResult =
  | { kind: "updated"; collector: CollectorInstance }
  | CollectorNotFound
  | Refused<"collector_group_not_found" | "collector_name_taken">
  | AssignmentRefused
  | Invalid
  | Unavailable;

export type DeleteCollectorInstanceResult = { kind: "deleted" } | CollectorNotFound | Invalid | Unavailable;

export type ListCollectorInstanceErrorsResult =
  | { kind: "page"; page: CollectorInstanceErrorList }
  | CollectorNotFound
  | Invalid
  | Unavailable;

// ---------------------------------------------------------------------------
// The organization variables: results.

type VariableNotFound = Refused<"organization_not_found" | "variable_not_found">;
type VariableGroupNotFound = Refused<"organization_not_found" | "variable_group_not_found">;
/** An override's path names a variable group or a variable the organization doesn't hold. */
type OverrideTargetNotFound = Refused<"organization_not_found" | "variable_group_not_found" | "variable_not_found">;

export type ListVariablesResult = { kind: "listed"; variables: Variable[] } | Refused<"organization_not_found"> | Invalid | Unavailable;

export type CreateVariableResult =
  | { kind: "created"; variable: Variable }
  /** The organization already holds this id with this name, value and description (200): a safe retry. */
  | { kind: "unchanged"; variable: Variable }
  | Refused<"organization_not_found" | "variable_conflict" | "variable_name_taken" | "variable_limit_reached">
  | Invalid
  | Unavailable;

export type UpdateVariableResult =
  | { kind: "updated"; variable: Variable }
  | VariableNotFound
  | Refused<"variable_name_taken" | "variable_in_use">
  | Invalid
  | Unavailable;

export type DeleteVariableResult = { kind: "deleted" } | VariableNotFound | Refused<"variable_in_use"> | Invalid | Unavailable;

export type ListVariableGroupsResult =
  | { kind: "listed"; variableGroups: VariableGroup[] }
  | Refused<"organization_not_found">
  | Invalid
  | Unavailable;

export type CreateVariableGroupResult =
  | { kind: "created"; variableGroup: VariableGroup }
  /** The organization already holds this id with this name and description (200): a safe retry. */
  | { kind: "unchanged"; variableGroup: VariableGroup }
  | Refused<"organization_not_found" | "variable_group_conflict" | "variable_group_name_taken" | "variable_group_limit_reached">
  | Invalid
  | Unavailable;

export type GetVariableGroupResult = ({ kind: "found" } & VariableGroupDetail) | VariableGroupNotFound | Invalid | Unavailable;

export type UpdateVariableGroupResult =
  | { kind: "updated"; variableGroup: VariableGroup }
  | VariableGroupNotFound
  | Refused<"variable_group_name_taken">
  | Invalid
  | Unavailable;

export type DeleteVariableGroupResult =
  | { kind: "deleted" }
  | VariableGroupNotFound
  | Refused<"variable_group_in_use">
  | Invalid
  | Unavailable;

export type SetVariableGroupOverrideResult =
  /**
   * The override as it now is, whether new (201, a reset one revived
   * included), replaced or the same value again (200): the caller can't
   * tell those apart, and doesn't need to.
   */
  | { kind: "set"; override: VariableGroupOverride }
  | OverrideTargetNotFound
  | Invalid
  | Unavailable;

/** `reset` whether or not there was an override to reset (204). */
export type ResetVariableGroupOverrideResult = { kind: "reset" } | OverrideTargetNotFound | Invalid | Unavailable;

export interface OpampServerClient {
  createOrganization(organization: CreateOrganizationRequest): Promise<CreateOrganizationResult>;
  getOrganization(organizationId: string): Promise<GetOrganizationResult>;
  renameOrganization(organizationId: string, name: string): Promise<RenameOrganizationResult>;
  /**
   * Deletes the organization and, by the server's cascade, every publication it owns. A 503
   * `delete_in_progress` (the server already running this delete) is `unavailable`, as every 5xx.
   */
  deleteOrganization(organizationId: string): Promise<DeleteOrganizationResult>;
  postPublication(organizationId: string, publicationId: string, publication: PublicationRequest): Promise<PostPublicationResult>;
  getPublication(organizationId: string, publicationId: string): Promise<GetPublicationResult>;
  listPublications(organizationId: string, query: ListPublicationsQuery): Promise<ListPublicationsResult>;
  /** `in_use` while a collector group is assigned it or a collector is pinned to it (nothing is deleted). */
  deletePublication(organizationId: string, publicationId: string): Promise<DeletePublicationResult>;
  /** `in_use` while a collector group or a collector uses any of them (none is deleted). */
  deleteConfigurationPublications(
    organizationId: string,
    configurationId: string,
  ): Promise<DeleteConfigurationPublicationsResult>;

  // The fleet model.
  /** Each published version of the configuration and what uses it; `inUse` while any is used. */
  getConfigurationUsage(organizationId: string, configurationId: string): Promise<GetConfigurationUsageResult>;
  getLimits(organizationId: string): Promise<GetLimitsResult>;
  setLimits(organizationId: string, limits: OrganizationLimits): Promise<SetLimitsResult>;
  /** `created` carries both tokens' bearers, answered this once; `unchanged` (a retry) none. */
  createFleet(organizationId: string, fleet: CreateFleetRequest): Promise<CreateFleetResult>;
  listFleets(organizationId: string, query?: ListFleetsQuery): Promise<ListFleetsResult>;
  getFleet(organizationId: string, fleetId: string): Promise<GetFleetResult>;
  updateFleet(organizationId: string, fleetId: string, changes: UpdateFleetRequest): Promise<UpdateFleetResult>;
  /**
   * Deletes the fleet and everything it holds. A 503 `delete_in_progress` (the server already
   * running this delete, or its organization's) is `unavailable`, as every 5xx.
   */
  deleteFleet(organizationId: string, fleetId: string): Promise<DeleteFleetResult>;
  listCollectorGroups(organizationId: string, fleetId: string): Promise<ListCollectorGroupsResult>;
  createCollectorGroup(
    organizationId: string,
    fleetId: string,
    group: CreateCollectorGroupRequest,
  ): Promise<CreateCollectorGroupResult>;
  getCollectorGroup(organizationId: string, fleetId: string, groupId: string): Promise<GetCollectorGroupResult>;
  updateCollectorGroup(
    organizationId: string,
    fleetId: string,
    groupId: string,
    changes: UpdateCollectorGroupRequest,
  ): Promise<UpdateCollectorGroupResult>;
  /**
   * Its collectors (and their error history) are deleted with it, in one
   * transaction: a long delete, waited for as a fleet's
   * (DELETE_OPAMP_SERVER_TIMEOUT_MS).
   */
  deleteCollectorGroup(organizationId: string, fleetId: string, groupId: string): Promise<DeleteCollectorGroupResult>;
  listEnrollmentTokens(organizationId: string, fleetId: string): Promise<ListEnrollmentTokensResult>;
  /** A page of the fleet's token events, newest first: ids, the actor and the time, never a bearer. */
  listEnrollmentTokenEvents(organizationId: string, fleetId: string, query?: PageQuery): Promise<ListEnrollmentTokenEventsResult>;
  /** `rotated` carries the new token's bearer. */
  rotateEnrollmentToken(
    organizationId: string,
    fleetId: string,
    rotation: RotateEnrollmentTokenRequest,
  ): Promise<RotateEnrollmentTokenResult>;
  /**
   * A new default token once every default token the fleet had is revoked:
   * `issued` carries its bearer; the opamp-server records `actor` issued it.
   */
  issueDefaultEnrollmentToken(organizationId: string, fleetId: string, actor: OpampActor): Promise<IssueDefaultEnrollmentTokenResult>;
  /** `revealed` carries a fresh bearer; the opamp-server records `actor` viewed it. */
  revealEnrollmentToken(
    organizationId: string,
    fleetId: string,
    tokenId: string,
    actor: OpampActor,
  ): Promise<RevealEnrollmentTokenResult>;
  revokeEnrollmentToken(
    organizationId: string,
    fleetId: string,
    tokenId: string,
    actor: OpampActor,
  ): Promise<RevokeEnrollmentTokenResult>;
  listCollectorInstances(
    organizationId: string,
    fleetId: string,
    query?: ListCollectorInstancesQuery,
  ): Promise<ListCollectorInstancesResult>;
  pinCollectorInstances(
    organizationId: string,
    fleetId: string,
    request: PinCollectorInstancesRequest,
  ): Promise<PinCollectorInstancesResult>;
  getCollectorInstance(organizationId: string, fleetId: string, collectorId: string): Promise<GetCollectorInstanceResult>;
  updateCollectorInstance(
    organizationId: string,
    fleetId: string,
    collectorId: string,
    changes: UpdateCollectorInstanceRequest,
  ): Promise<UpdateCollectorInstanceResult>;
  deleteCollectorInstance(
    organizationId: string,
    fleetId: string,
    collectorId: string,
  ): Promise<DeleteCollectorInstanceResult>;
  listCollectorInstanceErrors(
    organizationId: string,
    fleetId: string,
    collectorId: string,
    query?: PageQuery,
  ): Promise<ListCollectorInstanceErrorsResult>;

  // The organization variables. Every write names the caller's actor, which
  // the opamp-server records as `changedBy`.
  /** Every variable of the organization, values included (no secrets): what test runs and validation fill in. */
  listVariables(organizationId: string): Promise<ListVariablesResult>;
  createVariable(organizationId: string, variable: CreateVariableRequest): Promise<CreateVariableResult>;
  /** A rename is `variable_in_use` while a used published version references the old name; a value change never is. */
  updateVariable(organizationId: string, variableId: string, changes: UpdateVariableRequest): Promise<UpdateVariableResult>;
  /** `variable_in_use` while a used published version references its name (nothing is deleted). */
  deleteVariable(organizationId: string, variableId: string): Promise<DeleteVariableResult>;
  listVariableGroups(organizationId: string): Promise<ListVariableGroupsResult>;
  createVariableGroup(organizationId: string, variableGroup: CreateVariableGroupRequest): Promise<CreateVariableGroupResult>;
  getVariableGroup(organizationId: string, variableGroupId: string): Promise<GetVariableGroupResult>;
  updateVariableGroup(
    organizationId: string,
    variableGroupId: string,
    changes: UpdateVariableGroupRequest,
  ): Promise<UpdateVariableGroupResult>;
  /** `variable_group_in_use` while a collector group or a collector uses it (nothing is deleted). */
  deleteVariableGroup(organizationId: string, variableGroupId: string): Promise<DeleteVariableGroupResult>;
  setVariableGroupOverride(
    organizationId: string,
    variableGroupId: string,
    variableId: string,
    override: SetVariableGroupOverrideRequest,
  ): Promise<SetVariableGroupOverrideResult>;
  /** The opamp-server records `actor` as the reset's `changedBy`. */
  resetVariableGroupOverride(
    organizationId: string,
    variableGroupId: string,
    variableId: string,
    actor: OpampActor,
  ): Promise<ResetVariableGroupOverrideResult>;
}

export interface OpampServerClientOptions {
  /** The management API's base URL, e.g. `http://opamp-server:51235`. */
  url: string;
  /** The shared management secret. Never logged. */
  secret: string;
  /** Tests only; the global fetch by default. */
  fetch?: typeof fetch;
  /**
   * How long a call may take, reading the reply included. Default 5000, and
   * DELETE_OPAMP_SERVER_TIMEOUT_MS for an organization's, a fleet's or a
   * group's delete. Given (tests only), it bounds every call, the three long
   * deletes too, unless `deleteTimeoutMs` is given as well. Production passes
   * neither (index.ts and stack-smoke.ts pass the settings' url and secret
   * only), so its deletes wait the full 25 s.
   */
  timeoutMs?: number;
  /** Tests only: how long an organization's, a fleet's or a group's delete may take. */
  deleteTimeoutMs?: number;
  /** Tests only: a class's cap in bytes, OPAMP_SERVER_REPLY_CAPS's by default. */
  maxReplyBytes?: Partial<Record<OpampServerReplyClass, number>>;
}

/**
 * Thrown for an answer no caller can handle: the server refused the secret
 * (401), or answered something the API doesn't document. Its message names
 * the operation, the status and the fields at fault: never the secret, the
 * Authorization header or the YAML.
 */
export class OpampServerMisconfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpampServerMisconfigurationError";
  }
}

/** The SHA-256 of `yaml`'s UTF-8 bytes, as 64 lowercase hex digits: a publication's `sha256`. */
export function sha256Hex(yaml: string): string {
  return createHash("sha256").update(yaml, "utf8").digest("hex");
}

export const DEFAULT_OPAMP_SERVER_TIMEOUT_MS = 5000;

/**
 * How long an organization's, a fleet's or a collector group's delete may
 * take (a group's deletes its collectors with it): a cascade through tens
 * of thousands of collectors outlasts the 5 s every other call gets. The
 * opamp-server finishes a delete once started even if the platform hangs up
 * (its long delete context, bounded at 5 minutes), and a retry's 404 counts
 * as done, so this is how long the platform waits for the answer, under the
 * management listener's 30 s write timeout.
 */
export const DELETE_OPAMP_SERVER_TIMEOUT_MS = 25_000;

/** The operations DELETE_OPAMP_SERVER_TIMEOUT_MS bounds. */
const LONG_DELETES: ReadonlySet<Operation> = new Set<Operation>(["deleteOrganization", "deleteFleet", "deleteCollectorGroup"]);

/**
 * The reply size classes, each cap above its operations' worst documented
 * reply as the real server encodes it: S 64 KiB (an organization, limits, one
 * fleet, group or token, a bulk pin's ids, an empty 204), M 1 MiB (a page of
 * fleets, of publications or of a fleet's token events; one collector, its
 * attributes and error text), U 4 MiB (a fleet's groups and tokens and a
 * configuration's usage, unpaged), L 10 MiB (a page of collectors or of a
 * collector's errors; a publication's YAML). A cap under a documented reply
 * would make one collector able to break a route for good.
 *
 * The organization variables, unpaged (at most 150 variables, a value of at
 * most 1,024 characters), are U: listVariables' worst reply is about 1.85 MB
 * (150 variables, each a value of 1,024 four-byte characters, a description
 * of 1,000 characters whose 998 inner ones are U+2028 (it can't start or
 * end with one), which Go writes as a 6-byte escape, and an actor's email
 * of 320 characters escaped alike), over M's cap; and getVariableGroup's is
 * about 0.94 MB (the group and 150 overrides of 1,024 four-byte characters
 * with their actors), U like listVariableGroups' 100 groups (about 0.94 MB,
 * U+2028 throughout) rather than M with a tenth to spare. One variable,
 * group or override, and a 409's details (at most 100 entries, about 20 KB
 * with a group each), are S; so are a group's or a pin's 422
 * `variables_undefined`, at most 100 names of at most 128 characters (about
 * 13 KB). The sizes assume the opamp-server writes its replies through
 * writeJSON, with HTML escaping off.
 */
export type OpampServerReplyClass = "S" | "M" | "U" | "L";

export const OPAMP_SERVER_REPLY_CAPS: Readonly<Record<OpampServerReplyClass, number>> = {
  S: 64 * 1024,
  M: 1024 * 1024,
  U: 4 * 1024 * 1024,
  L: 10 * 1024 * 1024,
};

/** Every operation's class: the ruling's table. */
const REPLY_CLASSES = {
  createOrganization: "S",
  getOrganization: "S",
  renameOrganization: "S",
  deleteOrganization: "S",
  postPublication: "L",
  getPublication: "L",
  listPublications: "M",
  deletePublication: "S",
  deleteConfigurationPublications: "S",
  getConfigurationUsage: "U",
  getLimits: "S",
  setLimits: "S",
  createFleet: "S",
  listFleets: "M",
  getFleet: "S",
  updateFleet: "S",
  deleteFleet: "S",
  listCollectorGroups: "U",
  createCollectorGroup: "S",
  getCollectorGroup: "S",
  updateCollectorGroup: "S",
  deleteCollectorGroup: "S",
  listEnrollmentTokens: "U",
  listEnrollmentTokenEvents: "M",
  rotateEnrollmentToken: "S",
  issueDefaultEnrollmentToken: "S",
  revealEnrollmentToken: "S",
  revokeEnrollmentToken: "S",
  listCollectorInstances: "L",
  pinCollectorInstances: "S",
  getCollectorInstance: "M",
  updateCollectorInstance: "M",
  deleteCollectorInstance: "S",
  listCollectorInstanceErrors: "L",
  // The organization variables.
  listVariables: "U",
  createVariable: "S",
  updateVariable: "S",
  deleteVariable: "S",
  listVariableGroups: "U",
  createVariableGroup: "S",
  getVariableGroup: "U",
  updateVariableGroup: "S",
  deleteVariableGroup: "S",
  setVariableGroupOverride: "S",
  resetVariableGroupOverride: "S",
} as const satisfies Record<string, OpampServerReplyClass>;

type Operation = keyof typeof REPLY_CLASSES;

/** A reply the client read: its status and body, already parsed as JSON when it had one. */
interface Reply {
  status: number;
  body: unknown;
}

const INVALID_CODES = {
  400: "invalid_request",
  413: "payload_too_large",
  422: "sha256_mismatch",
} as const;

export function createOpampServerClient(options: OpampServerClientOptions): OpampServerClient {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPAMP_SERVER_TIMEOUT_MS;
  const deleteTimeoutMs = options.deleteTimeoutMs ?? options.timeoutMs ?? DELETE_OPAMP_SERVER_TIMEOUT_MS;
  const timeoutOf = (operation: Operation): number => (LONG_DELETES.has(operation) ? deleteTimeoutMs : timeoutMs);
  const capOf = (operation: Operation): number => {
    const replyClass = REPLY_CLASSES[operation];
    return options.maxReplyBytes?.[replyClass] ?? OPAMP_SERVER_REPLY_CAPS[replyClass];
  };

  function organizationPath(organizationId: string): string {
    return `${base}/api/v1/organizations/${encodeURIComponent(organizationId)}`;
  }

  function fleetPath(organizationId: string, fleetId: string): string {
    return `${organizationPath(organizationId)}/fleets/${encodeURIComponent(fleetId)}`;
  }

  function variablesPath(organizationId: string): string {
    return `${organizationPath(organizationId)}/variables`;
  }

  function variablePath(organizationId: string, variableId: string): string {
    return `${variablesPath(organizationId)}/${encodeURIComponent(variableId)}`;
  }

  function variableGroupsPath(organizationId: string): string {
    return `${organizationPath(organizationId)}/variable-groups`;
  }

  function variableGroupPath(organizationId: string, variableGroupId: string): string {
    return `${variableGroupsPath(organizationId)}/${encodeURIComponent(variableGroupId)}`;
  }

  function overridePath(organizationId: string, variableGroupId: string, variableId: string): string {
    return `${variableGroupPath(organizationId, variableGroupId)}/overrides/${encodeURIComponent(variableId)}`;
  }

  /**
   * Sends one request and reads its reply, under its operation's cap, within
   * its operation's timeout. A 5xx, a network error, the timeout or a reply
   * over the cap is Unavailable; a 401 throws. Redirects aren't followed: the API never
   * answers one, and following it would send the secret on.
   */
  async function send(
    operation: Operation,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: object,
  ): Promise<Reply | Unavailable> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOf(operation));
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${options.secret}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        // The error's own text is dropped: it can quote the request.
        return unavailableAfterFailure(controller);
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unavailable", reason: "server_error", status: response.status };
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpampServerMisconfigurationError(
          `The opamp-server answered ${operation} with 401: it doesn't accept TELFLO_OPAMP_MANAGEMENT_SECRET.`,
        );
      }
      let text: string | typeof TOO_LARGE;
      try {
        text = await readCapped(response, capOf(operation));
      } catch {
        return unavailableAfterFailure(controller);
      }
      if (text === TOO_LARGE) return { kind: "unavailable", reason: "oversized_reply" };
      if (text === "") return { status: response.status, body: undefined };
      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new OpampServerMisconfigurationError(
          `The opamp-server's reply to ${operation} (${response.status}) wasn't JSON.`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends one request and answers its reply by status: each status the
   * operation documents has its handler, and any other throws.
   */
  async function call<Result>(
    operation: Operation,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body: object | undefined,
    handlers: Partial<Record<number, (reply: Reply) => Result>>,
  ): Promise<Result | Unavailable> {
    const reply = await send(operation, method, url, body);
    if (isUnavailable(reply)) return reply;
    const handler = handlers[reply.status];
    if (handler === undefined) throw undocumentedStatus(operation, reply);
    return handler(reply);
  }

  return {
    async createOrganization(organization) {
      const operation = "createOrganization";
      const body: CreateOrganizationRequest =
        organization.id === undefined ? { name: organization.name } : { id: organization.id, name: organization.name };
      const reply = await send(operation, "POST", `${base}/api/v1/organizations`, body);
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 201:
        case 200: {
          const { organizationId } = parse(operation, reply, organizationIdReplySchema);
          if (organization.id !== undefined && !sameId(organizationId, organization.id)) {
            throw new OpampServerMisconfigurationError(
              `The opamp-server's reply to ${operation} (${reply.status}) named another organization.`,
            );
          }
          return { kind: reply.status === 201 ? "created" : "unchanged", organizationId };
        }
        case 409:
          expectCode(operation, reply, "organization_conflict");
          return { kind: "conflict" };
        case 400:
        case 413:
          return invalid(operation, reply, reply.status);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async getOrganization(organizationId) {
      const operation = "getOrganization";
      const reply = await send(operation, "GET", organizationPath(organizationId));
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 200:
          return { kind: "found", organization: parseOrganization(operation, reply, organizationId) };
        case 404:
          expectCode(operation, reply, "not_found");
          return { kind: "not_found" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async renameOrganization(organizationId, name) {
      const operation = "renameOrganization";
      const reply = await send(operation, "PATCH", organizationPath(organizationId), { name });
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 200:
          return { kind: "renamed", organization: parseOrganization(operation, reply, organizationId) };
        case 404:
          expectCode(operation, reply, "not_found");
          return { kind: "not_found" };
        case 400:
        case 413:
          return invalid(operation, reply, reply.status);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async deleteOrganization(organizationId) {
      const operation = "deleteOrganization";
      const reply = await send(operation, "DELETE", organizationPath(organizationId));
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 204:
          return { kind: "deleted" };
        case 404:
          expectCode(operation, reply, "not_found");
          return { kind: "not_found" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async postPublication(organizationId, publicationId, publication) {
      const operation = "postPublication";
      // 0.2.4's POST …/publications, with the caller's id in the body: the
      // platform always sends its own, so a retry is safe (an identical one
      // answers 200, a different one 409).
      const request: PublicationRequest & { id: string } = { ...publication, id: publicationId };
      const reply = await send(operation, "POST", `${organizationPath(organizationId)}/publications`, request);
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 201:
        case 200: {
          const stored = parse(operation, reply, publicationSchema);
          expectSamePublication(operation, reply, stored, organizationId, publicationId);
          return { kind: reply.status === 201 ? "created" : "unchanged", publication: stored };
        }
        case 409:
          expectCode(operation, reply, "publication_conflict");
          return { kind: "conflict" };
        case 404:
          expectCode(operation, reply, "organization_not_found");
          return { kind: "organization_not_found" };
        case 400:
        case 413:
        case 422:
          return invalid(operation, reply, reply.status);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async getPublication(organizationId, publicationId) {
      const operation = "getPublication";
      const reply = await send(
        operation,
        "GET",
        `${organizationPath(organizationId)}/publications/${encodeURIComponent(publicationId)}`,
      );
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 200: {
          const stored = parse(operation, reply, publicationSchema);
          expectSamePublication(operation, reply, stored, organizationId, publicationId);
          return { kind: "found", publication: stored };
        }
        case 404:
          return expectCode(operation, reply, "not_found", "organization_not_found") === "not_found"
            ? { kind: "not_found" }
            : { kind: "organization_not_found" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async listPublications(organizationId, query) {
      const operation = "listPublications";
      const search = new URLSearchParams({ configurationId: query.configurationId });
      if (query.limit !== undefined) search.set("limit", String(query.limit));
      if (query.cursor !== undefined) search.set("cursor", query.cursor);
      const reply = await send(operation, "GET", `${organizationPath(organizationId)}/publications?${search}`);
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 200: {
          const page = parse(operation, reply, publicationListSchema);
          for (const summary of page.publications) {
            if (
              !sameId(summary.organizationId, organizationId) ||
              !sameId(summary.configuration.id, query.configurationId)
            ) {
              throw new OpampServerMisconfigurationError(
                `The opamp-server's reply to ${operation} (200) listed a publication of another organization or configuration.`,
              );
            }
          }
          return { kind: "page", page };
        }
        case 404:
          expectCode(operation, reply, "organization_not_found");
          return { kind: "organization_not_found" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async deletePublication(organizationId, publicationId) {
      const operation = "deletePublication";
      const reply = await send(
        operation,
        "DELETE",
        `${organizationPath(organizationId)}/publications/${encodeURIComponent(publicationId)}`,
      );
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 204:
          return { kind: "deleted" };
        case 404:
          return expectCode(operation, reply, "not_found", "organization_not_found") === "not_found"
            ? { kind: "not_found" }
            : { kind: "organization_not_found" };
        case 409:
          expectCode(operation, reply, "publication_in_use");
          return { kind: "in_use" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    async deleteConfigurationPublications(organizationId, configurationId) {
      const operation = "deleteConfigurationPublications";
      const reply = await send(
        operation,
        "DELETE",
        `${organizationPath(organizationId)}/configurations/${encodeURIComponent(configurationId)}/publications`,
      );
      if (isUnavailable(reply)) return reply;
      switch (reply.status) {
        case 204:
          return { kind: "deleted" };
        case 404:
          expectCode(operation, reply, "organization_not_found");
          return { kind: "organization_not_found" };
        case 409:
          expectCode(operation, reply, "publication_in_use");
          return { kind: "in_use" };
        case 400:
          return invalid(operation, reply, 400);
        default:
          throw undocumentedStatus(operation, reply);
      }
    },

    // The fleet model.

    getConfigurationUsage(organizationId, configurationId) {
      const operation = "getConfigurationUsage";
      const url = `${organizationPath(organizationId)}/configurations/${encodeURIComponent(configurationId)}/usage`;
      return call<GetConfigurationUsageResult>(operation, "GET", url, undefined, {
        200: (reply) => {
          const usage = parse(operation, reply, configurationUsageSchema);
          expectIds(operation, reply, [usage.configurationId, configurationId]);
          return { kind: "found", usage };
        },
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    getLimits(organizationId) {
      const operation = "getLimits";
      return call<GetLimitsResult>(operation, "GET", `${organizationPath(organizationId)}/limits`, undefined, {
        200: (reply) => ({ kind: "found", limits: parse(operation, reply, organizationLimitsSchema) }),
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    setLimits(organizationId, limits) {
      const operation = "setLimits";
      const body = { maxCollectors: limits.maxCollectors, requestsPerMinute: limits.requestsPerMinute };
      return call<SetLimitsResult>(operation, "PUT", `${organizationPath(organizationId)}/limits`, body, {
        200: (reply) => ({ kind: "set", limits: parse(operation, reply, organizationLimitsSchema) }),
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    createFleet(organizationId, fleet) {
      const operation = "createFleet";
      const body = {
        ...(fleet.id === undefined ? {} : { id: fleet.id }),
        label: fleet.label,
        type: fleet.type,
        rotateExpiresAt: fleet.rotateExpiresAt,
        actor: actorBody(fleet.actor),
      };
      /** The fleet answered must be the organization's, under the id sent when one was. */
      const expectFleet = (reply: Reply, answered: Fleet) =>
        expectIds(
          operation,
          reply,
          [answered.organizationId, organizationId],
          ...(fleet.id === undefined ? [] : [[answered.id, fleet.id] as const]),
        );
      return call<CreateFleetResult>(operation, "POST", `${organizationPath(organizationId)}/fleets`, body, {
        201: (reply) => {
          const created = parse(operation, reply, fleetCreatedSchema);
          expectFleet(reply, created.fleet);
          expectIds(operation, reply, [created.defaultGroup.fleetId, created.fleet.id]);
          return { kind: "created", ...created };
        },
        // A retry's answer: only a create that sent its id can be one. Without
        // an id the server made one, so a 200 is undocumented.
        200: (reply) => {
          if (fleet.id === undefined) throw undocumentedStatus(operation, reply);
          const { fleet: answered } = parse(operation, reply, fleetUnchangedSchema);
          expectFleet(reply, answered);
          return { kind: "unchanged", fleet: answered };
        },
        404: (reply) => refused(operation, reply, "organization_not_found"),
        409: (reply) => refused(operation, reply, "fleet_conflict", "fleet_label_taken"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    listFleets(organizationId, query = {}) {
      const operation = "listFleets";
      const search = searchOf({ status: query.status, limit: query.limit, cursor: query.cursor });
      return call<ListFleetsResult>(operation, "GET", `${organizationPath(organizationId)}/fleets${search}`, undefined, {
        200: (reply) => {
          const page = parse(operation, reply, fleetListSchema);
          expectIds(operation, reply, ...page.fleets.map((listed) => [listed.organizationId, organizationId] as const));
          return { kind: "page", page };
        },
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    getFleet(organizationId, fleetId) {
      const operation = "getFleet";
      return call<GetFleetResult>(operation, "GET", fleetPath(organizationId, fleetId), undefined, {
        200: (reply) => {
          const fleet = parse(operation, reply, fleetDetailSchema);
          expectIds(operation, reply, [fleet.organizationId, organizationId], [fleet.id, fleetId]);
          return { kind: "found", fleet };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    updateFleet(organizationId, fleetId, changes) {
      const operation = "updateFleet";
      const body = definedFields({ label: changes.label, status: changes.status });
      return call<UpdateFleetResult>(operation, "PATCH", fleetPath(organizationId, fleetId), body, {
        200: (reply) => {
          const fleet = parse(operation, reply, fleetSchema);
          expectIds(operation, reply, [fleet.organizationId, organizationId], [fleet.id, fleetId]);
          return { kind: "updated", fleet };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        409: (reply) => refused(operation, reply, "fleet_label_taken"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    deleteFleet(organizationId, fleetId) {
      const operation = "deleteFleet";
      return call<DeleteFleetResult>(operation, "DELETE", fleetPath(organizationId, fleetId), undefined, {
        204: () => ({ kind: "deleted" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    listCollectorGroups(organizationId, fleetId) {
      const operation = "listCollectorGroups";
      return call<ListCollectorGroupsResult>(operation, "GET", `${fleetPath(organizationId, fleetId)}/groups`, undefined, {
        200: (reply) => {
          const { groups } = parse(operation, reply, collectorGroupListSchema);
          expectIds(operation, reply, ...groups.map((group) => [group.fleetId, fleetId] as const));
          return { kind: "listed", groups };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    createCollectorGroup(organizationId, fleetId, group) {
      const operation = "createCollectorGroup";
      const body = { name: group.name, ...collectorGroupFieldsBody(group) };
      return call<CreateCollectorGroupResult>(operation, "POST", `${fleetPath(organizationId, fleetId)}/groups`, body, {
        201: (reply) => {
          const created = parse(operation, reply, collectorGroupSchema);
          expectIds(operation, reply, [created.fleetId, fleetId]);
          return { kind: "created", group: created };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        409: (reply) => refused(operation, reply, "collector_group_name_taken"),
        422: (reply) => assignmentRefused(operation, reply),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    getCollectorGroup(organizationId, fleetId, groupId) {
      const operation = "getCollectorGroup";
      const url = `${fleetPath(organizationId, fleetId)}/groups/${encodeURIComponent(groupId)}`;
      return call<GetCollectorGroupResult>(operation, "GET", url, undefined, {
        200: (reply) => {
          const group = parse(operation, reply, collectorGroupSchema);
          expectIds(operation, reply, [group.fleetId, fleetId], [group.id, groupId]);
          return { kind: "found", group };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_group_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    updateCollectorGroup(organizationId, fleetId, groupId, changes) {
      const operation = "updateCollectorGroup";
      const url = `${fleetPath(organizationId, fleetId)}/groups/${encodeURIComponent(groupId)}`;
      const body = { ...definedFields({ name: changes.name }), ...collectorGroupFieldsBody(changes) };
      return call<UpdateCollectorGroupResult>(operation, "PATCH", url, body, {
        200: (reply) => {
          const group = parse(operation, reply, collectorGroupSchema);
          expectIds(operation, reply, [group.fleetId, fleetId], [group.id, groupId]);
          return { kind: "updated", group };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_group_not_found"),
        409: (reply) => refused(operation, reply, "collector_group_name_taken", "collector_group_is_default"),
        422: (reply) => assignmentRefused(operation, reply),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    deleteCollectorGroup(organizationId, fleetId, groupId) {
      const operation = "deleteCollectorGroup";
      const url = `${fleetPath(organizationId, fleetId)}/groups/${encodeURIComponent(groupId)}`;
      return call<DeleteCollectorGroupResult>(operation, "DELETE", url, undefined, {
        204: () => ({ kind: "deleted" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_group_not_found"),
        409: (reply) => refused(operation, reply, "collector_group_is_default"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    listEnrollmentTokens(organizationId, fleetId) {
      const operation = "listEnrollmentTokens";
      return call<ListEnrollmentTokensResult>(operation, "GET", `${fleetPath(organizationId, fleetId)}/tokens`, undefined, {
        200: (reply) => {
          const { tokens } = parse(operation, reply, enrollmentTokenListSchema);
          expectIds(operation, reply, ...tokens.map((token) => [token.fleetId, fleetId] as const));
          return { kind: "listed", tokens };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    listEnrollmentTokenEvents(organizationId, fleetId, query = {}) {
      const operation = "listEnrollmentTokenEvents";
      const search = searchOf({ limit: query.limit, cursor: query.cursor });
      return call<ListEnrollmentTokenEventsResult>(operation, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events${search}`, undefined, {
        // An event names no fleet: nothing to check.
        200: (reply) => ({ kind: "page", page: parse(operation, reply, enrollmentTokenEventListSchema) }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    rotateEnrollmentToken(organizationId, fleetId, rotation) {
      const operation = "rotateEnrollmentToken";
      const body = { expiresAt: rotation.expiresAt, graceEndsAt: rotation.graceEndsAt, actor: actorBody(rotation.actor) };
      const url = `${fleetPath(organizationId, fleetId)}/tokens/rotate`;
      return call<RotateEnrollmentTokenResult>(operation, "POST", url, body, {
        // The reply names no fleet: nothing to check.
        201: (reply) => ({ kind: "rotated", token: parse(operation, reply, enrollmentTokenRotatedSchema) }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        409: (reply) => refused(operation, reply, "fleet_archived"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    issueDefaultEnrollmentToken(organizationId, fleetId, actor) {
      const operation = "issueDefaultEnrollmentToken";
      const url = `${fleetPath(organizationId, fleetId)}/tokens/default`;
      return call<IssueDefaultEnrollmentTokenResult>(operation, "POST", url, { actor: actorBody(actor) }, {
        // The reply names no fleet (as a reveal's): nothing to check but
        // that the token made is a default token.
        201: (reply) => {
          const token = parse(operation, reply, enrollmentTokenRevealedSchema);
          if (token.kind !== "default" || token.expiresAt !== null) {
            throw new OpampServerMisconfigurationError(
              `The opamp-server's reply to ${operation} (${reply.status}) wasn't a default token.`,
            );
          }
          return { kind: "issued", token };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        409: (reply) => refused(operation, reply, "fleet_archived", "enrollment_token_default_exists"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    revealEnrollmentToken(organizationId, fleetId, tokenId, actor) {
      const operation = "revealEnrollmentToken";
      const url = `${fleetPath(organizationId, fleetId)}/tokens/${encodeURIComponent(tokenId)}/reveal`;
      return call<RevealEnrollmentTokenResult>(operation, "POST", url, { actor: actorBody(actor) }, {
        // The reply names no fleet: its token only.
        200: (reply) => {
          const token = parse(operation, reply, enrollmentTokenRevealedSchema);
          expectIds(operation, reply, [token.id, tokenId]);
          return { kind: "revealed", token };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "enrollment_token_not_found"),
        409: (reply) => refused(operation, reply, "enrollment_token_revoked", "enrollment_token_expired"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    revokeEnrollmentToken(organizationId, fleetId, tokenId, actor) {
      const operation = "revokeEnrollmentToken";
      const url = `${fleetPath(organizationId, fleetId)}/tokens/${encodeURIComponent(tokenId)}/revoke`;
      return call<RevokeEnrollmentTokenResult>(operation, "POST", url, { actor: actorBody(actor) }, {
        200: (reply) => {
          const token = parse(operation, reply, enrollmentTokenSchema);
          expectIds(operation, reply, [token.fleetId, fleetId], [token.id, tokenId]);
          return { kind: "revoked", token };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "enrollment_token_not_found"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    listCollectorInstances(organizationId, fleetId, query = {}) {
      const operation = "listCollectorInstances";
      const search = searchOf({
        q: query.q,
        groupId: query.groupId,
        sort: query.sort,
        order: query.order,
        limit: query.limit,
        cursor: query.cursor,
      });
      const url = `${fleetPath(organizationId, fleetId)}/collectors${search}`;
      return call<ListCollectorInstancesResult>(operation, "GET", url, undefined, {
        200: (reply) => {
          const page = parse(operation, reply, collectorInstanceListSchema);
          expectIds(operation, reply, ...page.collectors.map((collector) => [collector.fleetId, fleetId] as const));
          return { kind: "page", page };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    pinCollectorInstances(organizationId, fleetId, request) {
      const operation = "pinCollectorInstances";
      const body = {
        collectorIds: [...request.collectorIds],
        ...(request.pin === undefined ? {} : { pin: pinBody(request.pin) }),
        ...definedFields({ pinnedVariableGroupId: request.pinnedVariableGroupId }),
      };
      const url = `${fleetPath(organizationId, fleetId)}/collectors/pin`;
      return call<PinCollectorInstancesResult>(operation, "POST", url, body, {
        200: (reply) => {
          const { updated, notFound } = parse(operation, reply, collectorInstanceBulkPinResultSchema);
          // Every id answered must be one sent: the fleet's, or one it doesn't hold.
          const sent = new Set(request.collectorIds.map((id) => id.toLowerCase()));
          if (![...updated, ...notFound].every((id) => sent.has(id.toLowerCase()))) throw idMismatch(operation, reply);
          return { kind: "pinned", updated, notFound };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found"),
        422: (reply) => assignmentRefused(operation, reply),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    getCollectorInstance(organizationId, fleetId, collectorId) {
      const operation = "getCollectorInstance";
      const url = `${fleetPath(organizationId, fleetId)}/collectors/${encodeURIComponent(collectorId)}`;
      return call<GetCollectorInstanceResult>(operation, "GET", url, undefined, {
        200: (reply) => {
          const collector = parse(operation, reply, collectorInstanceSchema);
          expectIds(operation, reply, [collector.fleetId, fleetId], [collector.id, collectorId]);
          return { kind: "found", collector };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    updateCollectorInstance(organizationId, fleetId, collectorId, changes) {
      const operation = "updateCollectorInstance";
      const url = `${fleetPath(organizationId, fleetId)}/collectors/${encodeURIComponent(collectorId)}`;
      const body = {
        ...definedFields({ name: changes.name, groupId: changes.groupId }),
        ...(changes.pin === undefined ? {} : { pin: pinBody(changes.pin) }),
        ...definedFields({ pinnedVariableGroupId: changes.pinnedVariableGroupId }),
      };
      return call<UpdateCollectorInstanceResult>(operation, "PATCH", url, body, {
        200: (reply) => {
          const collector = parse(operation, reply, collectorInstanceSchema);
          expectIds(operation, reply, [collector.fleetId, fleetId], [collector.id, collectorId]);
          return { kind: "updated", collector };
        },
        404: (reply) =>
          refused(
            operation,
            reply,
            "organization_not_found",
            "fleet_not_found",
            "collector_not_found",
            "collector_group_not_found",
          ),
        409: (reply) => refused(operation, reply, "collector_name_taken"),
        422: (reply) => assignmentRefused(operation, reply),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    deleteCollectorInstance(organizationId, fleetId, collectorId) {
      const operation = "deleteCollectorInstance";
      const url = `${fleetPath(organizationId, fleetId)}/collectors/${encodeURIComponent(collectorId)}`;
      return call<DeleteCollectorInstanceResult>(operation, "DELETE", url, undefined, {
        204: () => ({ kind: "deleted" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    listCollectorInstanceErrors(organizationId, fleetId, collectorId, query = {}) {
      const operation = "listCollectorInstanceErrors";
      const search = searchOf({ limit: query.limit, cursor: query.cursor });
      const url = `${fleetPath(organizationId, fleetId)}/collectors/${encodeURIComponent(collectorId)}/errors${search}`;
      return call<ListCollectorInstanceErrorsResult>(operation, "GET", url, undefined, {
        // An error names no fleet or collector: nothing to check.
        200: (reply) => ({ kind: "page", page: parse(operation, reply, collectorInstanceErrorListSchema) }),
        404: (reply) => refused(operation, reply, "organization_not_found", "fleet_not_found", "collector_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    // The organization variables.

    listVariables(organizationId) {
      const operation = "listVariables";
      return call<ListVariablesResult>(operation, "GET", variablesPath(organizationId), undefined, {
        // A variable names no organization: nothing to check.
        200: (reply) => ({ kind: "listed", variables: parse(operation, reply, variableListSchema).variables }),
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    createVariable(organizationId, variable) {
      const operation = "createVariable";
      const body = {
        ...(variable.id === undefined ? {} : { id: variable.id }),
        name: variable.name,
        value: variable.value,
        description: variable.description,
        actor: actorBody(variable.actor),
      };
      /** The variable answered must be the one sent, when its id was. */
      const answered = (reply: Reply) => {
        const stored = parse(operation, reply, variableSchema);
        if (variable.id !== undefined) expectIds(operation, reply, [stored.id, variable.id]);
        return stored;
      };
      return call<CreateVariableResult>(operation, "POST", variablesPath(organizationId), body, {
        201: (reply) => ({ kind: "created", variable: answered(reply) }),
        // A retry's answer: only a create that sent its id can be one.
        200: (reply) => {
          if (variable.id === undefined) throw undocumentedStatus(operation, reply);
          return { kind: "unchanged", variable: answered(reply) };
        },
        404: (reply) => refused(operation, reply, "organization_not_found"),
        409: (reply) => refused(operation, reply, "variable_conflict", "variable_name_taken", "variable_limit_reached"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    updateVariable(organizationId, variableId, changes) {
      const operation = "updateVariable";
      const body = {
        ...definedFields({ name: changes.name, value: changes.value, description: changes.description }),
        actor: actorBody(changes.actor),
      };
      return call<UpdateVariableResult>(operation, "PATCH", variablePath(organizationId, variableId), body, {
        200: (reply) => {
          const variable = parse(operation, reply, variableSchema);
          expectIds(operation, reply, [variable.id, variableId]);
          return { kind: "updated", variable };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_not_found"),
        409: (reply) => refused(operation, reply, "variable_name_taken", "variable_in_use"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    deleteVariable(organizationId, variableId) {
      const operation = "deleteVariable";
      return call<DeleteVariableResult>(operation, "DELETE", variablePath(organizationId, variableId), undefined, {
        204: () => ({ kind: "deleted" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_not_found"),
        409: (reply) => refused(operation, reply, "variable_in_use"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    listVariableGroups(organizationId) {
      const operation = "listVariableGroups";
      return call<ListVariableGroupsResult>(operation, "GET", variableGroupsPath(organizationId), undefined, {
        // A variable group names no organization: nothing to check.
        200: (reply) => ({ kind: "listed", variableGroups: parse(operation, reply, variableGroupListSchema).variableGroups }),
        404: (reply) => refused(operation, reply, "organization_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    createVariableGroup(organizationId, variableGroup) {
      const operation = "createVariableGroup";
      const body = {
        ...(variableGroup.id === undefined ? {} : { id: variableGroup.id }),
        name: variableGroup.name,
        description: variableGroup.description,
        actor: actorBody(variableGroup.actor),
      };
      const answered = (reply: Reply) => {
        const stored = parse(operation, reply, variableGroupSchema);
        if (variableGroup.id !== undefined) expectIds(operation, reply, [stored.id, variableGroup.id]);
        return stored;
      };
      return call<CreateVariableGroupResult>(operation, "POST", variableGroupsPath(organizationId), body, {
        201: (reply) => ({ kind: "created", variableGroup: answered(reply) }),
        200: (reply) => {
          if (variableGroup.id === undefined) throw undocumentedStatus(operation, reply);
          return { kind: "unchanged", variableGroup: answered(reply) };
        },
        404: (reply) => refused(operation, reply, "organization_not_found"),
        409: (reply) =>
          refused(operation, reply, "variable_group_conflict", "variable_group_name_taken", "variable_group_limit_reached"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    getVariableGroup(organizationId, variableGroupId) {
      const operation = "getVariableGroup";
      return call<GetVariableGroupResult>(operation, "GET", variableGroupPath(organizationId, variableGroupId), undefined, {
        200: (reply) => {
          const detail = parse(operation, reply, variableGroupDetailSchema);
          expectIds(operation, reply, [detail.variableGroup.id, variableGroupId]);
          return { kind: "found", ...detail };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_group_not_found"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    updateVariableGroup(organizationId, variableGroupId, changes) {
      const operation = "updateVariableGroup";
      const body = { ...definedFields({ name: changes.name, description: changes.description }), actor: actorBody(changes.actor) };
      return call<UpdateVariableGroupResult>(operation, "PATCH", variableGroupPath(organizationId, variableGroupId), body, {
        200: (reply) => {
          const variableGroup = parse(operation, reply, variableGroupSchema);
          expectIds(operation, reply, [variableGroup.id, variableGroupId]);
          return { kind: "updated", variableGroup };
        },
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_group_not_found"),
        409: (reply) => refused(operation, reply, "variable_group_name_taken"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    deleteVariableGroup(organizationId, variableGroupId) {
      const operation = "deleteVariableGroup";
      return call<DeleteVariableGroupResult>(operation, "DELETE", variableGroupPath(organizationId, variableGroupId), undefined, {
        204: () => ({ kind: "deleted" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_group_not_found"),
        409: (reply) => refused(operation, reply, "variable_group_in_use"),
        400: (reply) => invalid(operation, reply, 400),
      });
    },

    setVariableGroupOverride(organizationId, variableGroupId, variableId, override) {
      const operation = "setVariableGroupOverride";
      const body = { value: override.value, actor: actorBody(override.actor) };
      const answered = (reply: Reply): SetVariableGroupOverrideResult => {
        const stored = parse(operation, reply, variableGroupOverrideSchema);
        expectIds(operation, reply, [stored.variableId, variableId]);
        return { kind: "set", override: stored };
      };
      return call<SetVariableGroupOverrideResult>(operation, "PUT", overridePath(organizationId, variableGroupId, variableId), body, {
        // New, replaced or the same value again: one result.
        201: answered,
        200: answered,
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_group_not_found", "variable_not_found"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },

    resetVariableGroupOverride(organizationId, variableGroupId, variableId, actor) {
      const operation = "resetVariableGroupOverride";
      // Who resets it goes in the body, never the URL (an email is configuration text).
      const body = { actor: actorBody(actor) };
      return call<ResetVariableGroupOverrideResult>(operation, "DELETE", overridePath(organizationId, variableGroupId, variableId), body, {
        204: () => ({ kind: "reset" }),
        404: (reply) => refused(operation, reply, "organization_not_found", "variable_group_not_found", "variable_not_found"),
        400: (reply) => invalid(operation, reply, 400),
        413: (reply) => invalid(operation, reply, 413),
      });
    },
  };
}

function isUnavailable(reply: Reply | Unavailable): reply is Unavailable {
  return "kind" in reply;
}

/** A failed fetch, or a reply that broke off: the timeout's, or the network's. */
function unavailableAfterFailure(controller: AbortController): Unavailable {
  return controller.signal.aborted ? { kind: "unavailable", reason: "timeout" } : { kind: "unavailable", reason: "network" };
}

/**
 * The reply's body, checked against its schema. A mismatch throws, naming
 * the fields at fault and nothing of their values (zod's messages can quote
 * what it received).
 */
function parse<Schema extends z.ZodTypeAny>(operation: Operation, reply: Reply, schema: Schema): z.infer<Schema> {
  const result = schema.safeParse(reply.body);
  if (result.success) return result.data as z.infer<Schema>;
  const fields = [...new Set(result.error.issues.map((issue) => fieldPath(issue.path)))];
  throw new OpampServerMisconfigurationError(
    `The opamp-server's reply to ${operation} (${reply.status}) didn't match its schema at: ${fields.join(", ")}.`,
  );
}

/**
 * An issue's path, as field names and indices. A reported attribute's key is
 * the collector's own text, so a path into `attributes` stops there, the key
 * replaced by `*`.
 */
function fieldPath(path: (string | number)[]): string {
  const attributes = path.indexOf("attributes");
  const kept = attributes === -1 || attributes === path.length - 1 ? path : [...path.slice(0, attributes + 1), "*"];
  return kept.join(".") || "(the body)";
}

/**
 * A refusal the operation documents for this status, as the result of its
 * code: another code is thrown, as any undocumented answer. A guard's
 * refusal carries its details, parsed by its code's schema: one that
 * doesn't match is thrown too, naming the fields at fault only (a name in
 * them is configuration text).
 */
function refused<Code extends ErrorCode>(operation: Operation, reply: Reply, ...codes: Code[]): Refused<Code> {
  const code = expectCode(operation, reply, ...codes);
  if (!(code in DETAILS)) return { kind: code } as Refused<Code>;
  const envelope = z.object({ error: z.object({ details: DETAILS[code as DetailedCode] }) });
  return { kind: code, details: parse(operation, reply, envelope).error.details } as Refused<Code>;
}

/** An assignment's or a pin's 422 (GroupAssignmentRefused, PinRefused). */
function assignmentRefused(operation: Operation, reply: Reply) {
  return refused(operation, reply, "publication_not_found", "variable_group_not_found", "variables_undefined");
}

function idMismatch(operation: Operation, reply: Reply): OpampServerMisconfigurationError {
  return new OpampServerMisconfigurationError(
    `The opamp-server's reply to ${operation} (${reply.status}) named other ids than the ones asked for.`,
  );
}

/**
 * Each pair, an id the reply echoes and the one asked for, must be the same: a
 * server answering another organization's or another fleet's would be a
 * cross-tenant read, and is refused here too. The error names the operation
 * and the status only, never an id.
 */
function expectIds(operation: Operation, reply: Reply, ...pairs: (readonly [string, string])[]): void {
  if (!pairs.every(([answered, asked]) => sameId(answered, asked))) throw idMismatch(operation, reply);
}

/** A query string of the parameters given, or "" for none. */
function searchOf(parameters: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** The fields given, each undefined one left out (a PATCH sets only what it names). */
function definedFields<Fields extends Record<string, unknown>>(fields: Fields): Partial<Fields> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<Fields>;
}

/** An actor as the API takes it: exactly its two fields, or null. */
function actorBody(actor: OpampActor): OpampActor {
  return actor === null ? null : { id: actor.id, email: actor.email };
}

/** A pin as the API takes it: exactly its two fields, or null. */
function pinBody(pin: CollectorInstancePin): CollectorInstancePin {
  return pin === null ? null : { kind: pin.kind, id: pin.id };
}

/** A group's assignment, annotations and variable group, each given one (null included) and no other. */
function collectorGroupFieldsBody(group: CollectorGroupFields): CollectorGroupFields {
  return definedFields({
    assignedPublicationId: group.assignedPublicationId,
    annotations: group.annotations,
    variableGroupId: group.variableGroupId,
  });
}

/**
 * A refusal of the request (400, 413, or a publication's 422), whose code
 * must be the one the operation documents for that status
 * (`invalid_request`, `payload_too_large`, `sha256_mismatch`): another is
 * thrown like any undocumented answer.
 */
function invalid(operation: Operation, reply: Reply, status: keyof typeof INVALID_CODES): Invalid {
  const code = expectCode(operation, reply, INVALID_CODES[status]);
  // The envelope must still be the API's, though its message is dropped.
  parse(operation, reply, errorEnvelopeSchema);
  return { kind: "invalid", code };
}

/**
 * The error envelope's code, which must be one `operation` documents for
 * this status: a 404 or 409 carrying another is a server of another version,
 * or another server, and is thrown like any undocumented answer.
 */
function expectCode<Code extends ErrorCode>(operation: Operation, reply: Reply, ...codes: Code[]): Code {
  const { code } = parse(operation, reply, errorEnvelopeSchema).error;
  if (!(codes as ErrorCode[]).includes(code)) {
    throw new OpampServerMisconfigurationError(
      `The opamp-server answered ${operation} with ${reply.status} ${code}, which the API doesn't document.`,
    );
  }
  return code as Code;
}

/** An Organization reply, which must be the organization asked for. */
function parseOrganization(operation: Operation, reply: Reply, organizationId: string): Organization {
  const organization = parse(operation, reply, organizationSchema);
  if (!sameId(organization.organizationId, organizationId)) {
    throw new OpampServerMisconfigurationError(
      `The opamp-server's reply to ${operation} (${reply.status}) was another organization's.`,
    );
  }
  return organization;
}

function undocumentedStatus(operation: Operation, reply: Reply): OpampServerMisconfigurationError {
  return new OpampServerMisconfigurationError(
    `The opamp-server answered ${operation} with ${reply.status}, which the API doesn't document.`,
  );
}

/** UUIDs compare without regard to case; the server answers them in lower case. */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The publication the server answered must be the one asked for, in the
 * organization asked for: a server that answered another organization's
 * would be a cross-tenant read, and is refused here too.
 */
function expectSamePublication(
  operation: Operation,
  reply: Reply,
  publication: Publication,
  organizationId: string,
  publicationId: string,
): void {
  if (!sameId(publication.organizationId, organizationId) || !sameId(publication.id, publicationId)) {
    throw new OpampServerMisconfigurationError(
      `The opamp-server's reply to ${operation} (${reply.status}) was another organization's or another publication.`,
    );
  }
}
