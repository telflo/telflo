import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, TestRunSignal, TestTemplatesTable } from "@telflo/db";

/*
 * Test templates (D14b decisions 3 and 13; Preflight rulings 4 and 11;
 * migration 1700000000029): a product-wide library of sample inputs, their
 * bytes in the FileStore at global/test-templates/<id>.
 *
 * A global repository (ADR 0008; the resource registry's `kind: "global"`),
 * as flows': every organization picks from the same templates, so there is
 * no organization scope and no row-level security. Whether a caller may
 * write is the service's question (product admins only, requireProductAdmin
 * on the routes). A template is deleted softly (`deleted_at`; the API's
 * role has no DELETE): a deleted one is found by nothing here, and changed
 * by nothing here.
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`, as
 * flows' do.
 */

/** A live template. Its name, description and file name are configuration text (ADR 0024). */
export interface TestTemplate {
  id: string;
  name: string;
  description: string;
  receiverType: string;
  signal: TestRunSignal;
  /** The upload's own name, with its extension. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** The bytes' SHA-256, lower-case hex. */
  sha256: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A new template: its id chosen before its bytes were written (nextId), and the bytes' size and SHA-256 as stored. */
export interface NewTestTemplate {
  id: string;
  name: string;
  description: string;
  receiverType: string;
  signal: TestRunSignal;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Lower-case hex, as the FileStore computed it while writing. */
  sha256: string;
  createdByUserId: string;
  at: Date;
}

/** A change to a template's metadata: the fields given. The file never changes. */
export interface TestTemplateChanges {
  name?: string;
  description?: string;
  receiverType?: string;
  signal?: TestRunSignal;
}

export interface ITestTemplateRepository {
  /** A live template (`deleted_at` null); undefined when there is none, or it is deleted. */
  findLive(id: string): Promise<TestTemplate | undefined>;
  /** A new template's id (uuidv7), chosen before its bytes are written, since they are stored under it. */
  nextId(): Promise<string>;
  /** The live templates, newest first (created_at, then id, both descending), at most `limit`. */
  listLive(limit: number): Promise<TestTemplate[]>;
  /** Inserts a template. */
  create(input: NewTestTemplate): Promise<TestTemplate>;
  /** A live template, locked `for update` until the transaction ends; undefined when there is none. */
  lockLive(id: string): Promise<TestTemplate | undefined>;
  /** Changes a live template's metadata and `updated_at`; undefined when there is none. */
  update(id: string, changes: TestTemplateChanges, at: Date): Promise<TestTemplate | undefined>;
  /** Deletes a live template softly (`deleted_at` = `at`); false when there is none, or it is deleted already. */
  softDelete(id: string, at: Date): Promise<boolean>;
}

function toTestTemplate(row: Selectable<TestTemplatesTable>): TestTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    receiverType: row.receiver_type,
    signal: row.signal,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256.toString("hex"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTestTemplateRepository(db: Kysely<Database> | Transaction<Database>): ITestTemplateRepository {
  return {
    async findLive(id) {
      const row = await db
        .selectFrom("test_templates")
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row ? toTestTemplate(row) : undefined;
    },

    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(db);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("uuidv7() returned no row");
      return id;
    },

    async listLive(limit) {
      const rows = await db
        .selectFrom("test_templates")
        .selectAll()
        .where("deleted_at", "is", null)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toTestTemplate);
    },

    async create(input) {
      const row = await db
        .insertInto("test_templates")
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          receiver_type: input.receiverType,
          signal: input.signal,
          file_name: input.fileName,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          sha256: Buffer.from(input.sha256, "hex"),
          created_by_user_id: input.createdByUserId,
          created_at: input.at,
          updated_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toTestTemplate(row);
    },

    async lockLive(id) {
      const row = await db
        .selectFrom("test_templates")
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      return row ? toTestTemplate(row) : undefined;
    },

    async update(id, changes, at) {
      const row = await db
        .updateTable("test_templates")
        .set({
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.receiverType === undefined ? {} : { receiver_type: changes.receiverType }),
          ...(changes.signal === undefined ? {} : { signal: changes.signal }),
          updated_at: at,
        })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      return row ? toTestTemplate(row) : undefined;
    },

    async softDelete(id, at) {
      const row = await db
        .updateTable("test_templates")
        .set({ deleted_at: at })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
