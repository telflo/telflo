import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addMembership, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createApiTokenFailureLimiter, TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import { createApiTokenStore, createAuthenticateApiToken, requireApiTokenAuthentication } from "./authenticate-api-token.js";

/*
 * The token check end to end (D22 decisions 31, 34 and 37; Ruling 101):
 * `createAuthenticateApiToken` over the real `createApiTokenStore`, on a
 * route this file registers on the real server (never in production code)
 * that answers the token's context and reads nothing else. Unlike
 * /whoami, which reads the token's name afterwards and so would refuse a
 * revoked token even past a stale check, this route shows the check alone:
 * a revoke, or the account's delete, through the API's own routes takes
 * effect on the very next request. And a token is never a session: the
 * /api/v1/ surface refuses it.
 *
 * Every token is built at run time by the API's create and never printed
 * (decision 48): the canaries (booleans) run before any comparison of a
 * reply that could hold one (Ruling 99).
 */

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
/**
 * This file's own route, registered below on the test's server only: on the
 * root, so outside /api/public/v1, where the root guard refuses any route
 * that isn't the public plugin's (D25 Ruling 163).
 */
const CONTEXT_ROUTE = "/test-only/token-check-context";
const REFUSAL = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

describe("the token check end to end, on a test-only route (D22 Ruling 101)", () => {
  let settings: AppSettings;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
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
    });
    // The production check over the production store, and nothing after it: the context as the check built it.
    server.get(
      CONTEXT_ROUTE,
      {
        preHandler: createAuthenticateApiToken({
          store: createApiTokenStore(db),
          failures: createApiTokenFailureLimiter(TEST_RATE_LIMITS.apiTokenFailuresPerIp),
          now: () => clock,
        }),
      },
      async (request) => ({ ...requireApiTokenAuthentication(request).context }),
    );
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
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return { group, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };

  const accountUrl = (organizationId: string, serviceAccountId: string) =>
    `/api/v1/organizations/${organizationId}/service-accounts/${serviceAccountId}`;

  /** An account of a new group, and a live token on it made through the API's create; the token is never printed. */
  const liveToken = async () => {
    const admin = await adminOfGroup();
    const made = await server.inject({
      method: "POST",
      url: `/api/v1/organizations/${admin.group.id}/service-accounts`,
      headers: csrfHeaders,
      cookies: { telflo_access: admin.access },
      payload: { name: `account-${randomUUID()}` },
    });
    expect(made.statusCode).toBe(201);
    const serviceAccountId = made.json<{ serviceAccount: { id: string } }>().serviceAccount.id;
    const minted = await server.inject({
      method: "POST",
      url: `${accountUrl(admin.group.id, serviceAccountId)}/api-tokens`,
      headers: csrfHeaders,
      cookies: { telflo_access: admin.access },
      payload: { name: `token-${randomUUID()}`, access: "write", expiresInDays: null },
    });
    expect(minted.statusCode).toBe(201);
    const { apiToken, token } = minted.json<{ apiToken: { id: string }; token: string }>();
    return { admin, serviceAccountId, tokenId: apiToken.id, token };
  };

  const asAdmin = (admin: { access: string }, method: "DELETE", url: string) =>
    server.inject({ method, url, headers: csrfHeaders, cookies: { telflo_access: admin.access } });

  const withToken = (token: string, url = CONTEXT_ROUTE) =>
    server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** Whether the reply is the one refusal, byte for byte, with WWW-Authenticate: Bearer. */
  const isTheRefusal = (response: LightMyRequestResponse) =>
    response.statusCode === 401 && response.body === REFUSAL && response.headers["www-authenticate"] === "Bearer";

  /** The reply's context, once the canary shows it holds no token. */
  const acceptedContext = (response: LightMyRequestResponse, token: string) => {
    expect(holdsToken(response.body, token)).toBe(false);
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  };

  it("a token used, then revoked through the tokens route, is refused on the very next request", async () => {
    const { admin, serviceAccountId, tokenId, token } = await liveToken();
    const expected = {
      userId: serviceAccountId,
      organizationId: admin.group.id,
      role: "contributor",
      kind: "service_account",
      tokenId,
      access: "write",
    };
    expect(acceptedContext(await withToken(token), token)).toEqual(expected);
    expect(acceptedContext(await withToken(token), token)).toEqual(expected);

    const revoked = await asAdmin(admin, "DELETE", `${accountUrl(admin.group.id, serviceAccountId)}/api-tokens/${tokenId}`);
    expect(revoked.statusCode).toBe(204);

    expect(isTheRefusal(await withToken(token))).toBe(true);
  });

  it("a token used, then its account deleted through the service-accounts route, is refused on the very next request", async () => {
    const { admin, serviceAccountId, tokenId, token } = await liveToken();
    expect(acceptedContext(await withToken(token), token)).toMatchObject({ userId: serviceAccountId, tokenId });

    const deleted = await asAdmin(admin, "DELETE", accountUrl(admin.group.id, serviceAccountId));
    expect(deleted.statusCode).toBe(204);

    expect(isTheRefusal(await withToken(token))).toBe(true);
  });

  it("a valid tf_ Bearer is not a session: /api/v1/auth/me answers the session's 401 with no cookie, and no session is made", async () => {
    const { serviceAccountId, token } = await liveToken();
    // Valid: the check accepts it.
    expect(acceptedContext(await withToken(token), token)).toMatchObject({ userId: serviceAccountId });
    const sessionsBefore = await ownerDb.selectFrom("sessions").select("id").orderBy("id").execute();

    const me = await withToken(token, "/api/v1/auth/me");

    expect(holdsToken(me.body, token)).toBe(false);
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: { code: "unauthenticated", message: "You need to sign in." } });
    expect(me.headers["set-cookie"]).toBeUndefined();
    expect(await ownerDb.selectFrom("sessions").select("id").orderBy("id").execute()).toEqual(sessionsBefore);
    const accountSessions = await ownerDb.selectFrom("sessions").select("id").where("user_id", "=", serviceAccountId).execute();
    expect(accountSessions).toEqual([]);
  });
});
