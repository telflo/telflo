import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { createUserSettingsRepository, type IUserSettingsRepository } from "./user-settings-repository.js";

/*
 * The user settings repository, against the test database as the API's
 * role: the lazy row read as the defaults, the one-statement merge, and two
 * writers racing on it.
 */

const APPLICATION_NAME = "user-settings-repository-test";
/** Each race runs this many times, on fresh users. */
const RACE_ROUNDS = 40;

describe("the user settings repository", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let settings: IUserSettingsRepository;

  beforeAll(() => {
    databases = openTestDatabases({ applicationName: APPLICATION_NAME });
    ({ db, ownerDb } = databases);
    settings = createUserSettingsRepository(db);
  });
  afterAll(async () => {
    await databases.destroy();
  });
  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  const createUser = async () => (await createUserWithOrganization(ownerDb)).user.id;

  const storedRow = (userId: string) =>
    ownerDb.selectFrom("user_settings").selectAll().where("user_id", "=", userId).executeTakeFirst();

  /** A row as the owner writes it, past the API's schema. */
  const writeRow = (userId: string, theme: string, preferences: unknown) => {
    const at = new Date("2026-10-01T08:00:00Z");
    return ownerDb
      .insertInto("user_settings")
      .values({ user_id: userId, theme, preferences: JSON.stringify(preferences), created_at: at, updated_at: at })
      .execute();
  };

  it("reads the defaults when there is no row", async () => {
    const userId = await createUser();

    expect(await settings.find(userId)).toEqual(DEFAULT_USER_PREFERENCES);
    expect(await settings.findTheme(userId)).toBe("dark");
    expect(await storedRow(userId)).toBeUndefined();
  });

  it("the first merge inserts the row with created_at and updated_at from the clock", async () => {
    const userId = await createUser();
    const first = new Date("2026-10-22T09:00:00.000Z");
    const second = new Date("2026-10-22T10:30:00.000Z");

    const answered = await settings.merge(userId, { editor: { fontSize: 16 } }, first);

    expect(answered).toEqual({ ...DEFAULT_USER_PREFERENCES, editor: { ...DEFAULT_USER_PREFERENCES.editor, fontSize: 16 } });
    expect(await storedRow(userId)).toEqual({
      user_id: userId,
      theme: "dark",
      preferences: { editor: { fontSize: 16 } },
      created_at: first,
      updated_at: first,
    });

    await settings.merge(userId, { theme: "light" }, second);

    expect(await storedRow(userId)).toMatchObject({ created_at: first, updated_at: second });
  });

  it("stores only the groups a first merge carries, and the theme it gives", async () => {
    const userId = await createUser();

    await settings.merge(userId, { theme: "navy" }, new Date());

    expect(await storedRow(userId)).toMatchObject({ theme: "navy", preferences: {} });
  });

  it("merges a group's keys onto the stored group and keeps the other group and the theme", async () => {
    const userId = await createUser();
    await settings.merge(userId, { theme: "navy", editor: { tabSize: 4, minimap: true }, email: { productTips: false } }, new Date());

    const answered = await settings.merge(userId, { editor: { fontSize: 18, minimap: false } }, new Date());

    const expected = {
      theme: "navy",
      editor: { tabSize: 4, fontSize: 18, lineNumbers: true, minimap: false },
      email: { productUpdates: true, productTips: false },
    };
    expect(answered).toEqual(expected);
    expect(await settings.find(userId)).toEqual(expected);
    expect((await storedRow(userId))?.preferences).toEqual({
      editor: { tabSize: 4, fontSize: 18, minimap: false },
      email: { productTips: false },
    });
  });

  it("replaces a stored group that isn't an object", async () => {
    const userId = await createUser();
    await writeRow(userId, "light", { editor: [4, 16], email: "off", other: { kept: true } });

    const answered = await settings.merge(userId, { editor: { tabSize: 4 } }, new Date());

    expect(answered).toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "light", editor: { ...DEFAULT_USER_PREFERENCES.editor, tabSize: 4 } });
    expect((await storedRow(userId))?.preferences).toEqual({ editor: { tabSize: 4 }, email: "off", other: { kept: true } });

    await settings.merge(userId, { email: { productUpdates: false } }, new Date());

    expect((await storedRow(userId))?.preferences).toEqual({
      editor: { tabSize: 4 },
      email: { productUpdates: false },
      other: { kept: true },
    });
  });

  it("sets the theme column only when given", async () => {
    const userId = await createUser();
    await settings.merge(userId, { theme: "light" }, new Date());

    await settings.merge(userId, { email: { productUpdates: false } }, new Date());
    expect((await storedRow(userId))?.theme).toBe("light");
    expect(await settings.findTheme(userId)).toBe("light");

    await settings.merge(userId, { theme: "navy" }, new Date());
    expect((await storedRow(userId))?.theme).toBe("navy");
    expect(await settings.findTheme(userId)).toBe("navy");
  });

  it("reads an invalid or unknown stored key as its default", async () => {
    const userId = await createUser();
    await writeRow(userId, "navy", {
      editor: { tabSize: 3, fontSize: 16, lineNumbers: "yes", minimap: true, wordWrap: true },
      email: { productUpdates: false, productTips: null },
      theme: "light",
      unknown: 1,
    });

    expect(await settings.find(userId)).toEqual({
      theme: "navy",
      editor: { tabSize: 2, fontSize: 16, lineNumbers: true, minimap: true },
      email: { productUpdates: false, productTips: true },
    });

    const answered = await settings.merge(userId, { editor: { tabSize: 4 } }, new Date());
    expect(answered.editor).toEqual({ tabSize: 4, fontSize: 16, lineNumbers: true, minimap: true });
  });

  it("two concurrent merges of different keys both land, on an existing row and on the first write", async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const fresh = await createUser();
      const existing = await createUser();
      await settings.merge(existing, { editor: { lineNumbers: false } }, new Date());

      await Promise.all([
        settings.merge(fresh, { editor: { tabSize: 4 } }, new Date()),
        settings.merge(fresh, { editor: { fontSize: 20 }, theme: "light" }, new Date()),
        settings.merge(existing, { editor: { minimap: true } }, new Date()),
        settings.merge(existing, { email: { productTips: false } }, new Date()),
      ]);

      expect(await settings.find(fresh)).toEqual({
        ...DEFAULT_USER_PREFERENCES,
        theme: "light",
        editor: { ...DEFAULT_USER_PREFERENCES.editor, tabSize: 4, fontSize: 20 },
      });
      expect(await settings.find(existing)).toEqual({
        theme: "dark",
        editor: { ...DEFAULT_USER_PREFERENCES.editor, lineNumbers: false, minimap: true },
        email: { ...DEFAULT_USER_PREFERENCES.email, productTips: false },
      });
    }
  });
});
