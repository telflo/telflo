import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { API_TOKEN_PATTERN, CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addMembership, addPersonalApiToken, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { apiTokenHash } from "../service-accounts/tokens.js";

/*
 * A person's own API tokens on their Account page (D25 decisions 27 to 29;
 * Preflight ruling 14): GET, POST and DELETE /api/v1/auth/me/api-tokens,
 * through the real server as the API's own role. The list (the person's
 * own, by prefix), the create (201 once with the token, no-store; the
 * stored hash; the expiry), the name's uniqueness, the cap of 20 live,
 * the revoke (204; again, another person's, an unknown or a malformed id:
 * the one 404), the audit rows (ids and fixed values only, under the
 * session's active organization), a session and the CSRF header needed,
 * the current terms not, and the token working on the public surface until
 * it is revoked.
 *
 * Tokens are built by the API at run time and never printed: every reply
 * that could hold one is checked with booleans first.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const TOKENS_URL = "/api/v1/auth/me/api-tokens";
const DAY_MS = 24 * 60 * 60 * 1000;

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

interface ListedToken {
  id: string;
  name: string;
  prefix: string;
  access: "read" | "write";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  isExpired: boolean;
}

describe("a person's own API tokens (D25 decision 28)", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  let logLines: string[] = [];

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
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

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** A person with a password, signed in: their personal organization active, unless they switch. */
  const signedIn = async (user: Record<string, unknown> = {}) => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash, ...user },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { ...account, access: cookieValue(response, "telflo_access") };
  };

  type Person = Awaited<ReturnType<typeof signedIn>>;

  const list = (person: Pick<Person, "access">) =>
    server.inject({ method: "GET", url: TOKENS_URL, cookies: { telflo_access: person.access } });

  /** POST, answering the reply and, on 201, the token (checked by shape as a boolean) and the listed row. */
  const create = async (person: Pick<Person, "access">, payload: object, headers: Record<string, string> = csrfHeaders) => {
    const response = await server.inject({ method: "POST", url: TOKENS_URL, headers, cookies: { telflo_access: person.access }, payload });
    if (response.statusCode !== 201) return { response, token: undefined, apiToken: undefined };
    const { token, apiToken } = response.json<{ token: string; apiToken: ListedToken }>();
    expect(API_TOKEN_PATTERN.test(token)).toBe(true);
    return { response, token, apiToken };
  };

  const revoke = (person: Pick<Person, "access">, tokenId: string, headers: Record<string, string> = csrfHeaders) =>
    server.inject({ method: "DELETE", url: `${TOKENS_URL}/${encodeURIComponent(tokenId)}`, headers, cookies: { telflo_access: person.access } });

  const whoami = (token: string) =>
    server.inject({ method: "GET", url: "/api/public/v1/whoami", headers: { authorization: `Bearer ${token}` } });

  const auditsOf = (action: string) =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("id").execute();

  it("creates a token once (201, no-store), lists it by its prefix, stores only its hash, and the token works on the public surface", async () => {
    const ana = await signedIn();
    expect((await list(ana)).json()).toEqual({ items: [] });

    const { response, token, apiToken } = await create(ana, { name: "CI", access: "write", expiresInDays: 30 });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(token !== undefined && apiToken !== undefined).toBe(true);
    const created = apiToken!;
    expect(created.prefix === token!.slice(0, 11)).toBe(true);
    const { prefix: _prefix, ...rest } = created;
    expect(rest).toEqual({
      id: expect.any(String),
      name: "CI",
      access: "write",
      expiresAt: new Date(clock.getTime() + 30 * DAY_MS).toISOString(),
      lastUsedAt: null,
      createdAt: clock.toISOString(),
      isExpired: false,
    });

    const listed = await list(ana);
    // The list holds the prefix (the masked list's text), never the rest of the token or its hash.
    expect(listed.body.includes(token!.slice(3)) || listed.body.includes(apiTokenHash(token!))).toBe(false);
    expect(listed.json<{ items: ListedToken[] }>().items.map((item) => item.id)).toEqual([created.id]);

    const row = await ownerDb.selectFrom("personal_api_tokens").selectAll().where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(row.user_id).toBe(ana.user.id);
    expect(row.token_hash === apiTokenHash(token!)).toBe(true);

    const accepted = await whoami(token!);
    expect(holdsToken(accepted.body, token!)).toBe(false);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ organizationId: null, tokenName: "CI", access: "write", kind: "person" });

    // No log line holds the token, its hash or its prefix, nor its name as a field.
    const logged = logLines.join("\n");
    expect(holdsToken(logged, token!)).toBe(false);
  });

  it("audits the create and the revoke with ids and fixed values only, under the session's active organization", async () => {
    const ana = await signedIn();
    const { organization: team } = await addMembership(ownerDb, { userId: ana.user.id, role: "contributor" });
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: ana.access },
      payload: { organizationId: team.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    const inTeam = { access: (switched.headers["set-cookie"] === undefined ? ana.access : cookieValue(switched, "telflo_access")) };

    const { token, apiToken } = await create(inTeam, { name: "Audited name", access: "read", expiresInDays: null });
    expect((await revoke(inTeam, apiToken!.id)).statusCode).toBe(204);

    const [createdRow] = await auditsOf("personal_api_token.created");
    const [revokedRow] = await auditsOf("personal_api_token.revoked");
    for (const row of [createdRow, revokedRow]) {
      expect(row).toBeDefined();
      expect(holdsToken(JSON.stringify(row), token!)).toBe(false);
      expect(JSON.stringify(row).includes("Audited name")).toBe(false);
      expect(row).toMatchObject({
        actor_user_id: ana.user.id,
        actor_email: ana.user.email,
        organization_id: team.id,
        subject_type: "personal_api_token",
        subject_id: apiToken!.id,
      });
    }
    expect(createdRow!.metadata).toEqual({ access: "read", expiresAt: null });
    expect(revokedRow!.metadata).toEqual({});
  });

  it("a name is unique, case aside, among the person's unrevoked tokens (an expired one's included); revoking frees it; another person's is no matter", async () => {
    const ana = await signedIn();
    const ben = await signedIn();
    const first = await create(ana, { name: "Deploy", access: "read", expiresInDays: 1 });
    expect(first.response.statusCode).toBe(201);
    const taken = await create(ana, { name: "deploy", access: "read", expiresInDays: null });
    expect(taken.response.statusCode).toBe(409);
    expect(taken.response.json()).toEqual({ error: { code: "api_token_name_taken", message: "You already have a token with this name." } });
    // An expired token is still listed, and still holds its name.
    await addPersonalApiToken(ownerDb, {
      userId: ana.user.id,
      name: "Old",
      created_at: new Date(clock.getTime() - 2 * DAY_MS),
      expires_at: new Date(clock.getTime() - DAY_MS),
    });
    const listed = (await list(ana)).json<{ items: ListedToken[] }>().items;
    expect(listed.map((item) => [item.name, item.isExpired])).toEqual([
      ["Deploy", false],
      ["Old", true],
    ]);
    expect((await create(ana, { name: "OLD", access: "read", expiresInDays: null })).response.statusCode).toBe(409);
    expect((await create(ben, { name: "Deploy", access: "read", expiresInDays: null })).response.statusCode).toBe(201);
    expect((await revoke(ana, first.apiToken!.id)).statusCode).toBe(204);
    expect((await create(ana, { name: "deploy", access: "read", expiresInDays: null })).response.statusCode).toBe(201);
  });

  it("holds at most 20 live tokens, as D22 (Q137; Ruling 180): an expired one doesn't count; the 21st live is 409 api_token_limit_reached; a revoke frees a place", async () => {
    const ana = await signedIn();
    const live = [];
    for (let index = 0; index < 19; index += 1) {
      live.push(await addPersonalApiToken(ownerDb, { userId: ana.user.id, created_at: new Date(clock.getTime() - 60_000) }));
    }
    await addPersonalApiToken(ownerDb, {
      userId: ana.user.id,
      created_at: new Date(clock.getTime() - 2 * DAY_MS),
      expires_at: new Date(clock.getTime() - DAY_MS),
    });
    // 19 live and 1 expired: the expired one doesn't count, so the 20th live is made.
    expect((await create(ana, { name: "twentieth", access: "read", expiresInDays: null })).response.statusCode).toBe(201);
    expect((await list(ana)).json<{ items: ListedToken[] }>().items.filter((item) => item.isExpired)).toHaveLength(1);
    // 20 live: the 21st is refused.
    const refused = await create(ana, { name: "one more", access: "read", expiresInDays: null });
    expect(refused.response.statusCode).toBe(409);
    expect(refused.response.json()).toEqual({ error: { code: "api_token_limit_reached", message: "You have 20 tokens. Revoke one first." } });
    // A revoke frees a place.
    expect((await revoke(ana, live[0]!.personalApiToken.id)).statusCode).toBe(204);
    expect((await create(ana, { name: "one more", access: "read", expiresInDays: null })).response.statusCode).toBe(201);
    expect((await create(ana, { name: "and another", access: "read", expiresInDays: null })).response.statusCode).toBe(409);
  });

  it("5 parallel creates over 19 tokens: exactly one passes the count under the user's lock", async () => {
    const ana = await signedIn();
    for (let index = 0; index < 19; index += 1) {
      await addPersonalApiToken(ownerDb, { userId: ana.user.id, created_at: new Date(clock.getTime() - 60_000) });
    }
    const replies = await Promise.all(
      Array.from({ length: 5 }, (_, index) => create(ana, { name: `parallel ${index}`, access: "read", expiresInDays: null })),
    );
    expect(replies.map(({ response }) => response.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    const count = await ownerDb
      .selectFrom("personal_api_tokens")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("user_id", "=", ana.user.id)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(20);
  });

  it("revokes once (204), and the token stops working on the next request; again, another person's, an unknown and a malformed id are the one 404", async () => {
    const ana = await signedIn();
    const ben = await signedIn();
    const { token, apiToken } = await create(ana, { name: "CI", access: "read", expiresInDays: null });
    const bens = await create(ben, { name: "Ben's", access: "read", expiresInDays: null });
    expect((await whoami(token!)).statusCode).toBe(200);

    // Ben can't see or revoke Ana's token.
    expect((await list(ben)).json<{ items: ListedToken[] }>().items.map((item) => item.id)).toEqual([bens.apiToken!.id]);
    const notFound = { error: { code: "api_token_not_found", message: "Token not found" } };
    const crossed = await revoke(ben, apiToken!.id);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toEqual(notFound);
    expect((await whoami(token!)).statusCode).toBe(200);

    expect((await revoke(ana, apiToken!.id)).statusCode).toBe(204);
    const refused = await whoami(token!);
    expect(holdsToken(refused.body, token!)).toBe(false);
    expect(refused.statusCode).toBe(401);
    expect((await list(ana)).json()).toEqual({ items: [] });
    for (const id of [apiToken!.id, "0192a6b0-0000-7000-8000-000000000000", "not-a-uuid", apiToken!.id.toUpperCase()]) {
      const response = await revoke(ana, id);
      expect(response.statusCode, id).toBe(404);
      expect(response.json()).toEqual(notFound);
    }
    // Ben's still works.
    expect((await whoami(bens.token!)).statusCode).toBe(200);
  });

  it("needs a session (401) and the CSRF header on the writes; the current terms aren't needed", async () => {
    const anonymous = await server.inject({ method: "GET", url: TOKENS_URL });
    expect(anonymous.statusCode).toBe(401);
    const ana = await signedIn({ accepted_terms_version: null, terms_accepted_at: null });
    expect((await list(ana)).statusCode).toBe(200);
    const noCsrf = await create(ana, { name: "CI", access: "read", expiresInDays: null }, {});
    expect(noCsrf.response.statusCode).toBe(403);
    const made = await create(ana, { name: "CI", access: "read", expiresInDays: null });
    expect(made.response.statusCode).toBe(201);
    expect((await revoke(ana, made.apiToken!.id, {})).statusCode).toBe(403);
    expect((await ownerDb.selectFrom("personal_api_tokens").select("id").execute()).length).toBe(1);
  });

  it("refuses a request outside D22's rules (400): a name too long, an expiry out of range, an unknown field", async () => {
    const ana = await signedIn();
    for (const payload of [
      { name: "x".repeat(65), access: "read", expiresInDays: null },
      { name: "CI", access: "read", expiresInDays: 0 },
      { name: "CI", access: "read", expiresInDays: 3651 },
      { name: "CI", access: "admin", expiresInDays: null },
      { name: "CI", access: "read", expiresInDays: null, organizationId: "0192a6b0-0000-7000-8000-000000000000" },
    ]) {
      expect((await create(ana, payload)).response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await ownerDb.selectFrom("personal_api_tokens").select("id").execute()).length).toBe(0);
  });
});
