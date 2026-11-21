import type {
  CreateOrganizationVariableRequest,
  CreateVariableGroupRequest,
  FleetActor,
  OrganizationVariable,
  PublishedVersion,
  UpdateOrganizationVariableRequest,
  UpdateVariableGroupRequest,
  VariableDraftsResponse,
  VariableGroup,
  VariableGroupDetail,
  VariableGroupInUseDetails,
  VariableGroupOverride,
  VariableInUseDetails,
  VariableUseGroup,
} from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { ActorContext } from "../../database/context.js";
import { rateLimited, type FleetLimiter, type FleetRequestKind } from "../../http/rate-limits.js";
import { OpampServerMisconfigurationError, type OpampActor, type OpampServerClient } from "../../opamp-server/client.js";
import type * as Opamp from "../../opamp-server/schemas.js";
import type { IPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import { organizationNotFound } from "../organizations/errors.js";
import { describeResult, ensureOrganization, type OpampRegistration } from "../organizations/opamp-registration.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { references } from "../test-runs/organization-variables.js";
import type { IVariableDraftsRepository } from "./drafts-repository.js";
import {
  variableConflict,
  variableGroupConflict,
  variableGroupInUse,
  variableGroupLimitReached,
  variableGroupNameTaken,
  variableGroupNotFound,
  variableInUse,
  variableLimitReached,
  variableNameTaken,
  variableNotFound,
  variablesUnavailable,
} from "./errors.js";

/*
 * The organization's variables and variable groups through the platform. The
 * opamp-server holds them: this service is its tenant router for the signed-in
 * person's active organization, as the fleets service is for fleets.
 *
 * Every operation, in order: the path's organization the session's active one
 * (else 404 `organization_not_found`, before anything else); each path id a
 * canonical UUID (else its 404, with no call); the person's opamp-server
 * budget (the fleet limiter's: one count and one in-flight slot per request,
 * released in a `finally`); the call; the audit row. Every member may do all
 * of it: no viewer role exists since migration 1700000000014, so admins and
 * contributors are every member. The actor the opamp-server records as
 * `changedBy` is the session's person, never the body's.
 *
 * A create first registers the organization with the opamp-server under its
 * current name (as a fleet's create does), then re-checks it `for share` once
 * the create succeeded: one deleted meanwhile is deleted in the opamp-server
 * again (its delete hook) and answers 404 `organization_not_found`.
 *
 * Answers: the person's own refusals passed on (404 `variable_not_found`,
 * `variable_group_not_found`; 409 `variable_name_taken`,
 * `variable_group_name_taken`, `variable_in_use`, `variable_group_in_use`,
 * `variable_limit_reached`, `variable_group_limit_reached`,
 * `variable_conflict`, `variable_group_conflict`); an organization the
 * opamp-server doesn't know holds none (an empty list, a 404); every other
 * outcome one 503 `variables_unavailable`, logged with ids and the
 * result's kind, a warning when the opamp-server couldn't be asked, an
 * error when it answered what the platform's checks should have prevented.
 * A 503 changes nothing on the platform's side; a write's can follow a
 * change the opamp-server made (a reply lost after its commit).
 *
 * The 409s' details: each publication id mapped to its configuration and
 * version by `publishedVersions.describe` (live configurations the person
 * can see), each fleet's label from `getFleet` and its groups' names from
 * `listCollectorGroups`, once per fleet named; a lookup that fails or finds
 * nothing leaves that name null, and the 409 stands. The totals pass
 * through.
 *
 * Audit rows, after the opamp-server's success, in their own transaction
 * (the fleets service's pattern), ids and field names only:
 * `organization_variable.created`, `.updated` (the fields sent) and
 * `.deleted`; `variable_group.created`, `.updated` (the fields sent) and
 * `.deleted`; `variable_group.override_set` on every successful PUT (the
 * platform can't tell a new override, a replace and the same value apart)
 * and `.override_reset` on every Reset (one of nothing included). No row for
 * a create's retry (`unchanged`). A failed row is an error log with the ids;
 * the change stands.
 *
 * A variable's value, name and description, and a variable group's name
 * and description, are configuration text: they reach replies only, never
 * a log line, an error's message, an audit row or a URL. The drafts
 * warning reads the variable's name from the opamp-server, never from the
 * request.
 */

/** The repositories a unit of work of the variables routes uses, bound to one transaction in the request's database context. */
export interface VariablesTransaction {
  /** The active organization: a create's name to register, and its re-check. */
  organization: Pick<IActiveOrganizationRepository, "findActive" | "findActiveForShare">;
  audit: IAuditRepository;
  /** The in-use details' configuration and version of each publication id. */
  publishedVersions: Pick<IPublishedVersionRepository, "describe">;
  /** The drafts warning: the configurations whose current draft holds the reference. */
  drafts: IVariableDraftsRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits.
 */
export type WithVariablesTransaction = <Result>(
  context: ActorContext,
  work: (transaction: VariablesTransaction) => Promise<Result>,
) => Promise<Result>;

export interface VariablesServiceDependencies {
  withTransaction: WithVariablesTransaction;
  opampServer: OpampServerClient;
  /** The person's opamp-server budget, shared with the fleet routes. */
  limiter: FleetLimiter;
  /** A create that finds its organization deleted runs its delete hook again. */
  opampRegistration: Pick<OpampRegistration, "deleted">;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

/** A create's answer: made now (201), or a retry's (200, nothing audited). */
export type CreateOutcome<Created> = { kind: "created" | "unchanged"; created: Created };

export interface IVariablesService {
  listVariables(actor: Actor, organizationId: string): Promise<OrganizationVariable[]>;
  createVariable(actor: Actor, organizationId: string, request: CreateOrganizationVariableRequest): Promise<CreateOutcome<OrganizationVariable>>;
  updateVariable(actor: Actor, organizationId: string, variableId: string, changes: UpdateOrganizationVariableRequest): Promise<OrganizationVariable>;
  deleteVariable(actor: Actor, organizationId: string, variableId: string): Promise<void>;
  /** The drafts warning: the configurations, among those the person can see, whose current draft references the variable's name. */
  variableDrafts(actor: Actor, organizationId: string, variableId: string): Promise<VariableDraftsResponse["configurations"]>;
  listVariableGroups(actor: Actor, organizationId: string): Promise<VariableGroup[]>;
  createVariableGroup(actor: Actor, organizationId: string, request: CreateVariableGroupRequest): Promise<CreateOutcome<VariableGroup>>;
  getVariableGroup(actor: Actor, organizationId: string, variableGroupId: string): Promise<VariableGroupDetail>;
  updateVariableGroup(actor: Actor, organizationId: string, variableGroupId: string, changes: UpdateVariableGroupRequest): Promise<VariableGroup>;
  deleteVariableGroup(actor: Actor, organizationId: string, variableGroupId: string): Promise<void>;
  /** A new override, a replace or the same value again: the override as it now is. */
  setOverride(actor: Actor, organizationId: string, variableGroupId: string, variableId: string, value: string): Promise<VariableGroupOverride>;
  /** Whether or not there was an override to reset. */
  resetOverride(actor: Actor, organizationId: string, variableGroupId: string, variableId: string): Promise<void>;
}

/** The ids a log line or an audit row may name, and nothing else. */
interface VariableIds {
  organizationId: string;
  variableId?: string;
  variableGroupId?: string;
  fleetId?: string;
}

/** What an audit row of the variables routes is about. */
type AuditSubject = { type: "organization_variable" | "variable_group"; id: string };

// ---------------------------------------------------------------------------
// The opamp-server's shapes, as the platform answers them, field by field.

function toActor(actor: { id: string; email: string } | null): FleetActor | null {
  return actor === null ? null : { userId: actor.id, email: actor.email };
}

export function toOrganizationVariable(variable: Opamp.Variable): OrganizationVariable {
  return {
    id: variable.id,
    name: variable.name,
    value: variable.value,
    description: variable.description,
    changedBy: toActor(variable.changedBy),
    changedAt: variable.changedAt,
  };
}

export function toVariableGroup(group: Opamp.VariableGroup): VariableGroup {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    overrideCount: group.overrideCount,
    usage: { collectorGroups: group.usage.collectorGroups, pinnedCollectors: group.usage.pinnedCollectors },
    changedBy: toActor(group.changedBy),
    changedAt: group.changedAt,
  };
}

function toOverride(override: Opamp.VariableGroupOverride): VariableGroupOverride {
  return {
    variableId: override.variableId,
    value: override.value,
    changedBy: toActor(override.changedBy),
    changedAt: override.changedAt,
  };
}

/** The opamp-server's actor: the session's person, never the body's. */
function opampActorOf(actor: Actor): OpampActor {
  return { id: actor.context.userId, email: actor.email };
}

/** The names of the fields a change sends, sorted: what `.updated` records (the reply doesn't say what changed). */
function fieldsSent(changes: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter((name) => changes[name] !== undefined).sort();
}

/** The names of the fields a create gives a value (a null description is none), sorted: what `.created` records. */
function fieldsGiven(request: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter((name) => request[name] !== undefined && request[name] !== null).sort();
}

/** An error's name only: its message could quote anything. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The most fleets a 409's names are looked up for at once. */
export const NAME_LOOKUP_CONCURRENCY = 8;

/** A variable's reference as a configuration writes it. */
function referenceOf(name: string): string {
  return "${org:" + name + "}";
}

export function createVariablesService(deps: VariablesServiceDependencies): IVariablesService {
  const { withTransaction, opampServer, limiter, opampRegistration, log } = deps;

  /** The person's count of `kind` and an in-flight slot, taken just before the first call; 429 when either is spent. */
  async function admitted<Result>(actor: Actor, kind: FleetRequestKind, work: () => Promise<Result>): Promise<Result> {
    const admission = limiter.admit(actor.context.userId, actor.context.organizationId, kind);
    if (!admission.isAdmitted) throw rateLimited(admission.retryAfterSeconds);
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
   * status only. Any other throw is the one 503 too, logged with its name only.
   */
  async function call<Result>(operation: string, ids: VariableIds, send: () => Promise<Result>): Promise<Result> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof OpampServerMisconfigurationError) {
        log.error({ operation, ...ids, error: error.message }, "the opamp-server's settings are wrong, or its answer isn't the API's");
        throw variablesUnavailable();
      }
      log.error({ operation, ...ids, error: errorName(error) }, "organization variables failed: calling the opamp-server threw");
      throw variablesUnavailable();
    }
  }

  /** The one 503 for an outcome that isn't the person's to fix, logged with the ids and the result's kind. */
  function unavailable(operation: string, ids: VariableIds, result: { kind: string }): never {
    const fields = { operation, ...ids, ...describeResult(result) };
    if (result.kind === "unavailable") log.warn(fields, "organization variables failed: the opamp-server couldn't be asked");
    else if (result.kind === "organization_not_found") {
      // Only a create gets here: the organization gone from the opamp-server
      // between the ensure and the create (its delete hook ran meanwhile).
      log.warn(fields, "organization variables failed: the opamp-server no longer knows the organization");
    } else log.error(fields, "organization variables failed: the opamp-server's answer wasn't one the platform expected");
    throw variablesUnavailable();
  }

  /** The row, after the opamp-server's success, in its own transaction; a failed write is an error log, and the change stands. */
  async function audit(actor: Actor, action: string, subject: AuditSubject, metadata: Record<string, unknown>): Promise<void> {
    try {
      await withTransaction(actor.context, (transaction) => transaction.audit.record(auditEvent(actor, action, subject, metadata)));
    } catch (error) {
      log.error(
        { action, organizationId: actor.context.organizationId, subjectId: subject.id, error: errorName(error) },
        "the variable change's audit row wasn't written: the change stands",
      );
    }
  }

  /**
   * After a create's success: the organization taken `for share`. Gone: its
   * delete hook runs again, and 404 `organization_not_found`. Live: a new
   * row's audit (none for a retry) in the same transaction. A transaction
   * that fails otherwise is an error log with the ids; the create stands.
   */
  async function recheckOrganization(
    actor: Actor,
    operation: string,
    ids: VariableIds,
    created?: { action: string; subject: AuditSubject; metadata: Record<string, unknown> },
  ): Promise<void> {
    let isGone: boolean;
    try {
      isGone = await withTransaction(actor.context, async (transaction) => {
        if (!(await transaction.organization.findActiveForShare())) return true;
        if (created !== undefined) {
          await transaction.audit.record(auditEvent(actor, created.action, created.subject, created.metadata));
        }
        return false;
      });
    } catch (error) {
      log.error(
        { operation, ...ids, error: errorName(error) },
        "the variable's create couldn't re-check its organization or write its audit row: the create stands",
      );
      return;
    }
    if (isGone) {
      log.warn({ operation, ...ids }, "the organization was deleted while a variable was created: it is deleted in the opamp-server again");
      opampRegistration.deleted(ids.organizationId);
      throw organizationNotFound();
    }
  }

  /** The organization registered under its current name, before a create. */
  async function ensured(actor: Actor, ids: VariableIds): Promise<void> {
    // The name to register under, read committed (no lock across a call).
    const organization = await withTransaction(actor.context, (transaction) => transaction.organization.findActive());
    if (!organization) throw organizationNotFound();
    const result = await call("ensureOrganization", ids, () => ensureOrganization(opampServer, { id: organization.id, name: organization.name }));
    if (result.kind === "failed") unavailable(result.operation, ids, result.result);
  }

  function variableIdOf(variableId: string): string {
    const id = canonicalIdOf(variableId);
    if (id === undefined) throw variableNotFound();
    return id;
  }

  function variableGroupIdOf(variableGroupId: string): string {
    const id = canonicalIdOf(variableGroupId);
    if (id === undefined) throw variableGroupNotFound();
    return id;
  }

  /**
   * A lookup for a 409's names: the answer, or undefined when the call
   * fails or throws (logged with the ids and the kind, or the error's
   * name), so the name stays null and the 409 stands.
   */
  async function lookedUp<Result extends { kind: string }>(
    operation: string,
    ids: VariableIds,
    send: () => Promise<Result>,
  ): Promise<Result | undefined> {
    try {
      return await send();
    } catch (error) {
      const detail = error instanceof OpampServerMisconfigurationError ? error.message : errorName(error);
      log.warn({ operation, ...ids, error: detail }, "a refusal's names couldn't be looked up: they are left out");
      return undefined;
    }
  }

  /**
   * Each fleet's label and its groups' names, once per fleet named; null
   * where a lookup failed or found none. At most NAME_LOOKUP_CONCURRENCY
   * fleets are looked up at once (a 409 may name up to 100), and none is
   * started after a lookup the opamp-server couldn't answer (unavailable,
   * an undocumented answer, a throw), so a server that is down
   * costs at most one round of calls; the names left are null and the 409
   * stands. A fleet or an organization it doesn't know is a name found
   * empty, never a failure.
   */
  async function namedGroups(ids: VariableIds, groups: readonly { fleetId: string; groupId: string }[]): Promise<VariableUseGroup[]> {
    const fleetIds = [...new Set(groups.map((group) => group.fleetId.toLowerCase()))];
    const labels = new Map<string, string>();
    const groupNames = new Map<string, string>();
    let failed = false;
    const isNotFound = (kind: string) => kind === "fleet_not_found" || kind === "organization_not_found";
    const lookUpFleet = async (fleetId: string) => {
      const lookupIds = { ...ids, fleetId };
      const [fleet, listed] = await Promise.all([
        lookedUp("getFleet", lookupIds, () => opampServer.getFleet(ids.organizationId, fleetId)),
        lookedUp("listCollectorGroups", lookupIds, () => opampServer.listCollectorGroups(ids.organizationId, fleetId)),
      ]);
      if (fleet === undefined) failed = true;
      else if (fleet.kind === "found") labels.set(fleetId, fleet.fleet.label);
      else if (!isNotFound(fleet.kind)) {
        failed = true;
        log.warn({ operation: "getFleet", ...lookupIds, ...describeResult(fleet) }, "a refusal's names couldn't be looked up: they are left out");
      }
      if (listed === undefined) failed = true;
      else if (listed.kind === "listed") for (const group of listed.groups) groupNames.set(group.id.toLowerCase(), group.name);
      else if (!isNotFound(listed.kind)) {
        failed = true;
        log.warn(
          { operation: "listCollectorGroups", ...lookupIds, ...describeResult(listed) },
          "a refusal's names couldn't be looked up: they are left out",
        );
      }
    };
    let next = 0;
    const worker = async () => {
      while (!failed && next < fleetIds.length) {
        const fleetId = fleetIds[next] as string;
        next += 1;
        await lookUpFleet(fleetId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(NAME_LOOKUP_CONCURRENCY, fleetIds.length) }, worker));
    return groups.map((group) => ({
      fleetId: group.fleetId,
      fleetLabel: labels.get(group.fleetId.toLowerCase()) ?? null,
      groupId: group.groupId,
      groupName: groupNames.get(group.groupId.toLowerCase()) ?? null,
    }));
  }

  /** `variable_in_use`'s details with the platform's names: the totals passed through. */
  async function inUseDetails(actor: Actor, ids: VariableIds, details: Opamp.VariableInUseDetails): Promise<VariableInUseDetails> {
    let versions = new Map<string, PublishedVersion>();
    const publicationIds = details.usedBy.map((use) => use.publicationId);
    if (publicationIds.length > 0) {
      try {
        versions = await withTransaction(actor.context, (transaction) => transaction.publishedVersions.describe(publicationIds));
      } catch (error) {
        log.warn({ operation: "describePublishedVersions", ...ids, error: errorName(error) }, "a refusal's names couldn't be looked up: they are left out");
      }
    }
    const groups = await namedGroups(ids, details.usedBy.flatMap((use) => use.groups));
    let next = 0;
    return {
      usedBy: details.usedBy.map((use) => {
        const version = versions.get(use.publicationId.toLowerCase());
        const named = groups.slice(next, next + use.groups.length);
        next += use.groups.length;
        return {
          publishedVersionId: use.publicationId,
          configurationId: version?.configurationId ?? null,
          configurationName: version?.configurationName ?? null,
          versionId: version?.versionId ?? null,
          versionNumber: version?.versionNumber ?? null,
          groups: named,
          pinnedCollectors: use.pinnedCollectors,
        };
      }),
      totalPublications: details.totalPublications,
      totalGroups: details.totalGroups,
      totalPinnedCollectors: details.totalPinnedCollectors,
    };
  }

  /** `variable_group_in_use`'s details with the platform's names. */
  async function groupInUseDetails(ids: VariableIds, details: Opamp.VariableGroupInUseDetails): Promise<VariableGroupInUseDetails> {
    return {
      collectorGroups: await namedGroups(ids, details.collectorGroups),
      totalCollectorGroups: details.totalCollectorGroups,
      pinnedCollectors: details.pinnedCollectors,
    };
  }

  return {
    async listVariables(actor, organizationId) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId };
      return admitted(actor, "read", async () => {
        const result = await call("listVariables", ids, () => opampServer.listVariables(ids.organizationId));
        switch (result.kind) {
          case "listed":
            return result.variables.map(toOrganizationVariable);
          case "organization_not_found":
            // An organization the opamp-server doesn't know has no variables.
            return [];
          default:
            return unavailable("listVariables", ids, result);
        }
      });
    },

    async createVariable(actor, organizationId, request) {
      assertActiveOrganization(actor, organizationId);
      // The browser's id makes a retry safe.
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableId: request.id.toLowerCase() };
      const variableId = request.id.toLowerCase();
      return admitted(actor, "write", async () => {
        await ensured(actor, ids);
        const result = await call("createVariable", ids, () =>
          opampServer.createVariable(ids.organizationId, {
            id: variableId,
            name: request.name,
            value: request.value,
            description: request.description,
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "created":
            await recheckOrganization(actor, "createVariable", ids, {
              action: "organization_variable.created",
              subject: { type: "organization_variable", id: variableId },
              metadata: { variableId, fields: fieldsGiven(request, ["name", "value", "description"]) },
            });
            return { kind: "created", created: toOrganizationVariable(result.variable) };
          case "unchanged":
            await recheckOrganization(actor, "createVariable", ids);
            return { kind: "unchanged", created: toOrganizationVariable(result.variable) };
          case "variable_conflict":
            throw variableConflict();
          case "variable_name_taken":
            throw variableNameTaken();
          case "variable_limit_reached":
            throw variableLimitReached();
          default:
            // A 400 too: the contract checked the body.
            return unavailable("createVariable", ids, result);
        }
      });
    },

    async updateVariable(actor, organizationId, variableIdParam, changes) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableId: variableIdOf(variableIdParam) };
      const variableId = ids.variableId as string;
      return admitted(actor, "write", async () => {
        const result = await call("updateVariable", ids, () =>
          opampServer.updateVariable(ids.organizationId, variableId, {
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.value === undefined ? {} : { value: changes.value }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "updated":
            await audit(actor, "organization_variable.updated", { type: "organization_variable", id: variableId }, {
              variableId,
              fields: fieldsSent(changes, ["name", "value", "description"]),
            });
            return toOrganizationVariable(result.variable);
          case "variable_not_found":
          case "organization_not_found":
            throw variableNotFound();
          case "variable_name_taken":
            throw variableNameTaken();
          case "variable_in_use":
            throw variableInUse(await inUseDetails(actor, ids, result.details));
          default:
            return unavailable("updateVariable", ids, result);
        }
      });
    },

    async deleteVariable(actor, organizationId, variableIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableId: variableIdOf(variableIdParam) };
      const variableId = ids.variableId as string;
      await admitted(actor, "write", async () => {
        const result = await call("deleteVariable", ids, () => opampServer.deleteVariable(ids.organizationId, variableId));
        switch (result.kind) {
          case "deleted":
            await audit(actor, "organization_variable.deleted", { type: "organization_variable", id: variableId }, { variableId });
            return;
          case "variable_not_found":
          case "organization_not_found":
            throw variableNotFound();
          case "variable_in_use":
            throw variableInUse(await inUseDetails(actor, ids, result.details));
          default:
            return unavailable("deleteVariable", ids, result);
        }
      });
    },

    async variableDrafts(actor, organizationId, variableIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableId: variableIdOf(variableIdParam) };
      return admitted(actor, "read", async () => {
        // The name from the opamp-server, never the request's. The opamp-server
        // has no single variable's read, so the whole list is read (at most
        // 150, class U) to find this one by its id.
        const result = await call("listVariables", ids, () => opampServer.listVariables(ids.organizationId));
        let name: string;
        switch (result.kind) {
          case "listed": {
            const found = result.variables.find((variable) => variable.id.toLowerCase() === ids.variableId);
            if (found === undefined) throw variableNotFound();
            name = found.name;
            break;
          }
          case "organization_not_found":
            throw variableNotFound();
          default:
            return unavailable("listVariables", ids, result);
        }
        // Prefiltered on the reference's spelling, then confirmed a live reference (an escaped `$${org:NAME}` isn't one).
        const candidates = await withTransaction(actor.context, (transaction) => transaction.drafts.candidates(referenceOf(name)));
        return candidates
          .filter((candidate) => references(candidate.yaml).includes(name))
          .map((candidate) => ({ id: candidate.id, name: candidate.name }));
      });
    },

    async listVariableGroups(actor, organizationId) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId };
      return admitted(actor, "read", async () => {
        const result = await call("listVariableGroups", ids, () => opampServer.listVariableGroups(ids.organizationId));
        switch (result.kind) {
          case "listed":
            return result.variableGroups.map(toVariableGroup);
          case "organization_not_found":
            return [];
          default:
            return unavailable("listVariableGroups", ids, result);
        }
      });
    },

    async createVariableGroup(actor, organizationId, request) {
      assertActiveOrganization(actor, organizationId);
      const variableGroupId = request.id.toLowerCase();
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId };
      return admitted(actor, "write", async () => {
        await ensured(actor, ids);
        const result = await call("createVariableGroup", ids, () =>
          opampServer.createVariableGroup(ids.organizationId, {
            id: variableGroupId,
            name: request.name,
            description: request.description,
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "created":
            await recheckOrganization(actor, "createVariableGroup", ids, {
              action: "variable_group.created",
              subject: { type: "variable_group", id: variableGroupId },
              metadata: { variableGroupId, fields: fieldsGiven(request, ["name", "description"]) },
            });
            return { kind: "created", created: toVariableGroup(result.variableGroup) };
          case "unchanged":
            await recheckOrganization(actor, "createVariableGroup", ids);
            return { kind: "unchanged", created: toVariableGroup(result.variableGroup) };
          case "variable_group_conflict":
            throw variableGroupConflict();
          case "variable_group_name_taken":
            throw variableGroupNameTaken();
          case "variable_group_limit_reached":
            throw variableGroupLimitReached();
          default:
            return unavailable("createVariableGroup", ids, result);
        }
      });
    },

    async getVariableGroup(actor, organizationId, variableGroupIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId: variableGroupIdOf(variableGroupIdParam) };
      const variableGroupId = ids.variableGroupId as string;
      return admitted(actor, "read", async () => {
        const result = await call("getVariableGroup", ids, () => opampServer.getVariableGroup(ids.organizationId, variableGroupId));
        switch (result.kind) {
          case "found":
            return { variableGroup: toVariableGroup(result.variableGroup), overrides: result.overrides.map(toOverride) };
          case "variable_group_not_found":
          case "organization_not_found":
            throw variableGroupNotFound();
          default:
            return unavailable("getVariableGroup", ids, result);
        }
      });
    },

    async updateVariableGroup(actor, organizationId, variableGroupIdParam, changes) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId: variableGroupIdOf(variableGroupIdParam) };
      const variableGroupId = ids.variableGroupId as string;
      return admitted(actor, "write", async () => {
        const result = await call("updateVariableGroup", ids, () =>
          opampServer.updateVariableGroup(ids.organizationId, variableGroupId, {
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
            actor: opampActorOf(actor),
          }),
        );
        switch (result.kind) {
          case "updated":
            await audit(actor, "variable_group.updated", { type: "variable_group", id: variableGroupId }, {
              variableGroupId,
              fields: fieldsSent(changes, ["name", "description"]),
            });
            return toVariableGroup(result.variableGroup);
          case "variable_group_not_found":
          case "organization_not_found":
            throw variableGroupNotFound();
          case "variable_group_name_taken":
            throw variableGroupNameTaken();
          default:
            return unavailable("updateVariableGroup", ids, result);
        }
      });
    },

    async deleteVariableGroup(actor, organizationId, variableGroupIdParam) {
      assertActiveOrganization(actor, organizationId);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId: variableGroupIdOf(variableGroupIdParam) };
      const variableGroupId = ids.variableGroupId as string;
      await admitted(actor, "write", async () => {
        const result = await call("deleteVariableGroup", ids, () => opampServer.deleteVariableGroup(ids.organizationId, variableGroupId));
        switch (result.kind) {
          case "deleted":
            await audit(actor, "variable_group.deleted", { type: "variable_group", id: variableGroupId }, { variableGroupId });
            return;
          case "variable_group_not_found":
          case "organization_not_found":
            throw variableGroupNotFound();
          case "variable_group_in_use":
            throw variableGroupInUse(await groupInUseDetails(ids, result.details));
          default:
            return unavailable("deleteVariableGroup", ids, result);
        }
      });
    },

    async setOverride(actor, organizationId, variableGroupIdParam, variableIdParam, value) {
      assertActiveOrganization(actor, organizationId);
      const variableGroupId = variableGroupIdOf(variableGroupIdParam);
      const variableId = variableIdOf(variableIdParam);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId, variableId };
      return admitted(actor, "write", async () => {
        const result = await call("setVariableGroupOverride", ids, () =>
          opampServer.setVariableGroupOverride(ids.organizationId, variableGroupId, variableId, { value, actor: opampActorOf(actor) }),
        );
        switch (result.kind) {
          case "set":
            // Every successful PUT: new, replaced or the same value again.
            await audit(actor, "variable_group.override_set", { type: "variable_group", id: variableGroupId }, { variableGroupId, variableId });
            return toOverride(result.override);
          case "variable_group_not_found":
          case "organization_not_found":
            throw variableGroupNotFound();
          case "variable_not_found":
            throw variableNotFound();
          default:
            return unavailable("setVariableGroupOverride", ids, result);
        }
      });
    },

    async resetOverride(actor, organizationId, variableGroupIdParam, variableIdParam) {
      assertActiveOrganization(actor, organizationId);
      const variableGroupId = variableGroupIdOf(variableGroupIdParam);
      const variableId = variableIdOf(variableIdParam);
      const ids: VariableIds = { organizationId: actor.context.organizationId, variableGroupId, variableId };
      await admitted(actor, "write", async () => {
        const result = await call("resetVariableGroupOverride", ids, () =>
          opampServer.resetVariableGroupOverride(ids.organizationId, variableGroupId, variableId, opampActorOf(actor)),
        );
        switch (result.kind) {
          case "reset":
            // Every 204, a Reset of no override included: the platform can't tell them apart.
            await audit(actor, "variable_group.override_reset", { type: "variable_group", id: variableGroupId }, { variableGroupId, variableId });
            return;
          case "variable_group_not_found":
          case "organization_not_found":
            throw variableGroupNotFound();
          case "variable_not_found":
            throw variableNotFound();
          default:
            return unavailable("resetVariableGroupOverride", ids, result);
        }
      });
    },
  };
}

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
