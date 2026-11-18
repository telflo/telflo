import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext, withUserContext } from "./context.js";

/**
 * Row-level security on organization_members (D5 decision 3, migration
 * 1700000000011), as the API's own role. The owner, which builds the
 * fixtures here, is exempt.
 */
describe("row-level security on organization_members", () => {
  /** The API's own role, which the policies constrain. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;

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

  /**
   * Two people and two group organizations: A belongs to their personal
   * organization and to both groups; B to their personal organization and
   * to `shared` only.
   */
  const twoPeople = async () => {
    const a = await createUserWithOrganization(ownerDb);
    const b = await createUserWithOrganization(ownerDb);
    const shared = await addMembership(ownerDb, { userId: a.user.id });
    await addMembership(ownerDb, { userId: b.user.id, organizationId: shared.organization.id, role: "contributor" });
    const other = await addMembership(ownerDb, { userId: a.user.id });
    return { a, b, shared: shared.organization, other: other.organization };
  };

  const selectMemberships = (transaction: Kysely<Database>) =>
    transaction.selectFrom("organization_members").select(["user_id", "organization_id"]).execute();

  const sorted = (rows: { user_id: string; organization_id: string }[]) =>
    rows.map((row) => `${row.user_id}/${row.organization_id}`).sort();

  const membershipRow = (userId: string, organizationId: string) =>
    ownerDb
      .selectFrom("organization_members")
      .select(["role", "deleted_at", "organization_id"])
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

  it("shows nothing without a context", async () => {
    await twoPeople();
    expect(await selectMemberships(db)).toEqual([]);
    expect(await db.transaction().execute(selectMemberships)).toEqual([]);
  });

  it("shows a user alone their own memberships in every organization, and nobody else's", async () => {
    const { a, shared, other } = await twoPeople();
    const visible = await withUserContext(db, a.user.id, selectMemberships);
    expect(sorted(visible)).toEqual(
      sorted([
        { user_id: a.user.id, organization_id: a.organization.id },
        { user_id: a.user.id, organization_id: shared.id },
        { user_id: a.user.id, organization_id: other.id },
      ]),
    );
  });

  it("shows every membership of the context's organization", async () => {
    const { a, b, shared } = await twoPeople();
    const visible = await withDatabaseContext(db, { userId: b.user.id, organizationId: shared.id }, selectMemberships);
    // B's own two, and A's in `shared`; not A's in their personal or `other`.
    expect(sorted(visible)).toEqual(
      sorted([
        { user_id: b.user.id, organization_id: b.organization.id },
        { user_id: b.user.id, organization_id: shared.id },
        { user_id: a.user.id, organization_id: shared.id },
      ]),
    );
  });

  describe("writes outside the context's organization", () => {
    it("refuses an insert into another organization with 42501", async () => {
      const { a, b, other } = await twoPeople();
      await expect(
        withDatabaseContext(db, { userId: a.user.id, organizationId: a.organization.id }, (transaction) =>
          transaction
            .insertInto("organization_members")
            .values({ organization_id: other.id, user_id: b.user.id, role: "admin" })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await membershipRow(b.user.id, other.id)).toBeUndefined();
    });

    it("updates nothing in another organization, even the context user's own membership", async () => {
      const { a, shared, other } = await twoPeople();
      const result = await withDatabaseContext(db, { userId: a.user.id, organizationId: shared.id }, (transaction) =>
        transaction
          .updateTable("organization_members")
          .set({ role: "contributor" })
          .where("organization_id", "=", other.id)
          .executeTakeFirst(),
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect((await membershipRow(a.user.id, other.id))?.role).toBe("admin");
    });

    it("refuses moving a membership out of the context's organization with 42501", async () => {
      const { a, b, shared } = await twoPeople();
      await expect(
        withDatabaseContext(db, { userId: a.user.id, organizationId: shared.id }, (transaction) =>
          transaction
            .updateTable("organization_members")
            .set({ organization_id: a.organization.id })
            .where("user_id", "=", b.user.id)
            .where("organization_id", "=", shared.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await membershipRow(b.user.id, shared.id))?.organization_id).toBe(shared.id);
    });

    it("deletes nothing in another organization", async () => {
      const { a, shared, other } = await twoPeople();
      const result = await withDatabaseContext(db, { userId: a.user.id, organizationId: shared.id }, (transaction) =>
        transaction.deleteFrom("organization_members").where("organization_id", "=", other.id).executeTakeFirst(),
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await membershipRow(a.user.id, other.id)).toBeDefined();
    });
  });

  describe("the membership invariant under a narrow context (it is SECURITY DEFINER)", () => {
    /** Soft-removes the user's membership of `organizationId`, acting in that organization as `actorId`. */
    const removeAs = (actorId: string, userId: string, organizationId: string) =>
      withDatabaseContext(db, { userId: actorId, organizationId }, (transaction) =>
        transaction
          .updateTable("organization_members")
          .set({ deleted_at: new Date() })
          .where("user_id", "=", userId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst(),
      );

    it("refuses removing a user's last live membership", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      // A person whose only live membership is in the group (their own group
      // organization's removed): a person, not a service account, since no
      // service account has a second membership (D22 Preflight ruling 8).
      const group = await addMembership(ownerDb, { userId: owner.user.id });
      const onlyHere = await createUserWithOrganization(ownerDb, { organization: { type: "group", name: "Only" } });
      await addMembership(ownerDb, { userId: onlyHere.user.id, organizationId: group.organization.id });
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: new Date() })
        .where("user_id", "=", onlyHere.user.id)
        .where("organization_id", "=", onlyHere.organization.id)
        .execute();

      await expect(removeAs(owner.user.id, onlyHere.user.id, group.organization.id)).rejects.toThrow(
        `user ${onlyHere.user.id} must belong to at least one organization`,
      );
      expect((await membershipRow(onlyHere.user.id, group.organization.id))?.deleted_at).toBeNull();
    });

    it("counts a membership the context cannot see: removing a non-last one passes", async () => {
      const { a, b, shared } = await twoPeople();
      // A acts in `shared`, where B's personal membership is invisible to A.
      const result = await removeAs(a.user.id, b.user.id, shared.id);
      expect(result.numUpdatedRows).toBe(1n);
      expect((await membershipRow(b.user.id, shared.id))?.deleted_at).toBeInstanceOf(Date);
    });
  });
});
