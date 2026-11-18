import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  removeMembership,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * D5 decision 9's two functions, from
 * 1700000000010_organizations_and_memberships: what removing a member and
 * deleting an organization do to sessions and accounts. They are called as
 * the API's role (`db`), which is the only role allowed to run them, with the
 * organization context set to their argument; fixtures and reads go through
 * the owner.
 */
describe("organization functions", () => {
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

  const insertSession = (userId: string, organizationId: string) =>
    ownerDb
      .insertInto("sessions")
      .values({ user_id: userId, active_organization_id: organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();

  const sessionRow = (id: string) =>
    ownerDb
      .selectFrom("sessions")
      .select(["active_organization_id", "revoked_at", "revoked_reason"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  /** A group organization with an exact name that the user joins. */
  const joinNamedGroup = async (userId: string, name: string) => {
    const organization = await ownerDb
      .insertInto("organizations")
      .values({ name, type: "group" })
      .returningAll()
      .executeTakeFirstOrThrow();
    await addMembership(ownerDb, { userId, organizationId: organization.id });
    return organization;
  };

  /**
   * A service account of `organizationId` (D22, addServiceAccount): its one
   * membership is there, and it has no personal organization.
   */
  const createServiceAccount = async (organizationId: string) =>
    (await addServiceAccount(ownerDb, { organizationId })).user;

  /**
   * A person whose only membership is in `organizationId`: no personal
   * organization. Not a service account's shape when it holds a session or
   * a second membership (a service account has neither, D22 decision 18), so
   * it stays a person, a shape no API path creates but one the functions
   * must still handle.
   */
  const createPersonOnlyIn = (organizationId: string) =>
    ownerDb.transaction().execute(async (transaction) => {
      const user = await transaction
        .insertInto("users")
        .values({ email: `only-in-${randomUUID()}@example.com`, email_verified_at: new Date() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("organization_members")
        .values({ organization_id: organizationId, user_id: user.id, role: "contributor" })
        .execute();
      return user;
    });

  /**
   * Runs `work` in a transaction as the API's role, with the organization
   * context set as Task 3's context.ts will set it (`null`: none). Both
   * functions refuse any organization but the context's.
   */
  const inContext = <T>(organizationId: string | null, work: (transaction: Kysely<Database>) => Promise<T>) =>
    db.transaction().execute(async (transaction) => {
      if (organizationId !== null) {
        await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
      }
      return work(transaction);
    });

  const reassign = async (
    organizationId: string,
    userId: string | null = null,
    context: string | null = organizationId,
  ) =>
    inContext(context, async (transaction) => {
      const { rows } = await sql<{ changed: number }>`
        select reassign_sessions_leaving_organization(${organizationId}::uuid, ${userId}::uuid) as changed
      `.execute(transaction);
      return rows[0]!.changed;
    });

  const deleteAccountsOnlyIn = async (organizationId: string, context: string | null = organizationId) =>
    inContext(context, async (transaction) => {
      const { rows } = await sql<{ deleted: number }>`
        select delete_accounts_only_in_organization(${organizationId}::uuid) as deleted
      `.execute(transaction);
      return rows[0]!.deleted;
    });

  describe("reassign_sessions_leaving_organization", () => {
    it("leaves a session in another organization untouched", async () => {
      const { user, organization: personal } = await createUserWithOrganization(ownerDb);
      const leaving = await joinNamedGroup(user.id, "Leaving");
      const elsewhere = await insertSession(user.id, personal.id);
      const other = await createUserWithOrganization(ownerDb);
      const othersSession = await insertSession(other.user.id, other.organization.id);

      expect(await reassign(leaving.id)).toBe(0);

      expect(await sessionRow(elsewhere.id)).toEqual({
        active_organization_id: personal.id,
        revoked_at: null,
        revoked_reason: null,
      });
      expect(await sessionRow(othersSession.id)).toMatchObject({ active_organization_id: other.organization.id });
    });

    it("moves a session to the user's personal organization first, even when a group sorts before it", async () => {
      const { user, organization: personal } = await createUserWithOrganization(ownerDb, {
        user: { email: "zz-last@example.com" },
      });
      await joinNamedGroup(user.id, "Aardvark");
      const leaving = await joinNamedGroup(user.id, "Leaving");
      const session = await insertSession(user.id, leaving.id);

      expect(await reassign(leaving.id)).toBe(1);

      expect(await sessionRow(session.id)).toEqual({
        active_organization_id: personal.id,
        revoked_at: null,
        revoked_reason: null,
      });
    });

    it("with no live personal membership, moves a session to the first live membership in a live organization by name", async () => {
      const { user, organization: personal } = await createUserWithOrganization(ownerDb);
      await joinNamedGroup(user.id, "Beta");
      const alpha = await joinNamedGroup(user.id, "Alpha");
      const deleted = await joinNamedGroup(user.id, "Aaa deleted");
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();
      const removed = await joinNamedGroup(user.id, "Aab removed");
      await removeMembership(ownerDb, { userId: user.id, organizationId: removed.id });
      await removeMembership(ownerDb, { userId: user.id, organizationId: personal.id });
      const leaving = await joinNamedGroup(user.id, "Aac leaving");
      const session = await insertSession(user.id, leaving.id);

      expect(await reassign(leaving.id)).toBe(1);

      expect(await sessionRow(session.id)).toMatchObject({ active_organization_id: alpha.id, revoked_at: null });
    });

    it("revokes a session with organization_access_lost when the user has no other live membership", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const leaving = await joinNamedGroup(owner.user.id, "Leaving");
      const onlyThere = await createPersonOnlyIn(leaving.id);
      const session = await insertSession(onlyThere.id, leaving.id);

      expect(await reassign(leaving.id, onlyThere.id)).toBe(1);

      const row = await sessionRow(session.id);
      expect(row).toMatchObject({ active_organization_id: leaving.id, revoked_reason: "organization_access_lost" });
      expect(row.revoked_at).toBeInstanceOf(Date);
    });

    it("limits itself to p_user_id's sessions when it is given", async () => {
      const first = await createUserWithOrganization(ownerDb);
      const second = await createUserWithOrganization(ownerDb);
      const leaving = await joinNamedGroup(first.user.id, "Leaving");
      await addMembership(ownerDb, { userId: second.user.id, organizationId: leaving.id });
      const firstSession = await insertSession(first.user.id, leaving.id);
      const secondSession = await insertSession(second.user.id, leaving.id);

      expect(await reassign(leaving.id, first.user.id)).toBe(1);

      expect(await sessionRow(firstSession.id)).toMatchObject({ active_organization_id: first.organization.id });
      expect(await sessionRow(secondSession.id)).toMatchObject({ active_organization_id: leaving.id, revoked_at: null });
    });

    it("returns how many live sessions it moved or revoked, and leaves revoked sessions alone", async () => {
      const { user, organization: personal } = await createUserWithOrganization(ownerDb);
      const leaving = await joinNamedGroup(user.id, "Leaving");
      await insertSession(user.id, leaving.id);
      await insertSession(user.id, leaving.id);
      const revoked = await insertSession(user.id, leaving.id);
      await ownerDb
        .updateTable("sessions")
        .set({ revoked_at: new Date(), revoked_reason: "logout" })
        .where("id", "=", revoked.id)
        .execute();
      const onlyThere = await createPersonOnlyIn(leaving.id);
      await insertSession(onlyThere.id, leaving.id);

      expect(await reassign(leaving.id)).toBe(3);

      const rows = await ownerDb
        .selectFrom("sessions")
        .select(["id", "user_id", "active_organization_id", "revoked_reason"])
        .orderBy("id")
        .execute();
      expect(rows.map(({ id, ...row }) => ({ ...row, revokedBefore: id === revoked.id }))).toEqual([
        { user_id: user.id, active_organization_id: personal.id, revoked_reason: null, revokedBefore: false },
        { user_id: user.id, active_organization_id: personal.id, revoked_reason: null, revokedBefore: false },
        { user_id: user.id, active_organization_id: leaving.id, revoked_reason: "logout", revokedBefore: true },
        {
          user_id: onlyThere.id,
          active_organization_id: leaving.id,
          revoked_reason: "organization_access_lost",
          revokedBefore: false,
        },
      ]);
    });
  });

  describe("delete_accounts_only_in_organization", () => {
    it("soft-deletes an account whose only live membership is in the organization, and leaves a member with a personal organization alone", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const deleting = await joinNamedGroup(owner.user.id, "Deleting");
      const serviceAccount = await createServiceAccount(deleting.id);

      expect(await deleteAccountsOnlyIn(deleting.id)).toBe(1);

      const users = await ownerDb.selectFrom("users").select(["id", "deleted_at"]).execute();
      expect(users.find((row) => row.id === serviceAccount.id)?.deleted_at).toBeInstanceOf(Date);
      expect(users.find((row) => row.id === owner.user.id)?.deleted_at).toBeNull();
    });

    it("counts a membership in a deleted organization as none, and skips accounts already deleted", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const deleting = await joinNamedGroup(owner.user.id, "Deleting");
      const alreadyGone = await joinNamedGroup(owner.user.id, "Already gone");
      const twoMemberships = await createPersonOnlyIn(deleting.id);
      await addMembership(ownerDb, { userId: twoMemberships.id, organizationId: alreadyGone.id });
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", alreadyGone.id).execute();
      const departed = await createServiceAccount(deleting.id);
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", departed.id).execute();

      expect(await deleteAccountsOnlyIn(deleting.id)).toBe(1);
    });

    // The whole of decision 9's deletion, in one transaction as the API's
    // role: without the account deletion, the organization's soft delete
    // would fail the invariant at commit for the service account.
    it("lets a group organization be deleted in the same transaction", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const deleting = await joinNamedGroup(owner.user.id, "Deleting");
      const serviceAccount = await createServiceAccount(deleting.id);

      await inContext(deleting.id, async (transaction) => {
        await sql`select delete_accounts_only_in_organization(${deleting.id}::uuid)`.execute(transaction);
        await sql`select reassign_sessions_leaving_organization(${deleting.id}::uuid)`.execute(transaction);
        await transaction
          .updateTable("organizations")
          .set({ deleted_at: new Date() })
          .where("id", "=", deleting.id)
          .execute();
      });

      const account = await ownerDb
        .selectFrom("users")
        .select("deleted_at")
        .where("id", "=", serviceAccount.id)
        .executeTakeFirstOrThrow();
      expect(account.deleted_at).toBeInstanceOf(Date);
    });
  });

  // Both bypass row-level security, so each refuses (42501) an organization
  // other than the database context's, and changes nothing.
  describe("the organization context", () => {
    /** A group with the owner's session in it, and a service account only in it. */
    const fixture = async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const group = await joinNamedGroup(owner.user.id, "Group");
      const session = await insertSession(owner.user.id, group.id);
      const serviceAccount = await createServiceAccount(group.id);
      return { owner, group, session, serviceAccount };
    };

    const expectUnchanged = async ({ group, session, serviceAccount }: Awaited<ReturnType<typeof fixture>>) => {
      expect(await sessionRow(session.id)).toEqual({
        active_organization_id: group.id,
        revoked_at: null,
        revoked_reason: null,
      });
      const account = await ownerDb
        .selectFrom("users")
        .select("deleted_at")
        .where("id", "=", serviceAccount.id)
        .executeTakeFirstOrThrow();
      expect(account.deleted_at).toBeNull();
    };

    it("refuses both functions when no organization context is set", async () => {
      const setup = await fixture();
      await expect(reassign(setup.group.id, null, null)).rejects.toMatchObject({ code: "42501" });
      await expect(deleteAccountsOnlyIn(setup.group.id, null)).rejects.toMatchObject({ code: "42501" });
      await expectUnchanged(setup);
    });

    it("refuses both functions when the context names another organization", async () => {
      const setup = await fixture();
      const other = setup.owner.organization.id;
      await expect(reassign(setup.group.id, null, other)).rejects.toMatchObject({
        code: "42501",
        message: "reassign_sessions_leaving_organization may act only on the organization in the database context",
      });
      await expect(deleteAccountsOnlyIn(setup.group.id, other)).rejects.toMatchObject({
        code: "42501",
        message: "delete_accounts_only_in_organization may act only on the organization in the database context",
      });
      await expectUnchanged(setup);
    });

    it("runs both functions when the context names their organization", async () => {
      const setup = await fixture();
      expect(await reassign(setup.group.id, null, setup.group.id)).toBe(1);
      expect(await sessionRow(setup.session.id)).toMatchObject({ active_organization_id: setup.owner.organization.id });
      expect(await deleteAccountsOnlyIn(setup.group.id, setup.group.id)).toBe(1);
    });
  });

  describe("who may run them", () => {
    const functions = [
      "reassign_sessions_leaving_organization(uuid, uuid)",
      "delete_accounts_only_in_organization(uuid)",
    ];

    const canExecute = async (role: string, signature: string) => {
      const { rows } = await sql<{ allowed: boolean }>`
        select has_function_privilege(${role}, ${signature}, 'EXECUTE') as allowed
      `.execute(ownerDb);
      return rows[0]!.allowed;
    };

    it("revokes execute from public and grants it to telflo_platform_runtime only", async () => {
      for (const signature of functions) {
        expect({ signature, public: await canExecute("public", signature) }).toEqual({ signature, public: false });
        expect({ signature, application: await canExecute("telflo_platform_runtime", signature) }).toEqual({
          signature,
          application: true,
        });
      }
    });

    it("runs both as SECURITY DEFINER with a fixed search_path, like the invariant", async () => {
      const { rows } = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>`
        select proname, prosecdef, proconfig
          from pg_proc
         where proname in (
           'reassign_sessions_leaving_organization',
           'delete_accounts_only_in_organization',
           'ensure_user_has_membership'
         )
         order by proname
      `.execute(ownerDb);
      expect(rows).toEqual(
        [
          "delete_accounts_only_in_organization",
          "ensure_user_has_membership",
          "reassign_sessions_leaving_organization",
        ].map((proname) => ({ proname, prosecdef: true, proconfig: ["search_path=platform, pg_temp"] })),
      );
    });
  });
});
