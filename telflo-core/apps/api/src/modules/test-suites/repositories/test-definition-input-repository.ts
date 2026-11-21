import { sql, type Selectable, type Transaction } from "kysely";
import type { Database, TestDefinitionInputsTable } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * Test definitions' inputs: each a copy made when a definition is created, its
 * bytes in the FileStore at organizations/<org>/test-definition-inputs/<id>,
 * shared by the definitions of a configuration's version copies. Through the
 * organization scope, as the context's user sees them: an input is visible
 * exactly when its configuration is (migration 029's select policy), and a
 * deleted configuration's are hidden.
 *
 * An input never changes. It is freed, row then bytes, once no definition
 * names it: `freeUnused` runs under the configuration's lock (the service's
 * lockAsMember, then lockedConfiguration), which every path that adds or
 * removes a reference takes, so "no definition names it" can't change under
 * it. fk_test_definitions_input, deferred, refuses the commit of any path
 * that forgets the lock.
 */

/** Whom the repository reads for: the organization, and the viewer whose drafts' inputs it shows. An `AuthContext` is one. */
export type TestDefinitionInputViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** An input. Its file name is configuration text. */
export interface TestDefinitionInput {
  id: string;
  configurationId: string;
  /** The original file's name, with its extension. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** The bytes' SHA-256, lower-case hex. */
  sha256: string;
  createdAt: Date;
}

export interface CreateTestDefinitionInputInput {
  /** Chosen before the bytes are copied (nextId), since they are stored under it. */
  id: string;
  configurationId: string;
  fileName: string;
  contentType: string;
  /** As the FileStore's copy counted them. */
  sizeBytes: number;
  /** Lower-case hex, as the FileStore's copy computed it. */
  sha256: string;
}

export interface ITestDefinitionInputRepository {
  /** A new id, uuidv7 by the database's clock, for an input whose bytes are copied before its row. */
  nextId(): Promise<string>;
  /** An input the viewer can see; undefined otherwise. */
  find(id: string): Promise<TestDefinitionInput | undefined>;
  /** A new input on the configuration, created now by the database's clock. */
  create(input: CreateTestDefinitionInputInput): Promise<TestDefinitionInput>;
  /**
   * Deletes each of `ids` the viewer can see that no definition names, and
   * answers the ids deleted: the reference count's free. Run it under the
   * configuration's lock, after the definitions' delete.
   */
  freeUnused(ids: readonly string[]): Promise<string[]>;
}

function toTestDefinitionInput(row: Selectable<TestDefinitionInputsTable>): TestDefinitionInput {
  return {
    id: row.id,
    configurationId: row.configuration_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256.toString("hex"),
    createdAt: row.created_at,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createTestDefinitionInputRepository(
  transaction: Transaction<Database>,
  context: TestDefinitionInputViewerContext,
): ITestDefinitionInputRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /** The inputs the viewer can see: joined to their live configuration, which they created or which is published. */
  const visible = () =>
    scope
      .selectFrom("test_definition_inputs")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "test_definition_inputs.configuration_id")
          .onRef("configurations.organization_id", "=", "test_definition_inputs.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  return {
    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(transaction);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("uuidv7() returned no row");
      return id;
    },

    async find(id) {
      const row = await visible()
        .selectAll("test_definition_inputs")
        .where("test_definition_inputs.id", "=", id)
        .executeTakeFirst();
      return row ? toTestDefinitionInput(row) : undefined;
    },

    async create(input) {
      const row = await scope
        .insertInto("test_definition_inputs", {
          id: input.id,
          configuration_id: input.configurationId,
          file_name: input.fileName,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          sha256: Buffer.from(input.sha256, "hex"),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTestDefinitionInput(row);
    },

    async freeUnused(ids) {
      if (ids.length === 0) return [];
      const rows = await scope
        .deleteFrom("test_definition_inputs")
        .where("test_definition_inputs.id", "in", [...ids])
        .where(
          sql<boolean>`exists (
            select 1 from configurations
             where configurations.id = test_definition_inputs.configuration_id
               and configurations.organization_id = test_definition_inputs.organization_id
               and configurations.deleted_at is null
               and ${visibleTo(viewer)})`,
        )
        .where(sql<boolean>`not exists (select 1 from test_definitions d where d.input_id = test_definition_inputs.id)`)
        .returning("test_definition_inputs.id")
        .execute();
      return rows.map((row) => row.id).sort();
    },
  };
}
