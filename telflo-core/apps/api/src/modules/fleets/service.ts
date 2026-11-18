import { randomUUID } from "node:crypto";
import type {
  Collector,
  CollectorErrorsPage,
  CollectorGroup,
  CollectorPinRequest,
  CollectorsPage,
  ConfigurationFleetUsage,
  CreateCollectorGroupRequest,
  CreateFleetRequest,
  CreateQuickDeployLinkRequest,
  CreateQuickDeployLinkResponse,
  EnrollmentToken,
  EnrollmentTokenEventsPage,
  EnrollmentTokenListed,
  Fleet,
  FleetActor,
  FleetCreatedResponse,
  FleetDetail,
  FleetsPage,
  FleetStatus,
  FleetType,
  HelmInstallFacts,
  InstallBundleRequest,
  InstallFacts,
  KubernetesRole,
  PinCollectorsRequest,
  PinCollectorsResponse,
  PublicInstallPlatform,
  PublicInstallReply,
  PublicInstallRequest,
  PublishedVersion,
  QuickDeployLink as QuickDeployLinkReply,
  QuickDeployLinkExtension,
  QuickDeployLinksPage,
  RotateEnrollmentTokenRequest,
  UpdateCollectorGroupRequest,
  UpdateCollectorRequest,
  UpdateFleetRequest,
} from "@telflo/contracts";
import {
  COLLECTOR_GROUP_CLUSTER_NAME,
  collectorGroupRole,
  containerCommand,
  dockerMountsOf,
  gatewayNameProblem,
  HELM_CHART_ENV_NAMES,
  HelmBuildError,
  helmFullnameOverride,
  helmQuickDeployCommand,
  helmReleaseName,
  helmValuesInputOf,
  helmValuesYaml,
  INSTALL_DISTRIBUTION,
  installBundleFileName,
  KUBERNETES_DEFAULT_NAMESPACE,
  kubernetesOf,
  quickDeployCommands,
  quickDeployLinkExpiryAfter,
  quickDeployLinkFirstExpiry,
  TELFLO_ANNOTATIONS_KEY,
} from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { ActorContext } from "../../database/context.js";
import type { FleetLimiter, FleetRequestKind } from "../../http/rate-limits.js";
import {
  OpampServerMisconfigurationError,
  type Invalid,
  type OpampActor,
  type OpampServerClient,
  type PinCollectorInstancesRequest,
} from "../../opamp-server/client.js";
import type * as Opamp from "../../opamp-server/schemas.js";
import { configurationNotFound, configurationVersionNotFound } from "../configurations/errors.js";
import { requiredEnvVarNames } from "../../install/env-var-names.js";
import { bundleValues, InstallRenderError, renderTemplate } from "../../install/render.js";
import { tarGz } from "../../install/tar.js";
import { InstallTemplatesError, type InstallTemplateLoader, type TemplateFile } from "../../install/templates.js";
import type { InstallSettings, QuickDeploySettings } from "../../settings.js";
import type { ICollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import type { IConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import type { InstallableVersion, IPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import { organizationNotFound } from "../organizations/errors.js";
import { describeResult, ensureOrganization, type OpampRegistration } from "../organizations/opamp-registration.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { QUICK_DEPLOY_LINK_EXTENDED, QUICK_DEPLOY_LINK_REVOKED, QUICK_DEPLOY_LINK_SUBJECT } from "../quick-deploy/actions.js";
import { createQuickDeployLink, type QuickDeployLinkToCreate } from "../quick-deploy/create-link.js";
import {
  downloadFleetGone,
  downloadRefusalOf,
  downloadTokenRevoked,
  downloadUnavailable,
  downloadVariablesChanged,
} from "../quick-deploy/errors.js";
import type {
  IQuickDeployLinkRepository,
  QuickDeployLink as StoredQuickDeployLink,
  QuickDeployLinksAfter,
} from "../quick-deploy/repositories/quick-deploy-link-repository.js";
import { SealedValuesError, type EnvValue } from "../quick-deploy/sealed-values.js";
import { generateQuickDeploySecret, quickDeployLinkUrl } from "../quick-deploy/secret.js";
import { variableGroupNotFound, variablesUndefined } from "../variables/errors.js";
import {
  collectorBinariesMissing,
  collectorDistributionNotInstallable,
  collectorGroupAssignmentDeleted,
  collectorGroupIsDefault,
  collectorGroupNameFixed,
  collectorGroupNameTaken,
  collectorGroupNotFound,
  collectorGroupRequired,
  collectorGroupSettingsUnreadable,
  collectorGroupUnassigned,
  collectorNameTaken,
  collectorNotFound,
  collectorVersionNotOffered,
  configurationVersionNotPublished,
  dockerMountsOnKubernetesFleet,
  enrollmentTokenDefaultExists,
  enrollmentTokenDefaultMissing,
  enrollmentTokenExpired,
  enrollmentTokenNotFound,
  enrollmentTokenRevoked,
  envVarsNotOffered,
  fleetArchived,
  fleetConflict,
  fleetLabelTaken,
  fleetNotFound,
  fleetsRateLimited,
  fleetsUnavailable,
  fleetTypeNotHelmInstallable,
  fleetTypeNotInstallable,
  graceAfterExpiry,
  installPlatformNotSuited,
  helmChartEnvNamesRefused,
  installUnavailable,
  invalidCursor,
  invalidTime,
  kubernetesGroupNameRefused,
  kubernetesOnServerFleet,
  kubernetesRoleRefused,
  kubernetesSettingsRequired,
  publicInstallLinksDisabled,
  quickDeployLinkLimitReached,
  quickDeployLinkNotFound,
  quickDeployLinkRevoked,
} from "./errors.js";

/*
 * Fleets and their enrollment tokens through the platform (D16b decisions
 * 1, 4 to 6, 13, 15 to 18 and 21; Preflight rulings 8 to 16 and 19). The
 * opamp-server holds them (D16a); this service is its tenant router for the
 * signed-in person's active organization.
 *
 * Every operation, in order: the path's organization the session's active
 * one (else 404 `organization_not_found`, before anything else); each path
 * id a canonical UUID (else its 404, with no call); the platform's own
 * checks (a time in the future); the person's fleet limit (Preflight ruling
 * 12, one count and one in-flight slot per request, released in a
 * `finally`); the call; the audit row (ruling 15). Every member may do all
 * of it (decision 6): there is no role check. No lock is held across a
 * call: `authenticate` read the session, the live membership and the live
 * organization, committed, on this request.
 *
 * The actor the opamp-server records is the session's person, never the
 * body's. The organization is the session's, never the body's.
 *
 * Answers (Preflight ruling 8): the person's own refusals passed on (409
 * `fleet_conflict`, `fleet_label_taken`, `fleet_archived`,
 * `enrollment_token_revoked`, `enrollment_token_expired`,
 * `enrollment_token_default_exists`; 404
 * `fleet_not_found`, `enrollment_token_not_found`); 400 `invalid_request`
 * for a list's cursor or a time the opamp-server refused (when the request
 * sent one, the cursor or the time); an organization
 * the opamp-server doesn't know holds no fleets (an empty list, a
 * `fleet_not_found`); every other outcome one 503 `fleets_unavailable`,
 * logged with ids and the result's kind (describeResult), never a body, a
 * URL, a label or a bearer. A write's 503 can follow a change the
 * opamp-server made (a reply lost after its commit): its message says so.
 *
 * Bearers go only into the create's, the reveal's, the rotation's and a new
 * default token's (D17c-1) replies, and the public install's command (D25
 * decision 38: `installCommand`, which also carries a link's secret); labels
 * only into replies. Neither reaches a log line or an audit row (ADR 0024).
 *
 * Collector groups, collectors and a configuration's fleet usage
 * (Task 4; decisions 3, 13, 14 and 21, Preflight rulings 5, 8, 9 and 12)
 * follow the same order, with the platform's reads between the path's ids
 * and the limit: an assignment's or a pin's configuration version resolved
 * to its published copy's id, or the usage's configuration found visible,
 * in one short committed transaction (404 `configuration_version_not_found`
 * or `configuration_not_found`, 422 `configuration_version_not_published`,
 * with no call). A group's create, and its update carrying a name or
 * annotations, reads the fleet's type first, within the request's count and
 * slot, and checks the group against it (D17d-1 decisions 17 and 18,
 * Preflight ruling 13: refusalForFleetType), nothing written on a refusal.
 * After the call, every publication id the
 * reply names is looked up in one query, the platform's configuration and
 * version put beside it (null for none). Their own refusals: 409
 * `collector_group_name_taken`, `collector_group_is_default`,
 * `collector_name_taken`; 404 `collector_group_not_found`,
 * `collector_not_found`. A 422
 * `publication_not_found` for a version the platform resolved is the two
 * sides disagreeing: the one 503, logged at error.
 *
 * D20's bindings (decisions 4, 5 and 7; Preflight ruling 39; Q103): a
 * group's create and update pass `variableGroupId`, a collector's update
 * and the bulk pin `pinnedVariableGroupId` (the bulk pin's `pin` and
 * `pinnedVariableGroupId` each optional, at least one, a field left out
 * leaving each collector's as it is). The opamp-server's 422s map to the
 * person's: a variable group the organization doesn't hold is 404
 * `variable_group_not_found` (as a missing version is 404
 * `configuration_version_not_found`), and a published version referencing
 * names no variable has is 422 `variables_undefined` with the names (at
 * most 100, their total exact: Q102) in its details, never in a log line.
 * A binding's change is unaudited, as assignments and pins are (decision 15). None of these writes is
 * audited (decision 18). A group's or a collector's name, a reported
 * attribute, an error text and a collector list's `q` reach replies only,
 * never a log line. A pin names a configuration version only (D16c removed
 * importing): the contract refuses any other kind (400, no call).
 *
 * Installing (D17c-1 decisions 38 and 39, Preflight ruling 14): an
 * install's facts (one read admission) and a Linux bundle (one write) read
 * the fleet and the group from the opamp-server, then the group's
 * published version's YAML and collector and the catalogue in one short
 * committed transaction (`installable`'s order of refusals). The bundle is
 * rendered from the request's validated fields, the settings and the
 * catalogue only (install/render.ts), its templates read again from the
 * directory (install/templates.ts), and audited
 * `fleet.install_bundle_downloaded` with ids, the method and the arch.
 * Neither carries a bearer; a configuration's YAML, a template's text, a
 * render's output and the request's paths and values reach no log line or
 * audit row.
 *
 * Quick-deploy links (D17c-2 decisions 4 to 7, 10, 11, 22 and 25;
 * Preflight rulings 3, 9, 13, 20 and 25): every member makes (a write), lists
 * (a read), extends and revokes (writes) any link of the organization's
 * fleets. A create checks what the bundle would (`installable`, the
 * variables offered, the binaries for the arch), then that the fleet holds
 * a valid default token (the command carries its bearer; else 409
 * `enrollment_token_default_missing`), and makes the link, its values
 * sealed, within the fleet's cap, audited in the same transaction
 * (create-link.ts); its reply alone carries the link's `url` (the secret),
 * `no-store`. A link of another fleet or organization is 404
 * `quick_deploy_link_not_found`. A fleet's delete removes its links after
 * the opamp-server's success, and after its 404 too (the retry of a delete
 * that outlasted the platform's wait; Ruling 49).
 *
 * The public download renders through `quickDeployBundle` (a service the
 * public route builds with `withOrganizationTransaction`: the link's
 * organization, no person): `installable` and `renderBundle` as the signed-in
 * bundle, with no actor and no audit (the route counts and audits).
 *
 * The Helm install (D17d-2 decisions 15, 20 and 21; Preflight rulings 1 to
 * 4, 9, 11 and 13): `installable` takes the install's path, so a
 * Kubernetes-supervisor fleet's group answers its Helm facts
 * (`helmFactsOf`: the chart, the image's repository, the group's release,
 * role, namespace, replicas and volumes; no bearer) and makes a Helm values
 * link, while the Linux bundle and a Linux link keep refusing it
 * (`fleet_type_not_installable`, each direction's words). Either link's
 * create needs the organization's "Public install links" switch on (409
 * `public_install_links_disabled`), read `for share` in its transaction.
 * A Helm values link's public download (`quickDeployHelmValues`) renders
 * the group's current Helm facts and a bearer of the link's default token
 * revealed LAST, with no actor (the opamp-server's `viewed` event names no
 * person): `values.yaml`, which holds it, reaches no log line (a builder's
 * refusal is logged with ids and the field only).
 */

/**
 * The repositories a unit of work of the fleet routes uses, bound to one
 * transaction that carries the request's database context: the active
 * organization (a create's name to register, and its re-check, Preflight
 * ruling 13) and the audit trail.
 */
export interface FleetsTransaction {
  organization: Pick<IActiveOrganizationRepository, "findActive" | "findActiveForShare" | "findSettingsForShare">;
  audit: IAuditRepository;
  /** The person's configurations (D11b's draft rules): a fleet usage's configuration. */
  configurations: Pick<IConfigurationRepository, "find">;
  /** A configuration version and its published copy, both ways (decision 14, Preflight ruling 5). */
  publishedVersions: IPublishedVersionRepository;
  /** The collector catalogue (global): an install's version state and binaries (D17c-1 Preflight ruling 14). */
  catalogue: Pick<ICollectorCatalogueRepository, "findVersionState" | "findVersionBinaries" | "listOfferedBinaries">;
  /** The organization's quick-deploy links (D17c-2 decision 22). */
  quickDeployLinks: IQuickDeployLinkRepository;
}

/**
 * The repositories the public download uses, bound to one transaction in a
 * link's organization with no person (D17c-2 Preflight ruling 9: the
 * published version read with no viewer, in database/context.ts' context
 * of an organization with no person).
 */
export interface QuickDeployDownloadTransaction {
  /** The link's organization's "Public install links" switch (D17d-2 Preflight ruling 10): read, then re-read `for share` at the count. */
  organization: Pick<IActiveOrganizationRepository, "findSettings" | "findSettingsForShare">;
  quickDeployLinks: IQuickDeployLinkRepository;
  publishedVersions: IPublishedVersionRepository;
  catalogue: FleetsTransaction["catalogue"];
  audit: IAuditRepository;
}

/** Runs `work` in one transaction in `organizationId`'s context with no person, and resolves once it commits. */
export type WithOrganizationTransaction = <Result>(
  organizationId: string,
  work: (transaction: QuickDeployDownloadTransaction) => Promise<Result>,
) => Promise<Result>;

/** An install's reads (the published version, the catalogue) in one short committed transaction: a member's, or the public download's. */
type InstallRead = <Result>(work: (transaction: Pick<FleetsTransaction, "publishedVersions" | "catalogue">) => Promise<Result>) => Promise<Result>;

/** What a bundle is rendered from: the request's validated fields, or a link's stored choices and opened values. */
interface BundleChoices {
  method: InstallBundleRequest["method"];
  arch: InstallBundleRequest["arch"];
  rootPath: string;
  executablePath?: string | undefined;
  env: readonly EnvValue[];
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithFleetsTransaction = <Result>(
  context: ActorContext,
  work: (transaction: FleetsTransaction) => Promise<Result>,
) => Promise<Result>;

export interface FleetsServiceDependencies {
  withTransaction: WithFleetsTransaction;
  opampServer: OpampServerClient;
  limiter: FleetLimiter;
  /**
   * The organization's delete hook (D11a decision 20): a fleet's create
   * that finds its organization deleted meanwhile asks the opamp-server to
   * delete it again (Preflight ruling 13; Task 6 makes the hook retry).
   */
  opampRegistration: Pick<OpampRegistration, "deleted">;
  /** The platform's clock: a time in a request must be after it; a bundle's files are dated by it. */
  now: () => Date;
  /** What an install writes (D17c-1 decision 34). */
  install: InstallSettings;
  /** The install templates, read on every render (D17c-1 decision 36). */
  installTemplates: InstallTemplateLoader;
  /** Where a link points and the keys sealing its values (D17c-2 decision 24). */
  quickDeploy: QuickDeploySettings;
  /**
   * The public download's transactions, in a link's organization with no
   * person (D17c-2 Preflight ruling 9): only the public route's service has
   * them (modules/quick-deploy/routes.ts); `quickDeployBundle` needs them.
   */
  withOrganizationTransaction?: WithOrganizationTransaction;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

/** A fleet's create: 201 with both bearers, or a retry's 200 with the fleet alone. */
export type CreateFleetOutcome = { kind: "created"; reply: FleetCreatedResponse } | { kind: "unchanged"; fleet: Fleet };

export interface IFleetsService {
  list(actor: Actor, organizationId: string, query: { status?: FleetStatus; limit: number; cursor?: string }): Promise<FleetsPage>;
  create(actor: Actor, organizationId: string, request: CreateFleetRequest): Promise<CreateFleetOutcome>;
  get(actor: Actor, organizationId: string, fleetId: string): Promise<FleetDetail>;
  update(actor: Actor, organizationId: string, fleetId: string, changes: UpdateFleetRequest): Promise<Fleet>;
  remove(actor: Actor, organizationId: string, fleetId: string): Promise<void>;
  listTokens(actor: Actor, organizationId: string, fleetId: string): Promise<EnrollmentTokenListed[]>;
  listTokenEvents(actor: Actor, organizationId: string, fleetId: string, query: PageQuery): Promise<EnrollmentTokenEventsPage>;
  rotateToken(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    rotation: RotateEnrollmentTokenRequest,
  ): Promise<{ id: string; bearer: string; expiresAt: string | null; predecessorId: string | null }>;
  /** A new default token once the fleet's default tokens are all revoked (D17c-1 decision 29). */
  issueDefaultToken(
    actor: Actor,
    organizationId: string,
    fleetId: string,
  ): Promise<{ id: string; kind: "default" | "rotate"; bearer: string; expiresAt: string | null }>;
  revealToken(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    tokenId: string,
  ): Promise<{ id: string; kind: "default" | "rotate"; bearer: string; expiresAt: string | null }>;
  revokeToken(actor: Actor, organizationId: string, fleetId: string, tokenId: string): Promise<EnrollmentToken>;
  listGroups(actor: Actor, organizationId: string, fleetId: string): Promise<CollectorGroup[]>;
  createGroup(actor: Actor, organizationId: string, fleetId: string, request: CreateCollectorGroupRequest): Promise<CollectorGroup>;
  getGroup(actor: Actor, organizationId: string, fleetId: string, groupId: string): Promise<CollectorGroup>;
  updateGroup(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    groupId: string,
    changes: UpdateCollectorGroupRequest,
  ): Promise<CollectorGroup>;
  removeGroup(actor: Actor, organizationId: string, fleetId: string, groupId: string): Promise<void>;
  listCollectors(actor: Actor, organizationId: string, fleetId: string, query: CollectorsQuery): Promise<CollectorsPage>;
  pinCollectors(actor: Actor, organizationId: string, fleetId: string, request: PinCollectorsRequest): Promise<PinCollectorsResponse>;
  getCollector(actor: Actor, organizationId: string, fleetId: string, collectorId: string): Promise<Collector>;
  updateCollector(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    collectorId: string,
    changes: UpdateCollectorRequest,
  ): Promise<Collector>;
  removeCollector(actor: Actor, organizationId: string, fleetId: string, collectorId: string): Promise<void>;
  listCollectorErrors(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    collectorId: string,
    query: PageQuery,
  ): Promise<CollectorErrorsPage>;
  fleetUsage(actor: Actor, organizationId: string, configurationId: string): Promise<ConfigurationFleetUsage>;
  /** An install's facts (D17c-1 decision 38): no bearer. A Kubernetes group's are its Helm facts (D17d-2 decision 15). */
  installFacts(actor: Actor, organizationId: string, fleetId: string, groupId: string): Promise<InstallFacts | HelmInstallFacts>;
  /** A Linux bundle (D17c-1 decision 39), rendered from the request's validated fields only: no bearer. */
  installBundle(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    groupId: string,
    request: InstallBundleRequest,
  ): Promise<{ fileName: string; archive: Buffer }>;
  /**
   * The public install's ready command (D25 decisions 37 and 38; Preflight
   * ruling 10, Rulings 160 and 161), for the group named or the fleet's
   * default one, built by the shared builders only: docker's container
   * command (the facts, a reveal of the default token), linux's All In One
   * Quick Deploy command (a new link, a reveal) or kubernetes' Helm Quick
   * Deploy command (a new values link). Every platform spends one bearer
   * admission and writes `enrollment_token.revealed` with `via` and
   * `platform`. The reply is a secret: never logged, audited or in an error.
   */
  installCommand(actor: Actor, organizationId: string, fleetId: string, request: PublicInstallRequest): Promise<PublicInstallReply>;
  /**
   * A quick-deploy link for the group (D17c-2 decision 25), by kind: a Linux
   * link on a server fleet's group, a Helm values link on a Kubernetes
   * fleet's (D17d-2 decision 21). The link and its `url`, the one copy of
   * its secret.
   */
  createQuickDeployLink(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    groupId: string,
    request: CreateQuickDeployLinkRequest,
  ): Promise<CreateQuickDeployLinkResponse>;
  /** A page of the fleet's links, newest first, each with its group's name. */
  listQuickDeployLinks(actor: Actor, organizationId: string, fleetId: string, query: PageQuery): Promise<QuickDeployLinksPage>;
  /**
   * A new expiry counted from now (null for `never`); a revoked link is 409.
   * Every extend is decided under the cap's lock, as a create is: refused
   * (409 `quick_deploy_link_limit_reached`) when the fleet's OTHER active
   * links are already at the cap, which is normally an expired link's
   * extend (an active link of a full fleet has one fewer others; Rulings 36
   * and 40).
   */
  extendQuickDeployLink(
    actor: Actor,
    organizationId: string,
    fleetId: string,
    linkId: string,
    by: QuickDeployLinkExtension,
  ): Promise<QuickDeployLinkReply>;
  /**
   * Revoked once; a repeat answers the link as it is (and is audited again).
   * The revoke is written before the group's name is asked for, and stands
   * when the opamp-server can't answer (the reply's name null, Ruling 36).
   */
  revokeQuickDeployLink(actor: Actor, organizationId: string, fleetId: string, linkId: string): Promise<QuickDeployLinkReply>;
  /**
   * The public download's render (D17c-2 decisions 6, 7 and 26; Preflight
   * rulings 9 and 10), for a link the route found active, with no person:
   * `installable` in the link's organization, the stored variables still
   * offered, the link's default token still valid, the values opened
   * (`openValues`), then `renderBundle`. Refused in the download's terms
   * (quick-deploy/errors.ts). No count and no audit: the route's.
   */
  quickDeployBundle(link: StoredQuickDeployLink, openValues: (link: StoredQuickDeployLink) => EnvValue[]): Promise<Buffer>;
  /**
   * A Helm values link's public render (D17d-2 decision 21; Preflight
   * ruling 9), with no person, in this order: `installable` for a Helm
   * install in the link's organization, the group's Helm facts (its
   * settings readable), the stored variables still offered, the values
   * opened, then the link's default token's bearer revealed with no actor
   * (revoked, expired or unknown 410), and `helmValuesYaml`. The file holds
   * the bearer: never logged. Refused in the download's terms. No count and
   * no audit: the route's.
   */
  quickDeployHelmValues(link: StoredQuickDeployLink, openValues: (link: StoredQuickDeployLink) => EnvValue[]): Promise<string>;
}

/** A page's size and the cursor of an earlier page. */
export interface PageQuery {
  limit: number;
  cursor?: string;
}

/** The collector list's query, as the contract parsed it. */
export interface CollectorsQuery extends PageQuery {
  q?: string;
  groupId?: string;
  sort?: "created" | "lastSeen" | "name";
  order?: "asc" | "desc";
}

/** The ids a log line or an audit row may name, and nothing else. */
interface FleetIds {
  organizationId: string;
  fleetId?: string;
  tokenId?: string;
  groupId?: string;
  collectorId?: string;
  configurationId?: string;
  versionId?: string;
  publicationId?: string;
  linkId?: string;
  /** D20: a group's or a pin's variable group. */
  variableGroupId?: string;
}

// ---------------------------------------------------------------------------
// The opamp-server's shapes, as the platform answers them.

function toActor(actor: { id: string; email: string } | null): FleetActor | null {
  return actor === null ? null : { userId: actor.id, email: actor.email };
}

export function toFleet(fleet: Opamp.Fleet): Fleet {
  return {
    id: fleet.id,
    label: fleet.label,
    type: fleet.type,
    status: fleet.status,
    createdBy: toActor(fleet.createdBy),
    createdAt: fleet.createdAt,
    updatedAt: fleet.updatedAt,
  };
}

export function toFleetDetail(fleet: Opamp.FleetDetail): FleetDetail {
  const { summary } = fleet;
  return {
    ...toFleet(fleet),
    summary: {
      collectors: summary.collectors,
      online: summary.online,
      warning: summary.warning,
      unknown: summary.unknown,
      offline: summary.offline,
      inSync: summary.inSync,
      pending: summary.pending,
      failed: summary.failed,
      drifted: summary.drifted,
      unassigned: summary.unassigned,
      lastSeenAt: summary.lastSeenAt,
      rotateToken:
        summary.rotateToken === null
          ? null
          : {
              expiresAt: summary.rotateToken.expiresAt,
              graceEndsAt: summary.rotateToken.graceEndsAt,
              validCount: summary.rotateToken.validCount,
            },
    },
  };
}

/**
 * A collector group, its assignment's configuration and version beside it
 * (decision 14). A fleet's create makes its Default group unassigned, so
 * the create passes null; the group routes (Task 4) look the version up.
 */
export function toCollectorGroup(group: Opamp.CollectorGroup, assignedVersion: CollectorGroup["assignedVersion"]): CollectorGroup {
  return {
    id: group.id,
    fleetId: group.fleetId,
    name: group.name,
    isDefault: group.isDefault,
    annotations: group.annotations,
    assignedPublishedVersionId: group.assignedPublicationId,
    assignedVersion,
    variableGroupId: group.variableGroupId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function toEnrollmentToken(token: Opamp.EnrollmentToken): EnrollmentToken {
  return {
    id: token.id,
    fleetId: token.fleetId,
    kind: token.kind,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    doRefresh: token.doRefresh,
    createdBy: toActor(token.createdBy),
    createdAt: token.createdAt,
  };
}

/** Each publication id's configuration and version (decision 14), or null where the platform holds no live version recording it. */
type VersionOf = (publicationId: string | null) => PublishedVersion | null;

/** A collector's pin under the platform's names (contracts/fleets.ts maps them): a version's re-sendable as a pin's request. */
function toCollectorPin(pin: NonNullable<Opamp.CollectorInstancePin>, versionOf: VersionOf): NonNullable<Collector["pin"]> {
  const version = versionOf(pin.id);
  return { kind: "version", versionId: version?.versionId ?? null, publishedVersionId: pin.id, version };
}

/** What resolves for a collector, under the platform's names. */
function toCollectorResolution(resolution: NonNullable<Opamp.CollectorInstance["resolution"]>, versionOf: VersionOf): NonNullable<Collector["resolution"]> {
  const { from, id, sha256 } = resolution;
  return { from: from === "pinnedPublication" ? "pinnedVersion" : "groupVersion", publishedVersionId: id, sha256, version: versionOf(id) };
}

/**
 * What a collector was served, under the platform's names. The
 * opamp-server names neither its kind nor its id once it is deleted, which
 * its API documents as a deleted published version: a version, its id null.
 */
function toCollectorServed(served: NonNullable<Opamp.CollectorInstance["served"]>, versionOf: VersionOf): NonNullable<Collector["served"]> {
  const { id, sha256, at } = served;
  return { kind: "version", publishedVersionId: id, sha256, at, version: versionOf(id) };
}

/** A fleet's collector, each published version it names with the platform's names beside it. */
function toCollector(collector: Opamp.CollectorInstance, versionOf: VersionOf): Collector {
  const { pin, resolution, served, effective, reported } = collector;
  return {
    id: collector.id,
    instanceUid: collector.instanceUid,
    name: collector.name,
    fleetId: collector.fleetId,
    groupId: collector.groupId,
    pin: pin === null ? null : toCollectorPin(pin, versionOf),
    pinnedVariableGroupId: collector.pinnedVariableGroupId,
    resolution: resolution === null ? null : toCollectorResolution(resolution, versionOf),
    served: served === null ? null : toCollectorServed(served, versionOf),
    effective:
      effective === null ? null : { sha256: effective.sha256, status: effective.status, error: effective.error, at: effective.at },
    reported: {
      collectorVersion: reported.collectorVersion,
      ip: reported.ip,
      hostIp: reported.hostIp,
      attributes: reported.attributes === null ? null : { ...reported.attributes },
    },
    enrollmentTokenId: collector.enrollmentTokenId,
    lastSeenAt: collector.lastSeenAt,
    liveness: collector.liveness,
    // The opamp-server's `sync` (0.2.4) is the platform contract's `drift`,
    // same values (D36-1 decision 15).
    drift: collector.sync,
    createdAt: collector.createdAt,
    updatedAt: collector.updatedAt,
  };
}

/** The publication ids a collector names: its pin's, its resolution's and what it was served. */
function publicationIdsOf(collector: Opamp.CollectorInstance): (string | null)[] {
  return [
    collector.pin?.kind === "publication" ? collector.pin.id : null,
    collector.resolution?.id ?? null,
    collector.served?.kind === "publication" ? collector.served.id : null,
  ];
}

/**
 * The platform's key of a group request's annotations (the contract checked
 * its shape: a plain object when present), or undefined for none.
 */
function telfloAnnotationsOf(annotations: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (annotations === null || annotations === undefined || !Object.hasOwn(annotations, TELFLO_ANNOTATIONS_KEY)) return undefined;
  return annotations[TELFLO_ANNOTATIONS_KEY] as Record<string, unknown>;
}

/**
 * D17d-1 decisions 17 and 18, Preflight ruling 13: a group's write against
 * its fleet's type, once the fleet is read. A `server` fleet's group takes
 * no `telflo.kubernetes`. A `kubernetes-supervisor` fleet's group takes no
 * `telflo.dockerMounts` and no rename (any `name`: 409
 * `collector_group_name_fixed`, without reading the group's current name);
 * its create is named `cluster` (the Cluster) or a gateway's name, and
 * carries `telflo.kubernetes` naming its role (collectorGroupRole). An
 * update carrying `annotations` carries `telflo.kubernetes` too (Ruling 48:
 * once written, a Kubernetes group's settings are never dropped), naming
 * the group's role, which `roleOfGroup` reads (the Default group's is
 * `node`); an update without `annotations` (an assignment) reads nothing
 * more. The Default group of a Kubernetes fleet may hold no `kubernetes`
 * key until its first save. The
 * trims are the browser's: the contract already refused a name with an edge
 * space.
 */
async function refusalForFleetType(
  type: FleetType,
  write:
    | { create: true; name: string; annotations: Record<string, unknown> | null | undefined }
    | { create: false; name: string | undefined; annotations: Record<string, unknown> | null | undefined },
  roleOfGroup: () => Promise<KubernetesRole | null>,
): Promise<void> {
  const telflo = telfloAnnotationsOf(write.annotations);
  const kubernetes = telflo !== undefined && Object.hasOwn(telflo, "kubernetes") ? (telflo.kubernetes as { role: KubernetesRole }) : undefined;
  if (type !== "kubernetes-supervisor") {
    if (kubernetes !== undefined) throw kubernetesOnServerFleet();
    return;
  }
  if (!write.create && write.name !== undefined) throw collectorGroupNameFixed();
  if (telflo !== undefined && Object.hasOwn(telflo, "dockerMounts")) throw dockerMountsOnKubernetesFleet();
  if (write.create) {
    if (write.name !== COLLECTOR_GROUP_CLUSTER_NAME) {
      const problem = gatewayNameProblem(write.name);
      if (problem !== null) throw kubernetesGroupNameRefused(problem);
    }
    if (kubernetes === undefined) throw kubernetesSettingsRequired();
    const role = collectorGroupRole({ isDefault: false, name: write.name }, type) as KubernetesRole;
    if (kubernetes.role !== role) throw kubernetesRoleRefused(role);
    return;
  }
  if (write.annotations === undefined) return;
  if (kubernetes === undefined) throw kubernetesSettingsRequired();
  const role = (await roleOfGroup()) as KubernetesRole;
  if (kubernetes.role !== role) throw kubernetesRoleRefused(role);
}

/** A group request's fields as the opamp-server takes them: each given one (null included), the assignment as its published copy's id. */
function opampGroupFields(request: CreateCollectorGroupRequest | UpdateCollectorGroupRequest, assignedPublicationId: string | null | undefined) {
  return {
    ...(assignedPublicationId === undefined ? {} : { assignedPublicationId }),
    // On any fleet's group (D17c-1 decision 30): the whole object the
    // contract checked (a Kubernetes group's settings within it), or null.
    ...(request.annotations === undefined ? {} : { annotations: request.annotations }),
    // D20 decision 5: the variable group its collectors' text is filled in with, or null for none.
    ...(request.variableGroupId === undefined ? {} : { variableGroupId: lowerOrNull(request.variableGroupId) }),
  };
}

/** An id the contract took, in lower case, or null. */
function lowerOrNull(id: string | null): string | null {
  return id === null ? null : id.toLowerCase();
}

/** A binding's variable group id for the log lines: its id, when it names one. */
function variableGroupIdsOf(variableGroupId: string | null | undefined): Pick<FleetIds, "variableGroupId"> {
  return typeof variableGroupId === "string" ? { variableGroupId: variableGroupId.toLowerCase() } : {};
}

/**
 * The bulk pin as the opamp-server takes it (Q103): each choice given, a
 * field left out leaving each collector's as it is. The contract refuses a
 * request with neither.
 */
function opampBulkPin(
  collectorIds: string[],
  pin: Opamp.CollectorInstancePin | undefined,
  pinnedVariableGroupId: string | null | undefined,
): PinCollectorInstancesRequest {
  const variableGroup = pinnedVariableGroupId === undefined ? undefined : lowerOrNull(pinnedVariableGroupId);
  if (pin !== undefined) return { collectorIds, pin, ...(variableGroup === undefined ? {} : { pinnedVariableGroupId: variableGroup }) };
  if (variableGroup === undefined) throw new Error("the contract refuses a bulk pin with neither a pin nor a variable group");
  return { collectorIds, pinnedVariableGroupId: variableGroup };
}

/** The opamp-server's actor: the session's person, never the body's. */
function opampActorOf(actor: Actor): OpampActor {
  return { id: actor.context.userId, email: actor.email };
}

/** Whether `value`, an RFC 3339 time the contract took, is after `now`, to the millisecond. */
function isAfter(value: string, now: Date): boolean {
  return Date.parse(value) > now.getTime();
}

export function createFleetsService(deps: FleetsServiceDependencies): IFleetsService {
  const { withTransaction, opampServer, limiter, opampRegistration, now, log, install, installTemplates, quickDeploy } = deps;

  /**
   * Preflight ruling 12: the person's count of `kind` and an in-flight slot
   * in the organization, taken just before the first call and given back
   * once the request's work is done; 429 `rate_limited` with Retry-After
   * when either is spent.
   */
  async function admitted<Result>(actor: Actor, kind: FleetRequestKind, work: () => Promise<Result>): Promise<Result> {
    const admission = limiter.admit(actor.context.userId, actor.context.organizationId, kind);
    if (!admission.isAdmitted) throw fleetsRateLimited(admission.retryAfterSeconds);
    try {
      return await work();
    } finally {
      admission.release();
    }
  }

  /**
   * One call to the opamp-server. A misconfiguration (a 401, a reply the API
   * doesn't document, ids that aren't the request's) is the one 503, logged
   * at error with the client's message, which names the operation and the
   * status only (never a URL, a body or the secret). Any other throw is the
   * one 503 too (Ruling 34; decision 19), logged at error with its name
   * only, since its message could quote anything.
   */
  async function call<Result>(operation: string, ids: FleetIds, send: () => Promise<Result>): Promise<Result> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof OpampServerMisconfigurationError) {
        log.error({ operation, ...ids, error: error.message }, "the opamp-server's settings are wrong, or its answer isn't the API's");
        throw fleetsUnavailable();
      }
      log.error({ operation, ...ids, error: error instanceof Error ? error.name : typeof error }, "fleet management failed: calling the opamp-server threw");
      throw fleetsUnavailable();
    }
  }

  /**
   * The one 503 for an outcome that isn't the person's to fix: logged with
   * the ids and the result's kind (with a reason, a status or a code), a
   * warning when the opamp-server couldn't be asked, an error when it
   * answered something the platform's own checks should have prevented.
   */
  function unavailable(operation: string, ids: FleetIds, result: { kind: string }): never {
    const fields = { operation, ...ids, ...describeResult(result) };
    if (result.kind === "unavailable") log.warn(fields, "fleet management failed: the opamp-server couldn't be asked");
    else if (result.kind === "organization_not_found") {
      // Only a create gets here: the organization gone from the
      // opamp-server between the ensure and the create (its delete hook
      // ran meanwhile), a race and not a fault of either side.
      log.warn(fields, "fleet management failed: the opamp-server no longer knows the organization");
    } else log.error(fields, "fleet management failed: the opamp-server's answer wasn't one the platform expected");
    throw fleetsUnavailable();
  }

  /**
   * A create's or a rotation's 400 `invalid_request` (Ruling 22): with a
   * time sent, the opamp-server's clock refused it (clock skew, or a time it
   * can't keep), which is the person's 400. Without one, the contract
   * checked everything the opamp-server would refuse: the one 503, logged
   * at warn with the ids and the code (never its message).
   */
  function refusedTime(
    operation: string,
    ids: FleetIds,
    result: Invalid,
    fields: readonly [string, ...string[]] | undefined,
  ): never {
    if (result.code === "invalid_request" && fields !== undefined) throw invalidTime(...fields);
    if (result.code === "invalid_request") {
      log.warn(
        { operation, ...ids, ...describeResult(result) },
        "fleet management failed: the opamp-server refused a request the platform had checked",
      );
      throw fleetsUnavailable();
    }
    return unavailable(operation, ids, result);
  }

  /**
   * Preflight ruling 15: the row, after the opamp-server's success, in its
   * own transaction, with the actor's email, address and user agent. Ids,
   * a kind, a type, a status and field names only: never a label or a
   * bearer. A failed write is an error log with the ids; the change stands.
   */
  async function audit(
    actor: Actor,
    action: string,
    subject: AuditSubject,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await withTransaction(actor.context, (transaction) =>
        transaction.audit.record(auditEvent(actor, action, subject, metadata)),
      );
    } catch (error) {
      log.error(
        { action, organizationId: actor.context.organizationId, subjectId: subject.id, error: errorName(error) },
        "the fleet change's audit row wasn't written: the change stands",
      );
    }
  }

  /**
   * D17c-2 Preflight ruling 9: after a fleet's delete in the opamp-server,
   * one transaction removes its quick-deploy links and writes the
   * `fleet.deleted` row. A failure is an error log with the ids, as any
   * failed row's; the delete stands, and the links left answer 410 (their
   * fleet is gone).
   */
  async function removedWithLinks(actor: Actor, ids: FleetIds & { fleetId: string }): Promise<void> {
    try {
      await withTransaction(actor.context, async (transaction) => {
        const links = await transaction.quickDeployLinks.removeForFleet(ids.fleetId);
        await transaction.audit.record(auditEvent(actor, "fleet.deleted", { type: "fleet", id: ids.fleetId }, { fleetId: ids.fleetId }));
        return links;
      });
    } catch (error) {
      // The words and fields of every fleet change's failed row (audit()'s), so D16b's readers see it alike;
      // the links stay with it (rolled back together) and answer 410, their fleet being gone.
      log.error(
        { action: "fleet.deleted", organizationId: ids.organizationId, subjectId: ids.fleetId, fleetId: ids.fleetId, error: errorName(error) },
        "the fleet change's audit row wasn't written: the change stands",
      );
    }
  }

  /**
   * Ruling 49: a fleet's delete answered 404 (the fleet, or the
   * organization, unknown to the opamp-server) may be the retry of a delete
   * that the opamp-server carried out after the platform stopped waiting
   * (the first answer a 503): its links went with nothing, so the 404
   * removes them, in the person's context and with no audit row (the
   * opamp-server's own record holds the delete; a fleet never known has
   * none to remove). A failure is an error log with the ids; the 404
   * stands, and the links left answer 410, their fleet being gone.
   */
  async function linksOfGoneFleetRemoved(actor: Actor, ids: FleetIds & { fleetId: string }): Promise<void> {
    try {
      await withTransaction(actor.context, (transaction) => transaction.quickDeployLinks.removeForFleet(ids.fleetId));
    } catch (error) {
      log.error(
        { operation: "removeQuickDeployLinks", organizationId: ids.organizationId, fleetId: ids.fleetId, error: errorName(error) },
        "a gone fleet's quick-deploy links weren't removed: they answer 410",
      );
    }
  }

  /** A path's fleet id, canonical, or its 404 before any call. */
  function fleetIdOf(fleetId: string): string {
    const id = canonicalIdOf(fleetId);
    if (id === undefined) throw fleetNotFound();
    return id;
  }

  function tokenIdOf(tokenId: string): string {
    const id = canonicalIdOf(tokenId);
    if (id === undefined) throw enrollmentTokenNotFound();
    return id;
  }

  function groupIdOf(groupId: string): string {
    const id = canonicalIdOf(groupId);
    if (id === undefined) throw collectorGroupNotFound();
    return id;
  }

  function linkIdOf(linkId: string): string {
    const id = canonicalIdOf(linkId);
    if (id === undefined) throw quickDeployLinkNotFound();
    return id;
  }

  /** A member's install reads, in their database context. */
  function readAs(actor: Actor): InstallRead {
    return (work) => withTransaction(actor.context, work);
  }

  function collectorIdOf(collectorId: string): string {
    const id = canonicalIdOf(collectorId);
    if (id === undefined) throw collectorNotFound();
    return id;
  }

  /**
   * Decision 14, Preflight ruling 5: the published copy's id of a version of
   * a live configuration the person can see, read in a short committed
   * transaction before the limit and any call. None: 404
   * `configuration_version_not_found` (another organization's, another
   * member's draft, a deleted configuration's, an unknown one); a draft:
   * 422 `configuration_version_not_published`.
   */
  async function publicationIdOf(actor: Actor, versionId: string): Promise<string> {
    const resolved = await withTransaction(actor.context, (transaction) =>
      transaction.publishedVersions.resolve(versionId.toLowerCase()),
    );
    if (resolved === undefined) throw configurationVersionNotFound();
    if (resolved.publicationId === null) throw configurationVersionNotPublished();
    return resolved.publicationId;
  }

  /** A pin as the opamp-server takes it: a version's published copy (resolved first), or null. */
  async function opampPinOf(actor: Actor, pin: CollectorPinRequest): Promise<{ pin: Opamp.CollectorInstancePin; ids: Pick<FleetIds, "versionId" | "publicationId"> }> {
    if (pin === null) return { pin: null, ids: {} };
    const publicationId = await publicationIdOf(actor, pin.versionId);
    return { pin: { kind: "publication", id: publicationId }, ids: { versionId: pin.versionId.toLowerCase(), publicationId } };
  }

  /**
   * Decision 14, Preflight ruling 5: the platform's configuration and
   * version of each publication id a reply names, from one query (none when
   * it names none).
   */
  async function versionsOf(actor: Actor, publicationIds: (string | null)[]): Promise<VersionOf> {
    const ids = publicationIds.filter((id): id is string => id !== null);
    const described =
      ids.length === 0
        ? new Map<string, PublishedVersion>()
        : await withTransaction(actor.context, (transaction) => transaction.publishedVersions.describe(ids));
    return (id) => (id === null ? null : (described.get(id.toLowerCase()) ?? null));
  }

  /**
   * Preflight ruling 8: a 422 `publication_not_found` for a version the
   * platform resolved means the two sides disagree (a published copy the
   * opamp-server lost), which isn't the person's to fix: the one 503,
   * logged at error with the ids (nothing heals it yet).
   */
  function disagreed(operation: string, ids: FleetIds): never {
    log.error(
      { operation, ...ids, result: "publication_not_found" },
      "fleet management failed: the opamp-server doesn't hold a published version the platform resolved",
    );
    throw fleetsUnavailable();
  }

  /**
   * Preflight ruling 13 (D16b's rulings 8 and 9 before it): before a
   * group's create, or its update carrying a name or annotations, the
   * fleet's type (it never changes), read within the request's count and
   * slot. The fleet unknown (or the organization, to the opamp-server): 404
   * `fleet_not_found`. Any other failure: the one 503.
   */
  async function fleetTypeOf(ids: FleetIds & { fleetId: string }): Promise<FleetType> {
    const result = await call("getFleet", ids, () => opampServer.getFleet(ids.organizationId, ids.fleetId));
    switch (result.kind) {
      case "found":
        return result.fleet.type;
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("getFleet", ids, result);
    }
  }

  /**
   * A Kubernetes fleet's group's role, for an update carrying its settings
   * (Preflight ruling 13): the group read within the request's slot (its
   * name and whether it is the Default group, neither of which changes on a
   * Kubernetes fleet). Unknown: 404 `collector_group_not_found`; the fleet
   * unknown: 404 `fleet_not_found`; any other failure: the one 503.
   */
  async function kubernetesRoleOf(ids: FleetIds & { fleetId: string; groupId: string }, type: FleetType): Promise<KubernetesRole | null> {
    const result = await call("getCollectorGroup", ids, () => opampServer.getCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId));
    switch (result.kind) {
      case "found":
        return collectorGroupRole(result.group, type);
      case "collector_group_not_found":
        throw collectorGroupNotFound();
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("getCollectorGroup", ids, result);
    }
  }

  /** A group as the platform answers it: its assignment's configuration and version beside it. */
  async function groupWithVersion(actor: Actor, group: Opamp.CollectorGroup): Promise<CollectorGroup> {
    const versionOf = await versionsOf(actor, [group.assignedPublicationId]);
    return toCollectorGroup(group, versionOf(group.assignedPublicationId));
  }

  /** A collector as the platform answers it: each published version it names with its configuration and version. */
  async function collectorWithVersions(actor: Actor, collector: Opamp.CollectorInstance): Promise<Collector> {
    return toCollector(collector, await versionsOf(actor, publicationIdsOf(collector)));
  }

  /**
   * Preflight ruling 13: after a create's success (201 or 200), the
   * organization taken `for share`. Gone (deleted while the create ran, its
   * delete's DELETE possibly landed before the ensure registered it again):
   * the delete hook runs again, and 404 `organization_not_found`. Live: the
   * 201's `fleet.created` row in the same transaction; the organization's
   * delete takes the row `for no key update`, so it waits, and its DELETE
   * then removes the fleet. A transaction that fails otherwise is an error
   * log with the ids, and the create's answer stands (its bearers come
   * only once).
   */
  async function recheckOrganization(actor: Actor, ids: Required<Pick<FleetIds, "organizationId" | "fleetId">>, created?: { type: string }) {
    let isGone: boolean;
    try {
      isGone = await withTransaction(actor.context, async (transaction) => {
        if (!(await transaction.organization.findActiveForShare())) return true;
        if (created !== undefined) {
          await transaction.audit.record(
            auditEvent(actor, "fleet.created", { type: "fleet", id: ids.fleetId }, { fleetId: ids.fleetId, type: created.type }),
          );
        }
        return false;
      });
    } catch (error) {
      log.error(
        { operation: "createFleet", ...ids, error: errorName(error) },
        "the fleet's create couldn't re-check its organization or write its audit row: the fleet stands",
      );
      return;
    }
    if (isGone) {
      log.warn({ operation: "createFleet", ...ids }, "the organization was deleted while its fleet was created: it is deleted in the opamp-server again");
      opampRegistration.deleted(ids.organizationId);
      throw organizationNotFound();
    }
  }

  /**
   * D17c-1 Preflight ruling 14: what an install needs of the group, within
   * the request's count and slot, refused in this order: the fleet unknown
   * (404), archived (409 `fleet_archived`), not the install's fleet type
   * (409 `fleet_type_not_installable`, D17d-2 Preflight ruling 2: `path`
   * "server", the Linux bundle and link, refuses a Kubernetes-supervisor
   * fleet with FLEET_TYPE_NOT_INSTALLABLE_MESSAGE; "helm", a Helm values
   * link, refuses a server fleet with FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE;
   * "any", the facts, neither); the group unknown (404); no published
   * version (409 `collector_group_unassigned`); a version the platform holds
   * no live one of, a deleted configuration's (409
   * `collector_group_assignment_deleted`); one built for another
   * distribution than the image's and the bundles' (otelcol-contrib), or for
   * a collector version the catalogue doesn't offer (409
   * `collector_version_not_offered`, Ruling 47).
   */
  async function installable(
    read: InstallRead,
    ids: FleetIds & { fleetId: string; groupId: string },
    path: "server" | "helm" | "any",
  ): Promise<{ fleetType: FleetType; group: Opamp.CollectorGroup; version: InstallableVersion }> {
    const fleetResult = await call("getFleet", ids, () => opampServer.getFleet(ids.organizationId, ids.fleetId));
    let fleetType: FleetType;
    switch (fleetResult.kind) {
      case "found":
        if (fleetResult.fleet.status === "archived") throw fleetArchived();
        fleetType = fleetResult.fleet.type;
        if (path === "server" && fleetType !== "server") throw fleetTypeNotInstallable();
        if (path === "helm" && fleetType !== "kubernetes-supervisor") throw fleetTypeNotHelmInstallable();
        break;
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("getFleet", ids, fleetResult);
    }
    const groupResult = await call("getCollectorGroup", ids, () =>
      opampServer.getCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId),
    );
    let group: Opamp.CollectorGroup;
    switch (groupResult.kind) {
      case "found":
        group = groupResult.group;
        break;
      case "collector_group_not_found":
        throw collectorGroupNotFound();
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("getCollectorGroup", ids, groupResult);
    }
    const publicationId = group.assignedPublicationId;
    if (publicationId === null) throw collectorGroupUnassigned();
    const found = await read(async (transaction) => {
      const version = await transaction.publishedVersions.findForInstall(publicationId);
      if (version === undefined) return undefined;
      return { version, state: await transaction.catalogue.findVersionState(version.collectorDistribution, version.collectorVersion) };
    });
    if (found === undefined) throw collectorGroupAssignmentDeleted();
    if (found.version.collectorDistribution !== INSTALL_DISTRIBUTION) throw collectorDistributionNotInstallable(found.version.collectorDistribution);
    if (found.state !== "offered") throw collectorVersionNotOffered(found.version.collectorVersion);
    return { fleetType, group, version: found.version };
  }

  /**
   * A Helm values link's variables (D17d-2 Preflight ruling 4): none the
   * chart sets itself (HELM_CHART_ENV_NAMES, in their own words: Ruling
   * 41), and only those the group's Helm facts offer (as the bundle's), each
   * 400 at its index, in that order; a YAML 1.1 word is a name like any
   * other (the platform's chart quotes the keys: D18 decision 23). The
   * details name each index, never the name.
   */
  function refuseHelmVariables(facts: HelmInstallFacts, env: readonly EnvValue[]): void {
    const chartSet = new Set<string>(HELM_CHART_ENV_NAMES);
    const chartsOwn = env.flatMap((variable, index) => (chartSet.has(variable.name) ? [index] : []));
    if (chartsOwn.length > 0) throw helmChartEnvNamesRefused(chartsOwn);
    const offered = new Set(facts.envVarNames);
    const notOffered = env.flatMap((variable, index) => (offered.has(variable.name) ? [] : [index]));
    if (notOffered.length > 0) throw envVarsNotOffered(notOffered);
  }

  /**
   * The bearer a Helm values link's download carries (D17d-2 Preflight
   * ruling 9): the link's default token revealed afresh with no actor (the
   * opamp-server records a `viewed` event naming no person). Revoked,
   * expired or unknown: 410 (decision 26's words); the fleet or the
   * organization gone: 410; anything else the one 503. Never logged.
   */
  async function revealedBearer(ids: FleetIds & { fleetId: string }, tokenId: string): Promise<string> {
    const result = await call("revealEnrollmentToken", ids, () =>
      opampServer.revealEnrollmentToken(ids.organizationId, ids.fleetId, tokenId, null),
    );
    switch (result.kind) {
      case "revealed":
        return result.token.bearer;
      case "enrollment_token_not_found":
      case "enrollment_token_revoked":
      case "enrollment_token_expired":
        throw downloadTokenRevoked();
      case "fleet_not_found":
      case "organization_not_found":
        throw downloadFleetGone();
      default:
        return unavailable("revealEnrollmentToken", ids, result);
    }
  }

  /** Only the variables the facts offer (D17c-1 decision 39): the details name each index, never the name. */
  function refuseVariablesNotOffered(version: InstallableVersion, env: readonly EnvValue[]): void {
    const offered = new Set(requiredEnvVarNames(version.yaml));
    const notOffered = env.flatMap((variable, index) => (offered.has(variable.name) ? [] : [index]));
    if (notOffered.length > 0) throw envVarsNotOffered(notOffered);
  }

  /**
   * The version's binaries for the arch (and the offered supervisors, for
   * own-binary): a version with none for the arch is the person's 409,
   * before anything is rendered (Ruling 47).
   */
  async function binariesOf(read: InstallRead, version: InstallableVersion, method: BundleChoices["method"], arch: BundleChoices["arch"]) {
    const { binaries, offeredBinaries } = await read(async (transaction) => ({
      binaries: await transaction.catalogue.findVersionBinaries(version.collectorDistribution, version.collectorVersion),
      offeredBinaries: method === "own-binary" ? await transaction.catalogue.listOfferedBinaries(version.collectorDistribution) : [],
    }));
    const platform = `linux_${arch}`;
    const otelcolContrib = binaries?.otelcolContrib[platform];
    const opampSupervisor = binaries?.opampSupervisor[platform];
    if (opampSupervisor === undefined || (method === "all-in-one" && otelcolContrib === undefined)) {
      throw collectorBinariesMissing(version.collectorVersion, arch);
    }
    return { platform, otelcolContrib, opampSupervisor, offeredBinaries };
  }

  /**
   * A token's bearer revealed for `actor` (the opamp-server records a
   * `viewed` event naming them), audited `enrollment_token.revealed` with
   * ids and its kind, and `extra` beside them (D25 decision 38: the public
   * install's `via` and `platform`), never the bearer. The caller holds the
   * bearer admission.
   */
  async function revealedFor(
    actor: Actor,
    ids: FleetIds & { fleetId: string; tokenId: string },
    extra: Readonly<Record<string, string>> = {},
  ): Promise<{ id: string; kind: "default" | "rotate"; bearer: string; expiresAt: string | null }> {
    const result = await call("revealEnrollmentToken", ids, () =>
      opampServer.revealEnrollmentToken(ids.organizationId, ids.fleetId, ids.tokenId, opampActorOf(actor)),
    );
    switch (result.kind) {
      case "revealed": {
        const { token } = result;
        await audit(actor, "enrollment_token.revealed", { type: "enrollment_token", id: ids.tokenId }, {
          fleetId: ids.fleetId,
          tokenId: ids.tokenId,
          kind: token.kind,
          ...extra,
        });
        return { id: token.id, kind: token.kind, bearer: token.bearer, expiresAt: token.expiresAt };
      }
      case "enrollment_token_not_found":
        throw enrollmentTokenNotFound();
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      case "enrollment_token_revoked":
        throw enrollmentTokenRevoked();
      case "enrollment_token_expired":
        throw enrollmentTokenExpired();
      default:
        return unavailable("revealEnrollmentToken", ids, result);
    }
  }

  /**
   * A Linux bundle (D17c-1 decision 39; D17c-2 Preflight ruling 9), for
   * `installable`'s group and version: the method's templates read now, the
   * binaries for the arch, every placeholder filled from `choices` (validated
   * fields only), the settings and the catalogue. No actor, no audit: the
   * caller's.
   */
  async function renderBundle(
    read: InstallRead,
    ids: FleetIds,
    group: Opamp.CollectorGroup,
    version: InstallableVersion,
    choices: BundleChoices,
    operation: string,
  ): Promise<Buffer> {
    const templates = await templatesOf(ids, choices.method, operation);
    const { platform, otelcolContrib, opampSupervisor, offeredBinaries } = await binariesOf(read, version, choices.method, choices.arch);
    const values = bundleValues({
      method: choices.method,
      arch: choices.arch,
      endpoint: install.agentPublicUrl,
      allowInsecureConnections: install.allowInsecureConnections,
      groupId: group.id,
      rootPath: choices.rootPath,
      ...(choices.executablePath === undefined ? {} : { executablePath: choices.executablePath }),
      env: [...choices.env],
      collectorVersion: version.collectorVersion,
      otelcolContrib,
      opampSupervisor,
      offeredSupervisors: offeredBinaries.map((offeredVersion) => ({
        version: offeredVersion.version,
        opampSupervisor: offeredVersion.opampSupervisor[platform],
      })),
    });
    return tarGz(
      templates.map((template) => ({
        name: template.name,
        content: Buffer.from(renderTemplate(template.name, template.text, values), "utf8"),
        mode: template.mode,
      })),
      now(),
    );
  }

  /** The fleet's tokens (no bearer), for a quick-deploy link's default token. */
  async function fleetTokens(ids: FleetIds & { fleetId: string }): Promise<Opamp.EnrollmentTokenListed[]> {
    const result = await call("listEnrollmentTokens", ids, () => opampServer.listEnrollmentTokens(ids.organizationId, ids.fleetId));
    switch (result.kind) {
      case "listed":
        return result.tokens;
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("listEnrollmentTokens", ids, result);
    }
  }

  /**
   * The fleet's groups' names by id (Preflight ruling 20: one call for a
   * page of links). The fleet gone: no names (its links read "a deleted
   * group").
   */
  async function groupNamesOf(ids: FleetIds & { fleetId: string }): Promise<Map<string, string>> {
    const result = await call("listCollectorGroups", ids, () => opampServer.listCollectorGroups(ids.organizationId, ids.fleetId));
    switch (result.kind) {
      case "listed":
        return new Map(result.groups.map((group) => [group.id.toLowerCase(), group.name]));
      case "fleet_not_found":
      case "organization_not_found":
        return new Map();
      default:
        return unavailable("listCollectorGroups", ids, result);
    }
  }

  /** One group's name, or null once it (or its fleet) is gone. */
  async function groupNameOf(ids: FleetIds & { fleetId: string; groupId: string }): Promise<string | null> {
    const result = await call("getCollectorGroup", ids, () => opampServer.getCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId));
    switch (result.kind) {
      case "found":
        return result.group.name;
      case "collector_group_not_found":
      case "fleet_not_found":
      case "organization_not_found":
        return null;
      default:
        return unavailable("getCollectorGroup", ids, result);
    }
  }

  /** A link's audit row with the member (Preflight ruling 13): ids and the preset only. */
  function linkAuditEvent(actor: Actor, action: string, linkId: string, metadata: Record<string, unknown>) {
    return auditEvent(actor, action, { type: QUICK_DEPLOY_LINK_SUBJECT, id: linkId }, metadata);
  }

  /**
   * A method's templates, read now (decision 36). A set that can't be used
   * is the 503 `install_unavailable`, logged with the method, the file's
   * relative path and the platform's reason only, never the template's text.
   */
  async function templatesOf(ids: FleetIds, method: InstallBundleRequest["method"], operation: string): Promise<TemplateFile[]> {
    try {
      return await installTemplates.load(method);
    } catch (error) {
      if (!(error instanceof InstallTemplatesError)) throw error;
      log.error(
        { operation, ...ids, method, file: error.file, reason: error.reason },
        "installing failed: the install templates can't be used",
      );
      throw installUnavailable();
    }
  }

  /**
   * A quick-deploy link's create for the group (D17c-2 decision 25; D17d-2
   * decision 21), within the caller's write admission: what the bundle or
   * the Helm install would refuse, the fleet's valid default token (else
   * 409), then the link in one transaction (create-link.ts). `beside`, when
   * given, writes in that same transaction once the link is made (D25
   * Ruling 161: the Kubernetes install's reveal-like audit row).
   */
  async function linkCreated(
    actor: Actor,
    ids: FleetIds & { fleetId: string; groupId: string },
    request: CreateQuickDeployLinkRequest,
    beside?: (transaction: FleetsTransaction, link: StoredQuickDeployLink) => Promise<void>,
  ): Promise<CreateQuickDeployLinkResponse> {
    const read = readAs(actor);
    let group: Opamp.CollectorGroup;
    let choices: QuickDeployLinkToCreate["choices"];
    if (request.kind === "helm") {
      // A Helm values link (D17d-2 decision 21; Preflight ruling 13): a Kubernetes fleet's group, its settings
      // readable, the variables its Helm facts offer; choices from the server's state only.
      const found = await installable(read, ids, "helm");
      const facts = helmFactsOf(found.group, found.version, install);
      refuseHelmVariables(facts, request.env);
      group = found.group;
      choices = { kind: "helm", role: facts.helm.role, release: facts.helm.release, namespace: facts.helm.namespace };
    } else {
      // What the bundle would refuse (D17c-1's facts and bundle checks), before anything is stored.
      const found = await installable(read, ids, "server");
      refuseVariablesNotOffered(found.version, request.env);
      await binariesOf(read, found.version, request.method, request.arch);
      group = found.group;
      choices = {
        method: request.method,
        arch: request.arch,
        rootPath: request.rootPath,
        executablePath: request.executablePath ?? null,
        systemd: request.systemd,
      };
    }
    // The command carries the fleet's default token's bearer (decision 10): one valid now, else 409.
    const at = now();
    const defaultToken = (await fleetTokens(ids)).find((token) => token.kind === "default" && tokenValidAt(token, at));
    if (defaultToken === undefined) throw enrollmentTokenDefaultMissing();
    const { secret, secretHash } = generateQuickDeploySecret();
    const outcome = await withTransaction(actor.context, async (transaction) => {
      const created = await createQuickDeployLink(transaction, actor, quickDeploy.keyRing, {
        fleetId: ids.fleetId,
        groupId: ids.groupId,
        defaultTokenId: defaultToken.id,
        secretHash,
        choices,
        values: request.env,
        createdAt: at,
        expiresAt: quickDeployLinkFirstExpiry(at),
      });
      // In the link's own transaction: committed with it, or not at all.
      if (created.kind === "created" && beside !== undefined) await beside(transaction, created.link);
      return created;
    });
    switch (outcome.kind) {
      case "created":
        return { link: toQuickDeployLinkReply(outcome.link, group.name, at), url: quickDeployLinkUrl(quickDeploy.publicApiUrl, secret) };
      case "limit_reached":
        throw quickDeployLinkLimitReached();
      case "organization_gone":
        throw organizationNotFound();
      case "links_disabled":
        throw publicInstallLinksDisabled();
    }
  }

  /**
   * A link the public install made revoked again, its command never given
   * (D25 Ruling 174: the reveal after it failed), as a member's revoke does
   * (revokeQuickDeployLink): revoked by the actor, audited
   * `quick_deploy_link.revoked` with ids, in one transaction. A failure is
   * an error log with the ids; the caller's refusal stands, and the link
   * expires in 24 hours.
   */
  async function linkWithdrawn(actor: Actor, ids: FleetIds & { fleetId: string; linkId: string }): Promise<void> {
    try {
      await withTransaction(actor.context, async (transaction) => {
        const revoked = await transaction.quickDeployLinks.revoke(ids.fleetId, ids.linkId, actor.context.userId, now());
        if (revoked !== undefined) {
          await transaction.audit.record(linkAuditEvent(actor, QUICK_DEPLOY_LINK_REVOKED, ids.linkId, { linkId: ids.linkId, fleetId: ids.fleetId }));
        }
      });
    } catch (error) {
      log.error(
        { operation: "revokeQuickDeployLink", organizationId: ids.organizationId, fleetId: ids.fleetId, linkId: ids.linkId, error: errorName(error) },
        "the public install's link wasn't revoked after its reveal failed: it expires in 24 hours",
      );
    }
  }

  /**
   * The group a public install joins (D25 decision 37): the one named (404
   * `collector_group_not_found` when the fleet doesn't hold it), else a
   * server fleet's Default group, or a Kubernetes fleet's only group (422
   * `collector_group_required`, its ids in the details, when it holds
   * several). Read within the request's admission.
   */
  async function installGroupOf(
    ids: FleetIds & { fleetId: string },
    fleetType: FleetType,
    namedGroupId: string | undefined,
  ): Promise<Opamp.CollectorGroup> {
    if (namedGroupId !== undefined) {
      const groupIds = { ...ids, groupId: namedGroupId };
      const result = await call("getCollectorGroup", groupIds, () => opampServer.getCollectorGroup(ids.organizationId, ids.fleetId, namedGroupId));
      switch (result.kind) {
        case "found":
          return result.group;
        case "collector_group_not_found":
          throw collectorGroupNotFound();
        case "fleet_not_found":
        case "organization_not_found":
          throw fleetNotFound();
        default:
          return unavailable("getCollectorGroup", groupIds, result);
      }
    }
    const result = await call("listCollectorGroups", ids, () => opampServer.listCollectorGroups(ids.organizationId, ids.fleetId));
    switch (result.kind) {
      case "listed": {
        const { groups } = result;
        if (fleetType !== "kubernetes-supervisor") {
          const defaultGroup = groups.find((group) => group.isDefault);
          if (defaultGroup !== undefined) return defaultGroup;
        } else if (groups.length === 1) {
          return groups[0]!;
        }
        throw collectorGroupRequired(groups.map((group) => group.id));
      }
      case "fleet_not_found":
      case "organization_not_found":
        throw fleetNotFound();
      default:
        return unavailable("listCollectorGroups", ids, result);
    }
  }

  /** Only the variables the facts offer (D17c-1 decision 39), each 400 at its index, never its name. */
  function refuseFactsVariables(offeredNames: readonly string[], env: readonly EnvValue[]): void {
    const offered = new Set(offeredNames);
    const notOffered = env.flatMap((variable, index) => (offered.has(variable.name) ? [] : [index]));
    if (notOffered.length > 0) throw envVarsNotOffered(notOffered);
  }

  const service: IFleetsService = {
    async list(actor, organizationId, query) {
      assertActiveOrganization(actor, organizationId);
      const ids: FleetIds = { organizationId: actor.context.organizationId };
      return admitted(actor, "read", async () => {
        const result = await call("listFleets", ids, () =>
          opampServer.listFleets(ids.organizationId, {
            limit: query.limit,
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        switch (result.kind) {
          case "page":
            return { fleets: result.page.fleets.map(toFleetDetail), nextCursor: result.page.nextCursor };
          case "organization_not_found":
            // An organization the opamp-server doesn't know holds no fleets (decision 15).
            return { fleets: [], nextCursor: null };
          case "invalid":
            // Only the cursor is the browser's to get wrong: the rest the contract checked.
            if (result.code === "invalid_request" && query.cursor !== undefined) throw invalidCursor();
            return unavailable("listFleets", ids, result);
          default:
            return unavailable("listFleets", ids, result);
        }
      });
    },

    async create(actor, organizationId, request) {
      assertActiveOrganization(actor, organizationId);
      if (request.rotateExpiresAt !== null && !isAfter(request.rotateExpiresAt, now())) throw invalidTime("rotateExpiresAt");
      // The browser's id makes a retry safe (decision 15); else the platform's.
      const ids = { organizationId: actor.context.organizationId, fleetId: request.id?.toLowerCase() ?? randomUUID() };
      // The name to register under, read committed (no lock across a call).
      const organization = await withTransaction(actor.context, (transaction) => transaction.organization.findActive());
      if (!organization) throw organizationNotFound();
      return admitted(actor, "bearer", async () => {
        const ensured = await call("ensureOrganization", ids, () =>
          ensureOrganization(opampServer, { id: organization.id, name: organization.name }),
        );
        if (ensured.kind === "failed") return unavailable(ensured.operation, ids, ensured.result);
        const result = await call("createFleet", ids, () =>
          opampServer.createFleet(ids.organizationId, {
            id: ids.fleetId,
            label: request.label,
            type: request.type,
            rotateExpiresAt: request.rotateExpiresAt,
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "created":
            await recheckOrganization(actor, ids, { type: result.fleet.type });
            return {
              kind: "created",
              reply: {
                fleet: toFleet(result.fleet),
                defaultGroup: toCollectorGroup(result.defaultGroup, null),
                tokens: {
                  default: { id: result.tokens.default.id, bearer: result.tokens.default.bearer },
                  rotate: {
                    id: result.tokens.rotate.id,
                    bearer: result.tokens.rotate.bearer,
                    expiresAt: result.tokens.rotate.expiresAt,
                  },
                },
              },
            };
          case "unchanged":
            await recheckOrganization(actor, ids);
            return { kind: "unchanged", fleet: toFleet(result.fleet) };
          case "fleet_conflict":
            throw fleetConflict();
          case "fleet_label_taken":
            throw fleetLabelTaken();
          case "invalid":
            // The label and the type the contract checked: a time the
            // opamp-server's clock refused (clock skew), when one was sent.
            return refusedTime("createFleet", ids, result, request.rotateExpiresAt === null ? undefined : ["rotateExpiresAt"]);
          default:
            // Down, or the organization gone between the ensure and the create (a warning).
            return unavailable("createFleet", ids, result);
        }
      });
    },

    async get(actor, organizationId, fleetIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("getFleet", ids, () => opampServer.getFleet(ids.organizationId, ids.fleetId));
        switch (result.kind) {
          case "found":
            return toFleetDetail(result.fleet);
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("getFleet", ids, result);
        }
      });
    },

    async update(actor, organizationId, fleetIdParam, changes) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "write", async () => {
        const result = await call("updateFleet", ids, () =>
          opampServer.updateFleet(ids.organizationId, ids.fleetId, {
            ...(changes.label === undefined ? {} : { label: changes.label }),
            ...(changes.status === undefined ? {} : { status: changes.status }),
          }),
        );
        switch (result.kind) {
          case "updated":
            // The fields sent: the reply doesn't say what changed (ruling 15).
            await audit(actor, "fleet.updated", { type: "fleet", id: ids.fleetId }, {
              fleetId: ids.fleetId,
              fields: Object.keys(changes).filter((field) => field === "label" || field === "status").sort(),
              status: result.fleet.status,
            });
            return toFleet(result.fleet);
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "fleet_label_taken":
            throw fleetLabelTaken();
          default:
            return unavailable("updateFleet", ids, result);
        }
      });
    },

    async remove(actor, organizationId, fleetIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      await admitted(actor, "write", async () => {
        const result = await call("deleteFleet", ids, () => opampServer.deleteFleet(ids.organizationId, ids.fleetId));
        switch (result.kind) {
          case "deleted":
            await removedWithLinks(actor, ids);
            return;
          case "fleet_not_found":
          case "organization_not_found":
            await linksOfGoneFleetRemoved(actor, ids);
            throw fleetNotFound();
          default:
            return unavailable("deleteFleet", ids, result);
        }
      });
    },

    async listTokens(actor, organizationId, fleetIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("listEnrollmentTokens", ids, () =>
          opampServer.listEnrollmentTokens(ids.organizationId, ids.fleetId),
        );
        switch (result.kind) {
          case "listed":
            return result.tokens.map((token) => ({ ...toEnrollmentToken(token), activeCollectors: token.activeCollectors }));
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("listEnrollmentTokens", ids, result);
        }
      });
    },

    async listTokenEvents(actor, organizationId, fleetIdParam, query) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("listEnrollmentTokenEvents", ids, () =>
          opampServer.listEnrollmentTokenEvents(ids.organizationId, ids.fleetId, {
            limit: query.limit,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        switch (result.kind) {
          case "page":
            return {
              events: result.page.events.map((event) => ({
                id: event.id,
                tokenId: event.tokenId,
                event: event.event,
                actor: toActor(event.actor),
                occurredAt: event.occurredAt,
              })),
              nextCursor: result.page.nextCursor,
            };
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "invalid":
            if (result.code === "invalid_request" && query.cursor !== undefined) throw invalidCursor();
            return unavailable("listEnrollmentTokenEvents", ids, result);
          default:
            return unavailable("listEnrollmentTokenEvents", ids, result);
        }
      });
    },

    async rotateToken(actor, organizationId, fleetIdParam, rotation) {
      assertActiveOrganization(actor, organizationId);
      const ids: FleetIds & { fleetId: string } = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      if (!isAfter(rotation.graceEndsAt, now())) throw invalidTime("graceEndsAt");
      if (rotation.expiresAt !== null && Date.parse(rotation.graceEndsAt) > Date.parse(rotation.expiresAt)) {
        throw graceAfterExpiry();
      }
      return admitted(actor, "bearer", async () => {
        const result = await call("rotateEnrollmentToken", ids, () =>
          opampServer.rotateEnrollmentToken(ids.organizationId, ids.fleetId, {
            expiresAt: rotation.expiresAt,
            graceEndsAt: rotation.graceEndsAt,
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "rotated": {
            const { token } = result;
            await audit(actor, "enrollment_token.rotated", { type: "enrollment_token", id: token.id }, {
              fleetId: ids.fleetId,
              tokenId: token.id,
              predecessorId: token.predecessorId,
            });
            return { id: token.id, bearer: token.bearer, expiresAt: token.expiresAt, predecessorId: token.predecessorId };
          }
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "fleet_archived":
            throw fleetArchived();
          case "invalid":
            // A time the opamp-server's clock refused (clock skew): the
            // grace's end is always sent, the new token's expiry when it
            // has one, and either may be the one refused.
            return refusedTime(
              "rotateEnrollmentToken",
              { ...ids },
              result,
              rotation.expiresAt === null ? ["graceEndsAt"] : ["expiresAt", "graceEndsAt"],
            );
          default:
            return unavailable("rotateEnrollmentToken", { ...ids }, result);
        }
      });
    },

    // D17c-1 decisions 29 and 45: one bearer admission (the reply carries
    // one); audited `enrollment_token.issued` with ids only.
    async issueDefaultToken(actor, organizationId, fleetIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids: FleetIds & { fleetId: string } = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "bearer", async () => {
        const result = await call("issueDefaultEnrollmentToken", ids, () =>
          opampServer.issueDefaultEnrollmentToken(ids.organizationId, ids.fleetId, opampActorOf(actor)),
        );
        switch (result.kind) {
          case "issued": {
            const { token } = result;
            await audit(actor, "enrollment_token.issued", { type: "enrollment_token", id: token.id }, {
              fleetId: ids.fleetId,
              tokenId: token.id,
            });
            return { id: token.id, kind: token.kind, bearer: token.bearer, expiresAt: token.expiresAt };
          }
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "fleet_archived":
            throw fleetArchived();
          case "enrollment_token_default_exists":
            throw enrollmentTokenDefaultExists();
          default:
            return unavailable("issueDefaultEnrollmentToken", { ...ids }, result);
        }
      });
    },

    async revealToken(actor, organizationId, fleetIdParam, tokenIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        tokenId: tokenIdOf(tokenIdParam),
      };
      return admitted(actor, "bearer", () => revealedFor(actor, ids));
    },

    async revokeToken(actor, organizationId, fleetIdParam, tokenIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        tokenId: tokenIdOf(tokenIdParam),
      };
      return admitted(actor, "write", async () => {
        const result = await call("revokeEnrollmentToken", ids, () =>
          opampServer.revokeEnrollmentToken(ids.organizationId, ids.fleetId, ids.tokenId, opampActorOf(actor)),
        );
        switch (result.kind) {
          case "revoked":
            // Every revoke asked, an already revoked token's included: the
            // row records the person's request (ruling 15).
            await audit(actor, "enrollment_token.revoked", { type: "enrollment_token", id: ids.tokenId }, {
              fleetId: ids.fleetId,
              tokenId: ids.tokenId,
            });
            return toEnrollmentToken(result.token);
          case "enrollment_token_not_found":
            throw enrollmentTokenNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("revokeEnrollmentToken", ids, result);
        }
      });
    },

    // -----------------------------------------------------------------------
    // Collector groups (Task 4).

    async listGroups(actor, organizationId, fleetIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("listCollectorGroups", ids, () => opampServer.listCollectorGroups(ids.organizationId, ids.fleetId));
        switch (result.kind) {
          case "listed": {
            const versionOf = await versionsOf(actor, result.groups.map((group) => group.assignedPublicationId));
            return result.groups.map((group) => toCollectorGroup(group, versionOf(group.assignedPublicationId)));
          }
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("listCollectorGroups", ids, result);
        }
      });
    },

    async createGroup(actor, organizationId, fleetIdParam, request) {
      assertActiveOrganization(actor, organizationId);
      const ids: FleetIds & { fleetId: string } = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      const assignedPublicationId =
        request.assignedVersionId === undefined || request.assignedVersionId === null
          ? request.assignedVersionId
          : await publicationIdOf(actor, request.assignedVersionId);
      if (typeof assignedPublicationId === "string") {
        ids.versionId = (request.assignedVersionId as string).toLowerCase();
        ids.publicationId = assignedPublicationId;
      }
      Object.assign(ids, variableGroupIdsOf(request.variableGroupId));
      return admitted(actor, "write", async () => {
        const type = await fleetTypeOf(ids);
        await refusalForFleetType(type, { create: true, name: request.name, annotations: request.annotations }, async () => null);
        const result = await call("createCollectorGroup", ids, () =>
          opampServer.createCollectorGroup(ids.organizationId, ids.fleetId, {
            name: request.name,
            ...opampGroupFields(request, assignedPublicationId),
          }),
        );
        switch (result.kind) {
          case "created":
            return groupWithVersion(actor, result.group);
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "collector_group_name_taken":
            throw collectorGroupNameTaken();
          case "publication_not_found":
            return disagreed("createCollectorGroup", ids);
          case "variable_group_not_found":
            throw variableGroupNotFound();
          case "variables_undefined":
            throw variablesUndefined({ names: [...result.details.names], totalNames: result.details.totalNames });
          default:
            // A 400 too: the contract checked the body, and the group against the fleet's type.
            return unavailable("createCollectorGroup", ids, result);
        }
      });
    },

    async getGroup(actor, organizationId, fleetIdParam, groupIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), groupId: groupIdOf(groupIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("getCollectorGroup", ids, () =>
          opampServer.getCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId),
        );
        switch (result.kind) {
          case "found":
            return groupWithVersion(actor, result.group);
          case "collector_group_not_found":
            throw collectorGroupNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("getCollectorGroup", ids, result);
        }
      });
    },

    async updateGroup(actor, organizationId, fleetIdParam, groupIdParam, changes) {
      assertActiveOrganization(actor, organizationId);
      const ids: FleetIds & { fleetId: string; groupId: string } = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        groupId: groupIdOf(groupIdParam),
      };
      const assignedPublicationId =
        changes.assignedVersionId === undefined || changes.assignedVersionId === null
          ? changes.assignedVersionId
          : await publicationIdOf(actor, changes.assignedVersionId);
      if (typeof assignedPublicationId === "string") {
        ids.versionId = (changes.assignedVersionId as string).toLowerCase();
        ids.publicationId = assignedPublicationId;
      }
      Object.assign(ids, variableGroupIdsOf(changes.variableGroupId));
      return admitted(actor, "write", async () => {
        if (changes.name !== undefined || changes.annotations !== undefined) {
          const type = await fleetTypeOf(ids);
          await refusalForFleetType(type, { create: false, name: changes.name, annotations: changes.annotations }, () => kubernetesRoleOf(ids, type));
        }
        const result = await call("updateCollectorGroup", ids, () =>
          opampServer.updateCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId, {
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...opampGroupFields(changes, assignedPublicationId),
          }),
        );
        switch (result.kind) {
          case "updated":
            return groupWithVersion(actor, result.group);
          case "collector_group_not_found":
            throw collectorGroupNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "collector_group_name_taken":
            throw collectorGroupNameTaken();
          case "collector_group_is_default":
            throw collectorGroupIsDefault();
          case "publication_not_found":
            return disagreed("updateCollectorGroup", ids);
          case "variable_group_not_found":
            throw variableGroupNotFound();
          case "variables_undefined":
            throw variablesUndefined({ names: [...result.details.names], totalNames: result.details.totalNames });
          default:
            return unavailable("updateCollectorGroup", ids, result);
        }
      });
    },

    async removeGroup(actor, organizationId, fleetIdParam, groupIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), groupId: groupIdOf(groupIdParam) };
      await admitted(actor, "write", async () => {
        const result = await call("deleteCollectorGroup", ids, () =>
          opampServer.deleteCollectorGroup(ids.organizationId, ids.fleetId, ids.groupId),
        );
        switch (result.kind) {
          case "deleted":
            return;
          case "collector_group_not_found":
            throw collectorGroupNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "collector_group_is_default":
            throw collectorGroupIsDefault();
          default:
            return unavailable("deleteCollectorGroup", ids, result);
        }
      });
    },

    // -----------------------------------------------------------------------
    // Collectors (Task 4).

    async listCollectors(actor, organizationId, fleetIdParam, query) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      return admitted(actor, "read", async () => {
        const result = await call("listCollectorInstances", ids, () =>
          opampServer.listCollectorInstances(ids.organizationId, ids.fleetId, {
            limit: query.limit,
            ...(query.q === undefined ? {} : { q: query.q }),
            ...(query.groupId === undefined ? {} : { groupId: query.groupId.toLowerCase() }),
            ...(query.sort === undefined ? {} : { sort: query.sort }),
            ...(query.order === undefined ? {} : { order: query.order }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        switch (result.kind) {
          case "page": {
            const { collectors, nextCursor } = result.page;
            const versionOf = await versionsOf(actor, collectors.flatMap(publicationIdsOf));
            return { collectors: collectors.map((collector) => toCollector(collector, versionOf)), nextCursor };
          }
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "invalid":
            // Only the cursor is the browser's to get wrong (another sort's, or none of the opamp-server's).
            if (result.code === "invalid_request" && query.cursor !== undefined) throw invalidCursor();
            return unavailable("listCollectorInstances", ids, result);
          default:
            return unavailable("listCollectorInstances", ids, result);
        }
      });
    },

    async pinCollectors(actor, organizationId, fleetIdParam, request) {
      assertActiveOrganization(actor, organizationId);
      const fleetIds = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      // Q103: either choice left out leaves each collector's as it is.
      const pinned = request.pin === undefined ? undefined : await opampPinOf(actor, request.pin);
      const ids = { ...fleetIds, ...pinned?.ids, ...variableGroupIdsOf(request.pinnedVariableGroupId) };
      return admitted(actor, "write", async () => {
        const result = await call("pinCollectorInstances", ids, () =>
          opampServer.pinCollectorInstances(
            ids.organizationId,
            ids.fleetId,
            opampBulkPin(
              request.collectorIds.map((id) => id.toLowerCase()),
              pinned?.pin,
              request.pinnedVariableGroupId,
            ),
          ),
        );
        switch (result.kind) {
          case "pinned":
            return { updated: result.updated, notFound: result.notFound };
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "publication_not_found":
            return disagreed("pinCollectorInstances", ids);
          case "variable_group_not_found":
            throw variableGroupNotFound();
          case "variables_undefined":
            throw variablesUndefined({ names: [...result.details.names], totalNames: result.details.totalNames });
          default:
            return unavailable("pinCollectorInstances", ids, result);
        }
      });
    },

    async getCollector(actor, organizationId, fleetIdParam, collectorIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        collectorId: collectorIdOf(collectorIdParam),
      };
      return admitted(actor, "read", async () => {
        const result = await call("getCollectorInstance", ids, () =>
          opampServer.getCollectorInstance(ids.organizationId, ids.fleetId, ids.collectorId),
        );
        switch (result.kind) {
          case "found":
            return collectorWithVersions(actor, result.collector);
          case "collector_not_found":
            throw collectorNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("getCollectorInstance", ids, result);
        }
      });
    },

    async updateCollector(actor, organizationId, fleetIdParam, collectorIdParam, changes) {
      assertActiveOrganization(actor, organizationId);
      const collectorIds = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        collectorId: collectorIdOf(collectorIdParam),
      };
      const pinned = changes.pin === undefined ? undefined : await opampPinOf(actor, changes.pin);
      const ids = { ...collectorIds, ...pinned?.ids, ...variableGroupIdsOf(changes.pinnedVariableGroupId) };
      return admitted(actor, "write", async () => {
        const result = await call("updateCollectorInstance", ids, () =>
          opampServer.updateCollectorInstance(ids.organizationId, ids.fleetId, ids.collectorId, {
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.groupId === undefined ? {} : { groupId: changes.groupId.toLowerCase() }),
            ...(pinned === undefined ? {} : { pin: pinned.pin }),
            // D20 decision 4: independent of the pin; null returns it to its group's.
            ...(changes.pinnedVariableGroupId === undefined ? {} : { pinnedVariableGroupId: lowerOrNull(changes.pinnedVariableGroupId) }),
          }),
        );
        switch (result.kind) {
          case "updated":
            return collectorWithVersions(actor, result.collector);
          case "collector_not_found":
            throw collectorNotFound();
          case "collector_group_not_found":
            throw collectorGroupNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "collector_name_taken":
            throw collectorNameTaken();
          case "publication_not_found":
            return disagreed("updateCollectorInstance", ids);
          case "variable_group_not_found":
            throw variableGroupNotFound();
          case "variables_undefined":
            throw variablesUndefined({ names: [...result.details.names], totalNames: result.details.totalNames });
          default:
            return unavailable("updateCollectorInstance", ids, result);
        }
      });
    },

    async removeCollector(actor, organizationId, fleetIdParam, collectorIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        collectorId: collectorIdOf(collectorIdParam),
      };
      await admitted(actor, "write", async () => {
        const result = await call("deleteCollectorInstance", ids, () =>
          opampServer.deleteCollectorInstance(ids.organizationId, ids.fleetId, ids.collectorId),
        );
        switch (result.kind) {
          case "deleted":
            return;
          case "collector_not_found":
            throw collectorNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          default:
            return unavailable("deleteCollectorInstance", ids, result);
        }
      });
    },

    async listCollectorErrors(actor, organizationId, fleetIdParam, collectorIdParam, query) {
      assertActiveOrganization(actor, organizationId);
      const ids = {
        organizationId: actor.context.organizationId,
        fleetId: fleetIdOf(fleetIdParam),
        collectorId: collectorIdOf(collectorIdParam),
      };
      return admitted(actor, "read", async () => {
        const result = await call("listCollectorInstanceErrors", ids, () =>
          opampServer.listCollectorInstanceErrors(ids.organizationId, ids.fleetId, ids.collectorId, {
            limit: query.limit,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        );
        switch (result.kind) {
          case "page":
            return {
              errors: result.page.errors.map((error) => ({
                id: error.id,
                reportedAt: error.reportedAt,
                configSha256: error.configSha256,
                message: error.message,
              })),
              nextCursor: result.page.nextCursor,
            };
          case "collector_not_found":
            throw collectorNotFound();
          case "fleet_not_found":
          case "organization_not_found":
            throw fleetNotFound();
          case "invalid":
            if (result.code === "invalid_request" && query.cursor !== undefined) throw invalidCursor();
            return unavailable("listCollectorInstanceErrors", ids, result);
          default:
            return unavailable("listCollectorInstanceErrors", ids, result);
        }
      });
    },

    // -----------------------------------------------------------------------
    // A configuration's fleet usage (Task 4; decision 13).

    async installFacts(actor, organizationId, fleetIdParam, groupIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), groupId: groupIdOf(groupIdParam) };
      return admitted(actor, "read", async () => {
        const { fleetType, group, version } = await installable(readAs(actor), ids, "any");
        // A Kubernetes group's facts are its Helm install's (D17d-2 decision 15): no mounts.
        if (fleetType === "kubernetes-supervisor") return helmFactsOf(group, version, install);
        // Unreadable mounts (another client's "telflo" shape) are none here, and the facts say so (Ruling 62).
        const { readable: mountsReadable, mounts } = dockerMountsOf(group.annotations);
        return {
          imageTag: `${install.collectorImageRepository}:${version.collectorVersion}`,
          endpoint: install.agentPublicUrl,
          allowInsecureConnections: install.allowInsecureConnections,
          collector: { distribution: version.collectorDistribution, version: version.collectorVersion },
          envVarNames: requiredEnvVarNames(version.yaml),
          mounts,
          mountsReadable,
          groupId: group.id,
        };
      });
    },

    async installBundle(actor, organizationId, fleetIdParam, groupIdParam, request) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), groupId: groupIdOf(groupIdParam) };
      return admitted(actor, "write", async () => {
        const read = readAs(actor);
        const { group, version } = await installable(read, ids, "server");
        refuseVariablesNotOffered(version, request.env);
        const archive = await renderBundle(read, ids, group, version, request, "installBundle");
        // Ids, the method and the arch only: never a path, a name or a value (decision 39).
        await audit(actor, "fleet.install_bundle_downloaded", { type: "fleet", id: ids.fleetId }, {
          fleetId: ids.fleetId,
          groupId: ids.groupId,
          method: request.method,
          arch: request.arch,
        });
        return { fileName: installBundleFileName(request.method, request.arch), archive };
      });
    },

    // -----------------------------------------------------------------------
    // The public install (D25 decisions 37 and 38; Preflight ruling 10; Rulings 160 and 161).

    async installCommand(actor, organizationId, fleetIdParam, request) {
      assertActiveOrganization(actor, organizationId);
      const fleetIds = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      const namedGroupId = request.groupId === undefined ? undefined : groupIdOf(request.groupId);
      const { platform } = request;
      const env = request.env ?? [];
      // One bearer admission on every platform (decision 38), taken first: a spent budget refuses before a link is
      // made or a bearer revealed. The facts (a read) and a link (a write) take their own admissions within it.
      return admitted(actor, "bearer", async () => {
        const fleetType = await fleetTypeOf(fleetIds);
        if ((platform === "kubernetes") !== (fleetType === "kubernetes-supervisor")) throw installPlatformNotSuited();
        const group = await installGroupOf(fleetIds, fleetType, namedGroupId);
        const ids = { ...fleetIds, groupId: group.id.toLowerCase() };
        // What the dialog reads first (D17c-1 Ruling 61): its refusals (archived, unassigned, a version not offered)
        // come before anything is made or revealed.
        const facts = await service.installFacts(actor, ids.organizationId, ids.fleetId, ids.groupId);
        const given = new Set(env.map((variable) => variable.name));
        const notGiven = facts.envVarNames.filter((name) => !given.has(name));
        const reply = { fleetId: ids.fleetId, fleetType, platform, groupId: ids.groupId, groupName: group.name };
        // The reveal's existing metadata gains these two (decision 38): ids and fixed words only.
        const via: Readonly<Record<string, string>> = { via: "public_api_install", platform };
        if (request.platform === "docker") {
          if ("helm" in facts) throw new Error("a server fleet's group answered Helm facts");
          refuseFactsVariables(facts.envVarNames, env);
          const at = now();
          const defaultToken = (await fleetTokens(ids)).find((token) => token.kind === "default" && tokenValidAt(token, at));
          if (defaultToken === undefined) throw enrollmentTokenDefaultMissing();
          const { bearer } = await revealedFor(actor, { ...ids, tokenId: defaultToken.id.toLowerCase() }, via);
          // The facts' order, as the dialog's (an included variable in the facts' order).
          const included = facts.envVarNames.flatMap((name) => env.filter((variable) => variable.name === name));
          const command = containerCommand({ facts, bearer, displayName: request.displayName ?? "", env: included });
          return { ...reply, command, notes: installNotes("docker", notGiven), expiresAt: null };
        }
        if (request.platform === "linux") {
          const { link, url } = await admitted(actor, "write", () =>
            linkCreated(actor, ids, { kind: "linux", method: "all-in-one", arch: request.arch, rootPath: request.rootPath, systemd: request.systemd, env }),
          );
          let bearer: string;
          try {
            ({ bearer } = await revealedFor(actor, { ...ids, tokenId: link.defaultTokenId.toLowerCase() }, via));
          } catch (error) {
            // Ruling 174: no command, so the link just made goes too (a retry after a 503 never piles links toward the cap).
            await linkWithdrawn(actor, { ...ids, linkId: link.id });
            throw error;
          }
          const command = quickDeployCommands({
            url,
            rootPath: request.rootPath,
            bearer,
            displayName: request.displayName ?? "",
            systemd: request.systemd,
          });
          return { ...reply, command, notes: installNotes("linux", notGiven), expiresAt: link.expiresAt };
        }
        if (!("helm" in facts)) throw new Error("a Kubernetes fleet's group answered server facts");
        // Ruling 161: no reveal (the command holds the values link's secret, whose download answers the bearer), so
        // the reveal's audit row is written in the link's own transaction, naming the link's default token.
        const { link, url } = await admitted(actor, "write", () =>
          linkCreated(actor, ids, { kind: "helm", env }, async (transaction, created) => {
            await transaction.audit.record(
              auditEvent(actor, "enrollment_token.revealed", { type: "enrollment_token", id: created.defaultTokenId }, {
                fleetId: ids.fleetId,
                tokenId: created.defaultTokenId,
                kind: "default",
                ...via,
              }),
            );
          }),
        );
        const release = link.choices.kind === "helm" ? link.choices.release : facts.helm.release;
        const namespace = link.choices.kind === "helm" ? link.choices.namespace : facts.helm.namespace;
        const command = helmQuickDeployCommand(url, { release, namespace, chartReference: facts.helm.chartReference, chartVersion: facts.helm.chartVersion });
        return { ...reply, command, notes: installNotes("kubernetes", notGiven), expiresAt: link.expiresAt };
      });
    },

    // -----------------------------------------------------------------------
    // Quick-deploy links (D17c-2 decisions 4 to 7, 10, 11, 22 and 25).

    async createQuickDeployLink(actor, organizationId, fleetIdParam, groupIdParam, request) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), groupId: groupIdOf(groupIdParam) };
      return admitted(actor, "write", () => linkCreated(actor, ids, request));
    },

    async listQuickDeployLinks(actor, organizationId, fleetIdParam, query) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam) };
      // A cursor the list didn't give: the browser's 400, before the limit and any read.
      const after = query.cursor === undefined ? undefined : linksAfterOf(query.cursor);
      return admitted(actor, "read", async () => {
        // One more than the page: whether another follows.
        const rows = await withTransaction(actor.context, (transaction) =>
          transaction.quickDeployLinks.list(ids.fleetId, { limit: query.limit + 1, ...(after === undefined ? {} : { after }) }),
        );
        const page = rows.slice(0, query.limit);
        // An unknown fleet holds no links: no call (ruling 25).
        const names = page.length === 0 ? new Map<string, string>() : await groupNamesOf(ids);
        const at = now();
        const last = page.at(-1);
        return {
          links: page.map((link) => toQuickDeployLinkReply(link, names.get(link.groupId.toLowerCase()) ?? null, at)),
          nextCursor: rows.length > query.limit && last !== undefined ? linksCursorOf(last) : null,
        };
      });
    },

    async extendQuickDeployLink(actor, organizationId, fleetIdParam, linkIdParam, by) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), linkId: linkIdOf(linkIdParam) };
      return admitted(actor, "write", async () => {
        const found = await withTransaction(actor.context, (transaction) => transaction.quickDeployLinks.find(ids.fleetId, ids.linkId));
        if (found === undefined) throw quickDeployLinkNotFound();
        if (found.revokedAt !== null) throw quickDeployLinkRevoked();
        // The reply's group name, read before the write: a 503 here changes nothing.
        const groupName = await groupNameOf({ ...ids, groupId: found.groupId });
        // Counted from now (decision 5, Preflight ruling 25), never from the old expiry.
        const at = now();
        const expiresAt = quickDeployLinkExpiryAfter(by, at);
        // Every extend decided under the cap's lock, in this one transaction: refused when the fleet's OTHER active links
        // are at the cap, normally an expired link's (Rulings 36 and 40).
        const result = await withTransaction(actor.context, async (transaction) => {
          const extended = await transaction.quickDeployLinks.extend(ids.fleetId, ids.linkId, expiresAt, at);
          if (extended.kind === "extended") {
            await transaction.audit.record(
              linkAuditEvent(actor, QUICK_DEPLOY_LINK_EXTENDED, ids.linkId, {
                linkId: ids.linkId,
                fleetId: ids.fleetId,
                by,
                expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
              }),
            );
          }
          return extended;
        });
        switch (result.kind) {
          case "extended":
            return toQuickDeployLinkReply(result.link, groupName, at);
          case "revoked":
            // Revoked between the read and the write.
            throw quickDeployLinkRevoked();
          case "limit_reached":
            throw quickDeployLinkLimitReached();
          case "not_found":
            throw quickDeployLinkNotFound();
        }
      });
    },

    async revokeQuickDeployLink(actor, organizationId, fleetIdParam, linkIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId: actor.context.organizationId, fleetId: fleetIdOf(fleetIdParam), linkId: linkIdOf(linkIdParam) };
      return admitted(actor, "write", async () => {
        // The revoke first (Ruling 36): it stands whatever the opamp-server answers after.
        const at = now();
        const revoked = await withTransaction(actor.context, async (transaction) => {
          const link = await transaction.quickDeployLinks.revoke(ids.fleetId, ids.linkId, actor.context.userId, at);
          // Every revoke asked, a revoked link's again included: the row records the person's request.
          if (link !== undefined) {
            await transaction.audit.record(linkAuditEvent(actor, QUICK_DEPLOY_LINK_REVOKED, ids.linkId, { linkId: ids.linkId, fleetId: ids.fleetId }));
          }
          return link;
        });
        if (revoked === undefined) throw quickDeployLinkNotFound();
        // Then the reply's group name: null when the opamp-server can't give it (the call's failure is
        // logged with the ids), as for a deleted group; the revoke is done either way.
        const groupName = await groupNameOf({ ...ids, groupId: revoked.groupId }).catch(() => null);
        return toQuickDeployLinkReply(revoked, groupName, at);
      });
    },

    async quickDeployBundle(link, openValues) {
      if (deps.withOrganizationTransaction === undefined) throw new Error("quickDeployBundle needs withOrganizationTransaction (the public route's service)");
      const withOrganization = deps.withOrganizationTransaction;
      const { choices } = link;
      if (choices.kind === "helm") throw new Error("a Helm values link renders through quickDeployHelmValues");
      const ids = { organizationId: link.organizationId, fleetId: link.fleetId, groupId: link.groupId, linkId: link.id };
      // The link's organization, no person: the published version read with no viewer (Preflight ruling 9).
      const read: InstallRead = (work) => withOrganization(link.organizationId, work);
      try {
        // The group's CURRENT version, templates and catalogue (decision 6), refused as D17c-1's bundle.
        const { group, version } = await installable(read, ids, "server");
        const offered = new Set(requiredEnvVarNames(version.yaml));
        if (!link.choices.envNames.every((name) => offered.has(name))) throw downloadVariablesChanged();
        // The default token the link's command carries, still valid (decision 6): a revoked one is 410.
        const at = now();
        const tokens = await fleetTokens(ids);
        if (!tokens.some((token) => token.id.toLowerCase() === link.defaultTokenId.toLowerCase() && tokenValidAt(token, at))) {
          throw downloadTokenRevoked();
        }
        let values: EnvValue[];
        try {
          values = openValues(link);
        } catch (error) {
          if (!(error instanceof SealedValuesError)) throw error;
          // The reason only: never a value, a name or a key.
          log.error({ operation: "quickDeployBundle", ...ids, reason: error.reason }, "the quick-deploy link's values can't be opened");
          throw downloadUnavailable();
        }
        try {
          return await renderBundle(
            read,
            ids,
            group,
            version,
            {
              method: choices.method,
              arch: choices.arch,
              rootPath: choices.rootPath,
              ...(choices.executablePath === null ? {} : { executablePath: choices.executablePath }),
              env: values,
            },
            "quickDeployBundle",
          );
        } catch (error) {
          if (!(error instanceof InstallRenderError)) throw error;
          // A refusal by its cause (D17d-2 Rulings 43 and 48), as the Helm values' below: the link's own data (a
          // value stored before Ruling 36's lone-surrogate check, say) at warn; the operator's (the catalogue, the
          // templates, the endpoint, the group's id, the collector version) at error. Ids, the cause and the
          // rule's fixed words only (an InstallRenderError names no value), no stack.
          const fields = { operation: "quickDeployBundle", ...ids, source: error.source, reason: error.message };
          const message = "the quick-deploy link's bundle couldn't be rendered";
          if (error.source === "choices") log.warn(fields, message);
          else log.error(fields, message);
          throw downloadUnavailable();
        }
      } catch (error) {
        throw downloadRefusalOf(error);
      }
    },

    async quickDeployHelmValues(link, openValues) {
      if (deps.withOrganizationTransaction === undefined) {
        throw new Error("quickDeployHelmValues needs withOrganizationTransaction (the public route's service)");
      }
      const withOrganization = deps.withOrganizationTransaction;
      const { choices } = link;
      if (choices.kind !== "helm") throw new Error("a Linux link renders through quickDeployBundle");
      const ids = { organizationId: link.organizationId, fleetId: link.fleetId, groupId: link.groupId, linkId: link.id };
      const read: InstallRead = (work) => withOrganization(link.organizationId, work);
      try {
        // The group's CURRENT version and settings (decision 21), refused as the signed-in Helm install.
        const { group, version } = await installable(read, ids, "helm");
        const facts = helmFactsOf(group, version, install);
        const offered = new Set(facts.envVarNames);
        if (!choices.envNames.every((name) => offered.has(name))) throw downloadVariablesChanged();
        let values: EnvValue[];
        try {
          values = openValues(link);
        } catch (error) {
          if (!(error instanceof SealedValuesError)) throw error;
          // The reason only: never a value, a name or a key.
          log.error({ operation: "quickDeployHelmValues", ...ids, reason: error.reason }, "the quick-deploy link's values can't be opened");
          throw downloadUnavailable();
        }
        // The bearer last, once nothing else can refuse (Preflight ruling 9): each reveal is a `viewed` event.
        const bearer = await revealedBearer(ids, link.defaultTokenId);
        try {
          return helmValuesYaml(helmValuesInputOf(facts, bearer, values));
        } catch (error) {
          // The file holds the bearer: the field only (HelmBuildError names no value), or the error's name, never
          // a stack. The builder's refusal by its cause, as the bundle's above (D17d-2 Rulings 43 and 48): the
          // link's typed variables at warn; the operator's fields (the image, the endpoint, the group's id and
          // settings, the token) at error; anything else, unexpected, at error.
          const message = "the Helm values link's values.yaml couldn't be built";
          if (!(error instanceof HelmBuildError)) log.error({ operation: "quickDeployHelmValues", ...ids, error: errorName(error) }, message);
          else if (error.source === "choices") log.warn({ operation: "quickDeployHelmValues", ...ids, source: error.source, field: error.field }, message);
          else log.error({ operation: "quickDeployHelmValues", ...ids, source: error.source, field: error.field }, message);
          throw downloadUnavailable();
        }
      } catch (error) {
        throw downloadRefusalOf(error);
      }
    },

    async fleetUsage(actor, organizationId, configurationIdParam) {
      assertActiveOrganization(actor, organizationId);
      const configurationId = canonicalIdOf(configurationIdParam);
      if (configurationId === undefined) throw configurationNotFound();
      const ids = { organizationId: actor.context.organizationId, configurationId };
      // Only a configuration the person can see (D11b's draft rules): another member's draft is a 404, with no call.
      const configuration = await withTransaction(actor.context, (transaction) => transaction.configurations.find(configurationId));
      if (configuration === undefined) throw configurationNotFound();
      // Never published: the opamp-server holds nothing of it, so there is nothing to ask (no call, no limit spent).
      if (!configuration.published) return { configurationId: ids.configurationId, inUse: false, publishedVersions: [] };
      return admitted(actor, "read", async () => {
        const result = await call("getConfigurationUsage", ids, () =>
          opampServer.getConfigurationUsage(ids.organizationId, ids.configurationId),
        );
        switch (result.kind) {
          case "found": {
            const { usage } = result;
            const versionOf = await versionsOf(actor, usage.publications.map((publication) => publication.id));
            return {
              configurationId: ids.configurationId,
              inUse: usage.inUse,
              publishedVersions: usage.publications.map((publication) => ({
                publishedVersionId: publication.id,
                publishedAt: publication.publishedAt,
                groups: publication.groups.map((group) => ({ fleetId: group.fleetId, groupId: group.groupId })),
                pinnedCollectors: publication.pinnedCollectors,
                // The platform's version: null for an orphan, where the platform holds no live version recording it.
                version: versionOf(publication.id),
                // The opamp-server's own record of the version, kept beside the platform's: never null.
                recorded: { number: publication.version.number, label: publication.version.label },
              })),
            };
          }
          case "organization_not_found":
            // An organization the opamp-server doesn't know holds no fleets (decision 15).
            return { configurationId: ids.configurationId, inUse: false, publishedVersions: [] };
          default:
            return unavailable("getConfigurationUsage", ids, result);
        }
      });
    },
  };
  return service;
}

