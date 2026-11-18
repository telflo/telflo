import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addPersonalApiToken,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS, createApiTokenFailureLimiter, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../testing/public-api-openapi.js";
import { hashPassword } from "../identity/password.js";
import { assertAdminRole } from "../organizations/service.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import { apiActorOf } from "./actor.js";
import { createApiTokenOrganizationCheck, createApiTokenStore, createAuthenticateApiToken } from "./authenticate-api-token.js";

/*
 * A person's own `tf_` token on the public surface (D25 decisions 3, 21,
 * 24, 26, 30 and 53; Rulings 160 and 161), through the real server as the
 * API's own role:
 *   - X-Telflo-Org's three answers on a route that needs it: missing or not
 *     a uuid → 400 organization_required; a non-member, a deleted and an
 *     unknown organization → the one 403 organization_access_denied;
 *   - the membership read on every request: a removal through the
 *     organization's own route takes effect on the next request, and so
 *     does a promotion (the person's live role, through a test-only route
 *     that runs the production checks and the organizations' admin check:
 *     no public route is admin-only);
 *   - the person's own drafts visible, another person's not;
 *   - the per-token count spent by a refused organization, the failure
 *     limit not;
 *   - /whoami and /orgs for a person; "Last used" written in the person's
 *     own context.
 * Every public reply is checked against the OpenAPI document.
 *
 * Tokens are built at run time by addPersonalApiToken and never printed:
 * `call` runs its canary (a boolean) on every reply before any comparison.
 */

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const P = "/api/public/v1";
/** On the root, outside /api/public/v1 (where the root guard refuses any route but the plugin's: Ruling 163). */
const ADMIN_PROBE_ROUTE = "/test-only/personal-token-admin";

const ORGANIZATION_REQUIRED = JSON.stringify({
  error: { code: "organization_required", message: "Send the organization's id in X-Telflo-Org." },
});
const ACCESS_DENIED = JSON.stringify({
  error: { code: "organization_access_denied", message: "You are not an active member of this organization" },
});
const VALID_YAML = "receivers:\n  otlp:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

