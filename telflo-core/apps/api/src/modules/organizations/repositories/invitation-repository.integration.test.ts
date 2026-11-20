import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addInvitation,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import {
  createInvitationRepository,
  findInvitationByTokenHash,
  InvitationAlreadyPendingError,
  type IInvitationRepository,
} from "./invitation-repository.js";

describe("invitation repository", () => {
  /** The repository's connection, as the API's own role, which row-level security constrains. */
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

  const hour = 60 * 60 * 1000;

  const invitationRow = (id: string) =>
    ownerDb.selectFrom("organization_invitations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  /**
   * An admin acting in a live group organization (they keep their personal
   * one), and another organization with an invitation of its own.
   */
  const organizationWithNeighbour = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: admin.user.id });
    const neighbour = await createUserWithOrganization(ownerDb);
    const elsewhere = await addInvitation(ownerDb, {
      organizationId: neighbour.organization.id,
      email: "invitee@example.com",
    });
    return { adminId: admin.user.id, organizationId: group.organization.id, elsewhere };
  };

  /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
  const inOrganization = <Result>(
    userId: string,
    organizationId: string,
    work: (invitations: IInvitationRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(db, { userId, organizationId }, (transaction) =>
      work(createInvitationRepository(transaction, { organizationId })),
    );

  /** Sets an invitation's created_at, which the typed builder can't write, so the order is certain. */
  const setInvitedAt = (id: string, at: string) =>
    sql`update organization_invitations set created_at = ${at}::timestamptz where id = ${id}`.execute(ownerDb);

  /**
   * Fails with 55P03 while another transaction holds a conflicting lock on
   * the row: the deterministic way to see a lock held.
   */
  const probeLock = (id: string, mode: "update" | "key share") =>
    ownerDb
      .transaction()
      .execute((transaction) =>
        sql`select 1 from organization_invitations where id = ${id} ${sql.raw(`for ${mode} nowait`)}`.execute(
          transaction,
        ),
      );

  /** An invitation in each state but pending, in `organizationId`. */
  const settledInvitations = async (organizationId: string, acceptorId: string) => ({
    accepted: await addInvitation(ownerDb, {
      organizationId,
      accepted_at: new Date(),
      accepted_by_user_id: acceptorId,
    }),
    revoked: await addInvitation(ownerDb, { organizationId, revoked_at: new Date() }),
  });

  describe("create", () => {
    it("creates a pending invitation in the context's organization, and returns it without the hash", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const expiresAt = new Date("2030-01-08T00:00:00.000Z");
      const invitation = await inOrganization(adminId, organizationId, (invitations) =>
        invitations.create({
          email: "new@example.com",
          role: "contributor",
          tokenHash: "a".repeat(64),
          invitedByUserId: adminId,
          expiresAt,
        }),
      );

      expect(invitation).toEqual({
        id: expect.any(String),
        organizationId,
        email: "new@example.com",
        role: "contributor",
        invitedByUserId: adminId,
        expiresAt,
        createdAt: expect.any(Date),
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      });
      expect(await invitationRow(invitation.id)).toMatchObject({
        organization_id: organizationId,
        token_hash: "a".repeat(64),
      });
    });

    it("throws InvitationAlreadyPendingError when the address has a pending invitation here, expired or not", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      await addInvitation(ownerDb, {
        organizationId,
        email: "invitee@example.com",
        expires_at: new Date(Date.now() - hour),
      });
      await expect(
        inOrganization(adminId, organizationId, (invitations) =>
          invitations.create({
            email: "invitee@example.com",
            role: "admin",
            tokenHash: "b".repeat(64),
            invitedByUserId: adminId,
            expiresAt: new Date(Date.now() + hour),
          }),
        ),
      ).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
      const rows = await ownerDb
        .selectFrom("organization_invitations")
        .select("role")
        .where("organization_id", "=", organizationId)
        .execute();
      expect(rows).toEqual([{ role: "contributor" }]);
    });

    it("lets any other violation through as it is: a clashing token hash, an uppercase address", async () => {
      const { adminId, organizationId, elsewhere } = await organizationWithNeighbour();
      const create = (email: string, tokenHash: string) =>
        inOrganization(adminId, organizationId, (invitations) =>
          invitations.create({ email, role: "admin", tokenHash, invitedByUserId: adminId, expiresAt: new Date() }),
        );

      await expect(create("fresh@example.com", elsewhere.token_hash)).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_organization_invitations_token_hash",
      });
      await expect(create("Fresh@example.com", "c".repeat(64))).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_organization_invitations_email_lowercase",
      });
    });
  });

  describe("reads", () => {
    it("lists pending invitations newest first, expired ones included, accepted, revoked and other organizations' left out", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const older = await addInvitation(ownerDb, { organizationId, expires_at: new Date(Date.now() - hour) });
      const newer = await addInvitation(ownerDb, { organizationId });
      const newest = await addInvitation(ownerDb, { organizationId });
      await setInvitedAt(older.id, "2030-01-01T00:00:00Z");
      await setInvitedAt(newer.id, "2030-01-02T00:00:00Z");
      await setInvitedAt(newest.id, "2030-01-03T00:00:00Z");
      await settledInvitations(organizationId, adminId);

      const listed = await inOrganization(adminId, organizationId, (invitations) => invitations.listPending());
      expect(listed.map((invitation) => invitation.id)).toEqual([newest.id, newer.id, older.id]);
      expect(listed[0]).toEqual({
        id: newest.id,
        organizationId,
        email: newest.email,
        role: "contributor",
        invitedByUserId: null,
        expiresAt: newest.expires_at,
        createdAt: new Date("2030-01-03T00:00:00.000Z"),
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      });
    });

    it("finds a pending invitation by id, expired or not, and nothing else", async () => {
      const { adminId, organizationId, elsewhere } = await organizationWithNeighbour();
      const pending = await addInvitation(ownerDb, { organizationId });
      const expired = await addInvitation(ownerDb, { organizationId, expires_at: new Date(Date.now() - hour) });
      const { accepted, revoked } = await settledInvitations(organizationId, adminId);

      const find = (id: string) => inOrganization(adminId, organizationId, (invitations) => invitations.findPending(id));
      expect(await find(pending.id)).toMatchObject({ id: pending.id });
      expect(await find(expired.id)).toMatchObject({ id: expired.id });
      expect(await find(accepted.id)).toBeUndefined();
      expect(await find(revoked.id)).toBeUndefined();
      expect(await find(elsewhere.id)).toBeUndefined();
    });

    it("finds the address's pending invitation, expired or not, and not a settled one or another organization's", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const find = (email: string) =>
        inOrganization(adminId, organizationId, (invitations) => invitations.findPendingByEmail(email));

      // The neighbour's invitation to invitee@example.com isn't this organization's.
      expect(await find("invitee@example.com")).toBeUndefined();
      await addInvitation(ownerDb, {
        organizationId,
        email: "invitee@example.com",
        accepted_at: new Date(),
        accepted_by_user_id: adminId,
      });
      await addInvitation(ownerDb, { organizationId, email: "invitee@example.com", revoked_at: new Date() });
      expect(await find("invitee@example.com")).toBeUndefined();

      const expired = await addInvitation(ownerDb, {
        organizationId,
        email: "invitee@example.com",
        expires_at: new Date(Date.now() - hour),
      });
      expect(await find("invitee@example.com")).toMatchObject({ id: expired.id, email: "invitee@example.com" });
    });
  });

  describe("lockForUpdate", () => {
    it("returns the invitation in any state with its token's hash, and holds it for update until the transaction ends", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const pending = await addInvitation(ownerDb, { organizationId });
      const { accepted, revoked } = await settledInvitations(organizationId, adminId);

      await inOrganization(adminId, organizationId, async (invitations) => {
        expect(await invitations.lockForUpdate(pending.id)).toMatchObject({
          id: pending.id,
          tokenHash: pending.token_hash,
          acceptedAt: null,
          revokedAt: null,
        });
        await expect(probeLock(pending.id, "update")).rejects.toMatchObject({ code: "55P03" });
        await expect(probeLock(pending.id, "key share")).rejects.toMatchObject({ code: "55P03" });
      });
      await expect(probeLock(pending.id, "update")).resolves.toBeDefined();

      await inOrganization(adminId, organizationId, async (invitations) => {
        expect(await invitations.lockForUpdate(accepted.id)).toMatchObject({
          id: accepted.id,
          tokenHash: accepted.token_hash,
          acceptedAt: accepted.accepted_at,
          acceptedByUserId: adminId,
        });
        expect(await invitations.lockForUpdate(revoked.id)).toMatchObject({
          id: revoked.id,
          tokenHash: revoked.token_hash,
          revokedAt: revoked.revoked_at,
        });
      });
    });

    it("finds nothing, and locks nothing, in another organization", async () => {
      const { adminId, organizationId, elsewhere } = await organizationWithNeighbour();
      await inOrganization(adminId, organizationId, async (invitations) => {
        expect(await invitations.lockForUpdate(elsewhere.id)).toBeUndefined();
        await expect(probeLock(elsewhere.id, "update")).resolves.toBeDefined();
      });
    });
  });

  describe("changes", () => {
    it("reissues a pending invitation with a new hash and expiry, reviving an expired one, and reports it", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const expired = await addInvitation(ownerDb, { organizationId, expires_at: new Date(Date.now() - hour) });
      const expiresAt = new Date("2030-01-08T00:00:00.000Z");
      const at = new Date("2030-01-01T00:00:00.000Z");

      expect(
        await inOrganization(adminId, organizationId, (invitations) =>
          invitations.reissue(expired.id, "d".repeat(64), expiresAt, at),
        ),
      ).toBe(true);
      const row = await invitationRow(expired.id);
      expect(row).toMatchObject({
        token_hash: "d".repeat(64),
        expires_at: expiresAt,
        updated_at: at,
        revoked_at: null,
      });
      expect(
        await inOrganization(adminId, organizationId, (invitations) => invitations.findPending(expired.id)),
      ).toMatchObject({ expiresAt });
    });

    it("revokes a pending invitation at the given time, once", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const pending = await addInvitation(ownerDb, { organizationId });
      const at = new Date("2030-02-01T00:00:00.000Z");
      const revoke = () => inOrganization(adminId, organizationId, (invitations) => invitations.revoke(pending.id, at));

      expect(await revoke()).toBe(true);
      expect(await invitationRow(pending.id)).toMatchObject({ revoked_at: at, updated_at: at, accepted_at: null });
      expect(await revoke()).toBe(false);
    });

    it("marks a pending invitation accepted by the user at the given time, once", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const invitee = await createUserWithOrganization(ownerDb);
      const pending = await addInvitation(ownerDb, { organizationId });
      const at = new Date("2030-02-01T00:00:00.000Z");
      const accept = () =>
        inOrganization(adminId, organizationId, (invitations) => invitations.markAccepted(pending.id, invitee.user.id, at));

      expect(await accept()).toBe(true);
      expect(await invitationRow(pending.id)).toMatchObject({
        accepted_at: at,
        accepted_by_user_id: invitee.user.id,
        updated_at: at,
        revoked_at: null,
      });
      expect(await accept()).toBe(false);
    });

    it("revokes every pending invitation the user sent here, expired ones included, oldest first, and nothing else", async () => {
      const { adminId, organizationId, elsewhere } = await organizationWithNeighbour();
      const other = await createUserWithOrganization(ownerDb);
      const sent = { invited_by_user_id: adminId };
      const theirs = [
        await addInvitation(ownerDb, { organizationId, ...sent }),
        await addInvitation(ownerDb, { organizationId, ...sent, expires_at: new Date(Date.now() - hour) }),
      ];
      const untouched = [
        await addInvitation(ownerDb, { organizationId, invited_by_user_id: other.user.id }),
        await addInvitation(ownerDb, { organizationId, ...sent, accepted_at: new Date(), accepted_by_user_id: other.user.id }),
        await addInvitation(ownerDb, { organizationId, ...sent, revoked_at: new Date(Date.now() - hour) }),
        // Sent by the same user, in another organization: out of the scope.
        await addInvitation(ownerDb, { organizationId: elsewhere.organization_id, ...sent }),
      ];
      const before = await Promise.all(untouched.map((invitation) => invitationRow(invitation.id)));
      const at = new Date("2030-02-01T00:00:00.000Z");

      const revoked = await inOrganization(adminId, organizationId, (invitations) =>
        invitations.revokePendingInvitedBy(adminId, at),
      );

      expect(revoked.map(({ id }) => id)).toEqual(theirs.map(({ id }) => id));
      expect(revoked[0]).toMatchObject({ organizationId, invitedByUserId: adminId, revokedAt: at });
      expect(revoked[0]).not.toHaveProperty("tokenHash");
      for (const { id } of theirs) {
        expect(await invitationRow(id)).toMatchObject({ revoked_at: at, updated_at: at, accepted_at: null });
      }
      expect(await Promise.all(untouched.map((invitation) => invitationRow(invitation.id)))).toEqual(before);
      expect(
        await inOrganization(adminId, organizationId, (invitations) => invitations.revokePendingInvitedBy(adminId, at)),
      ).toEqual([]);
    });

    it("reissues, revokes and accepts nothing that is accepted, revoked, or another organization's", async () => {
      const { adminId, organizationId, elsewhere } = await organizationWithNeighbour();
      const { accepted, revoked } = await settledInvitations(organizationId, adminId);
      const before = await Promise.all([accepted, revoked, elsewhere].map((invitation) => invitationRow(invitation.id)));

      await inOrganization(adminId, organizationId, async (invitations) => {
        for (const { id } of [accepted, revoked, elsewhere]) {
          expect({ id, reissued: await invitations.reissue(id, "e".repeat(64), new Date(), new Date()) }).toEqual({
            id,
            reissued: false,
          });
          expect({ id, revoked: await invitations.revoke(id, new Date()) }).toEqual({ id, revoked: false });
          expect({ id, accepted: await invitations.markAccepted(id, adminId, new Date()) }).toEqual({
            id,
            accepted: false,
          });
        }
      });

      expect(await Promise.all([accepted, revoked, elsewhere].map((invitation) => invitationRow(invitation.id)))).toEqual(
        before,
      );
    });
  });

  describe("findInvitationByTokenHash", () => {
    it("finds an invitation by its hash with no database context, with its organization's name, type and liveness", async () => {
      const { adminId, organizationId } = await organizationWithNeighbour();
      const organization = await ownerDb
        .selectFrom("organizations")
        .select("name")
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow();
      const accepted = await addInvitation(ownerDb, {
        organizationId,
        role: "contributor",
        accepted_at: new Date(),
        accepted_by_user_id: adminId,
      });

      expect(await findInvitationByTokenHash(db, accepted.token_hash)).toEqual({
        id: accepted.id,
        organizationId,
        email: accepted.email,
        role: "contributor",
        expiresAt: accepted.expires_at,
        acceptedAt: accepted.accepted_at,
        revokedAt: null,
        organizationName: organization.name,
        organizationType: "group",
        organizationIsLive: true,
      });

      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", organizationId).execute();
      expect(await findInvitationByTokenHash(db, accepted.token_hash)).toMatchObject({ organizationIsLive: false });
    });

    it("finds nothing for an unknown hash", async () => {
      await organizationWithNeighbour();
      expect(await findInvitationByTokenHash(db, "f".repeat(64))).toBeUndefined();
    });
  });
});
