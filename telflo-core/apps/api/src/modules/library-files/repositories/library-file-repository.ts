import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, LibraryFilesTable } from "@telflo/db";

/*
 * Library files (migration 1700000000037): the global library of helper
 * files, their bytes in the file store at global/library-files/<id>.
 *
 * A global repository (the resource registry's `kind: "global"`),
 * as test templates': every member reads the same files, so there is no
 * organization scope and no row-level security. Whether a caller may write
 * is the service's question (product admins only, requireProductAdmin on the
 * routes). A file is deleted hard.
 *
 * Every timestamp comes from the caller, as `at`, never from SQL `now()`.
 */

/** A library file. Its name, description and file name are Telflo's own content. */
export interface LibraryFile {
  id: string;
  name: string;
  description: string;
  /** The upload's own name. */
  fileName: string;
  sizeBytes: number;
  /** The bytes' SHA-256, lower-case hex. */
  sha256: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A new file: its id chosen before its bytes were written (nextId), and the bytes' size and SHA-256 as stored. */
export interface NewLibraryFile {
  id: string;
  name: string;
  description: string;
  fileName: string;
  sizeBytes: number;
  /** Lower-case hex, as the file store computed it while writing. */
  sha256: string;
  createdByUserId: string;
  at: Date;
}

/** A change to a file's name or description: the fields given. The file never changes. */
export interface LibraryFileChanges {
  name?: string;
  description?: string;
}

export interface ILibraryFileRepository {
  /** A file; undefined when there is none. */
  find(id: string): Promise<LibraryFile | undefined>;
  /** A new file's id (uuidv7), chosen before its bytes are written, since they are stored under it. */
  nextId(): Promise<string>;
  /** The files, newest first (created_at, then id, both descending), at most `limit`. */
  list(limit: number): Promise<LibraryFile[]>;
  /** Inserts a file. */
  create(input: NewLibraryFile): Promise<LibraryFile>;
  /** A file, locked `for update` until the transaction ends; undefined when there is none. */
  lock(id: string): Promise<LibraryFile | undefined>;
  /** Changes a file's name or description and `updated_at`; undefined when there is none. */
  update(id: string, changes: LibraryFileChanges, at: Date): Promise<LibraryFile | undefined>;
  /** Deletes a file's row; false when there is none. */
  remove(id: string): Promise<boolean>;
}

function toLibraryFile(row: Selectable<LibraryFilesTable>): LibraryFile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256.toString("hex"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLibraryFileRepository(db: Kysely<Database> | Transaction<Database>): ILibraryFileRepository {
  return {
    async find(id) {
      const row = await db.selectFrom("library_files").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? toLibraryFile(row) : undefined;
    },

    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(db);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("uuidv7() returned no row");
      return id;
    },

    async list(limit) {
      const rows = await db
        .selectFrom("library_files")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toLibraryFile);
    },

    async create(input) {
      const row = await db
        .insertInto("library_files")
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          file_name: input.fileName,
          size_bytes: input.sizeBytes,
          sha256: Buffer.from(input.sha256, "hex"),
          created_by_user_id: input.createdByUserId,
          created_at: input.at,
          updated_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toLibraryFile(row);
    },

    async lock(id) {
      const row = await db.selectFrom("library_files").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      return row ? toLibraryFile(row) : undefined;
    },

    async update(id, changes, at) {
      const row = await db
        .updateTable("library_files")
        .set({
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          updated_at: at,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
      return row ? toLibraryFile(row) : undefined;
    },

    async remove(id) {
      const row = await db.deleteFrom("library_files").where("id", "=", id).returning("id").executeTakeFirst();
      return row !== undefined;
    },
  };
}
