import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Insertable, Selectable } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { FlowsTable, UsersTable } from "@telflo/db";
import {
  addConfiguration,
  addMembership,
  createUserWithOrganization,
  insertSeededFlows,
  loadSeededFlows,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** The committed catalog's distribution, its default version, another it offers, and one it deprecated. */
const CONTRIB = "otelcol-contrib";
const CONTRIB_DEFAULT = "0.162.0";
const OFFERED = "0.161.0";
const DEPRECATED = "0.147.0";

const NOT_FOUND = { error: { code: "flow_not_found", message: "Flow not found" } };
const SLUG_TAKEN = { error: { code: "flow_slug_taken", message: "Another flow already has that slug." } };
const PRODUCT_ADMIN_REQUIRED = { error: { code: "product_admin_required", message: "Only a product admin can do that." } };
const VERSION_UNKNOWN = { error: { code: "collector_version_unknown", message: "That collector version isn't available." } };
const DISTRIBUTION_UNKNOWN = {
  error: { code: "collector_distribution_unknown", message: "That collector distribution isn't available." },
};

/** Text no audit row or log line may hold: a create's and a change's YAML and description. */
const YAML_MARKER = "yaml-marker-7f3a9c";
const DESCRIPTION_MARKER = "description-marker-91c2e4";
const YAML =
  "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n" +
  `# ${YAML_MARKER}\n` +
  "exporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
const DESCRIPTION = `The ${DESCRIPTION_MARKER} flow.\n\nA second paragraph.`;

/** The card's fields, exactly: the showcase's answer has these and nothing else. */
const CARD_KEYS = ["authorName", "name", "signals", "slug", "summary", "tags", "updatedAt"];

/** A published flow's fields, exactly: a flow in full but its id, published, sortOrder and createdAt. */
const PUBLISHED_KEYS = [
  "authorName",
  "authorUrl",
  "collectorDistribution",
  "collectorVersion",
  "description",
  "name",
  "signals",
  "slug",
  "source",
  "sourceUrl",
  "summary",
  "tags",
  "updatedAt",
  "yaml",
];

/** The 429 every limiter answers. */
const RATE_LIMITED = { error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } };

function accessCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith("telflo_access="));
  if (!line) throw new Error("the response set no access cookie");
  return line.slice("telflo_access=".length, line.indexOf(";"));
}

