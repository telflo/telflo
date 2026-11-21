import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { createAuthenticate, requireProductAdmin } from "./authenticate.js";
import { createDatabaseSessionService } from "./routes.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

const PRODUCT_ADMIN_REFUSAL = {
  error: { code: "product_admin_required", message: "Only a product admin can do that." },
};

function accessCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith("telflo_access="));
  if (!line) throw new Error("the response set no access cookie");
  return line.slice("telflo_access=".length, line.indexOf(";"));
}

/**
 * Against Postgres: the product-admin flag is the user row's, read by the
 * session check on every request, and `requireProductAdmin` on test routes
 * registered before `ready()`, since no production route runs it until the
 * flows endpoints do.
 */
describe("the product-admin flag", () => {
  let settings: AppSettings;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, and the operator's SQL. */
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
    // A product administration endpoint, as the flows endpoints' writes are.
    server.get("/test/product-admin", { preHandler: [authenticate, requireProductAdmin] }, async () => ({ ok: true }));
    // A route that forgot `authenticate`.
    server.get("/test/product-admin-only", { preHandler: requireProductAdmin }, async () => ({ ok: true }));
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

  /** A verified user, with the flag as given (the column's default when undefined), signed in. */
  async function signedIn(isProductAdmin?: boolean) {
    const account = await createUserWithOrganization(ownerDb, {
      user: {
        email: `product-admin-${Math.random().toString(36).slice(2)}@example.com`,
        password_hash: passwordHash,
        ...(isProductAdmin === undefined ? {} : { is_product_admin: isProductAdmin }),
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

  /** The operator's SQL from the README, run as the tables' owner. */
  const setFlag = (userId: string, isProductAdmin: boolean) =>
    ownerDb.updateTable("users").set({ is_product_admin: isProductAdmin }).where("id", "=", userId).execute();

  describe("requireProductAdmin", () => {
    it("passes a product admin", async () => {
      const { access } = await signedIn(true);
      const response = await get("/test/product-admin", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });

    it("refuses a user without the flag with 403 product_admin_required, though they administer their organization", async () => {
      const { access } = await signedIn();
      const response = await get("/test/product-admin", access);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(PRODUCT_ADMIN_REFUSAL);
    });

    it("answers a request without a session 401 unauthenticated, before the flag", async () => {
      const response = await get("/test/product-admin");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("fails closed with 401 unauthenticated on a route without authenticate, even for a product admin", async () => {
      const { access } = await signedIn(true);
      const response = await get("/test/product-admin-only", access);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  describe("read live, on every request", () => {
    it("is false on the very next request once the operator clears it, on the same session, with no new token", async () => {
      const account = await signedIn(true);
      expect((await get("/api/v1/auth/me", account.access)).json()).toMatchObject({ isProductAdmin: true });
      expect((await get("/test/product-admin", account.access)).statusCode).toBe(200);
      const sessionsBefore = await ownerDb.selectFrom("sessions").select(["id", "revoked_at"]).execute();

      await setFlag(account.user.id, false);

      const me = await get("/api/v1/auth/me", account.access);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { id: account.user.id }, isProductAdmin: false });
      expect(me.headers["set-cookie"]).toBeUndefined();
      const refused = await get("/test/product-admin", account.access);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual(PRODUCT_ADMIN_REFUSAL);
      expect(refused.headers["set-cookie"]).toBeUndefined();
      // The same session, still live: nothing was revoked or reissued.
      expect(await ownerDb.selectFrom("sessions").select(["id", "revoked_at"]).execute()).toEqual(sessionsBefore);
      expect(sessionsBefore).toEqual([{ id: expect.any(String), revoked_at: null }]);
    });

    it("is true on the very next request once the operator sets it, on the same session", async () => {
      const account = await signedIn(false);
      expect((await get("/test/product-admin", account.access)).statusCode).toBe(403);

      await setFlag(account.user.id, true);

      expect((await get("/api/v1/auth/me", account.access)).json()).toMatchObject({ isProductAdmin: true });
      expect((await get("/test/product-admin", account.access)).statusCode).toBe(200);
    });

    it("is one user's: another product admin's flag doesn't reach them", async () => {
      await signedIn(true);
      const { access } = await signedIn(false);
      expect((await get("/api/v1/auth/me", access)).json()).toMatchObject({ isProductAdmin: false });
      expect((await get("/test/product-admin", access)).statusCode).toBe(403);
    });
  });
});
