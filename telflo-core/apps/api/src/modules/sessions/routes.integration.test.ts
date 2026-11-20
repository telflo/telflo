import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  removeMembership,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import { withDatabaseContext } from "../../database/context.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { createAccessTokens } from "./access-tokens.js";
import { REFRESH_GRACE_SECONDS } from "./service.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** One `Set-Cookie` header, split into its name, value and attributes. */
interface SetCookie {
  name: string;
  value: string;
  attributes: string[];
}

function setCookies(response: LightMyRequestResponse): Map<string, SetCookie> {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookies = new Map<string, SetCookie>();
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    const separator = pair!.indexOf("=");
    const name = pair!.slice(0, separator);
    cookies.set(name, { name, value: pair!.slice(separator + 1), attributes });
  }
  return cookies;
}

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const cookie = setCookies(response).get(name);
  if (!cookie) throw new Error(`the response set no ${name} cookie`);
  return cookie.value;
}

/** A JWT's `iat` and `exp`, read without verifying it: the routes tests check dates, not signatures. */
function jwtDates(token: string): { iat: number; exp: number } {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat: number; exp: number };
}

function expectCleared(response: LightMyRequestResponse, isSecure = true): void {
  const cookies = setCookies(response);
  const secure = isSecure ? ["Secure"] : [];
  expect(cookies.get("telflo_access")).toEqual({
    name: "telflo_access",
    value: "",
    attributes: ["Max-Age=0", "Path=/", "HttpOnly", ...secure, "SameSite=Lax"],
  });
  expect(cookies.get("telflo_refresh")).toEqual({
    name: "telflo_refresh",
    value: "",
    attributes: ["Max-Age=0", "Path=/api/v1/auth/refresh", "HttpOnly", ...secure, "SameSite=Lax"],
  });
}

