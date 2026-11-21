import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  removeMembership,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext, withUserContext } from "../../../database/context.js";
import { createMemberRepository, type IMemberRepository } from "./member-repository.js";
import {
  createActiveOrganizationRepository,
  createOrganizationRepository,
  OrganizationNameTakenError,
  type IActiveOrganizationRepository,
} from "./organization-repository.js";

describe("organizations repositories", () => {
  /** The repositories' connection, as the API's own role, which row-level security constrains. */
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

  const organizationRow = (id: string) =>
    ownerDb.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const membershipRow = (userId: string, organizationId: string) =>
    ownerDb
      .selectFrom("organization_members")
      .selectAll()
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

  /**
   * Fails with 55P03 while another transaction holds a conflicting lock on
   * the row: the deterministic way to see a lock held.
   */
  const probeLock = (
    table: "organizations" | "organization_members" | "users",
    id: string,
    mode: "update" | "no key update" | "share" | "key share",
  ) =>
    ownerDb
      .transaction()
      .execute((transaction) =>
        sql`select 1 from ${sql.table(table)} where id = ${id} ${sql.raw(`for ${mode} nowait`)}`.execute(transaction),
      );

  describe("organization repository reads", () => {
    // Row-level security shows the API's role a user's memberships only in
    // that user's database context, as sign-in and /me read them.
    const findPersonal = (userId: string) =>
      withUserContext(db, userId, (transaction) => createOrganizationRepository(transaction).findPersonalForUser(userId));
    const listFor = (userId: string) =>
      withUserContext(db, userId, (transaction) => createOrganizationRepository(transaction).listForUser(userId));

    /** A group organization with an exact name, which has no owner, that the user joins. */
    const joinNamedGroup = async (userId: string, name: string) => {
      const organization = await ownerDb
        .insertInto("organizations")
        .values({ name, type: "group" })
        .returningAll()
        .executeTakeFirstOrThrow();
      return addMembership(ownerDb, { userId, organizationId: organization.id });
    };

    it("finds the user's personal organization", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: user.id });
      expect(await findPersonal(user.id)).toEqual({
        id: organization.id,
        name: organization.name,
      });
    });

    it("returns undefined for a user whose only membership is in a group organization", async () => {
      const { user } = await createUserWithOrganization(ownerDb, { organization: { type: "group", name: "Acme" } });
      expect(await findPersonal(user.id)).toBeUndefined();
    });

    it("does not return a soft-deleted personal organization", async () => {
      // The invariant needs a live membership in a live organization to remain.
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: user.id });
      await ownerDb
        .updateTable("organizations")
        .set({ deleted_at: new Date() })
        .where("id", "=", organization.id)
        .execute();
      expect(await findPersonal(user.id)).toBeUndefined();
    });

    it("does not return a personal organization the user is no longer a member of", async () => {
      const { user, membership } = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: user.id });
      await ownerDb.deleteFrom("organization_members").where("id", "=", membership.id).execute();
      expect(await findPersonal(user.id)).toBeUndefined();
    });

    it("does not return a personal organization whose membership was removed", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: user.id });
      await removeMembership(ownerDb, { userId: user.id, organizationId: organization.id });
      expect(await findPersonal(user.id)).toBeUndefined();
    });

    it("does not return someone else's personal organization the user is a member of", async () => {
      const owner = await createUserWithOrganization(ownerDb);
      const { user } = await createUserWithOrganization(ownerDb, { organization: { type: "group", name: "Acme" } });
      await addMembership(ownerDb, { userId: user.id, organizationId: owner.organization.id });
      expect(await findPersonal(user.id)).toBeUndefined();
    });

    it("finds the live organization the user joined most recently, in their context only", async () => {
      const newest = (userId: string) =>
        withUserContext(db, userId, (transaction) => createOrganizationRepository(transaction).findNewestJoinedForUser(userId));
      const { user, organization: personal } = await createUserWithOrganization(ownerDb);
      expect(await newest(user.id)).toBe(personal.id);
      const first = await addMembership(ownerDb, { userId: user.id });
      const second = await addMembership(ownerDb, { userId: user.id });
      // Someone else's newer membership, of an organization the user isn't in, is never theirs.
      const other = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: other.user.id });
      expect(await newest(user.id)).toBe(second.organization.id);

      // A removed membership and a deleted organization are passed over.
      await removeMembership(ownerDb, { userId: user.id, organizationId: second.organization.id });
      expect(await newest(user.id)).toBe(first.organization.id);
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", first.organization.id).execute();
      expect(await newest(user.id)).toBe(personal.id);

      // Outside a database context row-level security hides every membership; in another user's, the user's.
      expect(await createOrganizationRepository(db).findNewestJoinedForUser(user.id)).toBeUndefined();
      expect(
        await withUserContext(db, other.user.id, (transaction) =>
          createOrganizationRepository(transaction).findNewestJoinedForUser(user.id),
        ),
      ).toBeUndefined();
    });

    it("lists the user's organizations with their types and the user's roles, personal first, then by name", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb, {
        user: { email: "zz-last@example.com" },
      });
      const beta = await joinNamedGroup(user.id, "Beta");
      const alpha = await joinNamedGroup(user.id, "Alpha");
      const aardvark = await joinNamedGroup(user.id, "Aardvark");

      await ownerDb
        .updateTable("organization_members")
        .set({ role: "contributor" })
        .where("id", "=", alpha.membership.id)
        .execute();

      expect(await listFor(user.id)).toEqual([
        { id: organization.id, name: organization.name, type: "personal", logoId: null, role: "admin" },
        { id: aardvark.organization.id, name: "Aardvark", type: "group", logoId: null, role: "admin" },
        { id: alpha.organization.id, name: "Alpha", type: "group", logoId: null, role: "contributor" },
        { id: beta.organization.id, name: "Beta", type: "group", logoId: null, role: "admin" },
      ]);
    });

    it("lists neither soft-deleted organizations nor ones the user is not a member of", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const personalEntry = { id: organization.id, name: organization.name, type: "personal", logoId: null, role: "admin" };
      const deleted = await joinNamedGroup(user.id, "Deleted");
      await ownerDb
        .updateTable("organizations")
        .set({ deleted_at: new Date() })
        .where("id", "=", deleted.organization.id)
        .execute();
      await createUserWithOrganization(ownerDb, { organization: { type: "group", name: "Someone else's" } });

      expect(await listFor(user.id)).toEqual([personalEntry]);
    });

    it("hides a removed membership and a deleted organization, and shows a restored membership", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const personalEntry = { id: organization.id, name: organization.name, type: "personal", logoId: null, role: "admin" };
      const removed = await joinNamedGroup(user.id, "Removed");
      const deleted = await joinNamedGroup(user.id, "Deleted");
      await removeMembership(ownerDb, { userId: user.id, organizationId: removed.organization.id });
      await ownerDb
        .updateTable("organizations")
        .set({ deleted_at: new Date() })
        .where("id", "=", deleted.organization.id)
        .execute();

      expect(await listFor(user.id)).toEqual([personalEntry]);

      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: null })
        .where("id", "=", removed.membership.id)
        .execute();
      expect(await listFor(user.id)).toEqual([
        personalEntry,
        { id: removed.organization.id, name: "Removed", type: "group", logoId: null, role: "admin" },
      ]);
    });
  });


  describe("createGroup", () => {
    const createGroup = (name: string) => createOrganizationRepository(db).createGroup(name);

    it("creates a group organization with no owner", async () => {
      const organization = await createGroup("Acme");
      expect(organization).toEqual({
        id: expect.any(String),
        name: "Acme",
        type: "group",
        ownerUserId: null,
        createdAt: expect.any(Date),
        logoId: null,
        logoContentType: null,
      });
      expect((await organizationRow(organization.id)).owner_user_id).toBeNull();
    });

    it("takes the id and the logo it is given", async () => {
      const repository = createOrganizationRepository(db);
      const id = await repository.nextId();
      const logoId = await repository.nextId();
      const organization = await repository.createGroup("Acme", { id, logo: { logoId, contentType: "image/jpeg" } });
      expect(organization).toMatchObject({ id, name: "Acme", logoId, logoContentType: "image/jpeg" });
      expect(await organizationRow(id)).toMatchObject({ logo_id: logoId, logo_content_type: "image/jpeg" });
    });

    it("picks a new uuidv7 id each time, as the table's default", async () => {
      const repository = createOrganizationRepository(db);
      const [first, second] = [await repository.nextId(), await repository.nextId()];
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(second).not.toBe(first);
    });

    it("throws OrganizationNameTakenError for a live group's name in another case", async () => {
      await createGroup("Acme");
      await expect(createGroup("ACME")).rejects.toBeInstanceOf(OrganizationNameTakenError);
    });

    it("lets a unique violation on any other constraint through as it is", async () => {
      await withFailingInsert(
        ownerDb,
        "organizations",
        "raise exception 'another index' using errcode = 'unique_violation', constraint = 'uq_another_index'",
        async () => {
          await expect(createGroup("Acme")).rejects.toMatchObject({ code: "23505", constraint: "uq_another_index" });
        },
      );
    });
  });

  describe("the active organization", () => {
    /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
    const inOrganization = <Result>(
      userId: string,
      organizationId: string,
      work: (organizations: IActiveOrganizationRepository, transaction: Transaction<Database>) => Promise<Result>,
    ) =>
      withDatabaseContext(db, { userId, organizationId }, (transaction) =>
        work(createActiveOrganizationRepository(transaction, { organizationId }), transaction),
      );

    /** A person with their personal organization and a group organization. */
    const personWithGroup = async () => {
      const person = await createUserWithOrganization(ownerDb);
      const group = await addMembership(ownerDb, { userId: person.user.id });
      return { userId: person.user.id, personal: person.organization, group: group.organization };
    };

    it("finds the context's organization, in camelCase", async () => {
      const { userId, group } = await personWithGroup();
      expect(await inOrganization(userId, group.id, (organizations) => organizations.findActive())).toEqual({
        id: group.id,
        name: group.name,
        type: "group",
        ownerUserId: null,
        createdAt: group.created_at,
        logoId: null,
        logoContentType: null,
      });
    });

    it("finds nothing once the organization is soft-deleted", async () => {
      const { userId, group } = await personWithGroup();
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", group.id).execute();
      expect(await inOrganization(userId, group.id, (organizations) => organizations.findActive())).toBeUndefined();
      expect(await inOrganization(userId, group.id, (organizations) => organizations.lockActive())).toBeUndefined();
    });

    it("renames only the context's organization", async () => {
      const { userId, personal, group } = await personWithGroup();
      const renamed = await inOrganization(userId, group.id, (organizations) => organizations.rename("Renamed"));
      expect(renamed).toMatchObject({ id: group.id, name: "Renamed" });
      expect((await organizationRow(group.id)).name).toBe("Renamed");
      expect((await organizationRow(personal.id)).name).toBe(personal.name);
    });

    it("throws OrganizationNameTakenError when renaming to a live group's name in another case", async () => {
      const { userId, group } = await personWithGroup();
      const other = await addMembership(ownerDb, { userId });
      await expect(
        inOrganization(userId, group.id, (organizations) => organizations.rename(other.organization.name.toUpperCase())),
      ).rejects.toBeInstanceOf(OrganizationNameTakenError);
      expect((await organizationRow(group.id)).name).toBe(group.name);
    });

    it("renames nothing that is soft-deleted", async () => {
      const { userId, group } = await personWithGroup();
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", group.id).execute();
      expect(
        await inOrganization(userId, group.id, (organizations) => organizations.rename("Renamed")),
      ).toBeUndefined();
      expect((await organizationRow(group.id)).name).toBe(group.name);
    });

    it("sets and clears the context's organization's logo, both columns together, and nobody else's", async () => {
      const { userId, personal, group } = await personWithGroup();
      const logoId = "0199e000-0000-7000-8000-00000000a002";
      const set = await inOrganization(userId, group.id, (organizations) =>
        organizations.setLogo({ logoId, contentType: "image/png" }),
      );
      expect(set).toMatchObject({ id: group.id, logoId, logoContentType: "image/png" });
      expect(await organizationRow(group.id)).toMatchObject({ logo_id: logoId, logo_content_type: "image/png" });
      expect(await organizationRow(personal.id)).toMatchObject({ logo_id: null, logo_content_type: null });
      expect(await inOrganization(userId, group.id, (organizations) => organizations.findLogo())).toEqual({
        logoId,
        contentType: "image/png",
      });
      expect(await inOrganization(userId, personal.id, (organizations) => organizations.findLogo())).toBeUndefined();

      const cleared = await inOrganization(userId, group.id, (organizations) => organizations.setLogo(null));
      expect(cleared).toMatchObject({ logoId: null, logoContentType: null });
      expect(await organizationRow(group.id)).toMatchObject({ logo_id: null, logo_content_type: null });
      expect(await inOrganization(userId, group.id, (organizations) => organizations.findLogo())).toBeUndefined();
    });

    it("sets no logo on, and finds none of, a soft-deleted organization", async () => {
      const { userId, group } = await personWithGroup();
      const logoId = "0199e000-0000-7000-8000-00000000a003";
      await inOrganization(userId, group.id, (organizations) => organizations.setLogo({ logoId, contentType: "image/png" }));
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", group.id).execute();
      expect(await inOrganization(userId, group.id, (organizations) => organizations.findLogo())).toBeUndefined();
      expect(await inOrganization(userId, group.id, (organizations) => organizations.setLogo(null))).toBeUndefined();
      expect((await organizationRow(group.id)).logo_id).toBe(logoId);
    });

    it("lists each organization's logo id for its member", async () => {
      const { userId, group } = await personWithGroup();
      const logoId = "0199e000-0000-7000-8000-00000000a004";
      await inOrganization(userId, group.id, (organizations) => organizations.setLogo({ logoId, contentType: "image/webp" }));
      const listed = await withUserContext(db, userId, (transaction) =>
        createOrganizationRepository(transaction).listForUser(userId),
      );
      expect(listed.map((organization) => organization.logoId)).toEqual([null, logoId]);
    });

    it("marks a group organization deleted at the given time, once", async () => {
      const { userId, group } = await personWithGroup();
      const at = new Date("2030-01-01T00:00:00.000Z");
      expect(await inOrganization(userId, group.id, (organizations) => organizations.markDeleted(at))).toBe(true);
      expect((await organizationRow(group.id)).deleted_at).toEqual(at);
      expect(
        await inOrganization(userId, group.id, (organizations) => organizations.markDeleted(new Date())),
      ).toBe(false);
      expect((await organizationRow(group.id)).deleted_at).toEqual(at);
    });

    it("does not mark a personal organization deleted", async () => {
      const { userId, personal } = await personWithGroup();
      expect(await inOrganization(userId, personal.id, (organizations) => organizations.markDeleted(new Date()))).toBe(
        false,
      );
      expect((await organizationRow(personal.id)).deleted_at).toBeNull();
    });

    /** A live session of `userId`, acting in `organizationId`. */
    const sessionIn = async (userId: string, organizationId: string) =>
      (
        await ownerDb
          .insertInto("sessions")
          .values({ user_id: userId, active_organization_id: organizationId })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;

    const sessionRow = (id: string) =>
      ownerDb.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

    it("reassigns the sessions acting in the organization to each user's fallback, of one user when named", async () => {
      const admin = await personWithGroup();
      const member = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: member.user.id, organizationId: admin.group.id, role: "contributor" });
      const adminSession = await sessionIn(admin.userId, admin.group.id);
      const memberSession = await sessionIn(member.user.id, admin.group.id);
      const elsewhere = await sessionIn(member.user.id, member.organization.id);

      expect(
        await inOrganization(admin.userId, admin.group.id, (organizations) =>
          organizations.reassignSessionsLeavingOrganization(member.user.id),
        ),
      ).toBe(1);
      expect((await sessionRow(memberSession)).active_organization_id).toBe(member.organization.id);
      expect((await sessionRow(adminSession)).active_organization_id).toBe(admin.group.id);

      expect(
        await inOrganization(admin.userId, admin.group.id, (organizations) =>
          organizations.reassignSessionsLeavingOrganization(),
        ),
      ).toBe(1);
      expect((await sessionRow(adminSession)).active_organization_id).toBe(admin.personal.id);
      expect((await sessionRow(elsewhere)).active_organization_id).toBe(member.organization.id);
    });

    it("soft-deletes the accounts whose only membership is in the organization, once it is deleted", async () => {
      const admin = await personWithGroup();
      // A person whose only membership is in the group, a shape the owner
      // writes and no API path creates; a service account's deletion with
      // its organization is the routes' test.
      const onlyHere = await createUserWithOrganization(ownerDb, { organization: { type: "group", name: "Solo" } });
      await addMembership(ownerDb, { userId: admin.userId, organizationId: onlyHere.organization.id });

      const deleted = await inOrganization(admin.userId, onlyHere.organization.id, async (organizations) => {
        await organizations.markDeleted(new Date());
        return organizations.deleteAccountsOnlyInOrganization();
      });

      expect(deleted).toBe(1);
      const users = await ownerDb.selectFrom("users").select(["id", "deleted_at"]).execute();
      expect(users.find((user) => user.id === onlyHere.user.id)?.deleted_at).not.toBeNull();
      expect(users.find((user) => user.id === admin.userId)?.deleted_at).toBeNull();
    });

    it("refuses both functions (42501) when the transaction's context names another organization", async () => {
      const { userId, personal, group } = await personWithGroup();
      const inPersonalContextScopedToGroup = (work: (organizations: IActiveOrganizationRepository) => Promise<number>) =>
        withDatabaseContext(db, { userId, organizationId: personal.id }, (transaction) =>
          work(createActiveOrganizationRepository(transaction, { organizationId: group.id })),
        );
      await expect(
        inPersonalContextScopedToGroup((organizations) => organizations.reassignSessionsLeavingOrganization()),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inPersonalContextScopedToGroup((organizations) => organizations.deleteAccountsOnlyInOrganization()),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("lockActive holds the row for no key update until the transaction ends", async () => {
      // It conflicts with itself and with the switch's share lock, but not
      // with the key share a foreign-key check takes: a session moved into
      // the organization by another transaction doesn't wait on it.
      const { userId, group } = await personWithGroup();
      await inOrganization(userId, group.id, async (organizations) => {
        expect(await organizations.lockActive()).toMatchObject({ id: group.id });
        await expect(probeLock("organizations", group.id, "no key update")).rejects.toMatchObject({ code: "55P03" });
        await expect(probeLock("organizations", group.id, "share")).rejects.toMatchObject({ code: "55P03" });
        await expect(probeLock("organizations", group.id, "key share")).resolves.toBeDefined();
      });
      await expect(probeLock("organizations", group.id, "update")).resolves.toBeDefined();
    });

    it("findActiveForShare holds a share lock: another share passes, an update lock waits", async () => {
      const { userId, group } = await personWithGroup();
      await inOrganization(userId, group.id, async (organizations) => {
        expect(await organizations.findActiveForShare()).toMatchObject({ id: group.id });
        await expect(probeLock("organizations", group.id, "share")).resolves.toBeDefined();
        await expect(probeLock("organizations", group.id, "update")).rejects.toMatchObject({ code: "55P03" });
      });
    });
  });

  describe("members", () => {
    /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
    const inOrganization = <Result>(
      userId: string,
      organizationId: string,
      work: (members: IMemberRepository) => Promise<Result>,
    ) =>
      withDatabaseContext(db, { userId, organizationId }, (transaction) =>
        work(createMemberRepository(transaction, { organizationId })),
      );

    /** Sets a membership's created_at, which the typed builder can't write, so the order is certain. */
    const setJoinedAt = (userId: string, organizationId: string, at: string) =>
      sql`update organization_members set created_at = ${at}::timestamptz
          where user_id = ${userId} and organization_id = ${organizationId}`.execute(ownerDb);

    /**
     * An admin's personal organization with two more members, and a
     * separate group organization with a member of its own. Each member
     * also has their own personal organization, so removing them leaves the
     * invariant satisfied.
     */
    const organizationWithMembers = async () => {
      const admin = await createUserWithOrganization(ownerDb, { user: { email: "admin@example.com" } });
      const organizationId = admin.organization.id;
      const contributor = await createUserWithOrganization(ownerDb, { user: { email: "contributor@example.com" } });
      const colleague = await createUserWithOrganization(ownerDb, { user: { email: "colleague@example.com" } });
      await addMembership(ownerDb, { userId: contributor.user.id, organizationId, role: "contributor" });
      await addMembership(ownerDb, { userId: colleague.user.id, organizationId, role: "contributor" });
      await setJoinedAt(admin.user.id, organizationId, "2030-01-01T00:00:00Z");
      await setJoinedAt(contributor.user.id, organizationId, "2030-01-02T00:00:00Z");
      await setJoinedAt(colleague.user.id, organizationId, "2030-01-03T00:00:00Z");
      const outsider = await createUserWithOrganization(ownerDb, { user: { email: "outsider@example.com" } });
      const elsewhere = await addMembership(ownerDb, { userId: outsider.user.id });
      return {
        organizationId,
        admin: admin.user.id,
        contributor: contributor.user.id,
        colleague: colleague.user.id,
        outsider: outsider.user.id,
        elsewhere: elsewhere.organization.id,
      };
    };

    it("lists active and removed members newest first, with emails, marking the personal organization's owner", async () => {
      const { organizationId, admin, contributor, colleague } = await organizationWithMembers();
      const removedAt = new Date("2030-02-01T00:00:00.000Z");
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: removedAt })
        .where("user_id", "=", contributor)
        .where("organization_id", "=", organizationId)
        .execute();

      expect(await inOrganization(admin, organizationId, (members) => members.list())).toEqual([
        {
          userId: colleague,
          email: "colleague@example.com",
          role: "contributor",
          isOrganizationOwner: false,
          createdAt: new Date("2030-01-03T00:00:00.000Z"),
          deletedAt: null,
          isServiceAccount: false,
        },
        {
          userId: contributor,
          email: "contributor@example.com",
          role: "contributor",
          isOrganizationOwner: false,
          createdAt: new Date("2030-01-02T00:00:00.000Z"),
          deletedAt: removedAt,
          isServiceAccount: false,
        },
        {
          userId: admin,
          email: "admin@example.com",
          role: "admin",
          isOrganizationOwner: true,
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
          deletedAt: null,
          isServiceAccount: false,
        },
      ]);
    });

    it("leaves out members whose account is deleted, and other organizations' members", async () => {
      const { organizationId, admin, colleague } = await organizationWithMembers();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", colleague).execute();
      const listed = await inOrganization(admin, organizationId, (members) => members.list());
      expect(listed.map((member) => member.email)).toEqual(["contributor@example.com", "admin@example.com"]);
      expect(await inOrganization(admin, organizationId, (members) => members.find(colleague))).toBeUndefined();
    });

    it("leaves service accounts out of the list, and finds one, active or removed, marked as one", async () => {
      const { organizationId, admin } = await organizationWithMembers();
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId });
      const { user: removed } = await addServiceAccount(ownerDb, { organizationId });
      // Removed as no API path removes one: the owner, with another
      // membership given first so the invariant holds at commit.
      await addMembership(ownerDb, { userId: removed.id, role: "contributor" });
      await removeMembership(ownerDb, { userId: removed.id, organizationId });

      const listed = await inOrganization(admin, organizationId, (members) => members.list());
      expect(listed.map((member) => member.email)).toEqual([
        "colleague@example.com",
        "contributor@example.com",
        "admin@example.com",
      ]);
      expect(listed.every((member) => !member.isServiceAccount)).toBe(true);
      expect(await inOrganization(admin, organizationId, (members) => members.find(serviceAccount.id))).toMatchObject({
        userId: serviceAccount.id,
        role: "contributor",
        deletedAt: null,
        isServiceAccount: true,
      });
      expect(await inOrganization(admin, organizationId, (members) => members.find(removed.id))).toMatchObject({
        userId: removed.id,
        deletedAt: expect.any(Date),
        isServiceAccount: true,
      });
      expect(await inOrganization(admin, organizationId, (members) => members.find(admin))).toMatchObject({
        isServiceAccount: false,
      });
      // findByEmail keeps every kind: the invite's member check.
      expect(
        await inOrganization(admin, organizationId, (members) => members.findByEmail(serviceAccount.email)),
      ).toMatchObject({ userId: serviceAccount.id, isServiceAccount: true });
    });

    it("finds one member, active or removed, and nobody outside the organization", async () => {
      const { organizationId, admin, contributor, outsider } = await organizationWithMembers();
      await removeMembership(ownerDb, { userId: contributor, organizationId });
      expect(await inOrganization(admin, organizationId, (members) => members.find(contributor))).toMatchObject({
        userId: contributor,
        role: "contributor",
        deletedAt: expect.any(Date),
      });
      expect(await inOrganization(admin, organizationId, (members) => members.find(outsider))).toBeUndefined();
    });

    it("finds a member by email, active or removed, but no deleted account and nobody outside the organization", async () => {
      const { organizationId, admin, contributor, colleague } = await organizationWithMembers();
      await removeMembership(ownerDb, { userId: contributor, organizationId });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", colleague).execute();
      const byEmail = (email: string) => inOrganization(admin, organizationId, (members) => members.findByEmail(email));

      expect(await byEmail("admin@example.com")).toMatchObject({ userId: admin, deletedAt: null });
      expect(await byEmail("contributor@example.com")).toMatchObject({
        userId: contributor,
        role: "contributor",
        deletedAt: expect.any(Date),
      });
      expect(await byEmail("colleague@example.com")).toBeUndefined();
      expect(await byEmail("outsider@example.com")).toBeUndefined();
      expect(await byEmail("nobody@example.com")).toBeUndefined();
    });

    it("adds a member to the context's organization", async () => {
      const { organizationId, admin, outsider } = await organizationWithMembers();
      const membership = await inOrganization(admin, organizationId, (members) =>
        members.add({ userId: outsider, role: "contributor" }),
      );
      expect(membership).toEqual({
        id: expect.any(String),
        organizationId,
        userId: outsider,
        role: "contributor",
        createdAt: expect.any(Date),
      });
      expect((await membershipRow(outsider, organizationId))?.role).toBe("contributor");
    });

    it("changes an active member's role, reporting whether anything changed", async () => {
      const { organizationId, admin, contributor } = await organizationWithMembers();
      const change = (role: "admin" | "contributor") =>
        inOrganization(admin, organizationId, (members) => members.changeRole(contributor, role));
      expect(await change("admin")).toBe(true);
      expect((await membershipRow(contributor, organizationId))?.role).toBe("admin");
      expect(await change("admin")).toBe(false);

      await removeMembership(ownerDb, { userId: contributor, organizationId });
      expect(await change("contributor")).toBe(false);
      expect((await membershipRow(contributor, organizationId))?.role).toBe("admin");
    });

    it("removes an active member at the given time, once, and restores them", async () => {
      const { organizationId, admin, contributor } = await organizationWithMembers();
      const at = new Date("2030-03-01T00:00:00.000Z");
      const remove = () => inOrganization(admin, organizationId, (members) => members.remove(contributor, at));
      const restore = () => inOrganization(admin, organizationId, (members) => members.restore(contributor));

      expect(await restore()).toBe(false);
      expect(await remove()).toBe(true);
      expect((await membershipRow(contributor, organizationId))?.deleted_at).toEqual(at);
      expect(await remove()).toBe(false);

      expect(await restore()).toBe(true);
      const restored = await membershipRow(contributor, organizationId);
      expect(restored).toMatchObject({ deleted_at: null, role: "contributor" });
      expect(await restore()).toBe(false);
    });

    it("changes nothing for a member of another organization", async () => {
      const { organizationId, admin, outsider, elsewhere } = await organizationWithMembers();
      await inOrganization(admin, organizationId, async (members) => {
        expect(await members.changeRole(outsider, "contributor")).toBe(false);
        expect(await members.remove(outsider, new Date())).toBe(false);
      });
      expect(await membershipRow(outsider, elsewhere)).toMatchObject({ role: "admin", deleted_at: null });
    });

    it("lockAccounts locks the live members' accounts for no key update, or one member's", async () => {
      const { organizationId, admin, contributor, colleague, outsider } = await organizationWithMembers();
      await removeMembership(ownerDb, { userId: colleague, organizationId });
      const isLocked = async (userId: string) =>
        probeLock("users", userId, "no key update").then(
          () => false,
          (error: unknown) => {
            expect(error).toMatchObject({ code: "55P03" });
            return true;
          },
        );

      await inOrganization(admin, organizationId, async (members) => {
        await members.lockAccounts();
        expect(await isLocked(admin)).toBe(true);
        expect(await isLocked(contributor)).toBe(true);
        // A removed member, and someone else's, are left alone.
        expect(await isLocked(colleague)).toBe(false);
        expect(await isLocked(outsider)).toBe(false);
        // A foreign-key check's key share still passes.
        await expect(probeLock("users", admin, "key share")).resolves.toBeDefined();
      });

      await inOrganization(admin, organizationId, async (members) => {
        await members.lockAccounts(contributor);
        expect(await isLocked(contributor)).toBe(true);
        expect(await isLocked(admin)).toBe(false);
      });
      expect(await isLocked(contributor)).toBe(false);
    });

    it("findForShare finds a live membership and holds it for share", async () => {
      const { organizationId, admin, colleague } = await organizationWithMembers();
      const row = await membershipRow(colleague, organizationId);
      await inOrganization(colleague, organizationId, async (members) => {
        expect(await members.findForShare(colleague)).toEqual({
          id: row!.id,
          organizationId,
          userId: colleague,
          role: "contributor",
          createdAt: row!.created_at,
        });
        await expect(probeLock("organization_members", row!.id, "update")).rejects.toMatchObject({ code: "55P03" });
      });
      await removeMembership(ownerDb, { userId: colleague, organizationId });
      expect(await inOrganization(admin, organizationId, (members) => members.findForShare(colleague))).toBeUndefined();
    });
  });
});
