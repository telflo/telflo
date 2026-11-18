import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { createUserWithOrganization, openTestDatabases, restoreRevokedGrantLeftovers, truncateAll } from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * user_settings (D21 decision 18, migration 1700000000034; Preflight ruling
 * 2): its constraints and cascade, as the owner; its privileges, as the
 * API's role (`db`), which no row-level security limits.
 * schema.integration.test.ts has the migration's catalogue (up, down, up).
 */
describe("user_settings", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
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

  const createUser = async () => (await createUserWithOrganization(ownerDb)).user.id;

  const settingsRow = (userId: string) =>
    ownerDb.selectFrom("user_settings").selectAll().where("user_id", "=", userId).executeTakeFirst();

  /** Inserts a row for `userId` as the owner, with both timestamps unless overridden. */
  const insertSettings = (userId: string, values: Record<string, unknown> = {}) => {
    const at = new Date();
    return ownerDb
      .insertInto("user_settings")
      .values({ user_id: userId, created_at: at, updated_at: at, ...values } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
  };

  it("stores a row with its defaults: dark and an empty object", async () => {
    const userId = await createUser();
    const at = new Date("2026-10-22T09:00:00Z");
    await expect(insertSettings(userId, { created_at: at, updated_at: at })).resolves.toEqual({
      user_id: userId,
      theme: "dark",
      preferences: {},
      created_at: at,
      updated_at: at,
    });
  });

  it("stores each of the three themes", async () => {
    for (const theme of ["light", "dark", "navy"]) {
      const userId = await createUser();
      await expect(insertSettings(userId, { theme })).resolves.toMatchObject({ theme });
    }
  });

  it.each(["system", "Dark", "", " dark", "blue"])("refuses a theme other than light, dark or navy (%j)", async (theme) => {
    const userId = await createUser();
    await expect(insertSettings(userId, { theme })).rejects.toThrow(/ck_user_settings_theme/);
    await insertSettings(userId);
    await expect(
      ownerDb.updateTable("user_settings").set({ theme }).where("user_id", "=", userId).execute(),
    ).rejects.toThrow(/ck_user_settings_theme/);
  });

  it.each([
    ["an array", JSON.stringify([{ editor: { tabSize: 4 } }])],
    ["a string", JSON.stringify("dark")],
    ["a number", JSON.stringify(4)],
    ["a JSON null", JSON.stringify(null)],
  ])("refuses preferences that aren't a JSON object: %s", async (_label, preferences) => {
    const userId = await createUser();
    await expect(insertSettings(userId, { preferences })).rejects.toThrow(/ck_user_settings_preferences/);
    await insertSettings(userId);
    await expect(
      ownerDb.updateTable("user_settings").set({ preferences }).where("user_id", "=", userId).execute(),
    ).rejects.toThrow(/ck_user_settings_preferences/);
    expect((await settingsRow(userId))!.preferences).toEqual({});
  });

  it("refuses preferences over 4,096 bytes and stores 4,096", async () => {
    // Measured on jsonb's normalized text: {"a": "…"} is 9 bytes around the value (Preflight ruling 2).
    const object = (length: number) => sql<string>`jsonb_build_object('a', repeat('x', ${length}::int))`;
    const atBound = await createUser();
    await insertSettings(atBound, { preferences: object(4087) });
    const { rows } = await sql<{ bytes: number }>`
      select octet_length(preferences::text) as bytes from user_settings where user_id = ${atBound}
    `.execute(ownerDb);
    expect(rows).toEqual([{ bytes: 4096 }]);
    expect((await settingsRow(atBound))!.preferences).toEqual({ a: "x".repeat(4087) });

    const over = await createUser();
    await expect(insertSettings(over, { preferences: object(4088) })).rejects.toThrow(/ck_user_settings_preferences/);
    await expect(
      ownerDb.updateTable("user_settings").set({ preferences: object(4088) }).where("user_id", "=", atBound).execute(),
    ).rejects.toThrow(/ck_user_settings_preferences/);
    expect(await settingsRow(over)).toBeUndefined();
  });

  it("requires created_at and updated_at: no default", async () => {
    const userId = await createUser();
    const at = new Date();
    await expect(
      ownerDb.insertInto("user_settings").values({ user_id: userId, updated_at: at } as never).execute(),
    ).rejects.toThrow(/created_at/);
    await expect(
      ownerDb.insertInto("user_settings").values({ user_id: userId, created_at: at } as never).execute(),
    ).rejects.toThrow(/updated_at/);
    expect(await settingsRow(userId)).toBeUndefined();
  });

  it("refuses a second row for a user, and a user that doesn't exist", async () => {
    const userId = await createUser();
    await insertSettings(userId);
    await expect(insertSettings(userId)).rejects.toThrow(/user_settings_pkey/);
    await expect(insertSettings("00000000-0000-7000-8000-000000000000")).rejects.toThrow(/user_settings_user_id_fkey/);
  });

  it("deletes a user's row with the user", async () => {
    const userId = await createUser();
    const kept = await createUser();
    await insertSettings(userId, { theme: "navy" });
    await insertSettings(kept, { theme: "light" });

    await ownerDb.deleteFrom("users").where("id", "=", userId).execute();
    expect(await settingsRow(userId)).toBeUndefined();
    expect(await settingsRow(kept)).toMatchObject({ theme: "light" });
  });

  it("lets the API's role read, insert, update and delete it, with no database context (no row-level security)", async () => {
    const userId = await createUser();
    const at = new Date("2026-10-22T09:00:00Z");
    const later = new Date("2026-10-22T09:05:00Z");

    await db
      .insertInto("user_settings")
      .values({ user_id: userId, theme: "light", preferences: JSON.stringify({ editor: { tabSize: 4 } }), created_at: at, updated_at: at })
      .execute();
    expect(await db.selectFrom("user_settings").selectAll().where("user_id", "=", userId).executeTakeFirst()).toEqual({
      user_id: userId,
      theme: "light",
      preferences: { editor: { tabSize: 4 } },
      created_at: at,
      updated_at: at,
    });

    await db
      .updateTable("user_settings")
      .set({ theme: "navy", preferences: JSON.stringify({ email: { productTips: false } }), updated_at: later })
      .where("user_id", "=", userId)
      .execute();
    expect(await settingsRow(userId)).toEqual({
      user_id: userId,
      theme: "navy",
      preferences: { email: { productTips: false } },
      created_at: at,
      updated_at: later,
    });

    const deleted = await db.deleteFrom("user_settings").where("user_id", "=", userId).executeTakeFirst();
    expect(deleted.numDeletedRows).toBe(1n);
    expect(await settingsRow(userId)).toBeUndefined();
  });
  it("gets back the API role's privileges a killed run revoked, from the global setup's leftovers step (Ruling 83)", async () => {
    const privileges = async () =>
      (
        await sql<{ select: boolean; insert: boolean; update: boolean; delete: boolean }>`
          select has_table_privilege('telflo_platform_runtime', 'user_settings', 'SELECT') as select,
                 has_table_privilege('telflo_platform_runtime', 'user_settings', 'INSERT') as insert,
                 has_table_privilege('telflo_platform_runtime', 'user_settings', 'UPDATE') as update,
                 has_table_privilege('telflo_platform_runtime', 'user_settings', 'DELETE') as delete
        `.execute(ownerDb)
      ).rows[0];
    const all = { select: true, insert: true, update: true, delete: true };
    const ownerUrl = process.env.TELFLO_MIGRATION_DATABASE_URL!;

    // As sessions/routes.integration.test.ts's failing-read test leaves it when killed inside its window.
    await sql`revoke select, insert, update, delete on user_settings from telflo_platform_runtime`.execute(ownerDb);
    try {
      expect(await privileges()).toEqual({ select: false, insert: false, update: false, delete: false });
      await restoreRevokedGrantLeftovers(ownerUrl);
      expect(await privileges()).toEqual(all);
      // Idempotent: a run with nothing to restore changes nothing.
      await restoreRevokedGrantLeftovers(ownerUrl);
      expect(await privileges()).toEqual(all);
    } finally {
      await sql`grant select, insert, update, delete on user_settings to telflo_platform_runtime`.execute(ownerDb);
    }
  });
});