/**
 * The public install's notes (D25 decision 37): fixed words for the
 * platform, and the variables the group's published version reads that the
 * request didn't set, by name (the reply only: never a log line).
 */
function installNotes(platform: PublicInstallPlatform, notGiven: readonly string[]): string[] {
  const where = {
    docker: "Run this on the Docker host: the collector joins the fleet's group within a minute.",
    linux: "Run this on the Linux host as a user with sudo. Its install link works for 24 hours.",
    kubernetes: "Run this where helm reaches the cluster, with the rights to install into the namespace. Its values link works for 24 hours.",
  }[platform];
  const notes = [where, "The command holds a secret: keep it out of logs, tickets and chat."];
  if (notGiven.length > 0) {
    notes.push(`The group's published version reads these variables, not set here: ${notGiven.join(", ")}. Set them with env, or on the host before the collector starts.`);
  }
  return notes;
}

/** What an audit row of the fleet routes is about. */
type AuditSubject = { type: "fleet" | "enrollment_token" | typeof QUICK_DEPLOY_LINK_SUBJECT; id: string };

/** An audit row for `actor` in their active organization. */
function auditEvent(actor: Actor, action: string, subject: AuditSubject, metadata: Record<string, unknown>) {
  return {
    action,
    actorUserId: actor.context.userId,
    actorEmail: actor.email,
    organizationId: actor.context.organizationId,
    subjectType: subject.type,
    subjectId: subject.id,
    metadata,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

/** An error's name only: its message could quote anything. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * A Kubernetes group's Helm facts (D17d-2 decision 15; Preflight rulings 1,
 * 3 and 4), for the facts route and the public download alike, from
 * `installable`'s group and version and the settings: the server facts'
 * image, endpoint, insecure flag, collector and id; the version's variables
 * but the chart's own (HELM_CHART_ENV_NAMES); and the Helm install: the
 * chart and its version, the image's repository, the release
 * (`helmReleaseName`), the Agent's and the Cluster's `fullnameOverride` (D18
 * decision 21: `helmFullnameOverride` from the group's fleet id and name;
 * null for a gateway), the role (collectorGroupRole: never the stored one),
 * the namespace, a gateway's replicas (1 when unset; null for the Agent and
 * the Cluster) and the volumes. The Agent before its first save installs
 * with the defaults (telflo-collectors, no volumes). 409
 * `collector_group_settings_unreadable` for settings kubernetesOf can't read,
 * a stored role that isn't the group's, a Cluster or a gateway without
 * settings, or a gateway whose name isn't one (written around the
 * platform): nothing is installed from them.
 */
export function helmFactsOf(group: Opamp.CollectorGroup, version: InstallableVersion, install: InstallSettings): HelmInstallFacts {
  const role = collectorGroupRole(group, "kubernetes-supervisor") ?? "node";
  const { readable, kubernetes } = kubernetesOf(group.annotations);
  if (!readable) throw collectorGroupSettingsUnreadable();
  const settings = kubernetes ?? (role === "node" ? { role, namespace: KUBERNETES_DEFAULT_NAMESPACE, volumes: [] } : undefined);
  if (settings === undefined || settings.role !== role) throw collectorGroupSettingsUnreadable();
  if (role === "gateway" && gatewayNameProblem(group.name) !== null) throw collectorGroupSettingsUnreadable();
  const chartSet = new Set<string>(HELM_CHART_ENV_NAMES);
  return {
    imageTag: `${install.collectorImageRepository}:${version.collectorVersion}`,
    endpoint: install.agentPublicUrl,
    allowInsecureConnections: install.allowInsecureConnections,
    collector: { distribution: version.collectorDistribution, version: version.collectorVersion },
    envVarNames: requiredEnvVarNames(version.yaml).filter((name) => !chartSet.has(name)),
    groupId: group.id,
    helm: {
      chartReference: install.helmChartReference,
      chartVersion: install.helmChartVersion,
      imageRepository: install.collectorImageRepository,
      release: helmReleaseName(role, group.name),
      fullnameOverride: helmFullnameOverride(group.fleetId, role, group.name),
      role,
      namespace: settings.namespace,
      replicas: role === "gateway" ? (settings.replicas ?? 1) : null,
      volumes: settings.volumes.map(({ hostPath, hostPathType, mountPath, readOnly }) => ({ hostPath, hostPathType, mountPath, readOnly })),
    },
  };
}

/** A token valid at `at`: not revoked, and no expiry or one after it (the opamp-server's `Token.ValidAt`). */
function tokenValidAt(token: Pick<Opamp.EnrollmentTokenListed, "revokedAt" | "expiresAt">, at: Date): boolean {
  return token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > at.getTime());
}

/** A link's status at `at` (the API's clock): revoked wins over expired. */
function linkStatusAt(link: StoredQuickDeployLink, at: Date): QuickDeployLinkReply["status"] {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt.getTime() <= at.getTime()) return "expired";
  return "active";
}