describe("session routes", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only DDL and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  /** The server's clock. Reset to real time before each test; advanced to test expiry. */
  let clock: Date;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    server = buildServer({
      settings,
      db,
      mailer: createInMemoryMailer(),
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
    });
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
  });

  const advanceClockMinutes = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  const advanceClockSeconds = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  const verifiedUser = (email = `person-${Math.random().toString(36).slice(2)}@example.com`) =>
    createUserWithOrganization(ownerDb, { user: { email, password_hash: passwordHash } });

  const signIn = (email: string, password = PASSWORD, target = server) =>
    target.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password },
    });

  /** Signs in and returns the two cookie values. */
  const signedIn = async (email: string) => {
    const response = await signIn(email);
    expect(response.statusCode).toBe(200);
    return {
      access: cookieValue(response, "telflo_access"),
      refresh: cookieValue(response, "telflo_refresh"),
    };
  };

  const me = (access?: string) =>
    server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const refresh = (refreshToken?: string) =>
    server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: csrfHeaders,
      ...(refreshToken === undefined ? {} : { cookies: { telflo_refresh: refreshToken } }),
    });

  const logout = (access?: string) =>
    server.inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions/current",
      headers: csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const signOutEverywhere = (access?: string) =>
    server.inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  /**
   * Resolves once `count` backends other than this test's own are waiting
   * on a row lock: the requests have reached the locks a held transaction
   * blocks. Throws after five seconds.
   */
  const waitForLockWaits = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
      `.execute(ownerDb);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} backends to wait on a lock`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  describe("POST /api/v1/auth/sessions", () => {
    it("sets both cookies with the exact attributes", async () => {
      const account = await verifiedUser();
      const response = await signIn(account.user.email);

      expect(response.statusCode).toBe(200);
      const cookies = setCookies(response);
      // The access cookie lasts as long as the refresh token.
      expect(cookies.get("telflo_access")?.attributes).toEqual([
        `Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ]);
      expect(cookies.get("telflo_refresh")?.attributes).toEqual([
        `Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`,
        "Path=/api/v1/auth/refresh",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ]);
      expect(cookies.get("telflo_access")?.value).not.toBe("");
      expect(cookies.get("telflo_refresh")?.value).not.toBe("");
    });

    it("keeps the access cookie for the refresh TTL, while its token still expires after the access TTL", async () => {
      const account = await verifiedUser();
      const response = await signIn(account.user.email);

      const access = setCookies(response).get("telflo_access");
      expect(access?.attributes).toContain(`Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`);
      const { iat, exp } = jwtDates(access!.value);
      expect(exp - iat).toBe(settings.accessTokenTtlMinutes * 60);
    });

    it("omits Secure when the settings turn it off", async () => {
      const insecureServer = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, isCookieSecure: false },
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
      });
      try {
        await insecureServer.ready();
        const account = await verifiedUser();
        const response = await signIn(account.user.email, PASSWORD, insecureServer);

        expect(response.statusCode).toBe(200);
        for (const cookie of setCookies(response).values()) {
          expect(cookie.attributes).not.toContain("Secure");
          expect(cookie.attributes).toContain("HttpOnly");
          expect(cookie.attributes).toContain("SameSite=Lax");
        }
      } finally {
        await insecureServer.close();
      }
    });

    it("returns the user and neither token in the body", async () => {
      const account = await verifiedUser();
      const response = await signIn(account.user.email);

      expect(response.json()).toEqual({ user: { id: account.user.id, email: account.user.email } });
      expect(response.body).not.toContain(cookieValue(response, "telflo_access"));
      expect(response.body).not.toContain(cookieValue(response, "telflo_refresh"));
    });

    it("refuses a wrong password with invalid_credentials and sets no cookie", async () => {
      const account = await verifiedUser();
      const response = await signIn(account.user.email, "not-the-right-password");

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "invalid_credentials", message: "Invalid login credentials" } });
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    /**
     * A service account's address is an unknown address to sign-in. It holds
     * no password, so without the human-only lookup it would be audited
     * `no_password` with the account as actor; it is `unknown_email` with no
     * actor, the same answer as an unknown address's. That an unknown
     * address pays the dummy verify is sessions/service.test.ts's "still
     * performs one password verification, against an Argon2id hash with the
     * stored parameters, for an unknown email".
     */
    it("a service account's address answers invalid_credentials as an unknown address does, audited unknown_email with no actor", async () => {
      const { organization } = await verifiedUser();
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });

      const response = await signIn(serviceAccount.email);
      const unknown = await signIn("nobody@example.com");

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "invalid_credentials", message: "Invalid login credentials" } });
      expect(response.body).toBe(unknown.body);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await ownerDb.selectFrom("sessions").selectAll().execute()).toEqual([]);
      const failures = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "actor_email", "subject_id", "metadata"])
        .where("action", "=", "user.sign_in_failed")
        .orderBy("occurred_at")
        .execute();
      expect(failures).toHaveLength(2);
      for (const failure of failures) {
        expect(failure).toMatchObject({
          actor_user_id: null,
          actor_email: null,
          subject_id: null,
          metadata: { reason: "unknown_email" },
        });
      }
    });

    it("a human's wrong password answers invalid_credentials, beside it", async () => {
      const account = await verifiedUser();

      const response = await signIn(account.user.email, "not-the-right-password");

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "invalid_credentials", message: "Invalid login credentials" } });
      const failure = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "metadata"])
        .where("action", "=", "user.sign_in_failed")
        .executeTakeFirstOrThrow();
      expect(failure).toEqual({ actor_user_id: account.user.id, metadata: { reason: "wrong_password" } });
    });

    it("refuses an unverified account with email_not_verified", async () => {
      const account = await createUserWithOrganization(ownerDb, {
        user: { password_hash: passwordHash, email_verified_at: null },
      });
      const response = await signIn(account.user.email);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "email_not_verified" } });
    });

    it("rejects a body that fails the contract", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        payload: { email: "person@example.com", password: "" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    });

    it("creates no session when its refresh token cannot be inserted", async () => {
      const account = await verifiedUser();

      await withFailingInsert(ownerDb, "refresh_tokens", `raise exception 'refused by test'`, async () => {
        const response = await signIn(account.user.email);
        expect(response.statusCode).toBe(500);
        expect(response.headers["set-cookie"]).toBeUndefined();
      });

      expect(await ownerDb.selectFrom("sessions").selectAll().execute()).toEqual([]);
      expect(await ownerDb.selectFrom("refresh_tokens").selectAll().execute()).toEqual([]);
      const actions = await ownerDb.selectFrom("audit_events").select("action").execute();
      expect(actions.map((row) => row.action)).not.toContain("user.signed_in");
    });

    it("records the client address and user agent on the session", async () => {
      const account = await verifiedUser();
      await server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: { ...csrfHeaders, "user-agent": "session-routes-test" },
        payload: { email: account.user.email, password: PASSWORD },
      });
      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.user_agent).toBe("session-routes-test");
      expect(session.ip_address).not.toBeNull();
    });

    it("refuses a sign-in whose password changed after it verified, and creates no session", async () => {
      // A separate connection holds the user's row, as a reset in flight
      // does, until the sign-in has verified the password and is blocked on
      // its recheck. The locker then changes the hash and commits: the
      // sign-in must see the new hash, not keep a session made with the old.
      const account = await verifiedUser();
      const newHash = await hashPassword("a-different-sufficiently-long-password");

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from users where id = $1 for update", [account.user.id]);
        const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

        const pending = signIn(account.user.email);
        pending.catch(() => undefined);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await sql<{ blocked: number }>`
            select count(*)::int as blocked
            from pg_stat_activity
            where datname = current_database()
              and pid <> ${lockerPid}
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%users%'
          `.execute(ownerDb);
          if ((rows[0]?.blocked ?? 0) >= 1) break;
          if (Date.now() > deadline) throw new Error("timed out waiting for the sign-in to block on users");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await locker.query("update users set password_hash = $1 where id = $2", [newHash, account.user.id]);
        await locker.query("commit");
        lockerInTransaction = false;

        const response = await pending;
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "invalid_credentials" } });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await ownerDb.selectFrom("sessions").selectAll().execute()).toEqual([]);
        expect(await ownerDb.selectFrom("refresh_tokens").selectAll().execute()).toEqual([]);
        const failure = await ownerDb
          .selectFrom("audit_events")
          .selectAll()
          .where("action", "=", "user.sign_in_failed")
          .executeTakeFirstOrThrow();
        expect(failure).toMatchObject({ actor_user_id: account.user.id, metadata: { reason: "password_changed" } });
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns the user, the personal organization with role admin, and a one-entry organizations list", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      const response = await me(access);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        user: { id: account.user.id, email: account.user.email },
        organization: { id: account.organization.id, name: account.organization.name, type: "personal", logoId: null, role: "admin" },
        organizations: [
          { id: account.organization.id, name: account.organization.name, type: "personal", logoId: null, role: "admin" },
        ],
        termsAcceptanceRequired: false,
        isProductAdmin: false,
        mayCreateOrganizations: true,
        preferences: DEFAULT_USER_PREFERENCES,
      });
    });

    describe("isProductAdmin", () => {
      const meFor = async (isProductAdmin: boolean | undefined) => {
        const account = await createUserWithOrganization(ownerDb, {
          user: {
            email: `admin-${Math.random().toString(36).slice(2)}@example.com`,
            password_hash: passwordHash,
            ...(isProductAdmin === undefined ? {} : { is_product_admin: isProductAdmin }),
          },
        });
        const { access } = await signedIn(account.user.email);
        const response = await me(access);
        expect(response.statusCode).toBe(200);
        return response.json<{ isProductAdmin: boolean }>().isProductAdmin;
      };

      it("is true for a user whose row has the flag", async () => {
        expect(await meFor(true)).toBe(true);
      });

      it("is false for a user whose row has it false", async () => {
        expect(await meFor(false)).toBe(false);
      });

      it("is false for a user created without it, the column's default", async () => {
        expect(await meFor(undefined)).toBe(false);
      });
    });

    describe("termsAcceptanceRequired", () => {
      const meFor = async (terms: { accepted_terms_version: string | null; terms_accepted_at: Date | null }) => {
        const account = await createUserWithOrganization(ownerDb, {
          user: { email: `terms-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash, ...terms },
        });
        const { access } = await signedIn(account.user.email);
        const response = await me(access);
        expect(response.statusCode).toBe(200);
        return response.json<{ termsAcceptanceRequired: boolean }>().termsAcceptanceRequired;
      };

      it("is true for a user who has accepted no terms", async () => {
        expect(await meFor({ accepted_terms_version: null, terms_accepted_at: null })).toBe(true);
      });

      it("is true for a user who accepted an older version", async () => {
        expect(await meFor({ accepted_terms_version: "2025-01-01", terms_accepted_at: new Date() })).toBe(true);
      });

      it("is false for a user who accepted the current version", async () => {
        expect(await meFor({ accepted_terms_version: TEST_TERMS_VERSION, terms_accepted_at: new Date() })).toBe(
          false,
        );
      });

      it("is false for users seeded by the test helpers, so browser tests never meet the dialog", async () => {
        const account = await verifiedUser();
        expect(account.user.accepted_terms_version).toBe(TEST_TERMS_VERSION);
      });
    });

    it("is 401 unauthenticated without a cookie", async () => {
      const response = await me();
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "unauthenticated", message: "You need to sign in." } });
    });

    it("is 401 unauthenticated with a token that isn't one of ours", async () => {
      const response = await me("not-a-jwt");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("is 401 access_token_expired once the access token has expired", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      advanceClockMinutes(settings.accessTokenTtlMinutes + 1);

      const response = await me(access);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "access_token_expired", message: "Your session has expired." } });
    });

    it("is 401 after logout, although the access token itself has not expired", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      expect((await me(access)).statusCode).toBe(200);

      expect((await logout(access)).statusCode).toBe(204);
      const response = await me(access);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("lists every live organization the user belongs to, with its type and the user's role, personal first, and none of anyone else's", async () => {
      const account = await verifiedUser();
      const group = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });
      const stranger = await verifiedUser();
      await addMembership(ownerDb, { userId: stranger.user.id });
      const { access } = await signedIn(account.user.email);

      const response = await me(access);

      expect(response.statusCode).toBe(200);
      expect(response.json<{ organizations: unknown }>().organizations).toEqual([
        { id: account.organization.id, name: account.organization.name, type: "personal", logoId: null, role: "admin" },
        { id: group.organization.id, name: group.organization.name, type: "group", logoId: null, role: "contributor" },
      ]);
    });

    it("reads the role on every request, so a demotion shows on the member's next request", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      expect((await me(access)).json<{ organization: { role: string } }>().organization.role).toBe("admin");

      await ownerDb
        .updateTable("organization_members")
        .set({ role: "contributor" })
        .where("id", "=", account.membership.id)
        .execute();

      const response = await me(access);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ organization: { role: string } }>().organization.role).toBe("contributor");
    });
  });

  describe("a token naming an organization its session has left", () => {
    /** Signs in, then moves the session to a group organization the user also belongs to, as a switch does. */
    const signedInThenMoved = async () => {
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization.
      const cookies = await signedIn(account.user.email);
      const group = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });
      await ownerDb
        .updateTable("sessions")
        .set({ active_organization_id: group.organization.id })
        .where("user_id", "=", account.user.id)
        .execute();
      return { account, group: group.organization, cookies };
    };

    it("is 401 access_token_expired, not unauthenticated", async () => {
      const { cookies } = await signedInThenMoved();

      const response = await me(cookies.access);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "access_token_expired", message: "Your session has expired." } });
    });

    it("is answered by a refresh, which issues a token for the session's organization, and the retry succeeds", async () => {
      const { group, cookies } = await signedInThenMoved();
      expect((await me(cookies.access)).statusCode).toBe(401);

      const refreshed = await refresh(cookies.refresh);
      expect(refreshed.statusCode).toBe(200);
      const retried = await me(cookieValue(refreshed, "telflo_access"));

      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({
        organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
      });
    });

    it("stays unauthenticated for a token naming another user, even with that session's organization", async () => {
      const account = await verifiedUser();
      await signedIn(account.user.email);
      const other = await verifiedUser();
      const session = await ownerDb
        .selectFrom("sessions")
        .select(["id", "active_organization_id"])
        .where("user_id", "=", account.user.id)
        .executeTakeFirstOrThrow();
      const accessTokens = createAccessTokens({
        secret: settings.accessTokenSecret,
        ttlMinutes: settings.accessTokenTtlMinutes,
        now: () => clock,
      });

      for (const organizationId of [session.active_organization_id, other.organization.id]) {
        const forged = await accessTokens.issue({ userId: other.user.id, sessionId: session.id, organizationId });
        const response = await me(forged.token);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
      }
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("rotates the pair; the old refresh token then fails and revokes the session", async () => {
      const account = await verifiedUser();
      const first = await signedIn(account.user.email);

      const rotated = await refresh(first.refresh);
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json()).toEqual({ user: { id: account.user.id, email: account.user.email } });
      const second = {
        access: cookieValue(rotated, "telflo_access"),
        refresh: cookieValue(rotated, "telflo_refresh"),
      };
      expect(second.access).not.toBe(first.access);
      expect(second.refresh).not.toBe(first.refresh);
      expect(rotated.body).not.toContain(second.access);
      expect(rotated.body).not.toContain(second.refresh);
      expect((await me(second.access)).statusCode).toBe(200);

      // The first refresh token again, after the grace window: a reuse.
      advanceClockSeconds(REFRESH_GRACE_SECONDS + 1);
      const reused = await refresh(first.refresh);
      expect(reused.statusCode).toBe(401);
      expect(reused.json()).toMatchObject({ error: { code: "unauthenticated" } });

      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_reason).toBe("refresh_token_reused");
      expect((await me(second.access)).statusCode).toBe(401);
      expect((await refresh(second.refresh)).statusCode).toBe(401);
    });

    it("keeps the cookies on a failed rotation, and the retry succeeds without being treated as a reuse", async () => {
      const account = await verifiedUser();
      const first = await signedIn(account.user.email);

      await withFailingInsert(ownerDb, "refresh_tokens", `raise exception 'refused by test'`, async () => {
        const failed = await refresh(first.refresh);
        expect(failed.statusCode).toBe(500);
        expect(failed.json()).toMatchObject({ error: { code: "internal_error" } });
        // No Set-Cookie at all: the browser keeps both cookies.
        expect(failed.headers["set-cookie"]).toBeUndefined();
      });

      const retried = await refresh(first.refresh);
      expect(retried.statusCode).toBe(200);
      const second = {
        access: cookieValue(retried, "telflo_access"),
        refresh: cookieValue(retried, "telflo_refresh"),
      };
      expect(second.refresh).not.toBe(first.refresh);
      expect((await me(second.access)).statusCode).toBe(200);

      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_at).toBeNull();
      expect(session.revoked_reason).toBeNull();
      const reuses = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "session.refresh_token_reused")
        .execute();
      expect(reuses).toEqual([]);
    });

    it("sets the rotated cookies with the same attributes as sign-in", async () => {
      const account = await verifiedUser();
      const { refresh: refreshToken } = await signedIn(account.user.email);

      const rotated = await refresh(refreshToken);

      const cookies = setCookies(rotated);
      expect(cookies.get("telflo_access")?.attributes).toContain("Path=/");
      expect(cookies.get("telflo_refresh")?.attributes).toContain("Path=/api/v1/auth/refresh");
      expect(cookies.get("telflo_refresh")?.attributes).toContain(
        `Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`,
      );
    });

    it("keeps the rotated access cookie for the refresh TTL, while its token still expires after the access TTL", async () => {
      const account = await verifiedUser();
      const { refresh: refreshToken } = await signedIn(account.user.email);

      const rotated = await refresh(refreshToken);

      expect(rotated.statusCode).toBe(200);
      const access = setCookies(rotated).get("telflo_access");
      expect(access?.attributes).toContain(`Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`);
      const { iat, exp } = jwtDates(access!.value);
      expect(exp - iat).toBe(settings.accessTokenTtlMinutes * 60);
    });

    it("clears both cookies when the refresh token is refused", async () => {
      const response = await refresh("not-a-real-refresh-token");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "unauthenticated", message: "You need to sign in." } });
      expectCleared(response);
    });

    it("clears both cookies when there is no refresh cookie at all", async () => {
      const response = await refresh();
      expect(response.statusCode).toBe(401);
      expectCleared(response);
    });

    describe("the grace window", () => {
      /** Signs in and rotates once; returns both pairs. */
      const rotatedOnce = async (email: string) => {
        const first = await signedIn(email);
        const rotated = await refresh(first.refresh);
        expect(rotated.statusCode).toBe(200);
        const second = {
          access: cookieValue(rotated, "telflo_access"),
          refresh: cookieValue(rotated, "telflo_refresh"),
        };
        return { first, second };
      };

      const refreshTokenRowCount = async () =>
        (await ownerDb.selectFrom("refresh_tokens").select(sql<number>`count(*)::int`.as("count")).executeTakeFirstOrThrow())
          .count;

      const reuseAudits = () =>
        ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "session.refresh_token_reused").execute();

      it("answers a second refresh with the same cookie within the window with only a new access cookie", async () => {
        const account = await verifiedUser();
        const { first, second } = await rotatedOnce(account.user.email);
        const rowsBefore = await refreshTokenRowCount();
        advanceClockSeconds(REFRESH_GRACE_SECONDS);

        const grace = await refresh(first.refresh);

        expect(grace.statusCode).toBe(200);
        expect(grace.json()).toEqual({ user: { id: account.user.id, email: account.user.email } });
        const cookies = setCookies(grace);
        // The theme cookie too, never the refresh cookie.
        expect([...cookies.keys()]).toEqual(["telflo_access", "telflo_theme"]);
        expect(cookies.get("telflo_access")?.attributes).toEqual([
          `Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`,
          "Path=/",
          "HttpOnly",
          "Secure",
          "SameSite=Lax",
        ]);
        const graceAccess = cookies.get("telflo_access")!.value;
        expect(graceAccess).not.toBe(second.access);
        expect(grace.body).not.toContain(graceAccess);
        expect((await me(graceAccess)).statusCode).toBe(200);

        const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
        expect(session.revoked_at).toBeNull();
        expect(await refreshTokenRowCount()).toBe(rowsBefore);
        expect(await reuseAudits()).toEqual([]);

        // The rotation the first refresh won still carries on.
        expect((await refresh(second.refresh)).statusCode).toBe(200);
      });

      it("treats the same presentation after the window as a reuse: 401, the session revoked, the reuse audited", async () => {
        const account = await verifiedUser();
        const { first, second } = await rotatedOnce(account.user.email);
        advanceClockSeconds(REFRESH_GRACE_SECONDS + 1);

        const reused = await refresh(first.refresh);

        expect(reused.statusCode).toBe(401);
        expect(reused.json()).toMatchObject({ error: { code: "unauthenticated" } });
        expectCleared(reused);
        const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
        expect(session.revoked_reason).toBe("refresh_token_reused");
        expect(await reuseAudits()).toMatchObject([
          { actor_user_id: account.user.id, subject_type: "session", subject_id: session.id },
        ]);
        expect((await me(second.access)).statusCode).toBe(401);
      });

      it("refuses a presentation within the window for a revoked session, without auditing a reuse", async () => {
        const account = await verifiedUser();
        const { first, second } = await rotatedOnce(account.user.email);
        expect((await logout(second.access)).statusCode).toBe(204);

        const response = await refresh(first.refresh);

        expect(response.statusCode).toBe(401);
        expectCleared(response);
        const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
        expect(session.revoked_reason).toBe("logout");
        expect(await reuseAudits()).toEqual([]);
      });

      it("refuses an expired refresh token presented again within the window, without revoking or auditing", async () => {
        const account = await verifiedUser();
        const { refresh: refreshToken } = await signedIn(account.user.email);
        advanceClockMinutes(settings.refreshTokenTtlDays * 24 * 60 + 1);

        // The first presentation consumes the expired token and is refused.
        const first = await refresh(refreshToken);
        expect(first.statusCode).toBe(401);
        expectCleared(first);
        const consumed = await ownerDb
          .selectFrom("refresh_tokens")
          .select("consumed_at")
          .where("token_hash", "=", hashToken(refreshToken))
          .executeTakeFirstOrThrow();
        expect(consumed.consumed_at).not.toBeNull();

        advanceClockSeconds(REFRESH_GRACE_SECONDS);
        const again = await refresh(refreshToken);

        expect(again.statusCode).toBe(401);
        expect(again.json()).toMatchObject({ error: { code: "unauthenticated" } });
        expectCleared(again);
        expect(setCookies(again).get("telflo_access")?.value).toBe("");
        const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
        expect(session.revoked_at).toBeNull();
        expect(session.revoked_reason).toBeNull();
        expect(await reuseAudits()).toEqual([]);
      });

      /**
       * Resolves once `count` backends other than `lockerPid` are waiting on
       * a lock while running a statement against refresh_tokens; throws
       * after five seconds rather than hanging the suite.
       */
      const waitForBlockedBackends = async (lockerPid: number, count: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await sql<{ blocked: number }>`
            select count(*)::int as blocked
            from pg_stat_activity
            where datname = current_database()
              and pid <> ${lockerPid}
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%refresh_tokens%'
          `.execute(ownerDb);
          if ((rows[0]?.blocked ?? 0) >= count) return;
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${count} backends blocked on refresh_tokens`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      it("lets two concurrent refreshes with the same cookie both succeed, rotating once and leaving the session live", async () => {
        // A separate connection holds the token's row lock until both
        // refreshes are blocked on it at the database, so they really race.
        // The first to block reads the clock at T and the second at T - 1 s.
        // Postgres queues tuple-lock waiters in order, so the first wins and
        // writes consumed_at = T, and the second's own reading is a second
        // earlier than that: a negative difference, which must still be within
        // the window.
        const account = await verifiedUser();
        const { refresh: refreshToken } = await signedIn(account.user.email);

        const locker = await pool.connect();
        let lockerInTransaction = false;
        try {
          await locker.query("begin");
          lockerInTransaction = true;
          await locker.query("select id from refresh_tokens where token_hash = $1 for update", [
            hashToken(refreshToken),
          ]);
          const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

          const earlier = refresh(refreshToken);
          earlier.catch(() => undefined);
          await waitForBlockedBackends(lockerPid, 1);
          advanceClockSeconds(-1);
          const later = refresh(refreshToken);
          later.catch(() => undefined);
          await waitForBlockedBackends(lockerPid, 2);

          await locker.query("rollback");
          lockerInTransaction = false;

          const responses = await Promise.all([earlier, later]);
          expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
          const settingRefresh = responses.filter((response) => setCookies(response).has("telflo_refresh"));
          expect(settingRefresh).toHaveLength(1);
          for (const response of responses) {
            expect((await me(cookieValue(response, "telflo_access"))).statusCode).toBe(200);
          }

          const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
          expect(session.revoked_at).toBeNull();
          expect(await reuseAudits()).toEqual([]);
          expect(await refreshTokenRowCount()).toBe(2);
          // The one rotation's new refresh token works.
          expect((await refresh(cookieValue(settingRefresh[0]!, "telflo_refresh"))).statusCode).toBe(200);
        } finally {
          if (lockerInTransaction) await locker.query("rollback");
          locker.release();
        }
      });
    });
  });

  describe("the theme cookie", () => {
    const THEME_COOKIE_ATTRIBUTES = ["Max-Age=31536000", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];

    /** A row as the owner writes it: the person saved `theme` earlier. */
    const storeTheme = async (userId: string, theme: "light" | "dark" | "navy") => {
      await ownerDb
        .insertInto("user_settings")
        .values({ user_id: userId, theme, created_at: clock, updated_at: clock })
        .onConflict((conflict) => conflict.column("user_id").doUpdateSet({ theme }))
        .execute();
    };

    it("sign-in sets telflo_theme to the stored theme, HttpOnly, Path=/, SameSite=Lax, Max-Age=31536000, Secure as the session cookies", async () => {
      const account = await verifiedUser();
      await storeTheme(account.user.id, "navy");

      const response = await signIn(account.user.email);

      expect(response.statusCode).toBe(200);
      const cookies = setCookies(response);
      expect([...cookies.keys()]).toEqual(["telflo_access", "telflo_refresh", "telflo_theme"]);
      expect(cookies.get("telflo_theme")).toEqual({ name: "telflo_theme", value: "navy", attributes: THEME_COOKIE_ATTRIBUTES });
      // Secure exactly as the session cookies, whichever way the settings say.
      expect(cookies.get("telflo_access")?.attributes).toContain("Secure");

      const insecureServer = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, isCookieSecure: false },
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
      });
      try {
        await insecureServer.ready();
        const insecure = setCookies(await signIn(account.user.email, PASSWORD, insecureServer));
        expect(insecure.get("telflo_theme")).toEqual({
          name: "telflo_theme",
          value: "navy",
          attributes: THEME_COOKIE_ATTRIBUTES.filter((attribute) => attribute !== "Secure"),
        });
        expect(insecure.get("telflo_access")?.attributes).not.toContain("Secure");
      } finally {
        await insecureServer.close();
      }
    });

    it("with no row it is dark", async () => {
      const account = await verifiedUser();

      const response = await signIn(account.user.email);

      expect(setCookies(response).get("telflo_theme")).toEqual({
        name: "telflo_theme",
        value: "dark",
        attributes: THEME_COOKIE_ATTRIBUTES,
      });
      const row = await ownerDb.selectFrom("user_settings").selectAll().where("user_id", "=", account.user.id).executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("a refused sign-in sets no theme cookie", async () => {
      const account = await verifiedUser();
      await storeTheme(account.user.id, "light");

      const response = await signIn(account.user.email, "not-the-password-at-all");

      expect(response.statusCode).toBe(401);
      expect(setCookies(response).has("telflo_theme")).toBe(false);
    });

    it("a rotation and a grace refresh set it", async () => {
      const account = await verifiedUser();
      await storeTheme(account.user.id, "light");
      const first = await signedIn(account.user.email);
      // Changed in another browser since this one signed in: the refresh carries it here.
      await storeTheme(account.user.id, "navy");

      const rotated = await refresh(first.refresh);

      expect(rotated.statusCode).toBe(200);
      const rotatedCookies = setCookies(rotated);
      expect([...rotatedCookies.keys()]).toEqual(["telflo_access", "telflo_refresh", "telflo_theme"]);
      expect(rotatedCookies.get("telflo_theme")).toEqual({ name: "telflo_theme", value: "navy", attributes: THEME_COOKIE_ATTRIBUTES });

      await storeTheme(account.user.id, "dark");
      advanceClockSeconds(REFRESH_GRACE_SECONDS);
      const grace = await refresh(first.refresh);

      expect(grace.statusCode).toBe(200);
      const graceCookies = setCookies(grace);
      expect([...graceCookies.keys()]).toEqual(["telflo_access", "telflo_theme"]);
      expect(graceCookies.get("telflo_theme")).toEqual({ name: "telflo_theme", value: "dark", attributes: THEME_COOKIE_ATTRIBUTES });
    });

    it("a theme read that fails loses neither the sign-in, the rotation nor a grace refresh: the session's cookies are set, the theme's isn't", async () => {
      const account = await verifiedUser();
      // The API's role can't read user_settings for a moment: the read fails after the session's work committed.
      let latestRefresh: string;
      await sql`revoke select on user_settings from telflo_platform_runtime`.execute(ownerDb);
      try {
        const signedInResponse = await signIn(account.user.email);
        expect(signedInResponse.statusCode).toBe(200);
        expect([...setCookies(signedInResponse).keys()]).toEqual(["telflo_access", "telflo_refresh"]);

        const rotated = await refresh(cookieValue(signedInResponse, "telflo_refresh"));
        expect(rotated.statusCode).toBe(200);
        expect([...setCookies(rotated).keys()]).toEqual(["telflo_access", "telflo_refresh"]);
        latestRefresh = cookieValue(rotated, "telflo_refresh");

        // A grace refresh (the consumed token, presented again within the
        // window) keeps its new access cookie too.
        const grace = await refresh(cookieValue(signedInResponse, "telflo_refresh"));
        expect(grace.statusCode).toBe(200);
        expect([...setCookies(grace).keys()]).toEqual(["telflo_access"]);
        expect(cookieValue(grace, "telflo_access")).not.toBe("");
      } finally {
        await sql`grant select on user_settings to telflo_platform_runtime`.execute(ownerDb);
      }

      // The rotation's refresh token is the live one: no reuse, the session stays, and the cookie comes back.
      const again = await refresh(latestRefresh);
      expect(again.statusCode).toBe(200);
      expect(setCookies(again).get("telflo_theme")?.value).toBe("dark");
      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_at).toBeNull();
    });

    it("logout, sign-out-everywhere and a refused refresh don't touch it", async () => {
      const account = await verifiedUser();
      await storeTheme(account.user.id, "light");
      const first = await signedIn(account.user.email);
      const second = await signedIn(account.user.email);

      const loggedOut = await logout(first.access);
      expect(loggedOut.statusCode).toBe(204);
      expect([...setCookies(loggedOut).keys()]).toEqual(["telflo_access", "telflo_refresh"]);

      const everywhere = await signOutEverywhere(second.access);
      expect(everywhere.statusCode).toBe(204);
      expect([...setCookies(everywhere).keys()]).toEqual(["telflo_access", "telflo_refresh"]);

      const refused = await refresh(second.refresh);
      expect(refused.statusCode).toBe(401);
      expect([...setCookies(refused).keys()]).toEqual(["telflo_access", "telflo_refresh"]);
    });
  });

  describe("DELETE /api/v1/auth/sessions/current", () => {
    it("revokes the session, clears both cookies and returns 204", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      const response = await logout(access);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expectCleared(response);
      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_reason).toBe("logout");
      const audit = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "user.signed_out")
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ actor_user_id: account.user.id, actor_email: account.user.email });
    });

    it("revokes the session named by an expired access token", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      advanceClockMinutes(settings.accessTokenTtlMinutes + 5);

      const response = await logout(access);

      expect(response.statusCode).toBe(204);
      expectCleared(response);
      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_at).not.toBeNull();
      expect(session.revoked_reason).toBe("logout");
    });

    it("returns 204 and clears the cookies without any cookie", async () => {
      const response = await logout();
      expect(response.statusCode).toBe(204);
      expectCleared(response);
    });

    it("returns 204 and revokes nothing for a token that isn't one of ours", async () => {
      const account = await verifiedUser();
      await signedIn(account.user.email);

      const response = await logout("not-a-jwt");

      expect(response.statusCode).toBe(204);
      expectCleared(response);
      const session = await ownerDb.selectFrom("sessions").selectAll().executeTakeFirstOrThrow();
      expect(session.revoked_at).toBeNull();
    });
  });

  describe("DELETE /api/v1/auth/sessions", () => {
    it("signs out every session of the user and leaves other users signed in", async () => {
      const account = await verifiedUser();
      const other = await verifiedUser();
      const firstSession = await signedIn(account.user.email);
      const secondSession = await signedIn(account.user.email);
      const otherSession = await signedIn(other.user.email);

      const response = await signOutEverywhere(firstSession.access);

      expect(response.statusCode).toBe(204);
      expectCleared(response);
      expect((await me(firstSession.access)).statusCode).toBe(401);
      expect((await me(secondSession.access)).statusCode).toBe(401);
      expect((await me(otherSession.access)).statusCode).toBe(200);
      const audit = await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "user.signed_out_everywhere")
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ actor_user_id: account.user.id, actor_email: account.user.email });
    });

    it("is 401 unauthenticated without a cookie", async () => {
      const response = await signOutEverywhere();
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  describe("PUT /api/v1/auth/me/terms-acceptance", () => {
    const acceptTerms = (access: string | undefined, version: string, headers: Record<string, string> = csrfHeaders) =>
      server.inject({
        method: "PUT",
        url: "/api/v1/auth/me/terms-acceptance",
        headers,
        payload: { version },
        ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      });

    const termsOf = (userId: string) =>
      ownerDb
        .selectFrom("users")
        .select(["accepted_terms_version", "terms_accepted_at"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();

    const termsAudits = (userId: string) =>
      ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("action", "=", "user.terms_accepted")
        .where("actor_user_id", "=", userId)
        .execute();

    const userWithoutTerms = () =>
      createUserWithOrganization(ownerDb, {
        user: {
          email: `no-terms-${Math.random().toString(36).slice(2)}@example.com`,
          password_hash: passwordHash,
          accepted_terms_version: null,
          terms_accepted_at: null,
        },
      });

    it("records the current version, audits it, answers 204, and /me no longer requires acceptance", async () => {
      const account = await userWithoutTerms();
      const { access } = await signedIn(account.user.email);
      expect((await me(access)).json()).toMatchObject({ termsAcceptanceRequired: true });

      const response = await acceptTerms(access, TEST_TERMS_VERSION);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(await termsOf(account.user.id)).toEqual({
        accepted_terms_version: TEST_TERMS_VERSION,
        terms_accepted_at: clock,
      });
      const audits = await termsAudits(account.user.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_email: account.user.email,
        organization_id: account.organization.id,
        subject_type: "user",
        subject_id: account.user.id,
        metadata: { version: TEST_TERMS_VERSION },
      });
      expect((await me(access)).json()).toMatchObject({ termsAcceptanceRequired: false });
    });

    it("is a no-op when repeated: 204, the first acceptance kept, and no second audit row", async () => {
      const account = await userWithoutTerms();
      const { access } = await signedIn(account.user.email);
      expect((await acceptTerms(access, TEST_TERMS_VERSION)).statusCode).toBe(204);
      const first = await termsOf(account.user.id);
      advanceClockMinutes(1);

      const response = await acceptTerms(access, TEST_TERMS_VERSION);

      expect(response.statusCode).toBe(204);
      expect(await termsOf(account.user.id)).toEqual(first);
      expect(await termsAudits(account.user.id)).toHaveLength(1);
    });

    it("refuses an older version with 400 terms_version_not_current, and changes nothing", async () => {
      const account = await userWithoutTerms();
      const { access } = await signedIn(account.user.email);

      const response = await acceptTerms(access, "2025-01-01");

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "terms_version_not_current" } });
      expect(await termsOf(account.user.id)).toEqual({ accepted_terms_version: null, terms_accepted_at: null });
      expect(await termsAudits(account.user.id)).toHaveLength(0);
      expect((await me(access)).json()).toMatchObject({ termsAcceptanceRequired: true });
    });

    it("refuses a user who accepted an older version from re-recording it", async () => {
      const account = await createUserWithOrganization(ownerDb, {
        user: {
          email: `old-terms-${Math.random().toString(36).slice(2)}@example.com`,
          password_hash: passwordHash,
          accepted_terms_version: "2025-01-01",
          terms_accepted_at: new Date("2025-01-02T00:00:00Z"),
        },
      });
      const { access } = await signedIn(account.user.email);

      const response = await acceptTerms(access, "2025-01-01");

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "terms_version_not_current" } });
      expect(await termsAudits(account.user.id)).toHaveLength(0);
    });

    it("is 401 unauthenticated without a session, and records nothing", async () => {
      const response = await acceptTerms(undefined, TEST_TERMS_VERSION);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
      expect(await ownerDb.selectFrom("audit_events").select("id").where("action", "=", "user.terms_accepted").execute()).toEqual([]);
    });

    it("is 403 csrf_header_missing without the CSRF header, and records nothing", async () => {
      const account = await userWithoutTerms();
      const { access } = await signedIn(account.user.email);

      const response = await acceptTerms(access, TEST_TERMS_VERSION, {});

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
      expect(await termsOf(account.user.id)).toEqual({ accepted_terms_version: null, terms_accepted_at: null });
      expect(await termsAudits(account.user.id)).toHaveLength(0);
    });

    it("rejects a body that fails the contract", async () => {
      const account = await userWithoutTerms();
      const { access } = await signedIn(account.user.email);

      const response = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/me/terms-acceptance",
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload: { version: TEST_TERMS_VERSION, extra: true },
      });

      expect(response.statusCode).toBe(400);
      expect(await termsAudits(account.user.id)).toHaveLength(0);
    });
  });

  describe("where a new sign-in lands", () => {
    /** Signs in; the cookies and the organization /me names (the session's). */
    const landing = async (email: string) => {
      const cookies = await signedIn(email);
      const response = await me(cookies.access);
      expect(response.statusCode).toBe(200);
      return { cookies, organizationId: response.json<{ organization: { id: string } }>().organization.id };
    };

    const sessionRows = (userId: string) =>
      ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", userId).orderBy("created_at").orderBy("id").execute();

    it("with no earlier session, lands in the organization joined most recently, audited there; with only the personal one, there", async () => {
      const account = await verifiedUser();
      const first = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });
      const newest = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });
      const alone = await verifiedUser();

      expect((await landing(account.user.email)).organizationId).toBe(newest.organization.id);
      expect((await landing(alone.user.email)).organizationId).toBe(alone.organization.id);

      const audits = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "organization_id"])
        .where("action", "=", "user.signed_in")
        .execute();
      expect(audits).toEqual(
        expect.arrayContaining([
          { actor_user_id: account.user.id, organization_id: newest.organization.id },
          { actor_user_id: alone.user.id, organization_id: alone.organization.id },
        ]),
      );
      expect(first.organization.id).not.toBe(newest.organization.id);
    });

    it("lands where the earlier (signed-out) session was; once that organization is left, in the newest live membership; once that is deleted, in the personal organization", async () => {
      const account = await verifiedUser();
      const earlier = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });
      const newest = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });

      const first = await landing(account.user.email);
      expect(first.organizationId).toBe(newest.organization.id);
      const switched = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        cookies: { telflo_access: first.cookies.access },
        payload: { organizationId: earlier.organization.id },
      });
      expect(switched.statusCode).toBe(200);
      expect((await logout(cookieValue(switched, "telflo_access"))).statusCode).toBe(204);

      const second = await landing(account.user.email);
      expect(second.organizationId).toBe(earlier.organization.id);
      expect((await logout(second.cookies.access)).statusCode).toBe(204);

      await removeMembership(ownerDb, { userId: account.user.id, organizationId: earlier.organization.id });
      const third = await landing(account.user.email);
      expect(third.organizationId).toBe(newest.organization.id);
      expect((await logout(third.cookies.access)).statusCode).toBe(204);

      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", newest.organization.id).execute();
      expect((await landing(account.user.email)).organizationId).toBe(account.organization.id);
    });

    it("takes the most recently used earlier session, live or revoked: the one refreshed last, not the one made last", async () => {
      const account = await verifiedUser();
      const refreshedIn = await addMembership(ownerDb, { userId: account.user.id });
      const madeLastIn = await addMembership(ownerDb, { userId: account.user.id });
      const [first, second] = [await signedIn(account.user.email), await signedIn(account.user.email)];
      const [firstRow, secondRow] = await sessionRows(account.user.id);
      await ownerDb.updateTable("sessions").set({ active_organization_id: refreshedIn.organization.id }).where("id", "=", firstRow!.id).execute();
      await ownerDb.updateTable("sessions").set({ active_organization_id: madeLastIn.organization.id }).where("id", "=", secondRow!.id).execute();
      // The second browser signs out; the first is still in use, and refreshes later.
      await logout(second.access);
      advanceClockMinutes(5);
      expect((await refresh(first.refresh)).statusCode).toBe(200);

      expect((await landing(account.user.email)).organizationId).toBe(refreshedIn.organization.id);
    });

    it("against a removal that commits while the sign-in waits on the organization, passes it over: the session starts where the person can act", async () => {
      const account = await verifiedUser();
      const group = await addMembership(ownerDb, { userId: account.user.id });

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        // As a removal: the organization first, `for no key update`, then the membership.
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organizations where id = $1 for no key update", [group.organization.id]);
        const signingIn = signIn(account.user.email);
        signingIn.catch(() => undefined);
        await waitForLockWaits(1);
        await locker.query("update organization_members set deleted_at = now() where id = $1", [group.membership.id]);
        await locker.query("commit");
        lockerInTransaction = false;

        const response = await signingIn;
        expect(response.statusCode).toBe(200);
        const landed = await me(cookieValue(response, "telflo_access"));
        expect(landed.statusCode).toBe(200);
        expect(landed.json<{ organization: { id: string } }>().organization.id).toBe(account.organization.id);
        expect((await sessionRows(account.user.id)).map((row) => row.active_organization_id)).toEqual([account.organization.id]);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });

    it("against a removal that starts while the sign-in holds the organization, lands there, and the removal then reassigns the new session", async () => {
      // The sign-in holds the organization `for share` while it waits on the
      // membership, which a separate connection holds. The removal then waits
      // on the organization, and once the sign-in commits finds its session
      // there and reassigns it, as it does any session.
      const account = await verifiedUser();
      const group = await addMembership(ownerDb, { userId: account.user.id });
      const admin = await verifiedUser();
      await addMembership(ownerDb, { userId: admin.user.id, organizationId: group.organization.id });

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organization_members where id = $1 for update", [group.membership.id]);
        const signingIn = signIn(account.user.email);
        signingIn.catch(() => undefined);
        await waitForLockWaits(1);

        const inGroup = { userId: admin.user.id, organizationId: group.organization.id };
        const removal = withDatabaseContext(db, inGroup, async (transaction) => {
          const organizations = createActiveOrganizationRepository(transaction, inGroup);
          expect(await organizations.lockActive()).toBeDefined();
          const members = createMemberRepository(transaction, inGroup);
          await members.lockAccounts(account.user.id);
          expect(await members.remove(account.user.id, new Date())).toBe(true);
          return organizations.reassignSessionsLeavingOrganization(account.user.id);
        });
        removal.catch(() => undefined);
        await waitForLockWaits(2);

        await locker.query("rollback");
        lockerInTransaction = false;

        const response = await signingIn;
        expect(response.statusCode).toBe(200);
        expect(await removal).toBe(1);

        // Started in the group, then moved out by the removal: the token is stale, a refresh mends it.
        expect((await sessionRows(account.user.id)).map((row) => row.active_organization_id)).toEqual([account.organization.id]);
        expect((await me(cookieValue(response, "telflo_access"))).json()).toMatchObject({ error: { code: "access_token_expired" } });
        const refreshed = await refresh(cookieValue(response, "telflo_refresh"));
        expect((await me(cookieValue(refreshed, "telflo_access"))).json()).toMatchObject({
          organization: { id: account.organization.id },
        });
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });
  });

  describe("PUT /api/v1/auth/sessions/current/organization", () => {
    const switchTo = (access: string, organizationId: unknown) =>
      server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload: { organizationId },
      });

    const sessionRowOf = (userId: string) =>
      ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();

    const switchAudits = () =>
      ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "session.organization_switched").execute();

    const verifyAccess = (token: string) =>
      createAccessTokens({
        secret: settings.accessTokenSecret,
        ttlMinutes: settings.accessTokenTtlMinutes,
        now: () => clock,
      }).verify(token);

    /** A signed-in user, in their personal organization, who is also a `role` of a group organization. */
    const signedInWithGroup = async (role: "admin" | "contributor" = "contributor") => {
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization.
      const cookies = await signedIn(account.user.email);
      const group = await addMembership(ownerDb, { userId: account.user.id, role });
      return { account, personal: account.organization, group: group.organization, membership: group.membership, cookies };
    };

    it("switches to a membership: 200, a new access cookie only, the session row and the audit row", async () => {
      const { account, personal, group, cookies } = await signedInWithGroup("contributor");

      const response = await switchTo(cookies.access, group.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
      });
      const set = setCookies(response);
      expect([...set.keys()]).toEqual(["telflo_access"]);
      expect(set.get("telflo_access")?.attributes).toEqual([
        `Max-Age=${settings.refreshTokenTtlDays * 24 * 60 * 60}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ]);
      const session = await sessionRowOf(account.user.id);
      expect(await verifyAccess(set.get("telflo_access")!.value)).toEqual({
        status: "valid",
        claims: { userId: account.user.id, sessionId: session.id, organizationId: group.id },
      });
      expect(session.active_organization_id).toBe(group.id);

      const audits = await switchAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_user_id: account.user.id,
        actor_email: account.user.email,
        organization_id: group.id,
        subject_type: "session",
        subject_id: session.id,
        metadata: { fromOrganizationId: personal.id },
      });

      const after = await me(set.get("telflo_access")!.value);
      expect(after.json()).toMatchObject({
        organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
      });
    });

    it("answers a switch to the organization already active with 200, and changes, sets and audits nothing", async () => {
      const { account, personal, cookies } = await signedInWithGroup();

      const response = await switchTo(cookies.access, personal.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        organization: { id: personal.id, name: personal.name, type: "personal", logoId: null, role: "admin" },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await sessionRowOf(account.user.id)).active_organization_id).toBe(personal.id);
      expect(await switchAudits()).toEqual([]);
    });

    it("answers the active organization's id in capitals as the no-op: no cookie, no change, no audit", async () => {
      const { account, personal, cookies } = await signedInWithGroup();

      const response = await switchTo(cookies.access, personal.id.toUpperCase());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        organization: { id: personal.id, name: personal.name, type: "personal", logoId: null, role: "admin" },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await sessionRowOf(account.user.id)).active_organization_id).toBe(personal.id);
      expect(await switchAudits()).toEqual([]);
      expect((await me(cookies.access)).statusCode).toBe(200);
    });

    it("switches to a membership named in capitals with the id lowercased in the token and the audit row", async () => {
      const { account, group, cookies } = await signedInWithGroup();

      const response = await switchTo(cookies.access, group.id.toUpperCase());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ organization: { id: group.id } });
      const session = await sessionRowOf(account.user.id);
      expect(await verifyAccess(setCookies(response).get("telflo_access")!.value)).toEqual({
        status: "valid",
        claims: { userId: account.user.id, sessionId: session.id, organizationId: group.id },
      });
      expect(session.active_organization_id).toBe(group.id);
      const audits = await switchAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ organization_id: group.id, metadata: { fromOrganizationId: account.organization.id } });
    });

    it.each([
      ["an organization the user isn't a member of", async () => (await verifiedUser()).organization.id],
      ["an unknown organization", async () => "0190a5b0-0000-7000-8000-00000000abcd"],
      [
        "a deleted organization the user belonged to",
        async (userId: string) => {
          const { organization } = await addMembership(ownerDb, { userId });
          await ownerDb
            .updateTable("organizations")
            .set({ deleted_at: new Date() })
            .where("id", "=", organization.id)
            .execute();
          return organization.id;
        },
      ],
      [
        "an organization whose membership was removed",
        async (userId: string) => {
          const { organization } = await addMembership(ownerDb, { userId });
          await removeMembership(ownerDb, { userId, organizationId: organization.id });
          return organization.id;
        },
      ],
    ])("refuses %s with 403 organization_access_denied, and changes nothing", async (_label, target) => {
      const { account, personal, cookies } = await signedInWithGroup();
      const organizationId = await target(account.user.id);

      const response = await switchTo(cookies.access, organizationId);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: "organization_access_denied", message: "You are not an active member of this organization" },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await sessionRowOf(account.user.id)).active_organization_id).toBe(personal.id);
      expect(await switchAudits()).toEqual([]);
      expect((await me(cookies.access)).statusCode).toBe(200);
    });

    it("refuses a body without an organization id with 400", async () => {
      const { cookies } = await signedInWithGroup();
      expect((await switchTo(cookies.access, "not-a-uuid")).statusCode).toBe(400);
    });

    it("is 401 unauthenticated without a session", async () => {
      const { group } = await signedInWithGroup();
      const response = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        payload: { organizationId: group.id },
      });
      expect(response.statusCode).toBe(401);
    });

    it("then answers the old access token with access_token_expired", async () => {
      const { group, cookies } = await signedInWithGroup();
      expect((await switchTo(cookies.access, group.id)).statusCode).toBe(200);

      const response = await me(cookies.access);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "access_token_expired" } });
    });

    it("keeps a refresh after the switch in the new organization: the session row is authoritative", async () => {
      const { group, cookies } = await signedInWithGroup("contributor");
      expect((await switchTo(cookies.access, group.id)).statusCode).toBe(200);

      const refreshed = await refresh(cookies.refresh);

      expect(refreshed.statusCode).toBe(200);
      const access = cookieValue(refreshed, "telflo_access");
      expect(await verifyAccess(access)).toMatchObject({ claims: { organizationId: group.id } });
      expect((await me(access)).json()).toMatchObject({ organization: { id: group.id, role: "contributor" } });
    });

    it("against a concurrent removal, with the membership row locked, ends reassigned out of the organization", async () => {
      // The switch holds the organization `for share` while it waits on the
      // membership, which a separate connection holds. A removal started
      // meanwhile locks the organization `for no key update`, so it waits for
      // the switch, then finds the session in the organization and reassigns
      // it.
      const { account, personal, group, membership, cookies } = await signedInWithGroup();
      const admin = await verifiedUser();
      await addMembership(ownerDb, { userId: admin.user.id, organizationId: group.id });

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organization_members where id = $1 for update", [membership.id]);

        const switching = switchTo(cookies.access, group.id);
        switching.catch(() => undefined);
        await waitForLockWaits(1);

        // A member's removal, as its service runs it: the organization's lock
        // first, then the member's account, the membership, and the sessions.
        const inGroup = { userId: admin.user.id, organizationId: group.id };
        const removal = withDatabaseContext(db, inGroup, async (transaction) => {
          const organizations = createActiveOrganizationRepository(transaction, inGroup);
          expect(await organizations.lockActive()).toBeDefined();
          const members = createMemberRepository(transaction, inGroup);
          await members.lockAccounts(account.user.id);
          expect(await members.remove(account.user.id, new Date())).toBe(true);
          return organizations.reassignSessionsLeavingOrganization(account.user.id);
        });
        removal.catch(() => undefined);
        await waitForLockWaits(2);

        await locker.query("rollback");
        lockerInTransaction = false;

        const switched = await switching;
        expect(switched.statusCode).toBe(200);
        expect(await removal).toBe(1);

        expect((await sessionRowOf(account.user.id)).active_organization_id).toBe(personal.id);
        const staleAccess = cookieValue(switched, "telflo_access");
        expect((await me(staleAccess)).json()).toMatchObject({ error: { code: "access_token_expired" } });
        const refreshed = await refresh(cookies.refresh);
        expect((await me(cookieValue(refreshed, "telflo_access"))).json()).toMatchObject({
          organization: { id: personal.id },
        });
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });

    it("a switch to the organization already active, against a concurrent delete of it, doesn't deadlock", async () => {
      // A separate connection holds the organization `for no key update`, as
      // a delete does before it reassigns the sessions active in it. Were
      // the no-op to lock the session and then wait on the organization, the
      // holder asking for the session would close the cycle. The no-op takes
      // no lock at all, so it finishes while the holder still holds the
      // organization.
      const { account, group, cookies } = await signedInWithGroup("admin");
      const access = cookieValue(await switchTo(cookies.access, group.id), "telflo_access");
      const session = await sessionRowOf(account.user.id);

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organizations where id = $1 for no key update", [group.id]);

        let isSettled = false;
        const switching = switchTo(access, group.id).finally(() => {
          isSettled = true;
        });
        switching.catch(() => undefined);
        // Either the switch finishes, or it blocks on the organization.
        const deadline = Date.now() + 5_000;
        for (;;) {
          if (isSettled) break;
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
          `.execute(ownerDb);
          if ((rows[0]?.waiting ?? 0) >= 1) break;
          if (Date.now() > deadline) throw new Error("the switch neither finished nor waited on a lock");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // The delete's next step: the sessions active in the organization.
        await locker.query("select id from sessions where id = $1 for update", [session.id]);

        const response = await switching;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "admin" },
        });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await switchAudits()).toHaveLength(1);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });

    it("against a concurrent delete of the target, waits for it and is refused", async () => {
      // The delete holds the organization `for no key update` while it waits
      // on a session a separate connection holds. The switch then waits on
      // the organization, and once the delete commits finds it gone.
      const { account: admin, cookies: adminCookies, group } = await signedInWithGroup("admin");
      const adminSwitched = await switchTo(adminCookies.access, group.id);
      expect(adminSwitched.statusCode).toBe(200);
      const adminAccess = cookieValue(adminSwitched, "telflo_access");
      const member = await verifiedUser();
      // Signed in before joining: the member's session starts in their personal organization.
      const memberCookies = await signedIn(member.user.email);
      await addMembership(ownerDb, { userId: member.user.id, organizationId: group.id, role: "contributor" });
      const adminSession = await sessionRowOf(admin.user.id);

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from sessions where id = $1 for update", [adminSession.id]);

        const deleting = server.inject({
          method: "DELETE",
          url: `/api/v1/organizations/${group.id}`,
          headers: csrfHeaders,
          cookies: { telflo_access: adminAccess },
        });
        deleting.catch(() => undefined);
        await waitForLockWaits(1);

        const switching = switchTo(memberCookies.access, group.id);
        switching.catch(() => undefined);
        await waitForLockWaits(2);

        await locker.query("rollback");
        lockerInTransaction = false;

        expect((await deleting).statusCode).toBe(204);
        const switched = await switching;
        expect(switched.statusCode).toBe(403);
        expect(switched.json()).toMatchObject({ error: { code: "organization_access_denied" } });
        expect((await sessionRowOf(member.user.id)).active_organization_id).toBe(member.organization.id);
        expect((await sessionRowOf(admin.user.id)).active_organization_id).toBe(admin.organization.id);
        expect(await switchAudits()).toHaveLength(1);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });
  });

  describe("CSRF", () => {
    const stateChangingRoutes: { method: Method; url: string }[] = [
      { method: "POST", url: "/api/v1/auth/register" },
      { method: "POST", url: "/api/v1/auth/verify-email" },
      { method: "POST", url: "/api/v1/auth/sessions" },
      { method: "POST", url: "/api/v1/auth/refresh" },
      { method: "DELETE", url: "/api/v1/auth/sessions/current" },
      { method: "DELETE", url: "/api/v1/auth/sessions" },
      { method: "PUT", url: "/api/v1/auth/me/terms-acceptance" },
    ];

    it.each(stateChangingRoutes)("refuses $method $url without the header", async ({ method, url }) => {
      const account = await verifiedUser();
      const { access, refresh: refreshToken } = await signedIn(account.user.email);

      const response = await server.inject({
        method,
        url,
        cookies: { telflo_access: access, telflo_refresh: refreshToken },
        payload: { email: account.user.email, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: "csrf_header_missing", message: "This request is missing a required header." },
      });
      // Refused before the handler: the session is untouched.
      expect((await me(access)).statusCode).toBe(200);
    });

    it.each(stateChangingRoutes)("refuses $method $url with a wrong header value", async ({ method, url }) => {
      const response = await server.inject({ method, url, headers: { [CSRF_HEADER_NAME]: "true" } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
    });

    it("does not require the header on GET /api/v1/auth/me", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      expect((await me(access)).statusCode).toBe(200);
    });

    it("does not require the header on /health", async () => {
      const response = await server.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    });
  });
});
