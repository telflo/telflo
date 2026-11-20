import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * users.kind, service_accounts, api_tokens and the token lookup (migration
 * 1700000000035): the backstops and the tables' constraints, as the owner and
 * as the API's role (`db`); row-level security and the lookup, as the API's
 * role. schema.integration.test.ts has the migration's catalogue (up, down,
 * up). No test prints a token: a failing assertion compares hashes, ids or
 * booleans.
 */
describe("service accounts and API tokens", () => {
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
    return { adminId: admin.user.id, organizationId: group.organization.id };
  };

  /** A service account in a new group organization, with the organization's admin. */
  const createServiceAccount = async (name?: string) => {
    const organization = await createOrganization();
    const added = await addServiceAccount(ownerDb, {
      organizationId: organization.organizationId,
      createdByUserId: organization.adminId,
      ...(name === undefined ? {} : { name }),
    });
    return { ...organization, ...added, serviceAccountId: added.user.id };
  };

  /**
   * Runs `work` as the owner in a transaction that is always rolled back:
   * for a state the membership invariant would refuse at commit (a service
   * account's only membership removed, or its organization deleted).
   */
  const rolledBack = async <T>(work: (transaction: Kysely<Database>) => Promise<T>): Promise<T> => {
    const rollback = new Error("rollback");
    let result: T | undefined;
    await expect(
      ownerDb.transaction().execute(async (transaction) => {
        result = await work(transaction);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    return result as T;
  };

  /** A users row inserted as the owner, with an admin membership of a new personal organization (the invariant). */
  const insertUser = (values: Record<string, unknown>) =>
    ownerDb.transaction().execute(async (transaction) => {
      const user = await transaction
        .insertInto("users")
        .values(values as never)
        .returningAll()
        .executeTakeFirstOrThrow();
      const organization = await transaction
        .insertInto("organizations")
        .values({ name: "A workspace", type: "personal", owner_user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("organization_members")
        .values({ organization_id: organization.id, user_id: user.id, role: "admin" })
        .execute();
      return user;
    });

  /** A service user's columns at the reserved domain, verified, with no password. */
  const serviceUser = (local = randomUUID()) => ({
    email: `${local}@service-accounts.telflo.invalid`,
    email_verified_at: new Date(),
    kind: "service",
  });

  describe("users.kind and its backstops", () => {
    it("every existing user is human, and a user inserted without a kind is human", async () => {
      const person = await createUserWithOrganization(ownerDb);
      expect(person.user.kind).toBe("human");
      const plain = await insertUser({ email: `plain-${randomUUID()}@example.com` });
      expect(plain.kind).toBe("human");
      expect(await ownerDb.selectFrom("users").select("kind").distinct().execute()).toEqual([{ kind: "human" }]);
      const { rows: column } = await sql<{ fallback: string; notNull: boolean }>`
        select pg_get_expr(d.adbin, d.adrelid) as fallback, a.attnotnull as "notNull"
          from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = 'users'::regclass and a.attname = 'kind'
      `.execute(ownerDb);
      expect(column).toEqual([{ fallback: "'human'::user_kind", notNull: true }]);
    });

    it("refuses a service account with a password or without a verified email", async () => {
      await expect(insertUser({ ...serviceUser(), password_hash: "$argon2id$v=19$not-a-real-hash" })).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_users_service_account_credentials",
      });
      await expect(insertUser({ ...serviceUser(), email_verified_at: null })).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_users_service_account_credentials",
      });
      // An update as the API's role is held to it too: a reset could never give one a password.
      const { serviceAccountId } = await createServiceAccount();
      await expect(
        db.updateTable("users").set({ password_hash: "$argon2id$v=19$not-a-real-hash" }).where("id", "=", serviceAccountId).execute(),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_users_service_account_credentials" });
      await expect(
        db.updateTable("users").set({ email_verified_at: null }).where("id", "=", serviceAccountId).execute(),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_users_service_account_credentials" });
      // A person may have both, or neither.
      await expect(insertUser({ email: `person-${randomUUID()}@example.com`, password_hash: "x" })).resolves.toMatchObject({
        kind: "human",
      });
    });

    it("refuses the reserved domain on a human and any other domain on a service account, case aside", async () => {
      for (const email of ["x@service-accounts.telflo.invalid", "X@Service-Accounts.Telflo.Invalid"]) {
        await expect(insertUser({ email: `${randomUUID()}${email}` })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_users_service_account_domain",
        });
      }
      for (const email of ["x@example.com", "x@sub.service-accounts.telflo.invalid", "x@service-accounts.telflo.invalid.example"]) {
        await expect(insertUser({ ...serviceUser(), email: `${randomUUID()}${email}` })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_users_service_account_domain",
        });
      }
      // The exact domain only: a person at a subdomain is admitted, and a service account in capitals.
      await expect(insertUser({ email: `${randomUUID()}x@sub.service-accounts.telflo.invalid` })).resolves.toMatchObject({
        kind: "human",
      });
      await expect(
        insertUser({ ...serviceUser(), email: `${randomUUID()}X@SERVICE-ACCOUNTS.TELFLO.INVALID` }),
      ).resolves.toMatchObject({ kind: "service" });
      // An update as the API's role is held to it too.
      const person = await createUserWithOrganization(ownerDb);
      await expect(
        db.updateTable("users").set({ email: `${randomUUID()}@service-accounts.telflo.invalid` }).where("id", "=", person.user.id).execute(),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_users_service_account_domain" });
    });

    it("refuses the API's role a change of kind, and lets the owner make one", async () => {
      const person = await createUserWithOrganization(ownerDb);
      const { serviceAccountId } = await createServiceAccount();
      const kindOf = async (id: string) =>
        (await ownerDb.selectFrom("users").select("kind").where("id", "=", id).executeTakeFirstOrThrow()).kind;

      await expect(
        db
          .updateTable("users")
          .set({ kind: "service", email: `${randomUUID()}@service-accounts.telflo.invalid`, password_hash: null })
          .where("id", "=", person.user.id)
          .execute(),
      ).rejects.toMatchObject({ code: "42501", message: `only the tables' owner changes the kind of user ${person.user.id}` });
      await expect(
        db
          .updateTable("users")
          .set({ kind: "human", email: `${randomUUID()}@example.com` })
          .where("id", "=", serviceAccountId)
          .execute(),
      ).rejects.toMatchObject({ code: "42501", message: `only the tables' owner changes the kind of user ${serviceAccountId}` });
      expect([await kindOf(person.user.id), await kindOf(serviceAccountId)]).toEqual(["human", "service"]);

      // An update that leaves kind as it is passes, for both roles, naming it or not.
      await db.updateTable("users").set({ kind: "human", updated_at: new Date() }).where("id", "=", person.user.id).execute();
      await db.updateTable("users").set({ kind: "service" }).where("id", "=", serviceAccountId).execute();
      await ownerDb.updateTable("users").set({ kind: "human" }).where("id", "=", person.user.id).execute();

      // The owner (an operator's SQL) may change it, held to the checks.
      await ownerDb
        .updateTable("users")
        .set({ kind: "human", email: `${randomUUID()}@example.com` })
        .where("id", "=", serviceAccountId)
        .execute();
      expect(await kindOf(serviceAccountId)).toBe("human");
    });

    it("refuses a service account a user_identities row and a session, and admits a human's", async () => {
      const person = await createUserWithOrganization(ownerDb);
      const { serviceAccountId, organizationId } = await createServiceAccount();
      const identity = (userId: string) => ({
        user_id: userId,
        provider: "google",
        provider_subject: `subject-${randomUUID()}`,
        email: "person@example.com",
      });

      for (const connection of [db, ownerDb]) {
        await expect(connection.insertInto("user_identities").values(identity(serviceAccountId)).execute()).rejects.toMatchObject({
          code: "23514",
          message: `user ${serviceAccountId} is a service account and links no identity`,
        });
        await expect(
          connection.insertInto("sessions").values({ user_id: serviceAccountId, active_organization_id: organizationId }).execute(),
        ).rejects.toMatchObject({ code: "23514", message: `user ${serviceAccountId} is a service account and has no session` });
      }
      // Nor can a person's identity be moved onto one.
      const linked = await db.insertInto("user_identities").values(identity(person.user.id)).returning("id").executeTakeFirstOrThrow();
      await expect(
        db.updateTable("user_identities").set({ user_id: serviceAccountId }).where("id", "=", linked.id).execute(),
      ).rejects.toMatchObject({ code: "23514", message: `user ${serviceAccountId} is a service account and links no identity` });
      await expect(
        db
          .insertInto("sessions")
          .values({ user_id: person.user.id, active_organization_id: person.organization.id })
          .returning("user_id")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ user_id: person.user.id });

      expect(await ownerDb.selectFrom("user_identities").select("user_id").execute()).toEqual([{ user_id: person.user.id }]);
      expect(await ownerDb.selectFrom("sessions").select("user_id").execute()).toEqual([{ user_id: person.user.id }]);
    });

    it("refuses moving a session onto a service account, and admits moving it between people", async () => {
      const person = await createUserWithOrganization(ownerDb);
      const other = await createUserWithOrganization(ownerDb);
      const { serviceAccountId, organizationId } = await createServiceAccount();
      await addMembership(ownerDb, { userId: person.user.id, organizationId });
      const session = await db
        .insertInto("sessions")
        .values({ user_id: person.user.id, active_organization_id: organizationId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const ownerOf = async () =>
        (await ownerDb.selectFrom("sessions").select("user_id").where("id", "=", session.id).executeTakeFirstOrThrow()).user_id;

      for (const connection of [db, ownerDb]) {
        await expect(
          connection.updateTable("sessions").set({ user_id: serviceAccountId }).where("id", "=", session.id).execute(),
        ).rejects.toMatchObject({ code: "23514", message: `user ${serviceAccountId} is a service account and has no session` });
        expect(await ownerOf()).toBe(person.user.id);
      }
      const moved = await db
        .updateTable("sessions")
        .set({ user_id: other.user.id })
        .where("id", "=", session.id)
        .executeTakeFirst();
      expect(moved.numUpdatedRows).toBe(1n);
      expect(await ownerOf()).toBe(other.user.id);
    });

    it("refuses a service_accounts row naming a person", async () => {
      const { organizationId, adminId } = await createOrganization();
      const at = new Date();
      const row = { organization_id: organizationId, name: "Deploy bot", created_at: at, updated_at: at };
      await expect(ownerDb.insertInto("service_accounts").values({ ...row, user_id: adminId }).execute()).rejects.toMatchObject({
        code: "23514",
        message: `user ${adminId} is a person, not a service account`,
      });
      // Nor moved onto one.
      const { serviceAccountId } = await createServiceAccount();
      await expect(
        ownerDb.updateTable("service_accounts").set({ user_id: adminId } as never).where("user_id", "=", serviceAccountId).execute(),
      ).rejects.toMatchObject({ code: "23514", message: `user ${adminId} is a person, not a service account` });
      // A user that doesn't exist is the foreign key's.
      await expect(
        ownerDb.insertInto("service_accounts").values({ ...row, user_id: "00000000-0000-7000-8000-000000000000" }).execute(),
      ).rejects.toMatchObject({ code: "23503", constraint: "service_accounts_user_id_fkey" });
    });
  });

  describe("service_accounts", () => {
    it("stores an account in the shape the API's create writes", async () => {
      const { serviceAccountId, organizationId, adminId, user, serviceAccount, membership } = await createServiceAccount("CI deploys");
      expect(user).toMatchObject({ kind: "service", password_hash: null, accepted_terms_version: null, deleted_at: null });
      expect(user.email_verified_at).toBeInstanceOf(Date);
      expect(user.email).toMatch(/^ci-deploys-[0-9a-f]{8}@service-accounts\.telflo\.invalid$/);
      expect(serviceAccount).toEqual({
        user_id: serviceAccountId,
        organization_id: organizationId,
        name: "CI deploys",
        created_by_user_id: adminId,
        created_at: serviceAccount.created_at,
        updated_at: serviceAccount.created_at,
        deleted_at: null,
      });
      expect(membership).toMatchObject({ organization_id: organizationId, user_id: serviceAccountId, role: "contributor" });
      expect(await ownerDb.selectFrom("organizations").select("id").where("owner_user_id", "=", serviceAccountId).execute()).toEqual([]);
    });

    it("refuses a service account's name of 0 or 65 characters, and a live duplicate case aside, and admits it beside a deleted one", async () => {
      const { organizationId, serviceAccountId } = await createServiceAccount("ci");
      for (const name of ["", "a".repeat(65)]) {
        await expect(addServiceAccount(ownerDb, { organizationId, name })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_service_accounts_name",
        });
      }
      await expect(addServiceAccount(ownerDb, { organizationId, name: "a".repeat(64) })).resolves.toBeDefined();
      await expect(addServiceAccount(ownerDb, { organizationId, name: "CI" })).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_service_accounts_organization_id_lower_name",
      });
      // Another organization may hold the name.
      const other = await createOrganization();
      await expect(addServiceAccount(ownerDb, { organizationId: other.organizationId, name: "CI" })).resolves.toBeDefined();

      const at = new Date();
      await ownerDb.updateTable("service_accounts").set({ deleted_at: at }).where("user_id", "=", serviceAccountId).execute();
      await expect(addServiceAccount(ownerDb, { organizationId, name: "CI" })).resolves.toBeDefined();
    });

    it("refuses a deletion before the creation", async () => {
      const { serviceAccountId, serviceAccount } = await createServiceAccount();
      await expect(
        ownerDb
          .updateTable("service_accounts")
          .set({ deleted_at: new Date(serviceAccount.created_at.getTime() - 1000) })
          .where("user_id", "=", serviceAccountId)
          .execute(),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_service_accounts_deleted_after_created" });
    });
  });

  describe("api_tokens", () => {
    it("stores a token as its hash and prefix, never the token", async () => {
      const { serviceAccountId, organizationId } = await createServiceAccount();
      const { apiToken, token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
      expect(/^tf_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
      expect(apiToken.token_hash === createHash("sha256").update(token).digest("hex")).toBe(true);
      expect(apiToken.token_prefix === token.slice(0, 11)).toBe(true);
      expect(apiToken).toMatchObject({ access: "read", expires_at: null, last_used_at: null, revoked_at: null });
      const { rows } = await sql<{ holds: boolean }>`
        select exists (select 1 from api_tokens t where strpos(row_to_json(t)::text, ${token}) > 0) as holds
      `.execute(ownerDb);
      expect(rows).toEqual([{ holds: false }]);
    });

    it.each([
      ["a hash that isn't SHA-256 hex (a token itself)", () => ({ token_hash: `tf_${"A".repeat(43)}` }), "ck_api_tokens_token_hash"],
      ["a hash in capitals", () => ({ token_hash: "A".repeat(64) }), "ck_api_tokens_token_hash"],
      ["a prefix of 12 characters", () => ({ token_prefix: "tf_AbC12xYz9" }), "ck_api_tokens_token_prefix"],
      ["a prefix without tf_", () => ({ token_prefix: "tqd_AbC12xY" }), "ck_api_tokens_token_prefix"],
      ["a prefix with a character outside base64url", () => ({ token_prefix: "tf_AbC1+xYz" }), "ck_api_tokens_token_prefix"],
      ["a name of 0 characters", () => ({ name: "" }), "ck_api_tokens_name"],
      ["a name of 65 characters", () => ({ name: "a".repeat(65) }), "ck_api_tokens_name"],
      [
        "an expiry not after its creation",
        () => ({ created_at: new Date("2026-10-23T00:00:00Z"), expires_at: new Date("2026-10-23T00:00:00Z") }),
        "ck_api_tokens_expires_after_created",
      ],
      [
        "a use before its creation",
        () => ({ created_at: new Date("2026-10-23T00:00:00Z"), last_used_at: new Date("2026-10-22T23:59:59Z") }),
        "ck_api_tokens_last_used_after_created",
      ],
      [
        "a revocation before its creation",
        () => ({ created_at: new Date("2026-10-23T00:00:00Z"), revoked_at: new Date("2026-10-22T23:59:59Z") }),
        "ck_api_tokens_revoked_after_created",
      ],
      ["a revoker without a revocation", () => ({ revoked_by_user_id: "admin" }), "ck_api_tokens_revoked_by"],
    ])("refuses a token's bad hash, bad prefix, an expiry not after its creation and a revoker without a revocation: %s", async (_label, values, constraint) => {
      const { serviceAccountId, organizationId, adminId } = await createServiceAccount();
      const overrides = values() as Record<string, unknown>;
      if (overrides.revoked_by_user_id === "admin") overrides.revoked_by_user_id = adminId;
      await expect(
        addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, ...overrides }),
      ).rejects.toMatchObject({ code: "23514", constraint });
      expect(await ownerDb.selectFrom("api_tokens").select("id").execute()).toEqual([]);
    });

    it("refuses a second token with the same hash, in any organization", async () => {
      const first = await createServiceAccount();
      const second = await createServiceAccount();
      const { apiToken } = await addApiToken(ownerDb, { organizationId: first.organizationId, serviceAccountUserId: first.serviceAccountId });
      await expect(
        addApiToken(ownerDb, {
          organizationId: second.organizationId,
          serviceAccountUserId: second.serviceAccountId,
          token_hash: apiToken.token_hash,
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "uq_api_tokens_token_hash" });
    });

    it("refuses a token name beside one not revoked, expired included, and admits it beside a revoked one", async () => {
      const { serviceAccountId, organizationId, adminId } = await createServiceAccount();
      const at = new Date("2026-10-23T09:00:00Z");
      const expired = await addApiToken(ownerDb, {
        organizationId,
        serviceAccountUserId: serviceAccountId,
        name: "deploy",
        created_at: at,
        expires_at: new Date(at.getTime() + 1000),
      });
      await expect(addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, name: "Deploy" })).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_api_tokens_service_account_user_id_lower_name",
      });
      // Another account of the organization may hold the name.
      const other = await addServiceAccount(ownerDb, { organizationId });
      await expect(addApiToken(ownerDb, { organizationId, serviceAccountUserId: other.user.id, name: "DEPLOY" })).resolves.toBeDefined();

      await ownerDb
        .updateTable("api_tokens")
        .set({ revoked_at: new Date(), revoked_by_user_id: adminId })
        .where("id", "=", expired.apiToken.id)
        .execute();
      await expect(addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, name: "Deploy" })).resolves.toBeDefined();
      // Two revoked tokens may share a name.
      const again = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, name: "rotated" });
      await ownerDb.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", again.apiToken.id).execute();
      const third = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, name: "rotated" });
      await ownerDb.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", third.apiToken.id).execute();
    });

    it("refuses a token naming another organization's account", async () => {
      const ours = await createServiceAccount();
      const theirs = await createServiceAccount();
      await expect(
        addApiToken(ownerDb, { organizationId: ours.organizationId, serviceAccountUserId: theirs.serviceAccountId }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_api_tokens_service_account" });
      // Nor one that isn't a service account at all.
      await expect(
        addApiToken(ownerDb, { organizationId: ours.organizationId, serviceAccountUserId: ours.adminId }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_api_tokens_service_account" });
      expect(await ownerDb.selectFrom("api_tokens").select("id").execute()).toEqual([]);
    });

    it("goes with its account's hard delete, and keeps a token whose creator or revoker is hard-deleted", async () => {
      const { serviceAccountId, organizationId } = await createServiceAccount();
      const colleague = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: colleague.user.id, organizationId });
      const at = new Date();
      const { apiToken } = await addApiToken(ownerDb, {
        organizationId,
        serviceAccountUserId: serviceAccountId,
        created_by_user_id: colleague.user.id,
        created_at: at,
        revoked_at: at,
        revoked_by_user_id: colleague.user.id,
      });
      await ownerDb.deleteFrom("users").where("id", "=", colleague.user.id).execute();
      expect(await ownerDb.selectFrom("api_tokens").selectAll().where("id", "=", apiToken.id).executeTakeFirst()).toMatchObject({
        created_by_user_id: null,
        revoked_by_user_id: null,
        revoked_at: at,
      });
      expect(
        await ownerDb.selectFrom("service_accounts").select("created_by_user_id").where("user_id", "=", serviceAccountId).executeTakeFirst(),
      ).toBeDefined();

      await ownerDb.deleteFrom("users").where("id", "=", serviceAccountId).execute();
      expect(await ownerDb.selectFrom("service_accounts").select("user_id").execute()).toEqual([]);
      expect(await ownerDb.selectFrom("api_tokens").select("id").execute()).toEqual([]);
    });
  });

  describe("the lookup by the token's hash", () => {
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
    /** The lookup as telflo_platform_runtime, inside an owner transaction (rolled back by the caller). */
    const lookupIn = async (transaction: Kysely<Database>, hash: string, at: Date = new Date()) => {
      await sql`set local role telflo_platform_runtime`.execute(transaction);
      return (await sql<Found>`select * from find_live_api_token_by_hash(${hash}, ${at}::timestamptz)`.execute(transaction)).rows;
    };
    const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

    it("the lookup answers a live token's kind, id, account, its address, access, organization and role, and nothing else", async () => {
      const { serviceAccountId, organizationId, user } = await createServiceAccount();
      const { apiToken, token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, access: "write" });
      await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });

      const found = await lookup(hashOf(token));
      expect(found).toEqual([
        {
          kind: "service_account",
          token_id: apiToken.id,
          user_id: serviceAccountId,
          email: user.email,
          access: "write",
          organization_id: organizationId,
          role: "contributor",
        },
      ]);
      expect(Object.keys(found[0]!)).toEqual(["kind", "token_id", "user_id", "email", "access", "organization_id", "role"]);
      // No context: the API's role sees none of the rows through the policies, and the definer is exempt.
      expect(await db.selectFrom("api_tokens").select("id").execute()).toEqual([]);
      // Keyed by the exact hash: not the token, not a prefix, not a pattern, not capitals.
      for (const probe of [token, hashOf(token).slice(0, 63), `${hashOf(token).slice(0, 10)}%`, "%", hashOf(token).toUpperCase(), ""]) {
        expect((await lookup(probe)).length).toBe(0);
      }
    });

    describe("the lookup answers no row for an unknown hash, a revoked or expired token, a deleted account, user, membership or organization", () => {
      it("an unknown hash", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        expect(await lookup(hashOf(`tf_${randomBytes(32).toString("base64url")}`))).toEqual([]);
      });

      it("a revoked token", async () => {
        const { serviceAccountId, organizationId, adminId } = await createServiceAccount();
        const { apiToken, token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        expect(await lookup(hashOf(token))).toHaveLength(1);
        await ownerDb
          .updateTable("api_tokens")
          .set({ revoked_at: new Date(), revoked_by_user_id: adminId })
          .where("id", "=", apiToken.id)
          .execute();
        expect(await lookup(hashOf(token))).toEqual([]);
      });

      it("an expired token: at its expiry by p_at, the caller's clock; one second before, it is live", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        const expiresAt = new Date("2026-06-01T12:00:00Z");
        const { token } = await addApiToken(ownerDb, {
          organizationId,
          serviceAccountUserId: serviceAccountId,
          created_at: new Date("2026-01-01T00:00:00Z"),
          expires_at: expiresAt,
        });
        expect(await lookup(hashOf(token), new Date(expiresAt.getTime() - 1000))).toHaveLength(1);
        expect(await lookup(hashOf(token), expiresAt)).toEqual([]);
        expect(await lookup(hashOf(token), new Date(expiresAt.getTime() + 1000))).toEqual([]);
      });

      it("a deleted account (its service_accounts row)", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        const { token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        await ownerDb.updateTable("service_accounts").set({ deleted_at: new Date() }).where("user_id", "=", serviceAccountId).execute();
        expect(await lookup(hashOf(token))).toEqual([]);
      });

      it("a deleted user", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        const { token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", serviceAccountId).execute();
        expect(await lookup(hashOf(token))).toEqual([]);
      });

      it("a removed membership (the invariant would refuse it at commit: rolled back)", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        const { token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        const found = await rolledBack(async (transaction) => {
          expect(await lookupIn(transaction, hashOf(token))).toHaveLength(1);
          await sql`reset role`.execute(transaction);
          await transaction
            .updateTable("organization_members")
            .set({ deleted_at: new Date() })
            .where("user_id", "=", serviceAccountId)
            .execute();
          return lookupIn(transaction, hashOf(token));
        });
        expect(found).toEqual([]);
      });

      it("a deleted organization (rolled back, as the membership's)", async () => {
        const { serviceAccountId, organizationId } = await createServiceAccount();
        const { token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
        const found = await rolledBack(async (transaction) => {
          await transaction.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", organizationId).execute();
          return lookupIn(transaction, hashOf(token));
        });
        expect(found).toEqual([]);
      });

      it("a person's token, the backstop disabled for the moment (rolled back)", async () => {
        const { organizationId, adminId } = await createOrganization();
        const found = await rolledBack(async (transaction) => {
          await sql`alter table service_accounts disable trigger service_accounts_service_only`.execute(transaction);
          const at = new Date();
          await transaction
            .insertInto("service_accounts")
            .values({ user_id: adminId, organization_id: organizationId, name: "A person", created_at: at, updated_at: at })
            .execute();
          const added = await addApiToken(transaction, { organizationId, serviceAccountUserId: adminId });
          return lookupIn(transaction, hashOf(added.token));
        });
        expect(found).toEqual([]);
        expect(
          (
            await sql<{ enabled: string }>`
              select tgenabled::text as enabled from pg_trigger where tgname = 'service_accounts_service_only'
            `.execute(ownerDb)
          ).rows,
        ).toEqual([{ enabled: "O" }]);
      });
    });

    it("the lookup is refused to a role without the grant", async () => {
      const { serviceAccountId, organizationId } = await createServiceAccount();
      const { token } = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId });
      const { rows } = await sql<{ application: boolean; everyone: boolean; definer: boolean; volatility: string; config: string[] }>`
        select has_function_privilege('telflo_platform_runtime', 'find_live_api_token_by_hash(text, timestamptz)', 'EXECUTE') as application,
               has_function_privilege('public', 'find_live_api_token_by_hash(text, timestamptz)', 'EXECUTE') as everyone,
               p.prosecdef as definer, p.provolatile::text as volatility, p.proconfig as config
          from pg_proc p where p.proname = 'find_live_api_token_by_hash'
      `.execute(ownerDb);
      expect(rows).toEqual([
        { application: true, everyone: false, definer: true, volatility: "s", config: ["search_path=pg_catalog, platform"] },
      ]);

      // A role that exists only inside this rolled-back transaction (roles belong to the whole server), with PUBLIC's rights only.
      const outsider = `test_outsider_${randomUUID().replaceAll("-", "")}`;
      const refusal = await rolledBack(async (transaction) => {
        await sql`create role ${sql.id(outsider)} nologin`.execute(transaction);
        // USAGE on the schema, so the call reaches the function and its own grant refuses it.
        await sql`grant usage on schema platform to ${sql.id(outsider)}`.execute(transaction);
        await sql`set local role ${sql.id(outsider)}`.execute(transaction);
        return sql`select * from find_live_api_token_by_hash(${hashOf(token)}, now())`
          .execute(transaction)
          .then(() => undefined)
          .catch((error: unknown) => error);
      });
      expect(refusal).toMatchObject({ code: "42501", message: "permission denied for function find_live_api_token_by_hash" });
    });
  });

  describe("row-level security, as the application role", () => {
    /** `work` in a transaction whose database context names `organizationId` (none for null). */
    const inContext = <T>(organizationId: string | null, work: (transaction: Kysely<Database>) => Promise<T>) =>
      db.transaction().execute(async (transaction) => {
        if (organizationId !== null) await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
        return work(transaction);
      });

    it("the API's role reads, inserts, updates and deletes both tables only in the context's organization", async () => {
      const a = await createServiceAccount();
      const b = await createServiceAccount();
      const inA = await addApiToken(ownerDb, { organizationId: a.organizationId, serviceAccountUserId: a.serviceAccountId });
      const inB = await addApiToken(ownerDb, { organizationId: b.organizationId, serviceAccountUserId: b.serviceAccountId });
      const accountIds = (transaction: Kysely<Database>) => transaction.selectFrom("service_accounts").select("user_id").execute();
      const tokenIds = (transaction: Kysely<Database>) => transaction.selectFrom("api_tokens").select("id").execute();

      // Reads.
      expect(await inContext(null, accountIds)).toEqual([]);
      expect(await inContext(null, tokenIds)).toEqual([]);
      expect(await inContext(a.organizationId, accountIds)).toEqual([{ user_id: a.serviceAccountId }]);
      expect(await inContext(a.organizationId, tokenIds)).toEqual([{ id: inA.apiToken.id }]);
      expect(await inContext(b.organizationId, tokenIds)).toEqual([{ id: inB.apiToken.id }]);

      // Updates: the context's own rows, never another organization's, and none moved into one.
      const renamed = await inContext(a.organizationId, (transaction) =>
        transaction.updateTable("service_accounts").set({ name: "Renamed", updated_at: new Date() }).executeTakeFirst(),
      );
      expect(renamed.numUpdatedRows).toBe(1n);
      const revoked = await inContext(a.organizationId, (transaction) =>
        transaction.updateTable("api_tokens").set({ revoked_at: new Date(), revoked_by_user_id: a.adminId }).executeTakeFirst(),
      );
      expect(revoked.numUpdatedRows).toBe(1n);
      const bAccountBefore = await ownerDb.selectFrom("service_accounts").selectAll().where("user_id", "=", b.serviceAccountId).executeTakeFirst();
      const bTokenBefore = await ownerDb.selectFrom("api_tokens").selectAll().where("id", "=", inB.apiToken.id).executeTakeFirst();
      const crossUpdates = await inContext(a.organizationId, async (transaction) => [
        (await transaction.updateTable("service_accounts").set({ name: "Taken" }).where("user_id", "=", b.serviceAccountId).executeTakeFirst())
          .numUpdatedRows,
        (await transaction.updateTable("api_tokens").set({ last_used_at: new Date() }).where("id", "=", inB.apiToken.id).executeTakeFirst())
          .numUpdatedRows,
      ]);
      expect(crossUpdates).toEqual([0n, 0n]);
      await expect(
        inContext(a.organizationId, (transaction) =>
          transaction
            .updateTable("service_accounts")
            .set({ organization_id: b.organizationId } as never)
            .where("user_id", "=", a.serviceAccountId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Deletes: none of another organization's.
      const crossDeletes = await inContext(a.organizationId, async (transaction) => [
        (await transaction.deleteFrom("api_tokens").where("id", "=", inB.apiToken.id).executeTakeFirst()).numDeletedRows,
        (await transaction.deleteFrom("service_accounts").where("user_id", "=", b.serviceAccountId).executeTakeFirst()).numDeletedRows,
      ]);
      expect(crossDeletes).toEqual([0n, 0n]);
      expect(await ownerDb.selectFrom("service_accounts").selectAll().where("user_id", "=", b.serviceAccountId).executeTakeFirst()).toEqual(
        bAccountBefore,
      );
      expect(await ownerDb.selectFrom("api_tokens").selectAll().where("id", "=", inB.apiToken.id).executeTakeFirst()).toEqual(bTokenBefore);
      const ownDelete = await inContext(a.organizationId, (transaction) =>
        transaction.deleteFrom("api_tokens").where("id", "=", inA.apiToken.id).executeTakeFirst(),
      );
      expect(ownDelete.numDeletedRows).toBe(1n);

      // Inserts: the context's organization only (42501), and with none.
      const at = new Date();
      const tokenRow = (organizationId: string, serviceAccountUserId: string) => ({
        organization_id: organizationId,
        service_account_user_id: serviceAccountUserId,
        name: `token-${randomUUID()}`,
        token_hash: randomBytes(32).toString("hex"),
        token_prefix: `tf_${randomBytes(6).toString("base64url")}`,
        access: "read" as const,
        created_at: at,
      });
      for (const context of [a.organizationId, null]) {
        await expect(
          inContext(context, (transaction) => transaction.insertInto("api_tokens").values(tokenRow(b.organizationId, b.serviceAccountId)).execute()),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        inContext(a.organizationId, (transaction) =>
          transaction.insertInto("api_tokens").values(tokenRow(a.organizationId, a.serviceAccountId)).returning("organization_id").executeTakeFirstOrThrow(),
        ),
      ).resolves.toEqual({ organization_id: a.organizationId });

      // An account's row in B, its service user made by the owner: refused from A's context, admitted from B's.
      const extra = await addServiceAccount(ownerDb, { organizationId: b.organizationId });
      await ownerDb.deleteFrom("service_accounts").where("user_id", "=", extra.user.id).execute();
      const accountRow = { user_id: extra.user.id, organization_id: b.organizationId, name: "Second", created_at: at, updated_at: at };
      await expect(
        inContext(a.organizationId, (transaction) => transaction.insertInto("service_accounts").values(accountRow).execute()),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inContext(b.organizationId, (transaction) =>
          transaction.insertInto("service_accounts").values(accountRow).returning("user_id").executeTakeFirstOrThrow(),
        ),
      ).resolves.toEqual({ user_id: extra.user.id });
    });
  });
});