/** A flow row as a signed-in read answers it. */
function bodyOf(row: Selectable<FlowsTable>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    description: row.description,
    source: row.source,
    authorName: row.author_name,
    authorUrl: row.author_url,
    signals: row.signals,
    tags: row.tags,
    yaml: row.yaml_content,
    collectorDistribution: row.collector_distribution,
    collectorVersion: row.collector_version,
    sourceUrl: row.source_url,
    published: row.published,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A flow row as the open flow read answers it. */
function publishedOf(row: Selectable<FlowsTable>) {
  const { id: _id, published: _published, sortOrder: _sortOrder, createdAt: _createdAt, ...published } = bodyOf(row);
  return published;
}

/** A flow row as the showcase answers it. */
function cardOf(row: Selectable<FlowsTable>) {
  return {
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    signals: row.signals,
    tags: row.tags,
    authorName: row.author_name,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The flows endpoints against Postgres. Every flow here is the test's own,
 * slugged `test-…`, inserted as the tables' owner or created through the API:
 * truncateAll empties the seeded ones before every test, and the one test that
 * needs them puts them back with insertSeededFlows. The catalog is the
 * committed one: Contrib, offering 0.159.0 to 0.162.0, with 0.147.0
 * deprecated.
 */
describe("the flows endpoints", () => {
  let databases: TestDatabases;
  let server: FastifyInstance;
  let passwordHash: string;
  /** Every line the server logged, at trace level, since the test began. */
  let lines: string[] = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const now = () => new Date(clock.getTime());
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return now();
  };
  let counter = 0;

  beforeAll(async () => {
    databases = openTestDatabases();
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = buildServer({
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        now,
        rateLimits: TEST_RATE_LIMITS,
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        logStream: { write: (line) => void lines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    clock = new Date();
    lines = [];
  });

  type Kind = "productAdmin" | "organizationAdmin" | "contributor";

  /**
   * A verified user, signed in: a product admin (an admin of their personal
   * organization too), an organization's admin without the flag (their
   * personal organization's), or a contributor of a group organization
   * without it, active in that group.
   */
  async function signedIn(kind: Kind, user: Partial<Insertable<UsersTable>> = {}) {
    const account = await createUserWithOrganization(databases.ownerDb, {
      user: {
        email: `flows-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        ...(kind === "productAdmin" ? { is_product_admin: true } : {}),
        ...user,
      },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    if (kind !== "contributor") return { ...account, access: accessCookie(response) };
    const { organization: group } = await addMembership(databases.ownerDb, {
      userId: account.user.id,
      role: "contributor",
    });
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: accessCookie(response) },
      payload: { organizationId: group.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return { ...account, organization: group, access: (switched.headers["set-cookie"] === undefined ? accessCookie(response) : accessCookie(switched)) };
  }

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, access?: string, payload?: unknown) =>
    server.inject({
      method,
      url,
      ...(method === "GET" ? {} : { headers: csrfHeaders }),
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  /** A flow of the test's own, inserted as the tables' owner at the clock's time. */
  async function addFlow(overrides: Partial<Insertable<FlowsTable>> = {}) {
    counter += 1;
    const at = now();
    return databases.ownerDb
      .insertInto("flows")
      .values({
        slug: `test-flow-${counter}`,
        name: `Test flow ${counter}`,
        summary: `Summary ${counter}.`,
        description: `Description ${counter}.`,
        source: "telflo",
        signals: ["traces"],
        tags: ["test"],
        yaml_content: `receivers:\n  otlp: {}\n# flow ${counter}\n`,
        collector_distribution: CONTRIB,
        collector_version: CONTRIB_DEFAULT,
        created_at: at,
        updated_at: at,
        ...overrides,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  const rowOf = (id: string) =>
    databases.ownerDb.selectFrom("flows").selectAll().where("id", "=", id).executeTakeFirst();
  const allRows = () => databases.ownerDb.selectFrom("flows").selectAll().orderBy("slug").execute();
  const flowAudits = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", "flow.%")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  /** The admin dialog's fields for a flow, every one set, on a pin the catalog offers but not its default. */
  const flowInput = (overrides: Record<string, unknown> = {}) => ({
    slug: "test-created",
    name: "Created Flow",
    summary: "What the created flow does.",
    description: DESCRIPTION,
    signals: ["traces", "logs"],
    tags: ["test", "cost"],
    yaml: YAML,
    collectorDistribution: CONTRIB,
    collectorVersion: OFFERED,
    sourceUrl: "https://example.com/flows/created.yaml",
    authorName: "Example Author",
    sortOrder: 42,
    published: false,
    ...overrides,
  });

  it("the committed catalog offers 0.161.0 and 0.162.0 and deprecated 0.147.0, as these tests assume", async () => {
    const rows = await databases.ownerDb
      .selectFrom("collector_versions")
      .select(["version", "deprecated"])
      .where("distribution", "=", CONTRIB)
      .where("version", "in", [DEPRECATED, OFFERED, CONTRIB_DEFAULT])
      .orderBy("version")
      .execute();
    expect(rows).toEqual([
      { version: DEPRECATED, deprecated: true },
      { version: OFFERED, deprecated: false },
      { version: CONTRIB_DEFAULT, deprecated: false },
    ]);
  });

  describe("GET /api/v1/flow-showcase", () => {
    it("answers a signed-out visitor every published flow's card, in the gallery's order, with no YAML, no hidden flow and no cache header", async () => {
      const later = await addFlow({ sort_order: 20, name: "Alpha" });
      const hidden = await addFlow({ sort_order: 5, published: false });
      const first = await addFlow({ sort_order: 10, name: "Zulu", author_name: "ClickStack", tags: ["a", "b"] });
      const tie = await addFlow({ sort_order: 10, name: "Bravo", signals: ["metrics", "logs"] });

      const response = await call("GET", "/api/v1/flow-showcase");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flows: [cardOf(tie), cardOf(first), cardOf(later)] });
      for (const card of response.json().flows) expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
      expect(response.body).not.toContain("receivers");
      expect(response.body).not.toContain(hidden.slug);
      expect(response.headers["cache-control"]).toBeUndefined();
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("answers a product admin's request the same: a signed-out read, whatever the cookie", async () => {
      const shown = await addFlow();
      await addFlow({ published: false });
      const { access } = await signedIn("productAdmin");
      const response = await call("GET", "/api/v1/flow-showcase", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flows: [cardOf(shown)] });
    });

    it("lists the seeded flows once insertSeededFlows puts them back, a hidden one left out, and nothing when there are none", async () => {
      expect((await call("GET", "/api/v1/flow-showcase")).json()).toEqual({ flows: [] });
      await insertSeededFlows(databases.ownerDb);
      const seededFlows = await loadSeededFlows();
      await databases.ownerDb
        .updateTable("flows")
        .set({ published: false })
        .where("slug", "=", "otel-to-clickstack")
        .execute();
      const response = await call("GET", "/api/v1/flow-showcase");
      expect(response.json().flows.map((card: { slug: string }) => card.slug)).toEqual(
        seededFlows.map((flow) => flow.slug).filter((slug) => slug !== "otel-to-clickstack"),
      );
      expect(response.body).not.toContain("${env:");
    });

    it("is not rate limited under the production limits: more requests from one address than any per-IP limit allows all answer 200", async () => {
      await addFlow();
      const limited = buildServer({
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: RATE_LIMITS,
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
      try {
        await limited.ready();
        const requests = Math.max(...Object.values(RATE_LIMITS).map((limit) => limit.max)) + 1;
        const statuses = new Set<number>();
        for (let index = 0; index < requests; index += 1) {
          statuses.add((await limited.inject({ method: "GET", url: "/api/v1/flow-showcase" })).statusCode);
        }
        expect([...statuses]).toEqual([200]);
      } finally {
        await limited.close();
      }
    });
  });

  /*
   * The open flow read, for the playground, with no session: the published
   * flows only, YAML included, never from a cache, 60 a minute per address
   * over both routes, its request line the route's pattern only.
   */
  describe("GET /api/v1/published-flows and /api/v1/published-flows/:slug", () => {
    /** A server of its own whose open read allows `max` a minute per address, every other limit the production one's. */
    async function serverWithPublishedReads(max: number): Promise<FastifyInstance> {
      const limited = buildServer({
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: { ...RATE_LIMITS, publishedFlowReadsPerIp: { max, windowMs: 60_000 } },
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
      await limited.ready();
      return limited;
    }

    it("lists the published flows only, in full but their id, published, sortOrder and createdAt, YAML included, in the gallery's order, to a signed-out visitor, with no-store", async () => {
      const later = await addFlow({ sort_order: 20, name: "Alpha", author_name: "ClickStack", source_url: "https://example.com/x" });
      const hidden = await addFlow({ sort_order: 5, published: false });
      const first = await addFlow({ sort_order: 10, name: "Zulu", tags: ["a", "b"] });
      const tie = await addFlow({ sort_order: 10, name: "Bravo", signals: ["metrics", "logs"] });

      const response = await call("GET", "/api/v1/published-flows");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flows: [publishedOf(tie), publishedOf(first), publishedOf(later)] });
      for (const flow of response.json().flows) expect(Object.keys(flow).sort()).toEqual(PUBLISHED_KEYS);
      expect(response.json().flows.every((flow: { yaml: string }) => flow.yaml.includes("receivers"))).toBe(true);
      expect(response.body.includes(hidden.slug)).toBe(false);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("answers a product admin's request the same: the non-admin reader, whatever the cookie, so a hidden flow is never listed nor read", async () => {
      const shown = await addFlow({ sort_order: 1 });
      const hidden = await addFlow({ sort_order: 0, published: false });
      const { access } = await signedIn("productAdmin");

      const list = await call("GET", "/api/v1/published-flows", access);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ flows: [publishedOf(shown)] });

      const read = await call("GET", `/api/v1/published-flows/${hidden.slug}`, access);
      expect(read.statusCode).toBe(404);
      expect(read.json()).toEqual(NOT_FOUND);
    });

    it("answers a published flow by its slug with its YAML, with no-store and no session", async () => {
      const flow = await addFlow({ author_name: "ClickStack", source_url: "https://example.com/source" });
      const response = await call("GET", `/api/v1/published-flows/${flow.slug}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flow: publishedOf(flow) });
      expect(Object.keys(response.json().flow).sort()).toEqual(PUBLISHED_KEYS);
      expect(response.json().flow.yaml).toBe(flow.yaml_content);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("answers a hidden flow, an unknown slug and one no flow could have 404 flow_not_found, with no-store", async () => {
      const hidden = await addFlow({ published: false });
      const shown = await addFlow();
      for (const slug of [hidden.slug, "test-unknown", "Not-A-Slug", "a".repeat(81), "%20", shown.id]) {
        const response = await call("GET", `/api/v1/published-flows/${slug}`);
        expect({ slug, status: response.statusCode, body: response.json(), cache: response.headers["cache-control"] }).toEqual({
          slug,
          status: 404,
          body: NOT_FOUND,
          cache: "no-store",
        });
      }
    });

    it("lists the seeded flows once insertSeededFlows puts them back, a hidden one left out, each with its YAML", async () => {
      await insertSeededFlows(databases.ownerDb);
      const seededFlows = await loadSeededFlows();
      await databases.ownerDb.updateTable("flows").set({ published: false }).where("slug", "=", "otel-to-clickstack").execute();
      const response = await call("GET", "/api/v1/published-flows");
      const slugs = response.json().flows.map((flow: { slug: string }) => flow.slug);
      expect(slugs).toEqual(seededFlows.map((flow) => flow.slug).filter((slug) => slug !== "otel-to-clickstack"));
      expect(response.json().flows.every((flow: { yaml: string }) => flow.yaml.length > 0)).toBe(true);
      const one = await call("GET", "/api/v1/published-flows/log-volume-cost-control");
      expect(one.statusCode).toBe(200);
      expect(one.json().flow.yaml.length).toBeGreaterThan(0);
      expect((await call("GET", "/api/v1/published-flows/otel-to-clickstack")).statusCode).toBe(404);
    });

    it("counts every request per address over both routes together, an unknown slug's included: the next is 429 rate_limited with Retry-After and no-store; another address and the showcase are unaffected", async () => {
      const flow = await addFlow();
      const limited = await serverWithPublishedReads(3);
      try {
        const from = (url: string, remoteAddress = "198.51.100.7") => limited.inject({ method: "GET", url, remoteAddress });
        expect((await from("/api/v1/published-flows")).statusCode).toBe(200);
        expect((await from(`/api/v1/published-flows/${flow.slug}`)).statusCode).toBe(200);
        expect((await from("/api/v1/published-flows/test-unknown")).statusCode).toBe(404);
        for (const url of ["/api/v1/published-flows", `/api/v1/published-flows/${flow.slug}`, "/api/v1/published-flows/test-unknown"]) {
          const refused = await from(url);
          expect({ url, status: refused.statusCode, body: refused.json(), cache: refused.headers["cache-control"] }).toEqual({
            url,
            status: 429,
            body: RATE_LIMITED,
            cache: "no-store",
          });
          const retryAfter = Number(refused.headers["retry-after"]);
          expect(retryAfter > 0 && retryAfter <= 60).toBe(true);
        }
        // Another address has its own count; the showcase isn't counted at all.
        expect((await from("/api/v1/published-flows", "198.51.100.8")).statusCode).toBe(200);
        for (let index = 0; index < 5; index += 1) {
          expect((await from("/api/v1/flow-showcase")).statusCode).toBe(200);
        }
      } finally {
        await limited.close();
      }
    });

    it("is limited at 60 a minute per address under the production limits", async () => {
      await addFlow();
      const limited = buildServer({
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: RATE_LIMITS,
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
      try {
        await limited.ready();
        const statuses: number[] = [];
        for (let index = 0; index < 61; index += 1) {
          const url = index % 2 === 0 ? "/api/v1/published-flows" : "/api/v1/published-flows/test-unknown";
          statuses.push((await limited.inject({ method: "GET", url })).statusCode);
        }
        expect(statuses.filter((status) => status === 429)).toHaveLength(1);
        expect(statuses[60]).toBe(429);
      } finally {
        await limited.close();
      }
    });

    it("logs the request line with the route's pattern only, never the slug or a query, nor any flow's YAML or description, and audits nothing", async () => {
      const flow = await addFlow({ yaml_content: YAML, description: DESCRIPTION });
      const hidden = await addFlow({ published: false });
      const SLUG_MARKER = "slug-marker-5d1e";
      await call("GET", `/api/v1/published-flows?q=${SLUG_MARKER}`);
      await call("GET", `/api/v1/published-flows/${flow.slug}?x=${SLUG_MARKER}`);
      await call("GET", `/api/v1/published-flows/${hidden.slug}`);
      await call("GET", `/api/v1/published-flows/${SLUG_MARKER}`);
      await call("GET", `/api/v1/published-flows/${SLUG_MARKER}/more`);

      const urls = lines.flatMap((line) => {
        const { req } = JSON.parse(line) as { req?: { url?: string } };
        return req?.url === undefined ? [] : [req.url];
      });
      expect(urls.length).toBeGreaterThan(0);
      expect(new Set(urls)).toEqual(new Set(["/api/v1/published-flows", "/api/v1/published-flows/:slug"]));
      const logged = lines.join("\n");
      expect(logged.includes(SLUG_MARKER)).toBe(false);
      expect(logged.includes(flow.slug)).toBe(false);
      expect(logged.includes(hidden.slug)).toBe(false);
      expect(logged.includes(YAML_MARKER)).toBe(false);
      expect(logged.includes(DESCRIPTION_MARKER)).toBe(false);
      expect(await flowAudits()).toEqual([]);
    });
  });

  describe("the anonymous reads switched off, TELFLO_PUBLIC_FLOWS' default", () => {
    /** A server with public flows off (and the playground, which needs them), its open read limited to one a minute per address. */
    async function serverWithPublicFlowsOff(): Promise<FastifyInstance> {
      const settings = loadSettings(process.env);
      const off = buildServer({
        settings: { ...settings, site: { ...settings.site, publicFlows: false, playground: false } },
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: { ...RATE_LIMITS, publishedFlowReadsPerIp: { max: 1, windowMs: 60_000 } },
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
      });
      await off.ready();
      return off;
    }

    it("answers the showcase, the published flows and a published flow by its slug exactly as a path nothing serves, before the per-address limit counts them", async () => {
      const flow = await addFlow();
      const off = await serverWithPublicFlowsOff();
      try {
        const from = (url: string) => off.inject({ method: "GET", url, remoteAddress: "198.51.100.7" });
        for (let round = 0; round < 2; round += 1) {
          // sendNotFound's words, the path as the request log spells it: a slug as the route's pattern.
          for (const [url, spelled] of [
            ["/api/v1/flow-showcase", "/api/v1/flow-showcase"],
            ["/api/v1/published-flows", "/api/v1/published-flows"],
            [`/api/v1/published-flows/${flow.slug}`, "/api/v1/published-flows/:slug"],
          ] as const) {
            const response = await from(url);
            expect({ url, status: response.statusCode, body: response.json() }).toEqual({
              url,
              status: 404,
              body: { error: { code: "not_found", message: `No route for GET ${spelled}` } },
            });
            expect(response.body.includes(flow.name) || response.body.includes(flow.slug)).toBe(false);
          }
        }
        const unknown = await from("/api/v1/no-such-route");
        expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: { code: "not_found", message: "No route for GET /api/v1/no-such-route" } }]);
      } finally {
        await off.close();
      }
    });

    it("leaves the signed-in reads as they are: GET /api/v1/flows still asks for a session", async () => {
      const off = await serverWithPublicFlowsOff();
      try {
        const response = await off.inject({ method: "GET", url: "/api/v1/flows" });
        expect(response.statusCode).toBe(401);
      } finally {
        await off.close();
      }
    });
  });

  describe("GET /api/v1/flows", () => {
    it("answers 401 signed out", async () => {
      await addFlow();
      const response = await call("GET", "/api/v1/flows");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("lists the published flows in full, YAML included, in the gallery's order, to anyone signed in, and no cache keeps them", async () => {
      const second = await addFlow({ sort_order: 2, author_name: "ClickStack", source_url: "https://example.com/x" });
      const first = await addFlow({ sort_order: 1 });
      await addFlow({ sort_order: 0, published: false });
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const { access } = await signedIn(kind);
        const response = await call("GET", "/api/v1/flows", access);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ flows: [bodyOf(first), bodyOf(second)] });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("lists the hidden flows too to a product admin", async () => {
      const shown = await addFlow({ sort_order: 1 });
      const hidden = await addFlow({ sort_order: 0, published: false });
      const { access } = await signedIn("productAdmin");
      const response = await call("GET", "/api/v1/flows", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flows: [bodyOf(hidden), bodyOf(shown)] });
    });

    it("answers a user who hasn't accepted the current terms, as the catalog does: flows are no one's data", async () => {
      const flow = await addFlow();
      const { access } = await signedIn("organizationAdmin", { accepted_terms_version: "2025-01-01" });
      const response = await call("GET", "/api/v1/flows", access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flows: [bodyOf(flow)] });
      expect((await call("GET", `/api/v1/flows/${flow.slug}`, access)).statusCode).toBe(200);
    });
  });

  describe("GET /api/v1/flows/:slug", () => {
    it("answers a published flow in full to anyone signed in, with no cache", async () => {
      const flow = await addFlow({ author_name: "ClickStack", source_url: "https://example.com/source" });
      const { access } = await signedIn("contributor");
      const response = await call("GET", `/api/v1/flows/${flow.slug}`, access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flow: bodyOf(flow) });
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("answers a hidden flow 404 flow_not_found to anyone but a product admin, who reads it", async () => {
      const hidden = await addFlow({ published: false });
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const { access } = await signedIn(kind);
        const response = await call("GET", `/api/v1/flows/${hidden.slug}`, access);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(NOT_FOUND);
      }
      const { access } = await signedIn("productAdmin");
      const response = await call("GET", `/api/v1/flows/${hidden.slug}`, access);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ flow: bodyOf(hidden) });
    });

    it("answers an unknown slug, and one no flow could have, 404 flow_not_found; signed out, 401", async () => {
      const flow = await addFlow();
      const { access } = await signedIn("productAdmin");
      for (const slug of ["test-unknown", "Not-A-Slug", "a".repeat(81), "%20", flow.id]) {
        const response = await call("GET", `/api/v1/flows/${slug}`, access);
        expect({ slug, status: response.statusCode, body: response.json() }).toEqual({
          slug,
          status: 404,
          body: NOT_FOUND,
        });
      }
      expect((await call("GET", `/api/v1/flows/${flow.slug}`)).statusCode).toBe(401);
    });
  });

  describe("POST /api/v1/flows", () => {
    it("creates a flow from every field for a product admin, source telflo and no author link, both timestamps the API's clock, and round-trips every field", async () => {
      const admin = await signedIn("productAdmin");
      const at = tick();

      const response = await call("POST", "/api/v1/flows", admin.access, flowInput());

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const expected = {
        id: expect.any(String),
        slug: "test-created",
        name: "Created Flow",
        summary: "What the created flow does.",
        description: DESCRIPTION,
        source: "telflo",
        authorName: "Example Author",
        authorUrl: null,
        signals: ["traces", "logs"],
        tags: ["test", "cost"],
        yaml: YAML,
        collectorDistribution: CONTRIB,
        collectorVersion: OFFERED,
        sourceUrl: "https://example.com/flows/created.yaml",
        published: false,
        sortOrder: 42,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      };
      const { flow } = response.json();
      expect(flow).toEqual(expected);
      const row = await rowOf(flow.id);
      expect(row && bodyOf(row)).toEqual(flow);
      expect(row?.yaml_content).toBe(YAML);
      const read = await call("GET", "/api/v1/flows/test-created", admin.access);
      expect(read.json()).toEqual({ flow });
    });

    it("publishes by default, trims the text fields, and stores a blank author and link as none", async () => {
      const { access } = await signedIn("productAdmin");
      const { published: _published, ...withoutPublished } = flowInput();
      const response = await call("POST", "/api/v1/flows", access, {
        ...withoutPublished,
        name: "  Spaced Name  ",
        summary: " Spaced. ",
        tags: [" spaced "],
        authorName: "   ",
        sourceUrl: "",
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().flow).toMatchObject({
        name: "Spaced Name",
        summary: "Spaced.",
        tags: ["spaced"],
        authorName: null,
        sourceUrl: null,
        published: true,
        yaml: YAML,
      });
      expect((await call("GET", "/api/v1/flow-showcase")).json().flows).toHaveLength(1);
    });

    it("audits the create as flow.created, in no organization, naming the slug, never the YAML or the description", async () => {
      const admin = await signedIn("productAdmin");
      const response = await call("POST", "/api/v1/flows", admin.access, flowInput());
      const audits = await flowAudits();
      expect(audits).toEqual([
        expect.objectContaining({
          action: "flow.created",
          actor_user_id: admin.user.id,
          actor_email: admin.user.email,
          organization_id: null,
          subject_type: "flow",
          subject_id: response.json().flow.id,
          metadata: { slug: "test-created" },
        }),
      ]);
      expect(JSON.stringify(audits)).not.toContain(YAML_MARKER);
      expect(JSON.stringify(audits)).not.toContain(DESCRIPTION_MARKER);
    });

    it("refuses an organization's admin and a contributor 403 product_admin_required, and 401 signed out, writing nothing", async () => {
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const { access } = await signedIn(kind);
        const response = await call("POST", "/api/v1/flows", access, flowInput());
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(PRODUCT_ADMIN_REQUIRED);
      }
      const signedOut = await call("POST", "/api/v1/flows", undefined, flowInput());
      expect(signedOut.statusCode).toBe(401);
      expect(await allRows()).toEqual([]);
      expect(await flowAudits()).toEqual([]);
    });

    it("refuses a slug another flow has 409 flow_slug_taken, writing nothing", async () => {
      const existing = await addFlow({ slug: "test-created" });
      const { access } = await signedIn("productAdmin");
      const response = await call("POST", "/api/v1/flows", access, flowInput());
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(SLUG_TAKEN);
      expect(await allRows()).toEqual([existing]);
      expect(await flowAudits()).toEqual([]);
    });

    it("refuses a pin the catalog doesn't offer: an unknown distribution 400 collector_distribution_unknown, an unknown or deprecated version 400 collector_version_unknown, writing nothing", async () => {
      const { access } = await signedIn("productAdmin");
      const refusals: Array<[Record<string, unknown>, unknown]> = [
        [{ collectorDistribution: "clickstack" }, DISTRIBUTION_UNKNOWN],
        [{ collectorDistribution: "clickstack", collectorVersion: "2.36.0" }, DISTRIBUTION_UNKNOWN],
        [{ collectorVersion: "0.999.0" }, VERSION_UNKNOWN],
        [{ collectorVersion: DEPRECATED }, VERSION_UNKNOWN],
      ];
      for (const [overrides, refusal] of refusals) {
        const response = await call("POST", "/api/v1/flows", access, flowInput(overrides));
        expect({ overrides, status: response.statusCode, body: response.json() }).toEqual({
          overrides,
          status: 400,
          body: refusal,
        });
      }
      expect(await allRows()).toEqual([]);
      expect(await flowAudits()).toEqual([]);
    });

    it("refuses a body that isn't the contract's 400 invalid_request: a bad slug, a link that isn't http(s), a blank YAML, a source of its own, an unknown field", async () => {
      const { access } = await signedIn("productAdmin");
      for (const overrides of [
        { slug: "Not A Slug" },
        { sourceUrl: "javascript:alert(1)" },
        { yaml: "   \n" },
        { source: "community" },
        { authorUrl: "https://example.com" },
        { signals: ["profiles"] },
        { sortOrder: 1.5 },
      ]) {
        const response = await call("POST", "/api/v1/flows", access, flowInput(overrides));
        expect({ overrides, status: response.statusCode, code: response.json().error.code }).toEqual({
          overrides,
          status: 400,
          code: "invalid_request",
        });
      }
      expect(await allRows()).toEqual([]);
    });

    it("takes a body at the content limits, the YAML and the description each 262,144 characters that JSON escapes to six bytes, past the server's 1 MiB", async () => {
      const { access } = await signedIn("productAdmin");
      const yaml = `a${"\u0001".repeat(262_143)}`;
      const description = "\u0001".repeat(262_144);
      const payload = JSON.stringify(flowInput({ yaml, description }));
      expect(Buffer.byteLength(payload)).toBeGreaterThan(3 * 1024 * 1024);
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/flows",
        headers: { ...csrfHeaders, "content-type": "application/json" },
        cookies: { telflo_access: access },
        payload,
      });
      expect(response.statusCode).toBe(201);
      const row = await rowOf(response.json().flow.id);
      expect([row?.yaml_content === yaml, row?.description === description]).toEqual([true, true]);
      const over = await call("POST", "/api/v1/flows", access, flowInput({ slug: "test-over", yaml: `${yaml}a` }));
      expect(over.statusCode).toBe(400);
    });

    it("refuses a body over the route's 4 MiB 413 payload_too_large, writing and auditing nothing", async () => {
      const { access } = await signedIn("productAdmin");
      const payload = JSON.stringify(flowInput({ yaml: `${YAML}${"a".repeat(4 * 1024 * 1024)}` }));
      expect(Buffer.byteLength(payload)).toBeGreaterThan(4 * 1024 * 1024);
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/flows",
        headers: { ...csrfHeaders, "content-type": "application/json" },
        cookies: { telflo_access: access },
        payload,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: { code: "payload_too_large", message: "The request body is too large." } });
      expect(await allRows()).toEqual([]);
      expect(await flowAudits()).toEqual([]);
    });

    it("resolves creates racing for one slug to one flow and 409 for the rest, never a 500", async () => {
      const { access } = await signedIn("productAdmin");
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          call("POST", "/api/v1/flows", access, flowInput({ slug: "test-race", name: `Race ${index}` })),
        ),
      );
      const statuses = responses.map((response) => response.statusCode).sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      for (const response of responses.filter((candidate) => candidate.statusCode === 409)) {
        expect(response.json()).toEqual(SLUG_TAKEN);
      }
      expect((await allRows()).map((row) => row.slug)).toEqual(["test-race"]);
      expect((await flowAudits()).map((row) => row.action)).toEqual(["flow.created"]);
    });

    it("resolves a create racing a rename to the same slug to one flow with it and one 409, never a 500", async () => {
      const renamed = await addFlow({ slug: "test-before" });
      const { access } = await signedIn("productAdmin");
      const [rename, create] = await Promise.all([
        call("PATCH", `/api/v1/flows/${renamed.id}`, access, { slug: "test-contested" }),
        call("POST", "/api/v1/flows", access, flowInput({ slug: "test-contested" })),
      ]);
      expect([rename.statusCode, create.statusCode].sort((x, y) => x - y)).toEqual(
        rename.statusCode === 409 ? [201, 409] : [200, 409],
      );
      const loser = rename.statusCode === 409 ? rename : create;
      expect(loser.json()).toEqual(SLUG_TAKEN);
      expect((await allRows()).filter((row) => row.slug === "test-contested")).toHaveLength(1);
    });
  });

  describe("PATCH /api/v1/flows/:id", () => {
    it("changes every field for a product admin, updated_at from the API's clock and created_at as it was, and round-trips each", async () => {
      const flow = await addFlow({ author_name: "Before", source_url: "https://example.com/before" });
      const admin = await signedIn("productAdmin");
      const at = tick();
      const changes = {
        slug: "test-renamed",
        name: "Renamed",
        summary: "A new summary.",
        description: DESCRIPTION,
        signals: ["metrics"],
        tags: ["new", "tags"],
        yaml: YAML,
        collectorDistribution: CONTRIB,
        collectorVersion: OFFERED,
        sourceUrl: "http://example.com/after",
        authorName: "After",
        sortOrder: -3,
        published: false,
      };

      const response = await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, changes);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const expected = {
        ...bodyOf(flow),
        ...changes,
        createdAt: flow.created_at.toISOString(),
        updatedAt: at.toISOString(),
      };
      expect(response.json()).toEqual({ flow: expected });
      const row = await rowOf(flow.id);
      expect(row && bodyOf(row)).toEqual(expected);
      expect((await call("GET", "/api/v1/flows/test-renamed", admin.access)).json()).toEqual({ flow: expected });
      expect((await call("GET", `/api/v1/flows/${flow.slug}`, admin.access)).statusCode).toBe(404);
    });

    it("audits a change as flow.updated, naming the slug, the fields changed and the slug's and published's from and to, never the YAML or the description", async () => {
      const flow = await addFlow();
      const admin = await signedIn("productAdmin");
      await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, {
        slug: "test-audited",
        yaml: YAML,
        description: DESCRIPTION,
        published: false,
        name: flow.name,
      });
      await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, { tags: ["changed"] });
      const audits = await flowAudits();
      expect(audits).toEqual([
        expect.objectContaining({
          action: "flow.updated",
          actor_user_id: admin.user.id,
          actor_email: admin.user.email,
          organization_id: null,
          subject_type: "flow",
          subject_id: flow.id,
          metadata: {
            slug: "test-audited",
            changedFields: ["slug", "description", "yaml", "published"],
            from: { slug: flow.slug, published: true },
            to: { slug: "test-audited", published: false },
          },
        }),
        expect.objectContaining({
          action: "flow.updated",
          subject_id: flow.id,
          metadata: { slug: "test-audited", changedFields: ["tags"] },
        }),
      ]);
      expect(JSON.stringify(audits)).not.toContain(YAML_MARKER);
      expect(JSON.stringify(audits)).not.toContain(DESCRIPTION_MARKER);
    });

    it("hides and shows a flow by published alone: it leaves the showcase and a non-admin's reads, and comes back", async () => {
      const flow = await addFlow();
      const admin = await signedIn("productAdmin");
      const member = await signedIn("organizationAdmin");

      const hidden = await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, { published: false });
      expect(hidden.json().flow).toEqual({ ...bodyOf(flow), published: false, updatedAt: now().toISOString() });
      expect((await call("GET", "/api/v1/flow-showcase")).json()).toEqual({ flows: [] });
      expect((await call("GET", "/api/v1/flows", member.access)).json()).toEqual({ flows: [] });
      expect((await call("GET", `/api/v1/flows/${flow.slug}`, member.access)).statusCode).toBe(404);

      tick();
      const shown = await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, { published: true });
      expect(shown.json().flow.published).toBe(true);
      expect((await call("GET", "/api/v1/flow-showcase")).json().flows.map((card: { slug: string }) => card.slug)).toEqual([
        flow.slug,
      ]);
      expect((await flowAudits()).map((row) => row.metadata)).toEqual([
        { slug: flow.slug, changedFields: ["published"], from: { published: true }, to: { published: false } },
        { slug: flow.slug, changedFields: ["published"], from: { published: false }, to: { published: true } },
      ]);
    });

    it("changes only the fields given, and clears the author and the link with null or ''", async () => {
      const flow = await addFlow({ author_name: "Someone", source_url: "https://example.com/x" });
      const { access } = await signedIn("productAdmin");
      const at = tick();
      const response = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { authorName: null, sourceUrl: "" });
      expect(response.json()).toEqual({
        flow: { ...bodyOf(flow), authorName: null, sourceUrl: null, updatedAt: at.toISOString() },
      });
    });

    it("writes and audits nothing for no field, or fields as they are, and answers the flow as it is", async () => {
      const flow = await addFlow();
      const { access } = await signedIn("productAdmin");
      tick();
      for (const body of [
        {},
        { name: flow.name, tags: flow.tags, published: true, collectorVersion: CONTRIB_DEFAULT, sourceUrl: null },
      ]) {
        const response = await call("PATCH", `/api/v1/flows/${flow.id}`, access, body);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ flow: bodyOf(flow) });
      }
      expect(await rowOf(flow.id)).toEqual(flow);
      expect(await flowAudits()).toEqual([]);
    });

    it("keeps a pin deprecated since when the change leaves it as it is, and refuses a change to it", async () => {
      const flow = await addFlow({ collector_version: DEPRECATED });
      const { access } = await signedIn("productAdmin");

      const renamed = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { name: "Still on the old pin" });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().flow.collectorVersion).toBe(DEPRECATED);
      const restated = await call("PATCH", `/api/v1/flows/${flow.id}`, access, {
        collectorDistribution: CONTRIB,
        collectorVersion: DEPRECATED,
        summary: "Restating the pin.",
      });
      expect(restated.statusCode).toBe(200);
      expect(restated.json().flow).toMatchObject({ collectorVersion: DEPRECATED, summary: "Restating the pin." });

      const moved = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { collectorVersion: OFFERED });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().flow.collectorVersion).toBe(OFFERED);

      const back = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { collectorVersion: DEPRECATED });
      expect(back.statusCode).toBe(400);
      expect(back.json()).toEqual(VERSION_UNKNOWN);
      const unknown = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { collectorVersion: "0.999.0" });
      expect(unknown.json()).toEqual(VERSION_UNKNOWN);
      const elsewhere = await call("PATCH", `/api/v1/flows/${flow.id}`, access, {
        collectorDistribution: "clickstack",
        name: "Not written",
      });
      expect(elsewhere.statusCode).toBe(400);
      expect(elsewhere.json()).toEqual(DISTRIBUTION_UNKNOWN);
      expect(await rowOf(flow.id)).toMatchObject({
        collector_distribution: CONTRIB,
        collector_version: OFFERED,
        name: "Still on the old pin",
      });
    });

    it("refuses a body over the route's 4 MiB 413 payload_too_large, changing and auditing nothing", async () => {
      const flow = await addFlow();
      const { access } = await signedIn("productAdmin");
      tick();
      const payload = JSON.stringify({ name: "Renamed", yaml: `${YAML}${"a".repeat(4 * 1024 * 1024)}` });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(4 * 1024 * 1024);
      const response = await server.inject({
        method: "PATCH",
        url: `/api/v1/flows/${flow.id}`,
        headers: { ...csrfHeaders, "content-type": "application/json" },
        cookies: { telflo_access: access },
        payload,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: { code: "payload_too_large", message: "The request body is too large." } });
      expect(await rowOf(flow.id)).toEqual(flow);
      expect(await flowAudits()).toEqual([]);
    });

    it("refuses an organization's admin and a contributor 403 product_admin_required, before any 404, and 401 signed out, changing nothing", async () => {
      const flow = await addFlow();
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const { access } = await signedIn(kind);
        for (const id of [flow.id, randomUUID()]) {
          const response = await call("PATCH", `/api/v1/flows/${id}`, access, { published: false });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toEqual(PRODUCT_ADMIN_REQUIRED);
        }
      }
      expect((await call("PATCH", `/api/v1/flows/${flow.id}`, undefined, { published: false })).statusCode).toBe(401);
      expect(await rowOf(flow.id)).toEqual(flow);
      expect(await flowAudits()).toEqual([]);
    });

    it("answers an id no flow has, and one that isn't a UUID, 404 flow_not_found", async () => {
      await addFlow();
      const { access } = await signedIn("productAdmin");
      for (const id of [randomUUID(), "not-a-uuid", "test-flow-1"]) {
        const response = await call("PATCH", `/api/v1/flows/${id}`, access, { name: "x" });
        expect({ id, status: response.statusCode, body: response.json() }).toEqual({ id, status: 404, body: NOT_FOUND });
      }
    });

    it("refuses a slug another flow has 409 flow_slug_taken, changing nothing", async () => {
      const taken = await addFlow();
      const flow = await addFlow();
      const { access } = await signedIn("productAdmin");
      const response = await call("PATCH", `/api/v1/flows/${flow.id}`, access, { slug: taken.slug, name: "Changed" });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(SLUG_TAKEN);
      expect(await rowOf(flow.id)).toEqual(flow);
      expect(await flowAudits()).toEqual([]);
    });
  });

  describe("DELETE /api/v1/flows/:id", () => {
    it("deletes it for good for a product admin, audits flow.deleted with the slug, and leaves the configurations created from it as they were", async () => {
      const flow = await addFlow({ yaml_content: YAML, description: DESCRIPTION });
      const other = await addFlow();
      const admin = await signedIn("productAdmin");
      const configuration = await addConfiguration(databases.ownerDb, {
        organizationId: admin.organization.id,
        source_flow_slug: flow.slug,
      });

      const response = await call("DELETE", `/api/v1/flows/${flow.id}`, admin.access);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(await allRows()).toEqual([other]);
      expect((await call("GET", `/api/v1/flows/${flow.slug}`, admin.access)).statusCode).toBe(404);
      expect(
        await databases.ownerDb
          .selectFrom("configurations")
          .selectAll()
          .where("id", "=", configuration.id)
          .executeTakeFirst(),
      ).toEqual(configuration);
      const audits = await flowAudits();
      expect(audits).toEqual([
        expect.objectContaining({
          action: "flow.deleted",
          actor_user_id: admin.user.id,
          organization_id: null,
          subject_type: "flow",
          subject_id: flow.id,
          metadata: { slug: flow.slug },
        }),
      ]);
      expect(JSON.stringify(audits)).not.toContain(YAML_MARKER);
      expect(JSON.stringify(audits)).not.toContain(DESCRIPTION_MARKER);

      const again = await call("DELETE", `/api/v1/flows/${flow.id}`, admin.access);
      expect(again.statusCode).toBe(404);
      expect(again.json()).toEqual(NOT_FOUND);
    });

    it("refuses an organization's admin and a contributor 403 product_admin_required, and 401 signed out, deleting nothing", async () => {
      const flow = await addFlow();
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const { access } = await signedIn(kind);
        const response = await call("DELETE", `/api/v1/flows/${flow.id}`, access);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(PRODUCT_ADMIN_REQUIRED);
      }
      expect((await call("DELETE", `/api/v1/flows/${flow.id}`)).statusCode).toBe(401);
      expect(await allRows()).toEqual([flow]);
      expect(await flowAudits()).toEqual([]);
    });

    it("answers an id no flow has, and one that isn't a UUID, 404 flow_not_found", async () => {
      await addFlow();
      const { access } = await signedIn("productAdmin");
      for (const id of [randomUUID(), "not-a-uuid"]) {
        const response = await call("DELETE", `/api/v1/flows/${id}`, access);
        expect({ id, status: response.statusCode, body: response.json() }).toEqual({ id, status: 404, body: NOT_FOUND });
      }
      expect(await allRows()).toHaveLength(1);
    });
  });

  // A refused write's 400 carries Zod's issues as `details` (errors.ts),
  // which name each refused field's path, code and message, never a string
  // field's value (a too-long or unstorable YAML or description included).
  // By design of the error handler they may echo other values: an enum's
  // (`signals`) received value and its options, an unknown field's name. So
  // only the YAML and the description carry the markers here, and the
  // signals case's value holds none.
  it("answers a create or a change refused by validation 400 invalid_request, whose body and log lines never hold its YAML or description, writing nothing", async () => {
    const admin = await signedIn("productAdmin");
    const flow = await addFlow();
    const tooLongDescription = `${DESCRIPTION}${"a".repeat(262_144)}`;
    const unstorableYaml = `${YAML}# \u0000\n`;
    const refusals: Record<string, unknown>[] = [
      { slug: "Not A Slug" },
      { yaml: unstorableYaml },
      { description: tooLongDescription },
      { yaml: unstorableYaml, description: tooLongDescription },
      { sourceUrl: "javascript:alert(1)" },
      { signals: ["profiles"] },
      { source: "community" },
    ];
    const responses: LightMyRequestResponse[] = [];
    for (const overrides of refusals) {
      responses.push(await call("POST", "/api/v1/flows", admin.access, flowInput(overrides)));
      responses.push(
        await call("PATCH", `/api/v1/flows/${flow.id}`, admin.access, { yaml: YAML, description: DESCRIPTION, ...overrides }),
      );
    }
    for (const response of responses) {
      expect({ status: response.statusCode, code: response.json().error.code }).toEqual({ status: 400, code: "invalid_request" });
      expect(response.json().error.details.length).toBeGreaterThan(0);
      expect(response.body).not.toContain(YAML_MARKER);
      expect(response.body).not.toContain(DESCRIPTION_MARKER);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(YAML_MARKER);
    expect(lines.join("\n")).not.toContain(DESCRIPTION_MARKER);
    expect((await allRows()).map((row) => row.id)).toEqual([flow.id]);
    expect(await rowOf(flow.id)).toEqual(flow);
    expect(await flowAudits()).toEqual([]);
  });

  it("logs no flow's YAML or description, on a write, a refusal or a read, at trace level", async () => {
    const admin = await signedIn("productAdmin");
    const created = await call("POST", "/api/v1/flows", admin.access, flowInput({ published: true }));
    expect(created.statusCode).toBe(201);
    const id = created.json().flow.id;
    await call("POST", "/api/v1/flows", admin.access, flowInput());
    await call("POST", "/api/v1/flows", admin.access, flowInput({ slug: "test-other", collectorVersion: DEPRECATED }));
    await call("PATCH", `/api/v1/flows/${id}`, admin.access, { yaml: `${YAML}# changed\n`, description: `${DESCRIPTION}!` });
    await call("GET", "/api/v1/flows", admin.access);
    await call("GET", "/api/v1/flows/test-created", admin.access);
    await call("GET", "/api/v1/flow-showcase");
    await call("DELETE", `/api/v1/flows/${id}`, admin.access);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(YAML_MARKER);
    expect(lines.join("\n")).not.toContain(DESCRIPTION_MARKER);
  });
});