/**
 * A link as the routes answer it (Preflight ruling 20): ids, the group's
 * name (null once it is gone), the default token's id, the creator, the
 * choices, the times, the downloads and the status. Each field copied by
 * name: never the hash, the sealed values or a value.
 */
function toQuickDeployLinkReply(link: StoredQuickDeployLink, groupName: string | null, at: Date): QuickDeployLinkReply {
  const { choices } = link;
  return {
    id: link.id,
    groupId: link.groupId,
    groupName,
    defaultTokenId: link.defaultTokenId,
    createdBy: link.createdBy === null ? null : { userId: link.createdBy.userId, email: link.createdBy.email },
    // By kind (D17d-2 Preflight ruling 11): a Linux link's reply never gains `kind`.
    choices:
      choices.kind === "helm"
        ? { kind: "helm", role: choices.role, release: choices.release, namespace: choices.namespace, envNames: [...choices.envNames] }
        : {
            method: choices.method,
            arch: choices.arch,
            rootPath: choices.rootPath,
            executablePath: choices.executablePath,
            systemd: choices.systemd,
            envNames: [...choices.envNames],
          },
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
    revokedAt: link.revokedAt === null ? null : link.revokedAt.toISOString(),
    downloadCount: link.downloadCount,
    lastDownloadedAt: link.lastDownloadedAt === null ? null : link.lastDownloadedAt.toISOString(),
    status: linkStatusAt(link, at),
  };
}

const CURSOR_SEPARATOR = "|";
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The links list's cursor: the last row's (createdAt, id), base64url, opaque to the browser. */
function linksCursorOf(link: Pick<StoredQuickDeployLink, "createdAt" | "id">): string {
  return Buffer.from(`${link.createdAt.toISOString()}${CURSOR_SEPARATOR}${link.id}`, "utf8").toString("base64url");
}

/** Where a page starts, from a cursor the list gave; any other is 400 `invalid_request` naming `cursor`. */
function linksAfterOf(cursor: string): QuickDeployLinksAfter {
  const [createdAt, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split(CURSOR_SEPARATOR);
  if (rest.length > 0 || createdAt === undefined || id === undefined || !CANONICAL_INSTANT.test(createdAt)) throw invalidCursor();
  const at = new Date(createdAt);
  const canonical = canonicalIdOf(id);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== createdAt || canonical === undefined || linksCursorOf({ createdAt: at, id: canonical }) !== cursor) {
    throw invalidCursor();
  }
  return { createdAt: at, id: canonical };
}
