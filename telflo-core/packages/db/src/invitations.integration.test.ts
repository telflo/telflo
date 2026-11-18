import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { addInvitation, addMembership, createUserWithOrganization, openTestDatabases, truncateAll } from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * organization_invitations (D6 decisions 1, 2 and 9, migration
 * 1700000000013): its constraints, as the owner; its row-level security and
 * the token lookup function, as the API's role (`db`), which the policies
 * constrain.
 */
describe("organization_invitations", () => {
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

  /** A live group organization with an admin, who also keeps their personal organization. */
  const createOrganization = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: admin.user.id });
    return { adminId: admin.user.id, organization: group.organization };
  };

  const invitationRow = (id: string) =>
    ownerDb.selectFrom("organization_invitations").selectAll().where("id", "=", id).executeTakeFirst();

  describe("constraints", () => {
    it("stores a pending invitation with its defaults", async () => {
      const { adminId, organization } = await createOrganization();
      const invitation = await addInvitation(ownerDb, {
        organizationId: organization.id,
        email: "invitee@example.com",
        role: "contributor",
        invited_by_user_id: adminId,
      });
      expect(invitation).toMatchObject({
        organization_id: organization.id,
        email: "invitee@example.com",
        role: "contributor",
        invited_by_user_id: adminId,
        accepted_at: null,
        accepted_by_user_id: null,
        revoked_at: null,
      });
      expect(invitation.created_at).toBeInstanceOf(Date);
      expect(invitation.updated_at).toBeInstanceOf(Date);
    });

    it("refuses an email with an uppercase letter", async () => {
      const { organization } = await createOrganization();
      await expect(addInvitation(ownerDb, { organizationId: organization.id, email: "Invitee@example.com" })).rejects.toThrow(
        /ck_organization_invitations_email_lowercase/,
      );
    });

    it("refuses an invitation both accepted and revoked", async () => {
      const { adminId, organization } = await createOrganization();
      await expect(
        addInvitation(ownerDb, {
          organizationId: organization.id,
          accepted_at: new Date(),
          accepted_by_user_id: adminId,
          revoked_at: new Date(),
        }),
      ).rejects.toThrow(/ck_organization_invitations_one_outcome/);
    });

    it("refuses an acceptor without an acceptance, and allows an acceptance without an acceptor", async () => {
      const { adminId, organization } = await createOrganization();
      await expect(
        addInvitation(ownerDb, { organizationId: organization.id, accepted_by_user_id: adminId }),
      ).rejects.toThrow(/ck_organization_invitations_accepted_by/);
      // What a hard-deleted acceptor leaves behind.
      await expect(
        addInvitation(ownerDb, { organizationId: organization.id, accepted_at: new Date() }),
      ).resolves.toMatchObject({ accepted_by_user_id: null });
    });

    it("refuses a token hash another invitation has", async () => {
      const { organization } = await createOrganization();
      const first = await addInvitation(ownerDb, { organizationId: organization.id });
      await expect(addInvitation(ownerDb, { organizationId: organization.id, token_hash: first.token_hash })).rejects.toThrow(
        /uq_organization_invitations_token_hash/,
      );
    });

    it("refuses an unknown role", async () => {
      const { organization } = await createOrganization();
      await expect(addInvitation(ownerDb, { organizationId: organization.id, role: "owner" as never })).rejects.toThrow(
        /invalid input value for enum organization_role/,
      );
    });

    describe("one pending invitation per address per organization", () => {
      const email = "invitee@example.com";

      it("refuses a second pending invitation to the address in the same organization, expired or not", async () => {
        const { organization } = await createOrganization();
        await addInvitation(ownerDb, { organizationId: organization.id, email, expires_at: new Date(Date.now() - 1000) });
        await expect(addInvitation(ownerDb, { organizationId: organization.id, email })).rejects.toThrow(
          /uq_organization_invitations_one_pending/,
        );
      });

      it("allows a pending invitation to the address in another organization", async () => {
        const first = await createOrganization();
        const second = await createOrganization();
        await addInvitation(ownerDb, { organizationId: first.organization.id, email });
        await expect(addInvitation(ownerDb, { organizationId: second.organization.id, email })).resolves.toMatchObject({
          email,
        });
      });

      it("allows a new pending invitation once the first is revoked", async () => {
        const { organization } = await createOrganization();
        await addInvitation(ownerDb, { organizationId: organization.id, email, revoked_at: new Date() });
        await expect(addInvitation(ownerDb, { organizationId: organization.id, email })).resolves.toMatchObject({ email });
      });

      it("allows a new pending invitation once the first is accepted", async () => {
        const { adminId, organization } = await createOrganization();
        await addInvitation(ownerDb, {
          organizationId: organization.id,
          email,
          accepted_at: new Date(),
          accepted_by_user_id: adminId,
        });
        await expect(addInvitation(ownerDb, { organizationId: organization.id, email })).resolves.toMatchObject({ email });
      });
    });

    it("goes with its organization when the organization is hard-deleted", async () => {
      const { organization } = await createOrganization();
      const invitation = await addInvitation(ownerDb, { organizationId: organization.id });
      await ownerDb.deleteFrom("organizations").where("id", "=", organization.id).execute();
      expect(await invitationRow(invitation.id)).toBeUndefined();
    });

    it("keeps the invitation, with no inviter or acceptor, when their accounts are hard-deleted", async () => {
      const { organization } = await createOrganization();
      const inviter = await createUserWithOrganization(ownerDb);
      const acceptor = await createUserWithOrganization(ownerDb);
      const pending = await addInvitation(ownerDb, { organizationId: organization.id, invited_by_user_id: inviter.user.id });
      const accepted = await addInvitation(ownerDb, {
        organizationId: organization.id,
        accepted_at: new Date(),
        accepted_by_user_id: acceptor.user.id,
      });

      await ownerDb.deleteFrom("users").where("id", "in", [inviter.user.id, acceptor.user.id]).execute();

      expect(await invitationRow(pending.id)).toMatchObject({ invited_by_user_id: null });
      expect(await invitationRow(accepted.id)).toMatchObject({
        accepted_at: accepted.accepted_at,
        accepted_by_user_id: null,
      });
    });
  });

  describe("row-level security, as the application role", () => {
    /** Runs `work` in a transaction whose organization context is `organizationId`, as context.ts sets it (null: none). */
    const inContext = <T>(organizationId: string | null, work: (transaction: Kysely<Database>) => Promise<T>) =>
      db.transaction().execute(async (transaction) => {
        if (organizationId !== null) {
          await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
        }
        return work(transaction);
      });

    const visibleIds = (transaction: Kysely<Database>) =>
      transaction
        .selectFrom("organization_invitations")
        .select("id")
        .execute()
        .then((rows) => rows.map((row) => row.id).sort());

    /** Two organizations with an invitation each. */
    const twoOrganizations = async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await addInvitation(ownerDb, { organizationId: a.organization.id });
      const inB = await addInvitation(ownerDb, { organizationId: b.organization.id });
      return { a: a.organization.id, b: b.organization.id, inA, inB };
    };

    it("shows nothing without a context", async () => {
      await twoOrganizations();
      expect(await visibleIds(db)).toEqual([]);
      expect(await inContext(null, visibleIds)).toEqual([]);
    });

    it("shows the context's organization's invitations and no other's", async () => {
      const { a, inA } = await twoOrganizations();
      expect(await inContext(a, visibleIds)).toEqual([inA.id]);
    });

    it("refuses an insert naming another organization with 42501", async () => {
      const { a, b } = await twoOrganizations();
      await expect(
        inContext(a, (transaction) =>
          transaction
            .insertInto("organization_invitations")
            .values({
              organization_id: b,
              email: "smuggled@example.com",
              role: "admin",
              token_hash: randomUUID(),
              expires_at: new Date(Date.now() + 60_000),
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const smuggled = await ownerDb
        .selectFrom("organization_invitations")
        .select("id")
        .where("email", "=", "smuggled@example.com")
        .execute();
      expect(smuggled).toEqual([]);
    });

    it("inserts in the context's organization", async () => {
      const { a } = await twoOrganizations();
      const row = await inContext(a, (transaction) =>
        transaction
          .insertInto("organization_invitations")
          .values({
            organization_id: a,
            email: "welcome@example.com",
            role: "contributor",
            token_hash: randomUUID(),
            expires_at: new Date(Date.now() + 60_000),
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
      expect(await invitationRow(row.id)).toMatchObject({ organization_id: a, email: "welcome@example.com" });
    });

    it("updates nothing in another organization", async () => {
      const { a, b, inB } = await twoOrganizations();
      const result = await inContext(a, (transaction) =>
        transaction
          .updateTable("organization_invitations")
          .set({ revoked_at: new Date() })
          .where("organization_id", "=", b)
          .executeTakeFirst(),
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(await invitationRow(inB.id)).toMatchObject({ revoked_at: null });
    });

    it("refuses moving an invitation out of the context's organization with 42501", async () => {
      const { a, b, inA } = await twoOrganizations();
      await expect(
        inContext(a, (transaction) =>
          transaction
            .updateTable("organization_invitations")
            .set({ organization_id: b })
            .where("id", "=", inA.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await invitationRow(inA.id)).toMatchObject({ organization_id: a });
    });

    it("deletes nothing in another organization", async () => {
      const { a, b, inB } = await twoOrganizations();
      const result = await inContext(a, (transaction) =>
        transaction.deleteFrom("organization_invitations").where("organization_id", "=", b).executeTakeFirst(),
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await invitationRow(inB.id)).toBeDefined();
    });
  });

  describe("organization_invitation_by_token_hash", () => {
    interface ByTokenHash {
      id: string;
      organization_id: string;
      email: string;
      role: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      organization_name: string;
      organization_is_live: boolean;
    }

    /** Calls the function as the API's role, with no database context: the invitee has none yet. */
    const byTokenHash = async (tokenHash: string) => {
      const { rows } = await sql<ByTokenHash>`
        select * from organization_invitation_by_token_hash(${tokenHash})
      `.execute(db);
      return rows;
    };

    const expected = (
      invitation: Awaited<ReturnType<typeof addInvitation>>,
      organization: { name: string },
      organizationIsLive = true,
    ): ByTokenHash => ({
      id: invitation.id,
      organization_id: invitation.organization_id,
      email: invitation.email,
      role: invitation.role,
      expires_at: invitation.expires_at,
      accepted_at: invitation.accepted_at,
      revoked_at: invitation.revoked_at,
      organization_name: organization.name,
      organization_is_live: organizationIsLive,
    });

    it("finds a pending invitation by its hash past row-level security, with its organization's name and liveness", async () => {
      const { organization } = await createOrganization();
      const invitation = await addInvitation(ownerDb, { organizationId: organization.id, role: "contributor" });
      await addInvitation(ownerDb, { organizationId: organization.id });
      expect(await byTokenHash(invitation.token_hash)).toEqual([expected(invitation, organization)]);
    });

    it("finds an expired, an accepted and a revoked invitation too", async () => {
      const { adminId, organization } = await createOrganization();
      const expired = await addInvitation(ownerDb, {
        organizationId: organization.id,
        expires_at: new Date(Date.now() - 1000),
      });
      const accepted = await addInvitation(ownerDb, {
        organizationId: organization.id,
        accepted_at: new Date(),
        accepted_by_user_id: adminId,
      });
      const revoked = await addInvitation(ownerDb, { organizationId: organization.id, revoked_at: new Date() });

      for (const invitation of [expired, accepted, revoked]) {
        expect(await byTokenHash(invitation.token_hash)).toEqual([expected(invitation, organization)]);
      }
    });

    it("reports a soft-deleted organization as not live", async () => {
      const { organization } = await createOrganization();
      const invitation = await addInvitation(ownerDb, { organizationId: organization.id });
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", organization.id).execute();
      expect(await byTokenHash(invitation.token_hash)).toEqual([expected(invitation, organization, false)]);
    });

    it("returns nothing for an unknown hash, and nothing for the empty string", async () => {
      const { organization } = await createOrganization();
      await addInvitation(ownerDb, { organizationId: organization.id });
      expect(await byTokenHash("0".repeat(64))).toEqual([]);
      expect(await byTokenHash("")).toEqual([]);
    });

    it("is executable by telflo_platform_runtime, and by no role outside it", async () => {
      const canExecute = async (connection: Kysely<Database>, role: string) => {
        const { rows } = await sql<{ allowed: boolean }>`
          select has_function_privilege(${role}, 'organization_invitation_by_token_hash(text)', 'EXECUTE') as allowed
        `.execute(connection);
        return rows[0]!.allowed;
      };
      expect(await canExecute(ownerDb, "telflo_platform_runtime")).toBe(true);
      expect(await canExecute(ownerDb, "public")).toBe(false);

      // A role that exists only inside this rolled-back transaction: roles
      // belong to the whole server.
      const rollback = new Error("rollback");
      const outsider = `test_outsider_${randomUUID().replaceAll("-", "")}`;
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await sql`create role ${sql.id(outsider)} nologin`.execute(transaction);
          expect(await canExecute(transaction, outsider)).toBe(false);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });

    it("is SECURITY DEFINER, stable, with a fixed search_path", async () => {
      const { rows } = await sql<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null }>`
        select prosecdef, provolatile, proconfig from pg_proc where proname = 'organization_invitation_by_token_hash'
      `.execute(ownerDb);
      expect(rows).toEqual([{ prosecdef: true, provolatile: "s", proconfig: ["search_path=platform, pg_temp"] }]);
    });
  });
});
