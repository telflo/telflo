import { randomUUID } from "node:crypto";
import { VARIABLE_NAME_MAXIMUM_LENGTH } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { RunAfterResponse } from "../../http/after-response.js";
import {
  OpampServerMisconfigurationError,
  sha256Hex,
  type OpampServerClient,
  type PublicationRequest,
} from "../../opamp-server/client.js";
import { describeResult, ensureOrganization } from "../organizations/opamp-registration.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { references } from "../test-runs/organization-variables.js";
import { variableReferenceTooLong } from "../variables/errors.js";
import {
  configurationNotFound,
  configurationVersionAlreadyPublished,
  configurationVersionChanged,
  configurationVersionEmpty,
  configurationVersionNotFound,
  publishingUnavailable,
} from "./errors.js";
import type { ConfigurationVersionSummary } from "./repositories/configuration-version-repository.js";
import { auditEvent, lockAsMember, lockedConfiguration, type WithConfigurationTransaction } from "./service.js";

/*
 * Publishing a version (D11b decisions 9 to 11, Preflight rulings 8, 9 and
 * 15; D11a decision 12's order), and removing a deleted configuration's
 * snapshots (decision 12).
 *
 * A publish runs in four steps, and holds no lock across the opamp-server's
 * calls (decision 9):
 *
 * 1. the checks, in a transaction of their own that commits before any
 *    call: the configuration and the version are ones the caller can see,
 *    the version is a draft, it is the save the caller's tab last saw (when
 *    the tab says which, by its `updatedAt`: Ruling 30), and its saved YAML
 *    isn't empty; then, before any call, that its text holds no live
 *    `${org:NAME}` to a name over 128 characters, which no organization
 *    variable can have (D20 Ruling 55, the platform side of Ruling 51: 400
 *    `invalid_request` naming `yaml`, nothing written on either side);
 * 2. the organization ensured in the opamp-server's registry (D11a decision
 *    20): created, or renamed when it is registered under another name;
 * 3. the snapshot put under a fresh publication id, so a failure after the
 *    opamp-server took it leaves at worst an unused snapshot, never a record
 *    pointing at nothing;
 * 4. the record, in a new transaction in D10's lock order: one statement
 *    that publishes the version only if it is still a draft holding exactly
 *    the YAML, the label and the collector version put (`recordPublish`;
 *    D13a Preflight ruling 3). A concurrent publish that recorded first, or
 *    a save or a rename since the checks, leaves it unwritten.
 *
 * When the record fails for any reason after the put, the snapshot just put
 * is removed after the response, best effort (Ruling 29): unless a version
 * records its id after all (a commit whose answer was lost), the
 * opamp-server is asked to delete it by its id. Only when that clean-up
 * fails does it stay, an orphan, with a warning naming ids only (decision
 * 9; a reconciliation that removes them is not built yet).
 *
 * The YAML, the configuration's name, the version's label, the caller's
 * email and the opamp-server's secret go only to the opamp-server: never
 * into a log line, an error's message or the audit row (ADR 0024; D11a
 * decision 12). The log lines name ids, the operation and the result's kind
 * (with a reason, a status or a code) only.
 *
 * Exported for D25's public API, whose publish endpoint calls this service.
 */

