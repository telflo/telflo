import { sql, type Selectable, type Transaction } from "kysely";
import type { Database, TestInputFilesTable } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";

/*
 * A person's test files in the context's organization, "My Files" (D14a
 * decision 7), through the organization scope and narrowed to the
 * context's user: every method reads, adds and removes only that person's
 * own files. Row-level security on test_input_files (migration 028) stands
 * behind it with the same rule, so the transaction must carry a database
 * context naming the same organization and user.
 *
 * A file never changes: there is no update. Its bytes are the FileStore's
 * (`test-input` keys); this holds the row the list shows.
 */

/** Whom the repository acts for: the organization and the person whose files it holds. An `AuthContext` is one. */
export type TestInputFileOwnerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A test file, as its owner's list shows it. Its names and description are private text (ADR 0024). */
export interface TestInputFile {
  id: string;
  displayName: string;
  fileName: string;
  description: string;
  contentType: string;
  sizeBytes: number;
  /** The bytes' SHA-256, lower-case hex. */
  sha256: string;
  createdAt: Date;
}

export interface CreateTestInputFileInput {
  /** Chosen before the bytes are written (nextId), since they are stored under it. */
  id: string;
  /** Trimmed, 1 to 200 characters: the contract does it, and the table refuses anything else. */
  displayName: string;
  fileName: string;
  description: string;
  contentType: string;
  sizeBytes: number;
  /** Lower-case hex, as the FileStore computed it while writing. */
  sha256: string;
}

export interface ITestInputFileRepository {
  /** A new id, uuidv7 by the database's clock, for a file whose bytes are written before its row. */
  nextId(): Promise<string>;
  /** The person's files in the organization, newest first, at most `limit`. */
  listOwn(limit: number): Promise<TestInputFile[]>;
  /** The person's own file; undefined when there is none, or it is anyone else's. */
  findOwn(id: string): Promise<TestInputFile | undefined>;
  /** A new file of the person's, created now by the database's clock. */
  create(input: CreateTestInputFileInput): Promise<TestInputFile>;
  /** Deletes the person's own file's row. False when there is none (or it is anyone else's). */
  removeOwn(id: string): Promise<boolean>;
}

function toTestInputFile(row: Selectable<TestInputFilesTable>): TestInputFile {
  return {
    id: row.id,
    displayName: row.display_name,
    fileName: row.file_name,
    description: row.description,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256.toString("hex"),
    createdAt: row.created_at,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createTestInputFileRepository(
  transaction: Transaction<Database>,
  context: TestInputFileOwnerContext,
): ITestInputFileRepository {
  const scope = createOrganizationScope(transaction, context);
  const owner = context.userId;
  const own = () => scope.selectFrom("test_input_files").where("test_input_files.owner_user_id", "=", owner);

  return {
    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(transaction);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("uuidv7() returned no row");
      return id;
    },

    async listOwn(limit) {
      const rows = await own()
        .selectAll()
        .orderBy("test_input_files.created_at", "desc")
        .orderBy("test_input_files.id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toTestInputFile);
    },

    async findOwn(id) {
      const row = await own().selectAll().where("test_input_files.id", "=", id).executeTakeFirst();
      return row ? toTestInputFile(row) : undefined;
    },

    async create(input) {
      const row = await scope
        .insertInto("test_input_files", {
          id: input.id,
          owner_user_id: owner,
          display_name: input.displayName,
          file_name: input.fileName,
          description: input.description,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          sha256: Buffer.from(input.sha256, "hex"),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTestInputFile(row);
    },

    async removeOwn(id) {
      const result = await scope
        .deleteFrom("test_input_files")
        .where("test_input_files.owner_user_id", "=", owner)
        .where("test_input_files.id", "=", id)
        .executeTakeFirst();
      return result.numDeletedRows === 1n;
    },
  };
}
