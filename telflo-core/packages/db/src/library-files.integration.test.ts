import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { addLibraryFile, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "./testing.js";

/*
 * Migration 1700000000037 (D23-2 decisions 19, 21 and 28; Preflight ruling
 * 13): the global library of helper files. Its up, down and up again are
 * schema.integration.test.ts's ("the library files migration …"); the
 * resource registry's global entry is apps/api's cross-tenant suite's.
 * Here: every check, the guard trigger (P0001 for the tables' owner too),
 * the defaults, the creator's set null and the API's role's hard delete.
 */

/** A check's or the guard's refusal, by the name Postgres reports. */
const refusedBy = (constraint: string) => ({ code: "23514", constraint });

describe("library files (migration 1700000000037)", () => {
  let databases: TestDatabases;
  /** The API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  it("takes a file at every bound: a 200-character name, a 2,000-character description, a 255-character file name, 0 and 10,485,760 bytes", async () => {
    const at = new Date(Date.UTC(2026, 9, 24, 9, 0, 0));
    const largest = await addLibraryFile(ownerDb, {
      name: "x".repeat(200),
      description: "y".repeat(2000),
      file_name: "f".repeat(255),
      size_bytes: 10_485_760,
      created_at: at,
      updated_at: at,
    });
    expect(largest).toMatchObject({ size_bytes: 10_485_760, created_at: at, updated_at: at, created_by_user_id: null });
    expect(largest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    const smallest = await addLibraryFile(ownerDb, { name: "a", file_name: "b", size_bytes: 0 });
    expect(smallest.description).toBe("");
  });

  it("defaults the id to a uuidv7, the description to '' and both times to now()", async () => {
    const row = await ownerDb
      .insertInto("library_files")
      .values({ name: "Defaults", file_name: "d.txt", size_bytes: 1, sha256: createHash("sha256").update("d").digest() } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(row.description).toBe("");
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it.each([
    ["an untrimmed name", { name: " Guide" }, "ck_library_files_name"],
    ["a name with a trailing space", { name: "Guide " }, "ck_library_files_name"],
    ["an empty name", { name: "" }, "ck_library_files_name"],
    ["a 201-character name", { name: "x".repeat(201) }, "ck_library_files_name"],
    ["a 2,001-character description", { description: "y".repeat(2001) }, "ck_library_files_description"],
    ["an empty file name", { file_name: "" }, "ck_library_files_file_name"],
    ["a 256-character file name", { file_name: "f".repeat(256) }, "ck_library_files_file_name"],
    ["a negative size", { size_bytes: -1 }, "ck_library_files_size_bytes"],
    ["10,485,761 bytes", { size_bytes: 10_485_761 }, "ck_library_files_size_bytes"],
    ["a 31-byte SHA-256", { sha256: Buffer.alloc(31) }, "ck_library_files_sha256"],
    ["a 33-byte SHA-256", { sha256: Buffer.alloc(33) }, "ck_library_files_sha256"],
  ])("refuses %s (%s)", async (_label, overrides, constraint) => {
    await expect(addLibraryFile(ownerDb, overrides)).rejects.toMatchObject(refusedBy(constraint));
  });

  it("refuses a creator who isn't a user (23503)", async () => {
    await expect(addLibraryFile(ownerDb, { created_by_user_id: randomUUID() })).rejects.toMatchObject({
      code: "23503",
      constraint: "library_files_created_by_user_id_fkey",
    });
  });

  it("keeps a file's bytes' columns and its creator (P0001, for the tables' owner and the API's role), and lets its name, description and updated_at change", async () => {
    const creator = (await createUserWithOrganization(ownerDb)).user.id;
    const file = await addLibraryFile(ownerDb, { created_by_user_id: creator });
    const other = (await createUserWithOrganization(ownerDb)).user.id;
    const changes: Record<string, unknown> = {
      id: randomUUID(),
      file_name: "other.txt",
      size_bytes: 1,
      sha256: createHash("sha256").update("other").digest(),
      created_at: new Date(Date.UTC(2020, 0, 1)),
      created_by_user_id: other,
    };
    for (const connection of [ownerDb, db]) {
      for (const [column, value] of Object.entries(changes)) {
        await expect(
          connection
            .updateTable("library_files")
            .set({ [column]: value } as never)
            .where("id", "=", file.id)
            .execute(),
          column,
        ).rejects.toMatchObject({ code: "P0001", message: `library file ${file.id} keeps its file and its creator` });
      }
    }
    const updatedAt = new Date(Date.UTC(2026, 9, 24, 10, 0, 0));
    await db.updateTable("library_files").set({ name: "Renamed", description: "d", updated_at: updatedAt }).where("id", "=", file.id).execute();
    expect(await ownerDb.selectFrom("library_files").selectAll().where("id", "=", file.id).executeTakeFirstOrThrow()).toMatchObject({
      name: "Renamed",
      description: "d",
      updated_at: updatedAt,
      file_name: file.file_name,
      created_by_user_id: creator,
    });
  });

  it("sets the creator to null when their account is hard-deleted, which the guard allows", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    const file = await addLibraryFile(ownerDb, { created_by_user_id: user.id });
    await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();
    expect((await ownerDb.selectFrom("library_files").select("created_by_user_id").where("id", "=", file.id).executeTakeFirstOrThrow()).created_by_user_id).toBeNull();
  });

  it("lets the API's role, with no database context, read, add, change and hard-delete a file (no row-level security)", async () => {
    const file = await addLibraryFile(db, { name: "By the API" });
    expect(await db.selectFrom("library_files").select("id").execute()).toEqual([{ id: file.id }]);
    await db.updateTable("library_files").set({ description: "changed" }).where("id", "=", file.id).execute();
    const removed = await db.deleteFrom("library_files").where("id", "=", file.id).returning("id").execute();
    expect(removed).toEqual([{ id: file.id }]);
    expect(await ownerDb.selectFrom("library_files").selectAll().execute()).toEqual([]);
  });
});
