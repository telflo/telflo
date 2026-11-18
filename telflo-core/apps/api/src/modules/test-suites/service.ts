import {
  TEST_DEFINITIONS_PER_SUITE_MAXIMUM,
  TEST_FILE_HEAD_MAXIMUM_BYTES,
  TEST_SUITES_PER_VERSION_MAXIMUM,
  type TestRunSignal,
} from "@telflo/contracts";
import type { Readable } from "node:stream";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import { configurationNotFound, configurationVersionNotFound } from "../configurations/errors.js";
import { lockAsMember, lockedConfiguration } from "../configurations/service.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { testFileNotFound } from "../test-runs/errors.js";
import { firstBytes, testInputKey } from "../test-runs/test-file-service.js";
import { testTemplateNotFound } from "../test-templates/errors.js";
import {
  testDefinitionLimitReached,
  testDefinitionNotFound,
  testSuiteLimitReached,
  testSuiteNotFound,
} from "./errors.js";
import type { TestDefinition } from "./repositories/test-definition-repository.js";
import type { TestSuite } from "./repositories/test-suite-repository.js";
import type { TestSuitesTransaction, WithTestSuitesTransaction } from "./transaction.js";

/*
 * The test suites and definitions API (D14b decisions 1, 2, 4, 5, 8, 9 and
 * 25; details 19 and 20; Preflight rulings 7, 10 and 22 to 24).
 *
 * Suites and definitions belong to a configuration version and follow its
 * configuration's visibility (decision 8): another member's draft's, a
 * deleted configuration's and another organization's are 404, with the
 * configurations' own codes for the configuration and the version, as the
 * runs' are. They may change on any version, published or not (decision 5).
 *
 * Every write takes the organization's lock as a member (lockAsMember),
 * then the configuration's (lockedConfiguration): one lock order, which
 * also serializes the inputs' reference count (Preflight ruling 7) and the
 * caps (ruling 23), counted under it.
 *
 * Creating a definition copies its input, in this order (ruling 7):
 *   1. a read transaction: the membership, the configuration and its
 *      version, the suite in the version (404 `test_suite_not_found`), the
 *      source (the caller's own test file, 404 `test_file_not_found`, or a
 *      live template, 404 `test_template_not_found`), then the input's id;
 *   2. the source's bytes copied to
 *      organizations/<org>/test-definition-inputs/<input>;
 *   3. one transaction: the locks, the version and the suite re-read, the
 *      cap, the input's row (the source's file name and content type, the
 *      copy's size and SHA-256), the definition (the caller its creator) and
 *      the audit row;
 *   4. on any failure after the copy began, the copy is removed.
 *
 * Deleting a definition or a suite deletes its rows in one transaction under
 * the locks, frees (deletes) each of their inputs no definition names any
 * more, writes the audit row and commits; then each freed input's bytes are
 * removed, a failure logged (its code and syscall only) and never thrown:
 * without its row, the file is unreachable.
 *
 * Names, descriptions, file names and bytes reach no log line and no audit
 * row (ADR 0024): the audit rows name ids only.
 */

export interface TestSuiteServiceDependencies {
  withTransaction: WithTestSuitesTransaction;
  fileStore: IFileStore;
  /** Every suite and definition timestamp comes from here, never SQL `now()`. */
  now: () => Date;
  log: { warn(details: Record<string, unknown>, message: string): void };
}

/** A suite's create, as the contract parses it: trimmed already. */
export interface CreateSuiteInput {
  name: string;
  description: string;
}

/** A suite's change, as the contract parses it: a field left out stays as it is. */
export interface SuiteChanges {
  name?: string | undefined;
  description?: string | undefined;
}

/** A definition's create, as the contract parses it: exactly one of `inputFileId` and `templateId`. */
export interface CreateDefinitionInput {
  inputFileId?: string | undefined;
  templateId?: string | undefined;
  name: string;
  description: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
}

/** The path's ids, as the routes take them: any strings (D5 decision 7). */
export interface VersionPath {
  organizationId: string;
  configurationId: string;
  versionId: string;
}

