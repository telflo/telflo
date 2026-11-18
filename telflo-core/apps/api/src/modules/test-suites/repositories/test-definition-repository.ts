import { sql, type Transaction } from "kysely";
import type { Database, TestRunSignal } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * A suite's test definitions (D14b decisions 2 and 9, Preflight rulings 3
 * and 23), through the organization
 * scope, as the context's user sees them: a definition is visible exactly
 * when its configuration is (migration 029's select policy), and a deleted
 * configuration's are hidden. Each is read with its input's file name, the
 * name a run from it takes.
 *
 * A definition is created and deleted, never changed (decision 2): there is
 * no update. Both writes are made under the configuration's lock (the
 * service's lockAsMember, then lockedConfiguration; Preflight ruling 7), the
 * delete answering the input it named, which the caller then frees if no
 * other definition names it.
 */

/** Whom the repository reads for: the organization, and the viewer whose drafts' definitions it shows. An `AuthContext` is one. */
export type TestDefinitionViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A definition. Its name, description and input's name are configuration text (ADR 0024). */
export interface TestDefinition {
  id: string;
  configurationId: string;
  versionId: string;
  suiteId: string;
  inputId: string;
  /** Its input's original file name, with its extension. */
  inputName: string;
  name: string;
  description: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  /** Null once the creator's account is hard-deleted. */
  createdByUserId: string | null;
  createdAt: Date;
}

/** A definition as a run from it reads it (D14b Preflight ruling 10): with its suite's name, for the run's breadcrumb. */
export interface TestDefinitionForRun extends TestDefinition {
  /** Its suite's name, as it is now. Configuration text. */
  suiteName: string;
}

export interface CreateTestDefinitionInput {
  configurationId: string;
  versionId: string;
  suiteId: string;
  /** An input of the same configuration (fk_test_definitions_input, checked at commit). */
  inputId: string;
  name: string;
  description: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  /** The context's user: the insert policy admits no one else. */
  createdByUserId: string;
  /** From the API's clock. */
  at: Date;
}

export interface ITestDefinitionRepository {
  /** The suite's definitions the viewer can see, oldest first (created_at, then id), at most `limit`. */
  listForSuite(suiteId: string, limit: number): Promise<TestDefinition[]>;
  /** A definition the viewer can see, by id alone; undefined otherwise. */
  find(id: string): Promise<TestDefinition | undefined>;
  /** A definition the viewer can see in that suite; undefined otherwise. */
  findInSuite(suiteId: string, id: string): Promise<TestDefinition | undefined>;
  /**
   * A definition the viewer can see on that configuration's version, with
   * its suite's name: a run's source (D14b Preflight ruling 10). Undefined
   * for anything else: another version's or configuration's, another
   * member's draft's, a deleted configuration's, an unknown one.
   */
  findForRun(configurationId: string, versionId: string, id: string): Promise<TestDefinitionForRun | undefined>;
  /** How many definitions the suite has: the cap's count (Preflight ruling 23), read under the configuration's lock. */
  countInSuite(suiteId: string): Promise<number>;
  /** The distinct inputs the suite's definitions name: a suite delete's candidates to free (Preflight ruling 7). */
  inputIdsOfSuite(suiteId: string): Promise<string[]>;
  /** A new definition; answered with `inputName`, its input's name, which the caller knows. */
  create(input: CreateTestDefinitionInput, inputName: string): Promise<TestDefinition>;
  /** Deletes a visible definition, answering the input it named; undefined when there is none. */
  remove(id: string): Promise<{ inputId: string } | undefined>;
}

/** The columns a definition is read with: its own, and its input's file name. */
const definitionColumns = [
  "test_definitions.id",
  "test_definitions.configuration_id",
  "test_definitions.configuration_version_id",
  "test_definitions.test_suite_id",
  "test_definitions.input_id",
  "test_definitions.name",
  "test_definitions.description",
  "test_definitions.target_pipeline",
  "test_definitions.signal",
  "test_definitions.duration_seconds",
  "test_definitions.created_by_user_id",
  "test_definitions.created_at",
  "test_definition_inputs.file_name as input_name",
] as const;

interface DefinitionRow {
  id: string;
  configuration_id: string;
  configuration_version_id: string;
  test_suite_id: string;
  input_id: string;
  name: string;
  description: string;
  target_pipeline: string;
  signal: TestRunSignal;
  duration_seconds: number;
  created_by_user_id: string | null;
  created_at: Date;
  input_name: string;
}

function toTestDefinition(row: DefinitionRow): TestDefinition {
  return {
    id: row.id,
    configurationId: row.configuration_id,
    versionId: row.configuration_version_id,
    suiteId: row.test_suite_id,
    inputId: row.input_id,
    inputName: row.input_name,
    name: row.name,
    description: row.description,
    pipeline: row.target_pipeline,
    signal: row.signal,
    durationSeconds: row.duration_seconds,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createTestDefinitionRepository(
  transaction: Transaction<Database>,
  context: TestDefinitionViewerContext,
): ITestDefinitionRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /**
   * The definitions the viewer can see, with their inputs: joined to their
   * live configuration, which they created or which is published.
   */
  const visible = () =>
    scope
      .selectFrom("test_definitions")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "test_definitions.configuration_id")
          .onRef("configurations.organization_id", "=", "test_definitions.organization_id"),
      )
      .innerJoin("test_definition_inputs", (join) =>
        join
          .onRef("test_definition_inputs.id", "=", "test_definitions.input_id")
          .onRef("test_definition_inputs.configuration_id", "=", "test_definitions.configuration_id")
          .onRef("test_definition_inputs.organization_id", "=", "test_definitions.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  return {
    async listForSuite(suiteId, limit) {
      const rows = await visible()
        .select(definitionColumns)
        .where("test_definitions.test_suite_id", "=", suiteId)
        .orderBy("test_definitions.created_at", "asc")
        .orderBy("test_definitions.id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toTestDefinition);
    },

    async find(id) {
      const row = await visible().select(definitionColumns).where("test_definitions.id", "=", id).executeTakeFirst();
      return row ? toTestDefinition(row) : undefined;
    },

    async findInSuite(suiteId, id) {
      const row = await visible()
        .select(definitionColumns)
        .where("test_definitions.id", "=", id)
        .where("test_definitions.test_suite_id", "=", suiteId)
        .executeTakeFirst();
      return row ? toTestDefinition(row) : undefined;
    },

    async findForRun(configurationId, versionId, id) {
      const row = await visible()
        .innerJoin("test_suites", (join) =>
          join
            .onRef("test_suites.id", "=", "test_definitions.test_suite_id")
            .onRef("test_suites.configuration_version_id", "=", "test_definitions.configuration_version_id")
            .onRef("test_suites.configuration_id", "=", "test_definitions.configuration_id")
            .onRef("test_suites.organization_id", "=", "test_definitions.organization_id"),
        )
        .select(definitionColumns)
        .select("test_suites.name as suite_name")
        .where("test_definitions.id", "=", id)
        .where("test_definitions.configuration_id", "=", configurationId)
        .where("test_definitions.configuration_version_id", "=", versionId)
        .executeTakeFirst();
      return row ? { ...toTestDefinition(row), suiteName: row.suite_name } : undefined;
    },

    async countInSuite(suiteId) {
      const row = await scope
        .selectFrom("test_definitions")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .where("test_definitions.test_suite_id", "=", suiteId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async inputIdsOfSuite(suiteId) {
      const rows = await scope
        .selectFrom("test_definitions")
        .select("test_definitions.input_id")
        .distinct()
        .where("test_definitions.test_suite_id", "=", suiteId)
        .execute();
      return rows.map((row) => row.input_id).sort();
    },

    async create(input, inputName) {
      const row = await scope
        .insertInto("test_definitions", {
          configuration_id: input.configurationId,
          configuration_version_id: input.versionId,
          test_suite_id: input.suiteId,
          input_id: input.inputId,
          name: input.name,
          description: input.description,
          target_pipeline: input.pipeline,
          signal: input.signal,
          duration_seconds: input.durationSeconds,
          created_by_user_id: input.createdByUserId,
          created_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTestDefinition({ ...row, input_name: inputName });
    },

    async remove(id) {
      const row = await scope
        .deleteFrom("test_definitions")
        .where("test_definitions.id", "=", id)
        .where(
          sql<boolean>`exists (
            select 1 from configurations
             where configurations.id = test_definitions.configuration_id
               and configurations.organization_id = test_definitions.organization_id
               and configurations.deleted_at is null
               and ${visibleTo(viewer)})`,
        )
        .returning("test_definitions.input_id")
        .executeTakeFirst();
      return row ? { inputId: row.input_id } : undefined;
    },
  };
}
