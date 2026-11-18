import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { addMembership, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";

/*
 * D29 Task 1: every product-admin route and "Contact us"'s are registered
 * (decision 28; Preflight ruling 8), behind their gates: signed out 401;
 * a member who isn't a product admin 403 `product_admin_required` on every
 * `/api/v1/product-admin/` route, whatever its handler does, and `POST
 * /api/v1/feedback` 403 `terms_acceptance_required` for a member without
 * the current terms; every product-admin answer `cache-control: no-store`.
 * The request log keeps no route's query (decision 41, Preflight ruling 9):
 * a search marker sent as `q` to each route, a product admin's and a
 * member's, reaches no log line (a boolean). The handlers' own answers are
 * Tasks 2 to 4's suites'.
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
/** A search term no log line may hold: made up, an @example.com address's shape. */
const SEARCH_MARKER = "search-marker-7c41@example.com";
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";

/** Every product-admin route: [method, path, body]. */
const PRODUCT_ADMIN_ROUTES: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["GET", "/api/v1/product-admin/users", undefined],
  ["DELETE", `/api/v1/product-admin/users/${ID}`, undefined],
  ["GET", "/api/v1/product-admin/product-admins", undefined],
  ["POST", "/api/v1/product-admin/product-admins", { email: "nobody@example.com" }],
  ["DELETE", `/api/v1/product-admin/product-admins/${ID}`, undefined],
  ["GET", "/api/v1/product-admin/feedback", undefined],
  ["GET", "/api/v1/product-admin/feedback/pending-count", undefined],
  ["POST", `/api/v1/product-admin/feedback/${ID}/acknowledge`, { reply: "Thanks." }],
  ["POST", `/api/v1/product-admin/feedback/${ID}/dismiss`, undefined],
];

describe("the product-admin routes' registration and gates", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  let logLines: string[] = [];

  beforeAll(async () => {
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    logLines = [];
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** A signed-in person in a group organization; a product admin when asked. */
  const signedIn = async (options: { isProductAdmin?: boolean; hasAcceptedTerms?: boolean } = {}) => {
    const account = await createUserWithOrganization(databases.ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash, is_product_admin: options.isProductAdmin ?? false },
    });
    await addMembership(databases.ownerDb, { userId: account.user.id, role: "contributor" });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    if (options.hasAcceptedTerms === false) {
      await databases.ownerDb.updateTable("users").set({ accepted_terms_version: "2025-01-01" }).where("id", "=", account.user.id).execute();
    }
    return cookieValue(response, "telflo_access");
  };

  const send = (method: string, url: string, body: Record<string, unknown> | undefined, access?: string) =>
    server.inject({
      method: method as "GET",
      url,
      headers: method === "GET" ? {} : csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      ...(body === undefined ? {} : { payload: body }),
    });

  it("answers every product-admin route 401 signed out and 403 product_admin_required to a member, both no-store", async () => {
    const member = await signedIn();
    for (const [method, url, body] of PRODUCT_ADMIN_ROUTES) {
      const signedOut = await send(method, url, body);
      expect({ method, url, status: signedOut.statusCode, code: signedOut.json().error.code }).toEqual({
        method,
        url,
        status: 401,
        code: "unauthenticated",
      });
      const refused = await send(method, url, body, member);
      expect({ method, url, status: refused.statusCode, code: refused.json().error.code, cache: refused.headers["cache-control"] }).toEqual({
        method,
        url,
        status: 403,
        code: "product_admin_required",
        cache: "no-store",
      });
    }
  });

  it("lets a product admin through to every route's handler (registered: never the router's 404), no-store, terms or none", async () => {
    const admin = await signedIn({ isProductAdmin: true, hasAcceptedTerms: false });
    for (const [method, url, body] of PRODUCT_ADMIN_ROUTES) {
      const response = await send(method, url, body, admin);
      expect({ method, url, routed: response.statusCode !== 401 && response.statusCode !== 403 && !(response.statusCode === 404 && response.json().error.code === "not_found"), cache: response.headers["cache-control"] }).toEqual({
        method,
        url,
        routed: true,
        cache: "no-store",
      });
    }
  });

  it("registers POST /api/v1/feedback for a signed-in person with the current terms: 401 signed out, 403 terms_acceptance_required without them", async () => {
    const body = { text: "A test's feedback." };
    expect((await send("POST", "/api/v1/feedback", body)).statusCode).toBe(401);
    const withoutTerms = await signedIn({ hasAcceptedTerms: false });
    const refused = await send("POST", "/api/v1/feedback", body, withoutTerms);
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 403, code: "terms_acceptance_required" });
    const member = await signedIn();
    const reached = await send("POST", "/api/v1/feedback", body, member);
    expect([401, 403, 404].includes(reached.statusCode)).toBe(false);
  });

  it("keeps no product-admin route's query in the request log: a search term sent as q, by a product admin and a member, in no log line", async () => {
    const admin = await signedIn({ isProductAdmin: true });
    const member = await signedIn();
    logLines = [];
    const q = `?q=${encodeURIComponent(SEARCH_MARKER)}&cursor=${encodeURIComponent(SEARCH_MARKER)}`;
    for (const [method, url, body] of PRODUCT_ADMIN_ROUTES) {
      for (const access of [admin, member, undefined]) await send(method, `${url}${q}`, body, access);
    }
    // Spellings that match no route: the path's own rule.
    for (const url of ["/api/v1/product-admin/users/", "/api/v1//product-admin/users", "/api/v1/%70roduct-admin/users"]) {
      await send("GET", `${url}${q}`, undefined, admin);
    }
    const requestLines = logLines.filter((line) => line.includes("/product-admin"));
    expect(requestLines.length).toBeGreaterThanOrEqual(PRODUCT_ADMIN_ROUTES.length * 3);
    const encoded = encodeURIComponent(SEARCH_MARKER);
    expect(logLines.some((line) => line.includes(SEARCH_MARKER) || line.includes(encoded) || line.includes("search-marker-7c41"))).toBe(false);
  });
});
