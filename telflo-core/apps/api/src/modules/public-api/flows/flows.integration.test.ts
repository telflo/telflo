import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Insertable, Kysely } from "kysely";
import { createDb, createPool, type Database, type FlowsTable } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  catalogueDefaults,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings } from "../../../settings.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * The public surface's flows (D25 decision 17's routes 24 and 25;
 * decisions 19, 45 and 53), through the real server as the API's own role.
 * Flows are global: any organization's token reads the same published
 * flows, never a hidden one (a token is never a product admin, whatever its
 * user's flag), and every reply is checked against the OpenAPI document.
 * Both routes are read routes, so a read token and a write token alike
 * succeed; there is no organization's id to refuse.
 *
 * Tokens are built at run time by addApiToken and never printed: `call`
 * runs its canary (a boolean) on every reply before any comparison of it.
 */

const opamp = useFakeOpampServer();

const P = "/api/public/v1";
const ROUTE = { list: `${P}/flows`, one: `${P}/flows/:slug` } as const;
type Route = (typeof ROUTE)[keyof typeof ROUTE];

interface FlowBody {
  id: string;
  slug: string;
  name: string;
  summary: string;
  source: string;
  authorName: string | null;
  authorUrl: string | null;
  signals: string[];
  tags: string[];
  collectorVersion: string;
  distribution: string;
  sourceUrl: string | null;
  updatedAt: string;
  description?: string;
  yaml?: string;
}

describe("the public flows routes (D25 routes 24-25)", () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let pin: { distribution: string; version: string };
  let counter = 0;

  beforeAll(async () => {
    const settings = loadSettings(process.env);
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
      rateLimits: TEST_RATE_LIMITS,
    });
    await server.ready();
    pin = await catalogueDefaults(ownerDb);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    // Empties the seeded flows too (D12 Ruling 13): each test sees its own.
    await truncateAll(ownerDb);
  });

  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** A group organization's service account with a read and a write token. */
  const organization = async () => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb);
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    return { id: group.id, accountUserId: account.id, read: await tokenOf("read"), write: await tokenOf("write") };
  };

  async function addFlow(overrides: Partial<Insertable<FlowsTable>> = {}) {
    counter += 1;
    const at = new Date(Date.UTC(2026, 9, 1, 12, counter));
    return ownerDb
      .insertInto("flows")
      .values({
        slug: `public-flow-${counter}-${randomUUID().slice(0, 8)}`,
        name: `Flow ${counter}`,
        summary: `Summary ${counter}.`,
        description: `Description ${counter}.`,
        source: "telflo",
        signals: ["traces"],
        tags: ["test"],
        yaml_content: `receivers:\n  otlp: {}\n# flow ${counter}\n`,
        collector_distribution: pin.distribution,
        collector_version: pin.version,
        created_at: at,
        updated_at: at,
        ...overrides,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  const call = async (route: Route, token: string, slug = "") => {
    const response = await server.inject({
      method: "GET",
      url: route.replace(":slug", encodeURIComponent(slug)),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(holdsToken(response.body, token)).toBe(false);
    const body: unknown = response.body === "" ? undefined : response.json();
    expect(validatePublicReply("GET", route, response.statusCode, body).errors).toEqual([]);
    return response;
  };

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  describe("GET /flows (route 24)", () => {
    it("lists the published flows in the gallery's order, without description or YAML, to any organization's token; one page", async () => {
      const org = await organization();
      const other = await organization();
      const later = await addFlow({ sort_order: 20, name: "Alpha" });
      await addFlow({ sort_order: 5, published: false });
      const first = await addFlow({
        sort_order: 10,
        name: "Zulu",
        source: "community",
        author_name: "Someone",
        author_url: "https://example.com/someone",
        source_url: "https://example.com/flow",
        signals: ["metrics", "logs"],
        tags: ["a", "b"],
      });

      const response = await call(ROUTE.list, org.read);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const page = response.json<{ items: FlowBody[]; nextCursor: null }>();
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((item) => item.id)).toEqual([first.id, later.id]);
      expect(page.items[0]).toEqual({
        id: first.id,
        slug: first.slug,
        name: "Zulu",
        summary: first.summary,
        source: "community",
        authorName: "Someone",
        authorUrl: "https://example.com/someone",
        signals: ["metrics", "logs"],
        tags: ["a", "b"],
        collectorVersion: pin.version,
        distribution: pin.distribution,
        sourceUrl: "https://example.com/flow",
        updatedAt: first.updated_at.toISOString(),
      });
      // The same list for a write token and another organization's: flows are global.
      for (const token of [org.write, other.read]) {
        expect((await call(ROUTE.list, token)).json<{ items: FlowBody[] }>().items.map((item) => item.id)).toEqual([first.id, later.id]);
      }
    });

    it("answers an empty list when no flow is published", async () => {
      const org = await organization();
      await addFlow({ published: false });
      expect((await call(ROUTE.list, org.read)).json()).toEqual({ items: [], nextCursor: null });
    });

    it("never shows a hidden flow, even when the token's user is a product admin", async () => {
      const org = await organization();
      const shown = await addFlow();
      await addFlow({ published: false });
      await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", org.accountUserId).execute();
      expect((await call(ROUTE.list, org.read)).json<{ items: FlowBody[] }>().items.map((item) => item.id)).toEqual([shown.id]);
    });
  });

  describe("GET /flows/{slug} (route 25)", () => {
    it("reads a published flow with its description and YAML", async () => {
      const org = await organization();
      const flow = await addFlow({ description: "## Long\n\nMarkdown." });
      const response = await call(ROUTE.one, org.read, flow.slug);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<FlowBody>()).toMatchObject({
        id: flow.id,
        slug: flow.slug,
        description: "## Long\n\nMarkdown.",
        yaml: flow.yaml_content,
        distribution: pin.distribution,
        authorName: null,
        authorUrl: null,
        sourceUrl: null,
      });
    });

    it("answers a hidden flow (a product admin's token user included), an unknown slug and one no flow could have 404 flow_not_found", async () => {
      const org = await organization();
      const hidden = await addFlow({ published: false });
      await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", org.accountUserId).execute();
      for (const slug of [hidden.slug, "no-such-flow", "Not A Slug!", "x".repeat(100)]) {
        expectRefusal(await call(ROUTE.one, org.read, slug), 404, "flow_not_found");
      }
    });
  });
});
