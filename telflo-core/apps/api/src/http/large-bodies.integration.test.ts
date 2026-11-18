import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Insertable } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { UsersTable } from "@telflo/db";
import { createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { createInMemoryMailer } from "../mail/in-memory-mailer.js";
import { hashPassword } from "../modules/identity/password.js";
import { buildServer } from "../server.js";
import { loadSettings } from "../settings.js";
import { TEST_RATE_LIMITS } from "./rate-limits.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../testing/file-store.js";
import { UNCALLED_TESTING } from "../testing/otelcol-testing.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const MiB = 1024 * 1024;

/** The answers, exactly (the envelope's words). */
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "You need to sign in." } };
const CSRF_MISSING = { error: { code: "csrf_header_missing", message: "This request is missing a required header." } };
const TOO_LARGE = { error: { code: "payload_too_large", message: "The request body is too large." } };
const TERMS_REQUIRED = {
  error: { code: "terms_acceptance_required", message: "Accept the current Terms of Service to continue." },
};
const PRODUCT_ADMIN_REQUIRED = { error: { code: "product_admin_required", message: "Only a product admin can do that." } };

/** Who the role check stays for: the current Terms (a data route), or the product-admin flag (the flows' writes). */
type Gate = "terms" | "productAdmin";

interface LargeBodyRoute {
  name: string;
  method: "POST" | "PATCH";
  /** The path, for the signed-in person's organization (ids the route never reaches: every case is refused first). */
  path: (organizationId: string) => string;
  /** The route's own bodyLimit (decision 42's routes). */
  limit: number;
  /** A body the route's schema accepts, so the role check (after validation) is what answers. */
  valid: () => Record<string, unknown>;
  gate: Gate;
}

const configuration = randomUUID();
const version = randomUUID();
const flow = randomUUID();

/**
 * D36-1 decision 42's routes (Preflight ruling 9): the configurations
 * create, a version's save and create, a version's validation, the flows'
 * product-admin writes with a body (create, change, lint) and the test-runs
 * queue. Each runs `authenticate` in `onRequest`, before Fastify reads the
 * body.
 */
const ROUTES: LargeBodyRoute[] = [
  {
    name: "a configuration's create",
    method: "POST",
    path: (organizationId) => `/api/v1/organizations/${organizationId}/configurations`,
    limit: 5 * MiB,
    valid: () => ({ name: "Large bodies" }),
    gate: "terms",
  },
  {
    name: "a version's save",
    method: "PATCH",
    path: (organizationId) => `/api/v1/organizations/${organizationId}/configurations/${configuration}/versions/${version}`,
    limit: 5 * MiB,
    valid: () => ({ yamlContent: "", nodes: [], edges: [], pipelines: [] }),
    gate: "terms",
  },
  {
    name: "a version's create",
    method: "POST",
    path: (organizationId) => `/api/v1/organizations/${organizationId}/configurations/${configuration}/versions`,
    limit: 5 * MiB,
    valid: () => ({ sourceVersionId: version, yamlContent: "", nodes: [], edges: [], pipelines: [] }),
    gate: "terms",
  },
  {
    name: "a version's validation",
    method: "POST",
    path: (organizationId) =>
      `/api/v1/organizations/${organizationId}/configurations/${configuration}/versions/${version}/validation`,
    limit: 2 * MiB,
    valid: () => ({ yaml: "receivers: {}\n" }),
    gate: "terms",
  },
  {
    name: "a test run's queue",
    method: "POST",
    path: (organizationId) =>
      `/api/v1/organizations/${organizationId}/configurations/${configuration}/versions/${version}/test-runs`,
    limit: 2 * MiB,
    valid: () => ({ definitionId: randomUUID(), yaml: "receivers: {}\n", collectorVersion: "0.162.0" }),
    gate: "terms",
  },
  {
    name: "a flow's create",
    method: "POST",
    path: () => "/api/v1/flows",
    limit: 4 * MiB,
    valid: () => ({
      slug: "test-large-bodies",
      name: "Large Bodies",
      summary: "What the flow does.",
      description: "A flow.",
      signals: ["traces"],
      tags: ["test"],
      yaml: "receivers: {}\n",
      collectorDistribution: "otelcol-contrib",
      collectorVersion: "0.162.0",
      sourceUrl: "https://example.com/flows/large-bodies.yaml",
      authorName: "Example Author",
      sortOrder: 1,
    }),
    gate: "productAdmin",
  },
  {
    name: "a flow's change",
    method: "PATCH",
    path: () => `/api/v1/flows/${flow}`,
    limit: 4 * MiB,
    valid: () => ({ name: "Renamed" }),
    gate: "productAdmin",
  },
  {
    name: "a flow's lint",
    method: "POST",
    path: () => "/api/v1/flows/lint",
    limit: 2 * MiB,
    valid: () => ({ yaml: "receivers: {}\n" }),
    gate: "productAdmin",
  },
];

