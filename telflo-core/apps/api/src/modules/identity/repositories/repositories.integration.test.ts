import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import {
  createUserRepository,
  DuplicateEmailError,
  type AccountCreatedCallback,
  type CreateUserInput,
  type IUserRepository,
} from "./user-repository.js";
import {
  createUserIdentityRepository,
  IdentityLinkConflictError,
  type IUserIdentityRepository,
} from "./user-identity-repository.js";
import {
  createVerificationTokenRepository,
  type IVerificationTokenRepository,
} from "./verification-token-repository.js";
import { createAuditRepository, type IAuditRepository } from "./audit-repository.js";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
  STARTER_VERSION_LABEL,
} from "../../configurations/starter-configuration.js";
import { createConfigurationRepository } from "../../configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../../configurations/repositories/configuration-version-repository.js";
import { withDatabaseContext } from "../../../database/context.js";

describe("identity repositories", () => {
  /** The repositories' connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only DDL and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  let users: IUserRepository;
  let tokens: IVerificationTokenRepository;
  let audit: IAuditRepository;
  let identities: IUserIdentityRepository;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    users = createUserRepository(db);
    tokens = createVerificationTokenRepository(db);
    audit = createAuditRepository(db);
    identities = createUserIdentityRepository(db);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** Registration's clock: the terms' acceptance and the starter configuration's creation. */
  const registeredAt = new Date("2026-09-01T00:00:00.000Z");
  const origin = { ipAddress: "203.0.113.7", userAgent: "repositories-test-agent" };

  /** What email registration hands `createAccount`. */
  const registrationInput = (email: string): CreateUserInput => ({
    email,
    passwordHash: "$argon2id$fake",
    terms: { version: "2026-01-01", acceptedAt: registeredAt },
    emailVerifiedAt: null,
    createdAt: registeredAt,
    origin,
  });

  /** The configurations of `organizationId`, each with its versions, read as the owner. */
  const configurationsOf = async (organizationId: string) => {
    const configurations = await ownerDb
      .selectFrom("configurations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .execute();
    return Promise.all(
      configurations.map(async (configuration) => ({
        ...configuration,
        versions: await ownerDb
          .selectFrom("configuration_versions")
          .selectAll()
          .where("configuration_id", "=", configuration.id)
          .execute(),
      })),
    );
  };

  /** Asserts that `organizationId` holds exactly the starter configuration, created by `userId` at `at`. */
  const expectStarterOnly = async (organizationId: string, userId: string, at: Date) => {
    const configurations = await configurationsOf(organizationId);
    expect(configurations).toHaveLength(1);
    const [starter] = configurations;
    expect(starter).toMatchObject({
      name: STARTER_CONFIGURATION_NAME,
      description: STARTER_CONFIGURATION_DESCRIPTION,
      created_by_user_id: userId,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    });
    expect(starter!.versions).toHaveLength(1);
    expect(starter!.versions[0]).toMatchObject({
      organization_id: organizationId,
      version_number: 1,
      label: STARTER_VERSION_LABEL,
      yaml_content: STARTER_CONFIGURATION_YAML,
      created_by_user_id: userId,
      created_at: at,
      updated_at: at,
    });
    return starter!;
  };

  /**
   * A user created the way registration creates one: through `createAccount`,
   * with a personal organization and membership. The membership invariant
   * refuses a user committed alone (covered in packages/db's schema tests).
   */
  const newUser = async (email = "person@example.com") => (await users.createAccount(registrationInput(email))).user;

  describe("user repository", () => {
    it("returns camelCase properties, not database column names", async () => {
      const user = await newUser();
      expect(user).toHaveProperty("acceptedTermsVersion");
      expect(user).not.toHaveProperty("accepted_terms_version");
    });

    it("finds a user by exact email", async () => {
      await newUser("findme@example.com");
      const found = await users.findByEmail("findme@example.com");
      expect(found?.email).toBe("findme@example.com");
    });

    it("finds a user regardless of the case supplied", async () => {
      await newUser("mixed@example.com");
      expect(await users.findByEmail("MIXED@EXAMPLE.COM")).toBeDefined();
    });

    it("returns undefined for an unknown email rather than throwing", async () => {
      expect(await users.findByEmail("nobody@example.com")).toBeUndefined();
    });

    it("does not return a soft-deleted user", async () => {
      const user = await newUser("gone@example.com");
      await ownerDb
        .updateTable("users")
        .set({ deleted_at: new Date() })
        .where("id", "=", user.id)
        .execute();
      expect(await users.findByEmail("gone@example.com")).toBeUndefined();
    });

    it("stores the email lowercased", async () => {
      const user = await newUser("SHOUTY@Example.COM");
      expect(user.email).toBe("shouty@example.com");
    });

    it("creates a user unverified", async () => {
      const user = await newUser();
      expect(user.emailVerifiedAt).toBeNull();
    });

    it("marks a user verified", async () => {
      const user = await newUser();
      await users.markEmailVerified(user.id);
      const found = await users.findByEmail(user.email);
      expect(found?.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it("finds a user by id", async () => {
      const user = await newUser("byid@example.com");
      expect(await users.findById(user.id)).toEqual(user);
    });

    it("returns undefined for an unknown id", async () => {
      expect(await users.findById("0190a5b0-0000-7000-8000-000000000000")).toBeUndefined();
    });

    it("does not find a soft-deleted user by id", async () => {
      const user = await newUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      expect(await users.findById(user.id)).toBeUndefined();
    });

    // Migration 1700000000026's trigger refuses the API's role any change of
    // is_product_admin. None of these writes names the flag, so each still
    // goes through on a product admin's row, as the API's role, and leaves
    // the flag as the owner set it.
    it("makes every write it makes to users as the API's role on a product admin's row, and the flag stays set", async () => {
      const flagOf = async (id: string) =>
        (await ownerDb.selectFrom("users").select("is_product_admin").where("id", "=", id).executeTakeFirstOrThrow())
          .is_product_admin;
      const makeProductAdmin = (id: string) =>
        ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", id).execute();
      const at = new Date("2030-01-02T03:04:05.000Z");

      const created = await newUser("admin@example.com");
      expect(await flagOf(created.id)).toBe(false);
      await makeProductAdmin(created.id);

      await users.markEmailVerified(created.id);
      expect(await users.setPasswordAndConfirmEmail(created.id, "$argon2id$changed", at)).toMatchObject({
        email: "admin@example.com",
      });
      expect(await users.acceptTerms(created.id, "2027-01-01", at)).toBe(true);
      await db.transaction().execute((transaction) => createUserRepository(transaction).lockForUpdate(created.id));
      expect(await flagOf(created.id)).toBe(true);

      const unverified = await newUser("unverified-admin@example.com");
      await makeProductAdmin(unverified.id);
      expect(await users.takeOverUnverified(unverified.id, at)).toMatchObject({ hadPassword: true });
      expect(await flagOf(unverified.id)).toBe(true);
    });
  });

  describe("setPasswordAndConfirmEmail", () => {
    const at = new Date("2030-01-02T03:04:05.000Z");

    const userRow = (id: string) =>
      ownerDb
        .selectFrom("users")
        .select(["password_hash", "email_verified_at", "updated_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    it("sets the hash and confirms an unconfirmed email, reporting wasUnconfirmed true", async () => {
      const user = await newUser("unconfirmed@example.com");

      expect(await users.setPasswordAndConfirmEmail(user.id, "$argon2id$new", at)).toEqual({
        email: "unconfirmed@example.com",
        wasUnconfirmed: true,
      });

      expect(await userRow(user.id)).toEqual({
        password_hash: "$argon2id$new",
        email_verified_at: at,
        updated_at: at,
      });
    });

    it("keeps an existing confirmation time, reporting wasUnconfirmed false", async () => {
      const verifiedAt = new Date("2029-06-01T00:00:00.000Z");
      const { user } = await createUserWithOrganization(ownerDb, { user: { email_verified_at: verifiedAt } });

      expect(await users.setPasswordAndConfirmEmail(user.id, "$argon2id$new", at)).toEqual({
        email: user.email,
        wasUnconfirmed: false,
      });

      expect(await userRow(user.id)).toEqual({
        password_hash: "$argon2id$new",
        email_verified_at: verifiedAt,
        updated_at: at,
      });
    });

    it("returns undefined for a soft-deleted user and changes nothing", async () => {
      const user = await newUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      const before = await userRow(user.id);

      expect(await users.setPasswordAndConfirmEmail(user.id, "$argon2id$new", at)).toBeUndefined();

      expect(await userRow(user.id)).toEqual(before);
    });

    it("returns undefined for an unknown user", async () => {
      expect(
        await users.setPasswordAndConfirmEmail("0190a5b0-0000-7000-8000-000000000000", "$argon2id$new", at),
      ).toBeUndefined();
    });

    it("runs inside the transaction it is bound to, rolling back with it", async () => {
      const user = await newUser();
      await expect(
        db.transaction().execute(async (transaction) => {
          const result = await createUserRepository(transaction).setPasswordAndConfirmEmail(
            user.id,
            "$argon2id$new",
            at,
          );
          expect(result).toEqual({ email: user.email, wasUnconfirmed: true });
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");

      expect(await userRow(user.id)).toMatchObject({ password_hash: "$argon2id$fake", email_verified_at: null });
    });
  });

  describe("setPasswordHash", () => {
    const at = new Date("2030-01-02T03:04:05.000Z");

    const userRow = (id: string) =>
      ownerDb
        .selectFrom("users")
        .select(["password_hash", "email_verified_at", "updated_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    it("sets the hash and updated_at, and never touches email_verified_at, confirmed or not", async () => {
      const unconfirmed = await newUser("unconfirmed@example.com");
      const verifiedAt = new Date("2029-06-01T00:00:00.000Z");
      const { user: confirmed } = await createUserWithOrganization(ownerDb, { user: { email_verified_at: verifiedAt } });

      expect(await users.setPasswordHash(unconfirmed.id, "$argon2id$changed", at)).toBe(true);
      expect(await users.setPasswordHash(confirmed.id, "$argon2id$changed", at)).toBe(true);

      expect(await userRow(unconfirmed.id)).toEqual({
        password_hash: "$argon2id$changed",
        email_verified_at: null,
        updated_at: at,
      });
      expect(await userRow(confirmed.id)).toEqual({
        password_hash: "$argon2id$changed",
        email_verified_at: verifiedAt,
        updated_at: at,
      });
    });

    it("answers false for a soft-deleted or unknown user and changes nothing", async () => {
      const user = await newUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      const before = await userRow(user.id);

      expect(await users.setPasswordHash(user.id, "$argon2id$changed", at)).toBe(false);
      expect(await users.setPasswordHash("0190a5b0-0000-7000-8000-000000000000", "$argon2id$changed", at)).toBe(false);

      expect(await userRow(user.id)).toEqual(before);
    });

    it("runs inside the transaction it is bound to, after the lock and the reread, rolling back with it", async () => {
      const user = await newUser();
      await expect(
        db.transaction().execute(async (transaction) => {
          const bound = createUserRepository(transaction);
          await bound.lockForUpdate(user.id);
          expect(await bound.findPasswordHashForShare(user.id)).toBe("$argon2id$fake");
          expect(await bound.setPasswordHash(user.id, "$argon2id$changed", at)).toBe(true);
          expect(await bound.findPasswordHashForShare(user.id)).toBe("$argon2id$changed");
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");

      expect(await userRow(user.id)).toMatchObject({ password_hash: "$argon2id$fake" });
    });
  });

  describe("createAccount", () => {
    const account = (email = "person@example.com") => users.createAccount(registrationInput(email));

    it("creates the user, a personal organization named after the email, and an admin membership", async () => {
      const { user, organization, membership } = await account("Mixed.Case@Example.com");

      expect(user.email).toBe("mixed.case@example.com");
      expect(organization).toMatchObject({
        name: "mixed.case@example.com",
        type: "personal",
        ownerUserId: user.id,
      });
      expect(membership).toMatchObject({ organizationId: organization.id, userId: user.id, role: "admin" });

      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(1);
    });

    it("records the registration's terms version and acceptance time, a password, and no verification", async () => {
      const { user } = await account();
      expect(
        await ownerDb
          .selectFrom("users")
          .select(["password_hash", "email_verified_at", "accepted_terms_version", "terms_accepted_at"])
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        password_hash: "$argon2id$fake",
        email_verified_at: null,
        accepted_terms_version: "2026-01-01",
        terms_accepted_at: new Date("2026-09-01T00:00:00.000Z"),
      });
    });

    /** An onCreated that writes what registration writes: an audit row and a token. */
    const writeAuditAndToken: AccountCreatedCallback = async ({ user }, writes) => {
      await writes.audit.record({ action: "user.registered", actorUserId: user.id });
      await writes.verificationTokens.create({
        userId: user.id,
        tokenHash: `hash-${user.id}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    };

    const accountWithWrites = (email = "person@example.com") =>
      users.createAccount(registrationInput(email), writeAuditAndToken);

    async function expectNothingPersisted(): Promise<void> {
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("audit_events").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("email_verification_tokens").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toHaveLength(0);
    }

    it("commits what onCreated writes together with the account, then the starter configuration's audit row", async () => {
      const { user } = await accountWithWrites();
      const audits = await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute();
      const tokenRows = await ownerDb.selectFrom("email_verification_tokens").selectAll().execute();
      expect(audits.map((row) => row.action)).toEqual(["user.registered", "configuration.created"]);
      expect(audits[0]?.actor_user_id).toBe(user.id);
      expect(tokenRows).toHaveLength(1);
      expect(tokenRows[0]?.user_id).toBe(user.id);
    });

    describe("the starter configuration", () => {
      it("is created in the personal organization, by the new user at createdAt, with version 1 holding the starter YAML", async () => {
        const { user, organization } = await account();

        await expectStarterOnly(organization.id, user.id, registeredAt);
        expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toHaveLength(1);
      });

      it("is created under drafts-private row-level security as the new user's own draft, which they then see with its version", async () => {
        // The insert's returning is held to the select policy, which shows a
        // draft only to its creator: without the new user in the context,
        // every sign-up would fail here.
        const { user, organization } = await account();
        const viewer = { userId: user.id, organizationId: organization.id };

        const seen = await withDatabaseContext(db, viewer, async (transaction) => {
          const page = await createConfigurationRepository(transaction, viewer).listPage({ limit: 10 });
          const versions = await createConfigurationVersionRepository(transaction, viewer).listSummaries(
            page.items[0]!.id,
          );
          return { page, versions };
        });

        expect(seen.page.items).toEqual([
          expect.objectContaining({
            name: STARTER_CONFIGURATION_NAME,
            published: false,
            createdBy: { userId: user.id, email: user.email },
          }),
        ]);
        expect(seen.versions).toEqual([
          expect.objectContaining({
            versionNumber: 1,
            label: STARTER_VERSION_LABEL,
            publishedAt: null,
            publishedBy: null,
          }),
        ]);
      });

      it('labels its version 1 "Initial version"', async () => {
        const { organization } = await account();
        const [starter] = await configurationsOf(organization.id);

        expect(STARTER_VERSION_LABEL).toBe("Initial version");
        expect(starter!.versions.map((version) => version.label)).toEqual(["Initial version"]);
      });

      it("is audited as configuration.created after onCreated's rows, as the account's own rows are written", async () => {
        const { user, organization } = await accountWithWrites("Audited@Example.com");
        const [starter] = await configurationsOf(organization.id);

        const rows = await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute();
        expect(rows.at(-1)).toMatchObject({
          action: "configuration.created",
          actor_user_id: user.id,
          actor_email: "audited@example.com",
          organization_id: organization.id,
          subject_type: "configuration",
          subject_id: starter!.id,
          metadata: { name: STARTER_CONFIGURATION_NAME },
          ip_address: "203.0.113.7",
          user_agent: "repositories-test-agent",
        });
        // Never the YAML.
        expect(JSON.stringify(rows)).not.toContain("OpenTelemetry Collector Configuration");
      });

      it("is still made in the personal organization when onCreated entered another one", async () => {
        const inviter = await createUserWithOrganization(ownerDb);
        const { organization: group } = await addMembership(ownerDb, { userId: inviter.user.id });

        const { user, organization } = await users.createAccount(registrationInput("joiner@example.com"), async (_, writes) => {
          await writes.enterOrganization!(group.id);
        });

        await expectStarterOnly(organization.id, user.id, registeredAt);
        expect(await configurationsOf(group.id)).toEqual([]);
      });

      it.each(["configurations", "configuration_versions"] as const)(
        "rolls the whole account back when the %s insert fails",
        async (table) => {
          await withFailingInsert(ownerDb, table, `raise exception 'starter insert refused by test'`, async () => {
            await expect(accountWithWrites()).rejects.toThrow("starter insert refused by test");
          });
          await expectNothingPersisted();
        },
      );
    });

    it("the three inserts are atomic: when the membership insert fails, no user, organization, audit row or token persists", async () => {
      await withFailingInsert(
        ownerDb,
        "organization_members",
        `raise exception 'membership insert refused by test'`,
        async () => {
          await expect(accountWithWrites()).rejects.toThrow("membership insert refused by test");
        },
      );
      await expectNothingPersisted();
    });

    it("rolls the account back when a write inside onCreated fails", async () => {
      await withFailingInsert(ownerDb, "audit_events", `raise exception 'audit insert refused by test'`, async () => {
        await expect(accountWithWrites()).rejects.toThrow("audit insert refused by test");
      });
      await expectNothingPersisted();
    });

    it("maps a duplicate email to DuplicateEmailError and leaves no second organization", async () => {
      await account("taken@example.com");
      await expect(account("TAKEN@example.com")).rejects.toBeInstanceOf(DuplicateEmailError);
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(1);
    });

    it("does not report a unique violation on another index as a duplicate email", async () => {
      await withFailingInsert(
        ownerDb,
        "organization_members",
        `raise exception using errcode = 'unique_violation',
           constraint = 'uq_organization_members_organization_id_user_id',
           message = 'membership already exists'`,
        async () => {
          const error = await account().catch((caught: unknown) => caught);
          expect(error).not.toBeInstanceOf(DuplicateEmailError);
          expect(error).toMatchObject({ code: "23505" });
        },
      );
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(0);
    });
  });

  describe("createFederatedAccount", () => {
    const verifiedAt = new Date("2030-01-02T03:04:05.000Z");
    const federated = (email = "person@gmail.com", onCreated?: AccountCreatedCallback) =>
      users.createFederatedAccount({ email, verifiedAt, origin }, onCreated);

    it("creates the user, the personal organization and an admin membership, with no password, verified and without terms", async () => {
      const { user, organization, membership } = await federated("New.Person@Gmail.com");

      expect(user).toMatchObject({
        email: "new.person@gmail.com",
        passwordHash: null,
        emailVerifiedAt: verifiedAt,
        acceptedTermsVersion: null,
      });
      expect(organization).toMatchObject({
        name: "new.person@gmail.com",
        type: "personal",
        ownerUserId: user.id,
      });
      expect(membership).toMatchObject({ organizationId: organization.id, userId: user.id, role: "admin" });
      expect(
        await ownerDb
          .selectFrom("users")
          .select(["password_hash", "email_verified_at", "accepted_terms_version", "terms_accepted_at"])
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        password_hash: null,
        email_verified_at: verifiedAt,
        accepted_terms_version: null,
        terms_accepted_at: null,
      });
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(1);
      expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(1);
    });

    /** An onCreated that writes what a federated sign-up writes: the link and an audit row. */
    const linkAndAudit: AccountCreatedCallback = async ({ user }, writes) => {
      await writes.identities.link({ userId: user.id, provider: "google", subject: "subject-1", email: user.email });
      await writes.audit.record({ action: "user.registered", actorUserId: user.id });
    };

    it("commits the identity link written in onCreated together with the account", async () => {
      const { user } = await federated("person@gmail.com", linkAndAudit);
      expect(await identities.findUserBySubject("google", "subject-1")).toEqual({ user, isDeleted: false });
      const audits = await ownerDb.selectFrom("audit_events").select("action").orderBy("id").execute();
      expect(audits.map((row) => row.action)).toEqual(["user.registered", "configuration.created"]);
    });

    it("creates the starter configuration at verifiedAt", async () => {
      const { user, organization } = await federated();
      await expectStarterOnly(organization.id, user.id, verifiedAt);
    });

    it("rolls the account and its link back when a write inside onCreated fails", async () => {
      await withFailingInsert(ownerDb, "audit_events", `raise exception 'audit insert refused by test'`, async () => {
        await expect(federated("person@gmail.com", linkAndAudit)).rejects.toThrow("audit insert refused by test");
      });
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("organizations").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("organization_members").selectAll().execute()).toHaveLength(0);
      expect(await ownerDb.selectFrom("user_identities").selectAll().execute()).toHaveLength(0);
    });

    it("maps a taken email, a soft-deleted account's included, to DuplicateEmailError", async () => {
      const departed = await newUser("taken@gmail.com");
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", departed.id).execute();
      await expect(federated("TAKEN@gmail.com")).rejects.toBeInstanceOf(DuplicateEmailError);
      expect(await ownerDb.selectFrom("users").selectAll().execute()).toHaveLength(1);
    });
  });

  describe("findByEmailIncludingDeleted", () => {
    it("finds a live user, whatever the case supplied, as not deleted", async () => {
      const user = await newUser("live@example.com");
      expect(await users.findByEmailIncludingDeleted("LIVE@example.com")).toEqual({ user, isDeleted: false });
    });

    it("finds a soft-deleted user, reported as deleted", async () => {
      const user = await newUser("gone@example.com");
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      expect(await users.findByEmailIncludingDeleted("gone@example.com")).toEqual({ user, isDeleted: true });
    });

    it("returns undefined for an unknown email", async () => {
      expect(await users.findByEmailIncludingDeleted("nobody@example.com")).toBeUndefined();
    });
  });

  /**
   * The two finders start a person's flow, so they match people only. A
   * service account's address reads as no account there, live or deleted;
   * `findById` keeps every kind.
   */
  describe("the human-only lookups", () => {
    /** A service account in a person's personal organization, as the service accounts' create writes one. */
    const serviceAccount = async () => {
      const { organization } = await users.createAccount(registrationInput(`admin-${randomUUID()}@example.com`));
      return (await addServiceAccount(ownerDb, { organizationId: organization.id })).user;
    };

    /** Soft-deletes it as the service accounts' delete does: the user and its service_accounts row together. */
    const softDelete = async (userId: string) => {
      const at = new Date();
      await ownerDb.updateTable("service_accounts").set({ deleted_at: at }).where("user_id", "=", userId).execute();
      await ownerDb.updateTable("users").set({ deleted_at: at }).where("id", "=", userId).execute();
    };

    it("findByEmail and findByEmailIncludingDeleted never return a service account, deleted or not", async () => {
      const live = await serviceAccount();
      const deleted = await serviceAccount();
      await softDelete(deleted.id);

      for (const { email } of [live, deleted]) {
        expect(await users.findByEmail(email)).toBeUndefined();
        expect(await users.findByEmail(email.toUpperCase())).toBeUndefined();
        expect(await users.findByEmailIncludingDeleted(email)).toBeUndefined();
        expect(await users.findByEmailIncludingDeleted(email.toUpperCase())).toBeUndefined();
      }
    });

    it("both still find a human, live or deleted, beside them", async () => {
      await serviceAccount();
      const live = await newUser("live-person@example.com");
      const deleted = await newUser("deleted-person@example.com");
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();

      expect(await users.findByEmail(live.email)).toEqual(live);
      expect(await users.findByEmailIncludingDeleted(live.email)).toEqual({ user: live, isDeleted: false });
      expect(await users.findByEmailIncludingDeleted(deleted.email)).toEqual({ user: deleted, isDeleted: true });
    });

    /**
     * Registration's race refetch (identity/service.ts) looks the winner up
     * with `findByEmail` after a DuplicateEmailError. The route can't reach
     * it with a service account's address (registration refuses the domain
     * first), so this is the repository's half: a duplicate of a service
     * account's address finds no winner.
     */
    it("the race refetch finds only a human winner", async () => {
      const account = await serviceAccount();
      const human = await newUser("winner@example.com");

      expect(await users.findByEmail(human.email)).toEqual(human);
      expect(await users.findByEmail(account.email)).toBeUndefined();
    });

    it("findById keeps every kind", async () => {
      const account = await serviceAccount();

      expect(await users.findById(account.id)).toMatchObject({ id: account.id, email: account.email, passwordHash: null });
    });
  });

  describe("takeOverUnverified", () => {
    const at = new Date("2030-01-02T03:04:05.000Z");

    const userRow = (id: string) =>
      ownerDb
        .selectFrom("users")
        .select(["password_hash", "email_verified_at", "accepted_terms_version", "terms_accepted_at", "updated_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    it("confirms the email, deletes the password and clears the terms of an unverified user, reporting what it removed", async () => {
      const user = await newUser("squatted@example.com");

      expect(await users.takeOverUnverified(user.id, at)).toEqual({
        email: "squatted@example.com",
        hadPassword: true,
        hadTerms: true,
      });

      expect(await userRow(user.id)).toEqual({
        password_hash: null,
        email_verified_at: at,
        accepted_terms_version: null,
        terms_accepted_at: null,
        updated_at: at,
      });
    });

    it("reports hadPassword and hadTerms false for an unverified user without either", async () => {
      const { user } = await createUserWithOrganization(ownerDb, {
        user: { email_verified_at: null, accepted_terms_version: null, terms_accepted_at: null },
      });
      expect(await users.takeOverUnverified(user.id, at)).toEqual({
        email: user.email,
        hadPassword: false,
        hadTerms: false,
      });
    });

    it("refuses a verified user and changes nothing for them", async () => {
      const verifiedAt = new Date("2029-06-01T00:00:00.000Z");
      const { user } = await createUserWithOrganization(ownerDb, {
        user: { email_verified_at: verifiedAt, password_hash: "$argon2id$owner" },
      });
      const before = await userRow(user.id);

      expect(await users.takeOverUnverified(user.id, at)).toBeUndefined();

      expect(await userRow(user.id)).toEqual(before);
      expect(before).toMatchObject({ password_hash: "$argon2id$owner", email_verified_at: verifiedAt });
    });

    it("refuses a soft-deleted unverified user and changes nothing", async () => {
      const user = await newUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      const before = await userRow(user.id);

      expect(await users.takeOverUnverified(user.id, at)).toBeUndefined();

      expect(await userRow(user.id)).toEqual(before);
    });

    it("runs inside the transaction it is bound to, rolling back with it", async () => {
      const user = await newUser();
      await expect(
        db.transaction().execute(async (transaction) => {
          expect(await createUserRepository(transaction).takeOverUnverified(user.id, at)).toEqual({
            email: user.email,
            hadPassword: true,
            hadTerms: true,
          });
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");

      expect(await userRow(user.id)).toMatchObject({ password_hash: "$argon2id$fake", email_verified_at: null });
    });
  });

  describe("acceptTerms", () => {
    const at = new Date("2030-01-02T03:04:05.000Z");

    const termsRow = (id: string) =>
      ownerDb
        .selectFrom("users")
        .select(["accepted_terms_version", "terms_accepted_at", "updated_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    it("sets both the version and the acceptance time", async () => {
      const { user } = await users.createFederatedAccount({ email: "new@gmail.com", verifiedAt: new Date(), origin: {} });

      expect(await users.acceptTerms(user.id, "2026-01-01", at)).toBe(true);

      expect(await termsRow(user.id)).toEqual({
        accepted_terms_version: "2026-01-01",
        terms_accepted_at: at,
        updated_at: at,
      });
      expect((await users.findById(user.id))?.acceptedTermsVersion).toBe("2026-01-01");
    });

    it("replaces an older version", async () => {
      const user = await newUser();
      expect(await users.acceptTerms(user.id, "2027-01-01", at)).toBe(true);
      expect(await termsRow(user.id)).toMatchObject({ accepted_terms_version: "2027-01-01", terms_accepted_at: at });
    });

    it("changes nothing for a user who already accepted that version, keeping the first acceptance time", async () => {
      const user = await newUser();
      const before = await termsRow(user.id);

      expect(await users.acceptTerms(user.id, "2026-01-01", at)).toBe(false);

      expect(await termsRow(user.id)).toEqual(before);
    });

    it("changes nothing for a soft-deleted user", async () => {
      const { user } = await users.createFederatedAccount({ email: "gone@gmail.com", verifiedAt: new Date(), origin: {} });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();

      expect(await users.acceptTerms(user.id, "2026-01-01", at)).toBe(false);

      expect(await termsRow(user.id)).toMatchObject({ accepted_terms_version: null, terms_accepted_at: null });
    });
  });

  describe("user identity repository", () => {
    const link = (userId: string, subject: string, provider = "google") =>
      identities.link({ userId, provider, subject, email: "person@gmail.com" });

    it("links an identity, returning it in camelCase", async () => {
      const user = await newUser();
      const identity = await link(user.id, "subject-1");
      expect(identity).toMatchObject({
        userId: user.id,
        provider: "google",
        providerSubject: "subject-1",
        email: "person@gmail.com",
      });
      expect(identity.linkedAt).toBeInstanceOf(Date);
    });

    it("findUserBySubject finds a live user as not deleted", async () => {
      const user = await newUser();
      await link(user.id, "live-subject");
      expect(await identities.findUserBySubject("google", "live-subject")).toEqual({ user, isDeleted: false });
    });

    it("findUserBySubject reports a soft-deleted user as deleted rather than hiding them", async () => {
      const user = await newUser();
      await link(user.id, "deleted-subject");
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      expect(await identities.findUserBySubject("google", "deleted-subject")).toEqual({ user, isDeleted: true });
    });

    it("findUserBySubject returns undefined for an unknown subject, and for a known subject at another provider", async () => {
      const user = await newUser();
      await link(user.id, "known-subject");
      expect(await identities.findUserBySubject("google", "unknown-subject")).toBeUndefined();
      expect(await identities.findUserBySubject("okta", "known-subject")).toBeUndefined();
    });

    it("refuses a second link of one subject, with IdentityLinkConflictError subject_taken", async () => {
      const user = await newUser("first@example.com");
      const other = await newUser("second@example.com");
      await link(user.id, "subject-1");

      const error = await link(other.id, "subject-1").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(IdentityLinkConflictError);
      expect(error).toMatchObject({ reason: "subject_taken" });
      expect(await identities.findUserBySubject("google", "subject-1")).toMatchObject({ user: { id: user.id } });
    });

    it("refuses a second identity at one provider for one user, with IdentityLinkConflictError provider_taken", async () => {
      const user = await newUser();
      await link(user.id, "subject-1");

      const error = await link(user.id, "subject-2").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(IdentityLinkConflictError);
      expect(error).toMatchObject({ reason: "provider_taken" });
      expect(await identities.findUserBySubject("google", "subject-2")).toBeUndefined();
      await expect(link(user.id, "subject-2", "okta")).resolves.toMatchObject({ provider: "okta" });
    });

    it("re-throws an error that is not a conflict unchanged", async () => {
      const error = await link("0190a5b0-0000-7000-8000-000000000000", "orphan").catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(IdentityLinkConflictError);
      expect(error).toMatchObject({ code: "23503" });
    });

    describe("the sign-in methods' reads and the unlink", () => {
      it("listForUser lists the user's identities only, oldest link first, a provider no longer configured included", async () => {
        const user = await newUser("first@example.com");
        const other = await newUser("second@example.com");
        await link(user.id, "subject-okta", "okta");
        await link(user.id, "subject-google", "google");
        await link(other.id, "subject-other", "google");
        await ownerDb
          .updateTable("user_identities")
          .set({ linked_at: new Date("2026-01-01T00:00:00.000Z") })
          .where("provider_subject", "=", "subject-google")
          .execute();

        const listed = await identities.listForUser(user.id);

        expect(listed.map((identity) => [identity.provider, identity.providerSubject])).toEqual([
          ["google", "subject-google"],
          ["okta", "subject-okta"],
        ]);
        expect(listed[0]).toEqual({
          id: expect.any(String),
          userId: user.id,
          provider: "google",
          providerSubject: "subject-google",
          email: "person@gmail.com",
          linkedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        expect(await identities.listForUser((await newUser("third@example.com")).id)).toEqual([]);
      });

      it("findForUser finds the user's identity at a provider, and nobody else's", async () => {
        const user = await newUser("first@example.com");
        const other = await newUser("second@example.com");
        await link(other.id, "subject-other");

        expect(await identities.findForUser(user.id, "google")).toBeUndefined();
        await link(user.id, "subject-1");
        expect(await identities.findForUser(user.id, "google")).toMatchObject({ userId: user.id, providerSubject: "subject-1" });
        expect(await identities.findForUser(user.id, "okta")).toBeUndefined();
      });

      it("unlink deletes only the user's identity at the provider, and answers false when there is none", async () => {
        const user = await newUser("first@example.com");
        const other = await newUser("second@example.com");
        await link(user.id, "subject-1");
        await link(user.id, "subject-okta", "okta");
        await link(other.id, "subject-other");

        expect(await identities.unlink(user.id, "google")).toBe(true);
        expect(await identities.unlink(user.id, "google")).toBe(false);
        expect(await identities.findUserBySubject("google", "subject-1")).toBeUndefined();
        expect(await identities.findForUser(user.id, "okta")).toBeDefined();
        expect(await identities.findForUser(other.id, "google")).toMatchObject({ providerSubject: "subject-other" });
      });
    });
  });

  describe("verification token repository", () => {
    const future = () => new Date(Date.now() + 3_600_000);
    const past = () => new Date(Date.now() - 1_000);

    // findByHash is deliberately unfiltered: the service branches on
    // consumedAt/expiresAt itself (invalid vs. already_verified vs. expired),
    // so a consumed or expired row must still come back rather than looking
    // identical to a hash that was never issued.

    it("finds an unconsumed, unexpired token by hash", async () => {
      const user = await newUser();
      await tokens.create({ userId: user.id, tokenHash: "hash-live", expiresAt: future() });
      const found = await tokens.findByHash("hash-live");
      expect(found?.userId).toBe(user.id);
      expect(found?.consumedAt).toBeNull();
    });

    it("finds an expired, unconsumed token by hash", async () => {
      const user = await newUser();
      await tokens.create({ userId: user.id, tokenHash: "hash-expired", expiresAt: past() });
      const found = await tokens.findByHash("hash-expired");
      expect(found?.userId).toBe(user.id);
      expect(found?.consumedAt).toBeNull();
    });

    it("finds an already-consumed token, with consumedAt set", async () => {
      const user = await newUser();
      await tokens.create({ userId: user.id, tokenHash: "hash-used", expiresAt: future() });
      const found = await tokens.findByHash("hash-used");
      await tokens.consume(found!.id);
      const afterConsume = await tokens.findByHash("hash-used");
      expect(afterConsume?.consumedAt).toBeInstanceOf(Date);
    });

    it("returns undefined for an unknown hash", async () => {
      expect(await tokens.findByHash("never-issued")).toBeUndefined();
    });

    it("consumes a token exactly once, even when called concurrently", async () => {
      // Two clicks on the same link must not verify twice. consume() is an
      // atomic conditional update, so exactly one caller sees true.
      const user = await newUser();
      await tokens.create({ userId: user.id, tokenHash: "hash-race", expiresAt: future() });
      const found = await tokens.findByHash("hash-race");

      const results = await Promise.all([tokens.consume(found!.id), tokens.consume(found!.id)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("consumeAllForUser consumes the user's unconsumed tokens only, at the given time", async () => {
      const user = await newUser();
      const other = await newUser("other@example.com");
      const at = new Date("2026-09-26T12:00:00.000Z");
      await tokens.create({ userId: user.id, tokenHash: "hash-a", expiresAt: future() });
      await tokens.create({ userId: user.id, tokenHash: "hash-b", expiresAt: past() });
      await tokens.create({ userId: user.id, tokenHash: "hash-c", expiresAt: future() });
      await tokens.consume((await tokens.findByHash("hash-c"))!.id);
      await tokens.create({ userId: other.id, tokenHash: "hash-other", expiresAt: future() });

      expect(await tokens.consumeAllForUser(user.id, at)).toBe(2);
      expect((await tokens.findByHash("hash-a"))?.consumedAt).toEqual(at);
      expect((await tokens.findByHash("hash-b"))?.consumedAt).toEqual(at);
      expect((await tokens.findByHash("hash-c"))?.consumedAt).not.toEqual(at);
      expect((await tokens.findByHash("hash-other"))?.consumedAt).toBeNull();
      expect(await tokens.consumeAllForUser(user.id, at)).toBe(0);
    });
  });

  describe("audit repository", () => {
    it("records an event with only an action", async () => {
      await audit.record({ action: "user.registration_attempted" });
      const rows = await ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("user.registration_attempted");
    });

    it("records the actor and metadata it is given", async () => {
      const user = await newUser();
      await audit.record({
        action: "user.registered",
        actorUserId: user.id,
        actorEmail: user.email,
        metadata: { source: "web" },
      });
      // The account's own starter configuration was audited too.
      const row = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "user.registered")
        .executeTakeFirstOrThrow();
      expect(row.actor_user_id).toBe(user.id);
      expect(row.metadata).toEqual({ source: "web" });
    });

    it("defaults metadata to an empty object when none is supplied", async () => {
      await audit.record({ action: "user.registered" });
      const row = await ownerDb.selectFrom("audit_events").selectAll().executeTakeFirstOrThrow();
      expect(row.metadata).toEqual({});
    });
  });
});
