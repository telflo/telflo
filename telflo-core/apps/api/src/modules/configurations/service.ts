import type { ConfigurationsListFilter, ConfigurationVersionsFilter } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { ActorContext } from "../../database/context.js";
import { rateLimited } from "../../http/rate-limits.js";
import { OpampServerMisconfigurationError, type GetConfigurationUsageResult } from "../../opamp-server/client.js";
import type {
  CollectorPin,
  ICollectorCatalogueRepository,
} from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { organizationNotFound } from "../organizations/errors.js";
import { describeResult } from "../organizations/opamp-registration.js";
import type { IMemberRepository, Member } from "../organizations/repositories/member-repository.js";
import type {
  IActiveOrganizationRepository,
  Organization,
} from "../organizations/repositories/organization-repository.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import type { ITestSuiteRepository } from "../test-suites/repositories/test-suite-repository.js";
import type { IValidationPipelineRepository } from "../validation-pipelines/repositories/validation-pipeline-repository.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  collectorDistributionUnknown,
  collectorVersionUnknown,
  configurationDeleteForbidden,
  configurationVersionChangedWhileValidating,
  configurationInUse,
  configurationNotFound,
  configurationVersionNotFound,
  configurationVersionPublished,
  fleetsUnavailableAtDelete,
} from "./errors.js";
import type {
  Configuration,
  ConfigurationChanges,
  IConfigurationRepository,
} from "./repositories/configuration-repository.js";
import type {
  ConfigurationVersion,
  ConfigurationVersionFacts,
  ConfigurationVersionSummary,
  IConfigurationVersionRepository,
  SaveConfigurationVersionInput,
} from "./repositories/configuration-version-repository.js";
import type { IConfigurationVersionSelectionRepository } from "./repositories/configuration-version-selection-repository.js";

/**
 * The repositories a unit of work uses, bound to one transaction that
 * carries the request's database context: the active organization, its
 * members, its configurations, their versions, each person's selected
 * version, the collector catalogue (global), the test suites (a new
 * version's copy of its source's), the validation pipelines (likewise), and
 * the audit trail. The configurations, versions, suites and validation
 * pipelines are the caller's view of them: their own drafts and every
 * published configuration.
 */