/** A JSON body one byte over `limit`. */
function overLimit(limit: number): string {
  const frame = JSON.stringify({ yaml: "" });
  return JSON.stringify({ yaml: "a".repeat(limit + 1 - Buffer.byteLength(frame)) });
}

function accessCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith("telflo_access="));
  if (!line) throw new Error("the response set no access cookie");
  return line.slice("telflo_access=".length, line.indexOf(";"));
}

describe("large bodies are refused before parsing when unauthenticated (D36-1 decision 42)", () => {
  let databases: TestDatabases;
  let server: FastifyInstance;
  let passwordHash: string;

  beforeAll(async () => {
    databases = openTestDatabases();
    server = buildServer({
      settings: loadSettings(process.env),
      db: databases.db,
      mailer: createInMemoryMailer(),
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
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
  });

  /** A verified person, signed in to their personal organization: the access cookie and that organization's id. */
  async function signedIn(user: Partial<Insertable<UsersTable>> = {}) {
    const account = await createUserWithOrganization(databases.ownerDb, {
      user: { email: `large-bodies-${randomUUID()}@example.com`, password_hash: passwordHash, ...user },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { access: accessCookie(response), organizationId: account.organization.id };
  }

  const send = (
    route: LargeBodyRoute,
    organizationId: string,
    payload: string,
    options: { access?: string; csrf?: boolean } = {},
  ) =>
    server.inject({
      method: route.method,
      url: route.path(organizationId),
      headers: { ...(options.csrf === false ? {} : csrfHeaders), "content-type": "application/json" },
      ...(options.access === undefined ? {} : { cookies: { telflo_access: options.access } }),
      payload,
    });

  describe.each(ROUTES)("$method $name", (route) => {
    it("unauthenticated, a body over the route's limit: 401 unauthenticated, not 413", async () => {
      const body = overLimit(route.limit);
      expect(Buffer.byteLength(body)).toBe(route.limit + 1);
      const response = await send(route, randomUUID(), body);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(UNAUTHENTICATED);
    });

    it("unauthenticated, an invalid body: 401 unauthenticated, not 400", async () => {
      const response = await send(route, randomUUID(), "{");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(UNAUTHENTICATED);
    });

    it("no CSRF header, a body over the limit: 403 csrf_header_missing (the server-wide guard still runs first)", async () => {
      const response = await send(route, randomUUID(), overLimit(route.limit), { csrf: false });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(CSRF_MISSING);
    });

    it("signed in, a body over the limit: 413 payload_too_large", async () => {
      const { access, organizationId } = await signedIn(route.gate === "productAdmin" ? { is_product_admin: true } : {});
      const response = await send(route, organizationId, overLimit(route.limit), { access });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual(TOO_LARGE);
    });

    if (route.gate === "terms") {
      it("signed in without the current Terms, a valid body: 403 terms_acceptance_required (the check stays in preHandler)", async () => {
        const { access, organizationId } = await signedIn({ accepted_terms_version: null, terms_accepted_at: null });
        const response = await send(route, organizationId, JSON.stringify(route.valid()), { access });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(TERMS_REQUIRED);
      });
    } else {
      it("signed in without the product-admin flag, a valid body: 403 product_admin_required (the check stays in preHandler)", async () => {
        const { access, organizationId } = await signedIn();
        const response = await send(route, organizationId, JSON.stringify(route.valid()), { access });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(PRODUCT_ADMIN_REQUIRED);
      });
    }
  });
});