export interface ITestSuiteService {
  /** The version's suites the caller can see, oldest first, at most TEST_SUITES_PER_VERSION_MAXIMUM. */
  listSuites(actor: Actor, path: VersionPath): Promise<TestSuite[]>;
  /** A new suite on the version, the caller its creator: 409 `test_suite_limit_reached` for its 101st. */
  createSuite(actor: Actor, path: VersionPath, input: CreateSuiteInput): Promise<TestSuite>;
  /**
   * Changes the fields given. None given, or none different from what is
   * there, changes and audits nothing, and answers the suite as it is (as a
   * configuration's change does).
   */
  updateSuite(actor: Actor, path: VersionPath, suiteId: string, changes: SuiteChanges): Promise<TestSuite>;
  /** Deletes the suite and its definitions, then the bytes of every input no definition names any more. */
  removeSuite(actor: Actor, path: VersionPath, suiteId: string): Promise<void>;
  /** The suite's definitions, oldest first, at most TEST_DEFINITIONS_PER_SUITE_MAXIMUM. */
  listDefinitions(actor: Actor, path: VersionPath, suiteId: string): Promise<TestDefinition[]>;
  /** A new definition, its input copied from its source (the order above). */
  createDefinition(actor: Actor, path: VersionPath, suiteId: string, input: CreateDefinitionInput): Promise<TestDefinition>;
  /** Deletes the definition, then its input's bytes if no definition names it any more. */
  removeDefinition(actor: Actor, path: VersionPath, suiteId: string, definitionId: string): Promise<void>;
  /**
   * The first TEST_FILE_HEAD_MAXIMUM_BYTES of a visible definition's input,
   * open for streaming (Play one's fixture-shape check): 404
   * `test_definition_not_found` when its bytes are gone. The caller must
   * consume or destroy the stream.
   */
  openDefinitionInputHead(
    actor: Actor,
    path: VersionPath,
    suiteId: string,
    definitionId: string,
  ): Promise<{ sizeBytes: number; stream: Readable }>;
}

/**
 * The FileStore's key of a definition input in the caller's active
 * organization: always `actor.context.organizationId`, never the path's
 * (Ruling 32), as testInputKey keys a test file.
 */
export function testDefinitionInputKey(organizationId: string, inputId: string): FileKey {
  return { kind: "test-definition-input", organizationId, inputId };
}

/** The path's configuration and version, canonical, or the 404 each answers for a malformed one. */
function canonicalVersionPath(path: VersionPath): { configurationId: string; versionId: string } {
  const configurationId = canonicalIdOf(path.configurationId);
  if (configurationId === undefined) throw configurationNotFound();
  const versionId = canonicalIdOf(path.versionId);
  if (versionId === undefined) throw configurationVersionNotFound();
  return { configurationId, versionId };
}

/**
 * A read's checks: the membership, re-read under the organization's lock,
 * then the configuration and its version as the caller sees them (404
 * `configuration_not_found`, then `configuration_version_not_found`).
 */
async function visibleVersion(
  transaction: TestSuitesTransaction,
  actor: Actor,
  configurationId: string,
  versionId: string,
): Promise<void> {
  await lockAsMember(transaction, actor);
  if (!(await transaction.configurations.find(configurationId))) throw configurationNotFound();
  if (!(await transaction.versions.findSummary(configurationId, versionId))) throw configurationVersionNotFound();
}

/**
 * A write's checks, in the one lock order (Preflight ruling 7): the
 * organization as a member, then the configuration, locked `for update` as
 * the caller sees it, then its version.
 */
async function lockedVersion(
  transaction: TestSuitesTransaction,
  actor: Actor,
  configurationId: string,
  versionId: string,
): Promise<void> {
  await lockAsMember(transaction, actor);
  await lockedConfiguration(transaction, configurationId);
  if (!(await transaction.versions.findSummary(configurationId, versionId))) throw configurationVersionNotFound();
}

/** The version's suite the caller can see, or 404 `test_suite_not_found` (a malformed id included). */
async function suiteIn(
  transaction: TestSuitesTransaction,
  configurationId: string,
  versionId: string,
  suiteId: string | undefined,
): Promise<TestSuite> {
  const suite = suiteId === undefined ? undefined : await transaction.suites.findInVersion(configurationId, versionId, suiteId);
  if (!suite) throw testSuiteNotFound();
  return suite;
}

