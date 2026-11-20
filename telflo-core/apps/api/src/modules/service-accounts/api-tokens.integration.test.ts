import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { API_TOKEN_PATTERN, API_TOKEN_PREFIX_PATTERN, CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  applicationTables,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { apiTokenHash } from "./tokens.js";

/*
 * An account's API tokens. A token is a secret like a bearer: every token here
 * is built at run time (by the API or by addApiToken), and the assertions
 * compare a token, its hash or its prefix as booleans or counts, so a failure
 * prints none.
 */

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DAY = 24 * 60 * 60 * 1000;

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

interface ApiTokenBody {
  id: string;
  name: string;
  prefix: string;
  access: "read" | "write";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  isExpired: boolean;
}

describe("API token routes", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, the request log's included. */
  let logLines: string[] = [];

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    // Every line at info and above is kept, so a test can show that none
    // holds a token, its prefix or its name.
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
        mailer: createInMemoryMailer(),
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
  });

  const loggedDatabaseErrorCodes = () =>
    logLines.flatMap((line) => {
      const entry = JSON.parse(line) as { err?: { code?: unknown } };
      const code = entry.err?.code;
      return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? [code] : [];
    });

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

  const switchTo = async (access: string, organizationId: string) => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  /** A signed-in `role` of a group organization (a new one unless named), active in it. */
  const memberActiveInGroup = async (role: OrganizationRole = "admin", organizationId?: string) => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), group.id);
    return { user: account.user, group, access };
  };

  /** A service account of `organizationId` in its real shape, made at the clock's time. */
  const serviceAccountIn = async (organizationId: string, name?: string) =>
    (await addServiceAccount(ownerDb, { organizationId, createdAt: clock, ...(name === undefined ? {} : { name }) })).user;

  /** A token written by the tables' owner on the account, made a minute before the clock unless told otherwise. */
  const ownerMadeToken = (
    organizationId: string,
    serviceAccountUserId: string,
    overrides: Omit<Parameters<typeof addApiToken>[1], "organizationId" | "serviceAccountUserId"> = {},
  ) =>
    addApiToken(ownerDb, {
      organizationId,
      serviceAccountUserId,
      created_at: new Date(clock.getTime() - 60_000),
      ...overrides,
    });

  const tokensUrl = (organizationId: string, serviceAccountId: string, tokenId?: string) =>
    `/api/v1/organizations/${organizationId}/service-accounts/${serviceAccountId}/api-tokens${tokenId === undefined ? "" : `/${tokenId}`}`;

  const listTokens = (access: string, organizationId: string, serviceAccountId: string) =>
    server.inject({ method: "GET", url: tokensUrl(organizationId, serviceAccountId), cookies: { telflo_access: access } });

  const createToken = (
    access: string,
    organizationId: string,
    serviceAccountId: string,
    body: Record<string, unknown> = {},
  ) =>
    server.inject({
      method: "POST",
      url: tokensUrl(organizationId, serviceAccountId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name: `token-${randomUUID()}`, access: "read", expiresInDays: null, ...body },
    });

  const revokeToken = (access: string, organizationId: string, serviceAccountId: string, tokenId: string) =>
    server.inject({
      method: "DELETE",
      url: tokensUrl(organizationId, serviceAccountId, tokenId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  /** The created token's reply: its row as listed and the token, which is never printed. */
  const created = (response: LightMyRequestResponse) => {
    expect(response.statusCode).toBe(201);
    return response.json<{ apiToken: ApiTokenBody; token: string }>();
  };

  /** A listed token without its prefix, which the tests compare as a boolean. */
  const withoutPrefix = ({ prefix: _prefix, ...rest }: ApiTokenBody) => rest;

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string, message?: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      error: message === undefined ? expect.objectContaining({ code }) : { code, message },
    });
  };

  /**
   * Every token row without its hash and prefix, to show a refusal changed
   * nothing: a failed comparison prints neither.
   */
  const tokenRows = () =>
    ownerDb
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
      .execute();

  const tokenAudits = () =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "like", "api_token.%").orderBy("id").execute();

  /** The account's live tokens, counted as the limit counts them. */
  const liveTokenCount = async (serviceAccountUserId: string) =>
    Number(
      (
        await ownerDb
          .selectFrom("api_tokens")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("service_account_user_id", "=", serviceAccountUserId)
          .where("revoked_at", "is", null)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", clock)]))
          .executeTakeFirstOrThrow()
      ).count,
    );

  /** How many rows of every application table hold `text` anywhere, read as the tables' owner. */
  const rowsHolding = async (text: string) => {
    let count = 0;
    for (const table of applicationTables) {
      const { rows } = await sql<{ count: number }>`
        select count(*)::int as count from ${sql.table(table)} as row where row::text like ${`%${text}%`}
      `.execute(ownerDb);
      count += rows[0]?.count ?? 0;
    }
    return count;
  };

  /** Whether a log line, an audit row's metadata or its actor's address holds `text`, case aside. */
  const loggedOrAudited = async (text: string) => {
    const needle = text.toLowerCase();
    const audits = await ownerDb.selectFrom("audit_events").select(["metadata", "actor_email"]).execute();
    return (
      logLines.some((line) => line.toLowerCase().includes(needle)) ||
      audits.some((row) => `${JSON.stringify(row.metadata)} ${row.actor_email ?? ""}`.toLowerCase().includes(needle))
    );
  };

  /** Resolves once a backend other than this test's own waits on a lock naming `table`. Throws after five seconds. */
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

  describe("create", () => {
    it("creates a token: 201 with the token once, no-store, created_by the admin, the hash and prefix stored and the token nowhere in the database, audited with ids, access and expiry only", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id, `account-${randomUUID()}`);
      const name = `canary-${randomUUID()}`;

      const response = await createToken(admin.access, admin.group.id, account.id, {
        name,
        access: "write",
        expiresInDays: 30,
      });

      const { apiToken, token } = created(response);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(API_TOKEN_PATTERN.test(token)).toBe(true);
      expect(API_TOKEN_PREFIX_PATTERN.test(apiToken.prefix) && token.startsWith(apiToken.prefix)).toBe(true);
      expect(Object.keys(response.json<object>()).sort()).toEqual(["apiToken", "token"]);
      const stored = await ownerDb
        .selectFrom("api_tokens")
        .select(["token_hash", "token_prefix"])
        .where("id", "=", apiToken.id)
        .executeTakeFirstOrThrow();
      expect(stored.token_hash === apiTokenHash(token)).toBe(true);
      expect(stored.token_prefix === token.slice(0, 11)).toBe(true);

      // The canaries first, booleans with fixed labels: nothing compared
      // below with toEqual or toMatchObject, whose diff would print it, may
      // hold the token, its hash or its prefix. A canary over every log line
      // and every audit row: the token, its hash, its prefix, its name and
      // the account's name are in none.
      const accountRow = await ownerDb
        .selectFrom("service_accounts")
        .select("name")
        .where("user_id", "=", account.id)
        .executeTakeFirstOrThrow();
      expect(logLines.length).toBeGreaterThan(0);
      for (const [label, text] of [
        ["the token's body", token.slice(3)],
        ["its hash", stored.token_hash],
        ["its prefix", apiToken.prefix],
        ["its name", name],
        ["the account's name", accountRow.name],
      ] as const) {
        expect({ label, found: await loggedOrAudited(text) }).toEqual({ label, found: false });
      }
      // Every audit row whole, serialized: neither the token, its hash nor its prefix.
      const audits = await tokenAudits();
      const serializedAudits = JSON.stringify(audits);
      for (const [label, text] of [
        ["the token's body", token.slice(3)],
        ["its hash", stored.token_hash],
        ["its prefix", apiToken.prefix],
      ] as const) {
        expect({ label, inAuditRows: serializedAudits.includes(text) }).toEqual({ label, inAuditRows: false });
      }
      // The reply's row, its prefix aside, holds none of them either.
      const shown = JSON.stringify(withoutPrefix(apiToken));
      expect([token.slice(3), stored.token_hash, apiToken.prefix].some((text) => shown.includes(text))).toBe(false);
      // The token itself is in no row of any table; its hash only in its own.
      expect(await rowsHolding(token)).toBe(0);
      expect(await rowsHolding(stored.token_hash)).toBe(1);

      // Then the exact comparisons.
      const expiresAt = new Date(clock.getTime() + 30 * DAY);
      expect(withoutPrefix(apiToken)).toEqual({
        id: expect.any(String),
        name,
        access: "write",
        expiresAt: expiresAt.toISOString(),
        lastUsedAt: null,
        createdAt: clock.toISOString(),
        isExpired: false,
      });
      const [row] = await tokenRows();
      expect(row).toMatchObject({
        id: apiToken.id,
        organization_id: admin.group.id,
        service_account_user_id: account.id,
        name,
        access: "write",
        expires_at: expiresAt,
        last_used_at: null,
        created_by_user_id: admin.user.id,
        created_at: clock,
        revoked_at: null,
        revoked_by_user_id: null,
      });
      expect(audits).toHaveLength(1);
      expect(Object.keys(audits[0]!.metadata as object).sort()).toEqual(["access", "expiresAt", "serviceAccountId"]);
      expect(audits).toEqual([
        expect.objectContaining({
          action: "api_token.created",
          actor_user_id: admin.user.id,
          actor_email: admin.user.email,
          organization_id: admin.group.id,
          subject_type: "api_token",
          subject_id: apiToken.id,
          metadata: { serviceAccountId: account.id, access: "write", expiresAt: expiresAt.toISOString() },
        }),
      ]);
      // And it is never returned again.
      const listed = await listTokens(admin.access, admin.group.id, account.id);
      expect(listed.body.includes(token.slice(3))).toBe(false);
      expect(listed.body.includes(stored.token_hash)).toBe(false);
    });

    it("expiresInDays sets expiresAt to 24-hour days after createdAt; null never expires; 0 and 3651 are 400", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);

      for (const days of [1, 3650]) {
        const { apiToken } = created(await createToken(admin.access, admin.group.id, account.id, { expiresInDays: days }));
        expect(apiToken.expiresAt).toBe(new Date(clock.getTime() + days * DAY).toISOString());
      }
      const never = created(await createToken(admin.access, admin.group.id, account.id, { expiresInDays: null }));
      expect(never.apiToken.expiresAt).toBeNull();
      const before = await tokenRows();

      for (const expiresInDays of [0, 3651, 1.5, "7", -1]) {
        const response = await createToken(admin.access, admin.group.id, account.id, { expiresInDays });
        expectRefusal(response, 400, "invalid_request");
        expect(response.body.includes("Enter a whole number of days from 1 to 3650.")).toBe(true);
      }
      for (const body of [{ access: "admin" }, { access: undefined }, { name: "" }, { name: "a".repeat(65) }]) {
        expectRefusal(await createToken(admin.access, admin.group.id, account.id, body), 400, "invalid_request");
      }
      expect(await tokenRows()).toEqual(before);
    });

    it("the 21st live token is 409 api_token_limit_reached with the contracts' words; expired and revoked tokens don't count; 10 concurrent creates at 15 end with exactly 20", async () => {
      const admin = await memberActiveInGroup("admin");
      const full = await serviceAccountIn(admin.group.id);
      for (let index = 0; index < 20; index += 1) await ownerMadeToken(admin.group.id, full.id);
      const before = await tokenRows();

      expectRefusal(
        await createToken(admin.access, admin.group.id, full.id),
        409,
        "api_token_limit_reached",
        "This service account has 20 tokens. Revoke one first.",
      );
      expect(await tokenRows()).toEqual(before);

      // 19 live, 5 expired, 5 revoked and one expiring at the API's clock
      // exactly, which has expired too: one more fits, and then no more.
      const mixed = await serviceAccountIn(admin.group.id);
      for (let index = 0; index < 19; index += 1) await ownerMadeToken(admin.group.id, mixed.id);
      for (let index = 0; index < 5; index += 1) {
        await ownerMadeToken(admin.group.id, mixed.id, {
          created_at: new Date(clock.getTime() - 2 * DAY),
          expires_at: new Date(clock.getTime() - DAY),
        });
        await ownerMadeToken(admin.group.id, mixed.id, { revoked_at: clock, revoked_by_user_id: admin.user.id });
      }
      await ownerMadeToken(admin.group.id, mixed.id, { created_at: new Date(clock.getTime() - DAY), expires_at: clock });
      created(await createToken(admin.access, admin.group.id, mixed.id));
      expectRefusal(await createToken(admin.access, admin.group.id, mixed.id), 409, "api_token_limit_reached");
      expect(await liveTokenCount(mixed.id)).toBe(20);

      // 15 live, then 10 at once, each waiting on the organization's lock in turn.
      const crowded = await serviceAccountIn(admin.group.id);
      for (let index = 0; index < 15; index += 1) await ownerMadeToken(admin.group.id, crowded.id);
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => createToken(admin.access, admin.group.id, crowded.id)),
      );
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(5);
      expect(statuses.filter((status) => status === 409)).toHaveLength(5);
      expect(await liveTokenCount(crowded.id)).toBe(20);
      expect(loggedDatabaseErrorCodes()).toEqual([]);
    });

    it("a name beside a token not revoked is 409, an expired one's included, and free again once revoked", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const live = created(await createToken(admin.access, admin.group.id, account.id, { name: "Deploy" }));
      await ownerMadeToken(admin.group.id, account.id, {
        name: "Old",
        created_at: new Date(clock.getTime() - 2 * DAY),
        expires_at: new Date(clock.getTime() - DAY),
      });
      const before = await tokenRows();

      for (const name of ["Deploy", "deploy", "  DEPLOY  ", "old"]) {
        expectRefusal(
          await createToken(admin.access, admin.group.id, account.id, { name }),
          409,
          "api_token_name_taken",
          "This service account already has a token with this name.",
        );
      }
      expect(await tokenRows()).toEqual(before);
      // Another account's tokens are its own.
      const other = await serviceAccountIn(admin.group.id);
      created(await createToken(admin.access, admin.group.id, other.id, { name: "Deploy" }));

      expect((await revokeToken(admin.access, admin.group.id, account.id, live.apiToken.id)).statusCode).toBe(204);
      const again = created(await createToken(admin.access, admin.group.id, account.id, { name: "Deploy" }));
      expect(again.apiToken.id).not.toBe(live.apiToken.id);
    });

    it("a deleted account gets no token: 404 service_account_not_found, and an unknown account is 404", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const deleted = await server.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${admin.group.id}/service-accounts/${account.id}`,
        headers: csrfHeaders,
        cookies: { telflo_access: admin.access },
      });
      expect(deleted.statusCode).toBe(204);
      const elsewhere = await memberActiveInGroup("admin");
      const theirs = await serviceAccountIn(elsewhere.group.id);

      for (const id of [account.id, randomUUID(), theirs.id, "not-a-uuid", account.id.replace(/-/g, "")]) {
        expectRefusal(
          await createToken(admin.access, admin.group.id, id),
          404,
          "service_account_not_found",
          "Service account not found.",
        );
        expectRefusal(await listTokens(admin.access, admin.group.id, id), 404, "service_account_not_found");
      }
      expect(await tokenRows()).toEqual([]);
    });
  });

  describe("list", () => {
    it("the list holds the prefix, access, expiry, last use and isExpired, and never the token or its hash", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const at = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
      const older = await ownerMadeToken(admin.group.id, account.id, {
        name: "Older",
        created_at: at(30),
        last_used_at: at(5),
        access: "write",
      });
      const expired = await ownerMadeToken(admin.group.id, account.id, {
        name: "Expired",
        created_at: at(20),
        expires_at: at(10),
      });
      // Expiring exactly at the API's clock: expired (the lookup's `expires_at > p_at`).
      const atClock = await ownerMadeToken(admin.group.id, account.id, {
        name: "At the clock",
        created_at: at(15),
        expires_at: clock,
      });
      const newest = await ownerMadeToken(admin.group.id, account.id, {
        name: "Newest",
        created_at: at(10),
        expires_at: new Date(clock.getTime() + DAY),
        created_by_user_id: admin.user.id,
      });
      await ownerMadeToken(admin.group.id, account.id, { name: "Revoked", created_at: at(1), revoked_at: at(0) });
      const otherAccount = await serviceAccountIn(admin.group.id);
      await ownerMadeToken(admin.group.id, otherAccount.id, { name: "Not this account's" });

      const response = await listTokens(admin.access, admin.group.id, account.id.toUpperCase());

      expect(response.statusCode).toBe(200);
      // The canaries first: the body holds no token and no hash, and no item but in
      // its prefix, before any comparison could print one.
      const fixtures = [newest, atClock, expired, older];
      for (const { token, apiToken } of fixtures) {
        expect(response.body.includes(token.slice(3))).toBe(false);
        expect(response.body.includes(apiToken.token_hash)).toBe(false);
      }
      const items = response.json<{ items: ApiTokenBody[] }>().items;
      expect(items.map((item, index) => item.prefix === fixtures[index]?.token.slice(0, 11))).toEqual([true, true, true, true]);
      expect(
        items.some((item) => fixtures.some(({ token }) => JSON.stringify(withoutPrefix(item)).includes(token.slice(0, 11)))),
      ).toBe(false);
      expect(items.map(withoutPrefix)).toEqual([
        {
          id: newest.apiToken.id,
          name: "Newest",
          access: "read",
          expiresAt: new Date(clock.getTime() + DAY).toISOString(),
          lastUsedAt: null,
          createdAt: at(10).toISOString(),
          isExpired: false,
        },
        {
          id: atClock.apiToken.id,
          name: "At the clock",
          access: "read",
          expiresAt: clock.toISOString(),
          lastUsedAt: null,
          createdAt: at(15).toISOString(),
          isExpired: true,
        },
        {
          id: expired.apiToken.id,
          name: "Expired",
          access: "read",
          expiresAt: at(10).toISOString(),
          lastUsedAt: null,
          createdAt: at(20).toISOString(),
          isExpired: true,
        },
        {
          id: older.apiToken.id,
          name: "Older",
          access: "write",
          expiresAt: null,
          lastUsedAt: at(5).toISOString(),
          createdAt: at(30).toISOString(),
          isExpired: false,
        },
      ]);
      expect(Object.keys(items[0]!).sort()).toEqual(
        ["access", "createdAt", "expiresAt", "id", "isExpired", "lastUsedAt", "name", "prefix"].sort(),
      );
      // The account's page and the accounts' list agree on the count: not revoked, expired included.
      const accounts = await server.inject({
        method: "GET",
        url: `/api/v1/organizations/${admin.group.id}/service-accounts/${account.id}`,
        cookies: { telflo_access: admin.access },
      });
      expect(accounts.json()).toMatchObject({ serviceAccount: { tokenCount: 4 } });
    });
  });

  describe("revoke", () => {
    it("revokes: revoked_at and revoked_by set, audited, the token leaves the list; an unknown, another account's and an already revoked token are 404 alike", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const other = await serviceAccountIn(admin.group.id);
      const target = created(await createToken(admin.access, admin.group.id, account.id));
      const kept = created(await createToken(admin.access, admin.group.id, account.id));
      const othersToken = created(await createToken(admin.access, admin.group.id, other.id));
      const elsewhere = await memberActiveInGroup("admin");
      const elsewhereAccount = await serviceAccountIn(elsewhere.group.id);
      const elsewhereToken = created(await createToken(elsewhere.access, elsewhere.group.id, elsewhereAccount.id));
      clock = new Date(clock.getTime() + 60_000);

      const response = await revokeToken(admin.access, admin.group.id, account.id, target.apiToken.id.toUpperCase());

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      // The row without its hash and prefix, which a failed comparison would print.
      const row = await ownerDb
        .selectFrom("api_tokens")
        .select(["revoked_at", "revoked_by_user_id"])
        .where("id", "=", target.apiToken.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ revoked_at: clock, revoked_by_user_id: admin.user.id });
      const revokedRow = (await tokenAudits()).at(-1)!;
      // The canaries first: the audit row, whole, holds neither the token nor its prefix.
      const serializedRevoke = JSON.stringify(revokedRow);
      expect([target.token, target.token.slice(3), target.apiToken.prefix].some((text) => serializedRevoke.includes(text))).toBe(
        false,
      );
      expect(Object.keys(revokedRow.metadata as object)).toEqual(["serviceAccountId"]);
      expect(revokedRow).toMatchObject({
        action: "api_token.revoked",
        actor_user_id: admin.user.id,
        organization_id: admin.group.id,
        subject_type: "api_token",
        subject_id: target.apiToken.id,
      });
      // Exactly the account's id: no name, prefix or token.
      expect(revokedRow.metadata).toEqual({ serviceAccountId: account.id });
      const listed = (await listTokens(admin.access, admin.group.id, account.id)).json<{ items: ApiTokenBody[] }>();
      expect(listed.items.map((item) => item.id)).toEqual([kept.apiToken.id]);
      const before = await tokenRows();
      const audited = (await tokenAudits()).length;

      const refusals = [
        // Unknown.
        await revokeToken(admin.access, admin.group.id, account.id, randomUUID()),
        // Another account's, named under this one.
        await revokeToken(admin.access, admin.group.id, account.id, othersToken.apiToken.id),
        // Another organization's, named under one of this organization's accounts and under its own.
        await revokeToken(admin.access, admin.group.id, account.id, elsewhereToken.apiToken.id),
        await revokeToken(admin.access, admin.group.id, elsewhereAccount.id, elsewhereToken.apiToken.id),
        // Already revoked.
        await revokeToken(admin.access, admin.group.id, account.id, target.apiToken.id),
        // Not canonical uuids.
        await revokeToken(admin.access, admin.group.id, account.id, kept.apiToken.id.replace(/-/g, "")),
        await revokeToken(admin.access, admin.group.id, "not-a-uuid", kept.apiToken.id),
      ];
      for (const refusal of refusals) expectRefusal(refusal, 404, "api_token_not_found", "Token not found");
      expect(new Set(refusals.map((refusal) => refusal.body)).size).toBe(1);
      expect(await tokenRows()).toEqual(before);
      expect(await tokenAudits()).toHaveLength(audited);
    });

    it("an expired token not yet revoked can be revoked", async () => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const { apiToken } = await ownerMadeToken(admin.group.id, account.id, {
        created_at: new Date(clock.getTime() - 2 * DAY),
        expires_at: new Date(clock.getTime() - DAY),
      });

      expect((await revokeToken(admin.access, admin.group.id, account.id, apiToken.id)).statusCode).toBe(204);

      expect(
        await ownerDb.selectFrom("api_tokens").select(["revoked_at", "revoked_by_user_id"]).where("id", "=", apiToken.id).executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: clock, revoked_by_user_id: admin.user.id });
      expect((await listTokens(admin.access, admin.group.id, account.id)).json()).toEqual({ items: [] });
    });
  });

  describe("who may", () => {
    it("a contributor is 403 on all three, another organization's admin 404", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const other = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const { apiToken } = created(await createToken(admin.access, admin.group.id, account.id));
      const before = await tokenRows();
      const audited = (await tokenAudits()).length;

      expectRefusal(await listTokens(contributor.access, admin.group.id, account.id), 403, "organization_admin_required");
      expectRefusal(await createToken(contributor.access, admin.group.id, account.id), 403, "organization_admin_required");
      expectRefusal(await revokeToken(contributor.access, admin.group.id, account.id, apiToken.id), 403, "organization_admin_required");
      for (const response of [
        await listTokens(other.access, admin.group.id, account.id),
        await createToken(other.access, admin.group.id, account.id),
        await revokeToken(other.access, admin.group.id, account.id, apiToken.id),
      ]) {
        expectRefusal(response, 404, "organization_not_found", "Organization not found");
      }
      // Under their own organization's path, this organization's account and token are unknown.
      expectRefusal(await listTokens(other.access, other.group.id, account.id), 404, "service_account_not_found");
      expectRefusal(await createToken(other.access, other.group.id, account.id), 404, "service_account_not_found");
      expectRefusal(await revokeToken(other.access, other.group.id, account.id, apiToken.id), 404, "api_token_not_found");
      expect(await tokenRows()).toEqual(before);
      expect(await tokenAudits()).toHaveLength(audited);
    });

    it.each([
      ["a create", (access: string, organizationId: string, accountId: string, _tokenId: string) => createToken(access, organizationId, accountId)],
      ["a revoke", (access: string, organizationId: string, accountId: string, tokenId: string) => revokeToken(access, organizationId, accountId, tokenId)],
    ])("refuses %s by an admin demoted while it waited on the organization lock with 403, changing nothing", async (_label, request) => {
      const admin = await memberActiveInGroup("admin");
      const account = await serviceAccountIn(admin.group.id);
      const { apiToken } = await ownerMadeToken(admin.group.id, account.id);
      const before = await tokenRows();

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
        const pending = request(admin.access, admin.group.id, account.id, apiToken.id);
        pending.catch(() => undefined);
        await waitForLockWait("organizations");
        await locker.query("commit");
        lockerInTransaction = false;

        expectRefusal(await pending, 403, "organization_admin_required");
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
      expect(await tokenRows()).toEqual(before);
      expect((await tokenAudits()).length).toBe(0);
    });
  });
});
