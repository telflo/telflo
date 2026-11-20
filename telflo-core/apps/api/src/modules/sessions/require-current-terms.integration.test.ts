import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { addMembership, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { createAuthenticate, requireCurrentTerms } from "./authenticate.js";
import { createDatabaseSessionService } from "./routes.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

const TERMS_REFUSAL = {
  error: { code: "terms_acceptance_required", message: "Accept the current Terms of Service to continue." },
};

function accessCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith("telflo_access="));
  if (!line) throw new Error("the response set no access cookie");
  return line.slice("telflo_access=".length, line.indexOf(";"));
}

/**
 * Against Postgres: `requireCurrentTerms` on test routes registered before
 * `ready()`, since no production route runs it until the configurations
 * endpoints do. And the endpoints the terms dialog, and organization and
 * member management, need still answer a user who hasn't accepted them.
 */
describe("requireCurrentTerms", () => {
  let settings: AppSettings;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures and truncation. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    const mailer = createInMemoryMailer();
    const now = () => new Date();
    const opampServer = opamp.client;
    const otelcolValidator = UNCALLED_OTELCOL_VALIDATOR;
    const fileStore = UNCALLED_FILE_STORE;
    const testing = UNCALLED_TESTING;
    server = buildServer({ settings, db, mailer, now, rateLimits: TEST_RATE_LIMITS, opampServer, otelcolValidator, fileStore, testing });
    const authenticate = createAuthenticate(
      createDatabaseSessionService({ settings, db, mailer, now, opampServer, otelcolValidator, fileStore, testing }).service,
    );
    // A data endpoint as the configurations endpoints are: `authenticate`, then the terms check.
    server.get("/test/data", { preHandler: [authenticate, requireCurrentTerms] }, async () => ({ ok: true }));
    // A route that forgot `authenticate`.
    server.get("/test/terms-only", { preHandler: requireCurrentTerms }, async () => ({ ok: true }));
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

  /** A verified user who accepted `version` (null: none, as a Google sign-up), signed in; their access cookie. */
  async function signedInWithTerms(version: string | null) {
    const account = await createUserWithOrganization(ownerDb, {
      user: {
        email: `terms-${Math.random().toString(36).slice(2)}@example.com`,
        password_hash: passwordHash,
        accepted_terms_version: version,
        terms_accepted_at: version === null ? null : new Date(),
      },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { ...account, access: accessCookie(response) };
  }

  const get = (url: string, access?: string) =>
    server.inject({ method: "GET", url, ...(access === undefined ? {} : { cookies: { telflo_access: access } }) });

  describe("on a data endpoint", () => {
    it("passes a user who has accepted the current version", async () => {
      const { access } = await signedInWithTerms(TEST_TERMS_VERSION);
      const response = await get("/test/data", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });

    it("refuses a user who accepted an older version with 403 terms_acceptance_required", async () => {
      const { access } = await signedInWithTerms("2025-01-01");
      const response = await get("/test/data", access);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(TERMS_REFUSAL);
    });

    it("refuses a user who has accepted none (a Google sign-up) with 403 terms_acceptance_required", async () => {
      const { access } = await signedInWithTerms(null);
      const response = await get("/test/data", access);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(TERMS_REFUSAL);
    });

    it("answers a request without a session 401 unauthenticated, before the terms", async () => {
      const response = await get("/test/data");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("fails closed with 401 unauthenticated on a route without authenticate, even for a signed-in user", async () => {
      const { access } = await signedInWithTerms(TEST_TERMS_VERSION);
      const response = await get("/test/terms-only", access);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("passes the same session's next request once the terms are accepted, with no new token", async () => {
      const { access } = await signedInWithTerms(null);
      expect((await get("/test/data", access)).statusCode).toBe(403);

      const accepted = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/me/terms-acceptance",
        headers: csrfHeaders,
        payload: { version: TEST_TERMS_VERSION },
        cookies: { telflo_access: access },
      });
      expect(accepted.statusCode).toBe(204);
      expect(accepted.headers["set-cookie"]).toBeUndefined();

      const response = await get("/test/data", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });
  });

  describe("endpoints that stay open to a user with old terms", () => {
    it("/me answers, and says the terms need accepting", async () => {
      const { access } = await signedInWithTerms("2025-01-01");
      const response = await get("/api/v1/auth/me", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ termsAcceptanceRequired: true });
    });

    it("the terms acceptance answers", async () => {
      const { access } = await signedInWithTerms("2025-01-01");
      const response = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/me/terms-acceptance",
        headers: csrfHeaders,
        payload: { version: TEST_TERMS_VERSION },
        cookies: { telflo_access: access },
      });
      expect(response.statusCode).toBe(204);
    });

    it("switching organization answers", async () => {
      const account = await signedInWithTerms("2025-01-01");
      const group = await addMembership(ownerDb, { userId: account.user.id, role: "contributor" });
      const response = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        payload: { organizationId: group.organization.id },
        cookies: { telflo_access: account.access },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ organization: { id: group.organization.id } });
    });

    it("the member list answers", async () => {
      const account = await signedInWithTerms("2025-01-01");
      const response = await get(`/api/v1/organizations/${account.organization.id}/members`, account.access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [{ userId: account.user.id }] });
    });

    it("signing out answers, and ends the session", async () => {
      const { access } = await signedInWithTerms("2025-01-01");
      const response = await server.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions/current",
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });
      expect(response.statusCode).toBe(204);
      expect((await get("/api/v1/auth/me", access)).statusCode).toBe(401);
    });

    it("signing out everywhere answers", async () => {
      const { access } = await signedInWithTerms("2025-01-01");
      const response = await server.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });
      expect(response.statusCode).toBe(204);
    });
  });

  describe("on a site that asks for no Terms", () => {
    let noTerms: FastifyInstance;
    beforeAll(async () => {
      const site = { ...settings.site, terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" } };
      const noTermsSettings = { ...settings, site };
      const mailer = createInMemoryMailer();
      const now = () => new Date();
      const deps = {
        settings: noTermsSettings,
        db,
        mailer,
        now,
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      };
      noTerms = buildServer({ ...deps, rateLimits: TEST_RATE_LIMITS });
      const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
      noTerms.get("/test/data", { preHandler: [authenticate, requireCurrentTerms] }, async () => ({ ok: true }));
      await noTerms.ready();
    });
    afterAll(async () => {
      await noTerms.close();
    });

    /** Signed in on the no-Terms server; the access cookie. */
    const signedInThere = async (version: string | null) => {
      const account = await createUserWithOrganization(ownerDb, {
        user: {
          email: `terms-${Math.random().toString(36).slice(2)}@example.com`,
          password_hash: passwordHash,
          accepted_terms_version: version,
          terms_accepted_at: version === null ? null : new Date(),
        },
      });
      const response = await noTerms.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        payload: { email: account.user.email, password: PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      return { ...account, access: accessCookie(response) };
    };

    it("passes every user on a data endpoint, and /me answers termsAcceptanceRequired false: none accepted, an older version, the version a SaaS asked for", async () => {
      for (const version of [null, "2025-01-01", TEST_TERMS_VERSION]) {
        const { access } = await signedInThere(version);
        const data = await noTerms.inject({ method: "GET", url: "/test/data", cookies: { telflo_access: access } });
        expect({ version, status: data.statusCode }).toEqual({ version, status: 200 });
        const me = await noTerms.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });
        expect({ version, me: me.json<{ termsAcceptanceRequired: boolean }>().termsAcceptanceRequired }).toEqual({ version, me: false });
      }
    });

    it("refuses the terms acceptance with 400 terms_version_not_current: there is no version to accept, and nothing is recorded", async () => {
      const account = await signedInThere(null);
      for (const version of [TEST_TERMS_VERSION, "anything"]) {
        const response = await noTerms.inject({
          method: "PUT",
          url: "/api/v1/auth/me/terms-acceptance",
          headers: csrfHeaders,
          cookies: { telflo_access: account.access },
          payload: { version },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "terms_version_not_current" } });
      }
      const user = await ownerDb.selectFrom("users").select(["accepted_terms_version", "terms_accepted_at"]).where("id", "=", account.user.id).executeTakeFirstOrThrow();
      expect(user).toEqual({ accepted_terms_version: null, terms_accepted_at: null });
      expect(await ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "user.terms_accepted").execute()).toEqual([]);
    });
  });
});