export function createTestSuiteService(deps: TestSuiteServiceDependencies): ITestSuiteService {
  const { withTransaction, fileStore, now, log } = deps;

  /** Removes an input's bytes, logging (never throwing) a failure: without its row the file is unreachable. */
  async function removeInputQuietly(organizationId: string, inputId: string): Promise<void> {
    try {
      await fileStore.remove(testDefinitionInputKey(organizationId, inputId));
    } catch (error) {
      const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
      log.warn({ code, syscall }, "a test definition input's bytes could not be removed");
    }
  }

  /** An audit row about a suite or a definition, in the active organization: ids only. */
  function audit(
    actor: Actor,
    action: string,
    subject: { type: "test_suite" | "test_definition"; id: string },
    metadata: Record<string, unknown>,
  ) {
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

  return {
    async listSuites(actor, path) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        return transaction.suites.listForVersion(configurationId, versionId, TEST_SUITES_PER_VERSION_MAXIMUM);
      });
    },

    async createSuite(actor, path, input) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        if ((await transaction.suites.countInVersion(configurationId, versionId)) >= TEST_SUITES_PER_VERSION_MAXIMUM) {
          throw testSuiteLimitReached();
        }
        const suite = await transaction.suites.create({
          configurationId,
          versionId,
          name: input.name,
          description: input.description,
          createdByUserId: actor.context.userId,
          at: now(),
        });
        await transaction.audit.record(
          audit(actor, "test_suite.created", { type: "test_suite", id: suite.id }, { configurationId, versionId }),
        );
        return suite;
      });
    },

    async updateSuite(actor, path, suiteId, changes) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const current = await suiteIn(transaction, configurationId, versionId, id);
        // Only the fields that differ from what is there, as a configuration's change.
        const to: { name?: string; description?: string } = {};
        if (changes.name !== undefined && changes.name !== current.name) to.name = changes.name;
        if (changes.description !== undefined && changes.description !== current.description) {
          to.description = changes.description;
        }
        const changedFields = Object.keys(to);
        if (changedFields.length === 0) return current;
        const updated = await transaction.suites.update(current.id, to, now());
        // Visible under the lock just taken: this can't miss.
        if (!updated) throw testSuiteNotFound();
        // The fields' names, never their values (ADR 0024).
        await transaction.audit.record(
          audit(actor, "test_suite.updated", { type: "test_suite", id: current.id }, { configurationId, versionId, changedFields }),
        );
        return updated;
      });
    },

    async removeSuite(actor, path, suiteId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      const freed = await withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const suite = await suiteIn(transaction, configurationId, versionId, id);
        // Its definitions' inputs, read before the delete takes the definitions with it.
        const candidates = await transaction.definitions.inputIdsOfSuite(suite.id);
        if (!(await transaction.suites.remove(suite.id))) throw testSuiteNotFound();
        const freedInputIds = await transaction.inputs.freeUnused(candidates);
        await transaction.audit.record(
          audit(actor, "test_suite.deleted", { type: "test_suite", id: suite.id }, { configurationId, versionId, freedInputIds }),
        );
        return freedInputIds;
      });
      // Committed: the freed inputs' rows are gone, so their bytes are unreachable whatever happens to them now.
      for (const inputId of freed) await removeInputQuietly(actor.context.organizationId, inputId);
    },

    async listDefinitions(actor, path, suiteId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const suite = await suiteIn(transaction, configurationId, versionId, id);
        return transaction.definitions.listForSuite(suite.id, TEST_DEFINITIONS_PER_SUITE_MAXIMUM);
      });
    },

    async createDefinition(actor, path, suiteId, input) {
      assertActiveOrganization(actor, path.organizationId);
      // The store's key names the session's organization, never the path's (Ruling 32).
      const { organizationId } = actor.context;
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      const inputFileId = input.inputFileId === undefined ? undefined : canonicalIdOf(input.inputFileId);
      const templateId = input.templateId === undefined ? undefined : canonicalIdOf(input.templateId);

      // 1. Read in one transaction, committed before any byte is copied.
      const prepared = await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        await suiteIn(transaction, configurationId, versionId, id);
        let source: {
          from: FileKey;
          fileName: string;
          contentType: string;
          audit: { inputFileId: string } | { templateId: string };
        };
        if (input.inputFileId !== undefined) {
          // The caller's own file in this organization only (decision 1), admins included.
          const file = inputFileId === undefined ? undefined : await transaction.files.findOwn(inputFileId);
          if (!file) throw testFileNotFound();
          source = {
            from: testInputKey(actor, file.id),
            fileName: file.fileName,
            contentType: file.contentType,
            audit: { inputFileId: file.id },
          };
        } else {
          const template = templateId === undefined ? undefined : await transaction.templates.findLive(templateId);
          if (!template) throw testTemplateNotFound();
          source = {
            from: { kind: "test-template", templateId: template.id },
            fileName: template.fileName,
            contentType: template.contentType,
            audit: { templateId: template.id },
          };
        }
        return { source, inputId: await transaction.inputs.nextId() };
      });

      const { source, inputId } = prepared;
      const key = testDefinitionInputKey(organizationId, inputId);
      try {
        // 2. The bytes, copied whole or not at all.
        const copied = await fileStore.copy(source.from, key);
        if (!copied.found) throw "inputFileId" in source.audit ? testFileNotFound() : testTemplateNotFound();

        // 3. One transaction, under the locks: the rows and the audit.
        return await withTransaction(actor.context, async (transaction) => {
          await lockedVersion(transaction, actor, configurationId, versionId);
          const suite = await suiteIn(transaction, configurationId, versionId, id);
          if ((await transaction.definitions.countInSuite(suite.id)) >= TEST_DEFINITIONS_PER_SUITE_MAXIMUM) {
            throw testDefinitionLimitReached();
          }
          await transaction.inputs.create({
            id: inputId,
            configurationId,
            fileName: source.fileName,
            contentType: source.contentType,
            sizeBytes: copied.sizeBytes,
            sha256: copied.sha256,
          });
          const definition = await transaction.definitions.create(
            {
              configurationId,
              versionId,
              suiteId: suite.id,
              inputId,
              name: input.name,
              description: input.description,
              pipeline: input.pipeline,
              signal: input.signal,
              durationSeconds: input.durationSeconds,
              createdByUserId: actor.context.userId,
              at: now(),
            },
            source.fileName,
          );
          await transaction.audit.record(
            audit(
              actor,
              "test_definition.created",
              { type: "test_definition", id: definition.id },
              { configurationId, versionId, suiteId: suite.id, inputId, ...source.audit },
            ),
          );
          return definition;
        });
      } catch (error) {
        // 4. Nothing committed: the copy, if any, is unreachable, so it goes.
        await removeInputQuietly(organizationId, inputId);
        throw error;
      }
    },

    async removeDefinition(actor, path, suiteId, definitionId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      const definition = canonicalIdOf(definitionId);
      const freed = await withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const suite = await suiteIn(transaction, configurationId, versionId, id);
        const found = definition === undefined ? undefined : await transaction.definitions.findInSuite(suite.id, definition);
        if (!found) throw testDefinitionNotFound();
        const removed = await transaction.definitions.remove(found.id);
        // Visible under the lock just taken: this can't miss.
        if (!removed) throw testDefinitionNotFound();
        const freedInputIds = await transaction.inputs.freeUnused([removed.inputId]);
        await transaction.audit.record(
          audit(
            actor,
            "test_definition.deleted",
            { type: "test_definition", id: found.id },
            { configurationId, versionId, suiteId: suite.id, inputId: removed.inputId, freedInputIds },
          ),
        );
        return freedInputIds;
      });
      // Committed: as a suite delete's.
      for (const inputId of freed) await removeInputQuietly(actor.context.organizationId, inputId);
    },

    async openDefinitionInputHead(actor, path, suiteId, definitionId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(suiteId);
      const definitionKey = canonicalIdOf(definitionId);
      const inputId = await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const suite = await suiteIn(transaction, configurationId, versionId, id);
        const definition =
          definitionKey === undefined ? undefined : await transaction.definitions.findInSuite(suite.id, definitionKey);
        if (!definition) throw testDefinitionNotFound();
        return definition.inputId;
      });
      const opened = await fileStore.read(testDefinitionInputKey(actor.context.organizationId, inputId));
      if (!opened.found) throw testDefinitionNotFound();
      return {
        sizeBytes: Math.min(opened.sizeBytes, TEST_FILE_HEAD_MAXIMUM_BYTES),
        stream: firstBytes(opened.stream, TEST_FILE_HEAD_MAXIMUM_BYTES),
      };
    },
  };
}
