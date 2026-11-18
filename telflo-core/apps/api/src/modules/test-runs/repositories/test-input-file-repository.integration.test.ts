import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@telflo/db";
import {
  addMembership,
  addTestInputFile,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import { createTestInputFileRepository, type ITestInputFileRepository } from "./test-input-file-repository.js";

/*
 * The test files' repository (D14a decision 7): a person's own files in
 * one organization. Each rule is checked twice: as the API's role, where
 * row-level security stands behind the repository, and as the tables'
 * owner, which row-level security doesn't constrain, so the repository's
 * own filter is what answers (a lost filter fails there, whatever the
 * policies do).
 */
describe("test input file repository", () => {
  let databases: TestDatabases;
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, and the repository past row-level security. */
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

  /** Ana and Ben in one group organization, and Cara in another. */
  async function people() {
    const ana = await createUserWithOrganization(ownerDb);
    const { organization: group } = await addMembership(ownerDb, { userId: ana.user.id, role: "admin" });
    const ben = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: ben.user.id, role: "contributor", organizationId: group.id });
    const cara = await createUserWithOrganization(ownerDb);
    return { ana: ana.user.id, ben: ben.user.id, cara: cara.user.id, group: group.id, elsewhere: cara.organization.id };
  }

  const both = [
    ["as the API's role", () => db],
    ["as the tables' owner, past row-level security", () => ownerDb],
  ] as const;

  const as = <Result>(
    connection: Kysely<Database>,
    userId: string,
    organizationId: string,
    work: (files: ITestInputFileRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(connection, { userId, organizationId }, (transaction) =>
      work(createTestInputFileRepository(transaction, { organizationId, userId })),
    );

  describe.each(both)("%s", (_label, connection) => {
    it("finds a person's own file, and never a teammate's or another organization's", async () => {
      const { ana, ben, cara, group, elsewhere } = await people();
      const anas = await addTestInputFile(ownerDb, { organizationId: group, ownerUserId: ana });
      const bens = await addTestInputFile(ownerDb, { organizationId: group, ownerUserId: ben });
      const carasElsewhere = await addTestInputFile(ownerDb, { organizationId: elsewhere, ownerUserId: cara });
      const anasElsewhere = await addTestInputFile(ownerDb, { organizationId: elsewhere, ownerUserId: ana });

      await as(connection(), ana, group, async (files) => {
        expect((await files.findOwn(anas.id))?.id).toBe(anas.id);
        // A teammate's file id finds nothing, admin or not.
        expect(await files.findOwn(bens.id)).toBeUndefined();
        expect(await files.findOwn(carasElsewhere.id)).toBeUndefined();
        // Their own file in another organization isn't this organization's.
        expect(await files.findOwn(anasElsewhere.id)).toBeUndefined();
        expect((await files.listOwn(100)).map((file) => file.id)).toEqual([anas.id]);
      });
    });

    it("removes only a person's own file", async () => {
      const { ana, ben, group } = await people();
      const bens = await addTestInputFile(ownerDb, { organizationId: group, ownerUserId: ben });
      const anas = await addTestInputFile(ownerDb, { organizationId: group, ownerUserId: ana });

      await as(connection(), ana, group, async (files) => {
        expect(await files.removeOwn(bens.id)).toBe(false);
        expect(await files.removeOwn(anas.id)).toBe(true);
        expect(await files.removeOwn(anas.id)).toBe(false);
      });
      const left = await ownerDb.selectFrom("test_input_files").select("id").execute();
      expect(left.map((row) => row.id)).toEqual([bens.id]);
    });
  });

  it("lists the newest first, at most the limit", async () => {
    const { ana, group } = await people();
    const created = [];
    // One after another: each insert's created_at is its own transaction's now(), and uuidv7 ids rise.
    for (let index = 0; index < 3; index += 1) {
      created.push(await addTestInputFile(ownerDb, { organizationId: group, ownerUserId: ana }));
    }
    const listed = await as(db, ana, group, (files) => files.listOwn(2));
    expect(listed.map((file) => file.id)).toEqual([created[2]!.id, created[1]!.id]);
  });

  it("creates a file with the id chosen first, as the context's user, in the context's organization", async () => {
    const { ana, group } = await people();
    const sha256 = createHash("sha256").update("bytes").digest("hex");
    const file = await as(db, ana, group, async (files) => {
      const id = await files.nextId();
      return files.create({
        id,
        displayName: "App logs",
        fileName: "app-logs.json",
        description: "",
        contentType: "application/json",
        sizeBytes: 5,
        sha256,
      });
    });
    expect(file).toMatchObject({ displayName: "App logs", fileName: "app-logs.json", sizeBytes: 5, sha256 });
    expect(file.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const row = await ownerDb.selectFrom("test_input_files").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ id: file.id, organization_id: group, owner_user_id: ana });
  });
});