describe("a personal token on the public surface (D25 decisions 21, 24 and 30)", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;

  const serverWith = (rateLimits: RateLimits) =>
    buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits,
    });

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = serverWith(TEST_RATE_LIMITS);
    // The production checks over the production store, then the organizations' own admin check on the token's actor.
    const store = createApiTokenStore(db);
    const organization = createApiTokenOrganizationCheck({ store });
    server.get(
      ADMIN_PROBE_ROUTE,
      {
        preHandler: [
          createAuthenticateApiToken({ store, failures: createApiTokenFailureLimiter(TEST_RATE_LIMITS.apiTokenFailuresPerIp), now: () => new Date() }),
          (request) => organization(request, "required"),
        ],
      },
      async (request) => {
        const actor = apiActorOf(request);
        assertAdminRole(actor);
        return { role: actor.context.role, organizationId: actor.context.organizationId };
      },
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
  });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** A person with a password and their personal organization, and a token of theirs made a minute ago. */
  const person = async (access: "read" | "write" = "read") => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { personalApiToken, token } = await addPersonalApiToken(ownerDb, {
      userId: account.user.id,
      access,
      created_at: new Date(Date.now() - 60_000),
    });
    return { user: account.user, personalOrganization: account.organization, tokenId: personalApiToken.id, tokenName: personalApiToken.name, token };
  };

  /** A group organization named `name`, with a signed-in admin (their session active in it). */
  const group = async (name = `Group ${randomUUID().slice(0, 8)}`) => {
    const admin = await createUserWithOrganization(ownerDb, {
      user: { email: `admin-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    await ownerDb.updateTable("organizations").set({ name }).where("id", "=", organization.id).execute();
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: admin.user.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: cookieValue(signIn, "telflo_access") },
      payload: { organizationId: organization.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return { id: organization.id, name, adminId: admin.user.id, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };

  type Group = Awaited<ReturnType<typeof group>>;

  const asAdmin = (admin: Group, method: "DELETE" | "PATCH", url: string, payload?: object) =>
    server.inject({ method, url, headers: csrfHeaders, cookies: { telflo_access: admin.access }, ...(payload === undefined ? {} : { payload }) });

  /**
   * GET `route` (as registered) at `url` with the token and, if given,
   * X-Telflo-Org; the canary first, then the reply against the document.
   */
  const call = async (route: string, token: string, organizationId?: string, url = route, target: FastifyInstance = server) => {
    const response = await target.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}`, ...(organizationId === undefined ? {} : { "x-telflo-org": organizationId }) },
    });
    expect(holdsToken(response.body, token)).toBe(false);
    expect(validatePublicReply("GET", route, response.statusCode, response.body === "" ? undefined : response.json()).errors).toEqual([]);
    return response;
  };

  const configurations = (token: string, organizationId?: string, target?: FastifyInstance) =>
    call(`${P}/configurations`, token, organizationId, `${P}/configurations`, target);

  describe("X-Telflo-Org on a route that needs it", () => {
    it("missing or not a uuid: 400 organization_required, never echoing what was sent", async () => {
      const ana = await person();
      for (const header of [undefined, "", "acme", `${ana.personalOrganization.id}0`, "not-a-uuid-0192a6b0"]) {
        const response = await configurations(ana.token, header);
        expect(response.statusCode, JSON.stringify(header)).toBe(400);
        expect(response.body === ORGANIZATION_REQUIRED).toBe(true);
      }
    });

    it("an organization the person isn't in, a deleted one of theirs and an unknown one: the one 403, alike", async () => {
      const ana = await person();
      const elsewhere = await group();
      const gone = await group();
      await addMembership(ownerDb, { userId: ana.user.id, organizationId: gone.id, role: "contributor" });
      expect((await configurations(ana.token, gone.id)).statusCode).toBe(200);
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", gone.id).execute();
      for (const organizationId of [elsewhere.id, gone.id, randomUUID()]) {
        const response = await configurations(ana.token, organizationId);
        expect(response.statusCode).toBe(403);
        expect(response.body === ACCESS_DENIED).toBe(true);
      }
    });

    it("a member's own organization, its id in capitals included: 200", async () => {
      const ana = await person();
      expect((await configurations(ana.token, ana.personalOrganization.id.toUpperCase())).statusCode).toBe(200);
    });
  });

  it("a removal through the organization's own route takes effect on the very next request", async () => {
    const ana = await person();
    const team = await group();
    await addMembership(ownerDb, { userId: ana.user.id, organizationId: team.id, role: "contributor" });
    expect((await configurations(ana.token, team.id)).statusCode).toBe(200);
    expect((await asAdmin(team, "DELETE", `/api/v1/organizations/${team.id}/members/${ana.user.id}`)).statusCode).toBe(204);
    const refused = await configurations(ana.token, team.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.body === ACCESS_DENIED).toBe(true);
    // Their own organization still works: the token isn't revoked.
    expect((await configurations(ana.token, ana.personalOrganization.id)).statusCode).toBe(200);
  });

  it("acts with the person's live role: an admin-only check refuses a contributor, and allows them on the next request once promoted", async () => {
    const ana = await person();
    const team = await group();
    await addMembership(ownerDb, { userId: ana.user.id, organizationId: team.id, role: "contributor" });
    const probe = () =>
      server.inject({ method: "GET", url: ADMIN_PROBE_ROUTE, headers: { authorization: `Bearer ${ana.token}`, "x-telflo-org": team.id } });
    const refused = await probe();
    expect(holdsToken(refused.body, ana.token)).toBe(false);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("organization_admin_required");
    expect((await asAdmin(team, "PATCH", `/api/v1/organizations/${team.id}/members/${ana.user.id}`, { role: "admin" })).statusCode).toBe(204);
    const allowed = await probe();
    expect(holdsToken(allowed.body, ana.token)).toBe(false);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ role: "admin", organizationId: team.id });
  });

  it("the person's own drafts are visible through their token, another person's are not", async () => {
    const ana = await person();
    const ben = await person();
    const team = await group();
    await addMembership(ownerDb, { userId: ana.user.id, organizationId: team.id, role: "contributor" });
    await addMembership(ownerDb, { userId: ben.user.id, organizationId: team.id, role: "contributor" });
    const draftOf = async (userId: string) => {
      const configuration = await addConfiguration(ownerDb, { organizationId: team.id, created_by_user_id: userId });
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: team.id,
        version_number: 1,
        yaml_content: VALID_YAML,
        created_by_user_id: userId,
      });
      return configuration.id;
    };
    const anas = await draftOf(ana.user.id);
    const bens = await draftOf(ben.user.id);

    const listed = await configurations(ana.token, team.id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([anas]);
    const one = (configurationId: string) =>
      call(`${P}/configurations/:configurationId`, ana.token, team.id, `${P}/configurations/${configurationId}`);
    expect((await one(anas)).statusCode).toBe(200);
    expect((await one(bens)).statusCode).toBe(404);
    // Ben sees his, not Ana's.
    expect((await configurations(ben.token, team.id)).json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([bens]);
  });

  it("a refused organization spends the token's per-token minute, and never the address's failure limit (Ruling 160, decision 24)", async () => {
    const limited = serverWith({
      ...TEST_RATE_LIMITS,
      publicApiPerToken: { max: 3, windowMs: 60_000 },
      apiTokenFailuresPerIp: { max: 2, windowMs: 60_000 },
    });
    await limited.ready();
    try {
      const ana = await person();
      const other = await person();
      const elsewhere = await group();
      for (let request = 0; request < 3; request += 1) {
        const response = await configurations(ana.token, request === 0 ? undefined : elsewhere.id, limited);
        expect(response.statusCode).toBe(request === 0 ? 400 : 403);
      }
      // The minute is spent: even the person's own organization is 429 now.
      const spent = await configurations(ana.token, ana.personalOrganization.id, limited);
      expect(spent.statusCode).toBe(429);
      // The address's failure budget (2) is untouched by those refusals: another token passes.
      expect((await configurations(other.token, other.personalOrganization.id, limited)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("Last used is written in the person's own context, at most once a minute", async () => {
    const ana = await person();
    const lastUsed = async () =>
      (await ownerDb.selectFrom("personal_api_tokens").select("last_used_at").where("id", "=", ana.tokenId).executeTakeFirstOrThrow())
        .last_used_at;
    expect(await lastUsed()).toBeNull();
    // Even a request refused for its organization was made with a valid token.
    expect((await configurations(ana.token)).statusCode).toBe(400);
    const first = await lastUsed();
    expect(first).not.toBeNull();
    expect((await configurations(ana.token, ana.personalOrganization.id)).statusCode).toBe(200);
    expect((await lastUsed())?.getTime()).toBe(first?.getTime());
  });

  it("a soft-deleted person's token is the one 401", async () => {
    const ana = await person();
    expect((await configurations(ana.token, ana.personalOrganization.id)).statusCode).toBe(200);
    await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", ana.user.id).execute();
    const refused = await configurations(ana.token, ana.personalOrganization.id);
    expect(refused.statusCode).toBe(401);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("invalid_api_token");
  });

  describe("/whoami and /orgs for a person (decision 30)", () => {
    const whoami = (token: string, organizationId?: string) => call(`${P}/whoami`, token, organizationId);
    const orgs = (token: string, organizationId?: string) => call(`${P}/orgs`, token, organizationId);

    it("/whoami: kind person, the token's name and access, the organization only when X-Telflo-Org is sent and checked", async () => {
      const ana = await person("write");
      const elsewhere = await group();
      const bare = await whoami(ana.token);
      expect(bare.statusCode).toBe(200);
      expect(bare.headers["cache-control"]).toBe("no-store");
      expect(bare.json()).toEqual({ organizationId: null, tokenName: ana.tokenName, access: "write", kind: "person" });
      const named = await whoami(ana.token, ana.personalOrganization.id);
      expect(named.json()).toEqual({ organizationId: ana.personalOrganization.id, tokenName: ana.tokenName, access: "write", kind: "person" });
      expect((await whoami(ana.token, "acme")).body === ORGANIZATION_REQUIRED).toBe(true);
      expect((await whoami(ana.token, elsewhere.id)).body === ACCESS_DENIED).toBe(true);
    });

    it("/orgs: every live membership with the person's role, personal first, then by name; never a deleted organization or a removed membership", async () => {
      const ana = await person();
      const zulu = await group("Zulu team");
      const alpha = await group("Alpha team");
      const gone = await group("Gone team");
      const left = await group("Left team");
      const never = await group("Never theirs");
      await addMembership(ownerDb, { userId: ana.user.id, organizationId: zulu.id, role: "admin" });
      await addMembership(ownerDb, { userId: ana.user.id, organizationId: alpha.id, role: "contributor" });
      await addMembership(ownerDb, { userId: ana.user.id, organizationId: gone.id, role: "contributor" });
      await addMembership(ownerDb, { userId: ana.user.id, organizationId: left.id, role: "contributor" });
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", gone.id).execute();
      expect((await asAdmin(left, "DELETE", `/api/v1/organizations/${left.id}/members/${ana.user.id}`)).statusCode).toBe(204);

      const expected = {
        items: [
          { id: ana.personalOrganization.id, name: ana.personalOrganization.name, type: "personal", role: "admin" },
          { id: alpha.id, name: "Alpha team", type: "group", role: "contributor" },
          { id: zulu.id, name: "Zulu team", type: "group", role: "admin" },
        ],
        nextCursor: null,
      };
      const bare = await orgs(ana.token);
      expect(bare.statusCode).toBe(200);
      expect(bare.headers["cache-control"]).toBe("no-store");
      expect(bare.json()).toEqual(expected);
      // A header that is sent is checked, and the list is the same.
      expect((await orgs(ana.token, alpha.id)).json()).toEqual(expected);
      expect((await orgs(ana.token, never.id)).body === ACCESS_DENIED).toBe(true);
      expect((await orgs(ana.token, "acme")).body === ORGANIZATION_REQUIRED).toBe(true);
    });

    it("a revoked personal token answers /whoami the one 401", async () => {
      const ana = await person();
      await ownerDb.updateTable("personal_api_tokens").set({ revoked_at: new Date() }).where("id", "=", ana.tokenId).execute();
      const refused = await whoami(ana.token);
      expect(refused.statusCode).toBe(401);
    });
  });
});