export interface PublishingDependencies {
  withTransaction: WithConfigurationTransaction;
  /** One read per publish: the snapshot's `publishedAt` and the record's `published_at`. */
  now: () => Date;
  opampServer: OpampServerClient;
  /** buildServer's runner: an unrecorded publish's snapshot is removed on it (Ruling 29). */
  runAfterResponse: RunAfterResponse;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

/** What a caller may add to a publish. */
export interface PublishOptions {
  /**
   * The version's `updatedAt` as the caller's tab last loaded or saved it
   * (Ruling 30, the owner's): a version saved since is refused with 409
   * `configuration_version_changed` before any call. Compared to the
   * millisecond, as a summary reports it. Left out by a caller with no tab
   * (D25's public API), which publishes what is saved.
   */
  expectedUpdatedAt?: Date;
}

export interface IPublishingService {
  /**
   * Publishes the version and answers its summary, now published. 404
   * `configuration_not_found` for a configuration the caller can't see (a
   * malformed id included), then 404 `configuration_version_not_found` for
   * a version that isn't one of its own; 409
   * `configuration_version_published` for one published already (before
   * any call, or found by the record), 409 `configuration_version_changed`
   * for one saved since the caller's tab saw it (`expectedUpdatedAt`,
   * before any call), 409 `configuration_version_empty` for empty saved
   * YAML (before any call), 409 `configuration_version_changed` for one
   * saved or renamed between the checks and the record; 400
   * `invalid_request` naming `yaml` for a text referencing an organization
   * variable name over 128 characters (before any call), or a text the
   * opamp-server refuses `invalid_request` (D20 Rulings 55 and 71); 503
   * `publishing_unavailable` when the opamp-server can't be asked or an
   * organization vanished from its registry mid-publish. A conflict, or a
   * put's other `invalid` codes, rejects with an `OpampServerAnswerError`, and a
   * misconfiguration with the client's `OpampServerMisconfigurationError`:
   * both are a 500. Only a 200 records anything; any refusal after the
   * put removes the snapshot after the response (Ruling 29).
   */
  publishVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    options?: PublishOptions,
  ): Promise<ConfigurationVersionSummary>;
}

/**
 * An answer of the opamp-server's that the API documents but a publish
 * can't go on from, and that a retry wouldn't change: a `conflict`, an
 * organization's `invalid` at the ensure, or a put's `invalid` but
 * `invalid_request` (that one is Ruling 55's 400, Ruling 71). A 500. Its message names the operation, the result's kind and
 * an invalid's code only, never the server's own text.
 */
export class OpampServerAnswerError extends Error {
  constructor(operation: string, result: { kind: string; code?: string }) {
    super(
      `The opamp-server answered ${operation} with ${result.kind}${result.code === undefined ? "" : ` (${result.code})`}.`,
    );
    this.name = "OpampServerAnswerError";
  }
}

/**
 * What a publish read in its checks, and sends: the names, the YAML and the
 * collector as they are now. The snapshot's collector is the configuration's
 * distribution (fixed for its life, D13a decision 5) and the version's pin
 * (decision 8), never a default (D13a decision 7).
 */
interface PublishTarget {
  organization: { id: string; name: string };
  configuration: { id: string; name: string; collectorDistribution: string };
  version: { id: string; number: number; label: string | null; yaml: string; collectorVersion: string };
}

/** The ids a publish's log lines name, and nothing else. */
interface PublishIds {
  organizationId: string;
  configurationId: string;
  versionId: string;
}