export interface ConfigurationTransaction {
  organization: Pick<IActiveOrganizationRepository, "findActiveForShare">;
  members: Pick<IMemberRepository, "find">;
  configurations: IConfigurationRepository;
  versions: IConfigurationVersionRepository;
  selections: IConfigurationVersionSelectionRepository;
  suites: Pick<ITestSuiteRepository, "copyToVersion">;
  validationPipelines: Pick<IValidationPipelineRepository, "copyToVersion">;
  catalogue: Pick<
    ICollectorCatalogueRepository,
    "findDefaults" | "findDistributionDefault" | "isOffered" | "findVersionState"
  >;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithConfigurationTransaction = <Result>(
  context: ActorContext,
  work: (transaction: ConfigurationTransaction) => Promise<Result>,
) => Promise<Result>;

export interface ConfigurationServiceDependencies {
  withTransaction: WithConfigurationTransaction;
  /** Every configuration timestamp comes from here, never SQL `now()`. */
  now: () => Date;
  /**
   * Called once a configuration's soft delete has committed, never when it
   * is refused: schedules the removal of its snapshots from the
   * opamp-server after the response (`createPublicationsCleanup` in
   * publishing.ts). It must not throw or wait: the delete's answer never
   * depends on it.
   */
  afterDelete: (organizationId: string, configurationId: string) => void;
  /**
   * Asks the opamp-server whether a collector group or a collector uses
   * one of the configuration's published versions, for a delete. It
   * spends one read and an in-flight slot of the person's fleet limits in
   * the context's organization (given back before it resolves), or
   * answers `rate_limited` having asked nothing. The service calls it
   * outside any transaction, and only for a published configuration. A
   * misconfiguration (OpampServerMisconfigurationError) rejects, as any
   * other failure of the call does: the service answers each the one 503.
   */
  fleetUsage: (context: ActorContext, configurationId: string) => Promise<FleetUsageAnswer>;
  /** A delete's usage check that failed: ids and the result's kind only. */
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

/**
 * What `fleetUsage` answers: the opamp-server's (in use or not, an
 * organization it doesn't know, or a failure), or the person's fleet limit
 * spent before any call.
 */
export type FleetUsageAnswer = GetConfigurationUsageResult | { kind: "rate_limited"; retryAfterSeconds: number };

export interface ListConfigurationsOptions {
  /** 1 to 100; the contract bounds it. */
  limit: number;
  /** A previous page's `nextCursor`. */
  cursor?: string | undefined;
  /** Trimmed already; empty means no search. */
  search?: string | undefined;
  /** Everything the caller can see, only their own, or only the published. */
  filter: ConfigurationsListFilter;
}

export interface ConfigurationsPage {
  items: Configuration[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export interface CreateConfigurationInput {
  name: string;
  description: string;
  /**
   * The distribution it is built for; left out, the catalogue's default.
   */
  collectorDistribution?: string | undefined;
  /**
   * Version 1's content, exactly as the browser built it from a flow: the
   * text and the graph together. Left out, version 1 holds `''` and the
   * table's empty graph.
   */
  content?: SaveConfigurationVersionInput | undefined;
  /**
   * Version 1's collector version: one the distribution offers and hasn't
   * deprecated, else 400 `collector_version_unknown`; left out, the
   * distribution's default.
   */
  collectorVersion?: string | undefined;
  /** The flow it was made from: stored, never answered. */
  sourceFlowSlug?: string | undefined;
}

/**
 * What a save asks for, as the contract parses it: the content, and the
 * collector version, left out to keep the one stored.
 */
export interface SaveVersionInput extends SaveConfigurationVersionInput {
  collectorVersion?: string | undefined;
}

/**
 * A configuration, the version the editor opens, and every version's
 * summary, highest number first.
 */
export interface ConfigurationWithVersion {
  configuration: Configuration;
  version: ConfigurationVersion;
  versions: ConfigurationVersionSummary[];
}

/**
 * What a create asks for, as the contract parses it: the content the editor
 * holds, the version it was made from, and a label, trimmed already, or none.
 */
export interface NewConfigurationVersionInput extends SaveConfigurationVersionInput {
  /** Any string: one that isn't a canonical UUID is 404 configuration_version_not_found. */
  sourceVersionId: string;
  /** Trimmed, 1 to 80 characters; undefined for none. */
  label?: string | undefined;
  /**
   * The new version's collector version: left out, the source's saved one;
   * else the save's rule against the source's.
   */
  collectorVersion?: string | undefined;
}

/** What a change asks for, as the contract parses it: a field left out stays as it is. */
export interface ConfigurationUpdate {
  name?: string | undefined;
  description?: string | undefined;
}

/**
 * A configuration with what the public API answers of its versions: its latest
 * version's number and pin, and its highest published number.
 */
export interface ConfigurationWithFacts {
  configuration: Configuration;
  facts: ConfigurationVersionFacts;
}

/** A page of configurations with their versions' facts (the public list). */
export interface ConfigurationsWithFactsPage {
  items: ConfigurationWithFacts[];
  /** Null on the last page. */
  nextCursor: string | null;
}

/** A configuration with its facts and its latest version's YAML (the public read). */
export interface ConfigurationDetail extends ConfigurationWithFacts {
  /** The latest version's text, exactly as saved. Never logged. */
  yamlContent: string;
}

/** What the public API's version append asks for: the text, and a label or none. */
export interface AppendConfigurationVersionInput {
  yamlContent: string;
  /** Trimmed, 1 to 80 characters; undefined for none. */
  label?: string | undefined;
}

/**
 * What the public API's version PATCH merges over a draft: a field left out
 * keeps the one stored; the graph is always the stored one.
 */
export interface PatchConfigurationVersionInput {
  yamlContent?: string | undefined;
  collectorVersion?: string | undefined;
  /**
   * The version's `updatedAt` as the caller read it for its validation:
   * a save since is 409 `configuration_version_changed`, and
   * nothing is written, so the text validated is the text saved. Left out,
   * the merge writes over whatever is saved.
   */
  expectedUpdatedAt?: Date | undefined;
}

/**
 * A configuration with its facts, whether it is published read from the
 * facts: the list's row and the facts are two statements, so the facts'
 * highest published number is the one answer for both fields.
 */
function withFacts(configuration: Configuration, facts: ConfigurationVersionFacts): ConfigurationWithFacts {
  return { configuration: { ...configuration, published: facts.publishedVersionNumber !== null }, facts };
}

export interface IConfigurationService {
  /** A page of the active organization's live configurations. No lock. */
  list(actor: Actor, organizationId: string, options: ListConfigurationsOptions): Promise<ConfigurationsPage>;
  /**
   * The live configuration, the version the editor opens, and every
   * version's summary. The version is the caller's selection when it names
   * a version of this live configuration, else the highest
   * `version_number`. Another person's selection never counts. No lock.
   */
  get(actor: Actor, organizationId: string, configurationId: string): Promise<ConfigurationWithVersion>;
  /**
   * The live configuration, that version of it, and every version's summary.
   * No lock. 404 `configuration_version_not_found` for a version that isn't
   * this live configuration's, malformed ids included.
   */
  getVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
  ): Promise<ConfigurationWithVersion>;
  /**
   * The live configuration's versions' summaries, highest number first,
   * without content or layout (the route answers only their ids, numbers,
   * labels and published dates): every one the caller can see, or only the
   * published ones (`published`, possibly none). The configuration's read's
   * visibility and refusals: 404 `configuration_not_found` for one the caller
   * can't see (another organization's, another member's draft-only one, a
   * deleted, unknown or malformed one). No lock.
   */
  listVersions(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    filter: ConfigurationVersionsFilter,
  ): Promise<ConfigurationVersionSummary[]>;
  /**
   * A new configuration, created by the caller, with its version 1 holding
   * empty YAML, or the content given, exactly as given, built for the
   * distribution named or the catalogue's default, its version 1 at that
   * distribution's default version or the collector version given. A
   * distribution the catalogue doesn't offer is 400
   * `collector_distribution_unknown`; then a collector version it doesn't
   * offer, or has deprecated, is 400 `collector_version_unknown`. Either
   * refusal writes nothing. A graph the table's checks refuse rejects with
   * the database's 23514, and nothing is written. The flow's slug, when
   * given, is stored on the configuration. The audit row names only the
   * name.
   */
  create(actor: Actor, organizationId: string, input: CreateConfigurationInput): Promise<Configuration>;
  /**
   * Changes the fields given. None given, or none different from what is
   * there, changes and audits nothing, and answers the configuration as it
   * is.
   */
  update(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    changes: ConfigurationUpdate,
  ): Promise<Configuration>;
  /**
   * Deletes it softly. Only its author or an organization admin may: anyone
   * else is 403 `configuration_delete_forbidden`, after the 404 for one
   * they can't see. A published one only when no fleet uses it: 409
   * `configuration_in_use`, 429 `rate_limited` (the person's fleet limit),
   * or 503 `fleets_unavailable` (the usage couldn't be read), each deleting
   * nothing.
   */
  remove(actor: Actor, organizationId: string, configurationId: string): Promise<void>;
  /**
   * Saves the YAML over the version, exactly as given, with the builder's
   * graph, and moves the configuration's `updated_at`. It writes even when
   * both are the ones already there: the client sends only when it is dirty.
   * The last save wins. The version's `updatedAt` moves strictly forward: the
   * clock's, or a millisecond past its last save's when the clock hasn't
   * passed it. A graph the table's checks refuse rejects with the database's
   * 23514, and nothing is written. A published version is 409
   * `configuration_version_published`, and nothing is written, the collector
   * version included. A collector version left out keeps the one stored; the
   * one stored is always accepted, even if deprecated since; a change must
   * name a version the configuration's distribution offers, else 400
   * `collector_version_unknown`, and nothing is written. A save that changes
   * only the pin is an ordinary save.
   */
  saveVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    content: SaveVersionInput,
  ): Promise<ConfigurationVersion>;
  /**
   * The configuration's next version, numbered the highest plus one under
   * the configuration's lock, holding the content given, created by the
   * caller. The source must be a version of this live configuration; it is
   * left as it was, and named in the audit row. Moves the configuration's
   * `updated_at`. A graph the table's checks refuse rejects with the
   * database's 23514, and nothing is written. It is built for the
   * configuration's distribution, at the source's saved collector version
   * or the one given, by the save's rule against the source's. The source's
   * test suites and their definitions are copied to it in the same
   * transaction, in order, sharing their inputs, the caller their creator;
   * its runs are not.
   */
  createVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    input: NewConfigurationVersionInput,
  ): Promise<ConfigurationVersion>;
  /**
   * Sets the version's label, moving neither its `updated_at` nor the
   * configuration's. The same label as the one there writes and audits
   * nothing, and answers the summary as it is. A published version is 409
   * `configuration_version_published`, whatever the label.
   */
  renameVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    label: string,
  ): Promise<ConfigurationVersionSummary>;
  /**
   * The public API's list: `list`'s page, every configuration the caller
   * can see, with each one's version facts read in the same transaction by
   * one statement.
   */
  listWithFacts(
    actor: Actor,
    organizationId: string,
    options: Pick<ListConfigurationsOptions, "limit" | "cursor">,
  ): Promise<ConfigurationsWithFactsPage>;
  /**
   * The public API's read of one configuration: the live configuration the
   * caller can see, its version facts and its latest version's YAML (the
   * highest number; a selection never counts). 404
   * `configuration_not_found` otherwise, a malformed id included. No lock.
   */
  getDetail(actor: Actor, organizationId: string, configurationId: string): Promise<ConfigurationDetail>;
  /**
   * The id of the live configuration's version numbered `versionNumber`:
   * 404 `configuration_not_found` for a configuration the caller can't see
   * (a malformed id included), then 404 `configuration_version_not_found`
   * for a number it has no version of. No lock: a version is never deleted
   * on its own, so the id stays its.
   */
  versionIdOf(actor: Actor, organizationId: string, configurationId: string, versionNumber: number): Promise<string>;
  /**
   * `createVersion` from the configuration's latest version, read under its
   * lock: the latest's pin, its suites and validation pipelines copied, and
   * the text given with an empty graph (the web rebuilds it from the text).
   */
  appendVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    input: AppendConfigurationVersionInput,
  ): Promise<ConfigurationVersion>;
  /**
   * `saveVersion` with the stored content merged under the configuration's
   * lock: the text given or the stored one, the stored graph, and the pin
   * given or the stored one, by `saveVersion`'s rules (a published version
   * 409, a pin change the distribution doesn't offer 400). Neither field
   * given changes, writes and audits nothing, and answers the version as it
   * is, still 409 for a published one.
   */
  patchVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    input: PatchConfigurationVersionInput,
  ): Promise<ConfigurationVersion>;
  /**
   * Records the version as the caller's selection of the configuration,
   * which `get` then opens for them alone. Not audited.
   */
  selectVersion(actor: Actor, organizationId: string, configurationId: string, versionId: string): Promise<void>;
}

