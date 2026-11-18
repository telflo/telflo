import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import type { ActorContext } from "../../database/context.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import type { Actor } from "../organizations/service.js";
import { ServiceAccountAddressTakenError } from "./repositories/service-account-repository.js";
import { createDatabaseServiceAccountService } from "./routes.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DOMAIN = "@service-accounts.telflo.invalid";

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

interface ServiceAccountBody {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  createdBy: { userId: string; email: string } | null;
  tokenCount: number;
}

describe("service account routes (D22 decisions 26 to 30)", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only DDL and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let mailer: ReturnType<typeof createInMemoryMailer>;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, the request log's included. */
  let logLines: string[] = [];

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    mailer = createInMemoryMailer();
    // Every line at info and above is kept, so a test can show that none
    // holds a name or an address (decision 49: logs hold ids only).
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer,
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date();
    logLines = [];
    mailer.sent.length = 0;
  });

  /** The SQLSTATE of every database error the server logged, in order. */
  const loggedDatabaseErrorCodes = () =>
    logLines.flatMap((line) => {
      const entry = JSON.parse(line) as { err?: { code?: unknown } };
      const code = entry.err?.code;
      return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? [code] : [];
    });

  const verifiedUser = () =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });

  /** Signs in, which lands in the personal organization, and returns the access cookie's value. */
  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  /** Switches the session to `organizationId`; returns the new access cookie's value. */
  const switchTo = async (access: string, organizationId: string) => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  /** A signed-in `role` of a group organization (a new one unless named), active in it. */
  const memberActiveInGroup = async (role: OrganizationRole = "admin", organizationId?: string) => {
    const account = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), group.id);
    return { user: account.user, personal: account.organization, group, access };
  };

  const accountsUrl = (organizationId: string, serviceAccountId?: string) =>
    `/api/v1/organizations/${organizationId}/service-accounts${serviceAccountId === undefined ? "" : `/${serviceAccountId}`}`;

  const listAccounts = (access: string, organizationId: string) =>
    server.inject({ method: "GET", url: accountsUrl(organizationId), cookies: { telflo_access: access } });

  const createAccount = (access: string, organizationId: string, name: unknown) =>
    server.inject({
      method: "POST",
      url: accountsUrl(organizationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });

  const readAccount = (access: string, organizationId: string, serviceAccountId: string) =>
    server.inject({ method: "GET", url: accountsUrl(organizationId, serviceAccountId), cookies: { telflo_access: access } });

  const renameAccount = (access: string, organizationId: string, serviceAccountId: string, name: unknown) =>
    server.inject({
      method: "PATCH",
      url: accountsUrl(organizationId, serviceAccountId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });

  const deleteAccount = (access: string, organizationId: string, serviceAccountId: string) =>
    server.inject({
      method: "DELETE",
      url: accountsUrl(organizationId, serviceAccountId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  /** The three routes that name an account, as `[name, request]`. */
  const accountRoutes = [
    ["the read", readAccount],
    ["a rename", (access: string, organizationId: string, id: string) => renameAccount(access, organizationId, id, "Renamed")],
    ["the delete", deleteAccount],
  ] as const;

  const created = (response: LightMyRequestResponse) => {
    expect(response.statusCode).toBe(201);
    return response.json<{ serviceAccount: ServiceAccountBody }>().serviceAccount;
  };

  /** Asserts a refusal's status and envelope, its message too when given. */
  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string, message?: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      error: message === undefined ? expect.objectContaining({ code }) : { code, message },
    });
  };

  const serviceAccountAudits = () =>
    ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", "service_account.%")
      .orderBy("id")
      .execute();

  /**
   * Every service-account and membership row, every service user, and every
   * token row without its hash and prefix (as api-tokens.integration's
   * tokenRows: a failed comparison prints neither; Ruling 99), to show a
   * refusal changed nothing.
   */
  const snapshot = async () => ({
    accounts: await ownerDb.selectFrom("service_accounts").selectAll().orderBy("user_id").execute(),
    users: await ownerDb.selectFrom("users").selectAll().where("kind", "=", "service").orderBy("id").execute(),
    memberships: await ownerDb.selectFrom("organization_members").selectAll().orderBy("id").execute(),
    tokens: await ownerDb
      .selectFrom("api_tokens")
      .select([
        "id",
        "organization_id",
        "service_account_user_id",
        "name",
        "access",
        "expires_at",
        "last_used_at",
        "created_by_user_id",
        "created_at",
        "revoked_at",
        "revoked_by_user_id",
      ])
      .orderBy("id")
      .execute(),
    audits: await serviceAccountAudits(),
  });

  /**
   * Decision 49: no log line, no audit row's metadata or actor address and
   * no error holds these texts (a name, an address). Counted, and named by
   * their position only: a failure prints none of them (Ruling 99).
   */
  const expectNowhereLoggedOrAudited = async (...texts: string[]) => {
    const audits = await ownerDb.selectFrom("audit_events").select(["metadata", "actor_email"]).execute();
    const auditTexts = audits.map((row) => `${JSON.stringify(row.metadata)} ${row.actor_email ?? ""}`.toLowerCase());
    // The request log was on: the search below has lines to look through.
    expect(logLines.length).toBeGreaterThan(0);
    const found = texts.map((text, position) => {
      const needle = text.toLowerCase();
      return {
        position,
        logLines: logLines.filter((line) => line.toLowerCase().includes(needle)).length,
        auditRows: auditTexts.filter((auditText) => auditText.includes(needle)).length,
      };
    });
    expect(found).toEqual(texts.map((_text, position) => ({ position, logLines: 0, auditRows: 0 })));
  };

  /** The live service accounts of `organizationId`, counted as the limit counts them. */
  const liveAccountCount = async (organizationId: string) =>
    Number(
      (
        await ownerDb
          .selectFrom("service_accounts")
          .innerJoin("users", "users.id", "service_accounts.user_id")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("service_accounts.organization_id", "=", organizationId)
          .where("service_accounts.deleted_at", "is", null)
          .where("users.deleted_at", "is", null)
          .executeTakeFirstOrThrow()
      ).count,
    );

  /**
   * Resolves once a backend other than this test's own waits on a lock
   * naming `table` (D2a Ruling 6). Throws after five seconds.
   */
  const waitForLockWait = async (table: string) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike ${`%${table}%`}
      `.execute(ownerDb);
      if ((rows[0]?.waiting ?? 0) >= 1) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a request to wait on ${table}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /**
   * A service account written by the owner (D22's real shape), made at the
   * clock's time: the API deletes with the clock, and a deletion before the
   * creation is refused (ck_service_accounts_deleted_after_created).
   */
  const ownerMadeAccount = (organizationId: string, overrides: Omit<Parameters<typeof addServiceAccount>[1], "organizationId"> = {}) =>
    addServiceAccount(ownerDb, { createdAt: clock, ...overrides, organizationId });

  /** An actor for the service called directly, as `authenticate` would build it for a signed-in admin. */
  const directActor = (userId: string, organizationId: string, email: string): Actor => ({
    context: { userId, organizationId, role: "admin" } satisfies ActorContext,
    email,
  });

  /** An account made through the route, with two live tokens, an expired one and one already revoked. */
  const accountWithTokens = async (admin: Awaited<ReturnType<typeof memberActiveInGroup>>) => {
    const account = created(await createAccount(admin.access, admin.group.id, `Doomed ${randomUUID()}`));
    const earlier = new Date(clock.getTime() - 60_000);
    const token = (overrides: { expires_at?: Date; revoked_at?: Date; revoked_by_user_id?: string } = {}) =>
      addApiToken(ownerDb, {
        organizationId: admin.group.id,
        serviceAccountUserId: account.id,
        created_at: new Date(earlier.getTime() - 60_000),
        ...overrides,
      });
    const live = [await token(), await token()];
    const expired = await token({ expires_at: earlier });
    const revoked = await token({ revoked_at: earlier, revoked_by_user_id: admin.user.id });
    return { account, live, expired, revoked, earlier };
  };

  describe("create", () => {
    it("creates the account in one transaction: a service user with the slug address, verified, no password, no terms, one contributor membership in the organization, no personal organization, no configuration, no user_settings row, no verification token, no email", async () => {
      const admin = await memberActiveInGroup("admin");

      const account = created(await createAccount(admin.access, admin.group.id, "  CI Deploy  "));

      expect(account.email).toMatch(new RegExp(`^ci-deploy-[0-9a-f]{8}${DOMAIN.replace(/\./g, "\\.")}$`));
      const user = await ownerDb.selectFrom("users").selectAll().where("id", "=", account.id).executeTakeFirstOrThrow();
      expect(user).toMatchObject({
        email: account.email,
        kind: "service",
        password_hash: null,
        email_verified_at: clock,
        accepted_terms_version: null,
        terms_accepted_at: null,
        deleted_at: null,
        is_product_admin: false,
      });
      expect(await ownerDb.selectFrom("service_accounts").selectAll().execute()).toEqual([
        {
          user_id: account.id,
          organization_id: admin.group.id,
          name: "CI Deploy",
          created_by_user_id: admin.user.id,
          created_at: clock,
          updated_at: clock,
          deleted_at: null,
        },
      ]);
      expect(
        await ownerDb.selectFrom("organization_members").selectAll().where("user_id", "=", account.id).execute(),
      ).toEqual([
        expect.objectContaining({ organization_id: admin.group.id, user_id: account.id, role: "contributor", deleted_at: null }),
      ]);
      expect(
        await ownerDb.selectFrom("organizations").select("id").where("owner_user_id", "=", account.id).execute(),
      ).toEqual([]);
      expect(
        await ownerDb.selectFrom("configurations").select("id").where("created_by_user_id", "=", account.id).execute(),
      ).toEqual([]);
      expect(await ownerDb.selectFrom("user_settings").select("user_id").where("user_id", "=", account.id).execute()).toEqual(
        [],
      );
      expect(
        await ownerDb.selectFrom("email_verification_tokens").select("id").where("user_id", "=", account.id).execute(),
      ).toEqual([]);
      expect(await ownerDb.selectFrom("user_identities").select("id").where("user_id", "=", account.id).execute()).toEqual(
        [],
      );
      expect(await ownerDb.selectFrom("sessions").select("id").where("user_id", "=", account.id).execute()).toEqual([]);
      expect(mailer.sent).toEqual([]);
    });

    it("answers 201 with the account, its address and createdBy the admin, and audits service_account.created with ids only", async () => {
      const admin = await memberActiveInGroup("admin");
      const name = `canary-${randomUUID()}`;

      const response = await createAccount(admin.access, admin.group.id, name);

      const account = created(response);
      expect(response.json()).toEqual({
        serviceAccount: {
          id: account.id,
          name,
          email: account.email,
          createdAt: clock.toISOString(),
          createdBy: { userId: admin.user.id, email: admin.user.email },
          tokenCount: 0,
        },
      });
      expect(await serviceAccountAudits()).toEqual([
        expect.objectContaining({
          action: "service_account.created",
          actor_user_id: admin.user.id,
          actor_email: admin.user.email,
          organization_id: admin.group.id,
          subject_type: "service_account",
          subject_id: account.id,
          metadata: {},
        }),
      ]);
      await expectNowhereLoggedOrAudited(name, account.email, account.email.slice(0, account.email.indexOf("@")));
    });

    it("refuses a contributor with 403, another organization with 404, and a name of 0 or 65 characters with 400", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const other = await memberActiveInGroup("admin");
      const before = await snapshot();

      expectRefusal(
        await createAccount(contributor.access, admin.group.id, "CI"),
        403,
        "organization_admin_required",
        "Only an admin of this organization can do that",
      );
      expectRefusal(await createAccount(other.access, admin.group.id, "CI"), 404, "organization_not_found", "Organization not found");
      for (const name of ["", "   ", "a".repeat(65)]) {
        expectRefusal(await createAccount(admin.access, admin.group.id, name), 400, "invalid_request");
      }
      expect(JSON.stringify((await createAccount(admin.access, admin.group.id, "")).json())).toContain(
        "Service account name is required",
      );
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a live duplicate name case aside with 409 service_account_name_taken, whose message holds no name, and admits a deleted account's name", async () => {
      const admin = await memberActiveInGroup("admin");
      const first = created(await createAccount(admin.access, admin.group.id, "Deploy Bot"));
      const before = await snapshot();

      for (const name of ["Deploy Bot", "deploy bot", "DEPLOY BOT"]) {
        expectRefusal(
          await createAccount(admin.access, admin.group.id, name),
          409,
          "service_account_name_taken",
          "A service account with this name already exists.",
        );
      }
      expect(await snapshot()).toEqual(before);
      // Another organization may have it.
      const other = await memberActiveInGroup("admin");
      created(await createAccount(other.access, other.group.id, "Deploy Bot"));

      expect((await deleteAccount(admin.access, admin.group.id, first.id)).statusCode).toBe(204);
      const again = created(await createAccount(admin.access, admin.group.id, "deploy bot"));
      expect(again.id).not.toBe(first.id);
    });

    it("the 101st live account is 409 service_account_limit_reached, and 20 concurrent creates at 95 end with exactly 100", async () => {
      const admin = await memberActiveInGroup("admin");
      for (let index = 0; index < 100; index += 1) await ownerMadeAccount(admin.group.id);
      const before = await snapshot();

      expectRefusal(
        await createAccount(admin.access, admin.group.id, "One too many"),
        409,
        "service_account_limit_reached",
        "This organization has 100 service accounts. Delete one first.",
      );
      expect(await snapshot()).toEqual(before);

      // 95 live and one deleted, which doesn't count; then 20 at once, each
      // waiting on the organization's lock in turn.
      const crowded = await memberActiveInGroup("admin");
      for (let index = 0; index < 95; index += 1) await ownerMadeAccount(crowded.group.id);
      const deleted = created(await createAccount(crowded.access, crowded.group.id, "Deleted"));
      expect((await deleteAccount(crowded.access, crowded.group.id, deleted.id)).statusCode).toBe(204);

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => createAccount(crowded.access, crowded.group.id, `Concurrent ${index}`)),
      );

      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(5);
      expect(statuses.filter((status) => status === 409)).toHaveLength(15);
      for (const response of responses.filter((candidate) => candidate.statusCode === 409)) {
        expect(response.json()).toMatchObject({ error: { code: "service_account_limit_reached" } });
      }
      expect(await liveAccountCount(crowded.group.id)).toBe(100);
      expect(loggedDatabaseErrorCodes()).toEqual([]);
    });

    it("an address collision is retried with new digits (the random source injected)", async () => {
      const admin = await memberActiveInGroup("admin");
      const actor = directActor(admin.user.id, admin.group.id, admin.user.email);
      const draws: string[] = [];
      const digits = ["0000000a", "0000000a", "0000000a", "0000000b"];
      const service = createDatabaseServiceAccountService(db, () => clock, () => {
        const next = digits.shift();
        if (next === undefined) throw new Error("no digits left");
        draws.push(next);
        return next;
      });

      const first = await service.create(actor, admin.group.id, "CI");
      // Another name with the same slug: its first two addresses collide.
      const second = await service.create(actor, admin.group.id, "ci!");

      expect(first.email).toBe(`ci-0000000a${DOMAIN}`);
      expect(second.email).toBe(`ci-0000000b${DOMAIN}`);
      expect(draws).toEqual(["0000000a", "0000000a", "0000000a", "0000000b"]);
      // Each collision rolled its try back: two accounts, two audit rows.
      expect(await liveAccountCount(admin.group.id)).toBe(2);
      expect((await serviceAccountAudits()).map((row) => row.subject_id)).toEqual([first.id, second.id]);
    });

    it("three collisions in a row fail the create and write nothing", async () => {
      const admin = await memberActiveInGroup("admin");
      const actor = directActor(admin.user.id, admin.group.id, admin.user.email);
      let draws = 0;
      const service = createDatabaseServiceAccountService(db, () => clock, () => {
        draws += 1;
        return "0000000c";
      });
      await service.create(actor, admin.group.id, "CI");
      const before = await snapshot();

      await expect(service.create(actor, admin.group.id, "ci?")).rejects.toBeInstanceOf(ServiceAccountAddressTakenError);

      expect(draws).toBe(4);
      expect(await snapshot()).toEqual(before);
    });

    it("a membership refused at commit leaves nothing behind", async () => {
      const admin = await memberActiveInGroup("admin");
      const before = await snapshot();

      await withFailingInsert(ownerDb, "organization_members", "raise exception 'membership insert refused'", async () => {
        const response = await createAccount(admin.access, admin.group.id, "Doomed");
        expectRefusal(response, 500, "internal_error");
      });

      expect(await snapshot()).toEqual(before);
      expect(await ownerDb.selectFrom("users").select("id").where("email", "like", `%${DOMAIN}`).execute()).toEqual([]);
    });
  });

  describe("read", () => {
    it("lists the live accounts newest first with their creator and listed token count, expired included and revoked left out", async () => {
      const admin = await memberActiveInGroup("admin");
      const day = 24 * 60 * 60 * 1000;
      const at = (days: number) => new Date(clock.getTime() - days * day);
      const oldest = await addServiceAccount(ownerDb, { organizationId: admin.group.id, name: "Oldest", createdAt: at(30) });
      const newest = await addServiceAccount(ownerDb, {
        organizationId: admin.group.id,
        name: "Newest",
        createdByUserId: admin.user.id,
        createdAt: at(10),
      });
      const deleted = await addServiceAccount(ownerDb, { organizationId: admin.group.id, name: "Deleted", createdAt: at(5) });
      await ownerDb.updateTable("service_accounts").set({ deleted_at: at(1) }).where("user_id", "=", deleted.user.id).execute();
      await ownerDb.updateTable("users").set({ deleted_at: at(1) }).where("id", "=", deleted.user.id).execute();
      const elsewhere = await memberActiveInGroup("admin");
      await ownerMadeAccount(elsewhere.group.id, { name: "Elsewhere" });
      const token = (overrides: { created_at: Date; expires_at?: Date; revoked_at?: Date; revoked_by_user_id?: string }) =>
        addApiToken(ownerDb, { organizationId: admin.group.id, serviceAccountUserId: newest.user.id, ...overrides });
      await token({ created_at: at(9) });
      await token({ created_at: at(9), expires_at: at(8) });
      await token({ created_at: at(9), revoked_at: at(7), revoked_by_user_id: admin.user.id });

      const response = await listAccounts(admin.access, admin.group.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: newest.user.id,
            name: "Newest",
            email: newest.user.email,
            createdAt: at(10).toISOString(),
            createdBy: { userId: admin.user.id, email: admin.user.email },
            tokenCount: 2,
          },
          {
            id: oldest.user.id,
            name: "Oldest",
            email: oldest.user.email,
            createdAt: at(30).toISOString(),
            createdBy: null,
            tokenCount: 0,
          },
        ],
      });
      const one = await readAccount(admin.access, admin.group.id, newest.user.id.toUpperCase());
      expect(one.statusCode).toBe(200);
      expect(one.json()).toEqual({ serviceAccount: response.json<{ items: unknown[] }>().items[0] });
      expect((await listAccounts(elsewhere.access, elsewhere.group.id)).json()).toMatchObject({
        items: [expect.objectContaining({ name: "Elsewhere" })],
      });
    });

    it("a contributor is refused the list and the account with 403", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const { user } = await ownerMadeAccount(admin.group.id);

      expectRefusal(await listAccounts(contributor.access, admin.group.id), 403, "organization_admin_required");
      expectRefusal(await readAccount(contributor.access, admin.group.id, user.id), 403, "organization_admin_required");
      // Before anything else: an unknown account is the same 403 for them.
      expectRefusal(await readAccount(contributor.access, admin.group.id, randomUUID()), 403, "organization_admin_required");
    });

    it("another organization's account, a deleted one and an id that isn't a canonical uuid are 404 alike", async () => {
      const admin = await memberActiveInGroup("admin");
      const ours = await ownerMadeAccount(admin.group.id);
      const other = await memberActiveInGroup("admin");
      const theirs = await ownerMadeAccount(other.group.id);
      const deleted = await ownerMadeAccount(admin.group.id);
      expect((await deleteAccount(admin.access, admin.group.id, deleted.user.id)).statusCode).toBe(204);
      const before = await snapshot();

      const ids = [
        theirs.user.id,
        deleted.user.id,
        randomUUID(),
        ours.user.id.replace(/-/g, ""),
        `{${ours.user.id}}`,
        "not-a-uuid",
      ];
      for (const [, request] of accountRoutes) {
        for (const id of ids) {
          expectRefusal(await request(admin.access, admin.group.id, id), 404, "service_account_not_found", "Service account not found.");
        }
      }
      // A path naming the other organization, by its own admin's account id, is that organization's 404.
      expectRefusal(await readAccount(admin.access, other.group.id, theirs.user.id), 404, "organization_not_found");
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("rename", () => {
    it("renames, keeps the address, audits service_account.renamed without names", async () => {
      const admin = await memberActiveInGroup("admin");
      const before = `before-${randomUUID()}`;
      const after = `after-${randomUUID()}`;
      const account = created(await createAccount(admin.access, admin.group.id, before));
      clock = new Date(clock.getTime() + 60_000);

      const response = await renameAccount(admin.access, admin.group.id, account.id, `  ${after}  `);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ serviceAccount: { ...account, name: after } });
      expect(
        await ownerDb.selectFrom("service_accounts").select(["name", "updated_at"]).where("user_id", "=", account.id).executeTakeFirstOrThrow(),
      ).toEqual({ name: after, updated_at: clock });
      expect(
        (await ownerDb.selectFrom("users").select("email").where("id", "=", account.id).executeTakeFirstOrThrow()).email,
      ).toBe(account.email);
      expect((await serviceAccountAudits()).map((row) => row.action)).toEqual([
        "service_account.created",
        "service_account.renamed",
      ]);
      const renamedRow = (await serviceAccountAudits())[1]!;
      expect(renamedRow).toMatchObject({
        actor_user_id: admin.user.id,
        organization_id: admin.group.id,
        subject_type: "service_account",
        subject_id: account.id,
      });
      // Exactly empty: no name, from or to.
      expect(renamedRow.metadata).toEqual({});
      await expectNowhereLoggedOrAudited(before, after, account.email);
    });

    it("the same name is a no-op with no audit row", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = created(await createAccount(admin.access, admin.group.id, "Same"));
      const before = await snapshot();
      clock = new Date(clock.getTime() + 60_000);

      const response = await renameAccount(admin.access, admin.group.id, account.id, "Same");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ serviceAccount: account });
      expect(await snapshot()).toEqual(before);
      // Its own name in another case is a rename, not a duplicate.
      expect((await renameAccount(admin.access, admin.group.id, account.id, "SAME")).json()).toMatchObject({
        serviceAccount: { name: "SAME" },
      });
    });

    it("a live duplicate is 409", async () => {
      const admin = await memberActiveInGroup("admin");
      created(await createAccount(admin.access, admin.group.id, "Taken"));
      const account = created(await createAccount(admin.access, admin.group.id, "Mine"));
      const before = await snapshot();

      expectRefusal(
        await renameAccount(admin.access, admin.group.id, account.id, "taken"),
        409,
        "service_account_name_taken",
        "A service account with this name already exists.",
      );
      expect(await snapshot()).toEqual(before);
      expectRefusal(await renameAccount(admin.access, admin.group.id, account.id, "a".repeat(65)), 400, "invalid_request");
    });
  });

  describe("delete", () => {
    it("deletes in one transaction: the account and its membership soft-deleted, every token not yet revoked revoked by the admin, the user's deleted_at set, audited with the count", async () => {
      const admin = await memberActiveInGroup("admin");
      const { account, live, expired, revoked, earlier } = await accountWithTokens(admin);
      clock = new Date(clock.getTime() + 60_000);

      const response = await deleteAccount(admin.access, admin.group.id, account.id);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(
        await ownerDb.selectFrom("service_accounts").select("deleted_at").where("user_id", "=", account.id).executeTakeFirstOrThrow(),
      ).toEqual({ deleted_at: clock });
      expect(
        await ownerDb
          .selectFrom("users")
          .select(["deleted_at", "updated_at"])
          .where("id", "=", account.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ deleted_at: clock, updated_at: clock });
      expect(
        await ownerDb
          .selectFrom("organization_members")
          .select(["organization_id", "deleted_at"])
          .where("user_id", "=", account.id)
          .execute(),
      ).toEqual([{ organization_id: admin.group.id, deleted_at: clock }]);
      const tokens = await ownerDb
        .selectFrom("api_tokens")
        .select(["id", "revoked_at", "revoked_by_user_id"])
        .where("service_account_user_id", "=", account.id)
        .execute();
      const byId = new Map(tokens.map((row) => [row.id, row]));
      for (const { apiToken } of [...live, expired]) {
        expect(byId.get(apiToken.id)).toEqual({ id: apiToken.id, revoked_at: clock, revoked_by_user_id: admin.user.id });
      }
      expect(byId.get(revoked.apiToken.id)).toEqual({ id: revoked.apiToken.id, revoked_at: earlier, revoked_by_user_id: admin.user.id });
      const deletedRow = (await serviceAccountAudits()).at(-1)!;
      // The canary first (Ruling 99): the audit row, whole, holds no token, hash or prefix of the account's.
      const serializedDelete = JSON.stringify(deletedRow);
      expect(
        [...live, expired, revoked].some(({ token, apiToken }) =>
          [token.slice(3), apiToken.token_hash, apiToken.token_prefix].some((text) => serializedDelete.includes(text)),
        ),
      ).toBe(false);
      expect(Object.keys(deletedRow.metadata as object)).toEqual(["revokedTokens"]);
      expect(deletedRow).toMatchObject({
        action: "service_account.deleted",
        actor_user_id: admin.user.id,
        actor_email: admin.user.email,
        organization_id: admin.group.id,
        subject_type: "service_account",
        subject_id: account.id,
      });
      expect(deletedRow.metadata).toEqual({ revokedTokens: 3 });
      // No session touched: it has none, and the admin's is as it was.
      expect(await ownerDb.selectFrom("sessions").select("id").where("user_id", "=", account.id).execute()).toEqual([]);
      expect(await ownerDb.selectFrom("sessions").select("revoked_at").where("user_id", "=", admin.user.id).execute()).toEqual([
        { revoked_at: null },
      ]);
      await expectNowhereLoggedOrAudited(account.name, account.email);
    });

    it("runs as the API's real role: every write passes telflo_platform_runtime's grants and policies", async () => {
      // The server's connection is the API's login, a member of
      // telflo_platform_runtime, neither a superuser nor the tables' owner, so
      // row-level security and the grants apply to each of the delete's
      // writes (Q131).
      const { rows } = await sql<{ is_application: boolean; is_superuser: boolean; owns_tables: boolean }>`
        select pg_has_role(current_user, 'telflo_platform_runtime', 'member') as is_application,
               (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
               exists (
                 select 1 from pg_tables
                  where tablename in ('users', 'service_accounts', 'api_tokens', 'organization_members', 'audit_events')
                    and tableowner = current_user
               ) as owns_tables
      `.execute(db);
      expect(rows).toEqual([{ is_application: true, is_superuser: false, owns_tables: false }]);
      const admin = await memberActiveInGroup("admin");
      const { account } = await accountWithTokens(admin);

      const response = await deleteAccount(admin.access, admin.group.id, account.id);

      expect(response.statusCode).toBe(204);
      expect(loggedDatabaseErrorCodes()).toEqual([]);
      expect(await liveAccountCount(admin.group.id)).toBe(0);
      expect(
        await ownerDb
          .selectFrom("api_tokens")
          .select("id")
          .where("service_account_user_id", "=", account.id)
          .where("revoked_at", "is", null)
          .execute(),
      ).toEqual([]);
    });

    it("its configurations stay and still show its address as creator", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = created(await createAccount(admin.access, admin.group.id, "Publisher"));
      const configuration = await addConfiguration(ownerDb, { organizationId: admin.group.id, created_by_user_id: account.id });
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: admin.group.id,
        created_by_user_id: account.id,
        publishedAt: clock,
        publishedByUserId: account.id,
      });

      expect((await deleteAccount(admin.access, admin.group.id, account.id)).statusCode).toBe(204);

      const response = await server.inject({
        method: "GET",
        url: `/api/v1/organizations/${admin.group.id}/configurations/${configuration.id}`,
        cookies: { telflo_access: admin.access },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configuration: { id: configuration.id, createdBy: { userId: account.id, email: account.email } },
      });
    });

    it("its name is free again and its address is not", async () => {
      const admin = await memberActiveInGroup("admin");
      const actor = directActor(admin.user.id, admin.group.id, admin.user.email);
      const digits = ["0000000d", "0000000d", "0000000e"];
      const service = createDatabaseServiceAccountService(db, () => clock, () => digits.shift() ?? "ffffffff");
      const first = await service.create(actor, admin.group.id, "Reused");
      expect((await deleteAccount(admin.access, admin.group.id, first.id)).statusCode).toBe(204);

      // The same name, and first the deleted account's address: taken still
      // (uq_users_lower_email covers deleted users), so it is drawn again.
      const second = await service.create(actor, admin.group.id, "Reused");

      expect(second.id).not.toBe(first.id);
      expect(first.email).toBe(`reused-0000000d${DOMAIN}`);
      expect(second.email).toBe(`reused-0000000e${DOMAIN}`);
      expect(digits).toEqual([]);
    });

    it("a deleted account is 404 to every route", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = created(await createAccount(admin.access, admin.group.id, "Gone"));
      expect((await deleteAccount(admin.access, admin.group.id, account.id)).statusCode).toBe(204);
      const before = await snapshot();

      for (const [, request] of accountRoutes) {
        expectRefusal(await request(admin.access, admin.group.id, account.id), 404, "service_account_not_found");
      }
      expect((await listAccounts(admin.access, admin.group.id)).json()).toEqual({ items: [] });
      expect(await snapshot()).toEqual(before);
    });

    it("a contributor is 403 and nothing changes", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const { account } = await accountWithTokens(admin);
      const before = await snapshot();

      expectRefusal(await createAccount(contributor.access, admin.group.id, "Theirs"), 403, "organization_admin_required");
      for (const [, request] of accountRoutes) {
        expectRefusal(await request(contributor.access, admin.group.id, account.id), 403, "organization_admin_required");
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("an admin demoted while waiting on the organization lock (decision 26)", () => {
    it.each([
      ["a create", (access: string, organizationId: string, _id: string) => createAccount(access, organizationId, "Late")],
      ["a rename", (access: string, organizationId: string, id: string) => renameAccount(access, organizationId, id, "Late")],
      ["a delete", (access: string, organizationId: string, id: string) => deleteAccount(access, organizationId, id)],
    ])("refuses %s by an admin demoted while it waited on the organization lock with 403, changing nothing", async (_label, request) => {
      // A separate connection holds the organization `for no key update`, as
      // a concurrent role change does, and demotes the admin. The request
      // read the role as admin before it reached the lock; the re-check
      // under the lock must see the demotion once it commits.
      const admin = await memberActiveInGroup("admin");
      const { account } = await accountWithTokens(admin);
      const before = await snapshot();

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organizations where id = $1 for no key update", [admin.group.id]);
        await locker.query(
          "update organization_members set role = 'contributor' where organization_id = $1 and user_id = $2",
          [admin.group.id, admin.user.id],
        );

        const pending = request(admin.access, admin.group.id, account.id);
        pending.catch(() => undefined);
        await waitForLockWait("organizations");
        await locker.query("commit");
        lockerInTransaction = false;

        expectRefusal(await pending, 403, "organization_admin_required");
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
      const after = await snapshot();
      expect({ ...after, memberships: undefined }).toEqual({ ...before, memberships: undefined });
    });
  });

  it("every route needs a session (401) and every write the CSRF header", async () => {
    const admin = await memberActiveInGroup("admin");
    const account = created(await createAccount(admin.access, admin.group.id, "Guarded"));
    const routes = [
      ["GET", accountsUrl(admin.group.id), undefined],
      ["POST", accountsUrl(admin.group.id), { name: "Unguarded" }],
      ["GET", accountsUrl(admin.group.id, account.id), undefined],
      ["PATCH", accountsUrl(admin.group.id, account.id), { name: "Unguarded" }],
      ["DELETE", accountsUrl(admin.group.id, account.id), undefined],
    ] as const;
    const before = await snapshot();

    for (const [method, url, payload] of routes) {
      const unauthenticated = await server.inject({
        method,
        url,
        headers: csrfHeaders,
        ...(payload === undefined ? {} : { payload }),
      });
      expect({ method, url, status: unauthenticated.statusCode }).toEqual({ method, url, status: 401 });
      expectRefusal(unauthenticated, 401, "unauthenticated");
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== "GET")) {
      const withoutCsrf = await server.inject({
        method,
        url,
        cookies: { telflo_access: admin.access },
        ...(payload === undefined ? {} : { payload }),
      });
      expect({ method, status: withoutCsrf.statusCode }).toEqual({ method, status: 403 });
    }
    expect(await snapshot()).toEqual(before);
  });
});
