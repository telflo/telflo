import { sql, type Selectable, type Transaction } from "kysely";
import type { Database, TestSuitesTable } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * A configuration version's test suites (D14b decisions 5 and 8, Preflight
 * rulings 1 and 23), through the organization scope, as the context's user
 * sees them: a suite is visible exactly when its configuration is (their own
 * draft, or a published one), by the configurations' own rule
 * (`visibleTo`), which is migration 029's select policy (028's
 * childVisible). A deleted configuration's suites are hidden, as its runs
 * are. Row-level security stands behind it, so the transaction must carry a
 * database context naming the same organization and user.
 *
 * Every write here is made under the configuration's lock (the service's
 * lockAsMember, then lockedConfiguration; Preflight ruling 7), so a count
 * read here holds until the transaction ends.
 */

/** Whom the repository reads for: the organization, and the viewer whose drafts' suites it shows. An `AuthContext` is one. */
export type TestSuiteViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A suite. Its name and description are configuration text (ADR 0024). */
export interface TestSuite {
  id: string;
  configurationId: string;
  versionId: string;
  name: string;
  description: string;
  /** Null once the creator's account is hard-deleted. */
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTestSuiteInput {
  configurationId: string;
  versionId: string;
  /** Trimmed, 1 to 200 characters: the contract does it, and the table refuses anything else. */
  name: string;
  /** At most 2,000 characters; `''` for none. */
  description: string;
  /** The context's user: the insert policy admits no one else. */
  createdByUserId: string;
  /** Created and updated at this time, from the API's clock. */
  at: Date;
}

/** What a version copy wrote (D14b Preflight ruling 8): counts only. */
export interface CopiedTestSuites {
  suites: number;
  definitions: number;
}

/** A suite's changeable fields; a field left out stays as it is. */
export interface TestSuiteChanges {
  name?: string;
  description?: string;
}

export interface ITestSuiteRepository {
  /** The version's suites the viewer can see, oldest first (created_at, then id), at most `limit`. */
  listForVersion(configurationId: string, versionId: string, limit: number): Promise<TestSuite[]>;
  /** A suite the viewer can see, by id alone; undefined otherwise. */
  find(id: string): Promise<TestSuite | undefined>;
  /** A suite the viewer can see on that configuration's version; undefined otherwise (another version's included). */
  findInVersion(configurationId: string, versionId: string, id: string): Promise<TestSuite | undefined>;
  /** How many suites the version has: the cap's count (Preflight ruling 23), read under the configuration's lock. */
  countInVersion(configurationId: string, versionId: string): Promise<number>;
  /** A new suite on the version. */
  create(input: CreateTestSuiteInput): Promise<TestSuite>;
  /** Sets the fields given and `updated_at` to `at` on a visible suite; undefined when there is none. */
  update(id: string, changes: TestSuiteChanges, at: Date): Promise<TestSuite | undefined>;
  /** Deletes a visible suite (its definitions go with it, fk_test_definitions_suite). False when there is none. */
  remove(id: string): Promise<boolean>;
  /**
   * A new version's copy of its source's suites and definitions (D14b
   * decisions 4 and 12, Preflight ruling 8), in one statement, as the
   * context's user under row-level security: every suite of
   * `fromVersionId` the viewer can see, in its (created_at, id) order, each
   * under a new uuidv7(), then their definitions in (the suite's place,
   * created_at, id) order, naming the same inputs (no byte is copied). The
   * copies' creator is the context's user and their times `at`, the
   * version's; both versions are the configuration's. Run it under the
   * configuration's lock (createVersion's), which every path that adds or
   * removes a definition's reference to an input takes (ruling 7). Runs
   * are never copied.
   */
  copyToVersion(configurationId: string, fromVersionId: string, toVersionId: string, at: Date): Promise<CopiedTestSuites>;
}

function toTestSuite(row: Selectable<TestSuitesTable>): TestSuite {
  return {
    id: row.id,
    configurationId: row.configuration_id,
    versionId: row.configuration_version_id,
    name: row.name,
    description: row.description,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createTestSuiteRepository(
  transaction: Transaction<Database>,
  context: TestSuiteViewerContext,
): ITestSuiteRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /** The suites the viewer can see: joined to their live configuration, which they created or which is published. */
  const visible = () =>
    scope
      .selectFrom("test_suites")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "test_suites.configuration_id")
          .onRef("configurations.organization_id", "=", "test_suites.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /** The same rule for a write's `where`: the suite's configuration, live and visible. */
  const isVisible = sql<boolean>`exists (
    select 1 from configurations
     where configurations.id = test_suites.configuration_id
       and configurations.organization_id = test_suites.organization_id
       and configurations.deleted_at is null
       and ${visibleTo(viewer)})`;

  return {
    async listForVersion(configurationId, versionId, limit) {
      const rows = await visible()
        .selectAll("test_suites")
        .where("test_suites.configuration_id", "=", configurationId)
        .where("test_suites.configuration_version_id", "=", versionId)
        .orderBy("test_suites.created_at", "asc")
        .orderBy("test_suites.id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toTestSuite);
    },

    async find(id) {
      const row = await visible().selectAll("test_suites").where("test_suites.id", "=", id).executeTakeFirst();
      return row ? toTestSuite(row) : undefined;
    },

    async findInVersion(configurationId, versionId, id) {
      const row = await visible()
        .selectAll("test_suites")
        .where("test_suites.id", "=", id)
        .where("test_suites.configuration_id", "=", configurationId)
        .where("test_suites.configuration_version_id", "=", versionId)
        .executeTakeFirst();
      return row ? toTestSuite(row) : undefined;
    },

    async countInVersion(configurationId, versionId) {
      const row = await scope
        .selectFrom("test_suites")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .where("test_suites.configuration_id", "=", configurationId)
        .where("test_suites.configuration_version_id", "=", versionId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async create(input) {
      const row = await scope
        .insertInto("test_suites", {
          configuration_id: input.configurationId,
          configuration_version_id: input.versionId,
          name: input.name,
          description: input.description,
          created_by_user_id: input.createdByUserId,
          created_at: input.at,
          updated_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTestSuite(row);
    },

    async update(id, changes, at) {
      const row = await scope
        .updateTable("test_suites", {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          updated_at: at,
        })
        .where("test_suites.id", "=", id)
        .where(isVisible)
        .returningAll()
        .executeTakeFirst();
      return row ? toTestSuite(row) : undefined;
    },

    async remove(id) {
      const result = await scope
        .deleteFrom("test_suites")
        .where("test_suites.id", "=", id)
        .where(isVisible)
        .executeTakeFirst();
      return result.numDeletedRows === 1n;
    },

    async copyToVersion(configurationId, fromVersionId, toVersionId, at) {
      // The map is materialized in the source's order, so each new id is
      // taken in that order: Postgres 18's uuidv7() rises within a backend,
      // and the copies' (created_at, id) order is the source's, with every
      // copy at one created_at (Preflight ruling 8). The definitions are
      // inserted in (the suite's place, created_at, id) order, so their
      // ids, the table's default uuidv7(), rise the same way. The select
      // policies show the viewer only what they may see, and the insert
      // policies admit the viewer alone as the creator.
      const organizationId = context.organizationId;
      const { rows } = await sql<{ suites: number; definitions: number }>`
        with map as materialized (
          select ordered.id as old_id, uuidv7() as new_id, ordered.position
            from (select s.id, row_number() over (order by s.created_at, s.id) as position
                    from test_suites s
                   where s.organization_id = ${organizationId}
                     and s.configuration_id = ${configurationId}
                     and s.configuration_version_id = ${fromVersionId}
                   order by s.created_at, s.id) ordered
           order by ordered.position
        ), suites as (
          insert into test_suites
            (id, organization_id, configuration_id, configuration_version_id,
             name, description, created_by_user_id, created_at, updated_at)
          select m.new_id, s.organization_id, s.configuration_id, ${toVersionId},
                 s.name, s.description, ${viewer}, ${at}, ${at}
            from map m join test_suites s on s.id = m.old_id
           order by m.position
          returning id
        ), definitions as (
          insert into test_definitions
            (organization_id, configuration_id, configuration_version_id, test_suite_id, input_id,
             name, description, target_pipeline, signal, duration_seconds, created_by_user_id, created_at)
          select d.organization_id, d.configuration_id, ${toVersionId}, m.new_id, d.input_id,
                 d.name, d.description, d.target_pipeline, d.signal, d.duration_seconds, ${viewer}, ${at}
            from map m join test_definitions d on d.test_suite_id = m.old_id
           order by m.position, d.created_at, d.id
          returning id
        )
        select (select count(*) from suites)::integer as suites,
               (select count(*) from definitions)::integer as definitions
      `.execute(transaction);
      const copied = rows[0];
      if (copied === undefined) throw new Error("the version copy returned no row");
      return { suites: copied.suites, definitions: copied.definitions };
    },
  };
}
