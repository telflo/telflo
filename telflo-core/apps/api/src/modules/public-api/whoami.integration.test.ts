import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { withDatabaseContext } from "../../database/context.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { createApiTokenRepository } from "../service-accounts/repositories/api-token-repository.js";
import { apiTokenHash } from "../service-accounts/tokens.js";

/*
 * The token check and GET /api/public/v1/whoami, through the real server,
 * as the API's own role. A token is a secret like a bearer: every token
 * here is built at run time (by the API's create or by addApiToken), and
 * the canaries (booleans with fixed labels) run before any comparison of a
 * reply, a log line or a row that could hold one, so a failure prints none.
 */

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const WHOAMI = "/api/public/v1/whoami";
const REFUSAL = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

describe("the token check and GET /api/public/v1/whoami", () => {
  let settings: AppSettings;
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
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    // Every line at info and above is kept, so a test can show that none holds a token.
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

  /** An admin of a new group organization, signed in and active in it. */
  const adminOfGroup = async () => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });
    const { organization: group } = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: cookieValue(signIn, "telflo_access") },
      payload: { organizationId: group.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return { user: account.user, group, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };

  /** A service account of the admin's group, made through the API. */
  const serviceAccountOf = async (admin: { group: { id: string }; access: string }) => {
    const response = await server.inject({
      method: "POST",
      url: `/api/v1/organizations/${admin.group.id}/service-accounts`,
      headers: csrfHeaders,
      cookies: { telflo_access: admin.access },
      payload: { name: `account-${randomUUID()}` },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ serviceAccount: { id: string } }>().serviceAccount.id;
  };

  /** A token on the account, made through the API's create; the token is never printed. */
  const tokenOf = async (
    admin: { group: { id: string }; access: string },
    serviceAccountId: string,
    body: { name?: string; access?: "read" | "write"; expiresInDays?: number | null } = {},
  ) => {
    const response = await server.inject({
      method: "POST",
      url: `/api/v1/organizations/${admin.group.id}/service-accounts/${serviceAccountId}/api-tokens`,
      headers: csrfHeaders,
      cookies: { telflo_access: admin.access },
      payload: { name: `token-${randomUUID()}`, access: "read", expiresInDays: null, currentPassword: PASSWORD, ...body },
    });
    expect(response.statusCode).toBe(201);
    const { apiToken, token } = response.json<{ apiToken: { id: string; name: string }; token: string }>();
    return { id: apiToken.id, name: apiToken.name, token };
  };

  /** An account and a live token on it, ready for the check. */
  const liveToken = async (body: Parameters<typeof tokenOf>[2] = {}) => {
    const admin = await adminOfGroup();
    const serviceAccountId = await serviceAccountOf(admin);
    return { admin, serviceAccountId, ...(await tokenOf(admin, serviceAccountId, body)) };
  };

  const whoami = (authorization?: string, extra: { cookies?: Record<string, string>; method?: "GET" | "HEAD" } = {}) =>
    server.inject({
      method: extra.method ?? "GET",
      url: WHOAMI,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
      ...(extra.cookies === undefined ? {} : { cookies: extra.cookies }),
    });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** Whether the reply is the one refusal, byte for byte, with WWW-Authenticate: Bearer. */
  const isTheRefusal = (response: LightMyRequestResponse) =>
    response.statusCode === 401 && response.body === REFUSAL && response.headers["www-authenticate"] === "Bearer";

  const lastUsedAt = async (tokenId: string) =>
    (await ownerDb.selectFrom("api_tokens").select("last_used_at").where("id", "=", tokenId).executeTakeFirstOrThrow())
      .last_used_at;

  describe("a live token", () => {
    it("answers the organization, the token's name, its access and service_account for a live token, no-store", async () => {
      for (const access of ["read", "write"] as const) {
        const { admin, name, token } = await liveToken({ access });
        const response = await whoami(`Bearer ${token}`);
        expect(holdsToken(response.body, token)).toBe(false);
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({ organizationId: admin.group.id, tokenName: name, access, kind: "service_account" });
      }
    });

    it("needs no terms and no CSRF header: the account never accepted the terms, and a POST under /api/public/v1/ is not the CSRF guard's", async () => {
      const { serviceAccountId, token } = await liveToken();
      const account = await ownerDb
        .selectFrom("users")
        .select(["accepted_terms_version", "terms_accepted_at"])
        .where("id", "=", serviceAccountId)
        .executeTakeFirstOrThrow();
      expect(account).toEqual({ accepted_terms_version: null, terms_accepted_at: null });
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      const posted = await server.inject({ method: "POST", url: WHOAMI, headers: { authorization: `Bearer ${token}` } });
      expect(holdsToken(posted.body, token)).toBe(false);
      expect(posted.statusCode).toBe(404);
      expect(posted.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("a token keeps working after the admin who created it is removed and after their account is deleted", async () => {
      const { admin, token } = await liveToken();
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: clock })
        .where("user_id", "=", admin.user.id)
        .where("organization_id", "=", admin.group.id)
        .execute();
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      await ownerDb.updateTable("users").set({ deleted_at: clock }).where("id", "=", admin.user.id).execute();
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
    });

    it("a token expires at its expiresAt by the API's clock: one second before is accepted, at it and after refused", async () => {
      const admin = await adminOfGroup();
      const serviceAccountId = await serviceAccountOf(admin);
      const expiresAt = new Date(clock.getTime() + 60 * 60 * 1000);
      const { token } = await addApiToken(ownerDb, {
        organizationId: admin.group.id,
        serviceAccountUserId: serviceAccountId,
        created_at: new Date(clock.getTime() - 60_000),
        expires_at: expiresAt,
      });
      clock = new Date(expiresAt.getTime() - 1000);
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      clock = expiresAt;
      expect(isTheRefusal(await whoami(`Bearer ${token}`))).toBe(true);
      clock = new Date(expiresAt.getTime() + 1000);
      expect(isTheRefusal(await whoami(`Bearer ${token}`))).toBe(true);
    });
  });

  describe("the one refusal", () => {
    it("every refusal answers the same 401 body and WWW-Authenticate: Bearer: no header, another scheme, a malformed token, an unknown token, a revoked one, an expired one, a deleted account's, a removed membership's, a deleted organization's", async () => {
      const refusals: [string, () => Promise<LightMyRequestResponse>][] = [];
      const unknown = `tf_${randomBytes(32).toString("base64url")}`;
      refusals.push(["no header", () => whoami()]);
      {
        const { token } = await liveToken();
        refusals.push(["another scheme", () => whoami(`Basic ${token}`)]);
        refusals.push(["a malformed token", () => whoami(`Bearer ${token.slice(0, -1)}`)]);
      }
      refusals.push(["an unknown token", () => whoami(`Bearer ${unknown}`)]);
      {
        const { admin, serviceAccountId, id, token } = await liveToken();
        const revoked = await server.inject({
          method: "DELETE",
          url: `/api/v1/organizations/${admin.group.id}/service-accounts/${serviceAccountId}/api-tokens/${id}`,
          headers: csrfHeaders,
          cookies: { telflo_access: admin.access },
        });
        expect(revoked.statusCode).toBe(204);
        refusals.push(["a revoked token", () => whoami(`Bearer ${token}`)]);
      }
      {
        const admin = await adminOfGroup();
        const serviceAccountId = await serviceAccountOf(admin);
        const { token } = await addApiToken(ownerDb, {
          organizationId: admin.group.id,
          serviceAccountUserId: serviceAccountId,
          created_at: new Date(clock.getTime() - 2 * 60_000),
          expires_at: new Date(clock.getTime() - 60_000),
        });
        refusals.push(["an expired token", () => whoami(`Bearer ${token}`)]);
      }
      {
        // Written by the owner, its tokens left unrevoked: the lookup's own join refuses it.
        const { serviceAccountId, token } = await liveToken();
        await ownerDb.updateTable("service_accounts").set({ deleted_at: clock }).where("user_id", "=", serviceAccountId).execute();
        await ownerDb.updateTable("users").set({ deleted_at: clock }).where("id", "=", serviceAccountId).execute();
        refusals.push(["a deleted account's token", () => whoami(`Bearer ${token}`)]);
      }
      {
        // Written by the owner, a shape no API path makes: the membership invariant keeps a
        // user's last membership, so the account holds a second one elsewhere first.
        const { admin, serviceAccountId, token } = await liveToken();
        await addMembership(ownerDb, { userId: serviceAccountId, role: "contributor" });
        await ownerDb
          .updateTable("organization_members")
          .set({ deleted_at: clock })
          .where("user_id", "=", serviceAccountId)
          .where("organization_id", "=", admin.group.id)
          .execute();
        refusals.push(["a removed membership's token", () => whoami(`Bearer ${token}`)]);
      }
      {
        // The organization alone deleted, by the owner: the organization's delete would soft-delete
        // the account too, so the account holds a membership elsewhere and stays live.
        const { admin, serviceAccountId, token } = await liveToken();
        await addMembership(ownerDb, { userId: serviceAccountId, role: "contributor" });
        await ownerDb.updateTable("organizations").set({ deleted_at: clock }).where("id", "=", admin.group.id).execute();
        refusals.push(["a deleted organization's token", () => whoami(`Bearer ${token}`)]);
      }

      const answered: [string, boolean][] = [];
      for (const [label, call] of refusals) answered.push([label, isTheRefusal(await call())]);
      expect(answered).toEqual(refusals.map(([label]) => [label, true]));
    });

    it("a user's session cookie is not a token: 401, the cookie path never authenticates the public surface", async () => {
      const admin = await adminOfGroup();
      expect(isTheRefusal(await whoami(undefined, { cookies: { telflo_access: admin.access } }))).toBe(true);
      expect(isTheRefusal(await whoami(`Bearer ${admin.access}`, { cookies: { telflo_access: admin.access } }))).toBe(true);
    });

    it("a HEAD answers the 401 with WWW-Authenticate: Bearer, as the GET does", async () => {
      const response = await whoami(undefined, { method: "HEAD" });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
    });
  });

  describe('"Last used"', () => {
    it("the first check sets last_used_at, a second within the minute doesn't write, one after the minute does", async () => {
      const { id, token } = await liveToken();
      expect(await lastUsedAt(id)).toBeNull();
      const first = clock;
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      expect((await lastUsedAt(id))?.getTime()).toBe(first.getTime());
      clock = new Date(first.getTime() + 59_000);
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      expect((await lastUsedAt(id))?.getTime()).toBe(first.getTime());
      clock = new Date(first.getTime() + 60_000);
      expect((await whoami(`Bearer ${token}`)).statusCode).toBe(200);
      expect((await lastUsedAt(id))?.getTime()).toBe(clock.getTime());
    });

    it("a failed write never refuses the request and logs the token's id only", async () => {
      // A token made after the API's clock: its Last used fails ck_api_tokens_last_used_after_created (23514).
      const admin = await adminOfGroup();
      const serviceAccountId = await serviceAccountOf(admin);
      const { apiToken, token } = await addApiToken(ownerDb, {
        organizationId: admin.group.id,
        serviceAccountUserId: serviceAccountId,
        created_at: new Date(clock.getTime() + 24 * 60 * 60 * 1000),
      });
      logLines = [];
      const response = await whoami(`Bearer ${token}`);
      expect(holdsToken(response.body, token)).toBe(false);
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      expect(response.statusCode).toBe(200);
      expect(await lastUsedAt(apiToken.id)).toBeNull();
      const warnings = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.level === 40);
      expect(warnings).toHaveLength(1);
      const { level: _level, time: _time, pid: _pid, hostname: _hostname, reqId: _reqId, ...fields } = warnings[0]!;
      expect(Object.keys(fields).sort()).toEqual(["code", "msg", "tokenId"]);
      expect(fields).toEqual({ tokenId: apiToken.id, code: "23514", msg: "an API token's last use wasn't recorded" });
    });

    it("concurrent writes of one token's Last used write once", async () => {
      const { admin, serviceAccountId, id } = await liveToken();
      const context = { userId: serviceAccountId, organizationId: admin.group.id };
      const at = new Date(clock.getTime() + 1000);
      const writes = await Promise.all(
        Array.from({ length: 8 }, () =>
          withDatabaseContext(db, context, (transaction) => createApiTokenRepository(transaction, context).touchLastUsed(id, at)),
        ),
      );
      expect(writes.filter(Boolean)).toHaveLength(1);
      expect((await lastUsedAt(id))?.getTime()).toBe(at.getTime());
    });

    it("never stamps a revoked token", async () => {
      const admin = await adminOfGroup();
      const { user } = await addServiceAccount(ownerDb, { organizationId: admin.group.id, createdAt: new Date(clock.getTime() - 120_000) });
      const { apiToken } = await addApiToken(ownerDb, {
        organizationId: admin.group.id,
        serviceAccountUserId: user.id,
        created_at: new Date(clock.getTime() - 60_000),
        revoked_at: new Date(clock.getTime() - 30_000),
        revoked_by_user_id: admin.user.id,
      });
      const context = { userId: user.id, organizationId: admin.group.id };
      const wrote = await withDatabaseContext(db, context, (transaction) =>
        createApiTokenRepository(transaction, context).touchLastUsed(apiToken.id, clock),
      );
      expect(wrote).toBe(false);
      expect(await lastUsedAt(apiToken.id)).toBeNull();
    });
  });

  describe("the token in logs", () => {
    it("no log line of a check, a success or a refusal holds the token, nor the 404's reply for a path holding one", async () => {
      const { admin, serviceAccountId, id, token } = await liveToken();
      logLines = [];
      const replies = [
        await whoami(`Bearer ${token}`),
        await whoami(`Basic ${token}`),
        await whoami(`Bearer ${token}x`),
        await server.inject({ method: "GET", url: `/api/public/v1/${token}` }),
        // With the token as its bearer too: the plugin's 404, after the check, holding neither.
        await server.inject({ method: "GET", url: `/api/public/v1/${token}`, headers: { authorization: `Bearer ${token}` } }),
        await server.inject({ method: "GET", url: `${WHOAMI}?token=${token}`, headers: { authorization: `Bearer ${token}` } }),
      ];
      await server.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${admin.group.id}/service-accounts/${serviceAccountId}/api-tokens/${id}`,
        headers: csrfHeaders,
        cookies: { telflo_access: admin.access },
      });
      replies.push(await whoami(`Bearer ${token}`));
      expect(logLines.length).toBeGreaterThan(0);
      expect(holdsToken(logLines.join("\n"), token)).toBe(false);
      expect(replies.some((reply) => holdsToken(reply.body, token))).toBe(false);
      // A path holding the token, with no Authorization, is the one 401: the plugin's 404 answers after the check.
      expect(replies.map((reply) => reply.statusCode)).toEqual([200, 401, 401, 401, 404, 200, 401]);
    });
  });
});
