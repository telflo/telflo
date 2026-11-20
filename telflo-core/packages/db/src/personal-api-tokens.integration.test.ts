import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import {
  addMembership,
  addPersonalApiToken,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * personal_api_tokens and the lookup's person branch (migration
 * 1700000000038): the lookup as the API's real login, with no context;
 * row-level security on the context's user, as the API's role.
 * schema.integration.test.ts has the migration's catalogue (up, down, up);
 * service-accounts.integration.test.ts the service-account branch. No test
 * prints a token: a failing assertion compares hashes, ids, counts or
 * booleans.
 */
describe("personal API tokens", () => {
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

  const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

  describe("the lookup's person branch", () => {
    type Found = {
      kind: string;
      token_id: string;
      user_id: string;
      email: string;
      access: string;
      organization_id: string | null;
      role: string | null;
    };
    /** The lookup as the API's real login, with no database context. */
    const lookup = async (hash: string, at: Date = new Date()) =>
      (await sql<Found>`select * from find_live_api_token_by_hash(${hash}, ${at}::timestamptz)`.execute(db)).rows;

    it("answers a live person's token: its kind, id, the person, their email and its access, with no organization and no role", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { personalApiToken, token } = await addPersonalApiToken(ownerDb, { userId: user.id, access: "write" });
      await addPersonalApiToken(ownerDb, { userId: user.id });

      const found = await lookup(hashOf(token));
      expect(found).toEqual([
        {
          kind: "person",
          token_id: personalApiToken.id,
          user_id: user.id,
          email: user.email,
          access: "write",
          organization_id: null,
          role: null,
        },
      ]);
      // No context: the API's role sees none of the rows through the policies, and the definer is exempt.
      expect(await db.selectFrom("personal_api_tokens").select("id").execute()).toEqual([]);
      // Keyed by the exact hash: not the token, not a prefix, not a pattern, not capitals.
      for (const probe of [token, hashOf(token).slice(0, 63), `${hashOf(token).slice(0, 10)}%`, "%", hashOf(token).toUpperCase(), ""]) {
        expect((await lookup(probe)).length).toBe(0);
      }
    });

    describe("answers no row for a revoked or expired token, a soft-deleted user, or a user who isn't a person", () => {
      it("a revoked token", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const { personalApiToken, token } = await addPersonalApiToken(ownerDb, { userId: user.id });
        expect(await lookup(hashOf(token))).toHaveLength(1);
        await ownerDb.updateTable("personal_api_tokens").set({ revoked_at: new Date() }).where("id", "=", personalApiToken.id).execute();
        expect(await lookup(hashOf(token))).toEqual([]);
      });

      it("an expired token: at its expiry by p_at, the caller's clock; one second before, it is live", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const expiresAt = new Date("2026-06-01T12:00:00Z");
        const { token } = await addPersonalApiToken(ownerDb, {
          userId: user.id,
          created_at: new Date("2026-01-01T00:00:00Z"),
          expires_at: expiresAt,
        });
        expect(await lookup(hashOf(token), new Date(expiresAt.getTime() - 1000))).toHaveLength(1);
        expect(await lookup(hashOf(token), expiresAt)).toEqual([]);
        expect(await lookup(hashOf(token), new Date(expiresAt.getTime() + 1000))).toEqual([]);
      });

      it("a soft-deleted user", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const { token } = await addPersonalApiToken(ownerDb, { userId: user.id });
        expect(await lookup(hashOf(token))).toHaveLength(1);
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
        expect(await lookup(hashOf(token))).toEqual([]);
      });

      it("a service account's user holding a personal token (only an operator's SQL could make one)", async () => {
        const admin = await createUserWithOrganization(ownerDb);
        const group = await addMembership(ownerDb, { userId: admin.user.id });
        const { user: bot } = await addServiceAccount(ownerDb, { organizationId: group.organization.id, createdByUserId: admin.user.id });
        const { token } = await addPersonalApiToken(ownerDb, { userId: bot.id });
        expect(await lookup(hashOf(token))).toEqual([]);
      });
    });

    it("goes with its user's hard delete", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await addPersonalApiToken(ownerDb, { userId: user.id });
      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();
      await ownerDb.deleteFrom("organizations").where("id", "=", organization.id).execute();
      expect(await ownerDb.selectFrom("personal_api_tokens").select("id").execute()).toEqual([]);
    });

    it("an operator's hard delete takes every token of that person (revoked ones too) and no one else's", async () => {
      const ana = await createUserWithOrganization(ownerDb);
      const ben = await createUserWithOrganization(ownerDb);
      await addPersonalApiToken(ownerDb, { userId: ana.user.id, access: "write" });
      // One instant for both: a revoked_at read before the fixture's own created_at could fall a millisecond before it (the check refuses it).
      const at = new Date();
      await addPersonalApiToken(ownerDb, { userId: ana.user.id, created_at: at, revoked_at: at });
      const bens = await addPersonalApiToken(ownerDb, { userId: ben.user.id });
      await ownerDb.deleteFrom("users").where("id", "=", ana.user.id).execute();
      expect(await ownerDb.selectFrom("personal_api_tokens").select(["id", "user_id"]).execute()).toEqual([
        { id: bens.personalApiToken.id, user_id: ben.user.id },
      ]);
      expect(await lookup(hashOf(bens.token))).toHaveLength(1);
    });

    it("a soft-deleted person's every token is refused, write access and an unexpiring one included; the rows stay", async () => {
      const ana = await createUserWithOrganization(ownerDb);
      const tokens = [
        await addPersonalApiToken(ownerDb, { userId: ana.user.id, access: "write" }),
        await addPersonalApiToken(ownerDb, {
          userId: ana.user.id,
          created_at: new Date(Date.now() - 60_000),
          expires_at: new Date(Date.now() + 86_400_000),
        }),
      ];
      for (const { token } of tokens) expect(await lookup(hashOf(token))).toHaveLength(1);
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", ana.user.id).execute();
      for (const { token } of tokens) expect(await lookup(hashOf(token))).toEqual([]);
      expect(await ownerDb.selectFrom("personal_api_tokens").select("id").where("user_id", "=", ana.user.id).execute()).toHaveLength(2);
    });
  });

  describe("row-level security on the context's user, as the application role", () => {
    /** `work` in a transaction whose database context names `userId` (none for null), and `organizationId` if given. */
    const asUser = <T>(userId: string | null, work: (transaction: Kysely<Database>) => Promise<T>, organizationId?: string) =>
      db.transaction().execute(async (transaction) => {
        if (userId !== null) await sql`select set_config('telflo.user_id', ${userId}, true)`.execute(transaction);
        if (organizationId !== undefined) {
          await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
        }
        return work(transaction);
      });
    const tokenIds = (transaction: Kysely<Database>) =>
      transaction.selectFrom("personal_api_tokens").select("id").orderBy("id").execute();
    const tokenRow = (userId: string) => ({
      user_id: userId,
      name: `token-${randomUUID()}`,
      token_hash: randomBytes(32).toString("hex"),
      token_prefix: `tf_${randomBytes(6).toString("base64url")}`,
      access: "read" as const,
      created_at: new Date(),
    });

    it("a person reads only their own tokens, whatever organization the context names; no context reads none", async () => {
      const ana = await createUserWithOrganization(ownerDb);
      const ben = await createUserWithOrganization(ownerDb);
      const anas = await addPersonalApiToken(ownerDb, { userId: ana.user.id });
      const bens = await addPersonalApiToken(ownerDb, { userId: ben.user.id });

      expect(await asUser(ana.user.id, tokenIds)).toEqual([{ id: anas.personalApiToken.id }]);
      expect(await asUser(ben.user.id, tokenIds)).toEqual([{ id: bens.personalApiToken.id }]);
      // Ben's organization named beside Ana: still only Ana's.
      expect(await asUser(ana.user.id, tokenIds, ben.organization.id)).toEqual([{ id: anas.personalApiToken.id }]);
      expect(await asUser(null, tokenIds)).toEqual([]);
      expect(await asUser(null, tokenIds, ana.organization.id)).toEqual([]);
    });

    it("a person changes and deletes only their own tokens: another's update and delete touch 0 rows, and none is moved to another", async () => {
      const ana = await createUserWithOrganization(ownerDb);
      const ben = await createUserWithOrganization(ownerDb);
      const anas = await addPersonalApiToken(ownerDb, { userId: ana.user.id });
      const bens = await addPersonalApiToken(ownerDb, { userId: ben.user.id });
      const bensBefore = await ownerDb.selectFrom("personal_api_tokens").selectAll().where("id", "=", bens.personalApiToken.id).execute();

      const cross = await asUser(ana.user.id, async (transaction) => [
        (await transaction.updateTable("personal_api_tokens").set({ revoked_at: new Date() }).where("id", "=", bens.personalApiToken.id).executeTakeFirst())
          .numUpdatedRows,
        (await transaction.updateTable("personal_api_tokens").set({ last_used_at: new Date() }).where("user_id", "=", ben.user.id).executeTakeFirst())
          .numUpdatedRows,
        (await transaction.deleteFrom("personal_api_tokens").where("id", "=", bens.personalApiToken.id).executeTakeFirst()).numDeletedRows,
      ]);
      expect(cross).toEqual([0n, 0n, 0n]);
      expect(
        await ownerDb.selectFrom("personal_api_tokens").selectAll().where("id", "=", bens.personalApiToken.id).execute(),
      ).toEqual(bensBefore);

      const own = await asUser(ana.user.id, async (transaction) =>
        (await transaction.updateTable("personal_api_tokens").set({ last_used_at: new Date() }).where("id", "=", anas.personalApiToken.id).executeTakeFirst())
          .numUpdatedRows,
      );
      expect(own).toBe(1n);
      // Moving one's own token onto another person is refused by the update policy's check (42501).
      await expect(
        asUser(ana.user.id, (transaction) =>
          transaction
            .updateTable("personal_api_tokens")
            .set({ user_id: ben.user.id } as never)
            .where("id", "=", anas.personalApiToken.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // The same with NO WHERE: an update that reads no column isn't checked against the select policy, so only
      // the update policy's WITH CHECK refuses moving Ana's tokens onto Ben.
      await expect(
        asUser(ana.user.id, (transaction) => sql`update personal_api_tokens set user_id = ${ben.user.id}`.execute(transaction)),
      ).rejects.toMatchObject({ code: "42501" });
      // A delete with no WHERE takes Ana's own token only: Ben's survives, as Ben reads it.
      const ownDelete = await asUser(ana.user.id, async (transaction) =>
        Number((await sql`delete from personal_api_tokens`.execute(transaction)).numAffectedRows),
      );
      expect(ownDelete).toBe(1);
      const bensLeft = await asUser(ben.user.id, async (transaction) =>
        (
          await transaction
            .selectFrom("personal_api_tokens")
            .select((eb) => eb.fn.countAll<string>().as("count"))
            .where("id", "=", bens.personalApiToken.id)
            .executeTakeFirstOrThrow()
        ).count,
      );
      expect(Number(bensLeft)).toBe(1);
      expect(await ownerDb.selectFrom("personal_api_tokens").select("id").where("user_id", "=", ana.user.id).execute()).toEqual([]);
    });

    it("a person inserts tokens only for themselves: another's, or any with no context, is refused (42501)", async () => {
      const ana = await createUserWithOrganization(ownerDb);
      const ben = await createUserWithOrganization(ownerDb);
      for (const context of [ana.user.id, null]) {
        await expect(
          asUser(context, (transaction) => transaction.insertInto("personal_api_tokens").values(tokenRow(ben.user.id)).execute()),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        asUser(ana.user.id, (transaction) =>
          transaction.insertInto("personal_api_tokens").values(tokenRow(ana.user.id)).returning("user_id").executeTakeFirstOrThrow(),
        ),
      ).resolves.toEqual({ user_id: ana.user.id });
      expect(await ownerDb.selectFrom("personal_api_tokens").select("user_id").execute()).toEqual([{ user_id: ana.user.id }]);
    });
  });

  describe("the table's checks and indexes", () => {
    it("a name is unique, case aside, among the person's tokens not revoked; the checks hold", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const first = await addPersonalApiToken(ownerDb, { userId: user.id, name: "CI" });
      await expect(addPersonalApiToken(ownerDb, { userId: user.id, name: "ci" })).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_personal_api_tokens_user_id_lower_name",
      });
      await ownerDb.updateTable("personal_api_tokens").set({ revoked_at: new Date() }).where("id", "=", first.personalApiToken.id).execute();
      await expect(addPersonalApiToken(ownerDb, { userId: user.id, name: "ci" })).resolves.toBeDefined();

      const created = new Date("2026-01-01T00:00:00Z");
      for (const [values, constraint] of [
        [{ name: "" }, "ck_personal_api_tokens_name"],
        [{ name: "x".repeat(65) }, "ck_personal_api_tokens_name"],
        [{ token_hash: "A".repeat(64) }, "ck_personal_api_tokens_token_hash"],
        [{ token_prefix: "tf_123456789" }, "ck_personal_api_tokens_token_prefix"],
        [{ created_at: created, expires_at: created }, "ck_personal_api_tokens_expires_after_created"],
        [{ created_at: created, last_used_at: new Date(created.getTime() - 1) }, "ck_personal_api_tokens_last_used_after_created"],
        [{ created_at: created, revoked_at: new Date(created.getTime() - 1) }, "ck_personal_api_tokens_revoked_after_created"],
      ] as const) {
        await expect(addPersonalApiToken(ownerDb, { userId: user.id, ...values })).rejects.toMatchObject({ code: "23514", constraint });
      }
      const { personalApiToken } = await addPersonalApiToken(ownerDb, { userId: user.id });
      await expect(
        addPersonalApiToken(ownerDb, { userId: user.id, token_hash: personalApiToken.token_hash }),
      ).rejects.toMatchObject({ code: "23505", constraint: "uq_personal_api_tokens_token_hash" });
    });
  });
});