export function createPublishingService(deps: PublishingDependencies): IPublishingService {
  const { withTransaction, now, opampServer, runAfterResponse, log } = deps;

  /** Logged, then 503: the opamp-server couldn't be asked, or lost the organization mid-publish. */
  function unavailable(operation: string, ids: PublishIds, result: { kind: string }): never {
    log.warn({ operation, ...ids, ...describeResult(result) }, "publishing failed: the opamp-server didn't take it");
    throw publishingUnavailable();
  }

  /** Step 1: what to publish, read in a transaction that commits before any call (decision 9). */
  async function check(
    actor: Actor,
    configurationId: string,
    versionId: string | undefined,
    expectedUpdatedAt: Date | undefined,
  ): Promise<PublishTarget> {
    return withTransaction(actor.context, async (transaction) => {
      // The organization and the membership, live, as every write reads
      // them first; the organization's name is the one to register.
      const { organization } = await lockAsMember(transaction, actor);
      // The configuration first, so one the caller can't see is
      // configuration_not_found whatever the version (Preflight ruling 15).
      const configuration = await transaction.configurations.find(configurationId);
      if (!configuration) throw configurationNotFound();
      const version =
        versionId === undefined ? undefined : await transaction.versions.find(configuration.id, versionId);
      if (!version) throw configurationVersionNotFound();
      if (version.publishedAt !== null) throw configurationVersionAlreadyPublished(version.versionNumber);
      // Ruling 30: a save the caller's tab didn't see (a teammate's, or its
      // own from another tab) is refused, so a clean tab never publishes
      // text it isn't showing; the editor reloads the version. Before the
      // empty check, since the newer save is what the caller needs to see.
      // To the millisecond, as the summary the tab read reports it.
      if (expectedUpdatedAt !== undefined && version.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw configurationVersionChanged();
      }
      // Exactly empty, as every new configuration's version 1 is: the
      // opamp-server refuses it (Preflight ruling 9). Only whitespace or
      // comments is D13's validation.
      if (version.yamlContent === "") throw configurationVersionEmpty();
      return {
        organization: { id: organization.id, name: organization.name },
        configuration: {
          id: configuration.id,
          name: configuration.name,
          collectorDistribution: configuration.collectorDistribution,
        },
        version: {
          id: version.id,
          number: version.versionNumber,
          label: version.label,
          yaml: version.yamlContent,
          collectorVersion: version.collectorVersion,
        },
      };
    });
  }

  /**
   * Ruling 29: after the response, best effort, the snapshot a failed record
   * left is deleted by its id. First, in a transaction of its own, whether a
   * version records the id after all: a record whose commit's answer was
   * lost (the connection dropped) may have committed, and deleting its
   * snapshot would leave a record pointing at nothing, the one outcome the
   * order of the steps avoids. Row-level security can't hide a recorded
   * one: its configuration is then published, which the caller's context
   * sees, a removed member's included. When that read fails, the snapshot
   * is kept. Any answer of the delete's but `deleted` or `not_found` leaves
   * an orphan, with a warning; a misconfiguration is an error with its
   * message, which names no secret, and anything else an error with its
   * name. Ids only, never the YAML, a name, a label or an email.
   */
  function removeUnrecordedSnapshot(actor: Actor, ids: PublishIds, publicationId: string): void {
    const operation = "deletePublication";
    runAfterResponse(async () => {
      try {
        const recorded = await withTransaction(actor.context, (transaction) =>
          transaction.versions.isPublicationRecorded(publicationId),
        );
        if (recorded) return;
      } catch (error) {
        log.warn(
          { operation, ...ids, publicationId, error: error instanceof Error ? error.name : typeof error },
          "the unrecorded publish's snapshot was kept: whether it was recorded couldn't be read",
        );
        return;
      }
      try {
        const result = await opampServer.deletePublication(ids.organizationId, publicationId);
        if (result.kind === "in_use") {
          // D16a decision 31: a collector group or a collector uses it, so
          // the opamp-server kept it. A warning naming ids only.
          log.warn(
            { operation, ...ids, publicationId, result: result.kind },
            "the unrecorded publish's snapshot is in use in the opamp-server: it was kept",
          );
          return;
        }
        if (result.kind !== "deleted" && result.kind !== "not_found") {
          log.warn(
            { operation, ...ids, publicationId, ...describeResult(result) },
            "the opamp-server didn't delete the unrecorded publish's snapshot: it is an orphan",
          );
        }
      } catch (error) {
        if (error instanceof OpampServerMisconfigurationError) {
          log.error({ operation, ...ids, publicationId, error: error.message }, "the opamp-server's settings are wrong");
          return;
        }
        // A bug: its name only, since its message could quote anything.
        log.error(
          { operation, ...ids, publicationId, error: error instanceof Error ? error.name : typeof error },
          "deleting the unrecorded publish's snapshot failed",
        );
      }
    });
  }

  return {
    async publishVersion(
      actor: Actor,
      organizationId: string,
      configurationId: string,
      versionId: string,
      options: PublishOptions = {},
    ): Promise<ConfigurationVersionSummary> {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      const target = await check(actor, id, canonicalIdOf(versionId), options.expectedUpdatedAt);
      // D20 Ruling 55: a reference no variable can satisfy is refused before anything is written, on either side.
      if (references(target.version.yaml).some((name) => name.length > VARIABLE_NAME_MAXIMUM_LENGTH)) throw variableReferenceTooLong();
      const ids: PublishIds = {
        organizationId: target.organization.id,
        configurationId: target.configuration.id,
        versionId: target.version.id,
      };

      // Step 2: the organization registered under its current name (D11a
      // decision 20; ensureOrganization). A refusal (`invalid`) is a 500;
      // the opamp-server unreachable, or the organization gone mid-ensure,
      // a 503: a retry registers it again.
      const ensured = await ensureOrganization(opampServer, target.organization);
      if (ensured.kind === "failed") {
        if (ensured.result.kind === "invalid") throw new OpampServerAnswerError(ensured.operation, ensured.result);
        return unavailable(ensured.operation, ids, ensured.result);
      }

      // Step 3: a fresh id per attempt (D11a decision 12), and one clock
      // read for the snapshot and the record (Preflight ruling 15). The
      // API's clock holds whole milliseconds, which the opamp-server keeps.
      const publicationId = randomUUID();
      const publishedAt = now();
      const snapshot: PublicationRequest = {
        configuration: { id: target.configuration.id, name: target.configuration.name },
        version: { id: target.version.id, number: target.version.number, label: target.version.label },
        yaml: target.version.yaml,
        sha256: sha256Hex(target.version.yaml),
        publishedBy: { id: actor.context.userId, email: actor.email },
        publishedAt: publishedAt.toISOString(),
        // D13a decision 7: what the checks read, as the record re-checks it.
        collector: {
          distribution: target.configuration.collectorDistribution,
          version: target.version.collectorVersion,
        },
      };
      const posted = await opampServer.postPublication(target.organization.id, publicationId, snapshot);
      switch (posted.kind) {
        case "created":
        case "unchanged":
          break;
        case "unavailable":
        case "organization_not_found":
          return unavailable("postPublication", ids, posted);
        case "invalid":
          // Ruling 55's backstop, as Ruling 71 narrows it: the snapshot is
          // otherwise always valid, so the opamp-server's 400
          // `invalid_request` is its refusal of the text's over-128
          // reference (Ruling 51). It wrote nothing. Logged with the ids and
          // the code only, never the text. Any other code (a hash that
          // doesn't match, a body too large) is the platform's own bug: a 500.
          if (posted.code !== "invalid_request") throw new OpampServerAnswerError("postPublication", posted);
          log.warn({ operation: "postPublication", ...ids, ...describeResult(posted) }, "publishing refused: the opamp-server refused the version's text");
          throw variableReferenceTooLong();
        case "conflict":
          throw new OpampServerAnswerError("postPublication", posted);
      }

      // Step 4, in D10's lock order: the organization `for share`, the
      // membership re-read, then the configuration `for update`, so the
      // record and a save of this version have exactly one order.
      try {
        return await withTransaction(actor.context, async (transaction) => {
          await lockAsMember(transaction, actor);
          const current = await lockedConfiguration(transaction, target.configuration.id);
          const recorded = await transaction.versions.recordPublish(current.id, target.version.id, {
            publishedAt,
            publicationId,
            publishedByUserId: actor.context.userId,
            yamlContent: target.version.yaml,
            label: target.version.label,
            collectorVersion: target.version.collectorVersion,
          });
          if (!recorded) {
            // Why it wrote nothing, read under the same lock, so nothing
            // has changed since the statement.
            const found = await transaction.versions.find(current.id, target.version.id);
            if (!found) throw configurationVersionNotFound();
            if (found.publishedAt !== null) throw configurationVersionAlreadyPublished(found.versionNumber);
            // Saved or renamed since the checks: the snapshot holds text, a
            // label or a collector version the version no longer has
            // (Preflight ruling 8, Ruling 29, D13a Preflight ruling 3).
            if (
              found.yamlContent !== target.version.yaml ||
              found.label !== target.version.label ||
              found.collectorVersion !== target.version.collectorVersion
            ) {
              throw configurationVersionChanged();
            }
            // A draft of a live, visible configuration holding the YAML, the
            // label and the collector version put: the statement can't have
            // missed it.
            throw new Error(
              "the publish's record wrote no row, though the version is a draft holding the YAML, the label and the collector version put",
            );
          }
          // The configuration moves to the top of the list, as a save does;
          // the version's `updatedAt` stays its last save (D10). Its own
          // clock read: a save between the checks and here may have moved
          // it past `publishedAt`. Live under the lock just taken: this
          // can't miss.
          if (!(await transaction.configurations.touch(current.id, now()))) throw configurationNotFound();
          // Ids and the number only: never the YAML, the names, the label
          // or an email (Preflight ruling 15).
          await transaction.audit.record(
            auditEvent(actor, current.id, "configuration.version_published", {
              versionId: recorded.id,
              versionNumber: recorded.versionNumber,
              publicationId,
            }),
          );
          return recorded;
        });
      } catch (error) {
        // The opamp-server holds the snapshot, and the platform doesn't
        // point at it: whatever the reason (a concurrent publish recorded
        // first, a save or a rename since the checks, the configuration or
        // the membership gone, a failure in the transaction), it is removed
        // after the response (Ruling 29). The answer stays the record's.
        log.warn({ ...ids, publicationId }, "the publish wasn't recorded: its snapshot will be removed");
        removeUnrecordedSnapshot(actor, ids, publicationId);
        throw error;
      }
    },
  };

}

