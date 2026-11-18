import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Insertable, Kysely } from "kysely";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { createDb, createPool } from "./pool.js";
import type { Database, UsersTable } from "./schema.js";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addPersonalApiToken,
  addQuickDeployLink,
  addServiceAccount,
  addTestDefinition,
  addTestDefinitionInput,
  addTestInputFile,
  addTestRun,
  addTestSuite,
  addLibraryFile,
  addTestTemplate,
  addValidationPipeline,
  addValidationRule,
  applicationTables,
  catalogueTables,
  createUserWithOrganization,
  insertSeededTestRegexes,
  loadTestRegexMigration,
  singletonTables,
  openTestDatabases,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { PLATFORM_CONNECTION_OPTIONS, PLATFORM_MIGRATION_OPTIONS } from "./database-schema.js";

// The schema's own tests run as the tables' owner, as migrations do. The
// application role's privileges have their own describe block, which uses
// `db`, the API's login role.
describe("schema", () => {
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

  /**
   * For tests whose subject is the users insert itself (its defaults and
   * constraints): inserts exactly `values`, then an organization and a
   * membership in the same transaction, since the membership invariant
   * refuses a user committed alone. Fixtures use createUserWithOrganization.
   */
  const insertUserWithMembership = (values: Insertable<UsersTable>) =>
    ownerDb.transaction().execute(async (transaction) => {
      const user = await transaction
        .insertInto("users")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      const organization = await transaction
        .insertInto("organizations")
        .values({ name: "An organization", type: "personal", owner_user_id: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("organization_members")
        .values({ organization_id: organization.id, user_id: user.id, role: "admin" })
        .execute();
      return user;
    });

  const insertUser = (email: string) =>
    insertUserWithMembership({ email, accepted_terms_version: "2026-01-01", terms_accepted_at: new Date() });

  describe("users", () => {
    it("assigns an ascending uuidv7 primary key", async () => {
      const first = await createUserWithOrganization(ownerDb);
      const second = await createUserWithOrganization(ownerDb);
      expect(first.user.id < second.user.id).toBe(true);
    });

    it("defaults a new user to unverified with no password", async () => {
      const user = await insertUser("new@example.com");
      expect(user.email_verified_at).toBeNull();
      expect(user.password_hash).toBeNull();
    });

    // The duplicate is inserted with a membership, so the only thing that
    // can refuse it is the unique index, not the membership invariant.
    it("rejects a duplicate email", async () => {
      await insertUser("taken@example.com");
      await expect(insertUser("taken@example.com")).rejects.toThrow(/uq_users_lower_email/);
    });

    it("rejects an email differing only in case", async () => {
      await insertUser("person@example.com");
      await expect(insertUser("Person@Example.com")).rejects.toThrow(/uq_users_lower_email/);
    });

    // Inverted by D2c: an account created through a provider has accepted
    // no terms until the terms dialog records them (decision 6).
    it("allows a user who has accepted no terms version", async () => {
      const user = await insertUserWithMembership({ email: "noterms@example.com" });
      expect(user).toMatchObject({ accepted_terms_version: null, terms_accepted_at: null });
    });

    it("refuses a terms version without its acceptance time, and a time without a version", async () => {
      await expect(
        insertUserWithMembership({ email: "version-only@example.com", accepted_terms_version: "2026-01-01" }),
      ).rejects.toThrow(/chk_users_terms_accepted_together/);
      await expect(
        insertUserWithMembership({ email: "time-only@example.com", terms_accepted_at: new Date() }),
      ).rejects.toThrow(/chk_users_terms_accepted_together/);
    });
  });

  describe("user_identities", () => {
    const insertIdentity = (userId: string, provider: string, subject: string) =>
      ownerDb
        .insertInto("user_identities")
        .values({ user_id: userId, provider, provider_subject: subject, email: "person@example.com" })
        .returningAll()
        .executeTakeFirstOrThrow();

    it("links an identity with defaults", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const identity = await insertIdentity(user.id, "google", "subject-1");
      expect(identity).toMatchObject({ user_id: user.id, provider: "google", provider_subject: "subject-1" });
      expect(identity.linked_at).toBeInstanceOf(Date);
    });

    it("refuses linking one provider subject to a second user", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertIdentity(user.id, "google", "subject-1");
      await expect(insertIdentity(other.id, "google", "subject-1")).rejects.toThrow(
        /uq_user_identities_provider_subject/,
      );
    });

    it("allows one subject string at two different providers", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertIdentity(user.id, "google", "subject-1");
      await expect(insertIdentity(other.id, "okta", "subject-1")).resolves.toMatchObject({ provider: "okta" });
    });

    it("refuses a second identity for the same provider on one user, and allows another provider's", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await insertIdentity(user.id, "google", "subject-1");
      await expect(insertIdentity(user.id, "google", "subject-2")).rejects.toThrow(
        /uq_user_identities_user_id_provider/,
      );
      await expect(insertIdentity(user.id, "okta", "subject-3")).resolves.toMatchObject({ provider: "okta" });
    });

    it("refuses an identity for a user who does not exist", async () => {
      await expect(insertIdentity(randomUUID(), "google", "orphan")).rejects.toThrow(
        /user_identities_user_id_fkey/,
      );
    });

    it("deletes a user's identities when the user is deleted, and leaves other users' identities", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertIdentity(user.id, "google", "cascade-subject");
      await insertIdentity(other.id, "google", "kept-subject");

      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

      const identities = await ownerDb.selectFrom("user_identities").select("provider_subject").execute();
      expect(identities.map((row) => row.provider_subject)).toEqual(["kept-subject"]);
    });
  });

  describe("email_verification_tokens", () => {
    it("rejects a duplicate token hash", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const values = {
        user_id: user.id,
        token_hash: "identical-hash",
        expires_at: new Date(Date.now() + 3_600_000),
      };
      await ownerDb.insertInto("email_verification_tokens").values(values).execute();
      await expect(
        ownerDb.insertInto("email_verification_tokens").values(values).execute(),
      ).rejects.toThrow();
    });

    it("deletes a user's tokens when the user is deleted", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await ownerDb
        .insertInto("email_verification_tokens")
        .values({
          user_id: user.id,
          token_hash: "cascade-hash",
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .execute();

      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

      const remaining = await ownerDb.selectFrom("email_verification_tokens").selectAll().execute();
      expect(remaining).toHaveLength(0);
    });
  });

  describe("audit_events", () => {
    it("records an event with no actor, for anonymous actions", async () => {
      const row = await ownerDb
        .insertInto("audit_events")
        .values({ action: "user.registration_attempted" })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(row.actor_user_id).toBeNull();
      expect(row.metadata).toEqual({});
    });

    // Append-only twice over. The application role has no update or delete
    // grant (migration 009), so the API's own connection fails with 42501
    // before any trigger runs. Behind that, a BEFORE UPDATE/DELETE trigger
    // refuses every role, the owner and superusers included, which grants
    // cannot: the owner connection below proves the trigger. It blocks
    // unconditionally -- no carve-out for any shape of UPDATE -- because
    // actor_user_id carries no foreign key (see the migration), so there is no
    // FK-internal write that ever needs to be admitted.
    it("is append-only: the application role has no update privilege", async () => {
      await db.insertInto("audit_events").values({ action: "user.registered" }).execute();
      await expect(sql`update audit_events set action = 'tampered'`.execute(db)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("is append-only: the application role has no delete privilege", async () => {
      await db.insertInto("audit_events").values({ action: "user.registered" }).execute();
      await expect(sql`delete from audit_events`.execute(db)).rejects.toMatchObject({ code: "42501" });
    });

    it("is append-only: the trigger refuses even the owner an update", async () => {
      await ownerDb.insertInto("audit_events").values({ action: "user.registered" }).execute();
      await expect(
        sql`update audit_events set action = 'tampered'`.execute(ownerDb),
      ).rejects.toThrow(/append-only/i);
    });

    it("is append-only: the trigger refuses even the owner a delete", async () => {
      await ownerDb.insertInto("audit_events").values({ action: "user.registered" }).execute();
      await expect(sql`delete from audit_events`.execute(ownerDb)).rejects.toThrow(/append-only/i);
    });

    it("is untouched when the user it names is deleted, actor_user_id included", async () => {
      // Spec §3.11 applies the same reasoning to opamp: a snapshotted email
      // outlives the user row, which is what an audit trail requires. But the
      // audit row must be untouched, full stop -- actor_user_id carries no
      // foreign key, so deleting the user does not null it out either. The
      // dangling uuid stays, so events by the same actor remain correlatable;
      // actor_email carries the human-readable identity forward regardless.
      // Asserted against the whole row, not just the two columns the FK
      // removal touches, so the test proves the row is untouched full stop.
      const { user } = await createUserWithOrganization(ownerDb, {
        user: { email: "leaving@example.com" },
      });
      const inserted = await ownerDb
        .insertInto("audit_events")
        .values({
          action: "user.registered",
          actor_user_id: user.id,
          actor_email: "leaving@example.com",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

      const row = await ownerDb.selectFrom("audit_events").selectAll().executeTakeFirstOrThrow();
      expect(row).toEqual(inserted);
    });
  });
  describe("organizations and organization_members", () => {
    const insertOrganization = (
      ownerUserId: string,
      values: { name?: string; type?: "personal" | "group" } = {},
    ) =>
      ownerDb
        .insertInto("organizations")
        .values({
          name: values.name ?? "An organization",
          type: values.type ?? "personal",
          owner_user_id: ownerUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

    /** A group organization, which has no owner (ck_organizations_owner_only_personal). */
    const insertGroup = (name: string, values: { deleted_at?: Date } = {}) =>
      ownerDb
        .insertInto("organizations")
        .values({ name, type: "group", ...values })
        .returningAll()
        .executeTakeFirstOrThrow();

    const countRows = async (table: "users" | "organizations" | "organization_members") => {
      const row = await ownerDb
        .selectFrom(table)
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return row.count;
    };

    it("refuses an organization whose owner does not exist", async () => {
      await expect(insertOrganization(randomUUID())).rejects.toThrow(/foreign key/i);
    });

    it("refuses a membership of an organization that does not exist", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("organization_members")
          .values({ organization_id: randomUUID(), user_id: user.id, role: "admin" })
          .execute(),
      ).rejects.toThrow(/foreign key/i);
    });

    it("refuses a membership for a user who does not exist", async () => {
      const { organization } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("organization_members")
          .values({ organization_id: organization.id, user_id: randomUUID(), role: "contributor" })
          .execute(),
      ).rejects.toThrow(/foreign key/i);
    });

    it("refuses a second personal organization for the same owner", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await expect(insertOrganization(user.id, { type: "personal" })).rejects.toThrow(
        /uq_organizations_owner_user_id_personal/,
      );
    });

    it("allows a group organization, which has no owner, beside a user's personal one", async () => {
      await createUserWithOrganization(ownerDb);
      const group = await insertGroup("A team");
      expect(group).toMatchObject({ type: "group", owner_user_id: null });
    });

    // D5 decision 6: owner_user_id is set exactly when the organization is personal.
    it("refuses a group organization with an owner, and a personal one without", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb.insertInto("organizations").values({ name: "A team", type: "group", owner_user_id: user.id }).execute(),
      ).rejects.toThrow(/ck_organizations_owner_only_personal/);
      await expect(
        ownerDb.insertInto("organizations").values({ name: "Mine", type: "personal", owner_user_id: null }).execute(),
      ).rejects.toThrow(/ck_organizations_owner_only_personal/);
    });

    // D5 decision 6: group names are unique, ignoring case, among live group organizations.
    it("refuses two live group organizations named Acme and acme", async () => {
      await insertGroup("Acme");
      await expect(insertGroup("acme")).rejects.toThrow(/uq_organizations_lower_name_group/);
    });

    it("lets a new group organization take a deleted one's name", async () => {
      await insertGroup("Acme", { deleted_at: new Date() });
      await expect(insertGroup("ACME")).resolves.toMatchObject({ name: "ACME" });
    });

    it("lets a personal organization share a group organization's name", async () => {
      const { user } = await createUserWithOrganization(ownerDb, { organization: { name: "Acme" } });
      await insertGroup("acme");
      const personal = await ownerDb
        .selectFrom("organizations")
        .select("name")
        .where("owner_user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      expect(personal.name).toBe("Acme");
    });

    it("refuses two memberships for the same user in the same organization", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("organization_members")
          .values({ organization_id: organization.id, user_id: user.id, role: "contributor" })
          .execute(),
      ).rejects.toThrow(/uq_organization_members_organization_id_user_id/);
    });

    // D23-2 decisions 12 and 27: a logo has both columns or neither, and is PNG, JPEG or WebP.
    describe("ck_organizations_logo", () => {
      const LOGO_ID = "0199e000-0000-7000-8000-00000000c001";
      const setLogo = (id: string, logoId: string | null, contentType: string | null) =>
        ownerDb
          .updateTable("organizations")
          .set({ logo_id: logoId, logo_content_type: contentType as never })
          .where("id", "=", id)
          .execute();

      it("accepts no logo, and a PNG, a JPEG or a WebP with its id", async () => {
        const group = await insertGroup("Logos");
        expect(group).toMatchObject({ logo_id: null, logo_content_type: null });
        for (const type of ["image/png", "image/jpeg", "image/webp"]) {
          await setLogo(group.id, LOGO_ID, type);
        }
        await setLogo(group.id, null, null);
      });

      it.each([
        ["an id without a type", LOGO_ID, null],
        ["a type without an id", null, "image/png"],
        ["SVG", LOGO_ID, "image/svg+xml"],
        ["GIF", LOGO_ID, "image/gif"],
        ["a type in capitals", LOGO_ID, "IMAGE/PNG"],
        ["an empty type", LOGO_ID, ""],
      ])("refuses %s", async (_label, logoId, contentType) => {
        const group = await insertGroup("Logos");
        await expect(setLogo(group.id, logoId, contentType)).rejects.toThrow(/ck_organizations_logo/);
      });
    });

    it("refuses an empty organization name", async () => {
      await expect(insertGroup("")).rejects.toThrow(
        /ck_organizations_name_length/,
      );
    });

    it("refuses a 301-character organization name and accepts a 300-character one", async () => {
      await expect(
        insertGroup("a".repeat(301)),
      ).rejects.toThrow(/ck_organizations_name_length/);
      const accepted = await insertGroup("a".repeat(300));
      expect(accepted.name).toHaveLength(300);
    });

    it("refuses an unknown organization type", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await expect(
        insertOrganization(user.id, { type: "team" as never }),
      ).rejects.toThrow(/invalid input value for enum organization_type/);
    });

    it("refuses an unknown membership role", async () => {
      const { organization } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("organization_members")
          .values({ organization_id: organization.id, user_id: other.id, role: "owner" as never })
          .execute(),
      ).rejects.toThrow(/invalid input value for enum organization_role/);
    });

    /**
     * D1b decision 2: at commit, every user a transaction touched must still
     * exist with at least one membership, be soft-deleted, or be gone.
     * Enforced by the deferred constraint triggers in
     * 1700000000003_organization_membership_invariant, tightened by
     * 1700000000010_organizations_and_memberships.
     */
    describe("the membership invariant", () => {
      const invariantMessage = (userId: string) =>
        `user ${userId} must belong to at least one organization`;

      const membershipCount = async (userId: string) => {
        const rows = await ownerDb
          .selectFrom("organization_members")
          .select("id")
          .where("user_id", "=", userId)
          .execute();
        return rows.length;
      };

      it("commits a user inserted with an organization and membership in one transaction", async () => {
        const { user, organization, membership } = await createUserWithOrganization(ownerDb);
        expect(membership).toMatchObject({ user_id: user.id, organization_id: organization.id });
        expect(await countRows("users")).toBe(1);
        expect(await countRows("organizations")).toBe(1);
        expect(await countRows("organization_members")).toBe(1);
      });

      it("refuses a user inserted alone, at commit rather than at the insert", async () => {
        let insertedId: string | undefined;
        const error = await ownerDb
          .transaction()
          .execute(async (transaction) => {
            const user = await transaction
              .insertInto("users")
              .values({ email: "alone@example.com" })
              .returningAll()
              .executeTakeFirstOrThrow();
            // The insert itself succeeded: the check is deferred to commit.
            insertedId = user.id;
          })
          .catch((caught: unknown) => caught);

        expect(insertedId).toBeDefined();
        expect(error).toMatchObject({ code: "23514", message: invariantMessage(insertedId!) });
        expect(await countRows("users")).toBe(0);
      });

      it("refuses deleting a user's only membership", async () => {
        const { user, membership } = await createUserWithOrganization(ownerDb);
        await expect(
          ownerDb.deleteFrom("organization_members").where("id", "=", membership.id).execute(),
        ).rejects.toThrow(invariantMessage(user.id));
        expect(await membershipCount(user.id)).toBe(1);
      });

      it("allows deleting one of a user's two memberships", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const group = await insertGroup("A team");
        const groupMembership = await ownerDb
          .insertInto("organization_members")
          .values({ organization_id: group.id, user_id: user.id, role: "admin" })
          .returningAll()
          .executeTakeFirstOrThrow();

        await ownerDb.deleteFrom("organization_members").where("id", "=", groupMembership.id).execute();

        expect(await membershipCount(user.id)).toBe(1);
      });

      it("refuses deleting a user's personal organization while it holds their only membership", async () => {
        const { user, organization } = await createUserWithOrganization(ownerDb);
        await expect(
          ownerDb.deleteFrom("organizations").where("id", "=", organization.id).execute(),
        ).rejects.toThrow(invariantMessage(user.id));
        expect(await countRows("organizations")).toBe(1);
        expect(await membershipCount(user.id)).toBe(1);
      });

      // A service account (D22, migration 1700000000035): a users row of
      // kind service with one contributor membership in its group
      // organization, its service_accounts row, and no personal organization
      // (D1b decision 2). The invariant is membership, so this shape must
      // commit, provided account and membership commit together.
      it("accepts the service-account shape, and refuses deleting its group organization while the account exists", async () => {
        const group = await insertGroup("A team");

        const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: group.id });

        const personal = await ownerDb
          .selectFrom("organizations")
          .select("id")
          .where("owner_user_id", "=", serviceAccount.id)
          .execute();
        expect(personal).toHaveLength(0);
        expect(await membershipCount(serviceAccount.id)).toBe(1);

        await expect(
          ownerDb.deleteFrom("organizations").where("id", "=", group.id).execute(),
        ).rejects.toThrow(invariantMessage(serviceAccount.id));
        expect(await membershipCount(serviceAccount.id)).toBe(1);
      });

      it("allows deleting a soft-deleted user's last membership", async () => {
        const { user, membership } = await createUserWithOrganization(ownerDb);
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();

        await ownerDb.deleteFrom("organization_members").where("id", "=", membership.id).execute();

        expect(await membershipCount(user.id)).toBe(0);
      });

      it("allows hard-deleting a user, which takes their organization and membership with it", async () => {
        const { user } = await createUserWithOrganization(ownerDb);

        await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

        expect(await countRows("users")).toBe(0);
        expect(await countRows("organizations")).toBe(0);
        expect(await countRows("organization_members")).toBe(0);
      });

      // Each test below commits its setup first and acts in a separate
      // statement (its own transaction). Acting in the setup's transaction
      // would let the insert trigger's check stand in for the one under test.
      it("refuses moving a user's only membership to another user", async () => {
        const { user, membership } = await createUserWithOrganization(ownerDb);
        const { user: other } = await createUserWithOrganization(ownerDb);

        await expect(
          ownerDb
            .updateTable("organization_members")
            .set({ user_id: other.id })
            .where("id", "=", membership.id)
            .execute(),
        ).rejects.toThrow(invariantMessage(user.id));
        expect(await membershipCount(user.id)).toBe(1);
      });

      it("allows moving one of a user's two memberships to another user", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const { user: other } = await createUserWithOrganization(ownerDb);
        const group = await insertGroup("A team");
        const groupMembership = await ownerDb
          .insertInto("organization_members")
          .values({ organization_id: group.id, user_id: user.id, role: "admin" })
          .returningAll()
          .executeTakeFirstOrThrow();

        await ownerDb
          .updateTable("organization_members")
          .set({ user_id: other.id })
          .where("id", "=", groupMembership.id)
          .execute();

        expect(await membershipCount(user.id)).toBe(1);
        expect(await membershipCount(other.id)).toBe(2);
      });

      it("allows moving a membership to another organization", async () => {
        const { membership } = await createUserWithOrganization(ownerDb);
        const group = await insertGroup("A team");

        await ownerDb
          .updateTable("organization_members")
          .set({ organization_id: group.id })
          .where("id", "=", membership.id)
          .execute();

        const moved = await ownerDb
          .selectFrom("organization_members")
          .selectAll()
          .where("id", "=", membership.id)
          .executeTakeFirstOrThrow();
        expect(moved.organization_id).toBe(group.id);
      });

      it("allows soft-deleting a user", async () => {
        const { user } = await createUserWithOrganization(ownerDb);

        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();

        const row = await ownerDb.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow();
        expect(row.deleted_at).not.toBeNull();
      });

      it("refuses restoring a soft-deleted user who has no membership", async () => {
        const { user, membership } = await createUserWithOrganization(ownerDb);
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
        await ownerDb.deleteFrom("organization_members").where("id", "=", membership.id).execute();

        await expect(
          ownerDb.updateTable("users").set({ deleted_at: null }).where("id", "=", user.id).execute(),
        ).rejects.toThrow(invariantMessage(user.id));
        const row = await ownerDb.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow();
        expect(row.deleted_at).not.toBeNull();
      });

      it("allows restoring a soft-deleted user who still has a membership", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();

        await ownerDb.updateTable("users").set({ deleted_at: null }).where("id", "=", user.id).execute();

        const row = await ownerDb.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow();
        expect(row.deleted_at).toBeNull();
      });

      /**
       * D5 decision 6: the rule is a live membership in a live organization,
       * and it is checked when a membership is removed (deleted_at) and when
       * an organization is deleted. 1700000000010_organizations_and_memberships.
       */
      describe("soft removal and organization deletion", () => {
        const softDelete = (table: "organizations" | "organization_members" | "users", id: string) =>
          ownerDb.updateTable(table).set({ deleted_at: new Date() }).where("id", "=", id).execute();

        const membershipRow = (id: string) =>
          ownerDb.selectFrom("organization_members").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

        const organizationRow = (id: string) =>
          ownerDb.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

        it("refuses soft-removing a user's last live membership, at commit", async () => {
          const { user, membership } = await createUserWithOrganization(ownerDb);
          let updated = false;
          const error = await ownerDb
            .transaction()
            .execute(async (transaction) => {
              await transaction
                .updateTable("organization_members")
                .set({ deleted_at: new Date() })
                .where("id", "=", membership.id)
                .execute();
              // The update itself succeeded: the check is deferred to commit.
              updated = true;
            })
            .catch((caught: unknown) => caught);

          expect(updated).toBe(true);
          expect(error).toMatchObject({ code: "23514", message: invariantMessage(user.id) });
          expect((await membershipRow(membership.id)).deleted_at).toBeNull();
        });

        it("refuses soft-deleting the organization that holds a user's last live membership, at commit", async () => {
          const { user, organization } = await createUserWithOrganization(ownerDb);
          await expect(softDelete("organizations", organization.id)).rejects.toMatchObject({
            code: "23514",
            message: invariantMessage(user.id),
          });
          expect((await organizationRow(organization.id)).deleted_at).toBeNull();
        });

        // The organizations trigger checks every live member, not the first:
        // here the owner keeps a personal organization, and the service
        // account (created second) is the one stranded.
        it("refuses soft-deleting a group organization that strands any one of its members", async () => {
          const owner = await createUserWithOrganization(ownerDb);
          const group = await insertGroup("A team");
          await ownerDb
            .insertInto("organization_members")
            .values({ organization_id: group.id, user_id: owner.user.id, role: "admin" })
            .execute();
          const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: group.id });

          await expect(softDelete("organizations", group.id)).rejects.toThrow(invariantMessage(serviceAccount.id));
        });

        /**
         * Two transactions each removing one of a user's last two
         * memberships touch different rows. The check locks the user first
         * (1700000000012), so the second waits for the first and then sees
         * its removal. `set constraints all immediate` runs each check at a
         * chosen moment, so both checks run before either commits: without
         * the lock, both pass and both commit.
         */
        it("serializes two transactions removing a user's last two memberships: the second refuses (23514)", async () => {
          const account = await ownerDb.transaction().execute(async (transaction) => {
            const user = await transaction
              .insertInto("users")
              .values({ email: "service@example.com" })
              .returningAll()
              .executeTakeFirstOrThrow();
            const memberships = [];
            for (const name of ["Team A", "Team B"]) {
              const group = await transaction
                .insertInto("organizations")
                .values({ name, type: "group" })
                .returningAll()
                .executeTakeFirstOrThrow();
              memberships.push(
                await transaction
                  .insertInto("organization_members")
                  .values({ organization_id: group.id, user_id: user.id, role: "contributor" })
                  .returningAll()
                  .executeTakeFirstOrThrow(),
              );
            }
            return { user, memberships };
          });
          const [inA, inB] = account.memberships;

          /** Removes `membershipId` and runs the deferred check now; holds the transaction until `commit` resolves. */
          const removal = (membershipId: string, commit: Promise<void>, onChecked: () => void) =>
            ownerDb.transaction().execute(async (transaction) => {
              await transaction
                .updateTable("organization_members")
                .set({ deleted_at: new Date() })
                .where("id", "=", membershipId)
                .execute();
              await sql`set constraints all immediate`.execute(transaction);
              onChecked();
              await commit;
            });

          let commitFirst!: () => void;
          const firstMayCommit = new Promise<void>((resolve) => {
            commitFirst = resolve;
          });
          let firstChecked!: () => void;
          const firstHasChecked = new Promise<void>((resolve) => {
            firstChecked = resolve;
          });
          const first = removal(inA!.id, firstMayCommit, firstChecked);
          await firstHasChecked;

          let secondHasSettled = false;
          const second = removal(inB!.id, Promise.resolve(), () => undefined).finally(() => {
            secondHasSettled = true;
          });
          second.catch(() => undefined);
          // The second's check waits on the user's lock, which the first
          // holds; without the lock it doesn't wait, and settles.
          const deadline = Date.now() + 5_000;
          for (;;) {
            if (secondHasSettled) break;
            const { rows } = await sql<{ waiting: number }>`
              select count(*)::int as waiting
                from pg_stat_activity
               where datname = current_database()
                 and pid <> pg_backend_pid()
                 and wait_event_type = 'Lock'
            `.execute(ownerDb);
            if ((rows[0]?.waiting ?? 0) >= 1) break;
            if (Date.now() > deadline) throw new Error("timed out waiting for the second check to wait on a lock");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }

          commitFirst();
          await first;
          await expect(second).rejects.toMatchObject({ code: "23514", message: invariantMessage(account.user.id) });
          expect((await membershipRow(inA!.id)).deleted_at).not.toBeNull();
          expect((await membershipRow(inB!.id)).deleted_at).toBeNull();
        });

        it("allows removing the last membership, or deleting its organization, when the user is soft-deleted in the same transaction", async () => {
          const removed = await createUserWithOrganization(ownerDb);
          await ownerDb.transaction().execute(async (transaction) => {
            await transaction
              .updateTable("organization_members")
              .set({ deleted_at: new Date() })
              .where("id", "=", removed.membership.id)
              .execute();
            await transaction.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", removed.user.id).execute();
          });
          expect((await membershipRow(removed.membership.id)).deleted_at).not.toBeNull();

          const deleted = await createUserWithOrganization(ownerDb);
          await ownerDb.transaction().execute(async (transaction) => {
            await transaction
              .updateTable("organizations")
              .set({ deleted_at: new Date() })
              .where("id", "=", deleted.organization.id)
              .execute();
            await transaction.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", deleted.user.id).execute();
          });
          expect((await organizationRow(deleted.organization.id)).deleted_at).not.toBeNull();
        });

        it("allows removing a membership that is not the user's last live one", async () => {
          const { user } = await createUserWithOrganization(ownerDb);
          const group = await insertGroup("A team");
          const groupMembership = await ownerDb
            .insertInto("organization_members")
            .values({ organization_id: group.id, user_id: user.id, role: "admin" })
            .returningAll()
            .executeTakeFirstOrThrow();

          await softDelete("organization_members", groupMembership.id);

          expect((await membershipRow(groupMembership.id)).deleted_at).not.toBeNull();
        });

        it("does not count a live membership in a deleted organization", async () => {
          const { user, membership } = await createUserWithOrganization(ownerDb);
          const group = await insertGroup("A team");
          await ownerDb
            .insertInto("organization_members")
            .values({ organization_id: group.id, user_id: user.id, role: "admin" })
            .execute();
          // Deleting the group passes: the personal membership remains.
          await softDelete("organizations", group.id);

          await expect(softDelete("organization_members", membership.id)).rejects.toThrow(invariantMessage(user.id));
        });

        it("refuses moving a user's last live membership into a deleted organization", async () => {
          const { user, membership } = await createUserWithOrganization(ownerDb);
          const deleted = await insertGroup("Gone", { deleted_at: new Date() });

          await expect(
            ownerDb
              .updateTable("organization_members")
              .set({ organization_id: deleted.id })
              .where("id", "=", membership.id)
              .execute(),
          ).rejects.toThrow(invariantMessage(user.id));
        });

        it("allows restoring a removed membership and a deleted organization", async () => {
          const { user } = await createUserWithOrganization(ownerDb);
          const group = await insertGroup("A team");
          const groupMembership = await ownerDb
            .insertInto("organization_members")
            .values({ organization_id: group.id, user_id: user.id, role: "contributor" })
            .returningAll()
            .executeTakeFirstOrThrow();
          await softDelete("organization_members", groupMembership.id);
          await softDelete("organizations", group.id);

          await ownerDb
            .updateTable("organization_members")
            .set({ deleted_at: null })
            .where("id", "=", groupMembership.id)
            .execute();
          await ownerDb.updateTable("organizations").set({ deleted_at: null }).where("id", "=", group.id).execute();

          expect(await membershipRow(groupMembership.id)).toMatchObject({ deleted_at: null, role: "contributor" });
          expect((await organizationRow(group.id)).deleted_at).toBeNull();
        });
      });

      it("does not stop truncateAll: constraint triggers do not fire on TRUNCATE", async () => {
        // Guard against a vacuous pass: the triggers must be present.
        const triggers = await sql<{ tgname: string }>`
          select tgname from pg_trigger
           where tgname in (
             'users_require_membership',
             'users_restored_require_membership',
             'organization_members_keep_one',
             'organization_members_user_reassigned',
             'organization_members_removed_require_membership',
             'organizations_deleted_require_membership'
           )
           order by tgname
        `.execute(ownerDb);
        expect(triggers.rows.map((row) => row.tgname)).toEqual([
          "organization_members_keep_one",
          "organization_members_removed_require_membership",
          "organization_members_user_reassigned",
          "organizations_deleted_require_membership",
          "users_require_membership",
          "users_restored_require_membership",
        ]);

        await createUserWithOrganization(ownerDb);
        await expect(truncateAll(ownerDb)).resolves.toBeUndefined();
        expect(await countRows("users")).toBe(0);
        expect(await countRows("organization_members")).toBe(0);
      });
    });
  });

  describe("sessions and refresh_tokens", () => {
    const insertSession = (userId: string, organizationId: string) =>
      ownerDb
        .insertInto("sessions")
        .values({ user_id: userId, active_organization_id: organizationId })
        .returningAll()
        .executeTakeFirstOrThrow();

    const insertRefreshToken = (sessionId: string, tokenHash: string) =>
      ownerDb
        .insertInto("refresh_tokens")
        .values({
          session_id: sessionId,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 30 * 86_400_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

    const countSessionRows = async (table: "sessions" | "refresh_tokens") => {
      const row = await ownerDb
        .selectFrom(table)
        .select((builder) => builder.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    };

    it("creates a live session with defaults", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const session = await insertSession(user.id, organization.id);
      expect(session).toMatchObject({
        user_id: user.id,
        active_organization_id: organization.id,
        revoked_at: null,
        revoked_reason: null,
        ip_address: null,
        user_agent: null,
      });
      expect(session.created_at).toBeInstanceOf(Date);
      expect(session.last_refreshed_at).toBeInstanceOf(Date);
    });

    it("requires an existing user", async () => {
      const { organization } = await createUserWithOrganization(ownerDb);
      await expect(insertSession(randomUUID(), organization.id)).rejects.toThrow(
        /sessions_user_id_fkey/,
      );
    });

    it("requires an existing organization", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await expect(insertSession(user.id, randomUUID())).rejects.toThrow(
        /sessions_active_organization_id_fkey/,
      );
    });

    it("refuses a refresh token for a session that does not exist", async () => {
      await expect(insertRefreshToken(randomUUID(), "orphan-hash")).rejects.toThrow(
        /refresh_tokens_session_id_fkey/,
      );
    });

    it("deletes a user's sessions and their refresh tokens when the user is deleted", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const { user: other, organization: otherOrganization } = await createUserWithOrganization(ownerDb);
      const session = await insertSession(user.id, organization.id);
      await insertRefreshToken(session.id, "cascade-hash-1");
      await insertRefreshToken(session.id, "cascade-hash-2");
      const kept = await insertSession(other.id, otherOrganization.id);
      await insertRefreshToken(kept.id, "kept-hash");

      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

      const sessions = await ownerDb.selectFrom("sessions").select("id").execute();
      expect(sessions.map((row) => row.id)).toEqual([kept.id]);
      const tokens = await ownerDb.selectFrom("refresh_tokens").select("token_hash").execute();
      expect(tokens.map((row) => row.token_hash)).toEqual(["kept-hash"]);
    });

    // A personal organization holding the user's only membership cannot be
    // deleted (the membership invariant), so the session acts as a group
    // organization the user also belongs to.
    it("deletes an organization's sessions and their refresh tokens when the organization is deleted", async () => {
      const { user, organization: personal } = await createUserWithOrganization(ownerDb);
      const group = await ownerDb
        .insertInto("organizations")
        .values({ name: "A team", type: "group" })
        .returningAll()
        .executeTakeFirstOrThrow();
      await ownerDb
        .insertInto("organization_members")
        .values({ organization_id: group.id, user_id: user.id, role: "admin" })
        .execute();
      const groupSession = await insertSession(user.id, group.id);
      await insertRefreshToken(groupSession.id, "group-hash");
      const personalSession = await insertSession(user.id, personal.id);
      await insertRefreshToken(personalSession.id, "personal-hash");

      await ownerDb.deleteFrom("organizations").where("id", "=", group.id).execute();

      const sessions = await ownerDb.selectFrom("sessions").select("id").execute();
      expect(sessions.map((row) => row.id)).toEqual([personalSession.id]);
      const tokens = await ownerDb.selectFrom("refresh_tokens").select("token_hash").execute();
      expect(tokens.map((row) => row.token_hash)).toEqual(["personal-hash"]);
    });

    it("refuses two refresh tokens with the same hash, even across sessions", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const first = await insertSession(user.id, organization.id);
      const second = await insertSession(user.id, organization.id);
      await insertRefreshToken(first.id, "identical-hash");
      await expect(insertRefreshToken(second.id, "identical-hash")).rejects.toThrow(
        /uq_refresh_tokens_token_hash/,
      );
      expect(await countSessionRows("refresh_tokens")).toBe(1);
    });

    it("refuses a revoked session without a reason", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("sessions")
          .values({ user_id: user.id, active_organization_id: organization.id, revoked_at: new Date() })
          .execute(),
      ).rejects.toThrow(/ck_sessions_revoked_reason/);
    });

    it("refuses a reason on a session that is not revoked", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      await expect(
        ownerDb
          .insertInto("sessions")
          .values({ user_id: user.id, active_organization_id: organization.id, revoked_reason: "logout" })
          .execute(),
      ).rejects.toThrow(/ck_sessions_revoked_reason/);
    });

    it("refuses revoking a live session without a reason, and accepts revoking it with one", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const session = await insertSession(user.id, organization.id);

      await expect(
        ownerDb.updateTable("sessions").set({ revoked_at: new Date() }).where("id", "=", session.id).execute(),
      ).rejects.toThrow(/ck_sessions_revoked_reason/);

      const revoked = await ownerDb
        .updateTable("sessions")
        .set({ revoked_at: new Date(), revoked_reason: "sign_out_everywhere" })
        .where("id", "=", session.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(revoked.revoked_reason).toBe("sign_out_everywhere");
      expect(revoked.revoked_at).toBeInstanceOf(Date);
    });

    it("stores the client address as inet", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const session = await ownerDb
        .insertInto("sessions")
        .values({ user_id: user.id, active_organization_id: organization.id, ip_address: "203.0.113.7" })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(session.ip_address).toBe("203.0.113.7");
      await expect(
        ownerDb
          .insertInto("sessions")
          .values({ user_id: user.id, active_organization_id: organization.id, ip_address: "not-an-ip" })
          .execute(),
      ).rejects.toThrow(/inet/);
    });
  });

  describe("password_reset_tokens", () => {
    const insertResetToken = (userId: string, tokenHash: string, consumedAt: Date | null = null) =>
      ownerDb
        .insertInto("password_reset_tokens")
        .values({
          user_id: userId,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 3_600_000),
          consumed_at: consumedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

    it("creates an unconsumed token with defaults", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const token = await insertResetToken(user.id, "reset-hash");
      expect(token).toMatchObject({ user_id: user.id, token_hash: "reset-hash", consumed_at: null });
      expect(token.created_at).toBeInstanceOf(Date);
    });

    it("refuses two tokens with the same hash, even across users", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertResetToken(user.id, "identical-hash");
      await expect(insertResetToken(other.id, "identical-hash")).rejects.toThrow(
        /uq_password_reset_tokens_token_hash/,
      );
    });

    it("refuses a second unconsumed token for a user, and allows one for another user", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertResetToken(user.id, "live-hash-1");
      await expect(insertResetToken(user.id, "live-hash-2")).rejects.toThrow(
        /uq_password_reset_tokens_one_live_per_user/,
      );
      await expect(insertResetToken(other.id, "live-hash-3")).resolves.toMatchObject({ consumed_at: null });
    });

    it("allows an unconsumed token beside the user's consumed ones", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      await insertResetToken(user.id, "used-hash-1", new Date());
      await insertResetToken(user.id, "used-hash-2", new Date());
      await expect(insertResetToken(user.id, "live-hash")).resolves.toMatchObject({ consumed_at: null });
    });

    it("refuses a token for a user who does not exist", async () => {
      await expect(insertResetToken(randomUUID(), "orphan-hash")).rejects.toThrow(
        /password_reset_tokens_user_id_fkey/,
      );
    });

    it("deletes a user's tokens when the user is deleted, and leaves other users' tokens", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const { user: other } = await createUserWithOrganization(ownerDb);
      await insertResetToken(user.id, "cascade-hash-1", new Date());
      await insertResetToken(user.id, "cascade-hash-2");
      await insertResetToken(other.id, "kept-hash");

      await ownerDb.deleteFrom("users").where("id", "=", user.id).execute();

      const tokens = await ownerDb.selectFrom("password_reset_tokens").select("token_hash").execute();
      expect(tokens.map((row) => row.token_hash)).toEqual(["kept-hash"]);
    });
  });

  /** D5 decision 1: the API's own role gets only what it needs. */
  describe("the application role's privileges", () => {
    /** Every privilege a table can carry (Postgres 17 added MAINTAIN). */
    const tablePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];

    /** The privileges `role` holds on `table`, directly or inherited. */
    const privilegesOf = async (role: string, table: string) => {
      const held: string[] = [];
      for (const privilege of tablePrivileges) {
        const { rows } = await sql<{ held: boolean }>`
          select has_table_privilege(${role}, ${`platform.${table}`}, ${privilege}) as held
        `.execute(ownerDb);
        if (rows[0]!.held) held.push(privilege);
      }
      return held;
    };

    const currentUser = async (connection: Kysely<Database>) => {
      const { rows } = await sql<{ name: string }>`select current_user as name`.execute(connection);
      return rows[0]!.name;
    };

    it("grants select, insert, update and delete on every application table but audit_events, which gets select and insert, test_templates, which gets select, insert and update (deletes are soft, migration 1700000000029), user_feedback, which gets insert only, and user_deletion_records, which gets nothing (D29 decision 21, Preflight ruling 3), to the role and its login", async () => {
      const login = await currentUser(db);
      const granted: Partial<Record<(typeof applicationTables)[number], string[]>> = {
        audit_events: ["SELECT", "INSERT"],
        test_templates: ["SELECT", "INSERT", "UPDATE"],
        user_feedback: ["INSERT"],
        user_deletion_records: [],
      };
      for (const table of applicationTables) {
        const expected = granted[table] ?? ["SELECT", "INSERT", "UPDATE", "DELETE"];
        expect({ table, privileges: await privilegesOf("telflo_platform_runtime", table) }).toEqual({
          table,
          privileges: expected,
        });
        expect({ table, privileges: await privilegesOf(login, table) }).toEqual({ table, privileges: expected });
      }
    });

    it("grants only select on the tester's and the evaluator's states and the site's settings (migrations 1700000000028, 1700000000030 and 1700000000044): the API's role changes them only through otelcol_testing_mark, ottl_evaluator_mark and product_admin_set_organization_creation", async () => {
      const login = await currentUser(db);
      for (const table of singletonTables) {
        expect({ table, privileges: await privilegesOf("telflo_platform_runtime", table) }).toEqual({
          table,
          privileges: ["SELECT"],
        });
        expect({ table, privileges: await privilegesOf(login, table) }).toEqual({ table, privileges: ["SELECT"] });
      }
      await expect(sql`update otelcol_testing_state set down_since = now()`.execute(db)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(sql`update ottl_evaluator_state set down_since = now()`.execute(db)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(sql`update site_settings set organization_creation = 'product_admins'`.execute(db)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("grants nothing on pgmigrations: the application role can't read it", async () => {
      expect(await privilegesOf("telflo_platform_runtime", "pgmigrations")).toEqual([]);
      await expect(sql`select * from pgmigrations`.execute(db)).rejects.toMatchObject({ code: "42501" });
    });

    it("gives a table a later migration creates select, insert, update and delete, through default privileges", async () => {
      // Rolled back: the table exists only inside this transaction.
      const rollback = new Error("rollback");
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await sql`create table test_later_table (id int)`.execute(transaction);
          const { rows } = await sql<{ privilege: string }>`
            select privilege
              from unnest(${tablePrivileges}::text[]) as privilege
             where has_table_privilege('telflo_platform_runtime', 'platform.test_later_table', privilege)
          `.execute(transaction);
          expect(rows.map((row) => row.privilege)).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });

    it("connects the API's login as neither a superuser nor a BYPASSRLS role", async () => {
      const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        select rolsuper, rolbypassrls from pg_roles where rolname = current_user
      `.execute(db);
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  describe("test helpers", () => {
    it("createUserWithOrganization produces a verified user, a personal organization named after the email, and an admin membership", async () => {
      const { user, organization, membership } = await createUserWithOrganization(ownerDb, {
        user: { email: "Helper@Example.com" },
      });

      expect(user.email_verified_at).not.toBeNull();
      expect(user.accepted_terms_version).toBeTruthy();
      expect(user.terms_accepted_at).toBeInstanceOf(Date);
      expect(organization).toMatchObject({
        name: "helper@example.com",
        type: "personal",
        owner_user_id: user.id,
        deleted_at: null,
      });
      expect(membership).toMatchObject({
        organization_id: organization.id,
        user_id: user.id,
        role: "admin",
      });
    });

    it("createUserWithOrganization gives each call a unique email by default", async () => {
      const first = await createUserWithOrganization(ownerDb);
      const second = await createUserWithOrganization(ownerDb);
      expect(first.user.email).not.toBe(second.user.email);
    });

    it("truncateAll empties every table in the platform schema but the collector catalogue's, which it leaves as the sync wrote it, and the tester's and the evaluator's states, whose one rows it marks up", async () => {
      const tables = await sql<{ table_name: string }>`
        select table_name
          from information_schema.tables
         where table_schema = 'platform'
           and table_type = 'BASE TABLE'
           and table_name <> 'pgmigrations'
      `.execute(ownerDb);
      const tableNames = tables.rows.map((row) => row.table_name);

      // A table missing from the helpers fails here, not as a flaky leak later.
      expect([...tableNames].sort()).toEqual([...applicationTables, ...catalogueTables, ...singletonTables].sort());
      const catalogue = async () => ({
        distributions: await ownerDb.selectFrom("collector_distributions").selectAll().orderBy("id").execute(),
        versions: await ownerDb
          .selectFrom("collector_versions")
          .selectAll()
          .orderBy("distribution")
          .orderBy("version")
          .execute(),
      });
      const catalogueBefore = await catalogue();
      expect(catalogueBefore.versions.length).toBeGreaterThan(0);

      const { user, organization } = await createUserWithOrganization(ownerDb);
      await ownerDb
        .insertInto("email_verification_tokens")
        .values({ user_id: user.id, token_hash: "truncate-hash", expires_at: new Date() })
        .execute();
      await ownerDb.insertInto("audit_events").values({ action: "user.registered" }).execute();
      const session = await ownerDb
        .insertInto("sessions")
        .values({ user_id: user.id, active_organization_id: organization.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await ownerDb
        .insertInto("refresh_tokens")
        .values({ session_id: session.id, token_hash: "truncate-hash", expires_at: new Date() })
        .execute();
      await ownerDb
        .insertInto("password_reset_tokens")
        .values({ user_id: user.id, token_hash: "truncate-hash", expires_at: new Date() })
        .execute();
      await ownerDb
        .insertInto("user_identities")
        .values({ user_id: user.id, provider: "google", provider_subject: "truncate-subject", email: user.email })
        .execute();
      await ownerDb
        .insertInto("user_settings")
        .values({ user_id: user.id, theme: "navy", created_at: new Date(), updated_at: new Date() })
        .execute();
      const configuration = await addConfiguration(ownerDb, {
        organizationId: organization.id,
        created_by_user_id: user.id,
      });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: organization.id,
        created_by_user_id: user.id,
      });
      await addTestInputFile(ownerDb, { organizationId: organization.id, ownerUserId: user.id });
      await addTestRun(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
        configurationVersionId: version.id,
        queuedByUserId: user.id,
      });
      const suite = await addTestSuite(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
        configurationVersionId: version.id,
      });
      const input = await addTestDefinitionInput(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
      });
      await addTestDefinition(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
        configurationVersionId: version.id,
        testSuiteId: suite.id,
        inputId: input.id,
      });
      await addTestTemplate(ownerDb, { created_by_user_id: user.id });
      await insertSeededTestRegexes(ownerDb);
      const validationPipeline = await addValidationPipeline(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
        configurationVersionId: version.id,
      });
      await addValidationRule(ownerDb, {
        organizationId: organization.id,
        configurationId: configuration.id,
        configurationVersionId: version.id,
        validationPipelineId: validationPipeline.id,
      });

      await sql`update otelcol_testing_state set down_since = now()`.execute(ownerDb);
      await sql`update ottl_evaluator_state set down_since = now()`.execute(ownerDb);

      await truncateAll(ownerDb);

      expect(await ownerDb.selectFrom("otelcol_testing_state").selectAll().execute()).toEqual([
        { id: true, down_since: null },
      ]);
      expect(await ownerDb.selectFrom("ottl_evaluator_state").selectAll().execute()).toEqual([
        { id: true, down_since: null },
      ]);
      for (const table of applicationTables) {
        const result = await sql<{ count: number }>`
          select count(*)::int as count from ${sql.table(table)}
        `.execute(ownerDb);
        expect({ table, count: result.rows[0]?.count }).toEqual({ table, count: 0 });
      }
      expect(await catalogue()).toEqual(catalogueBefore);
    });
  });

  describe("migrations over existing data", () => {
    const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

    interface Throwaway {
      throwaway: Kysely<Database>;
      migrate: (count: number) => Promise<unknown>;
      migrateDown: (count: number) => Promise<unknown>;
    }

    /**
     * Runs `body` against a freshly created, unmigrated database, dropped
     * afterwards whatever happens. Every test here calls it, so every test
     * takes THROWAWAY_DATABASE_DROP_TIMEOUT: the drop waits for a checkpoint that
     * fsyncs every file the run has written since the last one (D7 Ruling
     * 15, D31-1 Ruling 316).
     */
    async function withThrowawayDatabase(body: (context: Throwaway) => Promise<void>): Promise<void> {
      const serverUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
      const throwawayName = `telflo_backfill_${randomUUID().replaceAll("-", "")}_test`;
      const throwawayUrl = new URL(serverUrl);
      throwawayUrl.pathname = `/${throwawayName}`;

      await sql`create database ${sql.id(throwawayName)}`.execute(ownerDb);

      // The runner gets a client we own. Given a URL, node-pg-migrate's
      // close() calls client.end() without awaiting it, so dropping the
      // database straight afterwards can kill a connection still closing,
      // whose unhandled error event fails the whole vitest run. With an
      // external client, the runner leaves it open and we end it ourselves.
      // One client per run: after a migration refuses, the runner leaves
      // that client's transaction aborted, so a later run needs a fresh one.
      const throwawayPool = createPool(throwawayUrl.toString());
      const throwaway = createDb(throwawayPool);

      const run = async (direction: "up" | "down", count: number) => {
        const migrationClient = new pg.Client({ connectionString: throwawayUrl.toString(), options: PLATFORM_CONNECTION_OPTIONS });
        await migrationClient.connect();
        try {
          return await runner({
            dbClient: migrationClient,
            dir: migrationsDirectory,
            direction,
            count,
            ...PLATFORM_MIGRATION_OPTIONS,
            log: () => {},
          });
        } finally {
          await migrationClient.end();
        }
      };

      try {
        await body({
          throwaway,
          migrate: (count) => run("up", count),
          migrateDown: (count) => run("down", count),
        });
      } finally {
        await throwaway.destroy();
        await sql`drop database if exists ${sql.id(throwawayName)}`.execute(ownerDb);
      }
    }

    it("the organizations backfill gives each existing user a personal organization, an admin membership and their backfill audit events, and skips soft-deleted users", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate }) => {
        // Up to and including 1700000000001_identity: the D1 schema.
        await migrate(2);
        const applied = await sql<{ name: string }>`select name from pgmigrations order by id`.execute(
          throwaway,
        );
        expect(applied.rows.map((row) => row.name)).toEqual([
          "1700000000000_extensions",
          "1700000000001_identity",
        ]);

        const users = await throwaway
          .insertInto("users")
          .values([
            { email: "Alice@Example.com", accepted_terms_version: "2026-01-01" },
            { email: "bob@example.com", accepted_terms_version: "2026-01-01" },
          ])
          .returningAll()
          .execute();
        const departed = await throwaway
          .insertInto("users")
          .values({
            email: "departed@example.com",
            accepted_terms_version: "2026-01-01",
            deleted_at: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await migrate(1);

        // A soft-deleted account gains nothing: no organization, no
        // membership, no audit event.
        const departedOrganizations = await throwaway
          .selectFrom("organizations")
          .select("id")
          .where("owner_user_id", "=", departed.id)
          .execute();
        const departedMemberships = await throwaway
          .selectFrom("organization_members")
          .select("id")
          .where("user_id", "=", departed.id)
          .execute();
        const departedEvents = await throwaway
          .selectFrom("audit_events")
          .select("id")
          .where("actor_user_id", "=", departed.id)
          .execute();
        expect({
          organizations: departedOrganizations.length,
          memberships: departedMemberships.length,
          events: departedEvents.length,
        }).toEqual({ organizations: 0, memberships: 0, events: 0 });

        for (const user of users) {
          const organizations = await throwaway
            .selectFrom("organizations")
            .selectAll()
            .where("owner_user_id", "=", user.id)
            .execute();
          expect(organizations).toHaveLength(1);
          const organization = organizations[0]!;
          expect(organization).toMatchObject({
            name: `${user.email.toLowerCase()}'s workspace`,
            type: "personal",
          });

          const memberships = await throwaway
            .selectFrom("organization_members")
            .selectAll()
            .where("user_id", "=", user.id)
            .execute();
          expect(memberships).toHaveLength(1);
          expect(memberships[0]).toMatchObject({ organization_id: organization.id, role: "admin" });

          // The two events registration writes for these rows, in its order.
          const events = await throwaway
            .selectFrom("audit_events")
            .selectAll()
            .where("organization_id", "=", organization.id)
            .orderBy("id")
            .execute();
          expect(events).toHaveLength(2);
          expect(events[0]).toMatchObject({
            action: "organization.created",
            actor_user_id: user.id,
            actor_email: user.email,
            organization_id: organization.id,
            subject_type: "organization",
            subject_id: organization.id,
            metadata: { type: "personal", source: "backfill" },
          });
          expect(events[1]).toMatchObject({
            action: "organization_member.added",
            actor_user_id: user.id,
            actor_email: user.email,
            organization_id: organization.id,
            subject_type: "organization_member",
            subject_id: memberships[0]!.id,
            metadata: { role: "admin", source: "backfill" },
          });
        }

        // Nothing else was written: two events per backfilled account.
        const allEvents = await throwaway.selectFrom("audit_events").select("id").execute();
        expect(allEvents).toHaveLength(users.length * 2);

        // The seeded, backfilled database then accepts the invariant: every
        // remaining non-deleted user has a membership, and the soft-deleted one
        // is exempt from the apply-time check.
        await migrate(1);
        const invariantApplied = await sql<{ name: string }>`
          select name from pgmigrations order by id desc limit 1
        `.execute(throwaway);
        expect(invariantApplied.rows[0]?.name).toBe("1700000000003_organization_membership_invariant");
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the application role migration's down revokes every grant, default privileges included, and keeps the role", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Every table in public on which telflo_platform_runtime holds anything. */
        const grantedTables = async () => {
          const { rows } = await sql<{ table_name: string }>`
            select c.relname as table_name
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'platform'
               and c.relkind = 'r'
               and has_table_privilege('telflo_platform_runtime', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
             order by c.relname
          `.execute(throwaway);
          return rows.map((row) => row.table_name);
        };

        /** Every table in public but the migration history: what exists at this point, not applicationTables, which later migrations extend. */
        const tablesSoFar = async () => {
          const { rows } = await sql<{ table_name: string }>`
            select c.relname as table_name
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'platform'
               and c.relkind = 'r'
               and c.relname <> 'pgmigrations'
             order by c.relname
          `.execute(throwaway);
          return rows.map((row) => row.table_name);
        };

        // Through 1700000000009_application_role.
        await migrate(10);
        expect(await grantedTables()).toEqual(await tablesSoFar());
        expect(await grantedTables()).toContain("organization_members");

        await migrateDown(1);
        expect(await grantedTables()).toEqual([]);
        await sql`create table test_after_down (id int)`.execute(throwaway);
        expect(await grantedTables()).toEqual([]);
        const role = await sql<{ rolname: string }>`
          select rolname from pg_roles where rolname = 'telflo_platform_runtime'
        `.execute(throwaway);
        expect(role.rows).toHaveLength(1);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the invariant migration refuses to apply over a user who has no membership", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate }) => {
        // Through 1700000000002_organizations; its backfill runs on an empty
        // table, so the user below, inserted afterwards, has no membership.
        await migrate(3);
        await throwaway
          .insertInto("users")
          .values({ email: "stranded@example.com", accepted_terms_version: "2026-01-01" })
          .execute();

        await expect(migrate(1)).rejects.toThrow(
          "cannot install the membership invariant: 1 user(s) with deleted_at null have no organization membership",
        );
        const triggers = await sql<{ tgname: string }>`
          select tgname from pg_trigger where tgname = 'users_require_membership'
        `.execute(throwaway);
        expect(triggers.rows).toHaveLength(0);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the organizations and memberships migration refuses a user whose only membership is in a deleted organization, clears group owners, and its down restores them from live admins only", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        // Through 1700000000009_application_role: the schema before D5's.
        await migrate(10);
        const { founder, stranded, team, stranding } = await throwaway.transaction().execute(async (transaction) => {
          const founder = await transaction.insertInto("users").values({ email: "founder@example.com" }).returningAll().executeTakeFirstOrThrow();
          const stranded = await transaction.insertInto("users").values({ email: "stranded@example.com" }).returningAll().executeTakeFirstOrThrow();
          const personal = await transaction
            .insertInto("organizations")
            .values({ name: "founder@example.com's workspace", type: "personal", owner_user_id: founder.id })
            .returningAll()
            .executeTakeFirstOrThrow();
          // Before D5 a group organization had an owner, its creator.
          const team = await transaction
            .insertInto("organizations")
            .values({ name: "Team", type: "group", owner_user_id: founder.id })
            .returningAll()
            .executeTakeFirstOrThrow();
          const stranding = await transaction
            .insertInto("organizations")
            .values({ name: "Stranding", type: "group", owner_user_id: founder.id })
            .returningAll()
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("organization_members")
            .values([
              { organization_id: personal.id, user_id: founder.id, role: "admin" },
              { organization_id: team.id, user_id: founder.id, role: "admin" },
              { organization_id: stranding.id, user_id: stranded.id, role: "admin" },
            ])
            .execute();
          return { founder, stranded, team, stranding };
        });
        // Allowed until now: a membership in a deleted organization counted.
        await throwaway.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", stranding.id).execute();

        await expect(migrate(1)).rejects.toThrow(
          "cannot tighten the membership invariant: 1 user(s) with deleted_at null have no membership in a live organization",
        );

        await throwaway.updateTable("organizations").set({ deleted_at: null }).where("id", "=", stranding.id).execute();
        await migrate(1);
        const owners = await throwaway.selectFrom("organizations").select(["name", "owner_user_id"]).orderBy("id").execute();
        expect(owners).toEqual([
          { name: "founder@example.com's workspace", owner_user_id: founder.id },
          { name: "Team", owner_user_id: null },
          { name: "Stranding", owner_user_id: null },
        ]);

        // Team's only admin is removed: a removed admin can't become its
        // owner (the down deletes removed memberships), so the down refuses
        // and changes nothing.
        await throwaway
          .updateTable("organization_members")
          .set({ deleted_at: new Date() })
          .where("organization_id", "=", team.id)
          .execute();

        await expect(migrateDown(1)).rejects.toThrow(
          "cannot restore organizations.owner_user_id to not null: 1 group organization(s) have no live admin to own them",
        );
        const unchanged = await throwaway.selectFrom("organizations").select(["name", "owner_user_id"]).orderBy("id").execute();
        expect(unchanged).toEqual(owners);

        // A later live admin beside the removed earlier one becomes the owner.
        const successor = await throwaway.transaction().execute(async (transaction) => {
          const user = await transaction.insertInto("users").values({ email: "successor@example.com" }).returningAll().executeTakeFirstOrThrow();
          await transaction
            .insertInto("organization_members")
            .values({ organization_id: team.id, user_id: user.id, role: "admin" })
            .execute();
          return user;
        });

        await migrateDown(1);
        const restored = await throwaway.selectFrom("organizations").select(["name", "owner_user_id"]).orderBy("id").execute();
        expect(restored).toEqual([
          { name: "founder@example.com's workspace", owner_user_id: founder.id },
          { name: "Team", owner_user_id: successor.id },
          { name: "Stranding", owner_user_id: stranded.id },
        ]);
        // Without deleted_at a removed membership would read as live, so the
        // down deleted it.
        const teamMembers = await throwaway
          .selectFrom("organization_members")
          .select("user_id")
          .where("organization_id", "=", team.id)
          .execute();
        expect(teamMembers).toEqual([{ user_id: successor.id }]);
        const invariant = await sql<{ prosecdef: boolean; proconfig: string[] | null }>`
          select prosecdef, proconfig from pg_proc where proname = 'ensure_user_has_membership'
        `.execute(throwaway);
        expect(invariant.rows).toEqual([{ prosecdef: false, proconfig: null }]);
        const triggers = await sql<{ tgname: string }>`
          select tgname from pg_trigger
           where tgfoid = 'ensure_user_has_membership'::regproc
           order by tgname
        `.execute(throwaway);
        expect(triggers.rows.map((row) => row.tgname)).toEqual([
          "organization_members_keep_one",
          "organization_members_user_reassigned",
          "users_require_membership",
          "users_restored_require_membership",
        ]);
        const functions = await sql<{ proname: string }>`
          select proname from pg_proc
           where proname in ('reassign_sessions_leaving_organization', 'delete_accounts_only_in_organization')
        `.execute(throwaway);
        expect(functions.rows).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the serialized invariant migration locks the checked users, and its down restores migration 010's check", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const invariant = async () => {
          const { rows } = await sql<{ source: string; isDefiner: boolean }>`
            select prosrc as source, prosecdef as "isDefiner"
              from pg_proc
             where proname = 'ensure_user_has_membership'
          `.execute(throwaway);
          return rows[0]!;
        };
        const triggerNames = async () => {
          const { rows } = await sql<{ tgname: string }>`
            select tgname from pg_trigger where tgfoid = 'ensure_user_has_membership'::regproc order by tgname
          `.execute(throwaway);
          return rows.map((row) => row.tgname);
        };

        // Through 1700000000011_organization_members_rls.
        await migrate(12);
        const before = await invariant();
        const triggers = await triggerNames();
        expect(before.source).not.toMatch(/for no key update/);

        await migrate(1);
        const serialized = await invariant();
        expect(serialized.source).toMatch(/perform 1\s+from users u\s+where u\.id = any \(checked_user_ids\)\s+order by u\.id\s+for no key update;/);
        expect(serialized.isDefiner).toBe(true);
        expect(await triggerNames()).toEqual(triggers);

        await migrateDown(1);
        const restored = await invariant();
        expect(restored.source).not.toMatch(/for no key update/);
        expect(restored.source.replace(/\s+/g, " ")).toBe(before.source.replace(/\s+/g, " "));
        expect(restored.isDefiner).toBe(true);
        expect(await triggerNames()).toEqual(triggers);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the federated identity migration backfills terms_accepted_at from created_at, and its down refuses while a user has no terms version", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** A user with a personal organization and membership, as the invariant requires. */
        const insertAccount = (values: Insertable<UsersTable>) =>
          throwaway.transaction().execute(async (transaction) => {
            const user = await transaction.insertInto("users").values(values).returningAll().executeTakeFirstOrThrow();
            const organization = await transaction
              .insertInto("organizations")
              .values({ name: `${user.email}'s workspace`, type: "personal", owner_user_id: user.id })
              .returningAll()
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("organization_members")
              .values({ organization_id: organization.id, user_id: user.id, role: "admin" })
              .execute();
            return user;
          });
        const termsColumns = async () => {
          const columns = await sql<{ column_name: string; is_nullable: string }>`
            select column_name, is_nullable
              from information_schema.columns
             where table_name = 'users'
               and column_name in ('accepted_terms_version', 'terms_accepted_at')
             order by column_name
          `.execute(throwaway);
          return columns.rows;
        };

        // Through 1700000000006: the schema before D2c.
        await migrate(7);
        const registered = await insertAccount({ email: "registered@example.com", accepted_terms_version: "2026-01-01" });

        await migrate(1);
        const backfilled = await throwaway
          .selectFrom("users")
          .select(["accepted_terms_version", "terms_accepted_at", "created_at"])
          .where("id", "=", registered.id)
          .executeTakeFirstOrThrow();
        expect(backfilled).toEqual({
          accepted_terms_version: "2026-01-01",
          terms_accepted_at: backfilled.created_at,
          created_at: registered.created_at,
        });
        expect(await termsColumns()).toEqual([
          { column_name: "accepted_terms_version", is_nullable: "YES" },
          { column_name: "terms_accepted_at", is_nullable: "YES" },
        ]);

        const federated = await insertAccount({ email: "federated@example.com" });
        await expect(migrateDown(1)).rejects.toThrow(
          "cannot restore users.accepted_terms_version to not null: 1 user(s) have accepted no terms version",
        );
        // The refused down changed nothing.
        expect(await termsColumns()).toHaveLength(2);

        await throwaway.deleteFrom("users").where("id", "=", federated.id).execute();
        await migrateDown(1);
        expect(await termsColumns()).toEqual([{ column_name: "accepted_terms_version", is_nullable: "NO" }]);
        const identities = await sql<{ name: string | null }>`
          select to_regclass('user_identities')::text as name
        `.execute(throwaway);
        expect(identities.rows[0]?.name).toBeNull();
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the invitations migration's down drops the table, its policies and its function, and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const installed = async () => {
          const { rows } = await sql<{ table: string | null; policies: number; functions: number }>`
            select to_regclass('organization_invitations')::text as table,
                   (select count(*)::int from pg_policies where tablename = 'organization_invitations') as policies,
                   (select count(*)::int from pg_proc where proname = 'organization_invitation_by_token_hash') as functions
          `.execute(throwaway);
          return rows[0];
        };

        // Through 1700000000013_organization_invitations.
        await migrate(14);
        expect(await installed()).toEqual({ table: "organization_invitations", policies: 4, functions: 1 });

        await migrateDown(1);
        expect(await installed()).toEqual({ table: null, policies: 0, functions: 0 });

        await migrate(1);
        expect(await installed()).toEqual({ table: "organization_invitations", policies: 4, functions: 1 });
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the viewer migration makes every viewer a contributor, recreates organization_role as admin and contributor, keeps the definer function, and its down adds viewer back", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const roleValues = async () => {
          const { rows } = await sql<{ label: string }>`
            select enumlabel as label from pg_enum
             where enumtypid = 'organization_role'::regtype
             order by enumsortorder
          `.execute(throwaway);
          return rows.map((row) => row.label);
        };
        const definer = async () => {
          const { rows } = await sql<{
            isDefiner: boolean;
            volatility: string;
            config: string[] | null;
            comment: string | null;
            applicationMayRun: boolean;
            publicMayRun: boolean;
          }>`
            select p.prosecdef as "isDefiner", p.provolatile as volatility, p.proconfig as config,
                   obj_description(p.oid, 'pg_proc') as comment,
                   has_function_privilege('telflo_platform_runtime', p.oid, 'EXECUTE') as "applicationMayRun",
                   exists (
                     select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                   ) as "publicMayRun"
              from pg_proc p
             where p.proname = 'organization_invitation_by_token_hash'
          `.execute(throwaway);
          return rows;
        };
        /** The function as the API's role calls it, with no database context. */
        const byTokenHashAsApplication = (tokenHash: string) =>
          throwaway.transaction().execute(async (transaction) => {
            await sql`set local role telflo_platform_runtime`.execute(transaction);
            const { rows } = await sql<{ id: string; role: string; organization_is_live: boolean }>`
              select id, role::text as role, organization_is_live
                from organization_invitation_by_token_hash(${tokenHash})
            `.execute(transaction);
            return rows;
          });
        const memberships = async () => {
          const { rows } = await sql<{ user_id: string; role: string; updated_at: Date }>`
            select user_id, role::text as role, updated_at from organization_members
             where organization_id = ${teamId} order by user_id
          `.execute(throwaway);
          return rows;
        };
        const invitations = async () => {
          const { rows } = await sql<{ email: string; role: string; updated_at: Date }>`
            select email, role::text as role, updated_at from organization_invitations order by email
          `.execute(throwaway);
          return rows;
        };

        // Through 1700000000013_organization_invitations: the schema before D7.
        await migrate(14);
        expect(await roleValues()).toEqual(["admin", "contributor", "viewer"]);
        const before = await definer();

        // In raw SQL: the typed schema no longer has viewer. Each user gets a
        // personal organization and an admin membership in the same
        // transaction, as the membership invariant requires.
        const longAgo = new Date("2026-01-01T00:00:00.000Z");
        const teamId = await throwaway.transaction().execute(async (transaction) => {
          const { rows: users } = await sql<{ id: string; email: string }>`
            insert into users (email)
            values ('admin@example.com'), ('viewer@example.com')
            returning id, email
          `.execute(transaction);
          for (const user of users) {
            await sql`
              with personal as (
                insert into organizations (name, type, owner_user_id)
                values (${`${user.email}'s workspace`}, 'personal', ${user.id})
                returning id
              )
              insert into organization_members (organization_id, user_id, role)
              select id, ${user.id}, 'admin' from personal
            `.execute(transaction);
          }
          const { rows: teams } = await sql<{ id: string }>`
            insert into organizations (name, type) values ('Team', 'group') returning id
          `.execute(transaction);
          const team = teams[0]!.id;
          const [admin, viewer] = users;
          await sql`
            insert into organization_members (organization_id, user_id, role, updated_at)
            values (${team}, ${admin!.id}, 'admin', ${longAgo}),
                   (${team}, ${viewer!.id}, 'viewer', ${longAgo})
          `.execute(transaction);
          await sql`
            insert into organization_invitations (organization_id, email, role, token_hash, expires_at, updated_at)
            values (${team}, 'invited-admin@example.com', 'admin', 'admin-token-hash', ${new Date(Date.now() + 60_000)}, ${longAgo}),
                   (${team}, 'invited-viewer@example.com', 'viewer', 'viewer-token-hash', ${new Date(Date.now() + 60_000)}, ${longAgo})
          `.execute(transaction);
          return team;
        });
        const membershipsBefore = await memberships();
        const invitationsBefore = await invitations();
        expect(membershipsBefore.map((row) => row.role).sort()).toEqual(["admin", "viewer"]);
        expect(invitationsBefore.map((row) => row.role)).toEqual(["admin", "viewer"]);
        const viewerInvitation = await byTokenHashAsApplication("viewer-token-hash");
        expect(viewerInvitation).toMatchObject([{ role: "viewer", organization_is_live: true }]);

        await migrate(1);

        // The values test: viewer is gone from the type itself.
        expect(await roleValues()).toEqual(["admin", "contributor"]);

        // The viewer became a contributor, with updated_at moved; the admin is untouched.
        const membershipsAfter = await memberships();
        expect(membershipsAfter.map((row) => ({ user_id: row.user_id, role: row.role }))).toEqual(
          membershipsBefore.map((row) => ({ user_id: row.user_id, role: row.role === "viewer" ? "contributor" : row.role })),
        );
        for (const [index, row] of membershipsAfter.entries()) {
          if (membershipsBefore[index]!.role === "viewer") {
            expect(row.updated_at.getTime()).toBeGreaterThan(longAgo.getTime());
          } else {
            expect(row.updated_at).toEqual(longAgo);
          }
        }
        const invitationsAfter = await invitations();
        expect(invitationsAfter.map((row) => ({ email: row.email, role: row.role }))).toEqual([
          { email: "invited-admin@example.com", role: "admin" },
          { email: "invited-viewer@example.com", role: "contributor" },
        ]);
        expect(invitationsAfter[0]!.updated_at).toEqual(longAgo);
        expect(invitationsAfter[1]!.updated_at.getTime()).toBeGreaterThan(longAgo.getTime());

        // Both role columns are the new type.
        const { rows: columns } = await sql<{ table_name: string; udt_name: string }>`
          select table_name, udt_name from information_schema.columns
           where column_name = 'role' and table_name in ('organization_members', 'organization_invitations')
           order by table_name
        `.execute(throwaway);
        expect(columns).toEqual([
          { table_name: "organization_invitations", udt_name: "organization_role" },
          { table_name: "organization_members", udt_name: "organization_role" },
        ]);
        const { rows: leftovers } = await sql<{ typname: string }>`
          select typname from pg_type where typname like 'organization_role%' and typtype = 'e'
        `.execute(throwaway);
        expect(leftovers).toEqual([{ typname: "organization_role" }]);

        // The definer function is migration 013's: it still finds an
        // invitation by its hash as the API's role, and only that role may
        // run it.
        expect(await byTokenHashAsApplication("viewer-token-hash")).toEqual([
          { id: viewerInvitation[0]!.id, role: "contributor", organization_is_live: true },
        ]);
        expect(await byTokenHashAsApplication("unknown-token-hash")).toEqual([]);
        const after = await definer();
        expect(after).toEqual(before);
        expect(after).toEqual([
          {
            isDefiner: true,
            volatility: "s",
            config: ["search_path=platform, pg_temp"],
            comment: expect.stringContaining("the invitation a token's hash names, past row-level security"),
            applicationMayRun: true,
            publicMayRun: false,
          },
        ]);

        // A viewer can no longer be written.
        await expect(
          sql`update organization_invitations set role = 'viewer' where email = 'invited-admin@example.com'`.execute(
            throwaway,
          ),
        ).rejects.toThrow(/invalid input value for enum organization_role: "viewer"/);

        // The down adds viewer back and moves nobody: which members were
        // viewers isn't recorded.
        await migrateDown(1);
        expect(await roleValues()).toEqual(["admin", "contributor", "viewer"]);
        expect((await memberships()).map((row) => row.role).sort()).toEqual(["admin", "contributor"]);
        expect((await invitations()).map((row) => row.role)).toEqual(["admin", "contributor"]);
        expect(await definer()).toEqual(before);

        // And it applies again.
        await migrate(1);
        expect(await roleValues()).toEqual(["admin", "contributor"]);
        expect(await definer()).toEqual(before);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the configurations migration creates the table with row-level security, its four policies, its indexes and the application role's privileges, and its down drops them all", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const installed = async () => {
          const { rows } = await sql<{
            table: string | null;
            rowLevelSecurity: boolean | null;
            policies: string[] | null;
            indexes: string[] | null;
            applicationMay: boolean | null;
          }>`
            select to_regclass('configurations')::text as table,
                   (select relrowsecurity from pg_class where oid = to_regclass('configurations')) as "rowLevelSecurity",
                   (select array_agg(policyname::text || ' ' || cmd || ' ' || array_to_string(roles, ',') order by policyname)
                      from pg_policies where tablename = 'configurations') as policies,
                   (select array_agg(indexname::text order by indexname)
                      from pg_indexes where tablename = 'configurations') as indexes,
                   case when to_regclass('configurations') is null then null
                        else has_table_privilege('telflo_platform_runtime', 'configurations', 'SELECT, INSERT, UPDATE, DELETE')
                   end as "applicationMay"
          `.execute(throwaway);
          return rows[0];
        };
        const present = {
          table: "configurations",
          rowLevelSecurity: true,
          policies: [
            "configurations_delete DELETE telflo_platform_runtime",
            "configurations_insert INSERT telflo_platform_runtime",
            "configurations_select SELECT telflo_platform_runtime",
            "configurations_update UPDATE telflo_platform_runtime",
          ],
          indexes: [
            "configurations_pkey",
            "idx_configurations_created_by_user_id",
            "idx_configurations_organization_id_updated_at",
            "uq_configurations_id_organization_id",
          ],
          applicationMay: true,
        };
        const absent = { table: null, rowLevelSecurity: null, policies: null, indexes: null, applicationMay: null };

        // Through 1700000000015_configurations: the runner counts from _000.
        await migrate(16);
        expect(await installed()).toEqual(present);

        await migrateDown(1);
        expect(await installed()).toEqual(absent);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the configuration versions migration gives every existing configuration, deleted or not, exactly one version 1 with empty YAML, its creator and its created_at", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate }) => {
        // Through 1700000000015_configurations: the schema before D8.
        await migrate(16);

        // The fixtures commit each user with a membership, as the membership
        // invariant requires. The hard-deleted creator's configuration is in a
        // group organization, since a personal one would go with its owner
        // (D7 Preflight ruling 6).
        const admin = await createUserWithOrganization(throwaway);
        const departed = await createUserWithOrganization(throwaway);
        const group = await addMembership(throwaway, { userId: admin.user.id });
        await addMembership(throwaway, { userId: departed.user.id, organizationId: group.organization.id });
        const created = new Date("2030-01-01T00:00:00.123Z");
        const updated = new Date("2030-02-01T00:00:00.456Z");
        const live = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
          created_at: created,
          updated_at: updated,
        });
        const deleted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: group.organization.id,
          created_by_user_id: admin.user.id,
          created_at: new Date("2030-01-02T00:00:00.789Z"),
          updated_at: updated,
          deleted_at: updated,
        });
        const withoutCreator = await addConfiguration(throwaway, {
          collector: false,
          organizationId: group.organization.id,
          created_by_user_id: null,
          created_at: new Date("2030-01-03T00:00:00.001Z"),
          updated_at: updated,
        });
        const byDeparted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: group.organization.id,
          created_by_user_id: departed.user.id,
          created_at: new Date("2030-01-04T00:00:00.999Z"),
          updated_at: updated,
        });
        await throwaway.deleteFrom("users").where("id", "=", departed.user.id).execute();
        const configurations = await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute();
        expect(configurations.map((row) => row.id)).toEqual(
          [live.id, deleted.id, withoutCreator.id, byDeparted.id].sort(),
        );

        await migrate(1);

        const versions = await throwaway.selectFrom("configuration_versions").selectAll().execute();
        expect(versions).toHaveLength(configurations.length);
        for (const configuration of configurations) {
          const own = versions.filter((version) => version.configuration_id === configuration.id);
          expect(own).toEqual([
            {
              id: expect.any(String),
              configuration_id: configuration.id,
              organization_id: configuration.organization_id,
              version_number: 1,
              yaml_content: "",
              created_by_user_id: configuration.created_by_user_id,
              created_at: configuration.created_at,
              updated_at: configuration.created_at,
            },
          ]);
        }
        // The timestamps kept their milliseconds, and the departed creator is null.
        expect(versions.find((version) => version.configuration_id === live.id)?.updated_at.toISOString()).toBe(
          "2030-01-01T00:00:00.123Z",
        );
        expect(versions.find((version) => version.configuration_id === byDeparted.id)?.created_by_user_id).toBeNull();
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the configuration versions migration creates the table with row-level security, its four policies, its constraints and indexes and the application role's privileges, and its down drops them all", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const installed = async () => {
          const { rows } = await sql<{
            table: string | null;
            rowLevelSecurity: boolean | null;
            forceRowLevelSecurity: boolean | null;
            policies: string[] | null;
            constraints: string[] | null;
            indexes: string[] | null;
            applicationMay: boolean | null;
          }>`
            select to_regclass('configuration_versions')::text as table,
                   (select relrowsecurity from pg_class where oid = to_regclass('configuration_versions')) as "rowLevelSecurity",
                   (select relforcerowsecurity from pg_class where oid = to_regclass('configuration_versions')) as "forceRowLevelSecurity",
                   (select array_agg(policyname::text || ' ' || cmd || ' ' || array_to_string(roles, ',') order by policyname)
                      from pg_policies where tablename = 'configuration_versions') as policies,
                   (select array_agg(conname::text order by conname)
                      from pg_constraint where conrelid = to_regclass('configuration_versions')
                       and contype <> 'n') as constraints,
                   (select array_agg(indexname::text order by indexname)
                      from pg_indexes where tablename = 'configuration_versions') as indexes,
                   case when to_regclass('configuration_versions') is null then null
                        else has_table_privilege('telflo_platform_runtime', 'configuration_versions', 'SELECT, INSERT, UPDATE, DELETE')
                   end as "applicationMay"
          `.execute(throwaway);
          return rows[0];
        };
        const present = {
          table: "configuration_versions",
          rowLevelSecurity: true,
          forceRowLevelSecurity: false,
          policies: [
            "configuration_versions_delete DELETE telflo_platform_runtime",
            "configuration_versions_insert INSERT telflo_platform_runtime",
            "configuration_versions_select SELECT telflo_platform_runtime",
            "configuration_versions_update UPDATE telflo_platform_runtime",
          ],
          constraints: [
            "ck_configuration_versions_version_number",
            "ck_configuration_versions_yaml_content_length",
            "configuration_versions_created_by_user_id_fkey",
            "configuration_versions_pkey",
            "fk_configuration_versions_configuration",
            "uq_configuration_versions_organization_configuration_version",
          ],
          indexes: [
            "configuration_versions_pkey",
            "idx_configuration_versions_created_by_user_id",
            "uq_configuration_versions_organization_configuration_version",
          ],
          applicationMay: true,
        };
        const absent = {
          table: null,
          rowLevelSecurity: null,
          forceRowLevelSecurity: null,
          policies: null,
          constraints: null,
          indexes: null,
          applicationMay: null,
        };

        // Through 1700000000016_configuration_versions.
        await migrate(17);
        expect(await installed()).toEqual(present);

        await migrateDown(1);
        expect(await installed()).toEqual(absent);
        // configurations, which it references, stays.
        const { rows: referenced } = await sql<{ table: string | null }>`
          select to_regclass('configurations')::text as table
        `.execute(throwaway);
        expect(referenced).toEqual([{ table: "configurations" }]);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the configuration version graph migration gives every existing version, a deleted configuration's included, '[]' in nodes, edges and pipelines, and changes nothing else", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate }) => {
        // Through 1700000000016_configuration_versions: D8's schema.
        await migrate(17);

        const admin = await createUserWithOrganization(throwaway);
        const live = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        const deleted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
          deleted_at: new Date("2030-02-01T00:00:00.000Z"),
        });
        const at = new Date("2030-01-01T00:00:00.123Z");
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: live.id,
          organizationId: admin.organization.id,
          yaml_content: "receivers:\r\n  otlp: {}\r\n",
          created_by_user_id: admin.user.id,
          created_at: at,
          updated_at: at,
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: live.id,
          organizationId: admin.organization.id,
          version_number: 2,
          yaml_content: "",
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: deleted.id,
          organizationId: admin.organization.id,
          yaml_content: "exporters: {}\n",
        });
        const before = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(before).toHaveLength(3);
        expect(Object.keys(before[0]!)).not.toContain("nodes");

        await migrate(1);

        const after = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(after).toEqual(before.map((row) => ({ ...row, nodes: [], edges: [], pipelines: [] })));
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the configuration version graph migration creates the three columns and their six checks, and its down drops them", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const installed = async () => {
          const { rows: columns } = await sql<{ column: string; type: string; nullable: string; default: string }>`
            select column_name as column, data_type as type, is_nullable as nullable, column_default as default
              from information_schema.columns
             where table_schema = 'platform' and table_name = 'configuration_versions'
               and column_name in ('nodes', 'edges', 'pipelines')
             order by column_name
          `.execute(throwaway);
          const { rows: checks } = await sql<{ name: string; definition: string }>`
            select conname as name, pg_get_constraintdef(oid) as definition
              from pg_constraint
             where conrelid = to_regclass('configuration_versions')
               and conname ~ '^ck_configuration_versions_(nodes|edges|pipelines)_'
             order by conname
          `.execute(throwaway);
          return { columns, checks };
        };
        const column = (name: string) => ({ column: name, type: "jsonb", nullable: "NO", default: "'[]'::jsonb" });
        const checks = (name: string) => [
          { name: `ck_configuration_versions_${name}_array`, definition: `CHECK ((jsonb_typeof(${name}) = 'array'::text))` },
          {
            name: `ck_configuration_versions_${name}_size`,
            definition: `CHECK ((octet_length((${name})::text) <= 4194304))`,
          },
        ];
        const present = {
          columns: [column("edges"), column("nodes"), column("pipelines")],
          checks: [...checks("edges"), ...checks("nodes"), ...checks("pipelines")],
        };

        // Through 1700000000017_configuration_version_graph.
        await migrate(18);
        expect(await installed()).toEqual(present);

        await migrateDown(1);
        expect(await installed()).toEqual({ columns: [], checks: [] });
        // The table itself, and D8's own checks, stay.
        const { rows: kept } = await sql<{ name: string }>`
          select conname as name from pg_constraint
           where conrelid = to_regclass('configuration_versions') and contype = 'c'
           order by conname
        `.execute(throwaway);
        expect(kept.map((row) => row.name)).toEqual([
          "ck_configuration_versions_version_number",
          "ck_configuration_versions_yaml_content_length",
        ]);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the version labels and selections migration keeps every existing version, a deleted configuration's included, unnamed, and changes nothing else", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate }) => {
        // Through 1700000000017_configuration_version_graph: D9's schema.
        await migrate(18);

        const admin = await createUserWithOrganization(throwaway);
        const live = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        const deleted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
          deleted_at: new Date("2030-02-01T00:00:00.000Z"),
        });
        const at = new Date("2030-01-01T00:00:00.123Z");
        // Inserted in SQL: the fixture's type has the label, which this schema hasn't yet.
        for (const [configurationId, versionNumber] of [
          [live.id, 1],
          [live.id, 2],
          [deleted.id, 1],
        ] as const) {
          await sql`
            insert into configuration_versions
              (configuration_id, organization_id, version_number, yaml_content, created_by_user_id, created_at, updated_at, nodes)
            values (${configurationId}, ${admin.organization.id}, ${versionNumber}, ${`v${versionNumber}`},
                    ${admin.user.id}, ${at}, ${at}, '[{"id":"n"}]'::jsonb)
          `.execute(throwaway);
        }
        const before = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(before).toHaveLength(3);
        expect(Object.keys(before[0]!)).not.toContain("label");

        await migrate(1);

        const after = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(after).toEqual(before.map((row) => ({ ...row, label: null })));
        expect(await throwaway.selectFrom("configuration_version_selections").selectAll().execute()).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the version labels and selections migration creates the label and its check, the versions' wider unique key, and the selections table with row-level security, its four policies, its constraints and indexes and the application role's privileges; its down drops them all, and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const installed = async () => {
          const { rows } = await sql<{
            label: string | null;
            versionConstraints: string[] | null;
            table: string | null;
            rowLevelSecurity: boolean | null;
            forceRowLevelSecurity: boolean | null;
            policies: string[] | null;
            constraints: string[] | null;
            indexes: string[] | null;
            applicationMay: boolean | null;
          }>`
            select (select data_type || ' ' || is_nullable || ' ' || coalesce(column_default, 'no default')
                      from information_schema.columns
                     where table_schema = 'platform' and table_name = 'configuration_versions'
                       and column_name = 'label') as label,
                   (select array_agg(conname::text || ' ' || pg_get_constraintdef(oid) order by conname)
                      from pg_constraint where conrelid = to_regclass('configuration_versions')
                       and conname in ('ck_configuration_versions_label_length',
                                       'uq_configuration_versions_id_configuration_organization'))
                     as "versionConstraints",
                   to_regclass('configuration_version_selections')::text as table,
                   (select relrowsecurity from pg_class where oid = to_regclass('configuration_version_selections')) as "rowLevelSecurity",
                   (select relforcerowsecurity from pg_class where oid = to_regclass('configuration_version_selections')) as "forceRowLevelSecurity",
                   (select array_agg(policyname::text || ' ' || cmd || ' ' || array_to_string(roles, ',') order by policyname)
                      from pg_policies where tablename = 'configuration_version_selections') as policies,
                   (select array_agg(conname::text || ' ' || pg_get_constraintdef(oid) order by conname)
                      from pg_constraint where conrelid = to_regclass('configuration_version_selections')
                       and contype <> 'n') as constraints,
                   (select array_agg(indexname::text || ' ' || indexdef order by indexname)
                      from pg_indexes where tablename = 'configuration_version_selections') as indexes,
                   case when to_regclass('configuration_version_selections') is null then null
                        else has_table_privilege('telflo_platform_runtime', 'configuration_version_selections', 'SELECT, INSERT, UPDATE, DELETE')
                   end as "applicationMay"
          `.execute(throwaway);
          return rows[0];
        };
        const present = {
          label: "text YES no default",
          versionConstraints: [
            "ck_configuration_versions_label_length CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 80))))",
            "uq_configuration_versions_id_configuration_organization UNIQUE (id, configuration_id, organization_id)",
          ],
          table: "configuration_version_selections",
          rowLevelSecurity: true,
          forceRowLevelSecurity: false,
          policies: [
            "configuration_version_selections_delete DELETE telflo_platform_runtime",
            "configuration_version_selections_insert INSERT telflo_platform_runtime",
            "configuration_version_selections_select SELECT telflo_platform_runtime",
            "configuration_version_selections_update UPDATE telflo_platform_runtime",
          ],
          constraints: [
            "configuration_version_selections_pkey PRIMARY KEY (id)",
            "configuration_version_selections_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
            "fk_configuration_version_selections_configuration FOREIGN KEY (configuration_id, organization_id) " +
              "REFERENCES configurations(id, organization_id) ON DELETE CASCADE",
            "fk_configuration_version_selections_version FOREIGN KEY (version_id, configuration_id, organization_id) " +
              "REFERENCES configuration_versions(id, configuration_id, organization_id) ON DELETE CASCADE",
            "uq_configuration_version_selections_organization_user_config UNIQUE (organization_id, user_id, configuration_id)",
          ],
          indexes: [
            "configuration_version_selections_pkey CREATE UNIQUE INDEX configuration_version_selections_pkey " +
              "ON platform.configuration_version_selections USING btree (id)",
            "idx_configuration_version_selections_user_id CREATE INDEX idx_configuration_version_selections_user_id " +
              "ON platform.configuration_version_selections USING btree (user_id)",
            "idx_configuration_version_selections_version CREATE INDEX idx_configuration_version_selections_version " +
              "ON platform.configuration_version_selections USING btree (version_id, configuration_id, organization_id)",
            "uq_configuration_version_selections_organization_user_config CREATE UNIQUE INDEX " +
              "uq_configuration_version_selections_organization_user_config " +
              "ON platform.configuration_version_selections USING btree (organization_id, user_id, configuration_id)",
          ],
          applicationMay: true,
        };
        const absent = {
          label: null,
          versionConstraints: null,
          table: null,
          rowLevelSecurity: null,
          forceRowLevelSecurity: null,
          policies: null,
          constraints: null,
          indexes: null,
          applicationMay: null,
        };

        // Through 1700000000018_configuration_versions_labels_and_selections.
        await migrate(19);
        expect(await installed()).toEqual(present);

        await migrateDown(1);
        expect(await installed()).toEqual(absent);
        // configuration_versions, with D8's and D9a's columns, stays.
        const { rows: kept } = await sql<{ column: string }>`
          select column_name as column from information_schema.columns
           where table_schema = 'platform' and table_name = 'configuration_versions'
           order by column_name
        `.execute(throwaway);
        expect(kept.map((row) => row.column)).toEqual([
          "configuration_id",
          "created_at",
          "created_by_user_id",
          "edges",
          "id",
          "nodes",
          "organization_id",
          "pipelines",
          "updated_at",
          "version_number",
          "yaml_content",
        ]);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the publishing migration keeps every existing version a draft and changes nothing else; adds the three publish columns, their check, unique constraint, foreign key and indexes, and the immutability trigger and its function, each with its comment; its down leaves the table as migration 018 left it, and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Everything about configuration_versions a migration can change, and the trigger's function. */
        const structure = async () => {
          const { rows } = await sql<{
            columns: string[];
            constraints: string[];
            indexes: string[];
            triggers: string[] | null;
            functions: string[] | null;
          }>`
            select (select array_agg(column_name::text || ' ' || data_type || ' ' || is_nullable || ' ' ||
                                     coalesce(column_default, 'no default') order by column_name)
                      from information_schema.columns
                     where table_schema = 'platform' and table_name = 'configuration_versions') as columns,
                   (select array_agg(conname::text || ' ' || pg_get_constraintdef(oid) order by conname)
                      from pg_constraint where conrelid = to_regclass('configuration_versions')
                       and contype <> 'n') as constraints,
                   (select array_agg(pg_get_indexdef(indexrelid) order by indexrelid::regclass::text)
                      from pg_index where indrelid = to_regclass('configuration_versions')) as indexes,
                   (select array_agg(pg_get_triggerdef(oid) || ' ' || tgenabled::text order by tgname)
                      from pg_trigger where tgrelid = to_regclass('configuration_versions')
                       and not tgisinternal) as triggers,
                   (select array_agg(proname::text order by proname)
                      from pg_proc where proname = 'refuse_published_configuration_version_change') as functions
          `.execute(throwaway);
          return rows[0]!;
        };
        /** The new objects' facts and comments, from the catalog. */
        const publishing = async () => {
          const { rows: columns } = await sql<{
            column: string;
            type: string;
            nullable: string;
            comment: string | null;
          }>`
            select a.attname::text as column, format_type(a.atttypid, a.atttypmod) as type,
                   case when a.attnotnull then 'NO' else 'YES' end as nullable,
                   col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
             where a.attrelid = to_regclass('configuration_versions') and not a.attisdropped
               and a.attname in ('published_at', 'published_by_user_id', 'publication_id')
             order by a.attname
          `.execute(throwaway);
          const { rows: constraints } = await sql<{ name: string; definition: string; comment: string | null }>`
            select conname::text as name, pg_get_constraintdef(oid) as definition,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint
             where conrelid = to_regclass('configuration_versions')
               and conname in ('ck_configuration_versions_published_at_publication_id',
                               'uq_configuration_versions_publication_id',
                               'configuration_versions_published_by_user_id_fkey')
             order by conname
          `.execute(throwaway);
          const { rows: indexes } = await sql<{
            name: string;
            definition: string;
            isUnique: boolean;
            predicate: string | null;
            comment: string | null;
          }>`
            select i.indexrelid::regclass::text as name, pg_get_indexdef(i.indexrelid) as definition,
                   i.indisunique as "isUnique", pg_get_expr(i.indpred, i.indrelid) as predicate,
                   obj_description(i.indexrelid, 'pg_class') as comment
              from pg_index i
             where i.indrelid = to_regclass('configuration_versions')
               and i.indexrelid::regclass::text in ('idx_configuration_versions_configuration_id_published',
                                                    'idx_configuration_versions_published_by_user_id')
             order by name
          `.execute(throwaway);
          const { rows: functions } = await sql<{
            isDefiner: boolean;
            volatility: string;
            config: string[] | null;
            returns: string;
            comment: string | null;
          }>`
            select p.prosecdef as "isDefiner", p.provolatile as volatility, p.proconfig as config,
                   p.prorettype::regtype::text as returns, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p
             where p.proname = 'refuse_published_configuration_version_change'
          `.execute(throwaway);
          const { rows: triggers } = await sql<{ definition: string; enabled: string; comment: string | null }>`
            select pg_get_triggerdef(oid) as definition, tgenabled::text as enabled,
                   obj_description(oid, 'pg_trigger') as comment
              from pg_trigger
             where tgrelid = to_regclass('configuration_versions')
               and tgname = 'configuration_versions_published_immutable'
          `.execute(throwaway);
          return { columns, constraints, indexes, functions, triggers };
        };
        const present = {
          columns: [
            {
              column: "publication_id",
              type: "uuid",
              nullable: "YES",
              comment: expect.stringContaining("the opamp-server's id for the version's snapshot"),
            },
            {
              column: "published_at",
              type: "timestamp with time zone",
              nullable: "YES",
              comment: expect.stringContaining("when the version was published"),
            },
            {
              column: "published_by_user_id",
              type: "uuid",
              nullable: "YES",
              comment: expect.stringContaining("the member who published the version"),
            },
          ],
          constraints: [
            {
              name: "ck_configuration_versions_published_at_publication_id",
              definition: "CHECK (((published_at IS NULL) = (publication_id IS NULL)))",
              comment: expect.stringContaining("both set or both null"),
            },
            {
              name: "configuration_versions_published_by_user_id_fkey",
              definition: "FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
              comment: expect.stringContaining("the publisher is a user"),
            },
            {
              name: "uq_configuration_versions_publication_id",
              definition: "UNIQUE (publication_id)",
              comment: expect.stringContaining("one snapshot is one version's"),
            },
          ],
          indexes: [
            {
              name: "idx_configuration_versions_configuration_id_published",
              definition:
                "CREATE INDEX idx_configuration_versions_configuration_id_published ON platform.configuration_versions " +
                "USING btree (configuration_id, organization_id) WHERE (published_at IS NOT NULL)",
              isUnique: false,
              predicate: "(published_at IS NOT NULL)",
              comment: expect.stringContaining('answers "is this configuration published"'),
            },
            {
              name: "idx_configuration_versions_published_by_user_id",
              definition:
                "CREATE INDEX idx_configuration_versions_published_by_user_id ON platform.configuration_versions " +
                "USING btree (published_by_user_id)",
              isUnique: false,
              predicate: null,
              comment: expect.stringContaining("a hard-deleted account sets published_by_user_id to null"),
            },
          ],
          functions: [
            {
              isDefiner: false,
              volatility: "v",
              config: ["search_path=platform, pg_temp"],
              returns: "trigger",
              comment: expect.stringContaining("the immutability of published versions"),
            },
          ],
          triggers: [
            {
              definition:
                "CREATE TRIGGER configuration_versions_published_immutable " +
                "BEFORE UPDATE ON platform.configuration_versions " +
                "FOR EACH ROW EXECUTE FUNCTION refuse_published_configuration_version_change()",
              enabled: "O",
              comment: expect.stringContaining("session_replication_role = replica"),
            },
          ],
        };

        // Through 1700000000019_connect_only_by_application: D11a's schema.
        await migrate(20);
        const before = await structure();
        expect(before.triggers).toBeNull();
        expect(before.functions).toBeNull();

        const admin = await createUserWithOrganization(throwaway);
        const live = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        const deleted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
          deleted_at: new Date("2030-02-01T00:00:00.000Z"),
        });
        for (const [configurationId, version_number] of [
          [live.id, 1],
          [live.id, 2],
          [deleted.id, 1],
        ] as const) {
          // The fixture writes no publish column unless given one, so it
          // inserts into this schema too.
          await addConfigurationVersion(throwaway, {
            collector: false,
            configurationId,
            organizationId: admin.organization.id,
            version_number,
            yaml_content: `v${version_number}`,
            label: `Version ${version_number}`,
            nodes: JSON.stringify([{ id: "n" }]),
            created_by_user_id: admin.user.id,
          });
        }
        const rowsBefore = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(rowsBefore).toHaveLength(3);
        expect(Object.keys(rowsBefore[0]!)).not.toContain("published_at");

        await migrate(1);
        const rowsAfter = await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute();
        expect(rowsAfter).toEqual(
          rowsBefore.map((row) => ({ ...row, published_at: null, published_by_user_id: null, publication_id: null })),
        );
        expect(await publishing()).toEqual(present);

        await migrateDown(1);
        expect(await structure()).toEqual(before);
        expect(await publishing()).toEqual({ columns: [], constraints: [], indexes: [], functions: [], triggers: [] });
        expect(await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute()).toEqual(
          rowsBefore,
        );

        await migrate(1);
        expect(await publishing()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the drafts-private migration adds the definer helper (its grants, its search_path, its comment), every configurations, versions and selections policy's new rule and comment, and the publisher-only-when-published check; changes no row or table grant; its down puts back migrations 015's, 016's and 018's policies and comments exactly, and drops the check and the helper; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const tables = ["configuration_version_selections", "configuration_versions", "configurations"];
        /** Every policy on the three tables, with its expressions and comment, and the tables' grants. */
        const policies = async () => {
          const { rows } = await sql<{
            name: string;
            command: string;
            roles: string;
            using: string | null;
            check: string | null;
            comment: string | null;
          }>`
            select p.polname::text as name, p.polcmd::text as command,
                   array_to_string(array(select r::regrole::text from unnest(p.polroles) r), ',') as roles,
                   pg_get_expr(p.polqual, p.polrelid) as using,
                   pg_get_expr(p.polwithcheck, p.polrelid) as check,
                   obj_description(p.oid, 'pg_policy') as comment
              from pg_policy p
             where p.polrelid::regclass::text in (${sql.join(tables)})
             order by p.polname
          `.execute(throwaway);
          return rows;
        };
        const tableFacts = async () => {
          const { rows } = await sql<{ table: string; acl: string[] | null; force: boolean; rls: boolean }>`
            select relname::text as table, relacl::text[] as acl, relforcerowsecurity as force, relrowsecurity as rls
              from pg_class where relname in (${sql.join(tables)}) order by relname
          `.execute(throwaway);
          return rows;
        };
        /** The helper's facts and grants, from the catalog; empty when it isn't there. */
        const helper = async () => {
          const { rows } = await sql<{
            arguments: string;
            returns: string;
            language: string;
            isDefiner: boolean;
            volatility: string;
            config: string[] | null;
            comment: string | null;
            executors: string[];
            applicationMayRun: boolean;
          }>`
            select pg_get_function_identity_arguments(p.oid) as arguments, p.prorettype::regtype::text as returns,
                   l.lanname::text as language, p.prosecdef as "isDefiner", p.provolatile as volatility,
                   p.proconfig as config, obj_description(p.oid, 'pg_proc') as comment,
                   array(select case when acl.grantee = 0 then 'PUBLIC' else acl.grantee::regrole::text end
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                          where acl.privilege_type = 'EXECUTE'
                          order by 1) as executors,
                   has_function_privilege('telflo_platform_runtime', p.oid, 'EXECUTE') as "applicationMayRun"
              from pg_proc p join pg_language l on l.oid = p.prolang
             where p.proname = 'configuration_is_published'
          `.execute(throwaway);
          return rows;
        };
        const check = async () => {
          const { rows } = await sql<{ definition: string; comment: string | null }>`
            select pg_get_constraintdef(oid) as definition, obj_description(oid, 'pg_constraint') as comment
              from pg_constraint
             where conrelid = to_regclass('configuration_versions')
               and conname = 'ck_configuration_versions_publisher_only_when_published'
          `.execute(throwaway);
          return rows;
        };

        const organization = "(NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid";
        const user = "(NULLIF(current_setting('telflo.user_id'::text, true), ''::text))::uuid";
        const inOrganization = `(organization_id = ${organization})`;
        const configurationVisible =
          `(${inOrganization} AND ((created_by_user_id = ${user}) OR configuration_is_published(id, organization_id)))`;
        const exists = (table: string) =>
          `(EXISTS ( SELECT 1\n   FROM configurations c\n  WHERE ((c.id = ${table}.configuration_id) AND ` +
          `(c.organization_id = ${table}.organization_id))))`;
        const childVisible = (table: string) => `(${inOrganization} AND ${exists(table)})`;
        const role = "telflo_platform_runtime";

        // Through 1700000000020_publishing: the schema before D11b's draft rules.
        await migrate(21);
        const before = { policies: await policies(), tables: await tableFacts() };
        // Every policy then was the organization alone (migrations 015, 016 and 018).
        expect(
          before.policies.map(({ name, using, check }) => [
            name,
            using ?? check,
            using !== null && check !== null ? check : null,
          ]),
        ).toEqual(
          before.policies.map(({ name, command }) => [name, inOrganization, command === "w" ? inOrganization : null]),
        );
        expect(before.policies).toHaveLength(12);
        expect(await helper()).toEqual([]);
        expect(await check()).toEqual([]);

        const admin = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: configuration.id,
          organizationId: admin.organization.id,
          publishedAt: new Date("2030-01-02T00:00:00.456Z"),
          publishedByUserId: admin.user.id,
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: configuration.id,
          organizationId: admin.organization.id,
          version_number: 2,
        });
        const rows = () =>
          Promise.all([
            throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
            throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          ]);
        const rowsBefore = await rows();

        await migrate(1);
        const present = {
          policies: [
            {
              name: "configuration_version_selections_delete",
              command: "d",
              roles: role,
              using: childVisible("configuration_version_selections"),
              check: null,
              comment: expect.stringContaining("to the selections of configurations the context's user can see"),
            },
            {
              name: "configuration_version_selections_insert",
              command: "a",
              roles: role,
              using: null,
              check: childVisible("configuration_version_selections"),
              comment: expect.stringContaining("records selections only of configurations the"),
            },
            {
              name: "configuration_version_selections_select",
              command: "r",
              roles: role,
              using: childVisible("configuration_version_selections"),
              check: null,
              comment: expect.stringContaining("sees the selections of the configurations the"),
            },
            {
              name: "configuration_version_selections_update",
              command: "w",
              roles: role,
              using: childVisible("configuration_version_selections"),
              check: childVisible("configuration_version_selections"),
              comment: expect.stringContaining("replaces only selections of configurations the"),
            },
            {
              name: "configuration_versions_delete",
              command: "d",
              roles: role,
              using: `(${inOrganization} AND ${exists("configuration_versions")} AND (published_at IS NULL))`,
              check: null,
              comment: expect.stringContaining("Never a published one"),
            },
            {
              name: "configuration_versions_insert",
              command: "a",
              roles: role,
              using: null,
              check:
                `(${inOrganization} AND ${exists("configuration_versions")} AND (published_at IS NULL) AND ` +
                "(publication_id IS NULL) AND (published_by_user_id IS NULL))",
              comment: expect.stringContaining("never inserted already published"),
            },
            {
              name: "configuration_versions_select",
              command: "r",
              roles: role,
              using: childVisible("configuration_versions"),
              check: null,
              comment: expect.stringContaining("sees the versions of the configurations the context's"),
            },
            {
              name: "configuration_versions_update",
              command: "w",
              roles: role,
              using: childVisible("configuration_versions"),
              check: childVisible("configuration_versions"),
              comment: expect.stringContaining("saves only versions of configurations the context's"),
            },
            {
              name: "configurations_delete",
              command: "d",
              roles: role,
              using: configurationVisible,
              check: null,
              comment: expect.stringContaining("to the configurations the context's user can see"),
            },
            {
              name: "configurations_insert",
              command: "a",
              roles: role,
              using: null,
              check: `(${inOrganization} AND (created_by_user_id = ${user}))`,
              comment: expect.stringContaining("only as the context's user"),
            },
            {
              name: "configurations_select",
              command: "r",
              roles: role,
              using: configurationVisible,
              check: null,
              comment: expect.stringContaining("the context's user created or that are published"),
            },
            {
              name: "configurations_update",
              command: "w",
              roles: role,
              using: configurationVisible,
              check: configurationVisible,
              comment: expect.stringContaining("changes only configurations the context's user can"),
            },
          ],
          tables: before.tables,
          helper: [
            {
              arguments: "p_configuration_id uuid, p_organization_id uuid",
              returns: "boolean",
              language: "sql",
              isDefiner: true,
              volatility: "s",
              config: ["search_path=pg_catalog, platform"],
              comment: expect.stringContaining("which holds only while neither table is FORCEd"),
              // The owner keeps its own EXECUTE; PUBLIC has none.
              executors: ["telflo_platform_owner", role].sort(),
              applicationMayRun: true,
            },
          ],
          check: [
            {
              definition: "CHECK (((published_at IS NOT NULL) OR (published_by_user_id IS NULL)))",
              comment: expect.stringContaining("a draft has no publisher"),
            },
          ],
        };
        const installed = async () => ({
          policies: await policies(),
          tables: await tableFacts(),
          helper: await helper(),
          check: await check(),
        });
        expect(await installed()).toEqual(present);
        expect(await rows()).toEqual(rowsBefore);
        // Neither table is FORCEd: the helper depends on it.
        expect(present.tables.map(({ table, force, rls }) => [table, force, rls])).toEqual(
          tables.map((table) => [table, false, true]),
        );

        await migrateDown(1);
        expect(await installed()).toEqual({ ...before, helper: [], check: [] });
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the never-hard-deleted migration makes the configurations and versions delete policies using (false) and adds the author trigger and its function, each with its comment; changes no other policy, no grant and no row; its down puts back migration 021's two policies and comments exactly and drops the trigger and the function; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const tables = ["configuration_version_selections", "configuration_versions", "configurations"];
        /** Every policy on the three tables, with its expressions and comment. */
        const policies = async () => {
          const { rows } = await sql<{
            name: string;
            command: string;
            roles: string;
            using: string | null;
            check: string | null;
            comment: string | null;
          }>`
            select p.polname::text as name, p.polcmd::text as command,
                   array_to_string(array(select r::regrole::text from unnest(p.polroles) r), ',') as roles,
                   pg_get_expr(p.polqual, p.polrelid) as using,
                   pg_get_expr(p.polwithcheck, p.polrelid) as check,
                   obj_description(p.oid, 'pg_policy') as comment
              from pg_policy p
             where p.polrelid::regclass::text in (${sql.join(tables)})
             order by p.polname
          `.execute(throwaway);
          return rows;
        };
        /** The three tables' grants and row-level security flags. */
        const tableFacts = async () => {
          const { rows } = await sql<{ table: string; acl: string[] | null; force: boolean; rls: boolean }>`
            select relname::text as table, relacl::text[] as acl, relforcerowsecurity as force, relrowsecurity as rls
              from pg_class where relname in (${sql.join(tables)}) order by relname
          `.execute(throwaway);
          return rows;
        };
        /** The author trigger's function, from the catalog; empty when it isn't there. */
        const functionFacts = async () => {
          const { rows } = await sql<{
            arguments: string;
            returns: string;
            language: string;
            isDefiner: boolean;
            volatility: string;
            config: string[] | null;
            comment: string | null;
          }>`
            select pg_get_function_identity_arguments(p.oid) as arguments, p.prorettype::regtype::text as returns,
                   l.lanname::text as language, p.prosecdef as "isDefiner", p.provolatile as volatility,
                   p.proconfig as config, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p join pg_language l on l.oid = p.prolang
             where p.proname = 'refuse_configuration_author_change'
          `.execute(throwaway);
          return rows;
        };
        /** Every trigger on configurations but the internal ones (the foreign keys'). */
        const triggerFacts = async () => {
          const { rows } = await sql<{ name: string; definition: string; enabled: string; comment: string | null }>`
            select tgname::text as name, pg_get_triggerdef(oid) as definition, tgenabled::text as enabled,
                   obj_description(oid, 'pg_trigger') as comment
              from pg_trigger
             where tgrelid = to_regclass('configurations') and not tgisinternal
             order by tgname
          `.execute(throwaway);
          return rows;
        };
        const installed = async () => ({
          policies: await policies(),
          tables: await tableFacts(),
          functions: await functionFacts(),
          triggers: await triggerFacts(),
        });

        const organization = "(NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid";
        const user = "(NULLIF(current_setting('telflo.user_id'::text, true), ''::text))::uuid";
        const inOrganization = `(organization_id = ${organization})`;
        const configurationVisible =
          `(${inOrganization} AND ((created_by_user_id = ${user}) OR configuration_is_published(id, organization_id)))`;
        const exists =
          "(EXISTS ( SELECT 1\n   FROM configurations c\n  WHERE ((c.id = configuration_versions.configuration_id) AND " +
          "(c.organization_id = configuration_versions.organization_id))))";

        // Through 1700000000021_drafts_private.
        await migrate(22);
        const before = await installed();
        const byName = (facts: Awaited<ReturnType<typeof policies>>, name: string) =>
          facts.find((policy) => policy.name === name);
        // Migration 021's two delete policies, as that migration's test expects them.
        expect(byName(before.policies, "configurations_delete")).toMatchObject({
          using: configurationVisible,
          comment: expect.stringContaining("to the configurations the context's user can see"),
        });
        expect(byName(before.policies, "configuration_versions_delete")).toMatchObject({
          using: `(${inOrganization} AND ${exists} AND (published_at IS NULL))`,
          comment: expect.stringContaining("Never a published one"),
        });
        expect(before.policies).toHaveLength(12);
        expect(before.functions).toEqual([]);
        expect(before.triggers).toEqual([]);

        const admin = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: configuration.id,
          organizationId: admin.organization.id,
          yaml_content: "receivers: {}\n",
          publishedAt: new Date("2030-01-02T00:00:00.456Z"),
          publishedByUserId: admin.user.id,
        });
        await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: configuration.id,
          organizationId: admin.organization.id,
          version_number: 2,
          created_by_user_id: admin.user.id,
        });
        await addConfiguration(throwaway, { organizationId: admin.organization.id, collector: false });
        const rows = () =>
          Promise.all([
            throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
            throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          ]);
        const rowsBefore = await rows();

        await migrate(1);
        const changed = new Map([
          [
            "configuration_versions_delete",
            { using: "false", comment: expect.stringContaining("the API's role deletes no version (D11b Ruling 29)") },
          ],
          [
            "configurations_delete",
            {
              using: "false",
              comment: expect.stringContaining("the API's role deletes no configuration (D11b Ruling 29)"),
            },
          ],
        ]);
        const present = {
          // Every other policy as migration 021 left it.
          policies: before.policies.map((policy) => ({ ...policy, ...changed.get(policy.name) })),
          tables: before.tables,
          functions: [
            {
              arguments: "",
              returns: "trigger",
              language: "plpgsql",
              isDefiner: false,
              volatility: "v",
              config: ["search_path=platform, pg_temp"],
              comment: expect.stringContaining("a configuration keeps its author (D11b Ruling 29)"),
            },
          ],
          triggers: [
            {
              name: "configurations_author_unchanged",
              definition:
                "CREATE TRIGGER configurations_author_unchanged BEFORE UPDATE ON platform.configurations " +
                "FOR EACH ROW EXECUTE FUNCTION refuse_configuration_author_change()",
              enabled: "O",
              comment: expect.stringContaining("triggers have no owner exemption"),
            },
          ],
        };
        expect(await installed()).toEqual(present);
        // The selections' delete policy is migration 021's still.
        expect(byName(present.policies, "configuration_version_selections_delete")!.using).not.toBe("false");
        expect(await rows()).toEqual(rowsBefore);
        // Installed and firing, for the owner too: the authorless
        // configuration can't be given an author.
        await expect(
          throwaway
            .updateTable("configurations")
            .set({ created_by_user_id: admin.user.id })
            .where("created_by_user_id", "is", null)
            .execute(),
        ).rejects.toMatchObject({ code: "P0001" });

        await migrateDown(1);
        expect(await installed()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await installed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the collector catalogue migration makes every existing configuration Contrib and every version 0.162.0, published ones otherwise untouched; adds the two global tables (SELECT only for the API's role, no row-level security) holding Contrib and 0.162.0, no column default, the composite keys, the distribution's lock and the guarded pin; its down puts back migration 020's function and comment exactly and drops the rest; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Migration 020's guard function as the catalog holds it: its body, comment and settings. */
        const guard = async () =>
          (
            await sql<{ source: string; comment: string | null; config: string[] | null; isDefiner: boolean }>`
              select p.prosrc as source, obj_description(p.oid, 'pg_proc') as comment, p.proconfig as config,
                     p.prosecdef as "isDefiner"
                from pg_proc p where p.proname = 'refuse_published_configuration_version_change'
            `.execute(throwaway)
          ).rows;
        /** What migration 023 adds, by name, from the catalog; empty when it isn't there. */
        const added = async () =>
          (
            await sql<{ object: string }>`
              select 'table ' || relname as object from pg_class
               where relname in ('collector_distributions', 'collector_versions') and relkind = 'r'
              union all
              select 'column ' || table_name || '.' || column_name || ' ' || is_nullable || ' ' ||
                     coalesce(column_default, 'no default')
                from information_schema.columns
               where table_schema = 'platform' and table_name in ('configurations', 'configuration_versions')
                 and column_name like 'collector%'
              union all
              select 'constraint ' || conname from pg_constraint
               where conname in ('fk_configurations_collector_distribution',
                                 'uq_configurations_id_collector_distribution',
                                 'fk_configuration_versions_configuration_distribution',
                                 'fk_configuration_versions_collector_version')
              union all
              select 'trigger ' || tgname from pg_trigger where tgname = 'configurations_collector_distribution_unchanged'
              union all
              select 'function ' || proname from pg_proc where proname = 'refuse_configuration_distribution_change'
              order by 1
            `.execute(throwaway)
          ).rows.map((row) => row.object);
        const rows = async () => ({
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
        });

        // Through 1700000000022_configurations_never_hard_deleted.
        await migrate(23);
        const guardBefore = await guard();
        expect(guardBefore).toEqual([
          {
            source: expect.not.stringContaining("collector"),
            comment: expect.stringContaining("the immutability of published versions"),
            config: ["search_path=platform, pg_temp"],
            isDefiner: false,
          },
        ]);
        expect(await added()).toEqual([]);

        const admin = await createUserWithOrganization(throwaway);
        const live = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
        });
        const deleted = await addConfiguration(throwaway, {
          collector: false,
          organizationId: admin.organization.id,
          created_by_user_id: admin.user.id,
          deleted_at: new Date("2030-02-01T00:00:00.000Z"),
        });
        const published = await addConfigurationVersion(throwaway, {
          collector: false,
          configurationId: live.id,
          organizationId: admin.organization.id,
          yaml_content: "receivers: {}\n",
          label: "Shipped",
          nodes: JSON.stringify([{ id: "n" }]),
          created_by_user_id: admin.user.id,
          publishedAt: new Date("2030-01-02T00:00:00.456Z"),
          publishedByUserId: admin.user.id,
        });
        for (const [configurationId, version_number] of [
          [live.id, 2],
          [deleted.id, 1],
        ] as const) {
          await addConfigurationVersion(throwaway, {
            collector: false,
            configurationId,
            organizationId: admin.organization.id,
            version_number,
            yaml_content: `v${version_number}`,
          });
        }
        const before = await rows();
        expect(before.versions).toHaveLength(3);
        expect(Object.keys(before.configurations[0]!)).not.toContain("collector_distribution");

        const contrib = { collector_distribution: "otelcol-contrib" };
        const backfilled = {
          configurations: before.configurations.map((row) => ({ ...row, ...contrib })),
          versions: before.versions.map((row) => ({ ...row, ...contrib, collector_version: "0.162.0" })),
        };
        const present = [
          "column configuration_versions.collector_distribution NO no default",
          "column configuration_versions.collector_version NO no default",
          "column configurations.collector_distribution NO no default",
          "constraint fk_configuration_versions_collector_version",
          "constraint fk_configuration_versions_configuration_distribution",
          "constraint fk_configurations_collector_distribution",
          "constraint uq_configurations_id_collector_distribution",
          "function refuse_configuration_distribution_change",
          "table collector_distributions",
          "table collector_versions",
          "trigger configurations_collector_distribution_unchanged",
        ];

        await migrate(1);
        // Every configuration Contrib, every version 0.162.0, the published one included and otherwise untouched.
        expect(await rows()).toEqual(backfilled);
        expect(await added()).toEqual(present);
        expect(await throwaway.selectFrom("collector_distributions").selectAll().execute()).toEqual([
          {
            id: "otelcol-contrib",
            label: "OpenTelemetry Collector Contrib",
            description: expect.stringContaining("The full upstream component catalog."),
            icon: "otel",
            sort_order: 0,
            is_default: true,
          },
        ]);
        const versions = await throwaway.selectFrom("collector_versions").selectAll().execute();
        expect(versions).toEqual([
          expect.objectContaining({
            distribution: "otelcol-contrib",
            version: "0.162.0",
            label: "v0.162.0",
            released_at: "2026-09-29",
            is_default: true,
            deprecated: false,
            container_image: "otel/opentelemetry-collector-contrib:0.162.0",
            supported_components: null,
          }),
        ]);
        expect(Object.keys(versions[0]!.otelcol_contrib).sort()).toEqual(
          ["darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64", "windows_amd64"],
        );
        // SELECT only for the API's role, and no row-level security.
        const { rows: privileges } = await sql<{ table: string; privilege: string }>`
          select t as table, p as privilege
            from unnest(array['collector_distributions', 'collector_versions']) as t,
                 unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p
           where has_table_privilege('telflo_platform_runtime', 'platform.' || t, p)
           order by t, p
        `.execute(throwaway);
        expect(privileges).toEqual([
          { table: "collector_distributions", privilege: "SELECT" },
          { table: "collector_versions", privilege: "SELECT" },
        ]);
        const { rows: security } = await sql<{ rls: boolean }>`
          select relrowsecurity as rls from pg_class where relname in ('collector_distributions', 'collector_versions')
        `.execute(throwaway);
        expect(security).toEqual([{ rls: false }, { rls: false }]);
        // The guard now covers the pin, and both triggers fire for the owner.
        expect(await guard()).toEqual([
          {
            source: expect.stringContaining("new.collector_version is distinct from old.collector_version"),
            comment: expect.stringContaining("its collector pin included"),
            config: ["search_path=platform, pg_temp"],
            isDefiner: false,
          },
        ]);
        // A version the catalogue here lacks: the before trigger's P0001 comes before the foreign key's 23503.
        await expect(
          sql`update configuration_versions set collector_version = '0.161.0' where id = ${published.id}`.execute(
            throwaway,
          ),
        ).rejects.toMatchObject({ code: "P0001", message: `configuration version ${published.id} is published and can't be changed` });
        await expect(
          sql`update configurations set collector_distribution = 'another' where id = ${live.id}`.execute(throwaway),
        ).rejects.toMatchObject({ code: "P0001", message: `configuration ${live.id} keeps its collector distribution` });

        await migrateDown(1);
        // Migration 020's function, body, comment and settings, exactly.
        expect(await guard()).toEqual(guardBefore);
        expect(await added()).toEqual([]);
        expect(await rows()).toEqual(before);

        await migrate(1);
        expect(await rows()).toEqual(backfilled);
        expect(await added()).toEqual(present);
        expect((await guard())[0]!.source).toContain("new.collector_distribution is distinct from old.collector_distribution");
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the distribution key's index migration indexes configuration_versions (configuration_id, collector_distribution), the columns of migration 023's cascading foreign key in its order, for every row, with a comment; its down drops it; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const indexed = async () =>
          (
            await sql<{
              name: string;
              columns: string[];
              isUnique: boolean;
              predicate: string | null;
              comment: string | null;
            }>`
              select i.indexrelid::regclass::text as name,
                     array(select a.attname::text
                             from unnest(i.indkey) with ordinality as k(attnum, position)
                             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                            order by k.position) as columns,
                     i.indisunique as "isUnique", pg_get_expr(i.indpred, i.indrelid) as predicate,
                     obj_description(i.indexrelid, 'pg_class') as comment
                from pg_index i
               where i.indrelid = to_regclass('configuration_versions')
                 and i.indexrelid::regclass::text = 'idx_configuration_versions_configuration_distribution'
            `.execute(throwaway)
          ).rows;
        /** The foreign key's columns, in its order: what the index must lead with. */
        const foreignKeyColumns = async () =>
          (
            await sql<{ columns: string[] }>`
              select array(select a.attname::text
                             from unnest(con.conkey) with ordinality as k(attnum, position)
                             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                            order by k.position) as columns
                from pg_constraint con
               where con.conname = 'fk_configuration_versions_configuration_distribution'
            `.execute(throwaway)
          ).rows[0]!.columns;
        const viaPgIndexes = async () =>
          (
            await sql<{ definition: string }>`
              select indexdef as definition from pg_indexes
               where tablename = 'configuration_versions'
                 and indexname = 'idx_configuration_versions_configuration_distribution'
            `.execute(throwaway)
          ).rows.map((row) => row.definition);
        const present = [
          {
            name: "idx_configuration_versions_configuration_distribution",
            columns: ["configuration_id", "collector_distribution"],
            isUnique: false,
            predicate: null,
            comment: expect.stringContaining("fk_configuration_versions_configuration_distribution"),
          },
        ];

        // Through 1700000000023_collector_catalogue.
        await migrate(24);
        expect(await indexed()).toEqual([]);
        expect(await foreignKeyColumns()).toEqual(["configuration_id", "collector_distribution"]);

        await migrate(1);
        expect(await indexed()).toEqual(present);
        expect(await viaPgIndexes()).toEqual([
          "CREATE INDEX idx_configuration_versions_configuration_distribution ON platform.configuration_versions USING btree (configuration_id, collector_distribution)",
        ]);
        expect((await indexed())[0]!.columns).toEqual(await foreignKeyColumns());

        await migrateDown(1);
        expect(await indexed()).toEqual([]);
        // Only the index: migration 023's foreign key stays.
        expect(await foreignKeyColumns()).toEqual(["configuration_id", "collector_distribution"]);

        await migrate(1);
        expect(await indexed()).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the renamed-types migration adds collector_distributions.renamed_types, jsonb not null default '[]', every existing row []; its array check refuses anything but a list; each with a comment; its down drops both; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        const column = async () =>
          (
            await sql<{ type: string; notNull: boolean; default: string | null; comment: string | null }>`
              select format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                     pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
                from pg_attribute a
                left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
               where a.attrelid = to_regclass('collector_distributions') and a.attname = 'renamed_types'
                 and not a.attisdropped
            `.execute(throwaway)
          ).rows;
        const check = async () =>
          (
            await sql<{ definition: string; comment: string | null }>`
              select pg_get_constraintdef(oid) as definition, obj_description(oid, 'pg_constraint') as comment
                from pg_constraint where conname = 'ck_collector_distributions_renamed_types_array'
            `.execute(throwaway)
          ).rows;
        const present = {
          column: [
            {
              type: "jsonb",
              notNull: true,
              default: "'[]'::jsonb",
              comment: expect.stringContaining("the collector's renames (D13b decision 6)"),
            },
          ],
          check: [
            {
              definition: "CHECK ((jsonb_typeof(renamed_types) = 'array'::text))",
              comment: expect.stringContaining("renamed_types is a list"),
            },
          ],
        };

        // Through 1700000000024: migration 023's Contrib row, and a fixture distribution.
        await migrate(25);
        await sql`
          insert into collector_distributions (id, label, description, icon, sort_order, is_default)
          values ('fixture-build', 'Fixture Build', null, null, 1, false)
        `.execute(throwaway);
        expect(await column()).toEqual([]);

        await migrate(1);
        expect({ column: await column(), check: await check() }).toEqual(present);
        expect(
          (await sql<{ id: string; renamed: unknown }>`
            select id, renamed_types as renamed from collector_distributions order by id
          `.execute(throwaway)).rows,
        ).toEqual([
          { id: "fixture-build", renamed: [] },
          { id: "otelcol-contrib", renamed: [] },
        ]);
        // An object, a string and jsonb's null: none is a list.
        for (const value of [`{}`, `"file_log"`, `null`]) {
          await expect(
            sql`update collector_distributions set renamed_types = ${value}::jsonb where id = 'fixture-build'`.execute(
              throwaway,
            ),
          ).rejects.toMatchObject({ code: "23514" });
        }
        await expect(
          sql`update collector_distributions set renamed_types = null where id = 'fixture-build'`.execute(throwaway),
        ).rejects.toMatchObject({ code: "23502" });
        await sql`
          update collector_distributions
             set renamed_types = '[{"kind": "receiver", "name": "file_log", "deprecatedName": "filelog", "since": "0.149.0"}]'
           where id = 'fixture-build'
        `.execute(throwaway);

        await migrateDown(1);
        expect({ column: await column(), check: await check() }).toEqual({ column: [], check: [] });

        await migrate(1);
        expect({ column: await column(), check: await check() }).toEqual(present);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the flows migration adds the global flows table (no row-level security, the API's role's four privileges by default) with its columns, defaults, checks, foreign key and index, users.is_product_admin false for every existing user with its owner-only trigger and function, configurations.source_flow_slug null for every existing configuration, each with its comment, and the 13 seeded flows; changes no other row; its down drops exactly those; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Every column of flows, users.is_product_admin and configurations.source_flow_slug. */
        const columns = async () =>
          (
            await sql<{
              column: string;
              type: string;
              notNull: boolean;
              default: string | null;
              comment: string | null;
            }>`
              select a.attrelid::regclass::text || '.' || a.attname as column,
                     format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                     pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
                from pg_attribute a
                left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
               where a.attnum > 0 and not a.attisdropped
                 and (a.attrelid = to_regclass('flows')
                      or (a.attrelid = to_regclass('users') and a.attname = 'is_product_admin')
                      or (a.attrelid = to_regclass('configurations') and a.attname = 'source_flow_slug'))
               order by a.attrelid::regclass::text, a.attnum
            `.execute(throwaway)
          ).rows;
        /** The flows table's constraints but its not-null ones, and its indexes backing none. */
        const constraints = async () =>
          (
            await sql<{ name: string; definition: string; comment: string | null }>`
              select conname::text as name, pg_get_constraintdef(oid) as definition,
                     obj_description(oid, 'pg_constraint') as comment
                from pg_constraint where conrelid = to_regclass('flows') and contype <> 'n'
              union all
              select i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid),
                     obj_description(i.indexrelid, 'pg_class')
                from pg_index i
               where i.indrelid = to_regclass('flows')
                 and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
               order by 1
            `.execute(throwaway)
          ).rows;
        /** The flows table's row-level security flags, grants and comment; empty when it isn't there. */
        const table = async () =>
          (
            await sql<{ rls: boolean; force: boolean; acl: string[] | null; comment: string | null }>`
              select relrowsecurity as rls, relforcerowsecurity as force, relacl::text[] as acl,
                     obj_description(oid, 'pg_class') as comment
                from pg_class where oid = to_regclass('flows')
            `.execute(throwaway)
          ).rows;
        /** The flag's trigger function, from the catalog; empty when it isn't there. */
        const functions = async () =>
          (
            await sql<{
              returns: string;
              language: string;
              isDefiner: boolean;
              config: string[] | null;
              comment: string | null;
            }>`
              select p.prorettype::regtype::text as returns, l.lanname::text as language, p.prosecdef as "isDefiner",
                     p.proconfig as config, obj_description(p.oid, 'pg_proc') as comment
                from pg_proc p join pg_language l on l.oid = p.prolang
               where p.proname = 'refuse_product_admin_change'
            `.execute(throwaway)
          ).rows;
        /** Every trigger on users but the internal ones (the foreign keys'). */
        const triggers = async () =>
          (
            await sql<{ name: string; definition: string; enabled: string; comment: string | null }>`
              select tgname::text as name, pg_get_triggerdef(oid) as definition, tgenabled::text as enabled,
                     obj_description(oid, 'pg_trigger') as comment
                from pg_trigger where tgrelid = to_regclass('users') and not tgisinternal order by tgname
            `.execute(throwaway)
          ).rows;
        const installed = async () => ({
          columns: await columns(),
          constraints: await constraints(),
          table: await table(),
          functions: await functions(),
          triggers: await triggers(),
        });
        const commented = (text: string) => expect.stringContaining(text);
        const flowColumn = (
          name: string,
          type: string,
          notNull: boolean,
          defaultValue: string | null,
          comment: string,
        ) => ({ column: `flows.${name}`, type, notNull, default: defaultValue, comment: commented(comment) });
        const present = {
          columns: [
            {
              column: "configurations.source_flow_slug",
              type: "text",
              notNull: false,
              default: null,
              comment: commented("the slug of the flow the configuration was created from"),
            },
            flowColumn("id", "uuid", true, "uuidv7()", "which the admin's writes address"),
            flowColumn("slug", "text", true, null, "the public URL segment"),
            flowColumn("name", "text", true, null, "the flow's title"),
            flowColumn("summary", "text", true, null, "the one-line card copy"),
            flowColumn("description", "text", true, null, "the flow page's long text"),
            flowColumn("source", "text", true, null, "telflo, authored by product admins"),
            flowColumn("author_name", "text", false, null, "who the flow credits"),
            flowColumn("author_url", "text", false, null, "a link for the author"),
            flowColumn("signals", "text[]", true, "'{}'::text[]", "the telemetry signals it handles"),
            flowColumn("tags", "text[]", true, "'{}'::text[]", "its categories"),
            flowColumn("yaml_content", "text", true, null, "copied byte for byte (D12 decision 5)"),
            flowColumn("collector_distribution", "text", true, null, "No default: the API always writes it."),
            flowColumn("collector_version", "text", true, null, "key: the API refuses"),
            flowColumn("source_url", "text", false, null, "an http(s) link"),
            flowColumn("published", "boolean", true, "true", "false hides the flow"),
            flowColumn("sort_order", "integer", true, "0", "the gallery's order"),
            flowColumn("created_at", "timestamp with time zone", true, null, "never now()"),
            flowColumn("updated_at", "timestamp with time zone", true, null, "sitemap's lastmod"),
            {
              column: "users.is_product_admin",
              type: "boolean",
              notNull: true,
              default: "false",
              comment: commented("a product admin (D12 decision 3)"),
            },
          ],
          constraints: [
            {
              name: "ck_flows_collector_version_present",
              definition: "CHECK ((btrim(collector_version) <> ''::text))",
              comment: commented("a blank pin"),
            },
            {
              name: "ck_flows_slug_format",
              definition: "CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))",
              comment: commented("lowercase letters and digits"),
            },
            {
              name: "ck_flows_slug_length",
              definition: "CHECK ((char_length(slug) <= 80))",
              comment: commented("at most 80 characters (D12 Preflight ruling 19)"),
            },
            {
              name: "ck_flows_source",
              definition: "CHECK ((source = ANY (ARRAY['telflo'::text, 'community'::text])))",
              comment: commented("telflo or community"),
            },
            {
              name: "ck_flows_source_url_scheme",
              definition: "CHECK (((source_url IS NULL) OR (source_url ~ '^https?://'::text)))",
              comment: commented("stored XSS"),
            },
            {
              name: "fk_flows_collector_distribution",
              definition: "FOREIGN KEY (collector_distribution) REFERENCES collector_distributions(id)",
              comment: commented("a distribution of the catalogue (23503 otherwise)"),
            },
            { name: "flows_pkey", definition: "PRIMARY KEY (id)", comment: commented("one row per flow") },
            {
              name: "idx_flows_sort_order_name",
              definition: "CREATE INDEX idx_flows_sort_order_name ON platform.flows USING btree (sort_order, name)",
              comment: commented("the gallery's order"),
            },
            { name: "uq_flows_slug", definition: "UNIQUE (slug)", comment: commented("a slug names one flow") },
          ],
          table: [
            {
              rls: false,
              force: false,
              acl: expect.arrayContaining([expect.stringMatching(/^telflo_platform_runtime=arwd\//)]),
              comment: commented("Global (ADR 0008): no organization column, no row-level security."),
            },
          ],
          functions: [
            {
              returns: "trigger",
              language: "plpgsql",
              isDefiner: false,
              config: ["search_path=platform, pg_temp"],
              comment: commented("only the tables' owner grants or revokes product admin"),
            },
          ],
          triggers: [
            {
              name: "users_product_admin_owner_only",
              definition:
                "CREATE TRIGGER users_product_admin_owner_only BEFORE INSERT OR UPDATE ON platform.users " +
                "FOR EACH ROW EXECUTE FUNCTION refuse_product_admin_change()",
              enabled: "O",
              comment: commented("is refused any change of is_product_admin"),
            },
          ],
        };

        // Through 1700000000025_collector_renamed_types, with a user, a
        // configuration and its version already there.
        await migrate(26);
        const before = await installed();
        // The membership invariant's two triggers on users, and nothing of this migration's.
        expect(before).toEqual({
          columns: [],
          constraints: [],
          table: [],
          functions: [],
          triggers: [
            expect.objectContaining({ name: "users_require_membership" }),
            expect.objectContaining({ name: "users_restored_require_membership" }),
          ],
        });
        present.triggers = [...before.triggers, ...present.triggers].sort((a, b) => a.name.localeCompare(b.name));
        const ana = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          organizationId: ana.organization.id,
          created_by_user_id: ana.user.id,
        });
        await addConfigurationVersion(throwaway, {
          configurationId: configuration.id,
          organizationId: ana.organization.id,
          yaml_content: "receivers: {}\n",
        });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          distributions: await throwaway.selectFrom("collector_distributions").selectAll().orderBy("id").execute(),
        });
        const rowsBefore = await rows();
        const seeded = async () =>
          (
            await sql<{ slug: string; version: string }>`
              select slug, collector_version as version from flows order by sort_order, name
            `.execute(throwaway)
          ).rows;

        await migrate(1);
        expect(await installed()).toEqual(present);
        expect(await rows()).toEqual({
          ...rowsBefore,
          users: rowsBefore.users.map((user) => ({ ...user, is_product_admin: false })),
          configurations: rowsBefore.configurations.map((row) => ({ ...row, source_flow_slug: null })),
        });
        const seededAfterUp = await seeded();
        expect(seededAfterUp).toHaveLength(13);

        await migrateDown(1);
        expect(await installed()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await installed()).toEqual(present);
        expect(await seeded()).toEqual(seededAfterUp);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the flows-signals migration adds ck_flows_signals (traces, metrics and logs, each at most once, or none) with its comment, the 13 seeded flows passing it; changes no row; up refuses a database holding a stray signal and changes nothing; its down drops exactly the check; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** The flows table's check constraints and their comments, by name. */
        const checks = async () =>
          (
            await sql<{ name: string; definition: string; comment: string | null }>`
              select conname::text as name, pg_get_constraintdef(oid) as definition,
                     obj_description(oid, 'pg_constraint') as comment
                from pg_constraint where conrelid = to_regclass('flows') and contype = 'c'
               order by conname
            `.execute(throwaway)
          ).rows;
        const signalsCheck = {
          name: "ck_flows_signals",
          definition:
            "CHECK (\nCASE\n    WHEN (array_ndims(signals) > 1) THEN false\n    ELSE ((signals <@ ARRAY['traces'::text, 'metrics'::text, 'logs'::text]) " +
            "AND (cardinality(array_positions(signals, 'traces'::text)) <= 1) " +
            "AND (cardinality(array_positions(signals, 'metrics'::text)) <= 1) " +
            "AND (cardinality(array_positions(signals, 'logs'::text)) <= 1))\nEND)",
          comment: expect.stringContaining("the contract's signals (D12 Ruling 37, FlowSignalsSchema)"),
        };
        const flows = async () => throwaway.selectFrom("flows").selectAll().orderBy("slug").execute();
        /** Inserts a flow with `signals` (a text[] literal). */
        const addFlow = (slug: string, signals: string) =>
          sql`
            insert into flows (slug, name, summary, description, source, signals, yaml_content,
                               collector_distribution, collector_version, created_at, updated_at)
            values (${slug}, 'A Flow', 'Does one thing.', 'Does one thing, well.', 'telflo', ${signals}::text[],
                    'receivers: {}\n', 'otelcol-contrib', '0.162.0', now(), now())
          `.execute(throwaway);

        // Through 1700000000026_flows: its 13 seeded flows, and one an admin wrote with every signal.
        await migrate(27);
        await addFlow("every-signal", "{logs,metrics,traces}");
        const before = await checks();
        expect(before.map((check) => check.name)).not.toContain("ck_flows_signals");
        const flowsBefore = await flows();
        expect(flowsBefore).toHaveLength(14);

        await migrate(1);
        const present = [...before, signalsCheck].sort((a, b) => a.name.localeCompare(b.name));
        expect(await checks()).toEqual(present);
        expect(await flows()).toEqual(flowsBefore);
        await expect(addFlow("a-stray-signal", "{traces,profiles}")).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_flows_signals",
        });

        await migrateDown(1);
        expect(await checks()).toEqual(before);
        expect(await flows()).toEqual(flowsBefore);
        // Without the check, the stray value goes in, and up then refuses the database, changing nothing.
        await addFlow("a-stray-signal", "{traces,profiles}");
        await expect(migrate(1)).rejects.toThrow('check constraint "ck_flows_signals" of relation "flows" is violated by some row');
        expect(await checks()).toEqual(before);
        await sql`delete from flows where slug = 'a-stray-signal'`.execute(throwaway);

        await migrate(1);
        expect(await checks()).toEqual(present);
        expect(await flows()).toEqual(flowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the test runs migration adds test_input_files and test_runs (row-level security, their policies, checks, foreign keys and indexes), the run guard trigger, the tester's one-row state (SELECT only for the API's role), the dispatcher's SECURITY DEFINER functions (EXECUTE for telflo_platform_runtime only, a fixed search_path) and the two member functions, each with its comment; changes no existing object or row; its down drops exactly those; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /**
         * Everything in the platform schema a migration can add or change: every
         * relation (its kind, row-level security, grants and comment), column,
         * constraint, index, policy, function (its signature, security, search
         * path, grants, source and comment), trigger, and the default
         * privileges.
         */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `after` holds that `before` doesn't, by section, parsed back. */
        const added = (before: Catalog, after: Catalog) =>
          Object.fromEntries(
            Object.entries(after).map(([section, items]) => [
              section,
              items
                .filter((item) => !before[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[], key = "name") => items.map((item) => String(item[key])).sort();

        // Through 1700000000027_flows_signals_check, with a member, a
        // configuration and its version already there.
        await migrate(28);
        const before = await catalog();
        const ana = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          organizationId: ana.organization.id,
          created_by_user_id: ana.user.id,
        });
        await addConfigurationVersion(throwaway, {
          configurationId: configuration.id,
          organizationId: ana.organization.id,
          yaml_content: "receivers: {}\n",
        });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed: every earlier object reads the same.
        for (const [section, items] of Object.entries(before)) {
          expect({ section, missing: items.filter((item) => !after[section as keyof Catalog].includes(item)) }).toEqual({
            section,
            missing: [],
          });
        }
        expect(await rows()).toEqual(rowsBefore);

        const add = added(before, after);
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.relations.map(({ name, kind, rls, force }) => ({ name, kind, rls, force }))).toEqual(
          expect.arrayContaining([
            { name: "test_input_files", kind: "r", rls: true, force: false },
            { name: "test_runs", kind: "r", rls: true, force: false },
            { name: "otelcol_testing_state", kind: "r", rls: false, force: false },
          ]),
        );
        expect(names(add.relations.filter((relation) => relation.kind === "r"))).toEqual([
          "otelcol_testing_state",
          "test_input_files",
          "test_runs",
        ]);
        expect(names(add.indexes)).toEqual([
          "idx_test_input_files_organization_owner_created_at",
          "idx_test_input_files_owner_user_id",
          "idx_test_runs_configuration_version_queued_at",
          "idx_test_runs_organization_configuration",
          "idx_test_runs_queued",
          "idx_test_runs_queued_by_user_queued_at",
          "idx_test_runs_running",
          "otelcol_testing_state_pkey",
          "test_input_files_pkey",
          "test_runs_pkey",
        ]);
        expect(add.indexes).toEqual(
          expect.arrayContaining([
            {
              name: "idx_test_runs_queued",
              definition:
                "CREATE INDEX idx_test_runs_queued ON platform.test_runs USING btree (queued_at, id) WHERE (status = 'queued'::text)",
            },
            {
              name: "idx_test_runs_running",
              definition:
                "CREATE INDEX idx_test_runs_running ON platform.test_runs USING btree (lease_expires_at) WHERE (status = 'running'::text)",
            },
          ]),
        );
        // Every new table, index (but one backing a constraint, whose comment is the constraint's), column,
        // constraint (but a not-null one), policy, function and trigger is commented.
        const constraintNames = names(add.constraints);
        const uncommented = [
          ...add.relations.filter((relation) => !constraintNames.includes(String(relation.name))),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
          ...add.policies,
          ...add.functions,
          ...add.triggers,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        expect(
          names(add.constraints.filter((constraint) => constraint.type !== "n" && constraint.relation === "test_runs")),
        ).toEqual([
          "ck_test_runs_decoded_input_size_bytes",
          "ck_test_runs_decoded_input_truncated",
          "ck_test_runs_duration_seconds",
          "ck_test_runs_error_code_format",
          "ck_test_runs_input_name_length",
          "ck_test_runs_input_size_bytes",
          "ck_test_runs_logs_length",
          "ck_test_runs_output_size_bytes",
          "ck_test_runs_output_truncated",
          "ck_test_runs_result_shapes",
          "ck_test_runs_results_only_when_finished",
          "ck_test_runs_signal",
          "ck_test_runs_state",
          "ck_test_runs_status",
          "ck_test_runs_strategy_length",
          "ck_test_runs_target_pipeline_length",
          "ck_test_runs_times_ordered",
          "ck_test_runs_yaml_length",
          "fk_test_runs_collector_version",
          "fk_test_runs_configuration",
          "fk_test_runs_configuration_distribution",
          "fk_test_runs_configuration_version",
          "test_runs_organization_id_fkey",
          "test_runs_pkey",
          "test_runs_queued_by_user_id_fkey",
        ]);
        expect(add.constraints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "fk_test_runs_configuration_version",
              definition:
                "FOREIGN KEY (configuration_version_id, configuration_id, organization_id) " +
                "REFERENCES configuration_versions(id, configuration_id, organization_id)",
            }),
            expect.objectContaining({
              name: "test_runs_queued_by_user_id_fkey",
              definition: "FOREIGN KEY (queued_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
            }),
            expect.objectContaining({
              name: "test_input_files_owner_user_id_fkey",
              definition: "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
            }),
          ]),
        );

        // The policies: runs follow their configuration's visibility, files their owner; no update or delete of a run.
        const policy = (name: string) => add.policies.find((item) => item.name === name)!;
        expect(names(add.policies)).toEqual([
          "test_input_files_delete",
          "test_input_files_insert",
          "test_input_files_select",
          "test_input_files_update",
          "test_runs_delete",
          "test_runs_insert",
          "test_runs_select",
          "test_runs_update",
        ]);
        for (const item of add.policies) expect(item.roles).toEqual(["telflo_platform_runtime"]);
        expect(policy("test_runs_select").qual).toMatch(/EXISTS \( SELECT 1\s+FROM configurations c/);
        expect(policy("test_runs_insert").withCheck).toMatch(/EXISTS \( SELECT 1\s+FROM configurations c/);
        expect(policy("test_runs_insert").withCheck).toMatch(/queued_at = now\(\)/);
        expect(policy("test_runs_insert").withCheck).toMatch(/status = 'queued'::text/);
        expect(policy("test_runs_update")).toMatchObject({ cmd: "UPDATE", qual: "false" });
        expect(policy("test_runs_delete")).toMatchObject({ cmd: "DELETE", qual: "false" });
        expect(policy("test_input_files_update")).toMatchObject({ cmd: "UPDATE", qual: "false" });
        expect(policy("test_input_files_select").qual).toMatch(/owner_user_id = \(NULLIF\(current_setting\('telflo\.user_id'/);

        // The functions: the dispatcher's and the members', definer with a fixed path and EXECUTE for the API's role only.
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        const definer = [
          "otelcol_testing_mark(boolean)",
          "test_runs_ahead(uuid[])",
          "test_runs_claim(integer,integer)",
          "test_runs_fail_waiting(interval,text)",
          "test_runs_finish(uuid,uuid,boolean,jsonb)",
          "test_runs_reap(text)",
          "test_runs_release(uuid,uuid)",
          "test_runs_waiting_for_context_user()",
        ];
        expect(names(add.functions, "signature")).toEqual(
          [...definer, "refuse_test_run_change()", "test_runs_require_dispatcher()"].sort(),
        );
        for (const signature of definer) {
          expect(add.functions.find((item) => item.signature === signature)).toMatchObject({
            isDefiner: true,
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
          });
        }
        expect(add.functions.find((item) => item.signature === "test_runs_require_dispatcher()")).toMatchObject({
          isDefiner: false,
          config: ["search_path=pg_catalog, platform"],
          acl: [`${owner}=X/${owner}`],
        });
        expect(add.functions.find((item) => item.signature === "refuse_test_run_change()")).toMatchObject({
          isDefiner: false,
          config: ["search_path=pg_catalog, platform"],
        });
        expect(add.triggers).toEqual([
          {
            relation: "test_runs",
            name: "test_runs_guard",
            definition:
              "CREATE TRIGGER test_runs_guard BEFORE UPDATE ON platform.test_runs FOR EACH ROW EXECUTE FUNCTION refuse_test_run_change()",
            enabled: "O",
            comment: expect.stringContaining("for every role"),
          },
        ]);

        // The tester's state: one row, up; the API's role may only read it.
        expect(await throwaway.selectFrom("otelcol_testing_state").selectAll().execute()).toEqual([
          { id: true, down_since: null },
        ]);
        expect(add.relations.find((relation) => relation.name === "otelcol_testing_state")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=r/${owner}`,
        ]);
        for (const table of ["test_input_files", "test_runs"]) {
          expect(add.relations.find((relation) => relation.name === table)!.acl).toEqual([
            `${owner}=arwdDxtm/${owner}`,
            `telflo_platform_runtime=arwd/${owner}`,
          ]);
        }

        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the test suites migration adds test_suites, test_definition_inputs and test_definitions (row-level security, their policies, checks, foreign keys and indexes), the global test_templates (no row-level security, no DELETE for the API's role), the suites' identity trigger and the templates' guard with their functions, and the runs' four breadcrumb columns with their checks and index; replaces refuse_test_run_change (the breadcrumb in the snapshot) and test_runs_waiting_for_context_user (the context's organization only), each with its comment and their grants kept; changes no other object or row; its down restores migration 028's two functions byte for byte with their comments and drops the rest; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the test runs migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `after` holds that `before` doesn't, by section, parsed back. */
        const added = (before: Catalog, after: Catalog) =>
          Object.fromEntries(
            Object.entries(after).map(([section, items]) => [
              section,
              items
                .filter((item) => !before[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[], key = "name") => items.map((item) => String(item[key])).sort();
        /** The source of a function, as Postgres stores it. */
        const sourceOf = async (signature: string) =>
          (
            await sql<{ source: string }>`select prosrc as source from pg_proc where oid = ${signature}::regprocedure`.execute(
              throwaway,
            )
          ).rows[0]!.source;

        // Through 1700000000028_test_runs, with a member, a configuration, its version and a run already there.
        await migrate(29);
        const before = await catalog();
        const sources028 = {
          guard: await sourceOf("refuse_test_run_change()"),
          waiting: await sourceOf("test_runs_waiting_for_context_user()"),
        };
        const ana = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          organizationId: ana.organization.id,
          created_by_user_id: ana.user.id,
        });
        const version = await addConfigurationVersion(throwaway, {
          configurationId: configuration.id,
          organizationId: ana.organization.id,
          yaml_content: "receivers: {}\n",
        });
        const run = await sql<Record<string, unknown>>`
          insert into test_runs (organization_id, configuration_id, configuration_version_id, queued_by_user_id, yaml,
                                 target_pipeline, signal, duration_seconds, collector_distribution, collector_version,
                                 input_name, input_size_bytes)
          values (${ana.organization.id}, ${configuration.id}, ${version.id}, ${ana.user.id}, 'receivers: {}', 'logs',
                  'logs', 5, ${version.collector_distribution}, ${version.collector_version}, 'input.json', 0)
          returning *`.execute(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but the two functions this migration replaces.
        const replaced = ["refuse_test_run_change()", "test_runs_waiting_for_context_user()"];
        for (const [section, items] of Object.entries(before)) {
          const missing = items
            .filter((item) => !after[section as keyof Catalog].includes(item))
            .map((item) => JSON.parse(item) as Record<string, unknown>);
          expect({ section, missing: names(missing, section === "functions" ? "signature" : "name") }).toEqual({
            section,
            missing: section === "functions" ? replaced : [],
          });
        }
        expect(await rows()).toEqual(rowsBefore);
        // The run keeps every column, with no breadcrumb.
        expect(
          (await sql<Record<string, unknown>>`select * from test_runs`.execute(throwaway)).rows,
        ).toEqual([
          { ...run.rows[0], test_suite_id: null, test_suite_name: null, test_definition_id: null, test_definition_name: null },
        ]);

        const add = added(before, after);
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.relations.filter((relation) => relation.kind === "r").map(({ name, rls, force }) => ({ name, rls, force })).sort((x, y) => String(x.name).localeCompare(String(y.name)))).toEqual([
          { name: "test_definition_inputs", rls: true, force: false },
          { name: "test_definitions", rls: true, force: false },
          { name: "test_suites", rls: true, force: false },
          { name: "test_templates", rls: false, force: false },
        ]);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        for (const table of ["test_suites", "test_definition_inputs", "test_definitions"]) {
          expect(add.relations.find((relation) => relation.name === table)!.acl).toEqual([
            `${owner}=arwdDxtm/${owner}`,
            `telflo_platform_runtime=arwd/${owner}`,
          ]);
        }
        // Deletes are soft: the API's role gets no DELETE on templates.
        expect(add.relations.find((relation) => relation.name === "test_templates")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=arw/${owner}`,
        ]);
        expect(names(add.columns.filter((column) => column.relation === "test_runs"))).toEqual([
          "test_definition_id",
          "test_definition_name",
          "test_suite_id",
          "test_suite_name",
        ]);
        expect(add.columns.find((column) => column.relation === "test_definitions" && column.name === "duration_seconds")).toMatchObject({
          type: "smallint",
          notNull: true,
          default: null,
        });
        expect(names(add.indexes)).toEqual([
          "idx_test_definition_inputs_organization_configuration",
          "idx_test_definitions_created_by_user_id",
          "idx_test_definitions_input",
          "idx_test_definitions_organization_configuration",
          "idx_test_definitions_suite_created_at",
          "idx_test_runs_test_definition_id",
          "idx_test_suites_created_by_user_id",
          "idx_test_suites_organization_configuration",
          "idx_test_suites_version_created_at",
          "idx_test_templates_created_by_user_id",
          "idx_test_templates_live_created_at",
          "test_definition_inputs_pkey",
          "test_definitions_pkey",
          "test_suites_pkey",
          "test_templates_pkey",
          "uq_test_definition_inputs_id_configuration_organization",
          "uq_test_suites_id_version_configuration_organization",
        ]);
        expect(add.indexes).toEqual(
          expect.arrayContaining([
            {
              name: "idx_test_templates_live_created_at",
              definition:
                "CREATE INDEX idx_test_templates_live_created_at ON platform.test_templates USING btree (created_at DESC, id DESC) WHERE (deleted_at IS NULL)",
            },
            {
              name: "idx_test_runs_test_definition_id",
              definition:
                "CREATE INDEX idx_test_runs_test_definition_id ON platform.test_runs USING btree (test_definition_id) WHERE (test_definition_id IS NOT NULL)",
            },
          ]),
        );

        // Every new table, index (but one backing a constraint), column, constraint (but a not-null one), policy,
        // function and trigger is commented, the replaced functions included.
        const constraintNames = names(add.constraints);
        const uncommented = [
          ...add.relations.filter((relation) => !constraintNames.includes(String(relation.name))),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
          ...add.policies,
          ...add.functions,
          ...add.triggers,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        expect(names(add.constraints.filter((constraint) => constraint.type !== "n"))).toEqual([
          "ck_test_definition_inputs_content_type_present",
          "ck_test_definition_inputs_file_name_length",
          "ck_test_definition_inputs_sha256_length",
          "ck_test_definition_inputs_size_bytes",
          "ck_test_definitions_description_length",
          "ck_test_definitions_duration_seconds",
          "ck_test_definitions_name_length",
          "ck_test_definitions_name_trimmed",
          "ck_test_definitions_pipeline_signal",
          "ck_test_definitions_signal",
          "ck_test_definitions_target_pipeline_length",
          "ck_test_runs_breadcrumb_together",
          "ck_test_runs_test_definition_name_length",
          "ck_test_runs_test_suite_name_length",
          "ck_test_suites_description_length",
          "ck_test_suites_name_length",
          "ck_test_suites_name_trimmed",
          "ck_test_templates_content_type_present",
          "ck_test_templates_description_length",
          "ck_test_templates_file_name_length",
          "ck_test_templates_name_length",
          "ck_test_templates_name_trimmed",
          "ck_test_templates_receiver_type_format",
          "ck_test_templates_sha256_length",
          "ck_test_templates_signal",
          "ck_test_templates_size_bytes",
          "fk_test_definition_inputs_configuration",
          "fk_test_definitions_input",
          "fk_test_definitions_suite",
          "fk_test_suites_configuration_version",
          "test_definition_inputs_organization_id_fkey",
          "test_definition_inputs_pkey",
          "test_definitions_created_by_user_id_fkey",
          "test_definitions_organization_id_fkey",
          "test_definitions_pkey",
          "test_suites_created_by_user_id_fkey",
          "test_suites_organization_id_fkey",
          "test_suites_pkey",
          "test_templates_created_by_user_id_fkey",
          "test_templates_pkey",
          "uq_test_definition_inputs_id_configuration_organization",
          "uq_test_suites_id_version_configuration_organization",
        ]);
        expect(add.constraints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "fk_test_suites_configuration_version",
              definition:
                "FOREIGN KEY (configuration_version_id, configuration_id, organization_id) " +
                "REFERENCES configuration_versions(id, configuration_id, organization_id) ON DELETE CASCADE",
            }),
            expect.objectContaining({
              name: "fk_test_definitions_suite",
              definition:
                "FOREIGN KEY (test_suite_id, configuration_version_id, configuration_id, organization_id) " +
                "REFERENCES test_suites(id, configuration_version_id, configuration_id, organization_id) ON DELETE CASCADE",
              deferrable: false,
            }),
            // No action, checked at commit (Preflight ruling 3).
            expect.objectContaining({
              name: "fk_test_definitions_input",
              definition:
                "FOREIGN KEY (input_id, configuration_id, organization_id) " +
                "REFERENCES test_definition_inputs(id, configuration_id, organization_id) DEFERRABLE INITIALLY DEFERRED",
              deferrable: true,
              deferred: true,
            }),
            expect.objectContaining({
              name: "fk_test_definition_inputs_configuration",
              definition:
                "FOREIGN KEY (configuration_id, organization_id) REFERENCES configurations(id, organization_id) ON DELETE CASCADE",
            }),
            expect.objectContaining({
              name: "test_suites_created_by_user_id_fkey",
              definition: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
            }),
            expect.objectContaining({
              name: "test_definitions_created_by_user_id_fkey",
              definition: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
            }),
            expect.objectContaining({
              name: "test_templates_created_by_user_id_fkey",
              definition: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
            }),
          ]),
        );

        // The policies: the child-visible rule, the creator pinned on insert, no update of a definition or an input.
        const policy = (name: string) => add.policies.find((item) => item.name === name)!;
        expect(names(add.policies)).toEqual([
          "test_definition_inputs_delete",
          "test_definition_inputs_insert",
          "test_definition_inputs_select",
          "test_definition_inputs_update",
          "test_definitions_delete",
          "test_definitions_insert",
          "test_definitions_select",
          "test_definitions_update",
          "test_suites_delete",
          "test_suites_insert",
          "test_suites_select",
          "test_suites_update",
        ]);
        for (const item of add.policies) expect(item.roles).toEqual(["telflo_platform_runtime"]);
        // Each policy's whole expression, as Postgres prints it back: the organization context AND the
        // configuration visible (migration 021's child-visible rule), and on insert the creator pinned too.
        const organization = "(NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid";
        const user = "(NULLIF(current_setting('telflo.user_id'::text, true), ''::text))::uuid";
        const inOrganization = `(organization_id = ${organization})`;
        const exists = (table: string) =>
          `(EXISTS ( SELECT 1\n   FROM configurations c\n  WHERE ((c.id = ${table}.configuration_id) AND ` +
          `(c.organization_id = ${table}.organization_id))))`;
        const childVisible = (table: string) => `(${inOrganization} AND ${exists(table)})`;
        const creatorPinned = (table: string) =>
          `(${inOrganization} AND ${exists(table)} AND (created_by_user_id = ${user}))`;
        for (const table of ["test_suites", "test_definition_inputs", "test_definitions"]) {
          expect(policy(`${table}_select`), table).toMatchObject({ cmd: "SELECT", qual: childVisible(table), withCheck: null });
          expect(policy(`${table}_delete`), table).toMatchObject({ cmd: "DELETE", qual: childVisible(table), withCheck: null });
        }
        expect(policy("test_suites_update")).toMatchObject({
          cmd: "UPDATE",
          qual: childVisible("test_suites"),
          withCheck: childVisible("test_suites"),
        });
        expect(policy("test_suites_insert")).toMatchObject({
          cmd: "INSERT",
          qual: null,
          withCheck: creatorPinned("test_suites"),
        });
        expect(policy("test_definitions_insert")).toMatchObject({
          cmd: "INSERT",
          qual: null,
          withCheck: creatorPinned("test_definitions"),
        });
        expect(policy("test_definition_inputs_insert")).toMatchObject({
          cmd: "INSERT",
          qual: null,
          withCheck: childVisible("test_definition_inputs"),
        });
        expect(policy("test_definitions_update")).toMatchObject({ cmd: "UPDATE", qual: "false", withCheck: null });
        expect(policy("test_definition_inputs_update")).toMatchObject({ cmd: "UPDATE", qual: "false", withCheck: null });

        // The functions: two new trigger functions, and the two replaced, which keep their grants and settings.
        expect(names(add.functions, "signature")).toEqual([
          "refuse_test_run_change()",
          "refuse_test_suite_identity_change()",
          "refuse_test_template_change()",
          "test_runs_waiting_for_context_user()",
        ]);
        for (const signature of ["refuse_test_suite_identity_change()", "refuse_test_template_change()"]) {
          expect(add.functions.find((item) => item.signature === signature)).toMatchObject({
            isDefiner: false,
            config: ["search_path=pg_catalog, platform"],
          });
        }
        const was = (signature: string) =>
          before.functions.map((item) => JSON.parse(item) as Record<string, unknown>).find((item) => item.signature === signature)!;
        for (const signature of replaced) {
          const now = add.functions.find((item) => item.signature === signature)!;
          expect({ ...now, source: undefined, comment: undefined }).toEqual({ ...was(signature), source: undefined, comment: undefined });
          expect(now.source).not.toBe(was(signature).source);
          expect(now.comment).not.toBe(was(signature).comment);
        }
        expect(await sourceOf("refuse_test_run_change()")).toContain(
          "new.queued_at, new.test_suite_id, new.test_suite_name, new.test_definition_id, new.test_definition_name)",
        );
        expect(await sourceOf("test_runs_waiting_for_context_user()")).toMatch(
          /and r\.organization_id = nullif\(current_setting\('telflo\.organization_id', true\), ''\)::uuid/,
        );
        expect(names(add.triggers)).toEqual(["test_suites_identity_unchanged", "test_templates_guard"]);
        expect(add.triggers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              definition:
                "CREATE TRIGGER test_suites_identity_unchanged BEFORE UPDATE ON platform.test_suites FOR EACH ROW EXECUTE FUNCTION refuse_test_suite_identity_change()",
              enabled: "O",
            }),
            expect.objectContaining({
              definition:
                "CREATE TRIGGER test_templates_guard BEFORE UPDATE ON platform.test_templates FOR EACH ROW EXECUTE FUNCTION refuse_test_template_change()",
              enabled: "O",
            }),
          ]),
        );

        // down: migration 028's schema exactly, its two functions' sources byte for byte with their comments.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await sourceOf("refuse_test_run_change()")).toBe(sources028.guard);
        expect(await sourceOf("test_runs_waiting_for_context_user()")).toBe(sources028.waiting);
        expect(await rows()).toEqual(rowsBefore);
        expect((await sql<Record<string, unknown>>`select * from test_runs`.execute(throwaway)).rows).toEqual(run.rows);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the validation rules migration adds validation_pipelines and validation_rules (row-level security, their policies, checks, foreign keys and indexes) with the rules' identity trigger and its function, the evaluator's one-row state (SELECT only for the API's role) and its mark, the runs' validation_failed status, rules' snapshot and results with their checks, test_runs_rules, and test_runs_finish taking the final status; replaces refuse_test_run_change (the snapshot's two columns, running → validation_failed), each with its comment; changes no other object or row; its down refuses while a run is validation_failed, then restores migration 029's catalogue exactly, the guard and the boolean finish byte for byte, and drops the rest; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the test suites migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `after` holds that `before` doesn't, by section, parsed back. */
        const added = (before: Catalog, after: Catalog) =>
          Object.fromEntries(
            Object.entries(after).map(([section, items]) => [
              section,
              items
                .filter((item) => !before[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[], key = "name") => items.map((item) => String(item[key])).sort();
        /** The source of a function, as Postgres stores it. */
        const sourceOf = async (signature: string) =>
          (
            await sql<{ source: string }>`select prosrc as source from pg_proc where oid = ${signature}::regprocedure`.execute(
              throwaway,
            )
          ).rows[0]!.source;

        // Through 1700000000029_test_suites, with a member, a configuration, its version, a waiting run and a
        // finished one already there.
        await migrate(30);
        const before = await catalog();
        const sources029 = {
          guard: await sourceOf("refuse_test_run_change()"),
          finish: await sourceOf("test_runs_finish(uuid,uuid,boolean,jsonb)"),
        };
        const ana = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          organizationId: ana.organization.id,
          created_by_user_id: ana.user.id,
        });
        const version = await addConfigurationVersion(throwaway, {
          configurationId: configuration.id,
          organizationId: ana.organization.id,
          yaml_content: "receivers: {}\n",
        });
        const insertRun = (state: string) =>
          sql<Record<string, unknown>>`
            insert into test_runs (organization_id, configuration_id, configuration_version_id, queued_by_user_id, yaml,
                                   target_pipeline, signal, duration_seconds, collector_distribution, collector_version,
                                   input_name, input_size_bytes, status, started_at, finished_at)
            values (${ana.organization.id}, ${configuration.id}, ${version.id}, ${ana.user.id}, 'receivers: {}', 'logs',
                    'logs', 5, ${version.collector_distribution}, ${version.collector_version}, 'input.json', 0,
                    ${state}, case when ${state} = 'queued' then null else now() end,
                    case when ${state} = 'queued' then null else now() end)
            returning *`.execute(throwaway);
        const runs029 = [...(await insertRun("queued")).rows, ...(await insertRun("failed")).rows];
        const runsNow = async () =>
          (await sql<Record<string, unknown>>`select * from test_runs order by id`.execute(throwaway)).rows;
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
          testerState: await throwaway.selectFrom("otelcol_testing_state").selectAll().execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but what this migration replaces: the guard, the boolean finish (dropped),
        // the three status checks (validation_failed added) and the status column's comment.
        const replaced: Record<string, string[]> = {
          functions: ["refuse_test_run_change()", "test_runs_finish(uuid,uuid,boolean,jsonb)"],
          constraints: ["ck_test_runs_results_only_when_finished", "ck_test_runs_state", "ck_test_runs_status"],
          columns: ["test_runs.status"],
        };
        for (const [section, items] of Object.entries(before)) {
          const missing = items
            .filter((item) => !after[section as keyof Catalog].includes(item))
            .map((item) => JSON.parse(item) as Record<string, unknown>);
          const missingNames = missing
            .map((item) =>
              section === "functions"
                ? String(item.signature)
                : section === "columns"
                  ? `${String(item.relation)}.${String(item.name)}`
                  : String(item.name),
            )
            .sort();
          expect({ section, missing: missingNames }).toEqual({ section, missing: replaced[section] ?? [] });
        }
        expect(await rows()).toEqual(rowsBefore);
        // The runs keep every column, with no rules, no pipeline and no results.
        const byId = (x: Record<string, unknown>, y: Record<string, unknown>) => String(x.id).localeCompare(String(y.id));
        expect(await runsNow()).toEqual(
          runs029
            .map((run): Record<string, unknown> => ({
              ...run,
              validation_pipeline_id: null,
              validation_rules: [],
              validation_results: null,
            }))
            .sort(byId),
        );

        const add = added(before, after);
        expect(add.defaultPrivileges).toEqual([]);
        expect(
          add.relations
            .filter((relation) => relation.kind === "r")
            .map(({ name, rls, force }) => ({ name, rls, force }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name))),
        ).toEqual([
          { name: "ottl_evaluator_state", rls: false, force: false },
          { name: "validation_pipelines", rls: true, force: false },
          { name: "validation_rules", rls: true, force: false },
        ]);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        for (const table of ["validation_pipelines", "validation_rules"]) {
          expect(add.relations.find((relation) => relation.name === table)!.acl).toEqual([
            `${owner}=arwdDxtm/${owner}`,
            `telflo_platform_runtime=arwd/${owner}`,
          ]);
        }
        // The evaluator's state: one row, up; the API's role may only read it.
        expect(add.relations.find((relation) => relation.name === "ottl_evaluator_state")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=r/${owner}`,
        ]);
        expect(await throwaway.selectFrom("ottl_evaluator_state").selectAll().execute()).toEqual([
          { id: true, down_since: null },
        ]);
        expect(names(add.columns.filter((column) => column.relation === "test_runs"))).toEqual([
          "status",
          "validation_pipeline_id",
          "validation_results",
          "validation_rules",
        ]);
        expect(add.columns.find((column) => column.relation === "test_runs" && column.name === "validation_rules")).toMatchObject({
          type: "jsonb",
          notNull: true,
          default: "'[]'::jsonb",
        });
        expect(add.columns.find((column) => column.relation === "validation_pipelines" && column.name === "updated_at")).toBeUndefined();
        expect(names(add.indexes)).toEqual([
          "idx_validation_pipelines_created_by_user_id",
          "idx_validation_pipelines_organization_configuration",
          "idx_validation_rules_created_by_user_id",
          "idx_validation_rules_organization_configuration",
          "ottl_evaluator_state_pkey",
          "uq_validation_pipelines_id_version_configuration_organization",
          "uq_validation_pipelines_version_pipeline_name",
          "uq_validation_rules_pipeline_position",
          "validation_pipelines_pkey",
          "validation_rules_pkey",
        ]);

        // Every new table, index (but one backing a constraint), column, constraint (but a not-null one), policy,
        // function and trigger is commented, the replaced ones included.
        const constraintNames = names(add.constraints);
        const uncommented = [
          ...add.relations.filter((relation) => !constraintNames.includes(String(relation.name))),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
          ...add.policies,
          ...add.functions,
          ...add.triggers,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        expect(names(add.constraints.filter((constraint) => constraint.type !== "n"))).toEqual([
          "ck_ottl_evaluator_state_singleton",
          "ck_test_runs_results_only_when_finished",
          "ck_test_runs_state",
          "ck_test_runs_status",
          "ck_test_runs_validation_outcome",
          "ck_test_runs_validation_results",
          "ck_test_runs_validation_rules",
          "ck_validation_pipelines_pipeline_name_length",
          "ck_validation_pipelines_pipeline_signal",
          "ck_validation_pipelines_signal",
          "ck_validation_rules_description_length",
          "ck_validation_rules_kind",
          "ck_validation_rules_name_length",
          "ck_validation_rules_name_trimmed",
          "ck_validation_rules_ottl_condition_length",
          "ck_validation_rules_ottl_context",
          "ck_validation_rules_ottl_count",
          "ck_validation_rules_ottl_expression_length",
          "ck_validation_rules_ottl_only_ottl",
          "ck_validation_rules_ottl_output_only",
          "ck_validation_rules_ottl_quantifier",
          "ck_validation_rules_ottl_shape",
          "ck_validation_rules_pattern_length",
          "ck_validation_rules_pattern_only_text_and_regex",
          "ck_validation_rules_position",
          "ck_validation_rules_target",
          "fk_validation_pipelines_configuration_version",
          "fk_validation_rules_validation_pipeline",
          "ottl_evaluator_state_pkey",
          "uq_validation_pipelines_id_version_configuration_organization",
          "uq_validation_pipelines_version_pipeline_name",
          "uq_validation_rules_pipeline_position",
          "validation_pipelines_created_by_user_id_fkey",
          "validation_pipelines_organization_id_fkey",
          "validation_pipelines_pkey",
          "validation_rules_created_by_user_id_fkey",
          "validation_rules_organization_id_fkey",
          "validation_rules_pkey",
        ]);
        const constraint = (name: string) => add.constraints.find((item) => item.name === name)!;
        expect(constraint("fk_validation_pipelines_configuration_version").definition).toBe(
          "FOREIGN KEY (configuration_version_id, configuration_id, organization_id) " +
            "REFERENCES configuration_versions(id, configuration_id, organization_id) ON DELETE CASCADE",
        );
        expect(constraint("fk_validation_rules_validation_pipeline").definition).toBe(
          "FOREIGN KEY (validation_pipeline_id, configuration_version_id, configuration_id, organization_id) " +
            "REFERENCES validation_pipelines(id, configuration_version_id, configuration_id, organization_id) ON DELETE CASCADE",
        );
        for (const name of ["validation_pipelines_created_by_user_id_fkey", "validation_rules_created_by_user_id_fkey"]) {
          expect(constraint(name).definition).toBe("FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL");
        }
        // Bytes, not characters (Preflight ruling 10).
        for (const name of [
          "ck_validation_rules_pattern_length",
          "ck_validation_rules_ottl_condition_length",
          "ck_validation_rules_ottl_expression_length",
        ]) {
          expect(constraint(name).definition, name).toMatch(/octet_length\(\w+\) <= 8192/);
        }
        expect(constraint("ck_test_runs_status").definition).toBe(
          "CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'validation_failed'::text])))",
        );

        // The policies: the child-visible rule, the creator pinned on insert, no update of a validation pipeline.
        const policy = (name: string) => add.policies.find((item) => item.name === name)!;
        expect(names(add.policies)).toEqual([
          "validation_pipelines_delete",
          "validation_pipelines_insert",
          "validation_pipelines_select",
          "validation_pipelines_update",
          "validation_rules_delete",
          "validation_rules_insert",
          "validation_rules_select",
          "validation_rules_update",
        ]);
        for (const item of add.policies) expect(item.roles).toEqual(["telflo_platform_runtime"]);
        const organization = "(NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid";
        const user = "(NULLIF(current_setting('telflo.user_id'::text, true), ''::text))::uuid";
        const inOrganization = `(organization_id = ${organization})`;
        const exists = (table: string) =>
          `(EXISTS ( SELECT 1\n   FROM configurations c\n  WHERE ((c.id = ${table}.configuration_id) AND ` +
          `(c.organization_id = ${table}.organization_id))))`;
        const childVisible = (table: string) => `(${inOrganization} AND ${exists(table)})`;
        const creatorPinned = (table: string) =>
          `(${inOrganization} AND ${exists(table)} AND (created_by_user_id = ${user}))`;
        for (const table of ["validation_pipelines", "validation_rules"]) {
          expect(policy(`${table}_select`), table).toMatchObject({ cmd: "SELECT", qual: childVisible(table), withCheck: null });
          expect(policy(`${table}_delete`), table).toMatchObject({ cmd: "DELETE", qual: childVisible(table), withCheck: null });
          expect(policy(`${table}_insert`), table).toMatchObject({
            cmd: "INSERT",
            qual: null,
            withCheck: creatorPinned(table),
          });
        }
        expect(policy("validation_rules_update")).toMatchObject({
          cmd: "UPDATE",
          qual: childVisible("validation_rules"),
          withCheck: childVisible("validation_rules"),
        });
        expect(policy("validation_pipelines_update")).toMatchObject({ cmd: "UPDATE", qual: "false", withCheck: null });

        // The functions: the rules' trigger function, the replaced guard, and three dispatcher functions, definer
        // with a fixed path and EXECUTE for the API's role only.
        expect(names(add.functions, "signature")).toEqual([
          "ottl_evaluator_mark(boolean)",
          "refuse_test_run_change()",
          "refuse_validation_rule_identity_change()",
          "test_runs_finish(uuid,uuid,text,jsonb)",
          "test_runs_rules(uuid,uuid)",
        ]);
        for (const signature of ["ottl_evaluator_mark(boolean)", "test_runs_finish(uuid,uuid,text,jsonb)", "test_runs_rules(uuid,uuid)"]) {
          expect(add.functions.find((item) => item.signature === signature), signature).toMatchObject({
            isDefiner: true,
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
          });
        }
        for (const signature of ["refuse_test_run_change()", "refuse_validation_rule_identity_change()"]) {
          expect(add.functions.find((item) => item.signature === signature), signature).toMatchObject({
            isDefiner: false,
            config: ["search_path=pg_catalog, platform"],
          });
        }
        const was = (signature: string) =>
          before.functions.map((item) => JSON.parse(item) as Record<string, unknown>).find((item) => item.signature === signature)!;
        const guardNow = add.functions.find((item) => item.signature === "refuse_test_run_change()")!;
        expect({ ...guardNow, source: undefined, comment: undefined }).toEqual({
          ...was("refuse_test_run_change()"),
          source: undefined,
          comment: undefined,
        });
        const guard = await sourceOf("refuse_test_run_change()");
        expect(guard).toContain("new.test_definition_name, new.validation_pipeline_id, new.validation_rules)");
        expect(guard).toContain("new.status in ('succeeded', 'failed', 'validation_failed', 'queued')");
        expect(names(add.triggers)).toEqual(["validation_rules_identity_unchanged"]);
        expect(add.triggers[0]).toMatchObject({
          definition:
            "CREATE TRIGGER validation_rules_identity_unchanged BEFORE UPDATE ON platform.validation_rules FOR EACH ROW EXECUTE FUNCTION refuse_validation_rule_identity_change()",
          enabled: "O",
        });

        // down refuses while a run ended validation_failed (028's status check couldn't be put back), changing
        // nothing; once no run is, it restores migration 029's schema exactly, the guard and the boolean finish byte
        // for byte with their comments.
        const refused = await sql<{ id: string }>`
          insert into test_runs (organization_id, configuration_id, configuration_version_id, queued_by_user_id, yaml,
                                 target_pipeline, signal, duration_seconds, collector_distribution, collector_version,
                                 input_name, input_size_bytes, status, started_at, finished_at, validation_rules,
                                 validation_results)
          values (${ana.organization.id}, ${configuration.id}, ${version.id}, ${ana.user.id}, 'receivers: {}', 'logs',
                  'logs', 5, ${version.collector_distribution}, ${version.collector_version}, 'input.json', 0,
                  'validation_failed', now(), now(), '[{"id": "r"}]', '[{"id": "r", "passed": false}]')
          returning id`.execute(throwaway);
        await expect(migrateDown(1)).rejects.toThrow(
          "cannot restore migration 029's run statuses: 1 run(s) ended validation_failed",
        );
        expect(await catalog()).toEqual(after);
        await throwaway.deleteFrom("test_runs").where("id", "=", refused.rows[0]!.id).execute();

        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await sourceOf("refuse_test_run_change()")).toBe(sources029.guard);
        expect(await sourceOf("test_runs_finish(uuid,uuid,boolean,jsonb)")).toBe(sources029.finish);
        expect(await rows()).toEqual(rowsBefore);
        expect(await runsNow()).toEqual([...runs029].sort(byId));

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the test regex migration adds test_regex (no row-level security, the API's role's four privileges, its unique name and checks, each commented) holding the 35 seeded entries, and changes no other object or row; its down restores migration 030's catalogue exactly; and it applies again, seeded again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the validation rules migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `after` holds that `before` doesn't, by section, parsed back. */
        const added = (before: Catalog, after: Catalog) =>
          Object.fromEntries(
            Object.entries(after).map(([section, items]) => [
              section,
              items
                .filter((item) => !before[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const { seededTestRegexes } = await loadTestRegexMigration();
        /** The library's entries but their ids and timestamps, by name. */
        const entries = async () =>
          (await throwaway.selectFrom("test_regex").select(["name", "category", "description", "regex"]).execute()).sort(
            (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          );
        const seeded = [...seededTestRegexes]
          .map(({ name, category, description, regex }) => ({ name, category, description, regex }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        // Through 1700000000030_validation_rules, with a member, a configuration and its version already there.
        await migrate(31);
        const before = await catalog();
        const ana = await createUserWithOrganization(throwaway);
        const configuration = await addConfiguration(throwaway, {
          organizationId: ana.organization.id,
          created_by_user_id: ana.user.id,
        });
        await addConfigurationVersion(throwaway, {
          configurationId: configuration.id,
          organizationId: ana.organization.id,
          yaml_content: "receivers: {}\n",
        });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          versions: await throwaway.selectFrom("configuration_versions").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
          testerState: await throwaway.selectFrom("otelcol_testing_state").selectAll().execute(),
          evaluatorState: await throwaway.selectFrom("ottl_evaluator_state").selectAll().execute(),
        });
        const rowsBefore = await rows();
        expect(rowsBefore.flows).toHaveLength(13);

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed.
        for (const [section, items] of Object.entries(before)) {
          const missing = items.filter((item) => !after[section as keyof Catalog].includes(item));
          expect({ section, missing }).toEqual({ section, missing: [] });
        }
        expect(await rows()).toEqual(rowsBefore);
        expect(await entries()).toEqual(seeded);

        const add = added(before, after);
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.policies).toEqual([]);
        expect(add.functions).toEqual([]);
        expect(add.triggers).toEqual([]);
        expect(
          add.relations
            .map(({ name, kind, rls, force }) => ({ name, kind, rls, force }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name))),
        ).toEqual([
          { name: "test_regex", kind: "r", rls: false, force: false },
          { name: "test_regex_pkey", kind: "i", rls: false, force: false },
          { name: "uq_test_regex_name", kind: "i", rls: false, force: false },
        ]);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(add.relations.find((relation) => relation.name === "test_regex")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=arwd/${owner}`,
        ]);
        expect(
          add.columns
            .map(({ relation, name, type, notNull, default: fallback }) => ({
              relation,
              name,
              type,
              notNull,
              default: fallback,
            }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name))),
        ).toEqual([
          { relation: "test_regex", name: "category", type: "text", notNull: true, default: null },
          { relation: "test_regex", name: "created_at", type: "timestamp with time zone", notNull: true, default: null },
          { relation: "test_regex", name: "description", type: "text", notNull: false, default: null },
          { relation: "test_regex", name: "id", type: "uuid", notNull: true, default: "uuidv7()" },
          { relation: "test_regex", name: "name", type: "text", notNull: true, default: null },
          { relation: "test_regex", name: "regex", type: "text", notNull: true, default: null },
          { relation: "test_regex", name: "updated_at", type: "timestamp with time zone", notNull: true, default: null },
        ]);
        expect(add.indexes).toEqual([
          {
            name: "test_regex_pkey",
            definition: "CREATE UNIQUE INDEX test_regex_pkey ON platform.test_regex USING btree (id)",
          },
          {
            name: "uq_test_regex_name",
            definition: "CREATE UNIQUE INDEX uq_test_regex_name ON platform.test_regex USING btree (name)",
          },
        ]);

        // Every new column and constraint (but a not-null one) is commented, and the table.
        const uncommented = [
          ...add.relations.filter((relation) => relation.kind === "r"),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        // The ASCII blank set, migration 030's (E' \t\n\x0B\f\r'), as Postgres prints it back: the six characters.
        const printedBlank = "' \t\n\u000b\f\r'::text";
        const patternCheck = (
          await sql<{ definition: string }>`
            select pg_get_constraintdef(oid) as definition
              from pg_constraint where conname = 'ck_validation_rules_pattern_length'`.execute(throwaway)
        ).rows[0]!.definition;
        expect(patternCheck).toContain(`btrim(pattern, ${printedBlank})`);
        expect(
          Object.fromEntries(
            add.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          test_regex_pkey: "PRIMARY KEY (id)",
          uq_test_regex_name: "UNIQUE (name)",
          ck_test_regex_name_trimmed: `CHECK ((name = btrim(name, ${printedBlank})))`,
          ck_test_regex_name_length: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))",
          ck_test_regex_category_trimmed: `CHECK ((category = btrim(category, ${printedBlank})))`,
          ck_test_regex_category_length: "CHECK (((char_length(category) >= 1) AND (char_length(category) <= 100)))",
          ck_test_regex_description_trimmed: `CHECK ((description = btrim(description, ${printedBlank})))`,
          ck_test_regex_description_length:
            "CHECK (((char_length(description) >= 1) AND (char_length(description) <= 2000)))",
          ck_test_regex_regex_length:
            `CHECK (((octet_length(regex) <= 8192) AND (btrim(regex, ${printedBlank}) <> ''::text)))`,
        });

        // down drops the table with its rows, restoring migration 030's catalogue exactly; up again seeds again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
        expect(await entries()).toEqual(seeded);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the quick-deploy links migration adds quick_deploy_links (row-level security, not forced, the API's role's four privileges, four policies, its checks and indexes, each commented) and the definer quick_deploy_link_by_secret_hash (EXECUTE for telflo_platform_runtime only), and changes no other object or row; its down restores migration 031's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the test regex migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `after` holds that `before` doesn't, by section, parsed back. */
        const added = (before: Catalog, after: Catalog) =>
          Object.fromEntries(
            Object.entries(after).map(([section, items]) => [
              section,
              items
                .filter((item) => !before[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const byName = (x: Record<string, unknown>, y: Record<string, unknown>) => String(x.name).localeCompare(String(y.name));

        // Through 1700000000031_test_regex, with a member and a configuration already there.
        await migrate(32);
        const before = await catalog();
        const ana = await createUserWithOrganization(throwaway);
        await addConfiguration(throwaway, { organizationId: ana.organization.id, created_by_user_id: ana.user.id });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          configurations: await throwaway.selectFrom("configurations").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed.
        for (const [section, items] of Object.entries(before)) {
          const missing = items.filter((item) => !after[section as keyof Catalog].includes(item));
          expect({ section, missing }).toEqual({ section, missing: [] });
        }
        expect(await rows()).toEqual(rowsBefore);

        const add = added(before, after);
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.triggers).toEqual([]);
        expect(add.relations.map(({ name, kind, rls, force }) => ({ name, kind, rls, force })).sort(byName)).toEqual([
          { name: "idx_quick_deploy_links_fleet_created", kind: "i", rls: false, force: false },
          { name: "quick_deploy_links", kind: "r", rls: true, force: false },
          { name: "quick_deploy_links_pkey", kind: "i", rls: false, force: false },
          { name: "uq_quick_deploy_links_secret_hash", kind: "i", rls: false, force: false },
        ]);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(add.relations.find((relation) => relation.name === "quick_deploy_links")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=arwd/${owner}`,
        ]);
        expect(
          add.columns
            .map(({ relation, name, type, notNull, default: fallback }) => ({ relation, name, type, notNull, default: fallback }))
            .sort(byName),
        ).toEqual([
          { relation: "quick_deploy_links", name: "choices", type: "jsonb", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "created_at", type: "timestamp with time zone", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "created_by_user_id", type: "uuid", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "default_token_id", type: "uuid", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "download_count", type: "integer", notNull: true, default: "0" },
          { relation: "quick_deploy_links", name: "env_ciphertext", type: "bytea", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "env_key_id", type: "text", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "expires_at", type: "timestamp with time zone", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "fleet_id", type: "uuid", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "group_id", type: "uuid", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "id", type: "uuid", notNull: true, default: "uuidv7()" },
          { relation: "quick_deploy_links", name: "last_downloaded_at", type: "timestamp with time zone", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "organization_id", type: "uuid", notNull: true, default: null },
          { relation: "quick_deploy_links", name: "revoked_at", type: "timestamp with time zone", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "revoked_by_user_id", type: "uuid", notNull: false, default: null },
          { relation: "quick_deploy_links", name: "secret_hash", type: "text", notNull: true, default: null },
        ]);
        expect(add.indexes.sort(byName)).toEqual([
          {
            name: "idx_quick_deploy_links_fleet_created",
            definition:
              "CREATE INDEX idx_quick_deploy_links_fleet_created ON platform.quick_deploy_links USING btree (organization_id, fleet_id, created_at DESC, id DESC)",
          },
          {
            name: "quick_deploy_links_pkey",
            definition: "CREATE UNIQUE INDEX quick_deploy_links_pkey ON platform.quick_deploy_links USING btree (id)",
          },
          {
            name: "uq_quick_deploy_links_secret_hash",
            definition: "CREATE UNIQUE INDEX uq_quick_deploy_links_secret_hash ON platform.quick_deploy_links USING btree (secret_hash)",
          },
        ]);
        const contextOrganization = "(organization_id = (NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid)";
        expect(add.policies.map(({ name, cmd, roles, qual, withCheck }) => ({ name, cmd, roles, qual, withCheck })).sort(byName)).toEqual([
          { name: "quick_deploy_links_delete", cmd: "DELETE", roles: ["telflo_platform_runtime"], qual: contextOrganization, withCheck: null },
          { name: "quick_deploy_links_insert", cmd: "INSERT", roles: ["telflo_platform_runtime"], qual: null, withCheck: contextOrganization },
          { name: "quick_deploy_links_select", cmd: "SELECT", roles: ["telflo_platform_runtime"], qual: contextOrganization, withCheck: null },
          {
            name: "quick_deploy_links_update",
            cmd: "UPDATE",
            roles: ["telflo_platform_runtime"],
            qual: contextOrganization,
            withCheck: contextOrganization,
          },
        ]);
        expect(add.functions.map(({ signature, isDefiner, volatility, config, acl }) => ({ signature, isDefiner, volatility, config, acl }))).toEqual([
          {
            signature: "quick_deploy_link_by_secret_hash(text)",
            isDefiner: true,
            volatility: "s",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
          },
        ]);
        // What the definer answers, and nothing more (ADR 0023).
        const { rows: returned } = await sql<{ name: string; type: string }>`
          select a.name, a.type
            from pg_proc p,
                 unnest(p.proargnames[2:], (select array_agg(format_type(t, null)) from unnest(p.proallargtypes[2:]) t)) as a(name, type)
           where p.proname = 'quick_deploy_link_by_secret_hash'`.execute(throwaway);
        expect(returned).toEqual([
          { name: "id", type: "uuid" },
          { name: "organization_id", type: "uuid" },
          { name: "organization_is_live", type: "boolean" },
        ]);

        // Every new column, constraint (but a not-null one), the table and the function are commented.
        const uncommented = [
          ...add.relations.filter((relation) => relation.kind === "r"),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
          ...add.functions,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        expect(
          Object.fromEntries(
            add.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          quick_deploy_links_pkey: "PRIMARY KEY (id)",
          quick_deploy_links_organization_id_fkey: "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
          quick_deploy_links_created_by_user_id_fkey: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          quick_deploy_links_revoked_by_user_id_fkey: "FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          ck_quick_deploy_links_secret_hash: "CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text))",
          ck_quick_deploy_links_choices:
            "CHECK (((jsonb_typeof(choices) = 'object'::text) AND (octet_length((choices)::text) <= 16384)))",
          ck_quick_deploy_links_env_sealed: "CHECK (((env_ciphertext IS NULL) = (env_key_id IS NULL)))",
          ck_quick_deploy_links_env_key_id: "CHECK ((env_key_id ~ '^[0-9a-f]{16}$'::text))",
          ck_quick_deploy_links_env_ciphertext_length:
            "CHECK (((octet_length(env_ciphertext) >= 29) AND (octet_length(env_ciphertext) <= 1048576)))",
          ck_quick_deploy_links_expires_after_created: "CHECK ((expires_at > created_at))",
          ck_quick_deploy_links_revoked_after_created: "CHECK ((revoked_at >= created_at))",
          ck_quick_deploy_links_revoked_by: "CHECK (((revoked_at IS NOT NULL) OR (revoked_by_user_id IS NULL)))",
          ck_quick_deploy_links_downloads:
            "CHECK (((download_count >= 0) AND ((download_count = 0) = (last_downloaded_at IS NULL))))",
        });

        // down drops the table and the function, restoring migration 031's catalogue exactly; up again.
        await addQuickDeployLink(throwaway, { organizationId: ana.organization.id, created_by_user_id: ana.user.id });
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the public install links migration adds organizations.public_install_links_enabled (boolean, not null, default true, commented; existing rows true) and re-comments quick_deploy_links.choices, and changes no other object or row; its down restores migration 032's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the quick-deploy links migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const emptySections = { relations: [], constraints: [], indexes: [], policies: [], functions: [], triggers: [], defaultPrivileges: [] };

        // Through 1700000000032_quick_deploy_links, with a member, a deleted group organization and a link already there.
        await migrate(33);
        const before = await catalog();
        const ana = await createUserWithOrganization(throwaway);
        await throwaway
          .insertInto("organizations")
          .values({ name: "Acme", type: "group", owner_user_id: null, deleted_at: new Date() })
          .execute();
        await addQuickDeployLink(throwaway, { organizationId: ana.organization.id, created_by_user_id: ana.user.id });
        /** Every row but organizations' new column, which `organizations()` reads. */
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          links: await throwaway.selectFrom("quick_deploy_links").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        const organizations = async () =>
          (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows;
        const rowsBefore = await rows();
        const organizationsBefore = await organizations();
        expect(organizationsBefore).toHaveLength(2);

        await migrate(1);
        const after = await catalog();
        /** quick_deploy_links.choices' column, as a catalogue lists it. */
        const choicesColumn = (catalogue: Catalog) =>
          catalogue.columns
            .map((item) => JSON.parse(item) as Record<string, unknown>)
            .find((item) => item.relation === "quick_deploy_links" && item.name === "choices")!;
        // Nothing that was there changed, but choices' comment; only the new column and that comment were added.
        expect(only(before, after)).toEqual({ ...emptySections, columns: [choicesColumn(before)] });
        const added = only(after, before);
        // Postgres 18 lists a not-null as a constraint (uncommented, as every not-null is).
        expect({ ...added, columns: [] }).toEqual({
          ...emptySections,
          columns: [],
          constraints: [
            {
              relation: "organizations",
              name: "organizations_public_install_links_enabled_not_null",
              type: "n",
              definition: "NOT NULL public_install_links_enabled",
              deferrable: false,
              deferred: false,
              comment: null,
            },
          ],
        });
        expect(added.columns.map((item) => item.name).sort()).toEqual(["choices", "public_install_links_enabled"]);
        const column = added.columns.find((item) => item.name === "public_install_links_enabled")!;
        expect(column).toMatchObject({ relation: "organizations", type: "boolean", notNull: true, default: "true", acl: null });
        for (const word of ["Linux", "Quick Deploy links", "Helm values links", "True by default", "only an admin changes it"]) {
          expect(String(column.comment).replace(/\s+/g, " ")).toContain(word);
        }
        expect(choicesColumn(after)).toEqual({ ...choicesColumn(before), comment: expect.any(String) });
        for (const word of [
          "no kind, or kind linux",
          "method, arch",
          "systemd and envNames",
          "kind helm",
          "kind, role, release, namespace and envNames",
          "Never a value, a display name or the secret.",
        ]) {
          expect(String(choicesColumn(after).comment).replace(/\s+/g, " ")).toContain(word);
        }

        // Existing rows are on, and no other row changed.
        expect(await rows()).toEqual(rowsBefore);
        expect(await organizations()).toEqual(
          organizationsBefore.map((organization) => ({ ...organization, public_install_links_enabled: true })),
        );
        // A new organization is on by default, and the column takes false.
        const later = await throwaway
          .insertInto("organizations")
          .values({ name: "Later", type: "group", owner_user_id: null })
          .returning(["id", "public_install_links_enabled"])
          .executeTakeFirstOrThrow();
        expect(later.public_install_links_enabled).toBe(true);
        await throwaway.updateTable("organizations").set({ public_install_links_enabled: false }).where("id", "=", later.id).execute();

        // down drops the column and restores migration 032's comment: its catalogue exactly; up again, every row on.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);
        expect((await organizations()).filter((organization) => organization.id !== later.id)).toEqual(organizationsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(
          (await throwaway.selectFrom("organizations").select("public_install_links_enabled").execute()).map(
            (organization) => organization.public_install_links_enabled,
          ),
        ).toEqual([true, true, true]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the user settings migration adds user_settings (no row-level security, the API's role's four privileges by default, its two checks, its cascade from users, each commented) and signed_out_elsewhere to sessions.revoked_reason's comment, and changes no other object or row; its down restores migration 033's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the public install links migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const emptySections = { relations: [], constraints: [], indexes: [], policies: [], functions: [], triggers: [], defaultPrivileges: [] };
        const byName = (x: Record<string, unknown>, y: Record<string, unknown>) => String(x.name).localeCompare(String(y.name));

        // Through 1700000000033_public_install_links, with a member, a revoked session and a link already there.
        await migrate(34);
        const before = await catalog();
        const ana = await createUserWithOrganization(throwaway);
        await throwaway
          .insertInto("sessions")
          .values({
            user_id: ana.user.id,
            active_organization_id: ana.organization.id,
            revoked_at: new Date(),
            revoked_reason: "sign_out_everywhere",
          })
          .execute();
        await addQuickDeployLink(throwaway, { organizationId: ana.organization.id, created_by_user_id: ana.user.id });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          sessions: await throwaway.selectFrom("sessions").selectAll().orderBy("id").execute(),
          links: await throwaway.selectFrom("quick_deploy_links").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
        });
        const rowsBefore = await rows();
        expect(rowsBefore.sessions).toHaveLength(1);

        await migrate(1);
        const after = await catalog();
        /** sessions.revoked_reason's column, as a catalogue lists it. */
        const revokedReasonColumn = (catalogue: Catalog) =>
          catalogue.columns
            .map((item) => JSON.parse(item) as Record<string, unknown>)
            .find((item) => item.relation === "sessions" && item.name === "revoked_reason")!;
        // Nothing that was there changed, but revoked_reason's comment; no row changed, and no settings row was made (lazy).
        expect(only(before, after)).toEqual({ ...emptySections, columns: [revokedReasonColumn(before)] });
        expect(revokedReasonColumn(after)).toEqual({ ...revokedReasonColumn(before), comment: expect.any(String) });
        const reasons = String(revokedReasonColumn(after).comment).replace(/\s+/g, " ");
        for (const word of [
          "one of logout, sign_out_everywhere, refresh_token_reused, password_reset, account_taken_over",
          "organization_access_lost",
          "or signed_out_elsewhere (one session signed out from Settings › Account, D21 decision 40)",
          "Text rather than an enum until a third consumer needs to branch on it.",
        ]) {
          expect(reasons).toContain(word);
        }
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("user_settings").selectAll().execute()).toEqual([]);

        const add = only(after, before);
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.policies).toEqual([]);
        expect(add.functions).toEqual([]);
        expect(add.triggers).toEqual([]);
        expect(add.relations.map(({ name, kind, rls, force }) => ({ name, kind, rls, force })).sort(byName)).toEqual([
          { name: "user_settings", kind: "r", rls: false, force: false },
          { name: "user_settings_pkey", kind: "i", rls: false, force: false },
        ]);
        // No grant in the migration: migration 009's default privileges give the API's role its four.
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(add.relations.find((relation) => relation.name === "user_settings")!.acl).toEqual([
          `${owner}=arwdDxtm/${owner}`,
          `telflo_platform_runtime=arwd/${owner}`,
        ]);
        const settingsColumns = add.columns.filter((column) => column.relation === "user_settings");
        expect(add.columns.filter((column) => column.relation !== "user_settings")).toEqual([revokedReasonColumn(after)]);
        expect(
          settingsColumns
            .map(({ relation, name, type, notNull, default: fallback, acl }) => ({ relation, name, type, notNull, default: fallback, acl }))
            .sort(byName),
        ).toEqual([
          { relation: "user_settings", name: "created_at", type: "timestamp with time zone", notNull: true, default: null, acl: null },
          { relation: "user_settings", name: "preferences", type: "jsonb", notNull: true, default: "'{}'::jsonb", acl: null },
          { relation: "user_settings", name: "theme", type: "text", notNull: true, default: "'dark'::text", acl: null },
          { relation: "user_settings", name: "updated_at", type: "timestamp with time zone", notNull: true, default: null, acl: null },
          { relation: "user_settings", name: "user_id", type: "uuid", notNull: true, default: null, acl: null },
        ]);
        expect(String(settingsColumns.find((column) => column.name === "theme")!.comment)).toBe(
          "light, dark or navy; dark when there is no row.",
        );
        expect(String(settingsColumns.find((column) => column.name === "preferences")!.comment).replace(/\s+/g, " ")).toBe(
          "only the editor and email keys ever saved; read through the API's schema, which fills in defaults and reads a bad key as its default (D21 decision 19).",
        );
        expect(add.indexes).toEqual([
          {
            name: "user_settings_pkey",
            definition: "CREATE UNIQUE INDEX user_settings_pkey ON platform.user_settings USING btree (user_id)",
          },
        ]);

        // Every new column and constraint (but a not-null one) is commented, and the table.
        const uncommented = [
          ...add.relations.filter((relation) => relation.kind === "r"),
          ...settingsColumns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        // Postgres 18 lists a not-null as a constraint (uncommented, as every not-null is), the primary key's column's included.
        expect(add.constraints.filter((constraint) => constraint.type === "n").sort(byName)).toEqual(
          ["created_at", "preferences", "theme", "updated_at", "user_id"].map((column) => ({
            relation: "user_settings",
            name: `user_settings_${column}_not_null`,
            type: "n",
            definition: `NOT NULL ${column}`,
            deferrable: false,
            deferred: false,
            comment: null,
          })),
        );
        expect(
          Object.fromEntries(
            add.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          user_settings_pkey: "PRIMARY KEY (user_id)",
          user_settings_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
          ck_user_settings_theme: "CHECK ((theme = ANY (ARRAY['light'::text, 'dark'::text, 'navy'::text])))",
          ck_user_settings_preferences:
            "CHECK (((jsonb_typeof(preferences) = 'object'::text) AND (octet_length((preferences)::text) <= 4096)))",
        });

        // down drops the table with its rows and restores migration 010's comment: migration 033's catalogue exactly; up again.
        const at = new Date();
        await throwaway
          .insertInto("user_settings")
          .values({ user_id: ana.user.id, theme: "navy", created_at: at, updated_at: at })
          .execute();
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("user_settings").selectAll().execute()).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the service accounts migration adds users.kind with its two checks and four triggers, service_accounts and api_tokens with row-level security, the API's role's four privileges by default, and find_live_api_token_by_hash executable only by telflo_platform_runtime, each commented, and changes no other object or row; its down restores migration 034's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /**
         * Everything in the platform schema a migration can add or change, as the user settings migration's test reads
         * it, and the types (Preflight ruling 1): an enum's labels, its grants and its comment.
         */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const emptySections = {
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        };
        const byName = (x: Record<string, unknown>, y: Record<string, unknown>) => String(x.name).localeCompare(String(y.name));
        /** A row without its kind, which only migration 035's users have. */
        const withoutKind = (row: object) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "kind"));

        // Through 1700000000034_user_settings, with a person, their session, their identity and their settings.
        await migrate(35);
        const before = await catalog();
        expect(before.types.map((item) => JSON.parse(item).name)).not.toContain("user_kind");
        const ana = await createUserWithOrganization(throwaway);
        await throwaway.insertInto("sessions").values({ user_id: ana.user.id, active_organization_id: ana.organization.id }).execute();
        await throwaway
          .insertInto("user_identities")
          .values({ user_id: ana.user.id, provider: "google", provider_subject: "subject-1", email: ana.user.email })
          .execute();
        const at = new Date();
        await throwaway.insertInto("user_settings").values({ user_id: ana.user.id, created_at: at, updated_at: at }).execute();
        const rows = async () => ({
          users: (await throwaway.selectFrom("users").selectAll().orderBy("id").execute()).map(withoutKind),
          organizations: await throwaway.selectFrom("organizations").selectAll().orderBy("id").execute(),
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          sessions: await throwaway.selectFrom("sessions").selectAll().orderBy("id").execute(),
          identities: await throwaway.selectFrom("user_identities").selectAll().orderBy("id").execute(),
          settings: await throwaway.selectFrom("user_settings").selectAll().orderBy("user_id").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
          flows: await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute(),
        });
        const rowsBefore = await rows();
        expect(rowsBefore.users).toHaveLength(1);

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed, and no row but for the users' new column, human for every one.
        expect(only(before, after)).toEqual(emptySections);
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("users").select("kind").distinct().execute()).toEqual([{ kind: "human" }]);

        const add = only(after, before);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(add.defaultPrivileges).toEqual([]);
        expect(add.types.map(({ name, type, labels, acl }) => ({ name, type, labels, acl })).sort(byName)).toEqual([
          { name: "api_token_access", type: "e", labels: ["read", "write"], acl: null },
          { name: "user_kind", type: "e", labels: ["human", "service"], acl: null },
        ]);
        expect(add.relations.map(({ name, kind, rls, force }) => ({ name, kind, rls, force })).sort(byName)).toEqual([
          { name: "api_tokens", kind: "r", rls: true, force: false },
          { name: "api_tokens_pkey", kind: "i", rls: false, force: false },
          { name: "idx_api_tokens_service_account_user_id_created_at", kind: "i", rls: false, force: false },
          { name: "idx_service_accounts_organization_id_created_at", kind: "i", rls: false, force: false },
          { name: "service_accounts", kind: "r", rls: true, force: false },
          { name: "service_accounts_pkey", kind: "i", rls: false, force: false },
          { name: "uq_api_tokens_service_account_user_id_lower_name", kind: "i", rls: false, force: false },
          { name: "uq_api_tokens_token_hash", kind: "i", rls: false, force: false },
          { name: "uq_service_accounts_organization_id_lower_name", kind: "i", rls: false, force: false },
          { name: "uq_service_accounts_user_id_organization_id", kind: "i", rls: false, force: false },
        ]);
        // No grant in the migration: migration 009's default privileges give the API's role its four, on both tables.
        for (const table of ["service_accounts", "api_tokens"]) {
          expect({ table, acl: add.relations.find((relation) => relation.name === table)!.acl }).toEqual({
            table,
            acl: [`${owner}=arwdDxtm/${owner}`, `telflo_platform_runtime=arwd/${owner}`],
          });
        }
        const timestamp = "timestamp with time zone";
        expect(
          add.columns
            .map(({ relation, name, type, notNull, default: fallback, acl }) => ({ relation, name, type, notNull, default: fallback, acl }))
            .sort((x, y) => `${String(x.relation)}.${String(x.name)}`.localeCompare(`${String(y.relation)}.${String(y.name)}`)),
        ).toEqual([
          { relation: "api_tokens", name: "access", type: "api_token_access", notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "created_at", type: timestamp, notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "created_by_user_id", type: "uuid", notNull: false, default: null, acl: null },
          { relation: "api_tokens", name: "expires_at", type: timestamp, notNull: false, default: null, acl: null },
          { relation: "api_tokens", name: "id", type: "uuid", notNull: true, default: "uuidv7()", acl: null },
          { relation: "api_tokens", name: "last_used_at", type: timestamp, notNull: false, default: null, acl: null },
          { relation: "api_tokens", name: "name", type: "text", notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "organization_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "revoked_at", type: timestamp, notNull: false, default: null, acl: null },
          { relation: "api_tokens", name: "revoked_by_user_id", type: "uuid", notNull: false, default: null, acl: null },
          { relation: "api_tokens", name: "service_account_user_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "token_hash", type: "text", notNull: true, default: null, acl: null },
          { relation: "api_tokens", name: "token_prefix", type: "text", notNull: true, default: null, acl: null },
          { relation: "service_accounts", name: "created_at", type: timestamp, notNull: true, default: null, acl: null },
          { relation: "service_accounts", name: "created_by_user_id", type: "uuid", notNull: false, default: null, acl: null },
          { relation: "service_accounts", name: "deleted_at", type: timestamp, notNull: false, default: null, acl: null },
          { relation: "service_accounts", name: "name", type: "text", notNull: true, default: null, acl: null },
          { relation: "service_accounts", name: "organization_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "service_accounts", name: "updated_at", type: timestamp, notNull: true, default: null, acl: null },
          { relation: "service_accounts", name: "user_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "users", name: "kind", type: "user_kind", notNull: true, default: "'human'::user_kind", acl: null },
        ]);
        expect(add.indexes.sort(byName)).toEqual([
          {
            name: "api_tokens_pkey",
            definition: "CREATE UNIQUE INDEX api_tokens_pkey ON platform.api_tokens USING btree (id)",
          },
          {
            name: "idx_api_tokens_service_account_user_id_created_at",
            definition:
              "CREATE INDEX idx_api_tokens_service_account_user_id_created_at ON platform.api_tokens USING btree (service_account_user_id, created_at DESC, id DESC)",
          },
          {
            name: "idx_service_accounts_organization_id_created_at",
            definition:
              "CREATE INDEX idx_service_accounts_organization_id_created_at ON platform.service_accounts USING btree (organization_id, created_at DESC, user_id DESC)",
          },
          {
            name: "service_accounts_pkey",
            definition: "CREATE UNIQUE INDEX service_accounts_pkey ON platform.service_accounts USING btree (user_id)",
          },
          {
            name: "uq_api_tokens_service_account_user_id_lower_name",
            definition:
              "CREATE UNIQUE INDEX uq_api_tokens_service_account_user_id_lower_name ON platform.api_tokens USING btree (service_account_user_id, lower(name)) WHERE (revoked_at IS NULL)",
          },
          {
            name: "uq_api_tokens_token_hash",
            definition: "CREATE UNIQUE INDEX uq_api_tokens_token_hash ON platform.api_tokens USING btree (token_hash)",
          },
          {
            name: "uq_service_accounts_organization_id_lower_name",
            definition:
              "CREATE UNIQUE INDEX uq_service_accounts_organization_id_lower_name ON platform.service_accounts USING btree (organization_id, lower(name)) WHERE (deleted_at IS NULL)",
          },
          {
            name: "uq_service_accounts_user_id_organization_id",
            definition:
              "CREATE UNIQUE INDEX uq_service_accounts_user_id_organization_id ON platform.service_accounts USING btree (user_id, organization_id)",
          },
        ]);
        const contextOrganization = "(organization_id = (NULLIF(current_setting('telflo.organization_id'::text, true), ''::text))::uuid)";
        expect(
          add.policies
            .map(({ relation, name, cmd, roles, qual, withCheck }) => ({ relation, name, cmd, roles, qual, withCheck }))
            .sort(byName),
        ).toEqual(
          ["api_tokens", "service_accounts"].flatMap((relation) => [
            { relation, name: `${relation}_delete`, cmd: "DELETE", roles: ["telflo_platform_runtime"], qual: contextOrganization, withCheck: null },
            { relation, name: `${relation}_insert`, cmd: "INSERT", roles: ["telflo_platform_runtime"], qual: null, withCheck: contextOrganization },
            { relation, name: `${relation}_select`, cmd: "SELECT", roles: ["telflo_platform_runtime"], qual: contextOrganization, withCheck: null },
            {
              relation,
              name: `${relation}_update`,
              cmd: "UPDATE",
              roles: ["telflo_platform_runtime"],
              qual: contextOrganization,
              withCheck: contextOrganization,
            },
          ]),
        );
        expect(
          add.functions
            .map(({ signature, isDefiner, volatility, config, acl }) => ({ signature, isDefiner, volatility, config, acl }))
            .sort((x, y) => String(x.signature).localeCompare(String(y.signature))),
        ).toEqual([
          {
            signature: "find_live_api_token_by_hash(text,timestamp with time zone)",
            isDefiner: true,
            volatility: "s",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
          },
          ...["refuse_human_service_account()", "refuse_service_account_identity()", "refuse_service_account_session()", "refuse_user_kind_change()"].map(
            (signature) => ({ signature, isDefiner: false, volatility: "v", config: ["search_path=platform, pg_temp"], acl: null }),
          ),
        ]);
        // What the definer answers, and nothing more (decision 18): not the token's name.
        const { rows: returned } = await sql<{ name: string; type: string }>`
          select a.name, a.type
            from pg_proc p,
                 unnest(p.proargnames[3:], (select array_agg(format_type(t, null)) from unnest(p.proallargtypes[3:]) t)) as a(name, type)
           where p.proname = 'find_live_api_token_by_hash'`.execute(throwaway);
        expect(returned).toEqual([
          { name: "token_id", type: "uuid" },
          { name: "organization_id", type: "uuid" },
          { name: "service_account_user_id", type: "uuid" },
          { name: "access", type: "api_token_access" },
          { name: "role", type: "organization_role" },
        ]);
        expect(add.triggers.map(({ relation, name, definition, enabled }) => ({ relation, name, definition, enabled })).sort(byName)).toEqual([
          {
            relation: "service_accounts",
            name: "service_accounts_service_only",
            definition:
              "CREATE TRIGGER service_accounts_service_only BEFORE INSERT OR UPDATE OF user_id ON platform.service_accounts FOR EACH ROW EXECUTE FUNCTION refuse_human_service_account()",
            enabled: "O",
          },
          {
            relation: "sessions",
            name: "sessions_human_only",
            definition:
              "CREATE TRIGGER sessions_human_only BEFORE INSERT OR UPDATE OF user_id ON platform.sessions FOR EACH ROW EXECUTE FUNCTION refuse_service_account_session()",
            enabled: "O",
          },
          {
            relation: "user_identities",
            name: "user_identities_human_only",
            definition:
              "CREATE TRIGGER user_identities_human_only BEFORE INSERT OR UPDATE OF user_id ON platform.user_identities FOR EACH ROW EXECUTE FUNCTION refuse_service_account_identity()",
            enabled: "O",
          },
          {
            relation: "users",
            name: "users_kind_immutable",
            definition: "CREATE TRIGGER users_kind_immutable BEFORE UPDATE OF kind ON platform.users FOR EACH ROW EXECUTE FUNCTION refuse_user_kind_change()",
            enabled: "O",
          },
        ]);

        // Every new table, column, constraint (but a not-null one), index (but those backing a constraint, which the
        // constraint's comment covers), policy, function, trigger and type is commented.
        const constraintNames = new Set(add.constraints.map((constraint) => constraint.name));
        const uncommented = [
          ...add.relations.filter((relation) => !constraintNames.has(relation.name)),
          ...add.columns,
          ...add.constraints.filter((constraint) => constraint.type !== "n"),
          ...add.policies,
          ...add.functions,
          ...add.triggers,
          ...add.types,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);
        // Postgres 18 lists a not-null as a constraint (uncommented, as every not-null is).
        expect(
          add.constraints
            .filter((constraint) => constraint.type === "n")
            .map(({ relation, name }) => `${String(relation)}.${String(name)}`)
            .sort(),
        ).toEqual(
          [
            ...["access", "created_at", "id", "name", "organization_id", "service_account_user_id", "token_hash", "token_prefix"].map(
              (column) => `api_tokens.api_tokens_${column}_not_null`,
            ),
            ...["created_at", "name", "organization_id", "updated_at", "user_id"].map(
              (column) => `service_accounts.service_accounts_${column}_not_null`,
            ),
            "users.users_kind_not_null",
          ].sort(),
        );
        expect(
          Object.fromEntries(
            add.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          ck_users_service_account_credentials:
            "CHECK (((kind = 'human'::user_kind) OR ((password_hash IS NULL) AND (email_verified_at IS NOT NULL))))",
          ck_users_service_account_domain:
            "CHECK (((kind = 'service'::user_kind) = (lower(email) ~~ '%@service-accounts.telflo.invalid'::text)))",
          service_accounts_pkey: "PRIMARY KEY (user_id)",
          service_accounts_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
          service_accounts_organization_id_fkey: "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
          service_accounts_created_by_user_id_fkey: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          uq_service_accounts_user_id_organization_id: "UNIQUE (user_id, organization_id)",
          ck_service_accounts_name: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64)))",
          ck_service_accounts_deleted_after_created: "CHECK ((deleted_at >= created_at))",
          api_tokens_pkey: "PRIMARY KEY (id)",
          api_tokens_organization_id_fkey: "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
          api_tokens_created_by_user_id_fkey: "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          api_tokens_revoked_by_user_id_fkey: "FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          fk_api_tokens_service_account:
            "FOREIGN KEY (service_account_user_id, organization_id) REFERENCES service_accounts(user_id, organization_id) ON DELETE CASCADE",
          ck_api_tokens_name: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64)))",
          ck_api_tokens_token_hash: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
          ck_api_tokens_token_prefix: "CHECK ((token_prefix ~ '^tf_[A-Za-z0-9_-]{8}$'::text))",
          ck_api_tokens_expires_after_created: "CHECK ((expires_at > created_at))",
          ck_api_tokens_last_used_after_created: "CHECK ((last_used_at >= created_at))",
          ck_api_tokens_revoked_after_created: "CHECK ((revoked_at >= created_at))",
          ck_api_tokens_revoked_by: "CHECK (((revoked_at IS NOT NULL) OR (revoked_by_user_id IS NULL)))",
        });

        // down refuses while a service account exists (Preflight ruling 1), naming a count only, and changes nothing.
        const group = await addMembership(throwaway, { userId: ana.user.id });
        const bot = await addServiceAccount(throwaway, { organizationId: group.organization.id, createdByUserId: ana.user.id });
        await addApiToken(throwaway, { organizationId: group.organization.id, serviceAccountUserId: bot.user.id });
        await expect(migrateDown(1)).rejects.toThrow("cannot restore migration 034's users: 1 user(s) are service accounts");
        expect(await catalog()).toEqual(after);
        // An operator's hard delete of the account takes its row, its membership and its token with it.
        await throwaway.deleteFrom("users").where("id", "=", bot.user.id).execute();
        await throwaway.deleteFrom("organizations").where("id", "=", group.organization.id).execute();
        expect(await throwaway.selectFrom("service_accounts").selectAll().execute()).toEqual([]);
        expect(await throwaway.selectFrom("api_tokens").selectAll().execute()).toEqual([]);

        // down then drops exactly what up added: migration 034's catalogue and rows exactly.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        // Without the check, a person at the reserved domain goes in, and up then refuses the database, changing nothing.
        const squatter = await createUserWithOrganization(throwaway, { user: { email: "Someone@Service-Accounts.Telflo.Invalid" } });
        await expect(migrate(1)).rejects.toThrow(
          'check constraint "ck_users_service_account_domain" of relation "users" is violated by some row',
        );
        expect(await catalog()).toEqual(before);
        await throwaway.deleteFrom("users").where("id", "=", squatter.user.id).execute();
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("service_accounts").selectAll().execute()).toEqual([]);
        expect(await throwaway.selectFrom("api_tokens").selectAll().execute()).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the organization logos migration adds organizations.logo_id and logo_content_type (nullable, commented; existing rows without a logo) and ck_organizations_logo (commented), and changes no other object or row; its down restores migration 035's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the public install links migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const emptySections = { relations: [], constraints: [], indexes: [], policies: [], functions: [], triggers: [], defaultPrivileges: [] };

        // Through 1700000000035_service_accounts, with a personal and a deleted group organization already there.
        await migrate(36);
        const before = await catalog();
        await createUserWithOrganization(throwaway);
        await throwaway
          .insertInto("organizations")
          .values({ name: "Acme", type: "group", owner_user_id: null, deleted_at: new Date() })
          .execute();
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        /** Every organization, every column, as the table holds it then. */
        const organizations = async () =>
          (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows;
        const rowsBefore = await rows();
        const organizationsBefore = await organizations();
        expect(organizationsBefore).toHaveLength(2);

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed; only the two columns and the check were added.
        expect(only(before, after)).toEqual({ ...emptySections, columns: [] });
        const added = only(after, before);
        expect({ ...added, columns: [], constraints: [] }).toEqual({ ...emptySections, columns: [], constraints: [] });
        expect(added.columns.map((item) => item.name).sort()).toEqual(["logo_content_type", "logo_id"]);
        const column = (name: string) => added.columns.find((item) => item.name === name)!;
        expect(column("logo_id")).toMatchObject({ relation: "organizations", type: "uuid", notNull: false, default: null, acl: null });
        expect(column("logo_content_type")).toMatchObject({
          relation: "organizations",
          type: "text",
          notNull: false,
          default: null,
          acl: null,
        });
        for (const word of ["a new one per upload", "organizations/<id>/logos/<logo_id>", "Null: no logo"]) {
          expect(String(column("logo_id").comment).replace(/\s+/g, " ")).toContain(word);
        }
        for (const word of ["read from its first bytes", "image/png, image/jpeg or image/webp", "Null exactly when logo_id is"]) {
          expect(String(column("logo_content_type").comment).replace(/\s+/g, " ")).toContain(word);
        }
        expect(added.constraints).toEqual([
          {
            relation: "organizations",
            name: "ck_organizations_logo",
            type: "c",
            definition: expect.stringContaining("logo_id IS NULL"),
            deferrable: false,
            deferred: false,
            comment: expect.stringContaining("SVG refused"),
          },
        ]);

        // Existing rows have no logo, and no other row changed.
        expect(await rows()).toEqual(rowsBefore);
        expect(await organizations()).toEqual(
          organizationsBefore.map((organization) => ({ ...organization, logo_id: null, logo_content_type: null })),
        );
        const later = await throwaway
          .insertInto("organizations")
          .values({ name: "Later", type: "group", owner_user_id: null })
          .returning("id")
          .executeTakeFirstOrThrow();
        await throwaway
          .updateTable("organizations")
          .set({ logo_id: "0199e000-0000-7000-8000-00000000c002", logo_content_type: "image/webp" })
          .where("id", "=", later.id)
          .execute();
        await expect(
          throwaway.updateTable("organizations").set({ logo_content_type: "image/svg+xml" as never }).where("id", "=", later.id).execute(),
        ).rejects.toThrow(/ck_organizations_logo/);

        // down drops both columns and the check: migration 035's catalogue exactly; up again, no logo anywhere.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);
        expect((await organizations()).filter((organization) => organization.id !== later.id)).toEqual(organizationsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(
          (await throwaway.selectFrom("organizations").select(["logo_id", "logo_content_type"]).execute()).every(
            (organization) => organization.logo_id === null && organization.logo_content_type === null,
          ),
        ).toBe(true);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the library files migration adds library_files (no row-level security, the default grants, its five named checks, its foreign key and two indexes, each commented) and its guard trigger with its function, and changes no other object or row; its down restores migration 036's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the organization logos migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[]) => items.map((item) => String(item.name)).sort();
        const flat = (text: unknown) => String(text).replace(/\s+/g, " ");

        // Through 1700000000036_organization_logos, with a user and their personal organization already there.
        await migrate(37);
        const before = await catalog();
        const { user } = await createUserWithOrganization(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed.
        expect(only(before, after)).toEqual({
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          defaultPrivileges: [],
        });
        const added = only(after, before);
        expect(added.policies).toEqual([]);
        expect(added.defaultPrivileges).toEqual([]);
        expect(names(added.relations)).toEqual([
          "idx_library_files_created_at",
          "idx_library_files_created_by_user_id",
          "library_files",
          "library_files_pkey",
        ]);
        const table = added.relations.find((relation) => relation.name === "library_files")!;
        expect(table).toMatchObject({ kind: "r", rls: false, force: false });
        // Migration 009's default privileges: select, insert, update and delete (a hard delete) for the API's role.
        expect((table.acl as string[]).some((entry) => /^telflo_platform_runtime=arwd\//.test(entry))).toBe(true);
        expect(flat(table.comment)).toContain("Global (ADR 0008)");
        expect(flat(table.comment)).toContain("global/library-files/<id>");

        expect(names(added.columns)).toEqual([
          "created_at",
          "created_by_user_id",
          "description",
          "file_name",
          "id",
          "name",
          "sha256",
          "size_bytes",
          "updated_at",
        ]);
        const column = (name: string) => added.columns.find((item) => item.name === name)!;
        expect(added.columns.every((item) => item.relation === "library_files" && item.acl === null && item.comment !== null)).toBe(true);
        expect(column("id")).toMatchObject({ type: "uuid", notNull: true, default: "uuidv7()" });
        expect(column("name")).toMatchObject({ type: "text", notNull: true, default: null });
        expect(column("description")).toMatchObject({ type: "text", notNull: true, default: "''::text" });
        expect(column("file_name")).toMatchObject({ type: "text", notNull: true, default: null });
        expect(column("size_bytes")).toMatchObject({ type: "integer", notNull: true, default: null });
        expect(column("sha256")).toMatchObject({ type: "bytea", notNull: true, default: null });
        expect(column("created_by_user_id")).toMatchObject({ type: "uuid", notNull: false, default: null });
        expect(column("created_at")).toMatchObject({ type: "timestamp with time zone", notNull: true, default: "now()" });
        expect(column("updated_at")).toMatchObject({ type: "timestamp with time zone", notNull: true, default: "now()" });

        // Postgres 18 lists each NOT NULL as a constraint of its own (contype n): the eight not-null columns'.
        const notNull = added.constraints.filter((item) => item.type === "n");
        expect(names(notNull)).toEqual(
          ["created_at", "description", "file_name", "id", "name", "sha256", "size_bytes", "updated_at"].map(
            (name) => `library_files_${name}_not_null`,
          ),
        );
        added.constraints = added.constraints.filter((item) => item.type !== "n");
        expect(names(added.constraints)).toEqual([
          "ck_library_files_description",
          "ck_library_files_file_name",
          "ck_library_files_name",
          "ck_library_files_sha256",
          "ck_library_files_size_bytes",
          "library_files_created_by_user_id_fkey",
          "library_files_pkey",
        ]);
        expect(added.constraints.every((item) => item.relation === "library_files" && item.comment !== null)).toBe(true);
        const constraint = (name: string) => added.constraints.find((item) => item.name === name)!;
        expect(constraint("library_files_created_by_user_id_fkey").definition).toBe(
          "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
        );
        expect(constraint("ck_library_files_size_bytes").definition).toContain("10485760");
        expect(constraint("ck_library_files_sha256").definition).toContain("32");

        expect(added.indexes).toEqual([
          {
            name: "idx_library_files_created_at",
            definition: "CREATE INDEX idx_library_files_created_at ON platform.library_files USING btree (created_at DESC, id DESC)",
            comment: expect.stringContaining("newest first"),
          },
          {
            name: "idx_library_files_created_by_user_id",
            definition: "CREATE INDEX idx_library_files_created_by_user_id ON platform.library_files USING btree (created_by_user_id)",
            comment: expect.stringContaining("set null"),
          },
          {
            name: "library_files_pkey",
            definition: "CREATE UNIQUE INDEX library_files_pkey ON platform.library_files USING btree (id)",
            comment: null,
          },
        ]);
        expect(added.functions).toEqual([
          expect.objectContaining({
            signature: "refuse_library_file_change()",
            isDefiner: false,
            config: ["search_path=pg_catalog, platform"],
            comment: expect.stringContaining("never change"),
          }),
        ]);
        expect(added.triggers).toEqual([
          {
            relation: "library_files",
            name: "library_files_guard",
            definition:
              "CREATE TRIGGER library_files_guard BEFORE UPDATE ON platform.library_files FOR EACH ROW EXECUTE FUNCTION refuse_library_file_change()",
            enabled: "O",
            comment: expect.stringContaining("before update"),
          },
        ]);

        // No other row changed; the table starts empty, and the guard holds.
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("library_files").selectAll().execute()).toEqual([]);
        const file = await addLibraryFile(throwaway, { created_by_user_id: user.id });
        await expect(
          throwaway.updateTable("library_files").set({ size_bytes: 1 } as never).where("id", "=", file.id).execute(),
        ).rejects.toMatchObject({ code: "P0001" });
        await throwaway.deleteFrom("library_files").execute();

        // down drops the table, its trigger and its function: migration 036's catalogue exactly; up again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the public API tokens migration adds personal_api_tokens (row-level security on the context's user, the default grants, its six named checks, its foreign key and three indexes, each commented) and re-creates find_live_api_token_by_hash with both kinds, its comment and its grants, and changes no other object or row; its down restores migration 037's catalogue exactly, the lookup's definition, comment and grants included; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the service accounts migration's test reads it, with indexes' comments. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[]) => items.map((item) => String(item.name)).sort();
        const flat = (text: unknown) => String(text).replace(/\s+/g, " ");
        const lookupSignature = "find_live_api_token_by_hash(text,timestamp with time zone)";

        // Through 1700000000037_library_files, with a person, a service account and its live token already there.
        await migrate(38);
        const before = await catalog();
        const admin = await createUserWithOrganization(throwaway);
        const group = await addMembership(throwaway, { userId: admin.user.id });
        const bot = await addServiceAccount(throwaway, { organizationId: group.organization.id, createdByUserId: admin.user.id });
        const { apiToken, token } = await addApiToken(throwaway, { organizationId: group.organization.id, serviceAccountUserId: bot.user.id });
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          accounts: await throwaway.selectFrom("service_accounts").selectAll().orderBy("user_id").execute(),
          tokens: await throwaway.selectFrom("api_tokens").selectAll().orderBy("id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        const rowsBefore = await rows();
        const hash = apiToken.token_hash;
        expect(hash.length === 64 && token.startsWith("tf_")).toBe(true);
        /** The lookup's row for the service account's token, as the owner reads it, without printing the token. */
        const lookUp = async () =>
          (await sql<Record<string, unknown>>`select * from find_live_api_token_by_hash(${hash}, now())`.execute(throwaway)).rows;
        expect(await lookUp()).toEqual([
          { token_id: apiToken.id, organization_id: group.organization.id, service_account_user_id: bot.user.id, access: "read", role: "contributor" },
        ]);

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but the lookup, dropped and created again.
        const removed = only(before, after);
        expect({ ...removed, functions: [] }).toEqual({
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        });
        expect(removed.functions.map((item) => item.signature)).toEqual([lookupSignature]);
        const added = only(after, before);
        expect(added.types).toEqual([]);
        expect(added.triggers).toEqual([]);
        expect(added.defaultPrivileges).toEqual([]);
        expect(await rows()).toEqual(rowsBefore);

        // The table: row-level security, not forced; migration 009's default privileges.
        expect(names(added.relations)).toEqual([
          "idx_personal_api_tokens_user_id_created_at",
          "personal_api_tokens",
          "personal_api_tokens_pkey",
          "uq_personal_api_tokens_token_hash",
          "uq_personal_api_tokens_user_id_lower_name",
        ]);
        const table = added.relations.find((relation) => relation.name === "personal_api_tokens")!;
        expect(table).toMatchObject({ kind: "r", rls: true, force: false });
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(table.acl).toEqual([`${owner}=arwdDxtm/${owner}`, `telflo_platform_runtime=arwd/${owner}`]);
        expect(flat(table.comment)).toContain("Belongs to the user, not to an organization");

        const timestamp = "timestamp with time zone";
        expect(
          added.columns
            .map(({ relation, name, type, notNull, default: fallback, acl }) => ({ relation, name, type, notNull, default: fallback, acl }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name))),
        ).toEqual(
          [
            { name: "access", type: "api_token_access", notNull: true, default: null },
            { name: "created_at", type: timestamp, notNull: true, default: null },
            { name: "expires_at", type: timestamp, notNull: false, default: null },
            { name: "id", type: "uuid", notNull: true, default: "uuidv7()" },
            { name: "last_used_at", type: timestamp, notNull: false, default: null },
            { name: "name", type: "text", notNull: true, default: null },
            { name: "revoked_at", type: timestamp, notNull: false, default: null },
            { name: "token_hash", type: "text", notNull: true, default: null },
            { name: "token_prefix", type: "text", notNull: true, default: null },
            { name: "user_id", type: "uuid", notNull: true, default: null },
          ].map((column) => ({ relation: "personal_api_tokens", ...column, acl: null })),
        );

        // Postgres 18 lists a not-null as a constraint (uncommented, as every not-null is).
        expect(names(added.constraints.filter((constraint) => constraint.type === "n"))).toEqual(
          ["access", "created_at", "id", "name", "token_hash", "token_prefix", "user_id"].map(
            (column) => `personal_api_tokens_${column}_not_null`,
          ),
        );
        expect(
          Object.fromEntries(
            added.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          personal_api_tokens_pkey: "PRIMARY KEY (id)",
          personal_api_tokens_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
          ck_personal_api_tokens_name: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64)))",
          ck_personal_api_tokens_token_hash: "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))",
          ck_personal_api_tokens_token_prefix: "CHECK ((token_prefix ~ '^tf_[A-Za-z0-9_-]{8}$'::text))",
          ck_personal_api_tokens_expires_after_created: "CHECK ((expires_at > created_at))",
          ck_personal_api_tokens_last_used_after_created: "CHECK ((last_used_at >= created_at))",
          ck_personal_api_tokens_revoked_after_created: "CHECK ((revoked_at >= created_at))",
        });

        expect(added.indexes.map(({ name, definition }) => ({ name, definition })).sort((x, y) => String(x.name).localeCompare(String(y.name)))).toEqual([
          {
            name: "idx_personal_api_tokens_user_id_created_at",
            definition:
              "CREATE INDEX idx_personal_api_tokens_user_id_created_at ON platform.personal_api_tokens USING btree (user_id, created_at DESC, id DESC)",
          },
          {
            name: "personal_api_tokens_pkey",
            definition: "CREATE UNIQUE INDEX personal_api_tokens_pkey ON platform.personal_api_tokens USING btree (id)",
          },
          {
            name: "uq_personal_api_tokens_token_hash",
            definition: "CREATE UNIQUE INDEX uq_personal_api_tokens_token_hash ON platform.personal_api_tokens USING btree (token_hash)",
          },
          {
            name: "uq_personal_api_tokens_user_id_lower_name",
            definition:
              "CREATE UNIQUE INDEX uq_personal_api_tokens_user_id_lower_name ON platform.personal_api_tokens USING btree (user_id, lower(name)) WHERE (revoked_at IS NULL)",
          },
        ]);

        const contextUser = "(user_id = (NULLIF(current_setting('telflo.user_id'::text, true), ''::text))::uuid)";
        const relation = "personal_api_tokens";
        expect(
          added.policies
            .map(({ relation, name, cmd, roles, qual, withCheck }) => ({ relation, name, cmd, roles, qual, withCheck }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name))),
        ).toEqual([
          { relation, name: `${relation}_delete`, cmd: "DELETE", roles: ["telflo_platform_runtime"], qual: contextUser, withCheck: null },
          { relation, name: `${relation}_insert`, cmd: "INSERT", roles: ["telflo_platform_runtime"], qual: null, withCheck: contextUser },
          { relation, name: `${relation}_select`, cmd: "SELECT", roles: ["telflo_platform_runtime"], qual: contextUser, withCheck: null },
          { relation, name: `${relation}_update`, cmd: "UPDATE", roles: ["telflo_platform_runtime"], qual: contextUser, withCheck: contextUser },
        ]);

        // The lookup: the same signature, its new shape, still a stable definer with a fixed search_path, executable by
        // telflo_platform_runtime only, and its comment restated.
        expect(added.functions).toHaveLength(1);
        const lookup = added.functions[0]!;
        expect({ ...lookup, source: undefined, comment: undefined }).toEqual({
          signature: lookupSignature,
          isDefiner: true,
          volatility: "s",
          config: ["search_path=pg_catalog, platform"],
          acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
          result:
            "TABLE(kind text, token_id uuid, user_id uuid, email text, access api_token_access, organization_id uuid, role organization_role)",
          source: undefined,
          comment: undefined,
        });
        for (const words of ["of either kind", "kind person", "kind human, not deleted", "findLiveApiTokenByHash"]) {
          expect(flat(lookup.comment)).toContain(words);
        }
        // The service account's token answers as before, with its kind and address (decision 21).
        expect(await lookUp()).toEqual([
          {
            kind: "service_account",
            token_id: apiToken.id,
            user_id: bot.user.id,
            email: bot.user.email,
            access: "read",
            organization_id: group.organization.id,
            role: "contributor",
          },
        ]);

        // Every new table, column, constraint (but a not-null one), index (but the primary key's, which its
        // constraint's comment covers), policy and the lookup is commented.
        const uncommented = [
          ...added.relations.filter((item) => item.name !== "personal_api_tokens_pkey"),
          ...added.columns,
          ...added.constraints.filter((constraint) => constraint.type !== "n"),
          ...added.policies,
          ...added.functions,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);

        // down drops the table with its rows and creates migration 035's lookup again: migration 037's catalogue
        // exactly (its definition's md5, its result, comment and grants among it); up again.
        const person = await addPersonalApiToken(throwaway, { userId: admin.user.id });
        expect(person.token.startsWith("tf_")).toBe(true);
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
        expect(await throwaway.selectFrom("personal_api_tokens").selectAll().execute()).toEqual([]);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the product administration migration adds user_feedback (INSERT only for the API's role) and user_deletion_records (nothing for the API's role), both without row-level security, with their named checks, foreign keys and indexes, assert_product_admin (EXECUTE for no one) and the seven product-admin definer functions (EXECUTE for telflo_platform_runtime only, a fixed search_path), each commented, and re-comments users.is_product_admin; changes no other object or row; its down restores migration 040's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the public API tokens migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const names = (items: Record<string, unknown>[]) => items.map((item) => String(item.name)).sort();
        const flat = (text: unknown) => String(text).replace(/\s+/g, " ");

        // Through 1700000000040_yaml_test_runs, with a person and their organization already there.
        await migrate(41);
        const before = await catalog();
        await createUserWithOrganization(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          catalogue: await throwaway.selectFrom("collector_versions").selectAll().orderBy("version").execute(),
          regexes: await throwaway.selectFrom("test_regex").selectAll().orderBy("name").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but users.is_product_admin's comment.
        const removed = only(before, after);
        expect({ ...removed, columns: [] }).toEqual({
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        });
        expect(removed.columns.map(({ relation, name }) => ({ relation, name }))).toEqual([{ relation: "users", name: "is_product_admin" }]);
        const added = only(after, before);
        expect(added.types).toEqual([]);
        expect(added.triggers).toEqual([]);
        expect(added.policies).toEqual([]);
        expect(added.defaultPrivileges).toEqual([]);
        expect(await rows()).toEqual(rowsBefore);
        const flagColumn = added.columns.find((column) => column.relation === "users")!;
        expect(flat(flagColumn.comment)).toContain("product_admin_grant and product_admin_revoke");

        // The two tables: no row-level security; INSERT only, and nothing, for the API's role (Preflight ruling 3).
        expect(names(added.relations)).toEqual([
          "idx_user_deletion_records_deleted_by_user_id",
          "idx_user_feedback_handled_by_user_id",
          "idx_user_feedback_organization_id",
          "idx_user_feedback_pending_created_at",
          "idx_user_feedback_user_id",
          "user_deletion_records",
          "user_deletion_records_pkey",
          "user_feedback",
          "user_feedback_pkey",
        ]);
        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        const feedback = added.relations.find((relation) => relation.name === "user_feedback")!;
        expect(feedback).toMatchObject({ kind: "r", rls: false, force: false });
        expect(feedback.acl).toEqual([`${owner}=arwdDxtm/${owner}`, `telflo_platform_runtime=a/${owner}`]);
        const records = added.relations.find((relation) => relation.name === "user_deletion_records")!;
        expect(records).toMatchObject({ kind: "r", rls: false, force: false });
        expect(records.acl).toEqual([`${owner}=arwdDxtm/${owner}`]);

        const timestamp = "timestamp with time zone";
        expect(
          added.columns
            .filter((column) => column.relation !== "users")
            .map(({ relation, name, type, notNull, default: fallback, acl }) => ({ relation, name, type, notNull, default: fallback, acl }))
            .sort((x, y) => `${String(x.relation)}.${String(x.name)}`.localeCompare(`${String(y.relation)}.${String(y.name)}`)),
        ).toEqual([
          { relation: "user_deletion_records", name: "deleted_at", type: timestamp, notNull: true, default: null, acl: null },
          { relation: "user_deletion_records", name: "deleted_by_user_id", type: "uuid", notNull: false, default: null, acl: null },
          { relation: "user_deletion_records", name: "original_email", type: "text", notNull: true, default: null, acl: null },
          { relation: "user_deletion_records", name: "user_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "user_feedback", name: "created_at", type: timestamp, notNull: true, default: null, acl: null },
          { relation: "user_feedback", name: "handled_at", type: timestamp, notNull: false, default: null, acl: null },
          { relation: "user_feedback", name: "handled_by_user_id", type: "uuid", notNull: false, default: null, acl: null },
          { relation: "user_feedback", name: "id", type: "uuid", notNull: true, default: "uuidv7()", acl: null },
          { relation: "user_feedback", name: "organization_id", type: "uuid", notNull: true, default: null, acl: null },
          { relation: "user_feedback", name: "outcome", type: "text", notNull: false, default: null, acl: null },
          { relation: "user_feedback", name: "text", type: "text", notNull: true, default: null, acl: null },
          { relation: "user_feedback", name: "user_id", type: "uuid", notNull: true, default: null, acl: null },
        ]);

        expect(
          Object.fromEntries(
            added.constraints
              .filter((constraint) => constraint.type !== "n")
              .map((constraint) => [constraint.name, constraint.definition]),
          ),
        ).toEqual({
          user_feedback_pkey: "PRIMARY KEY (id)",
          user_feedback_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
          user_feedback_organization_id_fkey: "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
          user_feedback_handled_by_user_id_fkey: "FOREIGN KEY (handled_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
          ck_user_feedback_text: "CHECK ((((char_length(text) >= 1) AND (char_length(text) <= 5000)) AND (text = btrim(text))))",
          ck_user_feedback_outcome: "CHECK ((outcome = ANY (ARRAY['acknowledged'::text, 'dismissed'::text])))",
          ck_user_feedback_handled_together: "CHECK (((handled_at IS NULL) = (outcome IS NULL)))",
          ck_user_feedback_handled_by_only_when_handled: "CHECK (((handled_by_user_id IS NULL) OR (handled_at IS NOT NULL)))",
          user_deletion_records_pkey: "PRIMARY KEY (user_id)",
          user_deletion_records_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
          user_deletion_records_deleted_by_user_id_fkey: "FOREIGN KEY (deleted_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
        });

        expect(
          Object.fromEntries(added.indexes.map(({ name, definition }) => [name, definition])),
        ).toEqual({
          user_feedback_pkey: "CREATE UNIQUE INDEX user_feedback_pkey ON platform.user_feedback USING btree (id)",
          idx_user_feedback_pending_created_at:
            "CREATE INDEX idx_user_feedback_pending_created_at ON platform.user_feedback USING btree (created_at DESC, id DESC) WHERE (handled_at IS NULL)",
          idx_user_feedback_user_id: "CREATE INDEX idx_user_feedback_user_id ON platform.user_feedback USING btree (user_id)",
          idx_user_feedback_organization_id: "CREATE INDEX idx_user_feedback_organization_id ON platform.user_feedback USING btree (organization_id)",
          idx_user_feedback_handled_by_user_id:
            "CREATE INDEX idx_user_feedback_handled_by_user_id ON platform.user_feedback USING btree (handled_by_user_id)",
          user_deletion_records_pkey: "CREATE UNIQUE INDEX user_deletion_records_pkey ON platform.user_deletion_records USING btree (user_id)",
          idx_user_deletion_records_deleted_by_user_id:
            "CREATE INDEX idx_user_deletion_records_deleted_by_user_id ON platform.user_deletion_records USING btree (deleted_by_user_id)",
        });

        // The gate: EXECUTE for no one. The seven functions: definers, executable by telflo_platform_runtime only.
        const definer = { isDefiner: true, config: ["search_path=pg_catalog, platform"], acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`] };
        expect(
          Object.fromEntries(
            added.functions.map(({ signature, isDefiner, volatility, config, acl, result }) => [
              signature,
              { isDefiner, volatility, config, acl, result },
            ]),
          ),
        ).toEqual({
          "assert_product_admin()": {
            isDefiner: false,
            volatility: "s",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`],
            result: "void",
          },
          "product_admin_list_users(text,timestamp with time zone,uuid,integer,timestamp with time zone)": {
            ...definer,
            volatility: "s",
            result:
              "TABLE(id uuid, email text, created_at timestamp with time zone, is_product_admin boolean, block_kind text, block_organization_name text, block_role organization_role)",
          },
          "product_admin_list_product_admins()": { ...definer, volatility: "s", result: "TABLE(id uuid, email text)" },
          "product_admin_grant(text,timestamp with time zone)": {
            ...definer,
            volatility: "v",
            result: "TABLE(outcome text, user_id uuid, email text)",
          },
          "product_admin_revoke(uuid,timestamp with time zone)": { ...definer, volatility: "v", result: "text" },
          "product_admin_list_feedback(timestamp with time zone,uuid,integer)": {
            ...definer,
            volatility: "s",
            result: "TABLE(id uuid, email text, text text, created_at timestamp with time zone, author_deleted boolean)",
          },
          "product_admin_count_pending_feedback()": { ...definer, volatility: "s", result: "integer" },
          "product_admin_handle_feedback(uuid,text,timestamp with time zone)": {
            ...definer,
            volatility: "v",
            result: "TABLE(outcome text, user_id uuid, email text)",
          },
        });

        // Every new table, column, constraint (but a not-null one), index (but the primary keys', which their
        // constraints' comments cover) and function is commented.
        const uncommented = [
          ...added.relations.filter((item) => !String(item.name).endsWith("_pkey")),
          ...added.columns,
          ...added.constraints.filter((constraint) => constraint.type !== "n"),
          ...added.functions,
        ].filter((item) => item.comment === null);
        expect(uncommented).toEqual([]);

        // The gate's refusal carries its own HINT (Ruling 260), at both of its raises, and its comment names it.
        const gate = (
          await sql<{ source: string }>`select prosrc as source from pg_proc where oid = 'assert_product_admin()'::regprocedure`.execute(throwaway)
        ).rows[0]!.source;
        expect(gate.split("hint = 'telflo_product_admin_gate'").length - 1).toBe(2);
        expect(flat(added.functions.find((item) => item.signature === "assert_product_admin()")!.comment)).toContain("telflo_product_admin_gate");

        // down: migration 040's catalogue exactly, and the rows as they were; up again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the product-admin delete migration adds product_admin_delete_account (a definer with a fixed search_path, EXECUTE for telflo_platform_runtime only, commented) and account_deleted to sessions.revoked_reason's comment, and changes no other object or row; its down restores migration 041's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the public API tokens migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const flat = (text: unknown) => String(text).replace(/\s+/g, " ");

        // Through 1700000000041_product_administration, with a person and their organization already there.
        await migrate(42);
        const before = await catalog();
        await createUserWithOrganization(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          members: await throwaway.selectFrom("organization_members").selectAll().orderBy("user_id").execute(),
          sessions: await throwaway.selectFrom("sessions").selectAll().orderBy("id").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but sessions.revoked_reason's comment.
        const removed = only(before, after);
        expect({ ...removed, columns: [] }).toEqual({
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        });
        expect(removed.columns.map(({ relation, name }) => ({ relation, name }))).toEqual([{ relation: "sessions", name: "revoked_reason" }]);
        const added = only(after, before);
        expect({ ...added, columns: [], functions: [] }).toEqual({
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        });
        expect(added.columns.map(({ relation, name }) => ({ relation, name }))).toEqual([{ relation: "sessions", name: "revoked_reason" }]);
        expect(flat(added.columns[0]!.comment)).toContain("signed_out_elsewhere (one session signed out from Settings › Account, D21 decision 40) or account_deleted");
        expect(await rows()).toEqual(rowsBefore);

        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(
          added.functions.map(({ signature, isDefiner, volatility, config, acl, result }) => ({ signature, isDefiner, volatility, config, acl, result })),
        ).toEqual([
          {
            signature: "product_admin_delete_account(uuid,timestamp with time zone)",
            isDefiner: true,
            volatility: "v",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
            result:
              "TABLE(outcome text, block_kind text, organizations jsonb, deleted_service_accounts integer, revoked_sessions integer)",
          },
        ]);
        expect(added.functions[0]!.comment).not.toBeNull();
        // The gate first, the restart's own SQLSTATE caught and nothing else.
        const source = (
          await sql<{ source: string }>`select prosrc as source from pg_proc where proname = 'product_admin_delete_account'`.execute(throwaway)
        ).rows[0]!.source;
        expect(source.trim().startsWith("declare")).toBe(true);
        expect(source.indexOf("perform platform.assert_product_admin()")).toBeLessThan(source.indexOf("p_user_id is null"));
        expect(source.match(/when\s+\S+\s+\S+\s+then/gi)).toEqual(["when sqlstate 'TFR01' then"]);
        expect(/when\s+others/i.test(source)).toBe(false);
        // Ruling 266: one anonymous address, for the email and the personal organization's name; the person's sessions forget their client.
        expect(source.match(/gen_random_bytes/g)?.length).toBe(1);
        expect(/name = case when type = 'personal' and owner_user_id = p_user_id\s+then anonymous \|\| '''s workspace'/.test(source)).toBe(true);
        expect(/ip_address = null, user_agent = null/.test(source)).toBe(true);
        // Ruling 267: the deleted organizations' invitations to the original email take the anonymous address.
        expect(/update platform\.organization_invitations\s+set email = anonymous, updated_at = p_at\s+where organization_id = any \(locked\) and lower\(email\) = lower\(original\)/.test(source)).toBe(true);

        // down: migration 041's catalogue exactly, and the rows as they were; up again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the first product admin migration adds bootstrap_first_product_admin (a definer with a fixed search_path, EXECUTE for telflo_platform_runtime only, commented) and rewrites users.accepted_terms_version's and users.is_product_admin's comments, and changes no other object or row; its down restores migration 042's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the product-admin delete migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const flat = (text: unknown) => String(text).replace(/\s+/g, " ");
        const nothing = {
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        };

        // Through 1700000000042_product_admin_delete_account, with a person and their organization already there.
        await migrate(43);
        const before = await catalog();
        await createUserWithOrganization(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          audits: await throwaway.selectFrom("audit_events").selectAll().orderBy("id").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed but the two columns' comments.
        const removed = only(before, after);
        expect({ ...removed, columns: [] }).toEqual(nothing);
        const commented = [
          { relation: "users", name: "accepted_terms_version" },
          { relation: "users", name: "is_product_admin" },
        ];
        expect(removed.columns.map(({ relation, name }) => ({ relation, name }))).toEqual(commented);
        const added = only(after, before);
        expect({ ...added, columns: [], functions: [] }).toEqual(nothing);
        expect(added.columns.map(({ relation, name }) => ({ relation, name }))).toEqual(commented);
        const terms = flat(added.columns.find((column) => column.name === "accepted_terms_version")!.comment);
        expect(terms).toContain("TELFLO_TERMS_VERSION");
        expect(terms).not.toContain("CURRENT_TERMS_VERSION");
        expect(flat(added.columns.find((column) => column.name === "is_product_admin")!.comment)).toContain(
          "bootstrap_first_product_admin",
        );
        // The removed comments are migration 007's and 041's, word for word.
        expect(flat(removed.columns.find((column) => column.name === "accepted_terms_version")!.comment)).toContain(
          "The current version is CURRENT_TERMS_VERSION in @telflo/contracts",
        );
        expect(await rows()).toEqual(rowsBefore);

        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(
          added.functions.map(({ signature, isDefiner, volatility, config, acl, result }) => ({ signature, isDefiner, volatility, config, acl, result })),
        ).toEqual([
          {
            signature: "bootstrap_first_product_admin(uuid,timestamp with time zone)",
            isDefiner: true,
            volatility: "v",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
            result: "void",
          },
        ]);
        expect(added.functions[0]!.comment).not.toBeNull();
        // The nulls first, then the lock, then the check, then the write; schema-qualified tables only.
        const source = (
          await sql<{ source: string }>`select prosrc as source from pg_proc where proname = 'bootstrap_first_product_admin'`.execute(throwaway)
        ).rows[0]!.source;
        const lock = source.indexOf("perform pg_advisory_xact_lock(hashtext('telflo.bootstrap_first_product_admin'))");
        expect(lock).toBeGreaterThan(source.indexOf("p_user_id is null or p_at is null"));
        expect(lock).toBeLessThan(source.indexOf("where u.is_product_admin"));
        expect(source.indexOf("where u.is_product_admin")).toBeLessThan(source.indexOf("update platform.users"));
        expect(source.match(/advisory/g)?.length).toBe(1);
        expect(/\b(?:from|update|insert\s+into)\s+(?!platform\.)\w/.test(source)).toBe(false);

        // down: migration 042's catalogue exactly, and the rows as they were; up again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    it("the site settings migration adds site_settings (one row, product_admins by default (Q259), SELECT only for the API's role, no row-level security) and product_admin_set_organization_creation (a definer with a fixed search_path, EXECUTE for telflo_platform_runtime only, gated by assert_product_admin), each commented, and changes no other object or row; its down restores migration 043's catalogue exactly; and it applies again", async () => {
      await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
        /** Rows of a catalog query, each as one comparable JSON text, sorted. */
        const listed = async (query: ReturnType<typeof sql<Record<string, unknown>>>) =>
          (await query.execute(throwaway)).rows.map((row) => JSON.stringify(row)).sort();
        /** Everything in the platform schema a migration can add or change, as the first product admin migration's test reads it. */
        const catalog = async () => ({
          relations: await listed(sql`
            select c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls,
                   c.relforcerowsecurity as force, c.relacl::text[] as acl, obj_description(c.oid, 'pg_class') as comment
              from pg_class c where c.relnamespace = 'platform'::regnamespace`),
          columns: await listed(sql`
            select a.attrelid::regclass::text as relation, a.attname::text as name,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
                   pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment,
                   a.attacl::text[] as acl
              from pg_attribute a
              join pg_class c on c.oid = a.attrelid
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where c.relnamespace = 'platform'::regnamespace and c.relkind in ('r', 'p', 'v')
               and a.attnum > 0 and not a.attisdropped`),
          constraints: await listed(sql`
            select conrelid::regclass::text as relation, conname::text as name, contype::text as type,
                   pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred,
                   obj_description(oid, 'pg_constraint') as comment
              from pg_constraint where connamespace = 'platform'::regnamespace`),
          indexes: await listed(sql`
            select i.indexname::text as name, i.indexdef as definition,
                   obj_description(to_regclass(i.indexname::text), 'pg_class') as comment
              from pg_indexes i where i.schemaname = 'platform'`),
          policies: await listed(sql`
            select p.tablename::text as relation, p.policyname::text as name, p.cmd, p.roles::text[] as roles,
                   p.qual, p.with_check as "withCheck", obj_description(pp.oid, 'pg_policy') as comment
              from pg_policies p
              join pg_policy pp on pp.polname = p.policyname and pp.polrelid = to_regclass(p.tablename::text)
             where p.schemaname = 'platform'`),
          functions: await listed(sql`
            select p.oid::regprocedure::text as signature, p.prosecdef as "isDefiner", p.provolatile::text as volatility,
                   p.proconfig as config, p.proacl::text[] as acl, md5(p.prosrc) as source,
                   pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as comment
              from pg_proc p where p.pronamespace = 'platform'::regnamespace`),
          triggers: await listed(sql`
            select tgrelid::regclass::text as relation, tgname::text as name, pg_get_triggerdef(oid) as definition,
                   tgenabled::text as enabled, obj_description(oid, 'pg_trigger') as comment
              from pg_trigger where not tgisinternal`),
          types: await listed(sql`
            select t.typname::text as name, t.typtype::text as type,
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
                   t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment
              from pg_type t
             where t.typnamespace = 'platform'::regnamespace and t.typtype in ('e', 'd', 'c')
               and not exists (select 1 from pg_class c where c.reltype = t.oid)`),
          defaultPrivileges: await listed(sql`
            select defaclrole::regrole::text as role, defaclobjtype::text as type, defaclacl::text[] as acl
              from pg_default_acl`),
        });
        type Catalog = Awaited<ReturnType<typeof catalog>>;
        /** What `from` holds that `to` doesn't, by section, parsed back. */
        const only = (from: Catalog, to: Catalog) =>
          Object.fromEntries(
            Object.entries(from).map(([section, items]) => [
              section,
              items
                .filter((item) => !to[section as keyof Catalog].includes(item))
                .map((item) => JSON.parse(item) as Record<string, unknown>),
            ]),
          ) as Record<keyof Catalog, Record<string, unknown>[]>;
        const nothing = {
          relations: [],
          columns: [],
          constraints: [],
          indexes: [],
          policies: [],
          functions: [],
          triggers: [],
          types: [],
          defaultPrivileges: [],
        };

        // Through 1700000000043_first_product_admin, with a person and their organization already there.
        await migrate(44);
        const before = await catalog();
        await createUserWithOrganization(throwaway);
        const rows = async () => ({
          users: await throwaway.selectFrom("users").selectAll().orderBy("id").execute(),
          organizations: (await sql<Record<string, unknown>>`select * from organizations order by id`.execute(throwaway)).rows,
          audits: await throwaway.selectFrom("audit_events").selectAll().orderBy("id").execute(),
        });
        const rowsBefore = await rows();

        await migrate(1);
        const after = await catalog();
        // Nothing that was there changed.
        expect(only(before, after)).toEqual(nothing);
        const added = only(after, before);
        const names = (items: Record<string, unknown>[]) => items.map((item) => item.name).sort();
        expect(names(added.relations)).toEqual(["site_settings", "site_settings_pkey"]);
        expect(added.relations.find((item) => item.name === "site_settings")).toMatchObject({ kind: "r", rls: false, force: false });
        expect(
          added.columns.map(({ relation, name, type, notNull, default: fallback }) => ({ relation, name, type, notNull, default: fallback })),
        ).toEqual(
          expect.arrayContaining([
            { relation: "site_settings", name: "id", type: "boolean", notNull: true, default: "true" },
            { relation: "site_settings", name: "organization_creation", type: "text", notNull: true, default: "'product_admins'::text" },
          ]),
        );
        expect(added.columns).toHaveLength(2);
        // Postgres 18 lists each NOT NULL as a constraint of its own (type n): the columns' notNull above.
        const named = added.constraints.filter((constraint) => constraint.type !== "n");
        expect(Object.fromEntries(named.map((constraint) => [constraint.name, constraint.definition]))).toEqual({
          site_settings_pkey: "PRIMARY KEY (id)",
          ck_site_settings_singleton: "CHECK (id)",
          ck_site_settings_organization_creation: "CHECK ((organization_creation = ANY (ARRAY['everyone'::text, 'product_admins'::text])))",
        });
        expect(names(added.indexes)).toEqual(["site_settings_pkey"]);
        expect({ ...added, relations: [], columns: [], constraints: [], indexes: [], functions: [] }).toEqual(nothing);
        // Every new object commented (the index is its constraint's, commented there).
        for (const item of [...added.relations.filter((relation) => relation.kind === "r"), ...added.columns, ...named, ...added.functions]) {
          expect({ item: item.name ?? item.signature, commented: typeof item.comment === "string" && item.comment !== "" }).toEqual({
            item: item.name ?? item.signature,
            commented: true,
          });
        }
        expect(await rows()).toEqual(rowsBefore);

        // One row, product_admins (only product admins create organizations on a fresh install, Q259);
        // a second refused; the API's role reads it and nothing more.
        expect((await sql<{ id: boolean; organization_creation: string }>`select * from site_settings`.execute(throwaway)).rows).toEqual([
          { id: true, organization_creation: "product_admins" },
        ]);
        await expect(sql`insert into site_settings default values`.execute(throwaway)).rejects.toMatchObject({ code: "23505" });
        await expect(sql`insert into site_settings (id) values (false)`.execute(throwaway)).rejects.toMatchObject({ code: "23514" });
        await expect(sql`update site_settings set organization_creation = 'nobody'`.execute(throwaway)).rejects.toMatchObject({ code: "23514" });
        const privileges = (
          await sql<{ privilege: string; held: boolean }>`
            select p.privilege, has_table_privilege('telflo_platform_runtime', 'site_settings', p.privilege) as held
              from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)`.execute(throwaway)
        ).rows;
        expect(privileges.filter((row) => row.held).map((row) => row.privilege)).toEqual(["SELECT"]);

        const owner = (await sql<{ name: string }>`select current_user as name`.execute(throwaway)).rows[0]!.name;
        expect(
          added.functions.map(({ signature, isDefiner, volatility, config, acl, result }) => ({ signature, isDefiner, volatility, config, acl, result })),
        ).toEqual([
          {
            signature: "product_admin_set_organization_creation(text)",
            isDefiner: true,
            volatility: "v",
            config: ["search_path=pg_catalog, platform"],
            acl: [`${owner}=X/${owner}`, `telflo_platform_runtime=X/${owner}`],
            result: "TABLE(outcome text, previous text)",
          },
        ]);
        // The gate first, then the value's check, the row's lock, the caller's; schema-qualified tables only.
        const source = (
          await sql<{ source: string }>`select prosrc as source from pg_proc where proname = 'product_admin_set_organization_creation'`.execute(throwaway)
        ).rows[0]!.source;
        const gate = source.indexOf("perform platform.assert_product_admin()");
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(source.indexOf("p_value is null"));
        expect(source.indexOf("from platform.site_settings s for update")).toBeLessThan(source.indexOf("where u.id = me for share"));
        expect(source.indexOf("where u.id = me for share")).toBeLessThan(source.indexOf("update platform.site_settings"));
        expect(/\b(?:from|update|insert\s+into)\s+(?!platform\.)\w/.test(source)).toBe(false);

        // down: migration 043's catalogue exactly, and the rows as they were; up again.
        await migrateDown(1);
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(rowsBefore);

        await migrate(1);
        expect(await catalog()).toEqual(after);
        expect(await rows()).toEqual(rowsBefore);
      });
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);
  });
});