/** An audit row about `configurationId`, in the active organization. */
export function auditEvent(
  actor: Actor,
  configurationId: string,
  action: string,
  metadata: Record<string, unknown>,
): AuditEvent {
  return {
    action,
    actorUserId: actor.context.userId,
    actorEmail: actor.email,
    organizationId: actor.context.organizationId,
    subjectType: "configuration",
    subjectId: configurationId,
    metadata,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

/**
 * First in every write: the organization locked `for share`,
 * which must be live, then the caller's membership re-read, which must be
 * live, both under that lock. A removal and an organization delete lock
 * the organization `for no key update` first, so they wait for a write
 * under way, or the write waits for them and then finds the membership or
 * the organization gone: 404 `organization_not_found` either way, as a
 * path naming another organization is. `for share` doesn't block other
 * members' writes, which take the same lock.
 *
 * `members.find` ignores a deleted account as well as a removed membership.
 * Both are returned, as read under the lock: the membership's role is the
 * one a delete checks, never the request's, and the organization's name is
 * the one a publish registers.
 */
export async function lockAsMember(
  transaction: Pick<ConfigurationTransaction, "organization" | "members">,
  actor: Actor,
): Promise<{ organization: Organization; member: Member }> {
  const organization = await transaction.organization.findActiveForShare();
  if (!organization) throw organizationNotFound();
  const member = await transaction.members.find(actor.context.userId);
  if (!member || member.deletedAt !== null) throw organizationNotFound();
  return { organization, member };
}

/**
 * A configuration's delete is its author's, or an admin's by the role re-read
 * under the organization's lock, else 403. A configuration whose author's
 * account is gone has no author, so only an admin deletes it.
 */
function assertMayDelete(actor: Actor, member: Member, createdByUserId: string | null): void {
  const isAuthor = createdByUserId !== null && createdByUserId === actor.context.userId;
  if (!isAuthor && member.role !== "admin") throw configurationDeleteForbidden();
}

/**
 * The configuration a change, a save or a delete names, locked `for
 * update` after the organization (the lock order: organization, then
 * configuration), so any two of them have exactly one order. 404 for an
 * id that isn't a canonical UUID, and for one that is missing, deleted,
 * another organization's or another member's draft: the repository reads
 * through the organization scope, as the caller, and skips deleted rows.
 */
export async function lockedConfiguration(
  transaction: { configurations: Pick<IConfigurationRepository, "lockForUpdate"> },
  id: string | undefined,
) {
  const locked = id === undefined ? undefined : await transaction.configurations.lockForUpdate(id);
  if (!locked) throw configurationNotFound();
  return locked;
}

/**
 * The collector version a write leaves a version at: `requested` when it names
 * one, else `current`. The current one is always accepted, even if the
 * catalogue deprecated it since (a pin is never changed silently, and keeping
 * it is no change); a change must name a version `distribution` offers, else
 * 400 `collector_version_unknown`.
 */
async function collectorVersionFor(
  transaction: ConfigurationTransaction,
  distribution: string,
  current: string,
  requested: string | undefined,
): Promise<string> {
  if (requested === undefined || requested === current) return current;
  if (!(await transaction.catalogue.isOffered(distribution, requested))) throw collectorVersionUnknown();
  return requested;
}

/**
 * The distribution a create builds a configuration for and its version 1's
 * collector version: the one named at its default version, else the
 * catalogue's defaults. One the catalogue doesn't offer is 400
 * `collector_distribution_unknown`.
 */
async function collectorPinFor(
  transaction: ConfigurationTransaction,
  distribution: string | undefined,
): Promise<CollectorPin> {
  if (distribution === undefined) return transaction.catalogue.findDefaults();
  const pin = await transaction.catalogue.findDistributionDefault(distribution);
  if (!pin) throw collectorDistributionUnknown();
  return pin;
}

/**
 * Every member may do everything here to a configuration they can see
 * (their own drafts, every published one), whatever their role, but two
 * things: only its author or an admin deletes it, and nobody changes a
 * published version. Another member's draft is 404 everywhere, as if it
 * didn't exist.
 */
export function createConfigurationService(deps: ConfigurationServiceDependencies): IConfigurationService {
  const { withTransaction, now, afterDelete, fleetUsage, log } = deps;

  /**
   * A published configuration's delete asks the opamp-server first, outside
   * any transaction, whether a collector group or a collector (archived
   * fleets' included) uses one of its published versions. In use: 409. An
   * organization the opamp-server doesn't know holds nothing there, so nothing
   * of it is in use (a delete never registers it). The person's fleet limit
   * spent: 429. Anything else, a throw included: 503 with the delete's own
   * words, logged with the ids and the result's kind (a misconfiguration's
   * message, any other throw's name only), never a body or a URL. Each refusal
   * deletes nothing. An assignment landing after this answer and before the
   * delete commits is an accepted residue: the clean-up then keeps the
   * published versions with its `in_use` warning.
   */
  async function refuseWhileInUse(actor: Actor, configurationId: string): Promise<void> {
    const ids = { operation: "getConfigurationUsage", organizationId: actor.context.organizationId, configurationId };
    let answer: FleetUsageAnswer;
    try {
      answer = await fleetUsage(actor.context, configurationId);
    } catch (error) {
      if (error instanceof OpampServerMisconfigurationError) {
        log.error(
          { ...ids, error: error.message },
          "a configuration's delete couldn't check its fleet usage: the opamp-server's settings are wrong, or its answer isn't the API's",
        );
        throw fleetsUnavailableAtDelete();
      }
      // Any other throw is the one 503 too: its name only, since its message
      // could quote anything.
      log.error(
        { ...ids, error: error instanceof Error ? error.name : typeof error },
        "a configuration's delete couldn't check its fleet usage: asking the opamp-server failed",
      );
      throw fleetsUnavailableAtDelete();
    }
    switch (answer.kind) {
      case "found":
        if (answer.usage.inUse) throw configurationInUse();
        return;
      case "organization_not_found":
        return;
      case "rate_limited":
        throw rateLimited(answer.retryAfterSeconds);
      default: {
        const fields = { ...ids, ...describeResult(answer) };
        if (answer.kind === "unavailable") log.warn(fields, "a configuration's delete couldn't check its fleet usage: the opamp-server couldn't be asked");
        else log.error(fields, "a configuration's delete couldn't check its fleet usage: the opamp-server's answer wasn't one the platform expected");
        throw fleetsUnavailableAtDelete();
      }
    }
  }

  /**
   * Every version's summary of the live configuration, read last in a read:
   * empty only if the configuration was deleted since it was read, which is
   * then 404 as a read after the delete is.
   */
  async function summariesOf(transaction: ConfigurationTransaction, id: string) {
    const versions = await transaction.versions.listSummaries(id);
    if (versions.length === 0) throw configurationNotFound();
    return versions;
  }

  /** What a version's write sends: the whole content (the browser's save), or fields to merge (the public PATCH). */
  type VersionWrite = { kind: "save"; content: SaveVersionInput } | { kind: "patch"; change: PatchConfigurationVersionInput };

  /** `saveVersion` and `patchVersion`: the one write of a version's content, under the configuration's lock. */
  async function writeVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    write: VersionWrite,
  ): Promise<ConfigurationVersion> {
    assertActiveOrganization(actor, organizationId);
    const id = canonicalIdOf(configurationId);
    const canonicalVersionId = canonicalIdOf(versionId);
    return withTransaction(actor.context, async (transaction) => {
      await lockAsMember(transaction, actor);
      // The version is written under the configuration's lock, so a save and
      // a delete of it have exactly one order. So is a publish's record, so
      // the check below holds until this transaction ends.
      const current = await lockedConfiguration(transaction, id);
      // A version is found only through its configuration: one of another
      // configuration, an unknown one and a malformed id are all this 404.
      // A save's summary, without the content, says whether it is
      // published; a patch merges over the stored content, so reads it
      // whole, under the same lock.
      let existing: ConfigurationVersionSummary | undefined;
      let stored: ConfigurationVersion | undefined;
      if (canonicalVersionId !== undefined) {
        if (write.kind === "save") existing = await transaction.versions.findSummary(current.id, canonicalVersionId);
        else existing = stored = await transaction.versions.find(current.id, canonicalVersionId);
      }
      if (!existing) throw configurationNotFound();
      // Before the write, so the immutability trigger is never what refuses
      // it.
      if (existing.publishedAt !== null) throw configurationVersionPublished();
      let content: SaveVersionInput;
      if (write.kind === "save") {
        content = write.content;
      } else {
        // Read whole above: a patch's version is never only a summary.
        if (stored === undefined) throw configurationNotFound();
        const { yamlContent, collectorVersion, expectedUpdatedAt } = write.change;
        // Saved since the caller validated it; to the millisecond, as a publish's check.
        if (expectedUpdatedAt !== undefined && stored.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw configurationVersionChangedWhileValidating();
        }
        // Nothing to merge: the version as it is, nothing written or audited.
        if (yamlContent === undefined && collectorVersion === undefined) return stored;
        content = {
          yamlContent: yamlContent ?? stored.yamlContent,
          // The stored graph, unchanged: the web lays it out again from the text.
          nodes: stored.nodes,
          edges: stored.edges,
          pipelines: stored.pipelines,
          collectorVersion,
        };
      }
      // After the published check, so a pin's change on a published version
      // is 409 like any other change.
      const collectorVersion = await collectorVersionFor(
        transaction,
        current.collectorDistribution,
        existing.collectorVersion,
        content.collectorVersion,
      );
      const at = now();
      // Every save moves the version's `updated_at` strictly forward, to the
      // clock or a millisecond past the last save, whichever is later. A
      // publish refuses a save the caller's tab didn't see by comparing
      // `updated_at` to the millisecond; two saves serialized by this lock can
      // read the same millisecond from the clock, and a tab holding the
      // first's would then pass after the second. The previous value is read
      // under the configuration's lock, which every save holds, so none comes
      // between. The configuration's `updated_at` keeps the clock's.
      const savedAt = new Date(Math.max(at.getTime(), existing.updatedAt.getTime() + 1));
      const version = await transaction.versions.save(
        current.id,
        existing.id,
        {
          yamlContent: content.yamlContent,
          nodes: content.nodes,
          edges: content.edges,
          pipelines: content.pipelines,
          // Only a change is written: the one stored stays as it is.
          ...(collectorVersion !== existing.collectorVersion && { collectorVersion }),
        },
        savedAt,
      );
      // Live under the lock just taken: these can't miss.
      if (!version) throw configurationNotFound();
      if (!(await transaction.configurations.touch(current.id, at))) throw configurationNotFound();
      // Never the YAML, which can hold secrets, nor the graph, whose nodes
      // hold copies of it.
      await transaction.audit.record(
        auditEvent(actor, current.id, "configuration.version_saved", {
          versionId: version.id,
          versionNumber: version.versionNumber,
        }),
      );
      return version;
    });
  }

  /**
   * `createVersion` and `appendVersion`: the configuration's next version,
   * from the source named (the browser's) or its latest (the public API's).
   */
  async function createNextVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    input: Omit<NewConfigurationVersionInput, "sourceVersionId">,
    from: { versionId: string } | { latest: true },
  ): Promise<ConfigurationVersion> {
    assertActiveOrganization(actor, organizationId);
    const id = canonicalIdOf(configurationId);
    const sourceVersionId = "versionId" in from ? canonicalIdOf(from.versionId) : undefined;
    return withTransaction(actor.context, async (transaction) => {
      await lockAsMember(transaction, actor);
      // The number is taken under the configuration's lock, so two creates
      // have exactly one order and never the same number, and a create and a
      // delete have one order too.
      const current = await lockedConfiguration(transaction, id);
      // The source must be a version of this live configuration; its
      // content isn't read from it, the editor sends it, so its summary is
      // enough. The public API's append takes the latest, read under the
      // same lock: every live configuration has its version 1, so there is
      // one.
      const source =
        "versionId" in from
          ? sourceVersionId === undefined
            ? undefined
            : await transaction.versions.findSummary(current.id, sourceVersionId)
          : (await transaction.versions.listSummaries(current.id))[0];
      if (!source) throw configurationVersionNotFound();
      // The source's saved pin, or the one the editor holds for it, by the
      // save's rule against the source's.
      const collectorVersion = await collectorVersionFor(
        transaction,
        current.collectorDistribution,
        source.collectorVersion,
        input.collectorVersion,
      );
      const at = now();
      const version = await transaction.versions.createNext({
        configurationId: current.id,
        label: input.label ?? null,
        yamlContent: input.yamlContent,
        nodes: input.nodes,
        edges: input.edges,
        pipelines: input.pipelines,
        createdByUserId: actor.context.userId,
        // The configuration's distribution, read under its lock: the server
        // stamps it, never the client.
        collectorDistribution: current.collectorDistribution,
        collectorVersion,
        at,
      });
      // Live under the lock just taken: these can't miss.
      if (!version) throw configurationNotFound();
      if (!(await transaction.configurations.touch(current.id, at))) throw configurationNotFound();
      // The source's suites and definitions, under the configuration's lock
      // just taken (which also serializes the inputs' reference count), as
      // the caller, at the version's time. A failure after this rolls them
      // back with the version.
      const copied = await transaction.suites.copyToVersion(current.id, source.id, version.id, at);
      // The source's validation pipelines and their rules, likewise, in
      // the source's order, those whose YAML pipeline has left the text
      // too.
      const copiedValidation = await transaction.validationPipelines.copyToVersion(current.id, source.id, version.id, at);
      // Never the YAML, nor the graph, nor the label; never a suite's, a
      // definition's or a rule's text: counts only.
      await transaction.audit.record(
        auditEvent(actor, current.id, "configuration.version_created", {
          versionId: version.id,
          versionNumber: version.versionNumber,
          sourceVersionId: source.id,
          copiedSuites: copied.suites,
          copiedDefinitions: copied.definitions,
          copiedValidationPipelines: copiedValidation.pipelines,
          copiedValidationRules: copiedValidation.rules,
        }),
      );
      return version;
    });
  }

  return {
    async list(actor: Actor, organizationId: string, options: ListConfigurationsOptions): Promise<ConfigurationsPage> {
      assertActiveOrganization(actor, organizationId);
      const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      const search = options.search === undefined || options.search === "" ? undefined : options.search;
      const page = await withTransaction(actor.context, (transaction) =>
        transaction.configurations.listPage({
          limit: options.limit,
          ...(after === undefined ? {} : { after }),
          ...(search === undefined ? {} : { search }),
          filter: options.filter,
        }),
      );
      const last = page.items.at(-1);
      return {
        items: page.items,
        nextCursor: page.hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      };
    },

    async get(actor: Actor, organizationId: string, configurationId: string): Promise<ConfigurationWithVersion> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      return withTransaction(actor.context, async (transaction) => {
        const configuration = await transaction.configurations.find(id);
        if (!configuration) throw configurationNotFound();
        // The caller's own selection only: the repository filters by the
        // person. It names a version of this configuration (the composite
        // foreign key), so the read misses only if the configuration was
        // deleted meanwhile, and then the highest misses too.
        const selectedId = await transaction.selections.find(actor.context.userId, id);
        const selected = selectedId === undefined ? undefined : await transaction.versions.find(id, selectedId);
        // Missing only if the configuration was deleted since the read above:
        // every configuration has a version 1.
        const version = selected ?? (await transaction.versions.findOpened(id));
        if (!version) throw configurationNotFound();
        return { configuration, version, versions: await summariesOf(transaction, id) };
      });
    },

    async getVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
    ): Promise<ConfigurationWithVersion> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      const canonicalVersionId = canonicalIdOf(versionId);
      return withTransaction(actor.context, async (transaction) => {
        // The configuration first, so a deleted one is configuration_not_found
        // whatever the version.
        const configuration = await transaction.configurations.find(id);
        if (!configuration) throw configurationNotFound();
        const version =
          canonicalVersionId === undefined ? undefined : await transaction.versions.find(id, canonicalVersionId);
        if (!version) throw configurationVersionNotFound();
        return { configuration, version, versions: await summariesOf(transaction, id) };
      });
    },

    async listVersions(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      filter: ConfigurationVersionsFilter,
    ): Promise<ConfigurationVersionSummary[]> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      return withTransaction(actor.context, async (transaction) => {
        // The configuration first, as its read: one the caller can't see is
        // 404 whatever its versions.
        if (!(await transaction.configurations.find(id))) throw configurationNotFound();
        if (filter === "all") return summariesOf(transaction, id);
        // None published is an empty list, not a refusal.
        return transaction.versions.listSummaries(id, { publishedOnly: true });
      });
    },

    async create(actor: Actor, organizationId: string, input: CreateConfigurationInput): Promise<Configuration> {
      assertActiveOrganization(actor, organizationId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        const at = now();
        // The distribution named at its default version, or the catalogue's
        // default distribution and its default version, read in this
        // transaction: one default, the catalogue's, never a constant.
        const pin = await collectorPinFor(transaction, input.collectorDistribution);
        // A collector version given is checked against that distribution,
        // before anything is written: the default is accepted as it is, any
        // other must be offered and not deprecated (the save's rule, with
        // the default as the current one).
        const collectorVersion = await collectorVersionFor(
          transaction,
          pin.distribution,
          pin.version,
          input.collectorVersion,
        );
        const configuration = await transaction.configurations.create({
          name: input.name,
          description: input.description,
          createdByUserId: actor.context.userId,
          collectorDistribution: pin.distribution,
          ...(input.sourceFlowSlug !== undefined && { sourceFlowSlug: input.sourceFlowSlug }),
          at,
        });
        // In the same transaction, so a configuration never lacks its
        // content. A flow's content is written exactly as given; without one,
        // version 1 holds `''`, the graph the table's `[]`.
        const { content } = input;
        await transaction.versions.create({
          configurationId: configuration.id,
          versionNumber: 1,
          yamlContent: content === undefined ? "" : content.yamlContent,
          ...(content !== undefined && {
            graph: { nodes: content.nodes, edges: content.edges, pipelines: content.pipelines },
          }),
          createdByUserId: actor.context.userId,
          collectorDistribution: pin.distribution,
          collectorVersion,
          at,
        });
        // The name alone: never the text nor the graph. The flow's slug is on
        // the row.
        await transaction.audit.record(
          auditEvent(actor, configuration.id, "configuration.created", { name: configuration.name }),
        );
        return configuration;
      });
    },

    async update(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      changes: ConfigurationUpdate,
    ): Promise<Configuration> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        const current = await lockedConfiguration(transaction, id);
        // Only the fields that differ from what is there.
        const from: ConfigurationChanges = {};
        const to: ConfigurationChanges = {};
        if (changes.name !== undefined && changes.name !== current.name) {
          from.name = current.name;
          to.name = changes.name;
        }
        if (changes.description !== undefined && changes.description !== current.description) {
          from.description = current.description;
          to.description = changes.description;
        }
        if (Object.keys(to).length === 0) {
          // Nothing to change: the configuration as it is, with its
          // creator's email, which the lock's read leaves out. Live under
          // the lock just taken, so this can't miss.
          const unchanged = await transaction.configurations.find(current.id);
          if (!unchanged) throw configurationNotFound();
          return unchanged;
        }
        const updated = await transaction.configurations.update(current.id, to, now());
        // Live under the lock just taken: this can't miss.
        if (!updated) throw configurationNotFound();
        await transaction.audit.record(auditEvent(actor, current.id, "configuration.updated", { from, to }));
        return updated;
      });
    },

    async remove(actor: Actor, organizationId: string, configurationId: string): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      // The rights first, in a short transaction committed before any call
      // (no lock is held across one), with whether any of its versions is
      // published.
      const isPublished = await withTransaction(actor.context, async (transaction) => {
        const { member } = await lockAsMember(transaction, actor);
        const current = id === undefined ? undefined : await transaction.configurations.find(id);
        if (!current) throw configurationNotFound();
        assertMayDelete(actor, member, current.createdBy?.userId ?? null);
        return current.published;
      });
      // Only a published one can be in use: a draft never calls.
      if (isPublished && id !== undefined) await refuseWhileInUse(actor, id);
      const deletedId = await withTransaction(actor.context, async (transaction) => {
        const { member } = await lockAsMember(transaction, actor);
        // 404 first: a configuration the caller can't see doesn't exist for
        // them, so it is never 403.
        const current = await lockedConfiguration(transaction, id);
        // The rights re-checked under the locks: the role, or the
        // configuration, may have changed since the first read.
        assertMayDelete(actor, member, current.createdByUserId);
        // Live under the lock just taken: this can't miss.
        if (!(await transaction.configurations.markDeleted(current.id, now()))) throw configurationNotFound();
        await transaction.audit.record(auditEvent(actor, current.id, "configuration.deleted", { name: current.name }));
        return current.id;
      });
      // After the commit, the other way round from a publish: a failure here only ever leaves orphaned snapshots.
      afterDelete(organizationId, deletedId);
    },

    async saveVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
      content: SaveVersionInput,
    ): Promise<ConfigurationVersion> {
      return writeVersion(actor, organizationId, configurationId, versionId, { kind: "save", content });
    },

    async createVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      input: NewConfigurationVersionInput,
    ): Promise<ConfigurationVersion> {
      const { sourceVersionId, ...content } = input;
      return createNextVersion(actor, organizationId, configurationId, content, { versionId: sourceVersionId });
    },

    async renameVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
      label: string,
    ): Promise<ConfigurationVersionSummary> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      const canonicalVersionId = canonicalIdOf(versionId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        // Under the configuration's lock, so a rename and a delete have
        // exactly one order.
        const current = await lockedConfiguration(transaction, id);
        // Its summary: the old label, without the content.
        const existing =
          canonicalVersionId === undefined
            ? undefined
            : await transaction.versions.findSummary(current.id, canonicalVersionId);
        if (!existing) throw configurationVersionNotFound();
        // A published version's label is fixed, so even its own label is
        // refused, before anything is written.
        if (existing.publishedAt !== null) throw configurationVersionPublished();
        // The same label: nothing to write or audit, as for a configuration's
        // change.
        const from = existing.label;
        if (from === label) return existing;
        const renamed = await transaction.versions.rename(current.id, existing.id, label);
        // Live under the lock just taken: this can't miss.
        if (!renamed) throw configurationVersionNotFound();
        await transaction.audit.record(
          auditEvent(actor, current.id, "configuration.version_renamed", {
            versionId: renamed.id,
            versionNumber: renamed.versionNumber,
            from,
            to: renamed.label,
          }),
        );
        return renamed;
      });
    },

    async listWithFacts(
      actor: Actor,
      organizationId: string,
      options: Pick<ListConfigurationsOptions, "limit" | "cursor">,
    ): Promise<ConfigurationsWithFactsPage> {
      assertActiveOrganization(actor, organizationId);
      const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      const page = await withTransaction(actor.context, async (transaction) => {
        const listed = await transaction.configurations.listPage({
          limit: options.limit,
          ...(after === undefined ? {} : { after }),
          filter: "all",
        });
        // One statement for the page, in the same transaction.
        const facts = await transaction.versions.listFacts(listed.items.map((configuration) => configuration.id));
        return { ...listed, facts };
      });
      // Every live configuration has its version 1: one is missing only if
      // it was deleted between the two statements, and then it is left out,
      // as a list read after the delete would. Whether it is published is
      // the facts': one snapshot, so `isPublished` and
      // `publishedVersionNumber` always agree.
      const items = page.items.flatMap((configuration) => {
        const facts = page.facts.get(configuration.id);
        return facts === undefined ? [] : [withFacts(configuration, facts)];
      });
      const last = page.items.at(-1);
      return {
        items,
        nextCursor: page.hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      };
    },

    async getDetail(actor: Actor, organizationId: string, configurationId: string): Promise<ConfigurationDetail> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      return withTransaction(actor.context, async (transaction) => {
        const configuration = await transaction.configurations.find(id);
        if (!configuration) throw configurationNotFound();
        // The facts first, then the text of the version they name as the
        // latest, so the two agree even when a version is added meanwhile.
        const facts = (await transaction.versions.listFacts([id])).get(id);
        const latest = facts === undefined ? undefined : await transaction.versions.find(id, facts.latestVersionId);
        // Missing only if the configuration was deleted since the read above.
        if (facts === undefined || latest === undefined) throw configurationNotFound();
        return { ...withFacts(configuration, facts), yamlContent: latest.yamlContent };
      });
    },

    async versionIdOf(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionNumber: number,
    ): Promise<string> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      return withTransaction(actor.context, async (transaction) => {
        // The configuration first, as getVersion's: one the caller can't see
        // is configuration_not_found whatever the number.
        if (!(await transaction.configurations.find(id))) throw configurationNotFound();
        const versionId = await transaction.versions.findIdByNumber(id, versionNumber);
        if (versionId === undefined) throw configurationVersionNotFound();
        return versionId;
      });
    },

    async appendVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      input: AppendConfigurationVersionInput,
    ): Promise<ConfigurationVersion> {
      // An empty graph: the web lays the version out from its text.
      return createNextVersion(
        actor,
        organizationId,
        configurationId,
        { yamlContent: input.yamlContent, label: input.label, nodes: [], edges: [], pipelines: [] },
        { latest: true },
      );
    },

    async patchVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
      input: PatchConfigurationVersionInput,
    ): Promise<ConfigurationVersion> {
      return writeVersion(actor, organizationId, configurationId, versionId, { kind: "patch", change: input });
    },

    async selectVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
    ): Promise<void> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      const canonicalVersionId = canonicalIdOf(versionId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        // Under the configuration's lock, so a selection and a delete have
        // exactly one order.
        const current = await lockedConfiguration(transaction, id);
        // `record` reads the version through its live configuration first,
        // and writes nothing when it isn't one of its versions.
        const recorded =
          canonicalVersionId !== undefined &&
          (await transaction.selections.record(actor.context.userId, current.id, canonicalVersionId, now()));
        if (!recorded) throw configurationVersionNotFound();
      });
    },
  };
}