export interface PublicationsCleanupDependencies {
  opampServer: OpampServerClient;
  runAfterResponse: RunAfterResponse;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
}

/**
 * D11b decision 12: once a configuration's soft delete has committed, its
 * snapshots are removed from the opamp-server after the response, best
 * effort. The delete never waits for it nor fails because of it. Any result
 * but `deleted` is a warning, `organization_not_found` included (an
 * organization the registry missed holds no snapshots), and `in_use` (a
 * collector group or a collector uses one, D16a decision 31: they are kept
 * until D16b refuses such a delete first); a misconfiguration is an error
 * with its message, which names no secret. Ids only.
 */
export function createPublicationsCleanup(
  deps: PublicationsCleanupDependencies,
): (organizationId: string, configurationId: string) => void {
  const { opampServer, runAfterResponse, log } = deps;
  const operation = "deleteConfigurationPublications";
  return (organizationId, configurationId) => {
    runAfterResponse(async () => {
      try {
        const result = await opampServer.deleteConfigurationPublications(organizationId, configurationId);
        if (result.kind === "in_use") {
          // D16a decision 31: a collector group or a collector uses one of
          // them, so the opamp-server kept them all, until D16b refuses the
          // configuration's delete first. A warning naming ids only.
          log.warn(
            { operation, organizationId, configurationId, result: result.kind },
            "the opamp-server kept the configuration's publications: a collector group or a collector uses one",
          );
          return;
        }
        if (result.kind !== "deleted") {
          log.warn(
            { operation, organizationId, configurationId, ...describeResult(result) },
            "the opamp-server didn't delete the configuration's publications",
          );
        }
      } catch (error) {
        if (error instanceof OpampServerMisconfigurationError) {
          log.error(
            { operation, organizationId, configurationId, error: error.message },
            "the opamp-server's settings are wrong",
          );
          return;
        }
        // A bug: its name only, since its message could quote anything.
        log.error(
          { operation, organizationId, configurationId, error: error instanceof Error ? error.name : typeof error },
          "deleting the configuration's publications failed",
        );
      }
    });
  };
}
